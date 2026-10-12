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

describe("keyword emphasis (pt-BR stopwords)", () => {
  it("marks content words, numbers and names; not articles, prepositions, conjunctions or pronouns", () => {
    const cues = groupWordsIntoCues(timed("o cheiro da Lua lembra pólvora e ele durou 7 dias em Paris"), cueOptionsFor(3));
    const emphasis = Object.fromEntries(cues.flatMap((c) => c.words).map((w) => [w.word, w.emphasis]));
    expect(emphasis).toMatchObject({ cheiro: true, Lua: true, lembra: true, pólvora: true, durou: true, "7": true, dias: true, Paris: true });
    expect(emphasis).toMatchObject({ o: false, da: false, e: false, ele: false, em: false });
  });

  it("every cue word carries the flag", () => {
    const cues = groupWordsIntoCues(words, cueOptionsFor(3));
    expect(cues.flatMap((c) => c.words).every((w) => typeof w.emphasis === "boolean")).toBe(true);
  });
});

describe("avoidDanglingWords", () => {
  const dangling = /^(o|a|os|as|um|uma|de|do|da|dos|das|em|no|na|nos|nas|por|para|pelo|pela|com|e|ou|que)$/i;

  it('never ends a cue on an article/preposition ("O CHEIRO DA" / "LUA" -> "O CHEIRO" / "DA LUA")', () => {
    const w = timed("o cheiro da lua lembra pólvora queimada");
    expect(groupWordsIntoCues(w, cueOptionsFor(3)).map((c) => c.text)).toEqual(["o cheiro da", "lua lembra", "pólvora queimada"]);
    const fixed = groupWordsIntoCues(w, cueOptionsFor(3, true)).map((c) => c.text);
    expect(fixed).toEqual(["o cheiro", "da lua lembra", "pólvora queimada"]);
  });

  it("moves several trailing function words together and keeps the word/duration limits", () => {
    const w = timed("a queda de uma fortaleza em paris mudou a frança para sempre e de vez");
    const cues = groupWordsIntoCues(w, cueOptionsFor(3, true));
    for (const cue of cues.slice(0, -1)) {
      if (cue.words.length > 1) expect(cue.words.at(-1)?.word).not.toMatch(dangling);
    }
    expect(Math.max(...cues.map((c) => c.words.length))).toBeLessThanOrEqual(3);
    for (const cue of cues) expect((cue.words.at(-1)?.endMs ?? 0) - (cue.words[0]?.startMs ?? 0)).toBeLessThanOrEqual(1200);
    expect(cues.flatMap((c) => c.words.map((x) => x.word))).toEqual(w.map((x) => x.word));
  });

  it("keeps the cue as is when the moved word would not fit with the next one (char limit)", () => {
    const cues = groupWordsIntoCues(timed("vale da extraordinariamente"), cueOptionsFor(3, true));
    expect(cues.map((c) => c.text)).toEqual(["vale da", "extraordinariamente"]);
  });

  it("end to end with the stage options: no cue ends dangling", () => {
    const script = {
      hook: "O cheiro da Lua lembra pólvora.",
      scenes: [
        { narration: "Os astronautas da Apollo sentiram o cheiro da poeira na cabine.", footageQuery: "x y" },
        { narration: "A poeira de uma rocha da Lua tem cheiro de fogos de artifício.", footageQuery: "x y" },
      ],
      cta: "",
    };
    const tts = timed([script.hook, ...script.scenes.map((s) => s.narration)].join(" ").replace(/[.,]/g, ""));
    const { captions } = buildCaptions(script, tts, (tts.at(-1)?.endMs ?? 0) + 200, cueOptionsFor(3, true));
    const endsDangling = captions.cues.filter((c) => c.words.length > 1 && dangling.test(c.words.at(-1)?.word ?? ""));
    expect(endsDangling.map((c) => c.text)).toEqual([]);
    expect(captions.cues.flatMap((c) => c.words)).toHaveLength(tts.length);
  });
});
