// Pure caption styling (no React runtime) so layout invariants can be unit-tested.
//
// Invariant: a highlighted word must occupy exactly the same box, and paint exactly the same outline,
// as a plain word. Only `color` may differ. Word spacing comes from the container's flex `columnGap`
// (never per-word margins or transforms), so it is identical for first/last words and across wraps.

import type { CSSProperties } from "react";
import type { CaptionWordProps } from "../shared.js";

export const CAPTION_CENTER_Y = 0.62; // caption block vertical center, as a fraction of frame height
export const CAPTION_SAFE_LEFT = 0.08;
export const CAPTION_SAFE_RIGHT = 0.15; // Shorts action buttons live on the right edge
export const CAPTION_MAX_FONT_PX = 96;
export const CAPTION_HIGHLIGHT = "#FFE11A";
export const CAPTION_TEXT = "#FFFFFF";

const AVG_GLYPH_EM = 0.8; // approx. width of an uppercase Arial Black glyph, in em
const STROKE_EM = 0.2; // full stroke width; paint-order hides the inner half under the fill
const HARD_SHADOW_EM = 0.07;
const COLUMN_GAP_EM = 0.5;
const ROW_GAP_EM = 0.1;
const FONT_STACK = '"Arial Black", "Segoe UI Black", "Montserrat Black", Impact, "Helvetica Neue", Arial, sans-serif';

/** How far the painted outline reaches beyond the glyph edge, in em. */
const outlineReachEm = (): number => Math.max(STROKE_EM / 2, HARD_SHADOW_EM);

/** Clear space a viewer sees between two adjacent words' outlines, in px. */
export function visibleWordGapPx(fontSize: number): number {
  return (COLUMN_GAP_EM - 2 * outlineReachEm()) * fontSize;
}

export function captionFontSize(words: CaptionWordProps[], availableWidth: number): number {
  const longest = Math.max(...words.map((w) => w.text.length), 1);
  return Math.min(CAPTION_MAX_FONT_PX, availableWidth / (longest * AVG_GLYPH_EM));
}

/** The word being spoken; between words the previous one stays lit so the highlight never blinks. */
export function activeWordIndex(words: CaptionWordProps[], frame: number): number {
  let index = 0;
  words.forEach((w, i) => {
    if (frame >= w.startFrame) index = i;
  });
  return index;
}

/** Crisp 8-direction hard shadow (thick outline) plus a soft drop shadow for depth. */
function outlineShadow(fontSize: number): string {
  const r = Math.round(fontSize * HARD_SHADOW_EM);
  const d = Math.round(r * 0.7);
  const offsets = [[r, 0], [-r, 0], [0, r], [0, -r], [d, d], [-d, d], [d, -d], [-d, -d]];
  const hard = offsets.map(([x, y]) => `${x}px ${y}px 0 #000`);
  return [...hard, `0 ${Math.round(fontSize * 0.1)}px ${Math.round(fontSize * 0.2)}px rgba(0,0,0,0.85)`].join(", ");
}

export function captionWordStyle(active: boolean, fontSize: number): CSSProperties {
  return {
    display: "inline-block",
    whiteSpace: "nowrap",
    color: active ? CAPTION_HIGHLIGHT : CAPTION_TEXT,
    WebkitTextStroke: `${Math.round(fontSize * STROKE_EM)}px #000`,
    paintOrder: "stroke fill",
    textShadow: outlineShadow(fontSize),
  };
}

export function captionContainerStyle(fontSize: number, availableWidth: number, left: number, top: number, popScale: number): CSSProperties {
  return {
    position: "absolute",
    top,
    left,
    width: availableWidth,
    transform: `translateY(-50%) scale(${popScale})`, // whole group pops in together; word gaps scale with it
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    alignItems: "center",
    columnGap: Math.round(fontSize * COLUMN_GAP_EM),
    rowGap: Math.round(fontSize * ROW_GAP_EM),
    textAlign: "center",
    fontFamily: FONT_STACK,
    fontWeight: 900,
    fontSize,
    lineHeight: 1.1,
    letterSpacing: "0.01em",
  };
}
