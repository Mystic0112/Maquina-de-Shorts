import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("../../src/orchestrator/lib/llmClient.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/orchestrator/lib/llmClient.js")>();
  return { ...original, generateJson: vi.fn(), generateGroundedText: vi.fn() };
});
vi.mock("../../src/orchestrator/lib/config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/orchestrator/lib/config.js")>();
  return { ...original, loadConfig: vi.fn() };
});
vi.mock("../../src/orchestrator/lib/logger.js", () => {
  const noop = () => undefined;
  return { getLogger: () => ({ info: noop, warn: noop, error: noop, debug: noop }) };
});
vi.mock("../../src/orchestrator/lib/ffmpeg.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/orchestrator/lib/ffmpeg.js")>();
  return { ...original, extractFrames: vi.fn(async () => [Buffer.from("frame")]) };
});

import { loadConfig, PipelineConfigSchema, type PipelineConfig } from "../../src/orchestrator/lib/config.js";
import { generateGroundedText, generateJson, mergeLlmUsage, type LlmProvider } from "../../src/orchestrator/lib/llmClient.js";
import { resolveRelevanceSettings, scoreClipBatch } from "../../src/orchestrator/lib/relevance.js";
import { run as generateScript } from "../../src/orchestrator/stages/02-generateScript.js";
import { defaultFactCheckDeps } from "../../src/orchestrator/stages/02b-factCheck.js";
import { run as generateMetadata } from "../../src/orchestrator/stages/07-generateMetadata.js";
import type { FootageClip, RunContext, Script } from "../../src/orchestrator/types.js";

const MODELS = { script: "gemini-4-argon-medium", factCheck: "claude-sonnet-5-5-medium", metadata: "gpt-oss-120b-medium", relevance: "gemini-3.8-flash-low" };

const config = {
  video: { width: 1080, height: 1920, fps: 30, minSeconds: 20, maxSeconds: 60 },
  voice: { engine: "gemini", name: "pt-BR-AntonioNeural", language: "pt-BR" },
  upload: { privacyStatus: "private", categoryId: "27", maxUploadsPerDay: 1 },
  llm: { models: MODELS },
} as unknown as PipelineConfig;

const words = (n: number): string => Array.from({ length: n }, () => "planeta").join(" ");
const llmScript = {
  title: "O planeta estranho",
  overlayText: "UM PLANETA ESTRANHO?",
  hook: "Existe um planeta estranho.",
  hookFootageQuery: "venus planet nasa",
  cta: "Siga para mais",
  scenes: Array.from({ length: 5 }, () => ({ narration: words(34), footageQuery: "venus planet nasa", beats: [{ phrase: "planeta", footageQuery: "venus planet nasa" }] })),
};
const script: Script = {
  title: llmScript.title, hook: llmScript.hook, cta: llmScript.cta, overlayText: llmScript.overlayText, language: "pt-BR",
  scenes: llmScript.scenes.map((s) => ({ narration: s.narration, footageQuery: s.footageQuery })),
} as Script;
const ctx: RunContext = { runId: "2026-01-01_00-00-00", runDir: "/tmp/run", createdAt: "2026-01-01T00:00:00Z", topic: { categoryId: "espaco", categoryLabel: "Espaço", seedPrompt: "x" }, script } as RunContext;

beforeEach(() => {
  vi.mocked(generateJson).mockReset();
  vi.mocked(generateGroundedText).mockReset();
  vi.mocked(loadConfig).mockReturnValue(config);
});

describe("config llm.models", () => {
  it("accepts per-stage model names and is optional", () => {
    expect(PipelineConfigSchema.shape.llm.safeParse(undefined).success).toBe(true);
    expect(PipelineConfigSchema.shape.llm.safeParse({ models: MODELS }).data).toEqual({ models: MODELS });
    expect(PipelineConfigSchema.shape.llm.safeParse({ models: { script: "" } }).success).toBe(false);
  });
});

