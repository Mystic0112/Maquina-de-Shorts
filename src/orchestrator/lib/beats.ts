// Beats: a scene's narration split into 1-3 stretches that each get their own image, so the picture
// matches what is being said at that moment (02 writes them, 03 searches/reviews per beat, the renderer
// cuts when the beat's phrase starts). Pure helpers shared by those stages.

import type { FootageClip, SceneBeat, SceneTiming, Script, WordTiming } from "../types.js";
import { normalizeToken, textTokens, tokenSpans } from "./ptBr.js";

export const MAX_BEATS = 3;

/** Token index range [start, end) of a match inside a token list. */
export interface TokenRange {
  start: number;
  end: number;
}

/**
 * First place `needle` starts inside `haystack` (at or after `from`), comparing the tokens glued together
 * so TTS/script differences in word splitting ("guarda-chuva" vs "guarda chuva") still match. `end` is
 * the index after the last haystack token the match touches.
 */
export function locateTokenPhrase(haystack: readonly string[], needle: readonly string[], from = 0): TokenRange | undefined {
  const target = needle.join("");
  if (!target) return undefined;
  const starts: number[] = [];
  let text = "";
  for (const token of haystack) {
    starts.push(text.length);
    text += token;
  }
  let pos = text.indexOf(target, starts[from] ?? text.length);
  while (pos !== -1) {
    const start = starts.indexOf(pos);
    if (start >= from) {
      const stop = pos + target.length;
      let end = start + 1;
      while (end < haystack.length && starts[end]! < stop) end++;
      return { start, end };
    }
    pos = text.indexOf(target, pos + 1);
  }
  return undefined;
}

/** `locateTokenPhrase().start`, or -1 when absent. */
export function findTokenPhrase(haystack: readonly string[], needle: readonly string[], from = 0): number {
  return locateTokenPhrase(haystack, needle, from)?.start ?? -1;
}

/**
 * Where a beat's phrase is spoken (at or after `from`): the whole phrase or, when the model paraphrased
 * it, its longest run of consecutive tokens that is still in the narration, as long as that run keeps at
 * least max(2, 60%) of the phrase. Nothing is invented: the caller snaps the phrase to the matched words.
 */
export function matchBeatPhrase(haystack: readonly string[], phrase: string, from = 0): TokenRange | undefined {
  const needle = textTokens(phrase);
  const full = locateTokenPhrase(haystack, needle, from);
  if (full) return full;
  const minLen = Math.max(2, Math.ceil(needle.length * 0.6));
  // ponytail: O(n^2) runs over a <= ~10-token phrase; a DP is not worth it at this size.
  for (let len = needle.length - 1; len >= minLen; len--) {
    for (let i = 0; i + len <= needle.length; i++) {
      const range = locateTokenPhrase(haystack, needle.slice(i, i + len), from);
      if (range) return range;
    }
  }
  return undefined;
}

/**
 * Beats whose phrase (or enough of it, see `matchBeatPhrase`) is found in the narration, in narration
 * order, with the phrase replaced by the narration's own wording for those words; undefined when none
 * survives.
 */
export function sanitizeBeats(narration: string, beats: readonly SceneBeat[] | undefined): SceneBeat[] | undefined {
  if (!beats) return undefined;
  const text = narration.normalize("NFC");
  const spans = tokenSpans(text);
  const tokens = spans.map((s) => s.token);
  const kept: SceneBeat[] = [];
  let from = 0;
  for (const beat of beats.slice(0, MAX_BEATS)) {
    const footageQuery = beat.footageQuery.trim();
    const at = matchBeatPhrase(tokens, beat.phrase, from);
    if (!at || !footageQuery) continue;
    kept.push({ phrase: text.slice(spans[at.start]!.start, spans[at.end - 1]!.end), footageQuery });
    from = at.start + 1;
  }
  return kept.length > 0 ? kept : undefined;
}

/**
 * Problems (pt-BR, for the corrective retry) with one scene's beats; empty when they are valid. The
 * message asks for a literal copy, but a phrase `sanitizeBeats` can still recover (partial match) is not
 * reported, so a light paraphrase does not cost a correction round.
 */
