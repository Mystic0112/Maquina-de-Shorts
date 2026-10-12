// Pure layout of the hook/cover text (no React runtime) so placement invariants can be unit-tested.
//
// The text sits around 21% of the frame height: inside the central 3:4 area (12.5%..87.5% of a 9:16
// frame) that Instagram's profile grid keeps, below the Shorts top bar and well above the captions.

import type { CSSProperties } from "react";
import { interpolate } from "remotion";
import { CAPTION_DEFAULTS, CAPTION_FONTS, type CaptionSettings } from "../../shared/settings.js";
import type { OverlayHookProps } from "../shared.js";
import { AVG_GLYPH_EM, outlinedTextStyle } from "./captionStyle.js";

type Captions = Required<CaptionSettings>;

export const OVERLAY_CENTER = 0.21;
/** Top edge of the central 3:4 crop of a 9:16 frame (IG grid), as a fraction of the height. */
export const GRID_SAFE_TOP = 0.125;
const GRID_SAFE_PAD = 0.015;
const SIDE_MARGIN = 0.08;
const FONT_SCALE = 1.25; // relative to the caption max font
const MIN_FONT_PX = 56;
const MAX_LINES = 2;
const LINE_HEIGHT = 1.05;
const SPACE_EM = 0.3;

export type OverlayLayout = { fontSize: number; lines: number; left: number; width: number; centerY: number; height: number };

/** Greedy line count for `words` at `fontSize` in a box `width` px wide (width estimated per glyph). */
function estimateLines(words: string[], fontSize: number, width: number, glyphEm: number): number {
  let lines = 1;
  let used = 0;
  for (const word of words) {
    const w = word.length * glyphEm * fontSize;
    const next = used === 0 ? w : used + SPACE_EM * fontSize + w;
    if (next > width && used > 0) {
      lines += 1;
      used = w;
    } else used = next;
  }
  return lines;
}

export function overlayLayout(text: string, frameWidth: number, frameHeight: number, captions: Captions = CAPTION_DEFAULTS): OverlayLayout {
  const width = frameWidth * (1 - 2 * SIDE_MARGIN);
  const words = text.split(" ").filter(Boolean);
  const glyphEm = AVG_GLYPH_EM[captions.font];
  const longest = Math.max(1, ...words.map((w) => w.length));
  let fontSize = Math.min(Math.round(captions.maxFontPx * FONT_SCALE), width / (longest * glyphEm));
  while (fontSize > MIN_FONT_PX && estimateLines(words, fontSize, width, glyphEm) > MAX_LINES) fontSize *= 0.92;
  fontSize = Math.max(MIN_FONT_PX, Math.floor(fontSize));
  const lines = estimateLines(words, fontSize, width, glyphEm);
  const height = lines * fontSize * LINE_HEIGHT;
  const centerY = Math.max(frameHeight * OVERLAY_CENTER, frameHeight * (GRID_SAFE_TOP + GRID_SAFE_PAD) + height / 2);
  return { fontSize, lines, left: frameWidth * SIDE_MARGIN, width, centerY, height };
}

/** Fully opaque from frame 0 (it is the cover), fading out to 0 exactly at `endFrame`. */
export function overlayOpacity(frame: number, overlay: OverlayHookProps): number {
  if (frame >= overlay.endFrame) return 0;
  if (overlay.fadeFrames <= 0) return 1;
  return interpolate(frame, [overlay.endFrame - overlay.fadeFrames, overlay.endFrame], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

export function overlayTextStyle(layout: OverlayLayout, captions: Captions = CAPTION_DEFAULTS): CSSProperties {
  return {
    position: "absolute",
    left: layout.left,
    top: layout.centerY,
    width: layout.width,
    transform: "translateY(-50%)",
    textAlign: "center",
    fontFamily: CAPTION_FONTS[captions.font],
    fontWeight: 900,
    fontSize: layout.fontSize,
    lineHeight: LINE_HEIGHT,
    letterSpacing: "0.01em",
    color: captions.highlightColor,
    ...outlinedTextStyle(layout.fontSize, captions.strokeColor),
  };
}

/** Darkens the top of the frame behind the hook text for legibility on bright footage. */
export function overlayScrim(layout: OverlayLayout, frameHeight: number): string {
  const bottom = ((layout.centerY + layout.height / 2) / frameHeight) * 100;
  return `linear-gradient(to bottom, rgba(0,0,0,0.45) 0%, rgba(0,0,0,0.3) ${bottom.toFixed(1)}%, rgba(0,0,0,0) ${Math.min(100, bottom + 12).toFixed(1)}%)`;
}
