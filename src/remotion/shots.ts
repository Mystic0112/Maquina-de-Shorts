// Pure shot planning for one scene: which media, for how long, from which point of a video and with
// which camera move. Every clip of the scene shows exactly once, splitting the scene evenly: a lone
// still holds the whole scene however long it is (cutting back to the same picture reads as a repeat).
// Only videos are cut: a long one jumps ahead every visual.maxShotSeconds, and a video-only scene that
// outlasts all its clips restarts the longest one. Node-free (only types), so it could run in the
// browser bundle too.

import type { FootageClip } from "../orchestrator/types.js";
import type { VisualSettings } from "../shared/settings.js";
import type { ClipSegment, MotionEasing, SegmentMotion } from "./shared.js";

type Visual = Required<VisualSettings>;

/** Preferred pan of a face still at the end of its move, in % of frame width (clamped to the zoom's slack). */
export const IMAGE_PAN_PCT = 4;
/** Fraction of the zoom's edge slack a pan may use, leaving margin for rounding/subpixel sampling. */
const PAN_SLACK_USAGE = 0.75;
/** Never magnify footage (normalized to the frame size) beyond this. */
export const SAFE_MAX_ZOOM = 1.25;
export const OPENING_PUNCH_ZOOM = 1.2;
/** An opening video is cut at most this long, so its punch-in is fast and the first cut lands early. */
export const OPENING_PUNCH_SECONDS = 3;
/** Shorter shots read as flashes; tiny videos are skipped when the scene has other footage. */
const MIN_SHOT_SECONDS = 1.5;
/** Frames shaved off a clip's reported duration — container durations are often slightly optimistic. */
const CLIP_SAFETY_FRAMES = 2;

export type ScenePlanInput = {
  /** Visual length of the scene, lead-in included. */
  sceneFrames: number;
  clips: FootageClip[];
  srcOf: (clip: FootageClip) => string;
  fps: number;
  visual: Visual;
  /** Position of the scene in the video; 0 = opening scene. Also alternates pan directions. */
  sceneOrdinal: number;
};

type Slot = { clip: FootageClip; frames: number };
type Shot = { clip: FootageClip; frames: number; trimBeforeFrames: number; motion: SegmentMotion };

/**
 * Largest pan (in pre-scale % of the frame) that never reveals an edge at zoom `zoom`: (z-1)/(2z).
 * The slack is concave in z, so a pan within it at both ends of a move stays within it throughout.
 */
export function maxSafePanPct(zoom: number): number {
  return zoom <= 1 ? 0 : ((zoom - 1) / (2 * zoom)) * 100;
}

const panPct = (zoom: number, share: number): number => share * maxSafePanPct(zoom) * PAN_SLACK_USAGE;

export const maxShotFrames = (visual: Visual, fps: number): number => Math.max(1, Math.round(visual.maxShotSeconds * fps));

export const minShotFrames = (visual: Visual, fps: number): number => Math.min(Math.round(MIN_SHOT_SECONDS * fps), maxShotFrames(visual, fps));

/** Owner's rule: a camera move only when a face is the subject; objects and places stay completely still. */
const mayZoom = (clip: FootageClip, visual: Visual): boolean => !visual.zoomOnlyOnFaces || clip.hasFace === true;

/** Frames of a video that can be shown, keeping room for the next shot's dissolve over its end. */
function playableFrames(clip: FootageClip, fps: number, visual: Visual): number {
  if (clip.kind === "image") return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.floor(clip.durationSeconds * fps) - CLIP_SAFETY_FRAMES - visual.crossfadeFrames);
}

// ---------------------------------------------------------------- time per clip (slots)

/** Splits `total` into lengths within `caps`, as evenly as possible (smallest caps are served first). */
export function waterFill(total: number, caps: number[]): number[] {
  const order = caps.map((_, i) => i).sort((a, b) => caps[a]! - caps[b]!);
  const lengths = caps.map(() => 0);
  let remaining = total;
  order.forEach((index, k) => {
    const length = Math.min(caps[index]!, Math.ceil(remaining / (order.length - k)));
    lengths[index] = length;
    remaining -= length;
  });
  return lengths;
}

/**
 * Every clip gets an even share of the scene; a video shorter than its share plays once and the leftover
 * goes to the others (stills can hold any length). A video-only scene that outlasts all its clips put
 * together gives the excess to the longest video, which restarts (never A B A B).
 */
function splitSlots(sceneFrames: number, clips: FootageClip[], playable: (c: FootageClip) => number): Slot[] {
  const caps = clips.map(playable);
  const lengths = waterFill(sceneFrames, caps);
  const leftover = sceneFrames - lengths.reduce((sum, l) => sum + l, 0);
  if (leftover > 0) lengths[caps.indexOf(Math.max(...caps))]! += leftover;
  return clips.map((clip, i) => ({ clip, frames: lengths[i]! }));
}

// ---------------------------------------------------------------- slot -> shots

/** Fewest shots of <= maxShot frames covering `total`, the first one capped at `firstCap`. */
function shotLengths(total: number, maxShot: number, firstCap: number): number[] {
  const caps = [Math.min(maxShot, firstCap)];
  let capacity = caps[0]!;
  while (capacity < total) {
    caps.push(maxShot);
    capacity += maxShot;
  }
  return waterFill(total, caps).filter((length) => length > 0);
}

