// Pure mapping RunContext -> Remotion inputProps (+ list of files to stage into the public dir).
// Node-side only (uses node:path); the browser bundle imports ./shared.ts instead.

import path from "node:path";
import type { CaptionCue, FootageClip, RunContext, SceneTiming, WordTiming } from "../orchestrator/types.js";
import { CROSSFADE_FRAMES, type CaptionChunkProps, type ClipSegment, type SceneProps, type ShortProps } from "./shared.js";

export * from "./shared.js";

export const TAIL_MS = 500;
export const MAX_WORDS_PER_CAPTION = 3;
/** Gaps between caption chunks up to this size are bridged so captions don't flicker off and on. */
const CAPTION_GAP_BRIDGE_FRAMES = 12;
/** Frames shaved off a clip's reported duration — container durations are often slightly optimistic. */
const CLIP_SAFETY_FRAMES = 2;

export type VideoConfig = { width: number; height: number; fps: number };

/** A file that must exist at `publicPath` inside the public dir before bundling. */
export type StagedAsset = { sourcePath: string; publicPath: string };

export type RenderPlan = { props: ShortProps; assets: StagedAsset[] };

const msToFrame = (ms: number, fps: number): number => Math.round((ms / 1000) * fps);

export function totalFramesFor(durationMs: number, fps: number): number {
  return Math.ceil(((durationMs + TAIL_MS) / 1000) * fps);
}

function sanitizeBaseName(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const stem = path
    .basename(filePath, path.extname(filePath))
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .slice(0, 40);
  return `${stem || "clip"}${ext}`;
}

