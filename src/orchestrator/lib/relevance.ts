import { basename, extname } from "node:path";
import { z } from "zod";
import type { FootageClip, QualitySummary, SceneBeat, ScriptScene } from "../types.js";
import type { PipelineConfig } from "./config.js";
import { DEFAULT_FRAME_FRACTIONS, extractFrames } from "./ffmpeg.js";
import {
  generateJson,
  generateJsonWithImages,
  type CallOptions,
  type LlmImage,
  type LlmProvider,
  type LlmProviderName,
  type ThinkingSetting,
} from "./llmClient.js";

// ---------------------------------------------------------------------------------------------
// Settings & verdicts
// ---------------------------------------------------------------------------------------------

export interface RelevanceSettings {
  enabled: boolean;
  minScore: number;
  /** Below-threshold clips scoring under this are never used, even as a last resort. */
  fallbackMinScore: number;
  keepPerScene: number;
  concurrency: number;
  thinking: ThinkingSetting;
  provider?: LlmProviderName;
  /** Per-call model override (config `llm.models.relevance`). */
  model?: string;
  /** Clips of the same scene/beat reviewed in one vision call (1 = one clip per call). */
  batchSize: number;
}

export const DEFAULT_KEEP_PER_SCENE = 3;
export const MAX_BATCH_SIZE = 6;
/** Frames a single vision call may carry; a batch over this is split. */
export const MAX_IMAGES_PER_CALL = 12;

export function resolveRelevanceSettings(footage: PipelineConfig["footage"], llm?: PipelineConfig["llm"]): RelevanceSettings {
  const r = footage?.relevance;
  return {
    enabled: r?.enabled ?? true,
    minScore: r?.minScore ?? 6,
    fallbackMinScore: r?.fallbackMinScore ?? 4,
    // 3 passing clips per scene give the renderer material to split long scenes into several shots.
    keepPerScene: r?.keepPerScene ?? DEFAULT_KEEP_PER_SCENE,
    concurrency: r?.concurrency ?? 4,
    thinking: r?.thinking ?? "low",
    provider: r?.provider,
    model: llm?.models?.relevance,
    batchSize: Math.min(MAX_BATCH_SIZE, Math.max(1, r?.batchSize ?? 1)),
  };
}

export const RelevanceVerdictSchema = z.object({
  score: z.number().min(0).max(10).describe("0-10: how well the footage illustrates the narration"),
  matches: z.boolean().describe("true if a typical viewer would find the footage fits the narration"),
  reason: z.string().describe("one short English sentence: what the frames show and why this score"),
  hasTextOrLogo: z.boolean().describe("burned-in text, subtitles, watermark, channel/agency logo or title card"),
  hasIdentifiablePeople: z.boolean().describe("any clearly recognizable human face"),
  wrongEraOrPlace: z
    .boolean()
    .optional()
    .describe("footage clearly shows a different century, country or civilization than the narration (anachronism)"),
  showsFace: z
    .boolean()
    .optional()
    .describe("a human face is the main subject (any person, statue or painting of a person with a visible face)"),
});

export type RelevanceVerdict = z.infer<typeof RelevanceVerdictSchema>;

export interface ScoredClip {
  clip: FootageClip;
  verdict?: RelevanceVerdict;
  /** Set when scoring failed (frame extraction or LLM error). */
  error?: string;
  /** JPEG frames sent to the reviewer (kept for the verdict log / training dataset). */
  frames?: Buffer[];
  /** Exact prompt sent with those frames (the batch prompt when reviewed in a batch). */
  prompt?: string;
}

/**
 * pass   = fits the narration and clears the threshold
 * weak   = clean but below threshold (last-resort candidate if score >= fallbackMinScore)
 * reject = text/logo/watermark or identifiable people: never used
 * unscored = scoring failed: never used (no human review, so unknown counts as unsafe)
 */
export type ClipStatus = "pass" | "weak" | "reject" | "unscored";

export function classifyClip(scored: ScoredClip, minScore: number): ClipStatus {
  const v = scored.verdict;
  if (!v) return "unscored";
  if (v.hasTextOrLogo || v.hasIdentifiablePeople || v.wrongEraOrPlace) return "reject";
  return v.matches && v.score >= minScore ? "pass" : "weak";
}

function rankValue(scored: ScoredClip): number {
  return scored.verdict?.score ?? -1;
}

export type SelectionMode = "pass" | "weak" | "none";

