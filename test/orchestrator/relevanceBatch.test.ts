import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("../../src/orchestrator/lib/ffmpeg.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/orchestrator/lib/ffmpeg.js")>();
  return { ...actual, extractFrames: vi.fn() };
});

import { encodeBeatSlot } from "../../src/orchestrator/lib/beats.js";
import { extractFrames } from "../../src/orchestrator/lib/ffmpeg.js";
import type { LlmImage, LlmProvider } from "../../src/orchestrator/lib/llmClient.js";
import {
  buildRelevanceBatchPrompt,
  buildRelevancePrompt,
  MAX_IMAGES_PER_CALL,
  planBatches,
  resolveRelevanceSettings,
  scoreClipBatch,
} from "../../src/orchestrator/lib/relevance.js";
import { reviewContextKey } from "../../src/orchestrator/stages/03-fetchFootage.js";
import type { FootageClip, Script } from "../../src/orchestrator/types.js";

const script: Script = {
  title: "A Bastilha tinha só sete presos",
  overlayText: "SÓ 7 PRESOS?",
  hook: "A Bastilha tinha só sete presos quando caiu.",
  hookFootageQuery: "storming of the Bastille painting",
  scenes: [
    {
      narration: "Em julho de 1789, a multidão de Paris invadiu a fortaleza.",
      footageQuery: "Paris 1789 crowd",
      beats: [
        { phrase: "Em julho de 1789", footageQuery: "Paris 1789 crowd" },
        { phrase: "invadiu a fortaleza", footageQuery: "Bastille fortress engraving" },
      ],
    },
    { narration: "Lá dentro, só sete prisioneiros esperavam.", footageQuery: "Bastille prison cell illustration" },
  ],
  cta: "",
  language: "pt-BR",
};

function clip(over: Partial<FootageClip> = {}): FootageClip {
  return {
    sceneIndex: 1, path: `/run/norm/1_${Math.random().toString(36).slice(2, 6)}.mp4`, kind: "video", durationSeconds: 8,
    width: 1080, height: 1920, source: "wikimedia", sourceUrl: "https://c/x", creator: "c", license: "Public domain", ...over,
  };
}

const verdict = (n: number, score = 7) => ({ candidate: n, score, matches: true, reason: `candidate ${n}`, hasTextOrLogo: false, hasIdentifiablePeople: false });

interface Call {
  prompt: string;
  images: readonly LlmImage[];
  schema: z.ZodType;
}

function fakeProvider(answer: unknown): { provider: LlmProvider; calls: Call[] } {
  const calls: Call[] = [];
  const provider: LlmProvider = {
    name: "gemini",
    model: "fake",
    async completeJson(prompt, schema, images = []) {
      calls.push({ prompt, images, schema });
      return JSON.stringify(answer);
    },
    async completeGroundedText() {
      throw new Error("not used");
    },
  };
  return { provider, calls };
}

beforeEach(() => {
  vi.mocked(extractFrames).mockReset();
  // Stills (duration 0) give one frame, videos three; frame bytes encode the clip name so order can be checked.
  vi.mocked(extractFrames).mockImplementation(async (input, duration, _dir, base) =>
    Array.from({ length: duration > 0 ? 3 : 1 }, (_, i) => Buffer.from(`${base}#${i}`)),
  );
});

describe("scoreClipBatch", () => {
  const scene = script.scenes[1]!;

  it("reviews 3 clips in ONE call and maps the verdicts back in candidate order", async () => {
    const clips = [clip({ path: "/run/norm/1_0.mp4" }), clip({ path: "/run/norm/1_1.jpg", kind: "image", durationSeconds: 0 }), clip({ path: "/run/norm/1_2.mp4" })];
    // Answer out of order on purpose: the candidate number, not the position, decides.
    const { provider, calls } = fakeProvider({ verdicts: [verdict(3, 9), verdict(1, 4), verdict(2, 7)] });
    const scored = await scoreClipBatch(clips, scene, "/frames", script.title, "low", script.hook, provider);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.images.map((i) => i.data.toString())).toEqual(["1_0#0", "1_0#1", "1_0#2", "1_1#0", "1_2#0", "1_2#1", "1_2#2"]);
    expect(calls[0]!.prompt).toContain("- Candidate 1: images 1-3 (3 frames sampled from one stock clip)");
    expect(calls[0]!.prompt).toContain("- Candidate 2: image 4 (one still picture)");
    expect(calls[0]!.prompt).toContain("- Candidate 3: images 5-7");
    expect(calls[0]!.prompt).toContain("3 DIFFERENT candidate clips");
    expect(scored.map((s) => s.clip.path)).toEqual(clips.map((c) => c.path));
    expect(scored.map((s) => s.verdict?.score)).toEqual([4, 7, 9]);
    expect(scored[0]!.verdict).not.toHaveProperty("candidate");
  });

  it("a missing or duplicated verdict only fails that clip", async () => {
    const clips = [clip(), clip(), clip()];
    const { provider } = fakeProvider({ verdicts: [verdict(1), verdict(3), verdict(3)] });
    const scored = await scoreClipBatch(clips, scene, "/frames", undefined, "low", undefined, provider);
    expect(scored[0]!.verdict?.score).toBe(7);
    expect(scored[1]).toMatchObject({ error: expect.stringContaining("0 verdicts for candidate 2") });
    expect(scored[2]).toMatchObject({ error: expect.stringContaining("2 verdicts for candidate 3") });
  });

  it("a clip whose frames fail is skipped in the call; the others are still reviewed", async () => {
    const clips = [clip({ path: "/run/norm/1_bad.mp4" }), clip({ path: "/run/norm/1_ok.mp4" })];
    vi.mocked(extractFrames).mockImplementation(async (input) => {
      if (input.includes("bad")) throw new Error("No frames could be extracted");
      return [Buffer.from("ok")];
    });
    const { provider, calls } = fakeProvider({ verdicts: [verdict(1, 8)] });
    const scored = await scoreClipBatch(clips, scene, "/frames", undefined, "low", undefined, provider);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.images).toHaveLength(1);
    expect(scored[0]).toMatchObject({ error: "No frames could be extracted" });
    expect(scored[1]!.verdict?.score).toBe(8);
  });

  it("an LLM failure marks every clip of the batch, without throwing", async () => {
    const provider: LlmProvider = {
      name: "gemini", model: "fake",
      completeJson: async () => { throw new Error("boom\nstack"); },
      completeGroundedText: async () => { throw new Error("not used"); },
    };
    const scored = await scoreClipBatch([clip(), clip()], scene, "/frames", undefined, "low", undefined, provider);
    expect(scored.map((s) => s.error)).toEqual(["boom", "boom"]);
  });

  it("a batch of one uses the unchanged single-clip prompt and schema", async () => {
    const one = clip({ path: "/run/norm/1_0.jpg", kind: "image", durationSeconds: 0 });
    const { provider, calls } = fakeProvider({ score: 6, matches: true, reason: "r", hasTextOrLogo: false, hasIdentifiablePeople: false });
    const scored = await scoreClipBatch([one], scene, "/frames", script.title, "low", script.hook, provider);
    expect(calls[0]!.prompt).toBe(buildRelevancePrompt(scene, 1, script.title, "image", script.hook));
    expect(calls[0]!.prompt).not.toContain("Candidate");
    expect(scored[0]!.verdict?.score).toBe(6);
  });
});

