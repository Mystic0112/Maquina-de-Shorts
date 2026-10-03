// QA (Quinn): property-style invariants for 05-buildCaptions over many seeded, perturbed TTS outputs.
// Pure logic only: no LLM, no TTS, no filesystem.
import { describe, expect, it } from "vitest";
import { buildCaptions, cueOptionsFor, normalizeToken } from "../../src/orchestrator/stages/05-buildCaptions.js";
import type { Script, WordTiming } from "../../src/orchestrator/types.js";

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCAB = [
  "o", "sol", "nasce", "no", "oeste", "em", "vênus,", "e", "se", "põe", "leste.", "ninguém", "sabe", "guarda-chuva",
  "por", "quê?", "há", "mais", "de", "mil", "anos", "faraós", "construíram", "pirâmides!", "água", "1969", "lua;",
];

function randomScript(r: () => number): Script {
  const sceneCount = 4 + Math.floor(r() * 4);
  const sentence = (min: number, max: number): string =>
    Array.from({ length: min + Math.floor(r() * (max - min)) }, () => VOCAB[Math.floor(r() * VOCAB.length)]).join(" ");
  return {
    title: "t",
    hook: sentence(4, 9),
    scenes: Array.from({ length: sceneCount }, () => ({ narration: sentence(8, 25), footageQuery: "a b" })),
    cta: sentence(3, 6),
    language: "pt-BR",
  };
}

/** TTS-like words: punctuation stripped, occasional split/merge/drop/substitution/punctuation-only token. */
function ttsWords(script: Script, r: () => number): WordTiming[] {
  const raw = [script.hook, ...script.scenes.map((s) => s.narration), script.cta].join(" ").split(/\s+/);
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const w = (raw[i] ?? "").replace(/[.,!?;:]/g, "");
    const roll = r();
    if (roll < 0.03) continue; // dropped
    if (roll < 0.06 && w.includes("-")) out.push(...w.split("-"));
    else if (roll < 0.09 && i + 1 < raw.length) out.push(w + (raw[++i] ?? "").replace(/[.,!?;:]/g, ""));
    else if (roll < 0.11) out.push("xyzzy");
    else if (roll < 0.12) out.push(w, "—");
    else out.push(w);
  }
  let t = 50;
  return out.map((word) => {
    const startMs = t;
    const endMs = t + 150 + Math.floor(r() * 300);
    t = endMs + Math.floor(r() * 120);
    return { word, startMs, endMs };
  });
}

describe("05-buildCaptions invariants (seeded fuzz)", () => {
  const seeds = Array.from({ length: 300 }, (_, i) => i + 1);

  it("scene windows are contiguous, strictly increasing and cover exactly [0, durationMs]", () => {
    for (const seed of seeds) {
      const r = rng(seed);
      const script = randomScript(r);
      const words = ttsWords(script, r);
      const durationMs = (words.at(-1)?.endMs ?? 0) + 300;
      const { captions } = buildCaptions(script, words, durationMs, cueOptionsFor(3));
      expect(captions.scenes, `seed ${seed}`).toHaveLength(script.scenes.length);
      expect(captions.scenes[0]?.startMs, `seed ${seed}`).toBe(0);
      expect(captions.scenes.at(-1)?.endMs, `seed ${seed}`).toBe(durationMs);
      captions.scenes.forEach((s, k) => {
        expect(s.endMs, `seed ${seed} scene ${k}`).toBeGreaterThan(s.startMs);
        if (k > 0) expect(s.startMs, `seed ${seed} scene ${k}`).toBe(captions.scenes[k - 1]?.endMs);
      });
    }
  });

  it("cues keep every displayable word exactly once, in order, never overlap and respect maxWords", () => {
    for (const maxWords of [1, 2, 3, 4]) {
      for (const seed of seeds) {
        const r = rng(seed * 7 + maxWords);
        const script = randomScript(r);
        const words = ttsWords(script, r);
        const durationMs = (words.at(-1)?.endMs ?? 0) + 300;
        const { captions } = buildCaptions(script, words, durationMs, cueOptionsFor(maxWords));
        const shown = captions.cues.flatMap((c) => c.words.map((w) => w.word));
        const expected = words.map((w) => w.word.trim()).filter((w) => normalizeToken(w).length > 0);
        expect(shown, `seed ${seed} max ${maxWords}`).toEqual(expected);
        captions.cues.forEach((cue, k) => {
          expect(cue.words.length, `seed ${seed}`).toBeLessThanOrEqual(maxWords);
          expect(cue.endMs, `seed ${seed}`).toBeGreaterThanOrEqual(cue.startMs);
          const next = captions.cues[k + 1];
          if (next) expect(cue.endMs, `seed ${seed} cue ${k}`).toBeLessThanOrEqual(next.startMs);
        });
      }
    }
  });
});
