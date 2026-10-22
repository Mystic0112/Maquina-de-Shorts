// Pure mapping RunContext + RenderStyle -> Remotion inputProps (+ list of files to stage).
// Node-side only (uses node:path); the browser bundle imports ./shared.ts instead.

import path from "node:path";
import { beatStartsMs } from "../orchestrator/lib/beats.js";
import type { CaptionCue, EditPlan, FootageClip, RunContext, SceneTiming, Script, WordTiming } from "../orchestrator/types.js";
import type { VisualSettings } from "../shared/settings.js";
import {
  DEFAULT_RENDER_STYLE,
  type CaptionChunkProps,
  type EditCueProps,
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

export type RenderPlan = { props: ShortProps; assets: StagedAsset[]; skippedLottieCues: number };

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

type SceneClips = { clips: FootageClip[]; reused: boolean };

/** Nearest scene first; on a tie the earlier one. */
const byDistanceTo =
  (sceneIndex: number) =>
  (a: FootageClip, b: FootageClip): number =>
    Math.abs(a.sceneIndex - sceneIndex) - Math.abs(b.sceneIndex - sceneIndex) || a.sceneIndex - b.sceneIndex;

/**
 * The scene's own clips not shown yet; otherwise one clip no scene has shown (leftovers of earlier scenes
 * first, so later scenes keep theirs, then the nearest later scene's); only when every clip is spent, the
 * nearest scene's clips come back (`reused`, for the log).
 */
function clipsForScene(sceneIndex: number, footage: FootageClip[], used: ReadonlySet<string>): SceneClips {
  const own = footage
    .filter((c) => c.sceneIndex === sceneIndex && !used.has(c.path))
    .filter((c, i, all) => all.findIndex((d) => d.path === c.path) === i); // same picture picked twice (two beats): first entry wins
  if (own.length > 0) return { clips: own, reused: false };
  const nearest = byDistanceTo(sceneIndex);
  const unused = footage
    .filter((c) => !used.has(c.path))
    .sort((a, b) => Number(a.sceneIndex > sceneIndex) - Number(b.sceneIndex > sceneIndex) || nearest(a, b));
  if (unused.length > 0) return { clips: [unused[0]!], reused: false };
  const donor = [...footage].sort(nearest)[0];
  return { clips: donor ? footage.filter((c) => c.sceneIndex === donor.sceneIndex) : [], reused: true };
}

/**
 * The beat's own clips; else a scene clip without beat (retry) not shown yet; else the previous beat's
 * (its shot simply extends, never a cut back to it); else the next beat's, shown early.
 */
function clipsForBeat(sceneClips: FootageClip[], beatIndex: number, previousParts: ScenePart[]): FootageClip[] {
  const shown = new Set(previousParts.flatMap((p) => p.clips.map((c) => c.path)));
  const own = sceneClips.filter((c) => c.beatIndex === beatIndex && !shown.has(c.path));
  if (own.length > 0) return own;
  const loose = sceneClips.find((c) => c.beatIndex === undefined && !shown.has(c.path));
  if (loose) return [loose];
  const previous = previousParts[previousParts.length - 1];
  if (previous) return previous.clips;
  const next = Math.min(...sceneClips.map((c) => c.beatIndex ?? Number.POSITIVE_INFINITY).filter((b) => b > beatIndex));
  return Number.isFinite(next) ? sceneClips.filter((c) => c.beatIndex === next) : sceneClips;
}

type ScenePart = { frames: number; clips: FootageClip[]; reused: boolean };

/**
 * Splits the scene's visual frames at the instants its beats start being spoken. Parts shorter than a minimum
 * shot merge into their neighbour, and neighbours showing the same clips merge (so a scene without beats, or
 * whose beats share one clip, is a single part exactly as before beats existed).
 */
export function beatParts(
  scene: SceneTiming,
  frames: { startFrame: number; leadInFrames: number; sceneFrames: number; minShot: number },
  input: Pick<SceneBuildInput, "footage" | "script" | "words" | "fps">,
  used: ReadonlySet<string> = new Set(),
): ScenePart[] {
  const { clips: sceneClips, reused } = clipsForScene(scene.sceneIndex, input.footage, used);
  const beats = input.script?.scenes[scene.sceneIndex]?.beats ?? [];
  if (beats.length < 2) return [{ frames: frames.sceneFrames, clips: sceneClips, reused }];
  const bounds = beatStartsMs(input.words, scene, beats).map((ms, k) =>
    k === 0 ? 0 : Math.min(frames.sceneFrames, Math.max(0, frames.leadInFrames + msToFrame(ms, input.fps) - frames.startFrame)),
  );
  const parts: ScenePart[] = [];
  beats.forEach((_, k) => parts.push({ frames: (bounds[k + 1] ?? frames.sceneFrames) - bounds[k]!, clips: clipsForBeat(sceneClips, k, parts), reused }));
  const merged: ScenePart[] = [];
  for (const part of parts) {
    const previous = merged[merged.length - 1];
    const sameClips = previous && previous.clips.map((c) => c.path).join("\n") === part.clips.map((c) => c.path).join("\n");
    if (previous && (sameClips || part.frames < frames.minShot)) previous.frames += part.frames;
    else if (previous && previous.frames < frames.minShot) merged[merged.length - 1] = { ...part, frames: previous.frames + part.frames };
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
  const srcOf = (clip: FootageClip): string => assets.get(clip.path)!.publicPath;
  const sorted = [...scenes].sort((a, b) => a.startMs - b.startMs);
  const used = new Set<string>(); // clip paths already on screen: a picture never comes back after another one
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
    const parts = beatParts(scene, { startFrame, leadInFrames, sceneFrames, minShot: minShotFrames(visual, fps) }, input, used);
    let offset = 0;
    const segments = parts.flatMap((part, k) => {
      const planned = planSceneShots({
        sceneFrames: part.frames,
        clips: part.clips,
        srcOf,
        fps,
        visual,
        sceneOrdinal: i + k, // later beats of the opening scene are never ordinal 0 (no second punch-in)
      });
      for (const clip of part.clips) if (planned.some((s) => s.src === srcOf(clip))) used.add(clip.path);
      const from = offset;
      offset += part.frames;
      return planned.map((s) => ({ ...s, fromFrame: s.fromFrame + from, ...(part.reused ? { reused: true } : {}) }));
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

// ---------------------------------------------------------------------------------------------
// Edit cues (stickers / SFX from 05b-planEdits)
// ---------------------------------------------------------------------------------------------

/** Set to true once @remotion/lottie is installed and EditLayer renders `lottie` cues; until then they are skipped. */
export const LOTTIE_SUPPORTED = false;

/** One staged file per asset used by the plan, keyed by asset id (`edits/<id>.<ext>`). */
export function planEditAssets(edits: EditPlan | undefined, publicPrefix?: string): Map<string, StagedAsset> {
  const assets = new Map<string, StagedAsset>();
  for (const asset of edits?.assets ?? []) {
    assets.set(asset.id, { sourcePath: asset.path, publicPath: withPrefix(publicPrefix, `edits/${asset.id}${path.extname(asset.path).toLowerCase()}`) });
  }
  return assets;
}

/** Cues as absolute frames, clipped to the composition; cues whose asset is missing or unsupported are dropped. */
export function buildEditCues(edits: EditPlan | undefined, assets: Map<string, StagedAsset>, fps: number, totalFrames: number): { cues: EditCueProps[]; skippedLottie: number } {
  const cues: EditCueProps[] = [];
  let skippedLottie = 0;
  for (const cue of edits?.cues ?? []) {
    const staged = assets.get(cue.assetId);
    if (!staged) continue;
    if (cue.kind === "lottie" && !LOTTIE_SUPPORTED) {
      skippedLottie += 1;
      continue;
    }
    const fromFrame = msToFrame(cue.atMs, fps);
    const durationInFrames = Math.min(totalFrames - fromFrame, Math.max(1, msToFrame(cue.atMs + cue.durationMs, fps) - fromFrame));
    if (fromFrame < 0 || durationInFrames < 1) continue;
    const kind = cue.kind === "lottie" ? "sticker" : cue.kind;
    cues.push({ id: cue.assetId, kind, src: staged.publicPath, fromFrame, durationInFrames, placement: cue.placement, intensity: cue.intensity, volume: edits?.sfxVolume ?? 0 });
  }
  return { cues, skippedLottie };
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
  const editAssets = planEditAssets(ctx.edits, options.publicPrefix);
  const edits = buildEditCues(ctx.edits, editAssets, fps, totalFrames);
  const usedEditAssets = [...editAssets.entries()].filter(([id]) => edits.cues.some((c) => c.id === id)).map(([, a]) => a);

  const props: ShortProps = {
    ...video,
    durationInFrames: totalFrames,
    audioSrc: audioAsset.publicPath,
    style,
    scenes: buildScenes(sceneTimings, { footage, assets, fps, totalFrames, visual: style.visual, script: ctx.script, words: ctx.narration.words }),
    captions,
    overlay: buildOverlayHook(ctx.script?.overlayText, style.visual, fps, totalFrames),
    edits: edits.cues,
  };
  return { props, assets: [audioAsset, ...assets.values(), ...usedEditAssets], skippedLottieCues: edits.skippedLottie };
}

/** Convenience wrapper when only the props are needed (e.g. tests). */
export function buildInputProps(ctx: RunContext, video: VideoConfig, style: RenderStyle = DEFAULT_RENDER_STYLE): ShortProps {
  return buildRenderPlan(ctx, video, style).props;
}
