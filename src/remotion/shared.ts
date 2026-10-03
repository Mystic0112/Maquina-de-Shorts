// Browser-safe types and constants shared by the Remotion bundle and the Node render stage.
// Keep this file free of Node built-ins: it is compiled by webpack into the browser bundle.
// Props use `type` aliases (not interfaces) so they satisfy Remotion's Record<string, unknown> bound.

export const COMPOSITION_ID = "Short";
export const CROSSFADE_FRAMES = 8;

/**
 * Camera move over one segment's lifetime: CSS `scale()` and a horizontal pan expressed as a
 * percentage of the frame width (pre-scale). Pans stay within the slack the zoom creates, so
 * frame edges are never revealed.
 */
export type SegmentMotion = {
  scaleFrom: number;
  scaleTo: number;
  panXFromPct: number;
  panXToPct: number;
};

/** One continuous run of a single media file inside a scene (frames relative to the scene start). */
export type ClipSegment = {
  src: string; // path relative to the bundle public dir, used with staticFile()
  kind: "video" | "image";
  fromFrame: number;
  durationInFrames: number;
  motion: SegmentMotion;
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

export type CaptionWordProps = { text: string; startFrame: number; endFrame: number };

export type CaptionChunkProps = {
  startFrame: number;
  endFrame: number;
  words: CaptionWordProps[];
};

export type ShortProps = {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  audioSrc: string | null;
  crossfadeFrames: number;
  scenes: SceneProps[];
  captions: CaptionChunkProps[];
};

export const EMPTY_SHORT_PROPS: ShortProps = {
  width: 1080,
  height: 1920,
  fps: 30,
  durationInFrames: 90,
  audioSrc: null,
  crossfadeFrames: CROSSFADE_FRAMES,
  scenes: [],
  captions: [{ startFrame: 0, endFrame: 90, words: [{ text: "PRÉVIA", startFrame: 0, endFrame: 90 }] }],
};
