import { resolveCaptions } from "../../shared/settings.js";
import { loadConfig } from "../lib/config.js";
import { getLogger } from "../lib/logger.js";
import { isDanglingWord, isEmphasisWord, normalizeToken } from "../lib/ptBr.js";
import type { CaptionCue, Captions, RunContext, SceneTiming, Script, WordTiming } from "../types.js";

// ---------------------------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------------------------

export { normalizeToken };

const CLAUSE_END = /[.,!?;:…]["'”’»)\]]*$/u;

export function endsClause(text: string): boolean {
  return CLAUSE_END.test(text.trim());
}

export interface ScriptToken {
  norm: string;
  sceneIndex: number;
  endsClause: boolean;
}

/** Spoken text per scene: the hook is prepended to scene 0 and the CTA appended to the last scene. */
export function sceneTexts(script: Pick<Script, "hook" | "scenes" | "cta">): string[] {
  const texts = script.scenes.map((s) => s.narration.trim());
  if (texts.length === 0) return [`${script.hook} ${script.cta}`.trim()];
  texts[0] = `${script.hook.trim()} ${texts[0]}`.trim();
  texts[texts.length - 1] = `${texts[texts.length - 1]} ${script.cta.trim()}`.trim();
  return texts;
}

export function tokenizeScenes(texts: readonly string[]): ScriptToken[] {
  return texts.flatMap((text, sceneIndex) =>
    text
      .split(/\s+/)
      .map((raw) => ({ norm: normalizeToken(raw), sceneIndex, endsClause: endsClause(raw) }))
      .filter((token) => token.norm.length > 0),
  );
}

// ---------------------------------------------------------------------------------------------
// Alignment: TTS words -> script tokens (sequential, tolerant to split/merged/substituted tokens)
// ---------------------------------------------------------------------------------------------

export interface Alignment {
  /** Scene index for every TTS word (non-decreasing). */
  sceneOfWord: number[];
  /** Indexes of TTS words after which a caption cue must end (clause end or scene change). */
  breakAfter: Set<number>;
  /** Fraction of TTS words matched to a script token exactly or via split/merge. */
  matchRatio: number;
  /** True when sequential matching was too poor and words were distributed proportionally. */
  usedFallback: boolean;
}

const RESYNC_WINDOW = 6;

interface Cursor {
  i: number; // script token index
  j: number; // TTS word index
}

interface StepResult {
  scriptUsed: number;
  wordsUsed: number;
  matched: boolean;
}

export function alignWordsToScenes(words: readonly WordTiming[], tokens: readonly ScriptToken[], sceneCount: number): Alignment {
  const wordNorms = words.map((w) => normalizeToken(w.word));
  const sceneOfWord: number[] = new Array<number>(words.length).fill(0);
  const clauseAfter = new Set<number>();
  const cursor: Cursor = { i: 0, j: 0 };
  let matchedWords = 0;
  let countable = 0;

  while (cursor.j < words.length) {
    const scene = tokens[Math.min(cursor.i, tokens.length - 1)]?.sceneIndex ?? sceneCount - 1;
    if (!wordNorms[cursor.j] || cursor.i >= tokens.length) {
      if (wordNorms[cursor.j]) countable++;
      sceneOfWord[cursor.j++] = scene;
      continue;
    }
    const step = alignStep(tokens, wordNorms, cursor);
    for (let k = 0; k < step.wordsUsed; k++) sceneOfWord[cursor.j + k] = scene;
    const lastToken = tokens[cursor.i + step.scriptUsed - 1];
    if (step.matched && lastToken?.endsClause) clauseAfter.add(cursor.j + step.wordsUsed - 1);
    countable += step.wordsUsed;
    if (step.matched) matchedWords += step.wordsUsed;
    cursor.i += step.scriptUsed;
    cursor.j += step.wordsUsed;
  }

  const matchRatio = countable === 0 ? 0 : matchedWords / countable;
  return finalizeAlignment(words, wordNorms, tokens, sceneCount, { sceneOfWord, clauseAfter, matchRatio });
}

/** One alignment step at the cursor. Always consumes at least one TTS word. */
function alignStep(tokens: readonly ScriptToken[], wordNorms: readonly string[], c: Cursor): StepResult {
  const target = tokens[c.i]?.norm ?? "";
  const word = wordNorms[c.j] ?? "";
  if (target === word) return { scriptUsed: 1, wordsUsed: 1, matched: true };
  const split = matchSplit(target, wordNorms, c.j);
  if (split > 0) return { scriptUsed: 1, wordsUsed: split, matched: true };
  const merged = matchMerge(word, tokens, c.i);
  if (merged > 0) return { scriptUsed: merged, wordsUsed: 1, matched: true };
  return resync(tokens, wordNorms, c);
}

/** TTS split one script token into several words ("guarda-chuva" -> "guarda" "chuva"). Returns words used. */
function matchSplit(target: string, wordNorms: readonly string[], j: number): number {
  let acc = "";
  for (let k = j; k < wordNorms.length && k - j < RESYNC_WINDOW; k++) {
    acc += wordNorms[k] ?? "";
    if (acc === target) return k - j + 1;
    if (!target.startsWith(acc)) return 0;
  }
  return 0;
}

/** TTS merged several script tokens into one word. Returns script tokens used. */
function matchMerge(word: string, tokens: readonly ScriptToken[], i: number): number {
  let acc = "";
  for (let k = i; k < tokens.length && k - i < RESYNC_WINDOW; k++) {
    acc += tokens[k]?.norm ?? "";
    if (acc === word) return k - i + 1;
    if (!word.startsWith(acc)) return 0;
  }
  return 0;
}

/**
 * No direct match: find the nearest (script, word) pair ahead that matches exactly and skip to it.
 * Skipped TTS words stay in the current scene. Without any anchor, treat it as a 1:1 substitution.
 */
function resync(tokens: readonly ScriptToken[], wordNorms: readonly string[], c: Cursor): StepResult {
  for (let cost = 1; cost <= RESYNC_WINDOW * 2; cost++) {
    for (let dj = 0; dj <= Math.min(cost, RESYNC_WINDOW); dj++) {
      const di = cost - dj;
      if (di > RESYNC_WINDOW) continue;
      const token = tokens[c.i + di];
      const word = wordNorms[c.j + dj];
      if (token && word && token.norm === word) {
        if (dj === 0) return { scriptUsed: di, wordsUsed: 0, matched: false };
        return { scriptUsed: di, wordsUsed: dj, matched: false };
      }
    }
  }
  return { scriptUsed: 1, wordsUsed: 1, matched: false };
}

interface RawAlignment {
  sceneOfWord: number[];
  clauseAfter: Set<number>;
  matchRatio: number;
}

function finalizeAlignment(
  words: readonly WordTiming[],
  wordNorms: readonly string[],
  tokens: readonly ScriptToken[],
  sceneCount: number,
  raw: RawAlignment,
): Alignment {
  let sceneOfWord = enforceMonotonic(raw.sceneOfWord, sceneCount);
  const missingScene = words.length >= sceneCount && countScenes(sceneOfWord) < sceneCount;
  const usedFallback = missingScene || raw.matchRatio < 0.5;
  if (usedFallback) sceneOfWord = proportionalScenes(words.length, tokens, sceneCount);
  const breakAfter = new Set<number>(usedFallback ? [] : raw.clauseAfter);
  words.forEach((w, j) => {
    if (endsClause(w.word)) breakAfter.add(j);
    if (j + 1 < words.length && sceneOfWord[j + 1] !== sceneOfWord[j]) breakAfter.add(j);
    if (!wordNorms[j]) breakAfter.add(j);
  });
  return { sceneOfWord, breakAfter, matchRatio: raw.matchRatio, usedFallback };
}

function enforceMonotonic(sceneOfWord: readonly number[], sceneCount: number): number[] {
  let current = 0;
  return sceneOfWord.map((scene) => {
    current = Math.min(Math.max(current, scene), sceneCount - 1);
    return current;
  });
}

function countScenes(sceneOfWord: readonly number[]): number {
  return new Set(sceneOfWord).size;
}

/** Distributes words over scenes in proportion to each scene's script token count. */
export function proportionalScenes(wordCount: number, tokens: readonly ScriptToken[], sceneCount: number): number[] {
  const perScene = new Array<number>(sceneCount).fill(0);
  for (const token of tokens) perScene[token.sceneIndex] = (perScene[token.sceneIndex] ?? 0) + 1;
  const cumulative: number[] = [];
  let running = 0;
  for (const count of perScene) {
    running += Math.max(count, 1); // an empty scene still gets a sliver
    cumulative.push(running);
  }
  const scale = running / Math.max(wordCount, 1);
  return Array.from({ length: wordCount }, (_, j) => {
    const position = (j + 0.5) * scale;
    const scene = cumulative.findIndex((end) => position < end);
    return scene === -1 ? sceneCount - 1 : scene;
  });
}

// ---------------------------------------------------------------------------------------------
// Scene timings
// ---------------------------------------------------------------------------------------------

/**
 * Contiguous scene windows covering exactly [0, durationMs]. Cuts happen in the middle of the pause
 * between the last word of one scene and the first word of the next.
 */
export function computeSceneTimings(
  words: readonly WordTiming[],
  sceneOfWord: readonly number[],
  sceneCount: number,
  durationMs: number,
): SceneTiming[] {
  const boundaries = [0];
  for (let scene = 1; scene < sceneCount; scene++) {
    boundaries.push(boundaryBefore(scene, words, sceneOfWord, durationMs, sceneCount));
  }
  boundaries.push(durationMs);
  const fixed = fixBoundaries(boundaries, durationMs);
  return Array.from({ length: sceneCount }, (_, sceneIndex) => ({
    sceneIndex,
    startMs: fixed[sceneIndex] ?? 0,
    endMs: fixed[sceneIndex + 1] ?? durationMs,
  }));
}

function boundaryBefore(
  scene: number,
  words: readonly WordTiming[],
  sceneOfWord: readonly number[],
  durationMs: number,
  sceneCount: number,
): number {
  const first = sceneOfWord.findIndex((s) => s >= scene);
  if (first <= 0) return first === 0 ? 0 : Math.round((durationMs * scene) / sceneCount);
  const prevEnd = words[first - 1]?.endMs ?? 0;
  const nextStart = words[first]?.startMs ?? prevEnd;
  return Math.round(nextStart >= prevEnd ? (prevEnd + nextStart) / 2 : nextStart);
}

/** Makes boundaries strictly increasing inside [0, durationMs] with the endpoints pinned. */
function fixBoundaries(boundaries: readonly number[], durationMs: number): number[] {
  const n = boundaries.length - 1;
  const minGap = n > 0 ? Math.min(1, durationMs / n) : 0;
  const out = boundaries.map((b) => Math.min(Math.max(Math.round(b), 0), durationMs));
  out[0] = 0;
  out[n] = durationMs;
  for (let k = 1; k < n; k++) {
    const lower = (out[k - 1] ?? 0) + minGap;
    const upper = durationMs - (n - k) * minGap;
    out[k] = Math.min(Math.max(out[k] ?? lower, lower), upper);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Caption cues
// ---------------------------------------------------------------------------------------------

export interface CueOptions {
  maxWords: number;
  maxChars: number;
  maxDurationMs: number;
  /** Extend a cue's end to the next cue's start when the gap is at most this (avoids flicker). */
  bridgeGapMs: number;
  /** Never end a cue on an article/preposition/conjunction: it moves to the next cue when that still fits. */
  avoidDanglingWords?: boolean;
}

export const DEFAULT_CUE_OPTIONS: CueOptions = { maxWords: 3, maxChars: 16, maxDurationMs: 1200, bridgeGapMs: 250 };

/**
 * Cue limits for the configured captions.maxWordsPerCue (1-4). Up to 3 words keeps the original
 * 16-char / 1.2 s limits; 4 words gets proportionally more room (24 chars, 1.6 s) so it can actually
 * form. Stage 06 only re-splits cues longer than maxWordsPerCue, so both stay consistent.
 */
export function cueOptionsFor(maxWordsPerCue: number, avoidDanglingWords = false): CueOptions {
  const maxWords = Math.max(1, Math.round(maxWordsPerCue));
  return {
    ...DEFAULT_CUE_OPTIONS,
    maxWords,
    maxChars: maxWords <= DEFAULT_CUE_OPTIONS.maxWords ? DEFAULT_CUE_OPTIONS.maxChars : 6 * maxWords,
    maxDurationMs: Math.max(DEFAULT_CUE_OPTIONS.maxDurationMs, 400 * maxWords),
    ...(avoidDanglingWords ? { avoidDanglingWords } : {}),
  };
}

/**
 * Groups words into 1-3 word cues, breaking on punctuation/scene changes, length and duration limits.
 * Every cue word carries `emphasis` (content word vs article/preposition/pronoun) for keyword highlighting.
 */
export function groupWordsIntoCues(
  words: readonly WordTiming[],
  options: CueOptions = DEFAULT_CUE_OPTIONS,
  breakAfter: ReadonlySet<number> = new Set(),
): CaptionCue[] {
  const groups: WordTiming[][] = [];
  let current: WordTiming[] = [];
  const flush = (): void => {
    if (current.length > 0) groups.push(current);
    current = [];
  };
  words.forEach((word, j) => {
    if (!normalizeToken(word.word)) return; // pure punctuation tokens are not displayed
    const text = word.word.trim();
    const next: WordTiming = { ...word, word: text, emphasis: isEmphasisWord(text) };
    if (current.length > 0 && !fitsInCue(current, next, options)) current = closeCue(groups, current, next, options);
    current.push(next);
    if (breakAfter.has(j) || endsClause(word.word)) flush();
  });
  flush();
  return bridgeGaps(groups.map(toCue), options.bridgeGapMs);
}

/**
 * Closes `current` as a cue because `next` does not fit. With avoidDanglingWords, trailing articles,
 * prepositions and conjunctions ("O CHEIRO DA") move to the next cue ("DA LUA") when they still fit there
 * with `next`; otherwise the cue closes as is. Returns the words that start the next cue.
 */
function closeCue(groups: WordTiming[][], current: readonly WordTiming[], next: WordTiming, options: CueOptions): WordTiming[] {
  const tail = options.avoidDanglingWords ? danglingTailLength(current) : 0;
  const carried = current.slice(current.length - tail);
  if (tail > 0 && fitsInCue(carried, next, options)) {
    groups.push(current.slice(0, current.length - tail));
    return carried;
  }
  groups.push([...current]);
  return [];
}

/** Trailing dangling words of a group, always leaving at least one word behind. */
function danglingTailLength(group: readonly WordTiming[]): number {
  let n = 0;
  while (n < group.length - 1 && isDanglingWord(group[group.length - 1 - n]?.word ?? "")) n++;
  return n;
}

function fitsInCue(current: readonly WordTiming[], next: WordTiming, options: CueOptions): boolean {
  const first = current[0];
  if (!first) return true;
  const chars = current.reduce((n, w) => n + w.word.trim().length, 0) + current.length + next.word.trim().length;
  return (
    current.length < options.maxWords && chars <= options.maxChars && next.endMs - first.startMs <= options.maxDurationMs
  );
}

function toCue(words: WordTiming[]): CaptionCue {
  return {
    text: words.map((w) => w.word).join(" "),
    startMs: words[0]?.startMs ?? 0,
    endMs: words[words.length - 1]?.endMs ?? 0,
    words,
  };
}

function bridgeGaps(cues: CaptionCue[], bridgeGapMs: number): CaptionCue[] {
  return cues.map((cue, k) => {
    const next = cues[k + 1];
    if (!next) return cue;
    const gap = next.startMs - cue.endMs;
    return gap > 0 && gap <= bridgeGapMs ? { ...cue, endMs: next.startMs } : cue;
  });
}

function clampWords(words: readonly WordTiming[], durationMs: number): WordTiming[] {
  return words.map((w) => {
    const startMs = Math.min(Math.max(0, w.startMs), durationMs);
    return { ...w, startMs, endMs: Math.min(Math.max(startMs, w.endMs), durationMs) };
  });
}

// ---------------------------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------------------------

export interface BuildCaptionsResult {
  captions: Captions;
  alignment: Alignment;
}

export function buildCaptions(
  script: Pick<Script, "hook" | "scenes" | "cta">,
  words: readonly WordTiming[],
  durationMs: number,
  options: CueOptions = DEFAULT_CUE_OPTIONS,
): BuildCaptionsResult {
  const sceneCount = Math.max(script.scenes.length, 1);
  const clamped = clampWords(words, durationMs);
  const alignment = alignWordsToScenes(clamped, tokenizeScenes(sceneTexts(script)), sceneCount);
  const cues = groupWordsIntoCues(clamped, options, alignment.breakAfter);
  const scenes = computeSceneTimings(clamped, alignment.sceneOfWord, sceneCount, durationMs);
  return { captions: { cues, scenes }, alignment };
}

export async function run(ctx: RunContext): Promise<RunContext> {
  if (!ctx.script) throw new Error("05-buildCaptions requires ctx.script");
  if (!ctx.narration) throw new Error("05-buildCaptions requires ctx.narration (run 04-synthesizeVoice first)");
  const log = getLogger(ctx.runId);
  const captionSettings = resolveCaptions(loadConfig().captions);
  const cueOptions = cueOptionsFor(captionSettings.maxWordsPerCue, captionSettings.avoidDanglingWords);
  const { captions, alignment } = buildCaptions(ctx.script, ctx.narration.words, ctx.narration.durationMs, cueOptions);
  const ratio = `${Math.round(alignment.matchRatio * 100)}%`;
  if (alignment.usedFallback) log.warn(`Word alignment weak (${ratio} matched); scenes split proportionally`);
  const sceneSummary = captions.scenes.map((s) => `${s.sceneIndex}:${s.startMs}-${s.endMs}`).join(" ");
  const cueWords = captions.cues.flatMap((c) => c.words);
  const emphasized = cueWords.filter((w) => w.emphasis).length;
  const dangling = captions.cues.filter((c) => c.words.length > 1 && isDanglingWord(c.words.at(-1)?.word ?? "")).length;
  log.info(
    `Captions: ${captions.cues.length} cues (max ${cueOptions.maxWords} words${cueOptions.avoidDanglingWords ? ", no dangling words" : ""}), ` +
      `${emphasized}/${cueWords.length} words emphasized, ${dangling} cue(s) ending on a function word, alignment ${ratio}, scenes ${sceneSummary}`,
  );
  return { ...ctx, captions };
}
