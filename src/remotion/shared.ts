// Browser-safe types and constants shared by the Remotion bundle and the Node render side.
// Keep this file free of Node built-ins: it is compiled by webpack into the browser bundle.
// Props use `type` aliases (not interfaces) so they satisfy Remotion's Record<string, unknown> bound.

import { CAPTION_DEFAULTS, VISUAL_DEFAULTS, type RenderStyle } from "../shared/settings.js";

export type { RenderStyle } from "../shared/settings.js";

export const COMPOSITION_ID = "Short";

/** Today's look; used when no settings are configured and as Studio default props. */
export const DEFAULT_RENDER_STYLE: RenderStyle = { captions: CAPTION_DEFAULTS, visual: VISUAL_DEFAULTS };

/** Easing of a camera move: "inOut" for regular shots, "out" (fast start) for the opening punch-in. */
export type MotionEasing = "linear" | "inOut" | "out";

/**
 * Camera move over one segment's lifetime: CSS `scale()` plus a pan expressed in pre-scale % of the
 * frame width (X) and height (Y). Pans stay within the slack the zoom creates at both ends of the move,
 * which (scale and pan share one monotonic progress) keeps frame edges hidden during the whole move.
 */
export type SegmentMotion = {
  scaleFrom: number;
  scaleTo: number;
  panXFromPct: number;
  panXToPct: number;
  panYFromPct: number;
  panYToPct: number;
  easing: MotionEasing;
};

/**
 * One shot: a continuous run of a single media file inside a scene (frames relative to the scene's
 * visual start). Shots tile the scene back to back; a shot with `fadeInFrames` > 0 dissolves in over
 * the previous one, which is kept on screen under it for those frames.
 */
export type ClipSegment = {
  src: string; // path relative to the bundle public dir, used with staticFile()
  kind: "video" | "image";
  fromFrame: number;
  durationInFrames: number;
  /** Source frames skipped at the start of a video (another part of the same clip); 0 for stills. */
  trimBeforeFrames: number;
  fadeInFrames: number;
  motion: SegmentMotion;
  /** Every clip was already on screen, so this one comes back (never set while an unseen clip exists). */
  reused?: boolean;
};

/**
 * A scene is narration-aligned at [startFrame, startFrame + durationInFrames). It becomes visible
 * `leadInFrames` earlier, fading in over the previous scene (crossfade); `segments` are relative to
 * that earlier visual start and cover leadInFrames + durationInFrames.
 */
export type SceneProps = {
  sceneIndex: number;
  startFrame: number;
  durationInFrames: number;
  leadInFrames: number;
  segments: ClipSegment[];
};

/** `emphasis`: content word (noun, number, key verb); only those light up with highlight "keywords". */
export type CaptionWordProps = { text: string; startFrame: number; endFrame: number; emphasis: boolean };

export type CaptionChunkProps = {
  startFrame: number;
  endFrame: number;
  words: CaptionWordProps[];
};

/** On-screen hook/cover text: fully visible from frame 0 (the cover), fading out to gone at `endFrame`. */
export type OverlayHookProps = {
  text: string; // already uppercased
  endFrame: number;
  fadeFrames: number;
};

export type ShortProps = {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  audioSrc: string | null;
  style: RenderStyle;
  scenes: SceneProps[];
  captions: CaptionChunkProps[]; // empty when captions are disabled
  overlay: OverlayHookProps | null;
};

export const EMPTY_SHORT_PROPS: ShortProps = {
  width: 1080,
  height: 1920,
  fps: 30,
  durationInFrames: 90,
  audioSrc: null,
  style: DEFAULT_RENDER_STYLE,
  scenes: [],
  captions: [{ startFrame: 0, endFrame: 90, words: [{ text: "prévia da legenda", startFrame: 0, endFrame: 90, emphasis: true }] }],
  overlay: null,
};
