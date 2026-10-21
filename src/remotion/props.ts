// Pure mapping RunContext + RenderStyle -> Remotion inputProps (+ list of files to stage).
// Node-side only (uses node:path); the browser bundle imports ./shared.ts instead.

import path from "node:path";
import { beatStartsMs } from "../orchestrator/lib/beats.js";
import type { CaptionCue, FootageClip, RunContext, SceneTiming, Script, WordTiming } from "../orchestrator/types.js";
import type { VisualSettings } from "../shared/settings.js";
import {
  DEFAULT_RENDER_STYLE,
  type CaptionChunkProps,
  type OverlayHookProps,
  type RenderStyle,
  type SceneProps,
  type ShortProps,
} from "./shared.js";
import { minShotFrames, planSceneShots } from "./shots.js";

export * from "./shared.js";
export { IMAGE_PAN_PCT, maxSafePanPct, maxShotFrames, OPENING_PUNCH_SECONDS, OPENING_PUNCH_ZOOM, SAFE_MAX_ZOOM } from "./shots.js";

/** Default crossfade / words-per-cue, kept as named exports for callers and tests. */
export const CROSSFADE_FRAMES = DEFAULT_RENDER_STYLE.visual.crossfadeFrames;
export const MAX_WORDS_PER_CAPTION = DEFAULT_RENDER_STYLE.captions.maxWordsPerCue;
/** Gaps between caption chunks up to this size are bridged so captions don't flicker off and on. */
const CAPTION_GAP_BRIDGE_FRAMES = 12;

type Visual = Required<VisualSettings>;

export type VideoConfig = { width: number; height: number; fps: number };

/** A file that must exist at `publicPath` inside the bundle's public dir before rendering. */
export type StagedAsset = { sourcePath: string; publicPath: string };

export type RenderPlan = { props: ShortProps; assets: StagedAsset[] };

export type RenderPlanOptions = {
  /** Namespace folder inside the public dir (lets concurrent renders share one cached bundle). */
  publicPrefix?: string;
};

const msToFrame = (ms: number, fps: number): number => Math.round((ms / 1000) * fps);

/** Narration plus a short tail; the last shot runs to the very end (no unrelated closing frame). */
export function totalFramesFor(durationMs: number, fps: number, tailSeconds: number = DEFAULT_RENDER_STYLE.visual.tailSeconds): number {
  return Math.ceil((durationMs / 1000 + tailSeconds) * fps);
}

function sanitizeBaseName(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const stem = path
    .basename(filePath, path.extname(filePath))
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .slice(0, 40);
  return `${stem || "clip"}${ext}`;
}

const withPrefix = (prefix: string | undefined, publicPath: string): string => (prefix ? `${prefix}/${publicPath}` : publicPath);

/** Deterministic, URL-safe public names so staticFile() never sees spaces or accents. */
export function planFootageAssets(footage: FootageClip[], publicPrefix?: string): Map<string, StagedAsset> {
  const assets = new Map<string, StagedAsset>();
  footage.forEach((clip, i) => {
    if (assets.has(clip.path)) return;
    const publicPath = withPrefix(publicPrefix, `footage/${String(i).padStart(2, "0")}_${sanitizeBaseName(clip.path)}`);
    assets.set(clip.path, { sourcePath: clip.path, publicPath });
  });
  return assets;
}

/** The scene's own clips; otherwise the nearest earlier scene's clips; otherwise any clip. */
function clipsForScene(sceneIndex: number, footage: FootageClip[]): FootageClip[] {
  const own = footage.filter((c) => c.sceneIndex === sceneIndex);
  if (own.length > 0) return own;
  const earlier = footage.filter((c) => c.sceneIndex < sceneIndex).map((c) => c.sceneIndex);
  if (earlier.length > 0) {
    const nearest = Math.max(...earlier);
    return footage.filter((c) => c.sceneIndex === nearest);
  }
  return footage.length > 0 ? [footage[sceneIndex % footage.length]!] : [];
}

/** The beat's own clips; else the nearest earlier beat's; else the scene's beat-less clips (retry/borrowed); else all. */
function clipsForBeat(sceneClips: FootageClip[], beatIndex: number): FootageClip[] {
  for (let b = beatIndex; b >= 0; b--) {
    const own = sceneClips.filter((c) => c.beatIndex === b);
    if (own.length > 0) return own;
  }
  const loose = sceneClips.filter((c) => c.beatIndex === undefined);
  return loose.length > 0 ? loose : sceneClips;
}