export interface SceneSelection {
  sceneIndex: number;
  /** Set when the candidates were searched for one beat of the scene. */
  beatIndex?: number;
  mode: SelectionMode;
  kept: ScoredClip[];
  discarded: ScoredClip[];
}

/**
 * Best `keepPerScene` passing clips, highest score first (the first one opens the scene); without any,
 * optionally the single best clean weak clip scoring at least `fallbackMinScore`. Ties go to `preferred`
 * clips (e.g. the hook query's iconic shot), then keep adapter order (stable sort).
 */
export function selectSceneClips(
  sceneIndex: number,
  candidates: readonly ScoredClip[],
  settings: Pick<RelevanceSettings, "minScore" | "keepPerScene" | "fallbackMinScore">,
  allowWeak: boolean,
  preferred: (scored: ScoredClip) => boolean = () => false,
): SceneSelection {
  const pref = (s: ScoredClip): number => (preferred(s) ? 1 : 0);
  const ranked = [...candidates].sort((a, b) => rankValue(b) - rankValue(a) || pref(b) - pref(a));
  const status = (s: ScoredClip): ClipStatus => classifyClip(s, settings.minScore);
  let kept = ranked.filter((s) => status(s) === "pass").slice(0, settings.keepPerScene);
  let mode: SelectionMode = kept.length > 0 ? "pass" : "none";
  if (kept.length === 0 && allowWeak) {
    kept = ranked.filter((s) => status(s) === "weak" && rankValue(s) >= settings.fallbackMinScore).slice(0, 1);
    mode = kept.length > 0 ? "weak" : "none";
  }
  const discarded = ranked.filter((s) => !kept.includes(s));
  return { sceneIndex, mode, kept, discarded };
}

/** Kept clip with the gate's verdict recorded on it. */
export function annotateClip(scored: ScoredClip): FootageClip {
  if (!scored.verdict) return { ...scored.clip, relevanceReason: `unscored: ${scored.error ?? "unknown error"}` };
  return {
    ...scored.clip,
    relevanceScore: scored.verdict.score,
    relevanceReason: scored.verdict.reason,
    relevanceMatches:
      scored.verdict.matches && !scored.verdict.hasTextOrLogo && !scored.verdict.hasIdentifiablePeople && !scored.verdict.wrongEraOrPlace,
    ...(scored.verdict.showsFace !== undefined ? { hasFace: scored.verdict.showsFace } : {}),
  };
}

export function describeScored(scored: ScoredClip, minScore: number): string {
  const name = basename(scored.clip.path, extname(scored.clip.path));
  const v = scored.verdict;
  if (!v) return `${name}=unscored`;
  const flags = [v.hasTextOrLogo ? "text/logo" : "", v.hasIdentifiablePeople ? "people" : "", v.wrongEraOrPlace ? "era/place" : ""].filter(Boolean);
  return `${name}=${v.score}${flags.length ? `[${flags.join(",")}]` : ""}(${classifyClip(scored, minScore)})`;
}

// ---------------------------------------------------------------------------------------------
// Source resolution
// ---------------------------------------------------------------------------------------------

/** Videos below this short side look soft after the 9:16 crop. */
export const MIN_VIDEO_SHORT_SIDE = 720;
/** Stills are cover-cropped to the frame; beyond these upscale factors they look blurry. */
export const IMAGE_UPSCALE_LIMITS = { soft: 1.5, blurry: 2 } as const;
export const LOW_RES_PENALTY = { soft: 1, blurry: 2 } as const;

export interface SourceSize {
  width: number;
  height: number;
}

/** Score points to subtract for a low-resolution source (dimensions as downloaded, before normalization). */
export function resolutionPenalty(
  source: SourceSize | undefined,
  kind: FootageClip["kind"],
  target: SourceSize = { width: 1080, height: 1920 },
): { penalty: number; note?: string } {
  if (!source || !(source.width > 0) || !(source.height > 0)) return { penalty: 0 };
  const size = `${source.width}x${source.height}`;
  if (kind === "video") {
    return Math.min(source.width, source.height) < MIN_VIDEO_SHORT_SIDE
      ? { penalty: LOW_RES_PENALTY.blurry, note: `low-res video ${size}` }
      : { penalty: 0 };
  }
  const upscale = Math.max(target.width / source.width, target.height / source.height);
  if (upscale > IMAGE_UPSCALE_LIMITS.blurry) return { penalty: LOW_RES_PENALTY.blurry, note: `still upscaled ${upscale.toFixed(1)}x (${size})` };
  if (upscale > IMAGE_UPSCALE_LIMITS.soft) return { penalty: LOW_RES_PENALTY.soft, note: `still upscaled ${upscale.toFixed(1)}x (${size})` };
  return { penalty: 0 };
}