describe("stages pass llm.models.<stage> as the call model", () => {
  it("02-generateScript: every script request carries llm.models.script", async () => {
    vi.mocked(generateJson).mockResolvedValue(llmScript);
    await generateScript(ctx).catch(() => undefined); // content rules may reject the fixture; the calls are what matter
    expect(vi.mocked(generateJson).mock.calls.length).toBeGreaterThan(0);
    for (const call of vi.mocked(generateJson).mock.calls) expect(call[2]).toMatchObject({ model: MODELS.script });
  });

  it("02b-factCheck: grounded and structured calls use llm.models.factCheck", async () => {
    vi.mocked(generateGroundedText).mockResolvedValue({ text: "ok", sources: [], queries: [] });
    vi.mocked(generateJson).mockResolvedValue({});
    const deps = defaultFactCheckDeps(MODELS.factCheck);
    await deps.grounded("p");
    await deps.structured("p", z.any());
    expect(vi.mocked(generateGroundedText).mock.calls[0]![1]).toMatchObject({ model: MODELS.factCheck, thinking: "low" });
    expect(vi.mocked(generateJson).mock.calls[0]![2]).toMatchObject({ model: MODELS.factCheck, thinking: "low" });
    expect(defaultFactCheckDeps()).toBeDefined();
  });

  it("07-generateMetadata: the draft call uses llm.models.metadata", async () => {
    vi.mocked(generateJson).mockResolvedValue({ context: [], hashtags: ["#planeta"], tags: ["a", "b", "c", "d", "e"] });
    await generateMetadata(ctx).catch(() => undefined);
    expect(vi.mocked(generateJson).mock.calls[0]![2]).toMatchObject({ model: MODELS.metadata, thinking: "low" });
  });

  it("relevance: resolveRelevanceSettings reads llm.models.relevance and scoreClipBatch forwards it", async () => {
    const settings = resolveRelevanceSettings(undefined, config.llm);
    expect(settings.model).toBe(MODELS.relevance);
    expect(resolveRelevanceSettings(undefined).model).toBeUndefined();

    const seen: Array<{ model?: string } | undefined> = [];
    const verdict = { score: 7, matches: true, reason: "r", hasTextOrLogo: false, hasIdentifiablePeople: false };
    const provider: LlmProvider = {
      name: "antigravity-cli", model: "default",
      async completeJson(_prompt, _schema, _images, options) {
        seen.push(options);
        return JSON.stringify(seen.length === 1 ? verdict : { verdicts: [{ ...verdict, candidate: 1 }, { ...verdict, candidate: 2 }] });
      },
      async completeGroundedText() { throw new Error("not used"); },
    };
    const clip = (path: string): FootageClip => ({ path, sceneIndex: 1, kind: "image", durationSeconds: 0, query: "q", source: "nasa", license: "public-domain" } as unknown as FootageClip);
    const scene = script.scenes[1]!;
    await scoreClipBatch([clip("/a.jpg")], scene, "/frames", undefined, "low", undefined, provider, undefined, settings.model);
    await scoreClipBatch([clip("/b.jpg"), clip("/c.jpg")], scene, "/frames", undefined, "low", undefined, provider, undefined, settings.model);
    expect(seen.map((o) => o?.model)).toEqual([MODELS.relevance, MODELS.relevance]);
  });
});

describe("usage accounting", () => {
  it("byModel keeps one entry per (provider, model) so per-stage models stay separate", () => {
    const usage = mergeLlmUsage(undefined, "02-generateScript", [
      { provider: "antigravity-cli", model: "gemini-4-argon-medium", inputTokens: 10, outputTokens: 1 },
      { provider: "antigravity-cli", model: "claude-sonnet-5-5-low", inputTokens: 20, outputTokens: 2 },
      { provider: "antigravity-cli", model: "gemini-4-argon-medium", inputTokens: 5, outputTokens: 1 },
    ]);
    expect(usage?.byModel).toEqual([
      { provider: "antigravity-cli", model: "gemini-4-argon-medium", calls: 2, inputTokens: 15, outputTokens: 2 },
      { provider: "antigravity-cli", model: "claude-sonnet-5-5-low", calls: 1, inputTokens: 20, outputTokens: 2 },
    ]);
  });
});