describe("batch prompt", () => {
  it("carries the same rules and context as the single-clip prompt, per beat too", () => {
    const beat = script.scenes[0]!.beats![1]!;
    const single = buildRelevancePrompt(script.scenes[0]!, 3, script.title, "video", script.hook, beat);
    const batch = buildRelevanceBatchPrompt(script.scenes[0]!, [{ kind: "video", frameCount: 3 }, { kind: "image", frameCount: 1 }], script.title, script.hook, beat);
    for (const rule of ["wrongEraOrPlace", "not a burger with ketchup", "blurry, pixelated", "showsFace", "NASA logo"]) {
      expect(single).toContain(rule);
      expect(batch).toContain(rule);
    }
    expect(batch).toContain('WHAT IS BEING SAID while this footage is on screen (pt-BR): "invadiu a fortaleza"');
    expect(batch).toContain(`Opening line of the video (pt-BR): "${script.hook}"`);
    expect(batch).toContain("exactly one entry per candidate (2 entries");
  });
});

describe("planBatches", () => {
  const key = (c: FootageClip): string => reviewContextKey(script, c, new Map());

  it("never mixes scenes or beats and respects batchSize", () => {
    const count = script.scenes.length;
    const clips = [
      clip({ sceneIndex: 0, beatIndex: 0 }), clip({ sceneIndex: 1 }), clip({ sceneIndex: 0, beatIndex: 0 }),
      clip({ sceneIndex: 0, beatIndex: 1 }), clip({ sceneIndex: 1 }), clip({ sceneIndex: 1 }), clip({ sceneIndex: 0, beatIndex: 0 }),
    ];
    expect(planBatches(clips, key, 2)).toEqual([[0, 2], [6], [1, 4], [5], [3]]);
    expect(encodeBeatSlot(0, 1, count)).toBeGreaterThan(count); // beat clips arrive decoded, see lib/beats.ts
  });

  it("hook clips and retry clips of a scene are reviewed against a different query, so they form their own batches", () => {
    const clips = [clip({ sceneIndex: 0, path: "/n/0_0.mp4" }), clip({ sceneIndex: 0, path: "/n/0_h0.mp4" }), clip({ sceneIndex: 1, path: "/n/1_0.mp4" }), clip({ sceneIndex: 1, path: "/n/1_r0.mp4" })];
    const alts = new Map([[1, ["prison door"]]]);
    const k = (c: FootageClip): string => reviewContextKey(script, c, alts);
    expect(planBatches(clips, k, 4)).toEqual([[0], [1], [2], [3]]);
  });

  it("splits a batch that would exceed the frame cap", () => {
    const videos = Array.from({ length: 6 }, () => clip());
    expect(planBatches(videos, key, 6)).toEqual([[0, 1, 2, 3], [4, 5]]); // 4 videos x 3 frames = 12
    const stills = Array.from({ length: 6 }, () => clip({ kind: "image", durationSeconds: 0 }));
    expect(planBatches(stills, key, 6)).toEqual([[0, 1, 2, 3, 4, 5]]);
    expect(MAX_IMAGES_PER_CALL).toBe(12);
  });

  it("batchSize 1 (the default) is one clip per call, in input order", () => {
    expect(resolveRelevanceSettings(undefined).batchSize).toBe(1);
    expect(resolveRelevanceSettings({ relevance: { batchSize: 4 } }).batchSize).toBe(4);
    expect(planBatches([clip(), clip(), clip()], key, 1)).toEqual([[0], [1], [2]]);
  });
});
