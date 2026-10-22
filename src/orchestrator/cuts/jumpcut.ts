/**
 * Jump cuts: which parts of a clip window to keep. Dead air between words is cut down to a short breath;
 * lively gaps (laughter, engine noise, people reacting without words) stay, capped, because that is where the
 * reference channels put their jokes and stickers. Liveliness comes from the transcript's loudness track
 * (python/cuts/transcribe.py); without it every gap counts as dead air.
 */
import type { Transcript, TranscriptWord } from "./transcribe.js";

/** Gaps up to this long are natural speech rhythm and stay untouched. */
export const KEEP_GAP_SECONDS = 0.5;
/** Breath left on each side of a cut. */
export const PAD_SECONDS = 0.2;
/** A lively gap (laughter) is kept up to this long. */
export const MAX_LIVELY_SECONDS = 2.5;
/** A gap is lively when its mean level is at most this far below the speech level. */
export const LIVELY_DROP_DB = 10;
/** Kept pieces shorter than this are dropped (a flash of a frame looks like a glitch). */
const MIN_PIECE_SECONDS = 0.12;

export type Loudness = NonNullable<Transcript["loudness"]>;
export type Interval = [number, number];

function meanDb(loudness: Loudness, from: number, to: number): number {
  const first = Math.max(0, Math.floor(from / loudness.hop));
  const last = Math.min(loudness.db.length, Math.ceil(to / loudness.hop));
  if (last <= first) return -90;
  let sum = 0;
  for (let i = first; i < last; i++) sum += loudness.db[i] as number;
  return sum / (last - first);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? -90;
}

/** Part of the gap [from, to] to remove, or undefined when the gap stays whole. */
function cutInGap(from: number, to: number, lively: boolean, edge: "lead" | "mid" | "tail"): Interval | undefined {
  const length = to - from;
  if (lively) {
    if (length <= MAX_LIVELY_SECONDS) return undefined;
    // Keep the start of the reaction (and the breath into the next word).
    if (edge === "tail") return [from + MAX_LIVELY_SECONDS, to];
    if (edge === "lead") return [from, to - MAX_LIVELY_SECONDS];
    return [from + MAX_LIVELY_SECONDS - PAD_SECONDS, to - PAD_SECONDS];
  }
  if (length <= KEEP_GAP_SECONDS) return undefined;
  if (edge === "lead") return [from, to - PAD_SECONDS];
  if (edge === "tail") return [from + 2 * PAD_SECONDS, to];
  return [from + PAD_SECONDS, to - PAD_SECONDS];
}

/**
 * Source intervals to keep inside [start, end] (absolute seconds, sorted, non-overlapping). The words of the
 * window are never touched: only the silence between, before and after them is trimmed.
 */
export function planKeep(words: readonly TranscriptWord[], loudness: Loudness | undefined, start: number, end: number): Interval[] {
  const inside = words.filter((w) => w.start >= start - 0.05 && w.end <= end + 0.05);
  if (inside.length === 0) return [[start, end]];
  const speechDb = loudness ? median(inside.map((w) => meanDb(loudness, w.start, w.end))) : 0;
  const isLively = (from: number, to: number): boolean => !!loudness && meanDb(loudness, from, to) >= speechDb - LIVELY_DROP_DB;

  const cuts: Interval[] = [];
  const consider = (from: number, to: number, edge: "lead" | "mid" | "tail"): void => {
    if (to - from <= 0) return;
    const cut = cutInGap(from, to, isLively(from, to), edge);
    if (cut && cut[1] > cut[0]) cuts.push(cut);
  };
  consider(start, Math.max(start, (inside[0] as TranscriptWord).start), "lead");
  for (let i = 1; i < inside.length; i++) consider((inside[i - 1] as TranscriptWord).end, (inside[i] as TranscriptWord).start, "mid");
  consider(Math.min(end, (inside.at(-1) as TranscriptWord).end), end, "tail");

  const keep: Interval[] = [];
  let cursor = start;
  for (const [from, to] of cuts) {
    if (from - cursor >= MIN_PIECE_SECONDS) keep.push([round(cursor), round(from)]);
    cursor = Math.max(cursor, to);
  }
  if (end - cursor >= MIN_PIECE_SECONDS) keep.push([round(cursor), round(end)]);
  return keep.length > 0 ? keep : [[start, end]];
}

export function keptSeconds(keep: readonly Interval[]): number {
  return round(keep.reduce((sum, [a, b]) => sum + (b - a), 0));
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

/** Laughter/reaction moments: lively word-free gaps of at least `minSeconds` (where the humor layer lands). */
export function livelyMoments(words: readonly TranscriptWord[], loudness: Loudness | undefined, start: number, end: number, minSeconds = 0.6): Interval[] {
  if (!loudness) return [];
  const inside = words.filter((w) => w.start >= start - 0.05 && w.end <= end + 0.05);
  if (inside.length === 0) return [];
  const speechDb = median(inside.map((w) => meanDb(loudness, w.start, w.end)));
  const gaps: Interval[] = [];
  for (let i = 1; i < inside.length; i++) {
    const from = (inside[i - 1] as TranscriptWord).end;
    const to = (inside[i] as TranscriptWord).start;
    if (to - from >= minSeconds && meanDb(loudness, from, to) >= speechDb - LIVELY_DROP_DB) gaps.push([round(from), round(to)]);
  }
  return gaps;
}
