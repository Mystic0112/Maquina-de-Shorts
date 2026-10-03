import { mkdir, rm, rmdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
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
  proposeAlternativeQueries,
  resolveRelevanceSettings,
  scoreClip,
  selectSceneClips,
  type FailedScene,
  type RelevanceSettings,
  type SceneSelection,
  type ScoredClip,
} from "../lib/relevance.js";
import { runPythonJson } from "../lib/python.js";
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
});

const FootageResponseSchema = z.object({
  clips: z.array(FootageClipSchema),
  errors: z.array(z.unknown()).default([]),
});

export interface FootageRequest {
  outputDir: string;
  queries: { sceneIndex: number; query: string }[];
  clipsPerQuery: number;
  minDurationSeconds: number;
  /** null = let the adapter use every allowlisted source whose API key is configured. */
  sources: string[] | null;
  /** Media kinds wanted (adapter extension; older adapters ignore it and return videos). */
  kinds?: FootageClip["kind"][];
}

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
    result.push({ ...donorClip, sceneIndex: scene, borrowedFromScene: donor });
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
  if (!parsed.success) return typeof error === "string" ? error : JSON.stringify(error);
  const e = parsed.data;
  const where = [e.phase, e.sceneIndex != null ? `scene ${e.sceneIndex}` : null, e.source].filter(Boolean).join(" ");
  return `${where ? `[${where}] ` : ""}${e.message}`;
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
  };
  const sourceLabel = request.sources ? `[${request.sources.join(", ")}]` : "all allowlisted sources";
  log.info(
    `Fetching ${clipsPerQuery} clip(s) per query (${request.kinds?.join("+") ?? "video"}) for ${queries.length} queries from ${sourceLabel}`,
  );
  const response = await runPythonJson({
    script: FOOTAGE_SCRIPT,
    stdin: request,
    timeoutMs: FOOTAGE_TIMEOUT_MS,
    schema: FootageResponseSchema,
    onStderrLine: (line) => log.debug(`[footage] ${line}`),
  });
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
}

/** Downloads, drops clips already evaluated (same sourceUrl), normalizes. */
async function fetchAndNormalize(
  round: FetchRound,
  seenSourceUrls: Set<string>,
  stats: FootageStats,
  log: Logger,
): Promise<FootageClip[]> {
  const downloaded = await requestFootage(round.queries, round.downloadDir, round.clipsPerQuery, log);
  const fresh = downloaded.filter((c) => !c.sourceUrl || !seenSourceUrls.has(c.sourceUrl));
  const duplicates = downloaded.filter((c) => !fresh.includes(c));
  await Promise.all(duplicates.map((c) => rm(c.path, { force: true })));
  for (const c of fresh) if (c.sourceUrl) seenSourceUrls.add(c.sourceUrl);
  if (duplicates.length > 0) log.info(`Skipped ${duplicates.length} clip(s) already evaluated earlier`);
  const normalized = await normalizeAll(fresh, round.normDir, log, round.namePrefix);
  stats.downloaded += downloaded.length;
  stats.rawBytes += normalized.rawBytes;
  stats.normalizedBytes += normalized.normalizedBytes;
  return normalized.clips;
}

// ---------------------------------------------------------------------------------------------
// Relevance gate
// ---------------------------------------------------------------------------------------------

interface GateContext {
  script: Script;
  settings: RelevanceSettings;
  dirs: { footage: string; frames: string };
  seen: Set<string>;
  stats: FootageStats;
  log: Logger;
  /** Alternative queries used in the retry round, per scene (shown to the reviewer for retry clips). */
  altQueries: Map<number, string[]>;
}

function sceneForClip(gate: GateContext, clip: FootageClip): ScriptScene {
  const scene = gate.script.scenes[clip.sceneIndex] ?? { narration: "", footageQuery: "" };
  const alts = gate.altQueries.get(clip.sceneIndex);
  const isRetryClip = basename(clip.path).startsWith(`${clip.sceneIndex}_r`);
  return alts && isRetryClip ? { ...scene, footageQuery: alts.join(" / ") } : scene;
}

async function scoreAll(clips: readonly FootageClip[], gate: GateContext): Promise<ScoredClip[]> {
  const { settings, stats, log } = gate;
  return mapWithConcurrency(clips, settings.concurrency, async (clip) => {
    const started = performance.now();
    const scored = await scoreClip(clip, sceneForClip(gate, clip), gate.dirs.frames, gate.script.title, settings.thinking);
    stats.visionCalls++;
    if (scored.verdict) {
      log.info(
        `Scored ${basename(clip.path)} (scene ${clip.sceneIndex}): ${describeScored(scored, settings.minScore)} ` +
          `in ${seconds(started)} - ${scored.verdict.reason}`,
      );
    } else {
      log.warn(`Could not score ${basename(clip.path)} (scene ${clip.sceneIndex}): ${scored.error ?? "unknown error"}`);
    }
    return scored;
  });
}

