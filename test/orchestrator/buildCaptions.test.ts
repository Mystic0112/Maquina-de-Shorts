import { describe, expect, it } from "vitest";
import {
  buildCaptions,
  cueOptionsFor,
  DEFAULT_CUE_OPTIONS,
  groupWordsIntoCues,
} from "../../src/orchestrator/stages/05-buildCaptions.js";
import type { WordTiming } from "../../src/orchestrator/types.js";

/** TTS-like words (no punctuation), 300 ms each with 80 ms gaps. */
function timed(text: string): WordTiming[] {
  return text.split(/\s+/).map((word, i) => ({ word, startMs: 100 + i * 380, endMs: 400 + i * 380 }));
}

const words = timed("o sol nasce no oeste em vênus e se põe no leste");

describe("cueOptionsFor", () => {
  it("keeps the historical limits for 3 words", () => {
    expect(cueOptionsFor(3)).toEqual(DEFAULT_CUE_OPTIONS);
  });

  it("gives 4-word cues room to form", () => {
    expect(cueOptionsFor(4)).toMatchObject({ maxWords: 4, maxChars: 24, maxDurationMs: 1600 });
  });
});

describe("groupWordsIntoCues with maxWordsPerCue", () => {
  it("1 word per cue: every word is its own cue", () => {
    const cues = groupWordsIntoCues(words, cueOptionsFor(1));
    expect(cues.map((c) => c.text)).toEqual(words.map((w) => w.word));
    expect(cues.every((c) => c.words.length === 1)).toBe(true);
  });

  it("4 words per cue: groups up to 4 short words", () => {
    const cues = groupWordsIntoCues(words, cueOptionsFor(4));
    expect(cues.map((c) => c.text)).toEqual(["o sol nasce no", "oeste em vênus e", "se põe no leste"]);
    expect(Math.max(...cues.map((c) => c.words.length))).toBe(4);
  });

  it("4 words per cue still honours clause breaks and the char limit", () => {
    const cues = groupWordsIntoCues(timed("Vênus gira, devagar demais extraordinariamente lento"), cueOptionsFor(4));
    expect(cues.map((c) => c.text)).toEqual(["Vênus gira,", "devagar demais", "extraordinariamente", "lento"]);
  });

  it("default (3) never exceeds 3 words", () => {
    const cues = groupWordsIntoCues(words);
    expect(Math.max(...cues.map((c) => c.words.length))).toBe(3);
  });
});

describe("buildCaptions honours the cue options end to end", () => {
  const script = {
    hook: "O Sol nasce no oeste em Vênus.",
    scenes: [
      { narration: "O Sol nasce no oeste em Vênus.", footageQuery: "venus planet nasa" },
      { narration: "E se põe no leste.", footageQuery: "sunset ocean horizon" },
    ],
    cta: "Siga o canal!",
  };
  const ttsWords = timed(
    [script.hook, ...script.scenes.map((s) => s.narration), script.cta].join(" ").replace(/[.,!]/g, ""),
  );
  const duration = (ttsWords.at(-1)?.endMs ?? 0) + 300;

  it.each([1, 4])("maxWordsPerCue %i keeps cues within the limit and scenes contiguous", (maxWords) => {
    const { captions } = buildCaptions(script, ttsWords, duration, cueOptionsFor(maxWords));
    expect(Math.max(...captions.cues.map((c) => c.words.length))).toBeLessThanOrEqual(maxWords);
    expect(captions.cues.flatMap((c) => c.words)).toHaveLength(ttsWords.length);
    expect(captions.scenes[0]?.startMs).toBe(0);
    expect(captions.scenes.at(-1)?.endMs).toBe(duration);
  });
});
