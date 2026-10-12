// Pure shot planning for one scene: which media, for how long, from which point of a video and with
// which camera move. No single framing stays on screen longer than visual.maxShotSeconds: long scenes
// cycle their clips, then reuse a still with a new framing (another region / zoom) or cut to another
// part of a video. Node-free (only types), so it could run in the browser bundle too.

import type { FootageClip } from "../orchestrator/types.js";
import type { VisualSettings } from "../shared/settings.js";
import type { ClipSegment, MotionEasing, SegmentMotion } from "./shared.js";

type Visual = Required<VisualSettings>;

/** Preferred pan of a still at the end of its first move, in % of frame width (clamped to the zoom's slack). */
export const IMAGE_PAN_PCT = 4;
/** Fraction of the zoom's edge slack a pan may use, leaving margin for rounding/subpixel sampling. */
const PAN_SLACK_USAGE = 0.75;
/** Never magnify footage (normalized to the frame size) beyond this. */
export const SAFE_MAX_ZOOM = 1.25;
/** A reused still is reframed this much tighter than the configured zoom (capped at SAFE_MAX_ZOOM). */
const REFRAME_EXTRA_ZOOM = 0.1;
export const OPENING_PUNCH_ZOOM = 1.2;
/** The opening shot is cut at most this long, so its punch-in is fast and the first cut lands early. */
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

const minShotFrames = (visual: Visual, fps: number): number => Math.min(Math.round(MIN_SHOT_SECONDS * fps), maxShotFrames(visual, fps));

/** Frames of a video that can be shown, keeping room for the next shot's dissolve over its end. */
function playableFrames(clip: FootageClip, fps: number, visual: Visual): number {
  if (clip.kind === "image") return Number.POSITIVE_INFINITY;
  return Math.max(1, Math.floor(clip.durationSeconds * fps) - CLIP_SAFETY_FRAMES - visual.crossfadeFrames);
}

// ---------------------------------------------------------------- time per clip (slots)

/** Video-only scene: chain the clips in order and loop the chain; never end on a sliver of a clip. */
function loopVideoSlots(sceneFrames: number, clips: FootageClip[], playable: (c: FootageClip) => number, minShot: number): Slot[] {
  const slots: Slot[] = [];
  for (let i = 0, cursor = 0; cursor < sceneFrames; i++) {
    const clip = clips[i % clips.length]!;
    const frames = Math.min(playable(clip), sceneFrames - cursor);
    slots.push({ clip, frames });
    cursor += frames;
  }
  growLastSlot(slots, Math.min(minShot, playable(slots[slots.length - 1]!.clip)), minShot);
  return slots;
}

/** Lengthens a too-short last slot to `target` by shortening earlier slots (each kept >= minShot). */
function growLastSlot(slots: Slot[], target: number, minShot: number): void {
  const last = slots[slots.length - 1]!;
  for (let i = slots.length - 2; i >= 0 && last.frames < target; i--) {
    const give = Math.min(target - last.frames, Math.max(0, slots[i]!.frames - minShot));
    slots[i]!.frames -= give;
    last.frames += give;
  }
}

/**
 * Scene containing stills: every clip gets an even share. A video shorter than its share plays once
 * and the leftover goes to the stills (never loop a video when a still can hold the shot).
 */
function splitSlotsWithImages(sceneFrames: number, clips: FootageClip[], playable: (c: FootageClip) => number): Slot[] {
  const share = Math.floor(sceneFrames / clips.length);
  const videoFrames = new Map(clips.filter((c) => c.kind === "video").map((c) => [c, Math.min(playable(c), share)]));
  let budgetLeft = sceneFrames - [...videoFrames.values()].reduce((sum, f) => sum + f, 0);
  let imagesLeft = clips.length - videoFrames.size;
  return clips.map((clip) => {
    const fixed = videoFrames.get(clip);
    if (fixed !== undefined) return { clip, frames: fixed };
    const frames = Math.ceil(budgetLeft / imagesLeft);
    imagesLeft -= 1;
    budgetLeft -= frames;
    return { clip, frames };
  });
}

// ---------------------------------------------------------------- slot -> shots

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

/** Zoom a reused still starts at: tighter than the configured zoom, or looser when that would pass SAFE_MAX_ZOOM. */
function reframeZoom(zoom: number): number {
  const tighter = zoom + REFRAME_EXTRA_ZOOM;
  return tighter <= SAFE_MAX_ZOOM + 1e-9 ? tighter : Math.max(1, zoom - REFRAME_EXTRA_ZOOM);
}

/**
 * Framing of the `variant`-th shot of the same still. 0: push-in with a sideways pan. Reuses alternate
 * 1: starts on another crop (zoom ±0.1) of the top of the picture and settles at the configured zoom,
 * 2: pushes in from wide towards its bottom. Every variant starts at a visibly different zoom/region
 * than the previous variant ended on, so each cut reads as a new shot.
 */