/** Deterministic, URL-safe public names so staticFile() never sees spaces or accents. */
export function planFootageAssets(footage: FootageClip[]): Map<string, StagedAsset> {
  const assets = new Map<string, StagedAsset>();
  footage.forEach((clip, i) => {
    if (assets.has(clip.path)) return;
    const publicPath = `footage/${String(i).padStart(2, "0")}_${sanitizeBaseName(clip.path)}`;
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

function usableFrames(clip: FootageClip, fps: number): number {
  if (clip.kind === "image") return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.floor(clip.durationSeconds * fps) - CLIP_SAFETY_FRAMES);
}

type Slot = { clip: FootageClip; frames: number };

/** Video-only scene: chain the clips in order and loop the chain until the scene is filled. */
function loopVideoSlots(sceneFrames: number, clips: FootageClip[], fps: number): Slot[] {
  const slots: Slot[] = [];
  let cursor = 0;
  for (let i = 0; clips.length > 0 && cursor < sceneFrames; i++) {
    const clip = clips[i % clips.length]!;
    const frames = Math.min(usableFrames(clip, fps), sceneFrames - cursor);
    slots.push({ clip, frames });
    cursor += frames;
  }
  return slots;
}

/**
 * Scene containing stills: every clip appears once, in order, sharing the time evenly. A video
 * shorter than its share is played once, and the leftover frames go to the images (never loop
 * a video when a still can hold the shot).
 */
function splitSlotsWithImages(sceneFrames: number, clips: FootageClip[], fps: number): Slot[] {
  const share = Math.floor(sceneFrames / clips.length);
  const videoFrames = new Map(clips.filter((c) => c.kind === "video").map((c) => [c, Math.min(usableFrames(c, fps), share)]));
  const images = clips.filter((c) => c.kind === "image");
  const imageBudget = sceneFrames - [...videoFrames.values()].reduce((sum, f) => sum + f, 0);
  let imagesLeft = images.length;
  let budgetLeft = imageBudget;
  return clips.map((clip) => {
    const fixed = videoFrames.get(clip);
    if (fixed !== undefined) return { clip, frames: fixed };
    const frames = Math.ceil(budgetLeft / imagesLeft);
    imagesLeft -= 1;
    budgetLeft -= frames;
    return { clip, frames };
  });
}

const VIDEO_ZOOM_TO = 1.08;
const IMAGE_ZOOM_TO = 1.12;
/** Horizontal pan at the end of a still, in % of frame width. Must stay <= (z-1)/(2z) = 5.36% at z=1.12. */
export const IMAGE_PAN_PCT = 4;

/** Videos get a gentle push-in; stills get a Ken Burns push-in plus a pan whose direction alternates. */
export function motionFor(kind: FootageClip["kind"], alternationIndex: number): ClipSegment["motion"] {
  if (kind === "video") return { scaleFrom: 1, scaleTo: VIDEO_ZOOM_TO, panXFromPct: 0, panXToPct: 0 };
  const direction = alternationIndex % 2 === 0 ? 1 : -1;
  return { scaleFrom: 1, scaleTo: IMAGE_ZOOM_TO, panXFromPct: 0, panXToPct: direction * IMAGE_PAN_PCT };
}

/**
 * Lays the scene's clips out over `sceneFrames`. `sceneOrdinal` alternates the pan direction of
 * stills from scene to scene (and between stills within a scene).
 */
export function buildSegments(
  sceneFrames: number,
  clips: FootageClip[],
  assets: Map<string, StagedAsset>,
  fps: number,
  sceneOrdinal = 0,
): ClipSegment[] {
  const hasImage = clips.some((c) => c.kind === "image");
  const slots = hasImage ? splitSlotsWithImages(sceneFrames, clips, fps) : loopVideoSlots(sceneFrames, clips, fps);
  let cursor = 0;
  return slots
    .filter((slot) => slot.frames > 0)
    .map((slot, i) => {
      const segment: ClipSegment = {
        src: assets.get(slot.clip.path)!.publicPath,
        kind: slot.clip.kind,
        fromFrame: cursor,
        durationInFrames: slot.frames,
        motion: motionFor(slot.clip.kind, sceneOrdinal + i),
      };
      cursor += slot.frames;
      return segment;
    });
}

function buildScenes(
  scenes: SceneTiming[],
  footage: FootageClip[],
  assets: Map<string, StagedAsset>,
  fps: number,
  totalFrames: number,
): SceneProps[] {
  const sorted = [...scenes].sort((a, b) => a.startMs - b.startMs);
  let previousStart = 0;
  return sorted.map((scene, i) => {
    const startFrame = i === 0 ? 0 : Math.min(msToFrame(scene.startMs, fps), totalFrames - 1);
    const isLast = i === sorted.length - 1;
    const endFrame = isLast ? totalFrames : msToFrame(sorted[i + 1]!.startMs, fps);
    const durationInFrames = Math.max(1, endFrame - startFrame);
    // Lead-in never reaches back past the previous scene's start, so very short scenes still work.
    const leadInFrames = i === 0 ? 0 : Math.max(0, Math.min(CROSSFADE_FRAMES, startFrame - previousStart - 1));
    previousStart = startFrame;
    const clips = clipsForScene(scene.sceneIndex, footage);
    const segments = buildSegments(leadInFrames + durationInFrames, clips, assets, fps, i);
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
  return [{ word: cue.text, startMs: cue.startMs, endMs: cue.endMs }];
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
    .flatMap((cue) => chunkWords(cueWords(cue), maxWords))
    .map((words) => ({
      startFrame: msToFrame(words[0]!.startMs, fps),
      endFrame: msToFrame(words[words.length - 1]!.endMs, fps),
      words: words.map((w) => ({ text: w.word, startFrame: msToFrame(w.startMs, fps), endFrame: msToFrame(w.endMs, fps) })),
    }));
  return bridgeCaptionGaps(chunks);
}

/** Pure: derives inputProps plus the list of files to stage into the bundle's public dir. */
export function buildRenderPlan(ctx: RunContext, video: VideoConfig): RenderPlan {
  if (!ctx.narration) throw new Error("renderVideo: ctx.narration is missing");
  const { fps } = video;
  const footage = ctx.footage ?? [];
  const footageAssets = planFootageAssets(footage);
  const audioExt = path.extname(ctx.narration.audioPath).toLowerCase() || ".mp3";
  const audioAsset: StagedAsset = { sourcePath: ctx.narration.audioPath, publicPath: `audio/narration${audioExt}` };
  const durationInFrames = totalFramesFor(ctx.narration.durationMs, fps);
  const sceneTimings: SceneTiming[] = ctx.captions?.scenes.length
    ? ctx.captions.scenes
    : [{ sceneIndex: 0, startMs: 0, endMs: ctx.narration.durationMs }];

  const props: ShortProps = {
    ...video,
    durationInFrames,
    audioSrc: audioAsset.publicPath,
    crossfadeFrames: CROSSFADE_FRAMES,
    scenes: buildScenes(sceneTimings, footage, footageAssets, fps, durationInFrames),
    captions: buildCaptionChunks(ctx.captions?.cues ?? [], fps),
  };
  return { props, assets: [audioAsset, ...footageAssets.values()] };
}

/** Convenience wrapper when only the props are needed (e.g. tests). */
export function buildInputProps(ctx: RunContext, video: VideoConfig): ShortProps {
  return buildRenderPlan(ctx, video).props;
}
