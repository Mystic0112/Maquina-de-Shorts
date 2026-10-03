import { basename, extname } from "node:path";
import { z } from "zod";
import type { FootageClip, QualitySummary, ScriptScene } from "../types.js";
import type { PipelineConfig } from "./config.js";
import { extractFrames } from "./ffmpeg.js";
import { generateJson, generateJsonWithImages, type ThinkingSetting } from "./llmClient.js";

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
}

export function resolveRelevanceSettings(footage: PipelineConfig["footage"]): RelevanceSettings {
  const r = footage?.relevance;
  return {
    enabled: r?.enabled ?? true,
    minScore: r?.minScore ?? 6,
    fallbackMinScore: r?.fallbackMinScore ?? 4,
    keepPerScene: r?.keepPerScene ?? 2,
    concurrency: r?.concurrency ?? 4,
    thinking: r?.thinking ?? "minimal",
  };
}

export const RelevanceVerdictSchema = z.object({
  score: z.number().min(0).max(10).describe("0-10: how well the footage illustrates the narration"),
  matches: z.boolean().describe("true if a typical viewer would find the footage fits the narration"),
  reason: z.string().describe("one short English sentence: what the frames show and why this score"),
  hasTextOrLogo: z.boolean().describe("burned-in text, subtitles, watermark, channel/agency logo or title card"),
  hasIdentifiablePeople: z.boolean().describe("any clearly recognizable human face"),
});

export type RelevanceVerdict = z.infer<typeof RelevanceVerdictSchema>;

export interface ScoredClip {
  clip: FootageClip;
  verdict?: RelevanceVerdict;
  /** Set when scoring failed (frame extraction or LLM error). */
  error?: string;
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
  if (v.hasTextOrLogo || v.hasIdentifiablePeople) return "reject";
  return v.matches && v.score >= minScore ? "pass" : "weak";
}

function rankValue(scored: ScoredClip): number {
  return scored.verdict?.score ?? -1;
}

export type SelectionMode = "pass" | "weak" | "none";

export interface SceneSelection {
  sceneIndex: number;
  mode: SelectionMode;
  kept: ScoredClip[];
  discarded: ScoredClip[];
}

/**
 * Best `keepPerScene` passing clips; without any, optionally the single best clean weak clip scoring at
 * least `fallbackMinScore`. Ties keep adapter order (stable sort).
 */
export function selectSceneClips(
  sceneIndex: number,
  candidates: readonly ScoredClip[],
  settings: Pick<RelevanceSettings, "minScore" | "keepPerScene" | "fallbackMinScore">,
  allowWeak: boolean,
): SceneSelection {
  const ranked = [...candidates].sort((a, b) => rankValue(b) - rankValue(a));
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
  return { ...scored.clip, relevanceScore: scored.verdict.score, relevanceReason: scored.verdict.reason };
}

export function describeScored(scored: ScoredClip, minScore: number): string {
  const name = basename(scored.clip.path, extname(scored.clip.path));
  const v = scored.verdict;
  if (!v) return `${name}=unscored`;
  const flags = [v.hasTextOrLogo ? "text/logo" : "", v.hasIdentifiablePeople ? "people" : ""].filter(Boolean);
  return `${name}=${v.score}${flags.length ? `[${flags.join(",")}]` : ""}(${classifyClip(scored, minScore)})`;
}

// ---------------------------------------------------------------------------------------------
// Run-level quality gate
// ---------------------------------------------------------------------------------------------