export function imageMotion(variant: number, direction: 1 | -1, visual: Visual): Omit<SegmentMotion, "easing"> {
  const zoom = Math.min(visual.imageZoom, SAFE_MAX_ZOOM);
  if (zoom <= 1) return STILL; // zoom 1 = camera moves turned off in Configurações
  const share = visual.imagePan ? 1 : 0;
  if (variant === 0) return { ...STILL, scaleTo: zoom, panXToPct: signed(direction, Math.min(IMAGE_PAN_PCT, panPct(zoom, share))) };
  if (variant % 2 === 1) {
    const crop = reframeZoom(zoom);
    return {
      scaleFrom: crop,
      scaleTo: zoom,
      panXFromPct: signed(direction, panPct(crop, share / 2)),
      panXToPct: signed(direction, panPct(zoom, share / 2)),
      panYFromPct: panPct(crop, share),
      panYToPct: panPct(zoom, share / 2),
    };
  }
  const wide = 1 + (zoom - 1) * 0.25;
  return {
    scaleFrom: wide,
    scaleTo: zoom,
    panXFromPct: signed(-direction, panPct(wide, share / 2)),
    panXToPct: signed(-direction, panPct(zoom, share / 2)),
    panYFromPct: 0,
    panYToPct: signed(-1, panPct(zoom, share)),
  };
}

/** Videos: gentle push-in; a later part of the same clip alternates with a pull-out. */
function videoMotion(variant: number, visual: Visual): Omit<SegmentMotion, "easing"> {
  const zoom = Math.min(visual.videoZoom, SAFE_MAX_ZOOM);
  return variant % 2 === 0 ? { ...STILL, scaleTo: zoom } : { ...STILL, scaleFrom: zoom };
}

const openingMotion = (): Omit<SegmentMotion, "easing"> => ({ ...STILL, scaleTo: Math.min(OPENING_PUNCH_ZOOM, SAFE_MAX_ZOOM) });

const easingFor = (visual: Visual, opening: boolean): MotionEasing => (visual.motionEasing === "ease" ? (opening ? "out" : "inOut") : "linear");

// ---------------------------------------------------------------- scene

function slotShots(slot: Slot, slotIndex: number, input: ScenePlanInput, firstCap: number): Shot[] {
  const { fps, visual, sceneOrdinal } = input;
  const lengths = shotLengths(slot.frames, maxShotFrames(visual, fps), firstCap);
  const trims = slot.clip.kind === "video" ? spreadTrims(lengths, playableFrames(slot.clip, fps, visual)) : lengths.map(() => 0);
  return lengths.map((frames, variant) => {
    const opening = Number.isFinite(firstCap) && variant === 0;
    const direction = (sceneOrdinal + slotIndex + variant) % 2 === 0 ? 1 : -1;
    const move = opening ? openingMotion() : slot.clip.kind === "image" ? imageMotion(variant, direction, visual) : videoMotion(variant, visual);
    return { clip: slot.clip, frames, trimBeforeFrames: trims[variant]!, motion: { ...move, easing: easingFor(visual, opening) } };
  });
}

/** Round-robin across the clips' shot lists (A1 B1 A2 B2 ...) so a long scene keeps cycling its clips. */
function interleave<T>(lists: T[][]): T[] {
  const out: T[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let round = 0; round < longest; round++) for (const list of lists) if (round < list.length) out.push(list[round]!);
  return out;
}

/** Same media back to back is a punch-in jump cut; different media dissolve like scene changes. */
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

/** Lays the scene's clips out over `sceneFrames` as shots of at most visual.maxShotSeconds each. */
export function planSceneShots(input: ScenePlanInput): ClipSegment[] {
  const { sceneFrames, fps, visual } = input;
  if (input.clips.length === 0 || sceneFrames <= 0) return [];
  const minShot = minShotFrames(visual, fps);
  const playable = (clip: FootageClip): number => playableFrames(clip, fps, visual);
  const long = input.clips.filter((c) => playable(c) >= minShot);
  const clips = long.length > 0 ? long : input.clips;
  const hasImage = clips.some((c) => c.kind === "image");
  const slots = (hasImage ? splitSlotsWithImages(sceneFrames, clips, playable) : loopVideoSlots(sceneFrames, clips, playable, minShot)).filter(
    (slot) => slot.frames > 0,
  );
  const openingCap = input.sceneOrdinal === 0 && visual.openingPunchIn ? Math.round(OPENING_PUNCH_SECONDS * fps) : Number.POSITIVE_INFINITY;
  const perSlot = slots.map((slot, i) => slotShots(slot, i, input, i === 0 ? openingCap : Number.POSITIVE_INFINITY));
  // Stills appear once each, so cycling them is safe; a looped video chain keeps its playback order.
  const shots = hasImage ? interleave(perSlot) : perSlot.flat();
  return toSegments(shots, input.srcOf, visual.crossfadeFrames);
}