/** Start points of a video's shots spread over the whole clip, so each cut shows another part of it. */
function spreadTrims(lengths: number[], playable: number): number[] {
  const free = Math.max(0, playable - lengths.reduce((sum, l) => sum + l, 0));
  let prefix = 0;
  return lengths.map((length, j) => {
    const trim = prefix + (lengths.length > 1 ? Math.floor((j * free) / (lengths.length - 1)) : 0);
    prefix += length;
    return trim;
  });
}

// ---------------------------------------------------------------- camera moves

const STILL: Omit<SegmentMotion, "easing"> = { scaleFrom: 1, scaleTo: 1, panXFromPct: 0, panXToPct: 0, panYFromPct: 0, panYToPct: 0 };

/** Applies a pan direction without producing -0 (props stay comparable/serializable as plain 0). */
const signed = (sign: number, value: number): number => (value === 0 ? 0 : sign * value);

/** A face still: slow push-in to the configured zoom with a sideways pan. */
export function imageMotion(direction: 1 | -1, visual: Visual): Omit<SegmentMotion, "easing"> {
  const zoom = Math.min(visual.imageZoom, SAFE_MAX_ZOOM);
  if (zoom <= 1) return STILL; // zoom 1 = camera moves turned off in Configurações
  const share = visual.imagePan ? 1 : 0;
  return { ...STILL, scaleTo: zoom, panXToPct: signed(direction, Math.min(IMAGE_PAN_PCT, panPct(zoom, share))) };
}

/** Videos: gentle push-in; a later part of the same clip alternates with a pull-out. */
function videoMotion(variant: number, visual: Visual): Omit<SegmentMotion, "easing"> {
  const zoom = Math.min(visual.videoZoom, SAFE_MAX_ZOOM);
  return variant % 2 === 0 ? { ...STILL, scaleTo: zoom } : { ...STILL, scaleFrom: zoom };
}

const openingMotion = (): Omit<SegmentMotion, "easing"> => ({ ...STILL, scaleTo: Math.min(OPENING_PUNCH_ZOOM, SAFE_MAX_ZOOM) });

const easingFor = (visual: Visual, opening: boolean): MotionEasing => (visual.motionEasing === "ease" ? (opening ? "out" : "inOut") : "linear");

// ---------------------------------------------------------------- scene

/**
 * A still is a single shot whatever its length. A video jumps ahead every maxShot while it has footage
 * left; a slot longer than the video restarts it from the head in even pieces (no sliver at the end).
 */
function slotShots(slot: Slot, slotIndex: number, input: ScenePlanInput, firstCap: number): Shot[] {
  const { fps, visual, sceneOrdinal } = input;
  const isImage = slot.clip.kind === "image";
  const playable = playableFrames(slot.clip, fps, visual);
  const lengths = isImage ? [slot.frames] : shotLengths(slot.frames, Math.min(maxShotFrames(visual, fps), playable), firstCap);
  const trims = isImage || slot.frames > playable ? lengths.map(() => 0) : spreadTrims(lengths, playable);
  const direction = (sceneOrdinal + slotIndex) % 2 === 0 ? 1 : -1;
  return lengths.map((frames, variant) => {
    const opening = Number.isFinite(firstCap) && variant === 0;
    const move = !mayZoom(slot.clip, visual) ? STILL : opening ? openingMotion() : isImage ? imageMotion(direction, visual) : videoMotion(variant, visual);
    return { clip: slot.clip, frames, trimBeforeFrames: trims[variant]!, motion: { ...move, easing: easingFor(visual, opening) } };
  });
}

/** Same media back to back is a jump cut (another part of a video); different media dissolve like scene changes. */
function toSegments(shots: Shot[], srcOf: (clip: FootageClip) => string, crossfadeFrames: number): ClipSegment[] {
  let cursor = 0;
  return shots.map((shot, i) => {
    const previous = shots[i - 1];
    const dissolve = previous !== undefined && previous.clip.path !== shot.clip.path;
    const fadeInFrames = dissolve ? Math.min(crossfadeFrames, Math.floor(previous.frames / 3), Math.floor(shot.frames / 3)) : 0;
    const segment: ClipSegment = {
      src: srcOf(shot.clip),
      kind: shot.clip.kind,
      fromFrame: cursor,
      durationInFrames: shot.frames,
      trimBeforeFrames: shot.trimBeforeFrames,
      fadeInFrames,
      motion: shot.motion,
    };
    cursor += shot.frames;
    return segment;
  });
}

/** Lays the scene's clips out over `sceneFrames`, each clip once, in order. */
export function planSceneShots(input: ScenePlanInput): ClipSegment[] {
  const { sceneFrames, fps, visual } = input;
  if (input.clips.length === 0 || sceneFrames <= 0) return [];
  const playable = (clip: FootageClip): number => playableFrames(clip, fps, visual);
  const long = input.clips.filter((c) => playable(c) >= minShotFrames(visual, fps));
  const clips = long.length > 0 ? long : input.clips;
  const slots = splitSlots(sceneFrames, clips, playable).filter((slot) => slot.frames > 0);
  const openingCap = input.sceneOrdinal === 0 && visual.openingPunchIn ? Math.round(OPENING_PUNCH_SECONDS * fps) : Number.POSITIVE_INFINITY;
  const shots = slots.flatMap((slot, i) => slotShots(slot, i, input, i === 0 ? openingCap : Number.POSITIVE_INFINITY));
  return toSegments(shots, input.srcOf, visual.crossfadeFrames);
}