type ScenePart = { frames: number; clips: FootageClip[] };

/**
 * Splits the scene's visual frames at the instants its beats start being spoken. Parts shorter than a minimum
 * shot merge into their neighbour, and neighbours showing the same clips merge (so a scene without beats, or
 * whose beats share one clip, is a single part exactly as before beats existed).
 */
export function beatParts(
  scene: SceneTiming,
  frames: { startFrame: number; leadInFrames: number; sceneFrames: number; minShot: number },
  input: Pick<SceneBuildInput, "footage" | "script" | "words" | "fps">,
): ScenePart[] {
  const sceneClips = clipsForScene(scene.sceneIndex, input.footage);
  const beats = input.script?.scenes[scene.sceneIndex]?.beats ?? [];
  if (beats.length < 2) return [{ frames: frames.sceneFrames, clips: sceneClips }];
  const bounds = beatStartsMs(input.words, scene, beats).map((ms, k) =>
    k === 0 ? 0 : Math.min(frames.sceneFrames, Math.max(0, frames.leadInFrames + msToFrame(ms, input.fps) - frames.startFrame)),
  );
  const parts = beats.map((_, k) => ({ frames: (bounds[k + 1] ?? frames.sceneFrames) - bounds[k]!, clips: clipsForBeat(sceneClips, k) }));
  const merged: ScenePart[] = [];
  for (const part of parts) {
    const previous = merged[merged.length - 1];
    const sameClips = previous && previous.clips.map((c) => c.path).join("\n") === part.clips.map((c) => c.path).join("\n");
    if (previous && (sameClips || part.frames < frames.minShot)) previous.frames += part.frames;
    else if (previous && previous.frames < frames.minShot) merged[merged.length - 1] = { frames: previous.frames + part.frames, clips: part.clips };
    else merged.push({ ...part });
  }
  return merged.filter((p) => p.frames > 0);
}

type SceneBuildInput = {
  footage: FootageClip[];
  assets: Map<string, StagedAsset>;
  fps: number;
  totalFrames: number;
  visual: Visual;
  script?: Pick<Script, "scenes">;
  words: WordTiming[];
};

function buildScenes(scenes: SceneTiming[], input: SceneBuildInput): SceneProps[] {
  const { assets, fps, totalFrames, visual } = input;
  const sorted = [...scenes].sort((a, b) => a.startMs - b.startMs);
  let previousStart = 0;
  return sorted.map((scene, i) => {
    const startFrame = i === 0 ? 0 : Math.min(msToFrame(scene.startMs, fps), totalFrames - 1);
    const isLast = i === sorted.length - 1;
    const endFrame = isLast ? totalFrames : msToFrame(sorted[i + 1]!.startMs, fps);
    const durationInFrames = Math.max(1, endFrame - startFrame);
    // Lead-in never reaches back past the previous scene's start, so very short scenes still work.
    const leadInFrames = i === 0 ? 0 : Math.max(0, Math.min(visual.crossfadeFrames, startFrame - previousStart - 1));
    previousStart = startFrame;
    const sceneFrames = leadInFrames + durationInFrames;
    const parts = beatParts(scene, { startFrame, leadInFrames, sceneFrames, minShot: minShotFrames(visual, fps) }, input);
    let offset = 0;
    const segments = parts.flatMap((part, k) => {
      const planned = planSceneShots({
        sceneFrames: part.frames,
        clips: part.clips,
        srcOf: (clip) => assets.get(clip.path)!.publicPath,
        fps,
        visual,
        sceneOrdinal: i + k, // later beats of the opening scene are never ordinal 0 (no second punch-in)
      });
      const from = offset;
      offset += part.frames;
      return planned.map((s) => ({ ...s, fromFrame: s.fromFrame + from }));
    });
    return { sceneIndex: scene.sceneIndex, startFrame, durationInFrames, leadInFrames, segments };
  });
}

/** Splits into the fewest chunks of <= maxWords, sized evenly (4 -> 2+2, 7 -> 3+2+2) to avoid orphan words. */
function chunkWords(words: WordTiming[], maxWords: number): WordTiming[][] {
  const count = Math.ceil(words.length / maxWords);
  const chunks: WordTiming[][] = [];
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    const size = Math.ceil((words.length - cursor) / (count - i));
    chunks.push(words.slice(cursor, cursor + size));
    cursor += size;
  }
  return chunks;
}

function cueWords(cue: CaptionCue): WordTiming[] {
  if (cue.words.length > 0) return cue.words;
  return [{ word: cue.text, startMs: cue.startMs, endMs: cue.endMs, emphasis: true }];
}