async function alternativeQueries(failed: readonly FailedScene[], gate: GateContext): Promise<Map<number, string[]>> {
  try {
    gate.stats.textCalls++;
    return normalizeAlternatives(failed, await proposeAlternativeQueries(failed));
  } catch (error) {
    gate.log.warn(`Alternative query generation failed, using simplified queries: ${errorText(error)}`);
    return normalizeAlternatives(failed, undefined);
  }
}

function selectAll(scored: readonly ScoredClip[], gate: GateContext, allowWeak: boolean): SceneSelection[] {
  const groups: ScoredClip[][] = gate.script.scenes.map(() => []);
  for (const s of scored) groups[s.clip.sceneIndex]?.push(s);
  return groups.map((candidates, sceneIndex) => selectSceneClips(sceneIndex, candidates, gate.settings, allowWeak));
}

function logSceneSummary(selections: readonly SceneSelection[], gate: GateContext): void {
  for (const sel of selections) {
    const all = [...sel.kept, ...sel.discarded].map((s) => describeScored(s, gate.settings.minScore)).join(" ");
    const kept = sel.kept.map((s) => basename(s.clip.path)).join(", ") || "none";
    const line = `Scene ${sel.sceneIndex}: ${sel.mode} -> kept ${kept} | candidates ${all || "none"}`;
    if (sel.mode === "pass") gate.log.info(line);
    else gate.log.warn(line);
  }
}

/** One retry round for scenes without a passing clip, using alternative queries. */
async function retryFailedScenes(scored: readonly ScoredClip[], gate: GateContext): Promise<ScoredClip[]> {
  const failed = selectAll(scored, gate, false).filter((s) => s.mode === "none");
  if (failed.length === 0) return [];
  const failedScenes: FailedScene[] = failed.flatMap((f) => {
    const scene = gate.script.scenes[f.sceneIndex];
    return scene ? [{ sceneIndex: f.sceneIndex, narration: scene.narration, footageQuery: scene.footageQuery }] : [];
  });
  for (const [k, v] of await alternativeQueries(failedScenes, gate)) gate.altQueries.set(k, v);
  const queries = [...gate.altQueries].flatMap(([sceneIndex, qs]) => qs.map((query) => ({ sceneIndex, query })));
  gate.log.warn(
    `No passing clip for scene(s) ${failed.map((f) => f.sceneIndex).join(", ")}; retrying with ` +
      queries.map((q) => `${q.sceneIndex}:"${q.query}"`).join(", "),
  );
  if (queries.length === 0) return [];
  const round: FetchRound = {
    queries,
    downloadDir: join(gate.dirs.footage, "retry"),
    normDir: join(gate.dirs.footage, "norm"),
    clipsPerQuery: RETRY_CLIPS_PER_QUERY,
    namePrefix: "r",
  };
  return scoreAll(await fetchAndNormalize(round, gate.seen, gate.stats, gate.log), gate);
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
  const footageConfig = loadConfig().footage;
  const settings = resolveRelevanceSettings(footageConfig);
  const footageDir = join(ctx.runDir, "footage");
  const gate: GateContext = {
    script,
    settings,
    dirs: { footage: footageDir, frames: join(footageDir, "frames") },
    seen: new Set<string>(),
    stats: { downloaded: 0, rawBytes: 0, normalizedBytes: 0, visionCalls: 0, textCalls: 0 },
    log,
    altQueries: new Map(),
  };
  const firstRound = await fetchAndNormalize(
    {
      queries: script.scenes.map((scene, sceneIndex) => ({ sceneIndex, query: scene.footageQuery })),
      downloadDir: footageDir,
      normDir: join(footageDir, "norm"),
      // The adapter returns up to clipsPerQuery items of EACH kind; 3 per kind keeps ~6 candidates per scene.
      clipsPerQuery: footageConfig?.clipsPerQuery ?? (settings.enabled ? ((footageConfig?.kinds?.length ?? 2) > 1 ? 3 : 4) : 2),
      namePrefix: "",
    },
    gate.seen,
    gate.stats,
    log,
  );
  if (firstRound.length === 0) throw new Error("No usable footage: every clip failed download or normalization");

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
      `kept ${kept.length}, rejected for text/logo/people ${rejected}, ` +
      `LLM calls ${stats.visionCalls} vision + ${stats.textCalls} text`,
  );
  if (kept.length === 0) throw new Error("No clip survived the relevance gate for any scene");
  const { clips, borrowed } = fillMissingScenes(kept, script.scenes.length);
  for (const b of borrowed) log.warn(`Scene ${b.sceneIndex} got no usable footage; reusing a clip from scene ${b.fromScene}`);
  const quality = assessQuality(clips, script.scenes.length, settings, footageConfig?.minPassingSceneRatio ?? 0.6);
  const kinds = clips.filter((c) => c.borrowedFromScene === undefined).map((c) => c.kind);
  log.info(
    `Quality: ${quality.verdict} - ${quality.reason ?? ""}; kept kinds: ` +
      `${kinds.filter((k) => k === "video").length} video, ${kinds.filter((k) => k === "image").length} image`,
  );
  return { ...ctx, footage: clips, quality };
}