/** The verdict with the low-resolution penalty applied to its score (and noted in the reason). */
export function penalizeLowResolution(scored: ScoredClip, source: SourceSize | undefined, target?: SourceSize): ScoredClip {
  const v = scored.verdict;
  if (!v) return scored;
  const { penalty, note } = resolutionPenalty(source, scored.clip.kind, target);
  if (penalty === 0) return scored;
  return { ...scored, verdict: { ...v, score: Math.max(0, v.score - penalty), reason: `${v.reason} [${note}: -${penalty}]` } };
}

// ---------------------------------------------------------------------------------------------
// Run-level quality gate
// ---------------------------------------------------------------------------------------------

/**
 * A scene passes only with one of its own (not borrowed) clips that truly passed review: the reviewer
 * said it matches the narration AND scored it >= minScore. Weak fallbacks never count.
 */
export function countPassingScenes(footage: readonly FootageClip[], sceneCount: number, minScore: number): number {
  const passing = new Set<number>();
  for (const clip of footage) {
    if (clip.borrowedFromScene !== undefined || clip.sceneIndex >= sceneCount) continue;
    if (clip.relevanceMatches === true && (clip.relevanceScore ?? -1) >= minScore) passing.add(clip.sceneIndex);
  }
  return passing.size;
}

export function assessQuality(
  footage: readonly FootageClip[],
  sceneCount: number,
  settings: Pick<RelevanceSettings, "enabled" | "minScore">,
  minPassingSceneRatio: number,
): QualitySummary {
  const passingScenes = settings.enabled ? countPassingScenes(footage, sceneCount, settings.minScore) : 0;
  const required = Math.ceil(minPassingSceneRatio * sceneCount);
  const base = {
    passingScenes,
    totalScenes: sceneCount,
    passingRatio: sceneCount > 0 ? Math.round((passingScenes / sceneCount) * 1000) / 1000 : 0,
    minPassingSceneRatio,
    minScore: settings.minScore,
  };
  if (!settings.enabled) return { ...base, verdict: "skipped", reason: "relevance gate disabled in config" };
  const verdict = passingScenes >= required ? "pass" : "fail";
  const reason = `${passingScenes}/${sceneCount} scenes have a clip scoring >= ${settings.minScore} (need ${required})`;
  return { ...base, verdict, reason };
}

// ---------------------------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------------------------

const REVIEWER_ROLE = `You are the automated footage reviewer for a faceless YouTube Shorts channel that narrates curiosities
about history, science and space in Brazilian Portuguese. No human reviews the videos before publishing, so be strict.`;

/** Title, hook and what is spoken while the footage is on screen (shared by single and batch prompts). */
function spokenContext(scene: ScriptScene, title?: string, hook?: string, beat?: SceneBeat): string {
  const spoken = beat
    ? `Narration of the whole scene (pt-BR, context only): "${scene.narration}"
WHAT IS BEING SAID while this footage is on screen (pt-BR): "${beat.phrase}"
Search query that found the clip: "${beat.footageQuery}"`
    : `Narration for this scene (pt-BR): "${scene.narration}"
Search query that found the clip: "${scene.footageQuery}"`;
  return `${title ? `Video title: "${title}"\n` : ""}${hook ? `Opening line of the video (pt-BR): "${hook}"\n` : ""}${spoken}`;
}

