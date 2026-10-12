// Pure caption styling (no React runtime) so layout invariants can be unit-tested.
//
// Invariant: a highlighted word must occupy exactly the same box, and paint exactly the same outline,
// as a plain word. Only `color` may differ. Word spacing comes from the container's flex `columnGap`
// (never per-word margins or transforms), so it is identical for first/last words and across wraps.

import type { CSSProperties } from "react";
import { CAPTION_DEFAULTS, CAPTION_FONTS, type CaptionFont, type CaptionSettings } from "../../shared/settings.js";
import type { CaptionWordProps } from "../shared.js";

type Captions = Required<CaptionSettings>;

export const CAPTION_SAFE_LEFT = 0.08;
export const CAPTION_SAFE_RIGHT = 0.15; // Shorts action buttons live on the right edge

/** Approx. average glyph advance per font, in em, used to keep the longest word on one line. */
export const AVG_GLYPH_EM: Record<CaptionFont, number> = {
  "arial-black": 0.8,
  impact: 0.56,
  "segoe-black": 0.74,
  verdana: 0.72,
};
const LOWERCASE_WIDTH_FACTOR = 0.85;
const STROKE_EM = 0.2; // full stroke width; paint-order hides the inner half under the fill
const HARD_SHADOW_EM = 0.07;
const COLUMN_GAP_EM = 0.5;
const ROW_GAP_EM = 0.1;

/** How far the painted outline reaches beyond the glyph edge, in em. */
const outlineReachEm = (): number => Math.max(STROKE_EM / 2, HARD_SHADOW_EM);

/** Clear space a viewer sees between two adjacent words' outlines, in px. */
export function visibleWordGapPx(fontSize: number): number {
  return (COLUMN_GAP_EM - 2 * outlineReachEm()) * fontSize;
}

export function captionText(text: string, captions: Captions = CAPTION_DEFAULTS): string {
  return captions.uppercase ? text.toLocaleUpperCase("pt-BR") : text;
}

export function captionFontSize(words: CaptionWordProps[], availableWidth: number, captions: Captions = CAPTION_DEFAULTS): number {
  const longest = Math.max(...words.map((w) => w.text.length), 1);
  const glyphEm = AVG_GLYPH_EM[captions.font] * (captions.uppercase ? 1 : LOWERCASE_WIDTH_FACTOR);
  return Math.min(captions.maxFontPx, availableWidth / (longest * glyphEm));
}

/** The word being spoken; between words the previous one stays lit so the highlight never blinks. */
export function activeWordIndex(words: CaptionWordProps[], frame: number): number {
  let index = 0;
  words.forEach((w, i) => {
    if (frame >= w.startFrame) index = i;
  });
  return index;
}

/**
 * Index of the word painted in the highlight color, or -1. "color": the word being spoken. "keywords":
 * the latest spoken content word (emphasis), so "DE"/"DA" never light up and the keyword stays lit
 * while the small words after it are spoken. "none": no word.
 */
export function highlightedWordIndex(words: CaptionWordProps[], frame: number, mode: Captions["highlight"]): number {
  if (mode === "none" || words.length === 0) return -1;
  const active = activeWordIndex(words, frame);
  if (mode === "color") return active;
  for (let i = active; i >= 0; i--) if (words[i]!.emphasis) return i;
  return -1;
}

/** Crisp 8-direction hard shadow (thick outline) plus a soft drop shadow for depth. */
function outlineShadow(fontSize: number, strokeColor: string): string {
  const r = Math.round(fontSize * HARD_SHADOW_EM);
  const d = Math.round(r * 0.7);
  const offsets = [[r, 0], [-r, 0], [0, r], [0, -r], [d, d], [-d, d], [d, -d], [-d, -d]];
  const hard = offsets.map(([x, y]) => `${x}px ${y}px 0 ${strokeColor}`);
  return [...hard, `0 ${Math.round(fontSize * 0.1)}px ${Math.round(fontSize * 0.2)}px rgba(0,0,0,0.85)`].join(", ");
}

/** Thick outline + shadow shared by captions and the hook overlay (identical for every word). */
export function outlinedTextStyle(fontSize: number, strokeColor: string): CSSProperties {
  return {
    WebkitTextStroke: `${Math.round(fontSize * STROKE_EM)}px ${strokeColor}`,
    paintOrder: "stroke fill",
    textShadow: outlineShadow(fontSize, strokeColor),
  };
}

/** `highlighted`: chosen by highlightedWordIndex(); only the color changes, never the box or outline. */
export function captionWordStyle(highlighted: boolean, fontSize: number, captions: Captions = CAPTION_DEFAULTS): CSSProperties {
  const lit = highlighted && captions.highlight !== "none";
  return {
    display: "inline-block",
    whiteSpace: "nowrap",
    color: lit ? captions.highlightColor : captions.textColor,
    ...outlinedTextStyle(fontSize, captions.strokeColor),
  };
}

export type CaptionBox = { left: number; top: number; width: number };

/** Caption block geometry: safe horizontal band, vertically centered at `verticalPosition`. */
export function captionBox(frameWidth: number, frameHeight: number, captions: Captions = CAPTION_DEFAULTS): CaptionBox {
  return {
    left: frameWidth * CAPTION_SAFE_LEFT,
    top: frameHeight * captions.verticalPosition,
    width: frameWidth * (1 - CAPTION_SAFE_LEFT - CAPTION_SAFE_RIGHT),
  };
}

export function captionContainerStyle(fontSize: number, box: CaptionBox, popScale: number, captions: Captions = CAPTION_DEFAULTS): CSSProperties {
  return {
    position: "absolute",
    top: box.top,
    left: box.left,
    width: box.width,
    transform: `translateY(-50%) scale(${popScale})`, // whole group pops in together; word gaps scale with it
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    alignItems: "center",
    columnGap: Math.round(fontSize * COLUMN_GAP_EM),
    rowGap: Math.round(fontSize * ROW_GAP_EM),
    textAlign: "center",
    fontFamily: CAPTION_FONTS[captions.font],
    fontWeight: 900,
    fontSize,
    lineHeight: 1.1,
    letterSpacing: "0.01em",
  };
}

/** Vertical gradient stops (in %) for the legibility backdrop, centered on the caption block. */
export function backdropGradient(verticalPosition: number): string {
  const c = verticalPosition * 100;
  const stop = (offset: number): string => `${Math.min(100, Math.max(0, c + offset)).toFixed(1)}%`;
  return `linear-gradient(to bottom, rgba(0,0,0,0) ${stop(-22)}, rgba(0,0,0,0.35) ${stop(-4)}, rgba(0,0,0,0.35) ${stop(6)}, rgba(0,0,0,0) ${stop(23)})`;
}
