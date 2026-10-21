import { describe, expect, it } from "vitest";
import {
  beatClipsPerQuery,
  beatForClip,
  beatProblems,
  beatStartsMs,
  decodeBeatSlot,
  encodeBeatSlot,
  findTokenPhrase,
  keepPerBeat,
  sanitizeBeats,
  withBeat,
} from "../../src/orchestrator/lib/beats.js";
import { textTokens } from "../../src/orchestrator/lib/ptBr.js";
import type { FootageClip, WordTiming } from "../../src/orchestrator/types.js";

const narration = "O ketchup era vendido em sachês de vidro, e só depois virou o frasco de plástico que a gente conhece.";

describe("phrase matching", () => {
  it("finds a literal phrase ignoring accents, case and punctuation, at token boundaries only", () => {
    const tokens = textTokens(narration);
    expect(findTokenPhrase(tokens, ["saches", "de", "vidro"])).toBe(5);
    expect(findTokenPhrase(tokens, ["frasco"])).toBe(13);
    expect(findTokenPhrase(tokens, ["frasco"], 14)).toBe(-1);
    expect(findTokenPhrase(tokens, ["chup"])).toBe(-1); // inside "ketchup": not a word start
    expect(findTokenPhrase(tokens, [])).toBe(-1);
  });

  it("tolerates different word splitting between script and TTS", () => {
    expect(findTokenPhrase(["o", "guarda", "chuva", "caiu"], ["guardachuva"])).toBe(1);
  });
});

describe("sanitizeBeats / beatProblems", () => {
  const beats = [
    { phrase: "vendido em SACHÊS de vidro", footageQuery: "glass ketchup bottles" },
    { phrase: "frasco de plástico", footageQuery: "plastic ketchup bottle" },
  ];

  it("accepts literal, ordered beats and trims them", () => {
    expect(beatProblems("scenes[0]", narration, beats)).toEqual([]);
    expect(sanitizeBeats(narration, [{ phrase: " frasco de plástico ", footageQuery: " x y " }])).toEqual([{ phrase: "frasco de plástico", footageQuery: "x y" }]);
  });

  it("flags a rewritten phrase and an out-of-order beat, naming the beat", () => {
    const bad = [beats[1]!, beats[0]!, { phrase: "ketchup em saquinhos", footageQuery: "sachets" }];
    const problems = beatProblems("scenes[2]", narration, bad);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("scenes[2].beats[1]");
    expect(problems[0]).toContain("fora de ordem");
    expect(problems[1]).toContain("scenes[2].beats[2]");
    expect(problems[1]).toContain("trecho literal");
    expect(beatProblems("scenes[0]", narration, [])).toEqual(['scenes[0] precisa de 1 a 3 "beats".']);
  });

  it("drops the beats it cannot place and returns undefined when none is left", () => {
    expect(sanitizeBeats(narration, [beats[1]!, beats[0]!])?.map((b) => b.phrase)).toEqual(["frasco de plástico"]);
    expect(sanitizeBeats(narration, [{ phrase: "nada disso", footageQuery: "x" }])).toBeUndefined();
    expect(sanitizeBeats(narration, undefined)).toBeUndefined();
  });
});

describe("beatStartsMs", () => {
  const words: WordTiming[] = narration.split(" ").map((word, i) => ({ word, startMs: 1000 + i * 300, endMs: 1000 + i * 300 + 250 }));
  const scene = { sceneIndex: 1, startMs: 1000, endMs: 7000 };

  it("starts beat 0 with the scene and later beats when their phrase is spoken", () => {
    const beats = [
      { phrase: "O ketchup", footageQuery: "a" },
      { phrase: "sachês de vidro", footageQuery: "b" },
      { phrase: "frasco de plástico", footageQuery: "c" },
    ];
    expect(beatStartsMs(words, scene, beats)).toEqual([1000, 1000 + 5 * 300, 1000 + 13 * 300]);
  });

  it("splits the scene evenly when a phrase is not found in the spoken words", () => {
    const beats = [{ phrase: "O ketchup", footageQuery: "a" }, { phrase: "garrafa de vidro", footageQuery: "b" }];
    expect(beatStartsMs(words, scene, beats)).toEqual([1000, 4000]);
  });
});

describe("adapter slots and budgets", () => {
  it("round-trips (scene, beat) through pseudo scene indexes above the hook's", () => {
    for (const sceneIndex of [0, 3, 6]) {
      for (const beatIndex of [1, 2]) expect(decodeBeatSlot(encodeBeatSlot(sceneIndex, beatIndex, 7), 7)).toEqual({ sceneIndex, beatIndex });
    }
    expect(encodeBeatSlot(0, 1, 7)).toBeGreaterThan(7);
    expect(decodeBeatSlot(7, 7)).toBeUndefined();
    expect(decodeBeatSlot(3, 7)).toBeUndefined();
  });

  it("maps clips back to their beat; scene-level clips of a beat scene are beat 0, others untouched", () => {
    const script = { scenes: [{ narration: "", footageQuery: "", beats: [{ phrase: "", footageQuery: "" }, { phrase: "", footageQuery: "" }] }, { narration: "", footageQuery: "" }] };
    const clip = (sceneIndex: number): FootageClip => ({ sceneIndex, path: "p", kind: "image", durationSeconds: 0, width: 1, height: 1, source: "", sourceUrl: "", creator: "", license: "" });
    expect(withBeat(clip(encodeBeatSlot(0, 1, 2)), script)).toMatchObject({ sceneIndex: 0, beatIndex: 1 });
    expect(withBeat(clip(0), script)).toMatchObject({ sceneIndex: 0, beatIndex: 0 });
    expect(withBeat(clip(1), script)).not.toHaveProperty("beatIndex");
    expect(beatForClip(script, { sceneIndex: 0, beatIndex: 1 })).toBe(script.scenes[0]!.beats![1]);
    expect(beatForClip(script, { sceneIndex: 1 })).toBeUndefined();
  });

  it("shares 1.5x the single-query budget between a scene's beats (default 3 per kind, 2 kinds -> cap 9)", () => {
    expect(beatClipsPerQuery(1, 3, 2)).toBe(3);
    expect(beatClipsPerQuery(2, 3, 2)).toBe(2);
    expect(beatClipsPerQuery(3, 3, 2)).toBe(1);
    expect(beatClipsPerQuery(3, 4, 1)).toBe(2);
    expect(keepPerBeat(3, 3)).toBe(1);
    expect(keepPerBeat(3, 2)).toBe(2);
    expect(keepPerBeat(3, 1)).toBe(3);
  });
});