/** The verdict fields and scoring rules (identical for single-clip and batch reviews). */
function verdictRules(beat?: SceneBeat): string {
  const beatRule = beat
    ? `
  The footage MUST show the concrete thing named in the phrase being said (the phrase mentions sachets -> the frames
  show sachets, not a burger with ketchup); showing something else from the scene is at most 5 and matches=false.`
    : "";
  return `- score (0-10): how well the footage visually illustrates ${beat ? "the phrase being said" : "THIS narration"} for a viewer.
  9-10 = directly shows the subject being narrated; 7-8 = clearly related and fitting (e.g. generic space imagery
  for an astronomy line); 4-6 = only a loose mood match; 0-3 = unrelated or misleading (e.g. an office building or
  a zoo animal for a line about planets, or a different celestial body than the one named).${beatRule}
- matches: true only if a typical viewer would feel the footage fits what is being said.
- showsFace: true if a human face is the main subject of the frames: a photographed person, or a statue, bust,
  painting, engraving or drawing of a person with a visible face. False for landscapes, objects, buildings, space.
- hasTextOrLogo: true if any frame shows burned-in text, subtitles, captions, a watermark, a TV channel bug or logo
  (e.g. ZDF, BBC), an agency insignia (including the NASA logo), or a title card. Tiny incidental text on real-world
  objects far in the background does not count.
- hasIdentifiablePeople: true if any person's face is clearly recognizable. Distant crowds, silhouettes, people seen
  from behind and astronauts with visors down do not count. Faces in old paintings, engravings, drawings and statues
  (historical artworks) do not count either; photographs and video of real people do.
- wrongEraOrPlace: true if the footage clearly belongs to a different century, country/region or civilization than the
  narration (an anachronism): e.g. an American Civil War reenactment for a line about Paris in 1789; a Greek Doric
  temple or an Egyptian temple for a line about the Ptolemaic Library of Alexandria (unless the line is about that
  building); modern streets or cars for an ancient event; a nebula or galaxy for a line about the inside of a planet;
  a different planet or moon than the one named. Then also set matches=false and score <= 3. Timeless generic imagery
  (sea, sky, fire, parchment, rock) is not an anachronism.
- Visibly blurry, pixelated, heavily compressed or upscaled-looking frames lower the score by 2 or more.
- reason: one short English sentence describing what the frames show and why you gave that score.`;
}

export function buildRelevancePrompt(
  scene: ScriptScene,
  frameCount: number,
  title?: string,
  kind: FootageClip["kind"] = "video",
  hook?: string,
  beat?: SceneBeat,
): string {
  const subject =
    kind === "image"
      ? "The image is ONE still picture, already cropped to vertical 9:16, that would be shown (with a slow zoom)"
      : `The ${frameCount} image(s) are frames sampled from ONE stock clip, already cropped to vertical 9:16, that would play`;
  return `${REVIEWER_ROLE}

${subject}
while the narrator speaks the line below.
${spokenContext(scene, title, hook, beat)}

Return JSON with:
${verdictRules(beat)}`;
}

export interface BatchCandidate {
  kind: FootageClip["kind"];
  frameCount: number;
}

/**
 * Several DIFFERENT clips of the same scene/beat in one call. Images are attached in candidate order
 * (image 1 = first frame of candidate 1, ...), which is also the order the agy provider lists its files.
 */
export function buildRelevanceBatchPrompt(
  scene: ScriptScene,
  candidates: readonly BatchCandidate[],
  title?: string,
  hook?: string,
  beat?: SceneBeat,
): string {
  let next = 1;
  const list = candidates.map((c, i) => {
    const first = next;
    next += c.frameCount;
    const range = c.frameCount === 1 ? `image ${first}` : `images ${first}-${next - 1}`;
    const what = c.kind === "image" ? "one still picture" : `${c.frameCount} frames sampled from one stock clip`;
    return `- Candidate ${i + 1}: ${range} (${what})`;
  });
  return `${REVIEWER_ROLE}

The ${next - 1} attached images belong to ${candidates.length} DIFFERENT candidate clips, all already cropped to vertical 9:16,
each of which could be shown while the narrator speaks the line below. Images are numbered in the order they are attached:
${list.join("\n")}
Judge every candidate independently, with the same criteria, looking only at its own images.
${spokenContext(scene, title, hook, beat)}

Return JSON {"verdicts": [...]} with exactly one entry per candidate (${candidates.length} entries, candidate = 1..${candidates.length},
none missing, none repeated). Each entry has candidate (its number) plus:
${verdictRules(beat)}`;
}

export const BatchVerdictsSchema = z.object({
  verdicts: z.array(RelevanceVerdictSchema.extend({ candidate: z.number().int().min(1).describe("candidate number, 1-based") })),
});

export const AlternativeQueriesSchema = z.object({
  scenes: z.array(
    z.object({
      sceneIndex: z.number().int().nonnegative(),
      queries: z.array(z.string()).min(1).max(3),
    }),
  ),
});

export interface FailedScene {
  sceneIndex: number;
  narration: string;
  footageQuery: string;
}

