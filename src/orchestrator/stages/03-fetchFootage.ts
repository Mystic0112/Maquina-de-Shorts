import { mkdir, rm, rmdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { resolveScript } from "../../shared/settings.js";
import { loadConfig, paths } from "../lib/config.js";
import {
  buildImageNormalizeArgs,
  buildVideoNormalizeArgs,
  probeVideo,
  resolveFfmpegBinaries,
  runBinary,
  type NormalizeTarget,
} from "../lib/ffmpeg.js";
import { getLogger, type Logger } from "../lib/logger.js";
import {
  annotateClip,
  assessQuality,
  classifyClip,
  describeScored,
  normalizeAlternatives,
  penalizeLowResolution,
  proposeAlternativeQueries,
  resolveRelevanceSettings,
  scoreClip,
  selectSceneClips,
  type FailedScene,
  type RelevanceSettings,
  type SceneSelection,
  type ScoredClip,
  type SourceSize,
} from "../lib/relevance.js";
import { beatClipsPerQuery, beatForClip, encodeBeatSlot, keepPerBeat, withBeat } from "../lib/beats.js";
import { footageHash } from "../lib/contentHash.js";
import { PythonExitError, runPythonJson } from "../lib/python.js";
import { RunRejectedError } from "../lib/rejection.js";
import { creditsFitDescription } from "./07-generateMetadata.js";
import { redactSecrets } from "../lib/redact.js";
import { getProviderByName } from "../lib/llmClient.js";
import type { FootageClip, RunContext, Script, ScriptScene } from "../types.js";

const FOOTAGE_SCRIPT = "vendor/openmontage_adapter/fetch_footage.py";
const FOOTAGE_TIMEOUT_MS = 15 * 60 * 1000;

const FootageClipSchema = z.object({
  sceneIndex: z.number().int().nonnegative(),
  path: z.string().min(1),
  kind: z.enum(["video", "image"]),
  durationSeconds: z.number().nonnegative(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
  source: z.string(),
  sourceUrl: z.string(),
  creator: z.string(),
  license: z.string(),
  licenseUrl: z.string().optional(),
  creatorUrl: z.string().optional(),
});

const FootageResponseSchema = z.object({
  clips: z.array(FootageClipSchema),
  errors: z.array(z.unknown()).default([]),
});

export interface FootageRequest {
  outputDir: string;
  /** `clipsPerQuery` per query overrides the global one (beat queries share their scene's budget). */
  queries: { sceneIndex: number; query: string; clipsPerQuery?: number }[];
  clipsPerQuery: number;
  minDurationSeconds: number;
  /** null = let the adapter use every allowlisted source whose API key is configured. */
  sources: string[] | null;
  /** Media kinds wanted (adapter extension; older adapters ignore it and return videos). */
  kinds?: FootageClip["kind"][];
  /** Wall-clock budget: the adapter starts no new search after it and returns partial results. */
  deadlineSeconds?: number;
}

/** Leaves the adapter 60 s to wrap up and print its JSON before the subprocess timeout kills it. */
export const ADAPTER_DEADLINE_SECONDS = FOOTAGE_TIMEOUT_MS / 1000 - 60;

/**
 * Guarantees at least one clip per scene by borrowing from the nearest scene that has footage
 * (previous scene wins ties). Returns the filled list plus the scenes that had to borrow.
 */
export function fillMissingScenes(
  clips: readonly FootageClip[],
  sceneCount: number,
): { clips: FootageClip[]; borrowed: { sceneIndex: number; fromScene: number }[] } {
  if (clips.length === 0) throw new Error("Footage adapter returned zero clips for all scenes");
  const byScene = new Map<number, FootageClip[]>();
  for (const clip of clips) byScene.set(clip.sceneIndex, [...(byScene.get(clip.sceneIndex) ?? []), clip]);
  const result: FootageClip[] = [];
  const borrowed: { sceneIndex: number; fromScene: number }[] = [];
  for (let scene = 0; scene < sceneCount; scene++) {
    const own = byScene.get(scene);
    if (own && own.length > 0) {
      result.push(...own);
      continue;
    }
    const donor = nearestSceneWithClips(scene, sceneCount, byScene);
    const donorClip = byScene.get(donor)?.[0];
    if (!donorClip) throw new Error(`No donor clip found for scene ${scene}`);
    const { beatIndex: _beat, ...donorFields } = donorClip; // the donor's beat means nothing in this scene
    result.push({ ...donorFields, sceneIndex: scene, borrowedFromScene: donor });
    borrowed.push({ sceneIndex: scene, fromScene: donor });
  }
  return { clips: result, borrowed };
}

function nearestSceneWithClips(scene: number, sceneCount: number, byScene: Map<number, FootageClip[]>): number {
  const hasClips = (i: number): boolean => (byScene.get(i)?.length ?? 0) > 0;
  for (let distance = 1; distance < sceneCount; distance++) {
    if (scene - distance >= 0 && hasClips(scene - distance)) return scene - distance;
    if (scene + distance < sceneCount && hasClips(scene + distance)) return scene + distance;
  }
  // Clips exist but only for out-of-range scene indexes: fall back to any of them.
  const anyScene = [...byScene.keys()].find(hasClips);
  if (anyScene === undefined) throw new Error("No clips available to borrow");
  return anyScene;
}

function absolutize(clip: FootageClip): FootageClip {
  return isAbsolute(clip.path) ? clip : { ...clip, path: paths.fromRoot(clip.path) };
}

const AdapterErrorSchema = z
  .object({
    sceneIndex: z.number().nullish(),
    query: z.string().nullish(),
    source: z.string().nullish(),
    phase: z.string().nullish(),
    message: z.string(),
  })
  .loose();

export function formatAdapterError(error: unknown): string {
  const parsed = AdapterErrorSchema.safeParse(error);
  if (!parsed.success) return redactSecrets(typeof error === "string" ? error : JSON.stringify(error));
  const e = parsed.data;
  const where = [e.phase, e.sceneIndex != null ? `scene ${e.sceneIndex}` : null, e.source].filter(Boolean).join(" ");
  return redactSecrets(`${where ? `[${where}] ` : ""}${e.message}`);
}

function logAdapterErrors(log: Logger, errors: unknown[]): void {
  for (const error of errors) log.warn(`Footage adapter: ${formatAdapterError(error)}`);
}

// ---------------------------------------------------------------------------------------------
// Normalization: every clip becomes a small 1080x1920 H.264 file Remotion can decode cheaply
// ---------------------------------------------------------------------------------------------

const NORMALIZE_CONCURRENCY = 2;
const RETRY_CLIPS_PER_QUERY = 2;
const NORMALIZE_TIMEOUT_MS = 180_000;
const MAX_CLIP_SECONDS = 20;

/** Runs fn over items with at most `limit` in flight; results keep input order. */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** "<sceneIndex>_<prefix><n>" where n counts clips within the same scene. */
export function normalizedBaseNames(clips: readonly Pick<FootageClip, "sceneIndex">[], prefix = ""): string[] {
  const perScene = new Map<number, number>();
  return clips.map((clip) => {
    const n = perScene.get(clip.sceneIndex) ?? 0;
    perScene.set(clip.sceneIndex, n + 1);
    return `${clip.sceneIndex}_${prefix}${n}`;
  });
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function normalizeClip(clip: FootageClip, outputBase: string, target: NormalizeTarget): Promise<FootageClip> {
  const { ffmpeg } = resolveFfmpegBinaries();
  const source = await probeVideo(clip.path);
  const isImage = clip.kind === "image";
  const output = `${outputBase}.${isImage ? "jpg" : "mp4"}`;
  const args = isImage
    ? buildImageNormalizeArgs(clip.path, output, target)
    : buildVideoNormalizeArgs(clip.path, output, source.durationSeconds, target);
  await runBinary(ffmpeg, args, NORMALIZE_TIMEOUT_MS);
  const result = await probeVideo(output);
  if (!isImage && result.durationSeconds <= 0) throw new Error(`Normalized clip has no duration: ${output}`);
  return {
    ...clip,
    path: output,
    durationSeconds: isImage ? clip.durationSeconds : result.durationSeconds,
    width: result.width,
    height: result.height,
  };
}

interface NormalizeSummary {
  clips: FootageClip[];
  rawBytes: number;
  normalizedBytes: number;
}

/** Normalizes every clip; failures are dropped with a warning. Successful raw downloads are deleted. */
async function normalizeAll(
  clips: readonly FootageClip[],
  normDir: string,
  log: Logger,
  namePrefix = "",
  sourceSizes?: Map<string, SourceSize>,
): Promise<NormalizeSummary> {
  const { width, height, fps } = loadConfig().video;
  const target: NormalizeTarget = { width, height, fps, maxSeconds: MAX_CLIP_SECONDS };
  await mkdir(normDir, { recursive: true });
  const names = normalizedBaseNames(clips, namePrefix);
  const rawPaths = [...new Set(clips.map((c) => c.path))];
  const rawBytes = await totalSize(rawPaths);
  const results = await mapWithConcurrency(clips, NORMALIZE_CONCURRENCY, async (clip, i) => {
    const started = performance.now();
    try {
      const normalized = await normalizeClip(clip, join(normDir, names[i] ?? `clip_${i}`), target);
      sourceSizes?.set(normalized.path, { width: clip.width, height: clip.height });
      log.info(
        `Normalized ${basename(clip.path)} -> ${basename(normalized.path)} (${normalized.durationSeconds.toFixed(1)} s) in ${seconds(started)}`,
      );
      return normalized;
    } catch (error) {
      log.warn(`Dropping clip ${basename(clip.path)} (scene ${clip.sceneIndex}): normalization failed: ${errorText(error)}`);
      return undefined;
    }
  });
  const survivors = results.filter((c): c is FootageClip => c !== undefined);
  // Raw files of failed clips are kept for debugging; successful ones are no longer needed.
  const failedRaw = new Set(clips.filter((_, i) => results[i] === undefined).map((c) => c.path));
  await Promise.all(rawPaths.filter((p) => !failedRaw.has(p)).map((p) => rm(p, { force: true })));
  await removeEmptyDirs([...new Set(rawPaths.map((p) => dirname(p)))]);
  return { clips: survivors, rawBytes, normalizedBytes: await totalSize(survivors.map((c) => c.path)) };
}

async function totalSize(files: readonly string[]): Promise<number> {
  return (await Promise.all(files.map(fileSize))).reduce((a, b) => a + b, 0);
}

/** rmdir only succeeds on empty directories, which is exactly what we want here. */
async function removeEmptyDirs(dirs: readonly string[]): Promise<void> {
  for (const d of dirs) await rmdir(d).catch(() => undefined);
}

const toMb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const seconds = (startedMs: number): string => `${((performance.now() - startedMs) / 1000).toFixed(1)} s`;
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------------------------
// Adapter calls
// ---------------------------------------------------------------------------------------------

async function requestFootage(
  queries: FootageRequest["queries"],
  outputDir: string,
  clipsPerQuery: number,
  log: Logger,
): Promise<FootageClip[]> {
  const footageConfig = loadConfig().footage;
  await mkdir(outputDir, { recursive: true });
  const request: FootageRequest = {
    outputDir,
    queries,
    clipsPerQuery,
    minDurationSeconds: footageConfig?.minDurationSeconds ?? 4,
    sources: footageConfig?.sources ?? null,
    kinds: footageConfig?.kinds ?? ["video", "image"],
    deadlineSeconds: ADAPTER_DEADLINE_SECONDS,
  };
  const sourceLabel = request.sources ? `[${request.sources.join(", ")}]` : "all allowlisted sources";
  log.info(
    `Fetching ${clipsPerQuery} clip(s) per query (${request.kinds?.join("+") ?? "video"}) for ${queries.length} queries from ${sourceLabel}`,
  );
  let response: z.infer<typeof FootageResponseSchema>;
  try {
    response = await runPythonJson({
      script: FOOTAGE_SCRIPT,
      stdin: request,
      timeoutMs: FOOTAGE_TIMEOUT_MS,
      schema: FootageResponseSchema,
      onStderrLine: (line) => log.debug(`[footage] ${line}`),
      envKeys: ["PEXELS_API_KEY", "PIXABAY_API_KEY"],
    });
  } catch (error) {
    // Documented adapter exit code 1 = "zero usable clips": a content problem, not a crash.
    if (error instanceof PythonExitError && error.exitCode === 1) {
      log.warn(`Footage adapter found zero usable clips for ${queries.length} queries`);
      return [];
    }
    throw error;
  }
  logAdapterErrors(log, response.errors);
  return response.clips.map(absolutize);
}

/** Running totals for the stage summary. */
interface FootageStats {
  downloaded: number;
  rawBytes: number;
  normalizedBytes: number;
  visionCalls: number;
  textCalls: number;
}

interface FetchRound {
  queries: FootageRequest["queries"];
  downloadDir: string;
  normDir: string;
  clipsPerQuery: number;
  namePrefix: string;
  /**
   * Pseudo scene index carrying the hook query (scene count, so it never collides with a real scene). Its clips
   * belong to scene 0 and are named "0_h<n>" so the gate knows they came from Script.hookFootageQuery.
   */
  hookSceneIndex?: number;
  /** First round only: clips get their beat (beat queries travel as pseudo scene indexes, see lib/beats.ts). */
  beatsOf?: Pick<Script, "scenes">;
}

/** Normalized-name prefix of clips found by the hook query (scene 0). */
export const HOOK_CLIP_PREFIX = "h";

export function isHookClip(clip: Pick<FootageClip, "path" | "sceneIndex">): boolean {
  return clip.sceneIndex === 0 && basename(clip.path).startsWith(`0_${HOOK_CLIP_PREFIX}`);
}

/**
 * First-round queries: scene 0 asks for the hook's iconic visual first (as pseudo scene `scenes.length`),
 * then its own footageQuery as the fallback; every other scene its footageQuery (= beat 0) followed by its
 * other beats as pseudo scene indexes. With `budget`, scenes with several beats split their candidate budget.
 */
export function firstRoundQueries(
  script: Pick<Script, "scenes" | "hookFootageQuery">,
  budget?: { clipsPerQuery: number; kinds: number },
): FootageRequest["queries"] {
  const count = script.scenes.length;
  const scenes = script.scenes.flatMap((scene, sceneIndex) => {
    const beats = scene.beats ?? [];
    const cap = budget && beats.length > 1 ? { clipsPerQuery: beatClipsPerQuery(beats.length, budget.clipsPerQuery, budget.kinds) } : {};
    return [
      { sceneIndex, query: scene.footageQuery, ...cap },
      ...beats.slice(1).map((b, k) => ({ sceneIndex: encodeBeatSlot(sceneIndex, k + 1, count), query: b.footageQuery, ...cap })),
    ];
  });
  const hook = script.hookFootageQuery?.trim();
  const sceneZero = script.scenes[0]?.footageQuery.trim().toLowerCase();
  if (!hook || hook.toLowerCase() === sceneZero) return scenes;
  return [{ sceneIndex: count, query: hook }, ...scenes];
}

/** Downloads, drops clips already evaluated (same sourceUrl), normalizes. */
async function fetchAndNormalize(
  round: FetchRound,
  seenSourceUrls: Set<string>,
  stats: FootageStats,
  log: Logger,
  sourceSizes?: Map<string, SourceSize>,
): Promise<FootageClip[]> {
  const downloaded = await requestFootage(round.queries, round.downloadDir, round.clipsPerQuery, log);
  // First occurrence wins, also within one response (the hook query and scene 0's query may find the same file).
  const fresh: FootageClip[] = [];
  for (const c of downloaded) {
    if (c.sourceUrl && seenSourceUrls.has(c.sourceUrl)) continue;
    if (c.sourceUrl) seenSourceUrls.add(c.sourceUrl);
    fresh.push(c);
  }
  const duplicates = downloaded.filter((c) => !fresh.includes(c));
  await Promise.all(duplicates.filter((c) => !fresh.some((f) => f.path === c.path)).map((c) => rm(c.path, { force: true })));
  if (duplicates.length > 0) log.info(`Skipped ${duplicates.length} clip(s) already evaluated earlier`);
  const fromHook = (c: { sceneIndex: number }): boolean => round.hookSceneIndex !== undefined && c.sceneIndex === round.hookSceneIndex;
  const beatOf = (c: FootageClip): FootageClip => (round.beatsOf ? withBeat(c, round.beatsOf) : c);
  const hookClips = fresh.filter(fromHook).map((c) => beatOf({ ...c, sceneIndex: 0 }));
  const sceneClips = fresh.filter((c) => !fromHook(c)).map(beatOf);
  const parts = [
    await normalizeAll(hookClips, round.normDir, log, HOOK_CLIP_PREFIX, sourceSizes),
    await normalizeAll(sceneClips, round.normDir, log, round.namePrefix, sourceSizes),
  ];
  stats.downloaded += downloaded.length;
  for (const part of parts) {
    stats.rawBytes += part.rawBytes;
    stats.normalizedBytes += part.normalizedBytes;
  }
  const hookQuery = round.queries.find(fromHook)?.query;
  if (hookQuery) log.info(`Hook query "${hookQuery}" gave ${parts[0]?.clips.length ?? 0} candidate(s) for scene 0`);
  return parts.flatMap((part) => part.clips);
}

// ---------------------------------------------------------------------------------------------
// Relevance gate
// ---------------------------------------------------------------------------------------------

interface GateContext {
  script: Script;
  settings: RelevanceSettings;
  /** Footage queries may name specific subjects (script.specificFootage): alternative queries may too. */
  specificFootage: boolean;
  /** Source (pre-normalization) size of every normalized clip, for the low-resolution penalty. */
  sourceSizes: Map<string, SourceSize>;
  dirs: { footage: string; frames: string };
  seen: Set<string>;
  stats: FootageStats;
  log: Logger;
  /** Alternative queries used in the retry round, per scene (shown to the reviewer for retry clips). */
  altQueries: Map<number, string[]>;
}

/** What the reviewer judges a clip against: scene 0 also carries the hook, which is spoken over it. */
export function sceneForClip(
  script: Pick<Script, "scenes" | "hook" | "hookFootageQuery">,
  clip: Pick<FootageClip, "path" | "sceneIndex">,
  altQueries: ReadonlyMap<number, string[]> = new Map(),
): ScriptScene {
  const base = script.scenes[clip.sceneIndex] ?? { narration: "", footageQuery: "" };
  const scene = clip.sceneIndex === 0 ? { ...base, narration: `${script.hook.trim()} ${base.narration}`.trim() } : base;
  if (isHookClip(clip) && script.hookFootageQuery) return { ...scene, footageQuery: script.hookFootageQuery };
  const alts = altQueries.get(clip.sceneIndex);
  const isRetryClip = basename(clip.path).startsWith(`${clip.sceneIndex}_r`);
  return alts && isRetryClip ? { ...scene, footageQuery: alts.join(" / ") } : scene;
}

async function scoreAll(clips: readonly FootageClip[], gate: GateContext): Promise<ScoredClip[]> {
  const { settings, stats, log } = gate;
  const relevanceProvider = settings.provider ? getProviderByName(settings.provider) : undefined;
  return mapWithConcurrency(clips, settings.concurrency, async (clip) => {
    const started = performance.now();
    const scene = sceneForClip(gate.script, clip, gate.altQueries);
    const beat = beatForClip(gate.script, clip);
    const raw = await scoreClip(clip, scene, gate.dirs.frames, gate.script.title, settings.thinking, gate.script.hook, relevanceProvider, beat);
    const scored = penalizeLowResolution(raw, gate.sourceSizes.get(clip.path));
    stats.visionCalls++;
    const where = `scene ${clip.sceneIndex}${beat ? ` beat ${clip.beatIndex}` : ""}`;
    if (scored.verdict) {
      log.info(`Scored ${basename(clip.path)} (${where}): ${describeScored(scored, settings.minScore)} in ${seconds(started)} - ${scored.verdict.reason}`);
    } else {
      log.warn(`Could not score ${basename(clip.path)} (${where}): ${scored.error ?? "unknown error"}`);
    }
    return scored;
  });
}

async function alternativeQueries(failed: readonly FailedScene[], gate: GateContext): Promise<Map<number, string[]>> {
  try {
    gate.stats.textCalls++;
    return normalizeAlternatives(failed, await proposeAlternativeQueries(failed, gate.specificFootage));
  } catch (error) {
    gate.log.warn(`Alternative query generation failed, using simplified queries: ${errorText(error)}`);
    return normalizeAlternatives(failed, undefined);
  }
}

/**
 * One selection per scene, or per beat of a scene with beats (each beat keeps a share of keepPerScene); clips
 * of a beat scene that have no beat (retry round) form one more group of their own.
 */
function selectAll(scored: readonly ScoredClip[], gate: GateContext, allowWeak: boolean): SceneSelection[] {
  const preferred = (s: ScoredClip): boolean => isHookClip(s.clip);
  return gate.script.scenes.flatMap((scene, sceneIndex) => {
    const own = scored.filter((s) => s.clip.sceneIndex === sceneIndex);
    const beats = scene.beats ?? [];
    if (beats.length === 0) return [selectSceneClips(sceneIndex, own, gate.settings, allowWeak, preferred)];
    const settings = { ...gate.settings, keepPerScene: keepPerBeat(gate.settings.keepPerScene, beats.length) };
    const loose = own.filter((s) => s.clip.beatIndex === undefined);
    return [
      ...beats.map((_, beatIndex) => ({
        ...selectSceneClips(sceneIndex, own.filter((s) => s.clip.beatIndex === beatIndex), settings, allowWeak, preferred),
        beatIndex,
      })),
      ...(loose.length > 0 ? [selectSceneClips(sceneIndex, loose, gate.settings, allowWeak, preferred)] : []),
    ];
  });
}

/** Scenes where no selection (no beat) passed. */
function scenesWithoutPass(selections: readonly SceneSelection[]): number[] {
  const passing = new Set(selections.filter((s) => s.mode === "pass").map((s) => s.sceneIndex));
  return [...new Set(selections.map((s) => s.sceneIndex))].filter((i) => !passing.has(i));
}

function logSceneSummary(selections: readonly SceneSelection[], gate: GateContext): void {
  for (const sel of selections) {
    const all = [...sel.kept, ...sel.discarded].map((s) => describeScored(s, gate.settings.minScore)).join(" ");
    const kept = sel.kept.map((s) => basename(s.clip.path)).join(", ") || "none";
    const where = `Scene ${sel.sceneIndex}${sel.beatIndex !== undefined ? ` beat ${sel.beatIndex}` : ""}`;
    const line = `${where}: ${sel.mode} -> kept ${kept} | candidates ${all || "none"}`;
    if (sel.mode === "pass") gate.log.info(line);
    else gate.log.warn(line);
  }
}

/** One retry round for scenes without a passing clip (in any beat), using scene-level alternative queries. */
async function retryFailedScenes(scored: readonly ScoredClip[], gate: GateContext): Promise<ScoredClip[]> {
  const failed = scenesWithoutPass(selectAll(scored, gate, false));
  if (failed.length === 0) return [];
  const failedScenes: FailedScene[] = failed.flatMap((sceneIndex) => {
    const scene = gate.script.scenes[sceneIndex];
    return scene ? [{ sceneIndex, narration: scene.narration, footageQuery: scene.footageQuery }] : [];
  });
  for (const [k, v] of await alternativeQueries(failedScenes, gate)) gate.altQueries.set(k, v);
  const queries = [...gate.altQueries].flatMap(([sceneIndex, qs]) => qs.map((query) => ({ sceneIndex, query })));
  gate.log.warn(
    `No passing clip for scene(s) ${failed.join(", ")}; retrying with ` + queries.map((q) => `${q.sceneIndex}:"${q.query}"`).join(", "),
  );
  if (queries.length === 0) return [];
  const round: FetchRound = {
    queries,
    downloadDir: join(gate.dirs.footage, "retry"),
    normDir: join(gate.dirs.footage, "norm"),
    clipsPerQuery: RETRY_CLIPS_PER_QUERY,
    namePrefix: "r",
  };
  return scoreAll(await fetchAndNormalize(round, gate.seen, gate.stats, gate.log, gate.sourceSizes), gate);
}

interface GateResult {
  kept: FootageClip[];
  rejected: number;
}

async function runRelevanceGate(firstRound: readonly FootageClip[], gate: GateContext): Promise<GateResult> {
  const firstScored = await scoreAll(firstRound, gate);
  if (firstScored.length > 0 && firstScored.every((s) => !s.verdict)) {
    throw new Error(`Relevance gate unavailable (every scoring call failed): ${firstScored[0]?.error ?? "unknown"}`);
  }
  const scored = [...firstScored, ...(await retryFailedScenes(firstScored, gate))];
  const selections = selectAll(scored, gate, true);
  logSceneSummary(selections, gate);
  const keptScored = selections.flatMap((s) => s.kept);
  await Promise.all(scored.filter((s) => !keptScored.includes(s)).map((s) => rm(s.clip.path, { force: true })));
  const rejected = scored.filter((s) => classifyClip(s, gate.settings.minScore) === "reject").length;
  return { kept: keptScored.map(annotateClip), rejected };
}

/** Gate disabled: keep the first `keepPerScene` normalized clips of each scene, delete the rest. */
async function keepFirstPerScene(clips: readonly FootageClip[], keepPerScene: number): Promise<FootageClip[]> {
  const counts = new Map<number, number>();
  const kept = clips.filter((c) => {
    const n = counts.get(c.sceneIndex) ?? 0;
    counts.set(c.sceneIndex, n + 1);
    return n < keepPerScene;
  });
  await Promise.all(clips.filter((c) => !kept.includes(c)).map((c) => rm(c.path, { force: true })));
  return kept;
}

// ---------------------------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------------------------

export async function run(ctx: RunContext): Promise<RunContext> {
  const script = ctx.script;
  if (!script) throw new Error("03-fetchFootage requires ctx.script (run 02-generateScript first)");
  const log = getLogger(ctx.runId);
  const config = loadConfig();
  const footageConfig = config.footage;
  const settings = resolveRelevanceSettings(footageConfig);
  const footageDir = join(ctx.runDir, "footage");
  const gate: GateContext = {
    script,
    settings,
    specificFootage: resolveScript(config.script).specificFootage,
    sourceSizes: new Map(),
    dirs: { footage: footageDir, frames: join(footageDir, "frames") },
    seen: new Set<string>(),
    stats: { downloaded: 0, rawBytes: 0, normalizedBytes: 0, visionCalls: 0, textCalls: 0 },
    log,
    altQueries: new Map(),
  };
  const kindCount = footageConfig?.kinds?.length ?? 2;
  // The adapter returns up to clipsPerQuery items of EACH kind; 3 per kind keeps ~6 candidates per scene.
  // Scenes with several beats split a budget of 1.5x that between their beat queries (lib/beats.ts).
  const clipsPerQuery = footageConfig?.clipsPerQuery ?? (settings.enabled ? (kindCount > 1 ? 3 : 4) : 2);
  const firstRound = await fetchAndNormalize(
    {
      queries: firstRoundQueries(script, { clipsPerQuery, kinds: kindCount }),
      downloadDir: footageDir,
      normDir: join(footageDir, "norm"),
      clipsPerQuery,
      namePrefix: "",
      hookSceneIndex: script.scenes.length,
      beatsOf: script,
    },
    gate.seen,
    gate.stats,
    log,
    gate.sourceSizes,
  );
  if (firstRound.length === 0) throw new RunRejectedError("No usable footage for this script (every query empty or failed)", ctx);

  let kept: FootageClip[];
  let rejected = 0;
  if (settings.enabled) {
    ({ kept, rejected } = await runRelevanceGate(firstRound, gate));
    await removeEmptyDirs([gate.dirs.frames, join(footageDir, "retry")]);
  } else {
    log.warn("Relevance gate disabled in config; footage is NOT checked against the narration");
    kept = await keepFirstPerScene(firstRound, settings.keepPerScene);
  }
  const { stats } = gate;
  log.info(
    `Footage: ${stats.downloaded} downloaded (${toMb(stats.rawBytes)}), normalized ${toMb(stats.normalizedBytes)}, ` +
      `kept ${kept.length}, rejected for text/logo/people/era ${rejected}, ` +
      `LLM calls ${stats.visionCalls} vision + ${stats.textCalls} text`,
  );
  if (kept.length === 0) throw new RunRejectedError("No clip survived the relevance gate for any scene", ctx);
  const { clips, borrowed } = fillMissingScenes(kept, script.scenes.length);
  if (!creditsFitDescription(script, clips)) {
    throw new RunRejectedError("Image credits would not fit in YouTube's 5000-char description (CC BY credits are mandatory)", ctx);
  }
  for (const b of borrowed) log.warn(`Scene ${b.sceneIndex} got no usable footage; reusing a clip from scene ${b.fromScene}`);
  const quality = assessQuality(clips, script.scenes.length, settings, footageConfig?.minPassingSceneRatio ?? 0.6);
  const kinds = clips.filter((c) => c.borrowedFromScene === undefined).map((c) => c.kind);
  log.info(
    `Quality: ${quality.verdict} - ${quality.reason ?? ""}; kept kinds: ` +
      `${kinds.filter((k) => k === "video").length} video, ${kinds.filter((k) => k === "image").length} image`,
  );
  return { ...ctx, footage: clips, quality: { ...quality, contentHash: footageHash(script, clips) } };
}