/** A scene passes when one of its own (not borrowed) clips scores >= minScore. */
export function countPassingScenes(footage: readonly FootageClip[], sceneCount: number, minScore: number): number {
  const passing = new Set<number>();
  for (const clip of footage) {
    if (clip.borrowedFromScene !== undefined || clip.sceneIndex >= sceneCount) continue;
    if ((clip.relevanceScore ?? -1) >= minScore) passing.add(clip.sceneIndex);
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

export function buildRelevancePrompt(
  scene: ScriptScene,
  frameCount: number,
  title?: string,
  kind: FootageClip["kind"] = "video",
): string {
  const subject =
    kind === "image"
      ? "The image is ONE still picture, already cropped to vertical 9:16, that would be shown (with a slow zoom)"
      : `The ${frameCount} image(s) are frames sampled from ONE stock clip, already cropped to vertical 9:16, that would play`;
  return `You are the automated footage reviewer for a faceless YouTube Shorts channel that narrates curiosities
about history, science and space in Brazilian Portuguese. No human reviews the videos before publishing, so be strict.

${subject}
while the narrator speaks the line below.
${title ? `Video title: "${title}"\n` : ""}Narration for this scene (pt-BR): "${scene.narration}"
Search query that found the clip: "${scene.footageQuery}"

Return JSON with:
- score (0-10): how well the footage visually illustrates THIS narration for a viewer.
  9-10 = directly shows the subject being narrated; 7-8 = clearly related and fitting (e.g. generic space imagery
  for an astronomy line); 4-6 = only a loose mood match; 0-3 = unrelated or misleading (e.g. an office building or
  a zoo animal for a line about planets, or a different celestial body than the one named).
- matches: true only if a typical viewer would feel the footage fits what is being said.
- hasTextOrLogo: true if any frame shows burned-in text, subtitles, captions, a watermark, a TV channel bug or logo
  (e.g. ZDF, BBC), an agency insignia (including the NASA logo), or a title card. Tiny incidental text on real-world
  objects far in the background does not count.
- hasIdentifiablePeople: true if any person's face is clearly recognizable. Distant crowds, silhouettes, people seen
  from behind and astronauts with visors down do not count.
- reason: one short English sentence describing what the frames show and why you gave that score.`;
}

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

export function buildAlternativeQueriesPrompt(scenes: readonly FailedScene[]): string {
  const list = scenes
    .map((s) => `- sceneIndex ${s.sceneIndex}: narration (pt-BR) "${s.narration}" | failed query "${s.footageQuery}"`)
    .join("\n");
  return `Stock footage searches on NASA, Wikimedia Commons, Pexels and Pixabay found no fitting clip for these scenes
of a Brazilian Portuguese YouTube Short:
${list}

For each scene propose 2 alternative English search queries (2-4 words each) that those libraries are likely to have
and that would visually fit the narration. Name concrete visible things (e.g. "venus planet nasa", "volcano lava flow",
"ancient pyramids aerial", "storm clouds timelapse"), not abstract concepts. Never use people's names, brands or titles
of copyrighted works. Make them different from the failed query, and make the second one simpler and more generic.`;
}

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

/** Samples frames from a (normalized) clip and asks the vision model for a verdict. Never throws. */
export async function scoreClip(
  clip: FootageClip,
  scene: ScriptScene,
  framesDir: string,
  title?: string,
  thinking: ThinkingSetting = "minimal",
): Promise<ScoredClip> {
  try {
    const duration = clip.kind === "image" ? 0 : clip.durationSeconds;
    const frames = await extractFrames(clip.path, duration, framesDir, basename(clip.path, extname(clip.path)));
    const images = frames.map((data) => ({ mimeType: "image/jpeg" as const, data }));
    const prompt = buildRelevancePrompt(scene, images.length, title, clip.kind);
    // Low temperature: a reviewer should give the same clip the same score on every run.
    const verdict = await generateJsonWithImages(prompt, images, RelevanceVerdictSchema, { thinking, temperature: 0.2 });
    return { clip, verdict };
  } catch (error) {
    return { clip, error: error instanceof Error ? error.message.split("\n")[0] : String(error) };
  }
}

export async function proposeAlternativeQueries(failed: readonly FailedScene[]): Promise<z.infer<typeof AlternativeQueriesSchema>> {
  return generateJson(buildAlternativeQueriesPrompt(failed), AlternativeQueriesSchema);
}