export function buildAlternativeQueriesPrompt(scenes: readonly FailedScene[], specific = false): string {
  const list = scenes
    .map((s) => `- sceneIndex ${s.sceneIndex}: narration (pt-BR) "${s.narration}" | failed query "${s.footageQuery}"`)
    .join("\n");
  return `Stock footage searches on NASA, Wikimedia Commons, Pexels and Pixabay found no fitting clip for these scenes
of a Brazilian Portuguese YouTube Short:
${list}

For each scene propose 2 alternative English search queries (${specific ? "2-6" : "2-4"} words each) that those libraries are likely to have
and that would visually fit the narration. Name concrete visible things (e.g. "venus planet nasa", "volcano lava flow",
"ancient pyramids aerial", "storm clouds timelapse"), not abstract concepts. ${specific ? SPECIFIC_ALT_RULE : GENERIC_ALT_RULE}
Make them different from the failed query, and make the second one simpler and more generic${specific ? " (still from the same era and place)" : ""}.`;
}

const GENERIC_ALT_RULE = "Never use people's names, brands or titles of copyrighted works.";
const SPECIFIC_ALT_RULE = `Keep the scene's era and place. Named historical places, events with famous paintings
("storming of the Bastille painting"), space missions ("Voyager 2 Uranus"), museum artworks and long-dead historical
figures are welcome; never living people, brands or titles of modern copyrighted works.`;

/** Deterministic fallback when the LLM cannot propose alternatives: progressively shorter queries. */
export function deriveSimplerQueries(query: string): string[] {
  const words = query.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  if (words.length > 2) out.push(words.slice(0, 2).join(" "));
  if (words.length > 1) out.push(words.slice(-2).join(" "));
  return [...new Set(out)].filter((q) => q.toLowerCase() !== query.toLowerCase().trim());
}

