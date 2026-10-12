// Pure per-frame camera math (no React) so easing and edge safety can be unit-tested.

import { Easing, interpolate } from "remotion";
import type { MotionEasing, SegmentMotion } from "../shared.js";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** Both curves stay inside [0, 1] and are monotonic, so scale/pan never overshoot their endpoints. */
const EASINGS: Record<MotionEasing, (t: number) => number> = {
  linear: (t) => t,
  inOut: Easing.bezier(0.45, 0, 0.55, 1),
  out: Easing.bezier(0.22, 1, 0.36, 1), // fast start: the opening punch-in moves from the first frames
};

export type CameraState = { scale: number; panXPct: number; panYPct: number };

/** Camera at `frame` (relative to the segment start) of a move lasting `durationInFrames`. */
export function cameraAt(motion: SegmentMotion, frame: number, durationInFrames: number): CameraState {
  const progress = interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [0, 1], { ...clamp, easing: EASINGS[motion.easing] });
  const lerp = (from: number, to: number): number => from + (to - from) * progress;
  return {
    scale: lerp(motion.scaleFrom, motion.scaleTo),
    panXPct: lerp(motion.panXFromPct, motion.panXToPct),
    panYPct: lerp(motion.panYFromPct, motion.panYToPct),
  };
}

/** translate() is applied before scale() (CSS composes right-to-left): the pan is in pre-scale % of the frame. */
export const cameraTransform = (camera: CameraState): string =>
  `scale(${camera.scale}) translate(${camera.panXPct}%, ${camera.panYPct}%)`;

/** Opacity of a shot that dissolves in over its first `fadeInFrames`. */
export function fadeInOpacity(frame: number, fadeInFrames: number): number {
  return fadeInFrames > 0 ? interpolate(frame, [0, fadeInFrames], [0, 1], clamp) : 1;
}