function bridgeCaptionGaps(chunks: CaptionChunkProps[]): CaptionChunkProps[] {
  return chunks.map((chunk, i) => {
    const next = chunks[i + 1];
    const endFrame = Math.max(chunk.endFrame, chunk.startFrame + 1);
    if (!next) return { ...chunk, endFrame };
    const gap = next.startFrame - endFrame;
    const bridged = gap > 0 && gap <= CAPTION_GAP_BRIDGE_FRAMES ? next.startFrame : Math.min(endFrame, next.startFrame);
    return { ...chunk, endFrame: Math.max(bridged, chunk.startFrame + 1) };
  });
}

/** Re-chunks cues to at most `maxWords` words and converts timings to frames. */
export function buildCaptionChunks(cues: CaptionCue[], fps: number, maxWords = MAX_WORDS_PER_CAPTION): CaptionChunkProps[] {
  const chunks = [...cues]
    .sort((a, b) => a.startMs - b.startMs)
    .flatMap((cue) => chunkWords(cueWords(cue), Math.max(1, maxWords)))
    .map((words) => ({
      startFrame: msToFrame(words[0]!.startMs, fps),
      endFrame: msToFrame(words[words.length - 1]!.endMs, fps),
      words: words.map((w) => ({
        text: w.word,
        startFrame: msToFrame(w.startMs, fps),
        endFrame: msToFrame(w.endMs, fps),
        emphasis: w.emphasis !== false, // absent (older runs) = treat as a content word
      })),
    }));
  return bridgeCaptionGaps(chunks);
}

/** Seconds over which the hook text fades out, ending exactly at overlayHookSeconds. */
const OVERLAY_FADE_SECONDS = 0.3;

/** Hook/cover text (Script.overlayText) shown from frame 0, or null when off or absent. */
export function buildOverlayHook(overlayText: string | undefined, visual: Visual, fps: number, totalFrames: number): OverlayHookProps | null {
  const text = overlayText?.trim().replace(/\s+/g, " ").toLocaleUpperCase("pt-BR");
  if (!visual.overlayHook || !text) return null;
  const endFrame = Math.max(1, Math.min(totalFrames, Math.round(visual.overlayHookSeconds * fps)));
  return { text, endFrame, fadeFrames: Math.min(Math.round(OVERLAY_FADE_SECONDS * fps), Math.floor(endFrame / 2)) };
}

/** Pure: derives inputProps plus the list of files to stage into the bundle's public dir. */
export function buildRenderPlan(
  ctx: RunContext,
  video: VideoConfig,
  style: RenderStyle = DEFAULT_RENDER_STYLE,
  options: RenderPlanOptions = {},
): RenderPlan {
  if (!ctx.narration) throw new Error("renderVideo: ctx.narration is missing");
  const { fps } = video;
  const footage = ctx.footage ?? [];
  const assets = planFootageAssets(footage, options.publicPrefix);
  const audioExt = path.extname(ctx.narration.audioPath).toLowerCase() || ".mp3";
  const audioAsset: StagedAsset = { sourcePath: ctx.narration.audioPath, publicPath: withPrefix(options.publicPrefix, `audio/narration${audioExt}`) };
  const totalFrames = totalFramesFor(ctx.narration.durationMs, fps, style.visual.tailSeconds);
  const sceneTimings: SceneTiming[] = ctx.captions?.scenes.length
    ? ctx.captions.scenes
    : [{ sceneIndex: 0, startMs: 0, endMs: ctx.narration.durationMs }];
  const captions = style.captions.enabled ? buildCaptionChunks(ctx.captions?.cues ?? [], fps, style.captions.maxWordsPerCue) : [];

  const props: ShortProps = {
    ...video,
    durationInFrames: totalFrames,
    audioSrc: audioAsset.publicPath,
    style,
    scenes: buildScenes(sceneTimings, { footage, assets, fps, totalFrames, visual: style.visual, script: ctx.script, words: ctx.narration.words }),
    captions,
    overlay: buildOverlayHook(ctx.script?.overlayText, style.visual, fps, totalFrames),
  };
  return { props, assets: [audioAsset, ...assets.values()] };
}

/** Convenience wrapper when only the props are needed (e.g. tests). */
export function buildInputProps(ctx: RunContext, video: VideoConfig, style: RenderStyle = DEFAULT_RENDER_STYLE): ShortProps {
  return buildRenderPlan(ctx, video, style).props;
}