export function normalizeAlternatives(
  failed: readonly FailedScene[],
  proposed: z.infer<typeof AlternativeQueriesSchema> | undefined,
): Map<number, string[]> {
  const result = new Map<number, string[]>();
  for (const scene of failed) {
    const fromLlm = proposed?.scenes.find((s) => s.sceneIndex === scene.sceneIndex)?.queries ?? [];
    const cleaned = fromLlm
      .map((q) => q.trim().replace(/\s+/g, " "))
      .filter((q) => q.length > 0 && q.toLowerCase() !== scene.footageQuery.toLowerCase());
    const queries = cleaned.length > 0 ? cleaned : deriveSimplerQueries(scene.footageQuery);
    if (queries.length > 0) result.set(scene.sceneIndex, [...new Set(queries)].slice(0, 2));
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// LLM calls
// ---------------------------------------------------------------------------------------------

// Low temperature: a reviewer should give the same clip the same score on every run.
const REVIEW_TEMPERATURE = 0.2;

const errorLine = (error: unknown): string => (error instanceof Error ? error.message.split("\n")[0]! : String(error));

const framesOf = (images: readonly LlmImage[]): Buffer[] => images.map((i) => i.data);

async function clipImages(clip: FootageClip, framesDir: string): Promise<LlmImage[]> {
  const duration = clip.kind === "image" ? 0 : clip.durationSeconds;
  const frames = await extractFrames(clip.path, duration, framesDir, basename(clip.path, extname(clip.path)));
  return frames.map((data) => ({ mimeType: "image/jpeg" as const, data }));
}

/** Samples frames from a (normalized) clip and asks the vision model for a verdict. Never throws. */
export async function scoreClip(
  clip: FootageClip,
  scene: ScriptScene,
  framesDir: string,
  title?: string,
  thinking: ThinkingSetting = "low",
  hook?: string,
  provider?: LlmProvider,
  beat?: SceneBeat,
  model?: string,
): Promise<ScoredClip> {
  let sent: Pick<ScoredClip, "frames" | "prompt"> = {};
  try {
    const images = await clipImages(clip, framesDir);
    const prompt = buildRelevancePrompt(scene, images.length, title, clip.kind, hook, beat);
    sent = { frames: framesOf(images), prompt };
    const verdict = await generateJsonWithImages(prompt, images, RelevanceVerdictSchema, {
      thinking,
      temperature: REVIEW_TEMPERATURE,
      model,
      ...(provider ? { provider } : {}),
    });
    return { clip, verdict, ...sent };
  } catch (error) {
    return { clip, error: errorLine(error), ...sent };
  }
}

/**
 * Reviews several clips that share the same scene/beat context in ONE vision call (see
 * `buildRelevanceBatchPrompt`). One clip -> `scoreClip` (unchanged single-clip prompt). A clip whose
 * frames cannot be extracted, or whose verdict is missing/duplicated in the answer, gets `error`
 * without affecting the others; an LLM failure marks the whole batch. Never throws. Callers keep
 * batches within `MAX_IMAGES_PER_CALL` (see `planBatches`).
 */
export async function scoreClipBatch(
  clips: readonly FootageClip[],
  scene: ScriptScene,
  framesDir: string,
  title?: string,
  thinking: ThinkingSetting = "low",
  hook?: string,
  provider?: LlmProvider,
  beat?: SceneBeat,
  model?: string,
): Promise<ScoredClip[]> {
  if (clips.length === 1) return [await scoreClip(clips[0]!, scene, framesDir, title, thinking, hook, provider, beat, model)];
  const extracted = await Promise.all(
    clips.map(async (clip) => {
      try {
        return { clip, images: await clipImages(clip, framesDir) };
      } catch (error) {
        return { clip, error: errorLine(error) };
      }
    }),
  );
  const ready = extracted.filter((e): e is { clip: FootageClip; images: LlmImage[] } => "images" in e);
  const verdicts = new Map<FootageClip, ScoredClip>();
  const prompt = buildRelevanceBatchPrompt(
    scene,
    ready.map((e) => ({ kind: e.clip.kind, frameCount: e.images.length })),
    title,
    hook,
    beat,
  );
  if (ready.length > 0) {
    try {
      const images = ready.flatMap((e) => e.images);
      const answer = await generateJsonWithImages(prompt, images, BatchVerdictsSchema, {
        thinking,
        temperature: REVIEW_TEMPERATURE,
        model,
        ...(provider ? { provider } : {}),
      });
      for (const [i, { clip }] of ready.entries()) verdicts.set(clip, pickVerdict(clip, answer.verdicts, i + 1));
    } catch (error) {
      const message = errorLine(error);
      for (const { clip } of ready) verdicts.set(clip, { clip, error: message });
    }
  }
  return extracted.map((e) =>
    e.images ? { ...verdicts.get(e.clip)!, frames: framesOf(e.images), prompt } : { clip: e.clip, error: e.error },
  );
}

function pickVerdict(clip: FootageClip, verdicts: z.infer<typeof BatchVerdictsSchema>["verdicts"], candidate: number): ScoredClip {
  const own = verdicts.filter((v) => v.candidate === candidate);
  if (own.length !== 1) return { clip, error: `batch answer had ${own.length} verdicts for candidate ${candidate} (expected 1)` };
  const { candidate: _n, ...verdict } = own[0]!;
  return { clip, verdict };
}

/** Frames `scoreClip` samples: stills give one, videos one per DEFAULT_FRAME_FRACTIONS entry. */
export function expectedFrameCount(clip: Pick<FootageClip, "kind" | "durationSeconds">): number {
  return clip.kind === "image" || !(clip.durationSeconds > 0) ? 1 : DEFAULT_FRAME_FRACTIONS.length;
}

/**
 * Groups clip indexes into review batches: only clips with the same `contextKey` share a batch, at most
 * `batchSize` per batch and at most `MAX_IMAGES_PER_CALL` frames per call. Input order is kept.
 */
export function planBatches(
  clips: readonly FootageClip[],
  contextKey: (clip: FootageClip, index: number) => string,
  batchSize: number,
  maxImages = MAX_IMAGES_PER_CALL,
): number[][] {
  const byContext = new Map<string, number[]>();
  clips.forEach((clip, i) => {
    const key = contextKey(clip, i);
    byContext.set(key, [...(byContext.get(key) ?? []), i]);
  });
  const batches: number[][] = [];
  for (const indexes of byContext.values()) {
    let current: number[] = [];
    let frames = 0;
    for (const i of indexes) {
      const need = expectedFrameCount(clips[i]!);
      if (current.length > 0 && (current.length >= batchSize || frames + need > maxImages)) {
        batches.push(current);
        current = [];
        frames = 0;
      }
      current.push(i);
      frames += need;
    }
    if (current.length > 0) batches.push(current);
  }
  return batches;
}

export async function proposeAlternativeQueries(
  failed: readonly FailedScene[],
  specific = false,
): Promise<z.infer<typeof AlternativeQueriesSchema>> {
  return generateJson(buildAlternativeQueriesPrompt(failed, specific), AlternativeQueriesSchema);
}