export function beatProblems(label: string, narration: string, beats: readonly SceneBeat[] | undefined): string[] {
  if (!beats || beats.length === 0) return [`${label} precisa de 1 a ${MAX_BEATS} "beats".`];
  const problems: string[] = [];
  const tokens = textTokens(narration);
  let from = 0;
  beats.forEach((beat, j) => {
    const at = matchBeatPhrase(tokens, beat.phrase, 0);
    if (!at) {
      problems.push(`${label}.beats[${j}].phrase "${beat.phrase}" não é um trecho literal da narração da cena: copie as palavras exatamente como estão na narração.`);
    } else if (at.start < from) {
      problems.push(`${label}.beats[${j}].phrase "${beat.phrase}" está fora de ordem: os beats seguem a ordem da narração.`);
    } else {
      from = at.start + 1;
    }
  });
  return problems;
}

/**
 * Narration time where each beat starts, from the per-word timings inside the scene window. Beat 0 always
 * starts with the scene; a beat whose phrase is not found makes the scene fall back to an even split.
 */
export function beatStartsMs(words: readonly WordTiming[], scene: SceneTiming, beats: readonly SceneBeat[]): number[] {
  const inScene = words.filter((w) => w.startMs >= scene.startMs && w.startMs < scene.endMs);
  const tokens = inScene.map((w) => normalizeToken(w.word));
  const starts = [scene.startMs];
  let from = 0;
  for (const [k, beat] of beats.entries()) {
    const at = findTokenPhrase(tokens, textTokens(beat.phrase), from);
    if (at < 0) return beats.map((_, j) => scene.startMs + ((scene.endMs - scene.startMs) * j) / beats.length);
    if (k > 0) starts.push(inScene[at]!.startMs);
    from = at + 1;
  }
  return starts;
}

/**
 * Adapter requests carry one `sceneIndex` per query; beats k >= 1 travel as pseudo scene indexes above the
 * hook's (`sceneCount`), so clips can be mapped back to (scene, beat). Beat 0 uses the plain scene index.
 */
export function encodeBeatSlot(sceneIndex: number, beatIndex: number, sceneCount: number): number {
  return sceneCount + 1 + sceneIndex * MAX_BEATS + beatIndex;
}

export function decodeBeatSlot(slot: number, sceneCount: number): { sceneIndex: number; beatIndex: number } | undefined {
  if (slot <= sceneCount) return undefined;
  const n = slot - sceneCount - 1;
  return { sceneIndex: Math.floor(n / MAX_BEATS), beatIndex: n % MAX_BEATS };
}

/** Maps a downloaded clip's (pseudo) scene index back to scene + beat; scene-level queries of beat scenes are beat 0. */
export function withBeat(clip: FootageClip, script: Pick<Script, "scenes">): FootageClip {
  const slot = decodeBeatSlot(clip.sceneIndex, script.scenes.length);
  if (slot) return { ...clip, ...slot };
  return script.scenes[clip.sceneIndex]?.beats ? { ...clip, beatIndex: 0 } : clip;
}

/** The beat a clip was searched for, when its scene has beats. */
export function beatForClip(script: Pick<Script, "scenes">, clip: Pick<FootageClip, "sceneIndex" | "beatIndex">): SceneBeat | undefined {
  return clip.beatIndex === undefined ? undefined : script.scenes[clip.sceneIndex]?.beats?.[clip.beatIndex];
}

/**
 * Candidates per beat query (per media kind) so a scene never gets more than 1.5x the single-query budget:
 * cap = round(base * kinds * 1.5) per scene, shared evenly by its beats, never above `base` (default 3 per
 * kind with both kinds -> cap 9: 1 beat = 3 per kind, 2 beats = 2, 3 beats = 1).
 */
export function beatClipsPerQuery(beatCount: number, base: number, kinds: number): number {
  const cap = Math.round(base * Math.max(1, kinds) * 1.5);
  return Math.min(base, Math.max(1, Math.floor(cap / (Math.max(1, beatCount) * Math.max(1, kinds)))));
}

/** Clips kept per beat so a scene still keeps about `keepPerScene` in total. */
export function keepPerBeat(keepPerScene: number, beatCount: number): number {
  return Math.max(1, Math.ceil(keepPerScene / Math.max(1, beatCount)));
}
