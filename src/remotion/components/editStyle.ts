// Pure geometry of sticker cues (no React runtime) so "never over the caption / hook text" can be unit-tested.
//
// Captions start at captions.verticalPosition * height and grow downwards, so any box whose bottom stays above
// that line (minus a margin) never touches them. The hook text sits around 12-30% of the height during the
// first 2.5 s, but cues are never scheduled there (lib/editPlan.ts), so the top band is free for stickers.

import { interpolate, spring } from "remotion";
import { CAPTION_DEFAULTS, type CaptionSettings } from "../../shared/settings.js";
import type { EditCueProps } from "../shared.js";

type Captions = Required<CaptionSettings>;
type Placement = EditCueProps["placement"];
type Intensity = EditCueProps["intensity"];

export type EditBox = { left: number; top: number; width: number; height: number };

/** Highest a sticker may reach (below the Shorts top bar / inside the IG grid crop). */
export const EDIT_SAFE_TOP = 0.12;
/** Clear space kept between a sticker's bottom edge and the caption line. */
export const CAPTION_MARGIN = 0.02;
export const POP_IN_SECONDS = 0.25;
const EXIT_FRAMES = 5;

/** Square side as a fraction of the frame width, and the box center (fractions of width/height). */
const PLACEMENT: Record<Placement, { size: number; cx: number; cy: number }> = {
  top: { size: 0.42, cx: 0.5, cy: 0.26 },
  "side-left": { size: 0.26, cx: 0.16, cy: 0.47 },
  "side-right": { size: 0.26, cx: 0.8, cy: 0.47 },
  corner: { size: 0.18, cx: 0.84, cy: 0.19 },
};
const INTENSITY_SCALE: Record<Intensity, number> = { sutil: 0.8, normal: 1, forte: 1.2 };

/** Box for a sticker: centered on its placement, then pushed/shrunk to stay inside [EDIT_SAFE_TOP, caption line). */
export function editBox(placement: Placement, intensity: Intensity, width: number, height: number, captions: Captions = CAPTION_DEFAULTS): EditBox {
  const spec = PLACEMENT[placement];
  const minTop = height * EDIT_SAFE_TOP;
  const maxBottom = height * (captions.verticalPosition - CAPTION_MARGIN);
  const side = Math.min(width * spec.size * INTENSITY_SCALE[intensity], Math.max(1, maxBottom - minTop));
  let top = height * spec.cy - side / 2;
  if (top + side > maxBottom) top = maxBottom - side;
  if (top < minTop) top = minTop;
  return { left: width * spec.cx - side / 2, top, width: side, height: side };
}

/** Pop in (spring 0 -> 1 over ~250 ms), hold, quick scale/fade out over the last frames. */
export function cueScale(localFrame: number, durationInFrames: number, fps: number): number {
  const popFrames = Math.max(1, Math.round(POP_IN_SECONDS * fps));
  const pop = spring({ frame: localFrame, fps, durationInFrames: popFrames, config: { damping: 11, stiffness: 180, mass: 0.7 } });
  const exitFrom = Math.max(popFrames, durationInFrames - EXIT_FRAMES);
  const exit = interpolate(localFrame, [exitFrom, durationInFrames], [1, 0.6], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return pop * exit;
}

export function cueOpacity(localFrame: number, durationInFrames: number): number {
  const exitFrom = Math.max(0, durationInFrames - EXIT_FRAMES);
  return interpolate(localFrame, [exitFrom, durationInFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
}

/** Gentle idle wobble so a still PNG does not look pasted on; stronger for "forte". */
export function cueRotationDeg(localFrame: number, intensity: Intensity): number {
  const amplitude = intensity === "forte" ? 6 : intensity === "normal" ? 3 : 1.5;
  return Math.sin(localFrame / 4) * amplitude;
}
