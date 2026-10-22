import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildRenderPayload, ensureModelFile, LIGHT_ASD } from "../../src/orchestrator/cuts/render.js";
import { KEEP_GAP_SECONDS, keptSeconds, MAX_LIVELY_SECONDS, PAD_SECONDS, planKeep, type Loudness } from "../../src/orchestrator/cuts/jumpcut.js";
import { buildVerifyPrompt, verifyPicks } from "../../src/orchestrator/cuts/select.js";
import type { LlmProvider } from "../../src/orchestrator/lib/llmClient.js";

const w = (word: string, start: number, end: number) => ({ word, start, end });

/** 10 Hz loudness: -20 dB everywhere except the given [from, to) ranges. */
function loudness(seconds: number, quiet: [number, number][], loud: [number, number][] = []): Loudness {
  const db = Array.from({ length: Math.ceil(seconds * 10) }, (_, i) => {
    const t = i / 10;
    if (loud.some(([a, b]) => t >= a && t < b)) return -18;
    return quiet.some(([a, b]) => t >= a && t < b) ? -60 : -20;
  });
  return { hop: 0.1, db };
}

describe("jump cut plan", () => {
  const words = [w("a", 0, 1), w("b", 1.2, 2), w("c", 6, 7), w("d", 7.3, 8)];

  it("keeps the speech rhythm and cuts dead air down to a breath on each side", () => {
    const keep = planKeep(words, loudness(10, [[2, 6]]), 0, 8);
    expect(keep).toEqual([[0, 2 + PAD_SECONDS], [6 - PAD_SECONDS, 8]]);
    expect(keptSeconds(keep)).toBeCloseTo(4.4, 3);
  });

  it("keeps a lively gap (laughter) whole when short, capped when long", () => {
    expect(planKeep([w("a", 0, 1), w("b", 3, 4)], loudness(10, [], [[1, 3]]), 0, 4)).toEqual([[0, 4]]);
    const long = planKeep(words, loudness(10, [], [[2, 6]]), 0, 8);
    expect(long).toEqual([[0, 2 + MAX_LIVELY_SECONDS - PAD_SECONDS], [6 - PAD_SECONDS, 8]]);
  });

  it("without a loudness track every long gap is dead air; short gaps stay", () => {
    const keep = planKeep([w("a", 0, 1), w("b", 1 + KEEP_GAP_SECONDS, 2)], undefined, 0, 2);
    expect(keep).toEqual([[0, 2]]);
    expect(planKeep(words, undefined, 0, 8)).toEqual([[0, 2 + PAD_SECONDS], [6 - PAD_SECONDS, 8]]);
  });

  it("trims silence before the first and after the last word, leaving a short tail", () => {
    const keep = planKeep([w("a", 3, 4), w("b", 4.1, 5)], loudness(12, [[0, 3], [5, 12]]), 0, 12);
    expect(keep).toEqual([[3 - PAD_SECONDS, 5 + 2 * PAD_SECONDS]]);
  });

  it("never drops a word and returns the whole window when it has no words", () => {
    const keep = planKeep(words, loudness(10, [[2, 6]]), 0, 8);
    for (const word of words) expect(keep.some(([a, b]) => word.start >= a && word.end <= b)).toBe(true);
    expect(planKeep([], undefined, 5, 9)).toEqual([[5, 9]]);
  });
});

describe("meaning and title review", () => {
  const transcript = {
    segments: [
      { start: 0, end: 60, text: "Antes: ele disse que era brincadeira." },
      { start: 60, end: 100, text: "O carro vai explodir." },
      { start: 100, end: 160, text: "Depois: todo mundo riu." },
    ],
    words: [],
  };
  const pick = (title: string) => ({ start: 60, end: 100, title, hook: "h", reason: "r" });

  it("shows the reviewer the context before and after each cut", () => {
    const prompt = buildVerifyPrompt([pick("O CARRO VAI EXPLODIR 😂")], transcript);
    expect(prompt).toMatch(/ANTES[^\n]*era brincadeira/);
    expect(prompt).toMatch(/O CORTE: O carro vai explodir/);
    expect(prompt).toMatch(/DEPOIS[^\n]*todo mundo riu/);
  });

  it("keeps only clips approved on meaning, title and respect; a missing verdict drops the clip", async () => {
    const completeJson = vi.fn(async () =>
      JSON.stringify({
        verdicts: [
          { clip: 1, meaningPreserved: true, titleFaithful: true, respectful: true, problem: "" },
          { clip: 2, meaningPreserved: false, titleFaithful: true, respectful: true, problem: "tirou a ironia" },
        ],
      }),
    );
    const provider = { name: "fake", model: "m", completeJson, completeGroundedText: vi.fn() } as unknown as LlmProvider;
    const { approved, rejected } = await verifyPicks([pick("ok"), pick("fora de contexto"), pick("sem veredito")], transcript, { provider });
    expect(approved.map((p) => p.title)).toEqual(["ok"]);
    expect(rejected.map((r) => [r.pick.title, r.verdict?.problem])).toEqual([["fora de contexto", "tirou a ironia"], ["sem veredito", undefined]]);
  });
});

describe("speaker detector model file", () => {
  it("is pinned to a commit and downloaded once, size-checked", async () => {
    expect(LIGHT_ASD.url).toMatch(/Light-ASD\/raw\/[0-9a-f]{40}\/weight\/finetuning_TalkSet\.model$/);
    const file = join(mkdtempSync(join(tmpdir(), "asd-")), "m", "w.model");
    const model = { ...LIGHT_ASD, file, minBytes: 4, maxBytes: 8 };
    const fetchFn = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4, 5]))) as unknown as typeof fetch;
    await expect(ensureModelFile(model, fetchFn)).resolves.toBe(file);
    await ensureModelFile(model, fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(readFileSync(file)).toHaveLength(5);
    const bad = vi.fn(async () => new Response("<html>nope</html>")) as unknown as typeof fetch;
    await expect(ensureModelFile({ ...model, file: `${file}2` }, bad)).rejects.toThrow(/unexpected size/);
    expect(existsSync(`${file}2`)).toBe(false);
  });

  it("goes to the renderer as asdModel (null = fallback heuristic)", () => {
    const input = { source: "/s.mp4", framing: "face" as const, credit: "c", captions: { wordsPerCue: 3, color: "#FFE11A" }, jobs: [] };
    expect(buildRenderPayload(input, "/y.onnx", "ffmpeg", "/m/asd.model")).toMatchObject({ asdModel: "/m/asd.model" });
    expect(buildRenderPayload(input, "/y.onnx", "ffmpeg")).toMatchObject({ asdModel: null });
  });
});
