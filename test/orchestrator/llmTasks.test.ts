import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { paths, PipelineConfigSchema, type PipelineConfig } from "../../src/orchestrator/lib/config.js";
import { generateGroundedText, generateJson, getProviderByName, isQuotaExhaustedError, type CallOptions, type LlmProvider } from "../../src/orchestrator/lib/llmClient.js";
import { FallbackProvider, resolveTaskSettings, taskCallOptions } from "../../src/orchestrator/lib/llmTasks.js";
import { resolveRelevanceSettings } from "../../src/orchestrator/lib/relevance.js";
import { LLM_TASK_NAMES, LlmSettingsSchema } from "../../src/shared/settings.js";

type Cfg = Pick<PipelineConfig, "llm" | "footage">;
const cfg = (llm?: unknown, footage?: unknown): Cfg => ({ llm: llm === undefined ? undefined : LlmSettingsSchema.parse(llm), footage } as Cfg);

afterEach(() => vi.unstubAllEnvs());

describe("old configs keep working", () => {
  it("the repository's current pipeline.config.json still parses and resolves every task to the machine defaults", () => {
    const raw: unknown = JSON.parse(readFileSync(join(paths.config, "pipeline.config.json"), "utf8"));
    const parsed = PipelineConfigSchema.parse(raw);
    for (const task of LLM_TASK_NAMES) {
      const r = resolveTaskSettings(task, parsed);
      expect(r.fallback).toBeUndefined();
      expect(r.warnings).toEqual([]);
    }
  });

  it("without llm.tasks: llm.models still sets the model (same provider as the machine) and relevance.provider still wins", () => {
    const old = cfg(
      { models: { script: "gemini-4-argon-medium", factCheck: "gemini-3.8-flash-medium", metadata: "m", relevance: "gemini-3.8-flash-low" } },
      { relevance: { provider: "gemini" } },
    );
    expect(resolveTaskSettings("script", old)).toEqual({ model: "gemini-4-argon-medium", warnings: [] });
    expect(resolveTaskSettings("factCheck", old).model).toBe("gemini-3.8-flash-medium");
    expect(resolveTaskSettings("terminal", old).model).toBe("m"); // terminal cards always used llm.models.metadata
    expect(resolveTaskSettings("relevance", old)).toEqual({ provider: "gemini", model: "gemini-3.8-flash-low", warnings: [] });
    expect(resolveTaskSettings("cutsSelect", old)).toEqual({ warnings: [] }); // never had a model setting
    expect(resolveRelevanceSettings(old.footage, old.llm)).toMatchObject({ provider: "gemini", model: "gemini-3.8-flash-low", thinking: "low" });
    expect(resolveRelevanceSettings(undefined, undefined)).toMatchObject({ provider: undefined, model: undefined });
  });

  it("no configuration: taskCallOptions adds nothing (the default provider is used, as before)", () => {
    expect(taskCallOptions("script", cfg())).toEqual({});
    expect(taskCallOptions("script", cfg({ models: {} }))).toEqual({});
    expect(taskCallOptions("factCheck", cfg({ models: { factCheck: "x" } }))).toEqual({ model: "x" });
  });
});

describe("provider and model per task", () => {
  const llm = {
    models: { script: "legacy-model" },
    tasks: {
      script: { provider: "antigravity-cli", model: "gemini-4-argon-medium", thinking: "high" },
      factCheck: { model: "only-a-model" },
      relevance: { provider: "gemini", model: "gemini-flash-latest", thinking: "minimal" },
    },
  };

  it("task settings win; with its own provider the legacy llm.models entry is ignored", () => {
    const c = cfg(llm, { relevance: { provider: "anthropic", thinking: "medium" } });
    expect(resolveTaskSettings("script", c)).toEqual({ provider: "antigravity-cli", model: "gemini-4-argon-medium", thinking: "high", warnings: [] });
    expect(resolveTaskSettings("factCheck", c)).toEqual({ model: "only-a-model", warnings: [] });
    // llm.tasks.relevance beats footage.relevance.provider/thinking
    expect(resolveTaskSettings("relevance", c)).toMatchObject({ provider: "gemini", model: "gemini-flash-latest", thinking: "minimal" });
    expect(resolveRelevanceSettings(c.footage, c.llm)).toMatchObject({ provider: "gemini", model: "gemini-flash-latest", thinking: "minimal" });
    // a task with a provider but no model does not inherit the legacy (other provider's) model
    const noModel = cfg({ models: { script: "legacy-model" }, tasks: { script: { provider: "gemini" } } });
    expect(resolveTaskSettings("script", noModel).model).toBeUndefined();
  });

  it("mixes providers: script on agy and fact check on Gemini at the same time", () => {
    vi.stubEnv("GEMINI_API_KEY", "AIzaFAKEfakefakefakefake"); // fake: nothing is sent, the client only needs a string
    const c = cfg({ tasks: { script: { provider: "antigravity-cli", model: "gemini-4-argon-medium" }, factCheck: { provider: "gemini", model: "gemini-flash-latest" } } });
    const script = taskCallOptions("script", c);
    const factCheck = taskCallOptions("factCheck", c);
    expect(script.provider?.name).toBe("antigravity-cli");
    expect(factCheck.provider?.name).toBe("gemini");
    expect([script.model, factCheck.model]).toEqual(["gemini-4-argon-medium", "gemini-flash-latest"]);
    expect(taskCallOptions("metadata", c)).toEqual({}); // untouched task: machine default
  });
});

describe("unknown provider and unknown task", () => {
  it("the schema rejects an unknown provider (task, fallback and relevance) and a mistyped task name", () => {
    expect(LlmSettingsSchema.safeParse({ tasks: { script: { provider: "openai" } } }).success).toBe(false);
    expect(LlmSettingsSchema.safeParse({ tasks: { script: { fallback: { provider: "openai" } } } }).success).toBe(false);
    expect(LlmSettingsSchema.safeParse({ tasks: { scritp: { provider: "gemini" } } }).success).toBe(false);
    expect(LlmSettingsSchema.safeParse({ tasks: { script: { model: "" } } }).success).toBe(false);
    expect(PipelineConfigSchema.shape.footage.safeParse({ relevance: { provider: "openai" } }).success).toBe(false);
  });

  it("the provider registry throws a clear error for a name that is not registered", () => {
    expect(() => getProviderByName("openai" as never)).toThrow(/Unknown LLM provider "openai".*antigravity-cli/);
    expect(() => getProviderByName("toString" as never)).toThrow(/Unknown LLM provider/);
  });
});

describe("fallback rules", () => {
  it("a free alternative is kept; a paid one is dropped unless allowPaid is on for that task", () => {
    const free = cfg({ tasks: { script: { fallback: { provider: "antigravity-cli", model: "gemini-3.8-flash-low" } } } });
    expect(resolveTaskSettings("script", free).fallback).toEqual({ provider: "antigravity-cli", model: "gemini-3.8-flash-low" });

    for (const provider of ["gemini", "anthropic"] as const) {
      const off = resolveTaskSettings("script", cfg({ tasks: { script: { provider: "antigravity-cli", fallback: { provider } } } }));
      expect(off.fallback).toBeUndefined();
      expect(off.warnings[0]).toMatch(new RegExp(`${provider}.*allowPaid`));
      const explicitlyOff = resolveTaskSettings("script", cfg({ tasks: { script: { fallback: { provider, allowPaid: false } } } }));
      expect(explicitlyOff.fallback).toBeUndefined();
      const on = resolveTaskSettings("script", cfg({ tasks: { script: { fallback: { provider, allowPaid: true, model: "m" } } } }));
      expect(on.fallback).toEqual({ provider, model: "m" });
      expect(on.warnings).toEqual([]);
    }
    // allowPaid is per task: another task with a paid fallback is still refused
    const two = cfg({ tasks: { script: { fallback: { provider: "gemini", allowPaid: true } }, factCheck: { fallback: { provider: "gemini" } } } });
    expect(resolveTaskSettings("script", two).fallback?.provider).toBe("gemini");
    expect(resolveTaskSettings("factCheck", two).fallback).toBeUndefined();
  });

  it("taskCallOptions wraps the provider only when a fallback survives (a refused paid fallback leaves the plain provider)", () => {
    vi.stubEnv("GEMINI_API_KEY", "AIzaFAKEfakefakefakefake");
    const refused = taskCallOptions("script", cfg({ tasks: { script: { provider: "antigravity-cli", fallback: { provider: "gemini" } } } }));
    expect(refused.provider).not.toBeInstanceOf(FallbackProvider);
    expect(refused.provider?.name).toBe("antigravity-cli");
    const allowed = taskCallOptions("script", cfg({ tasks: { script: { provider: "antigravity-cli", fallback: { provider: "gemini", allowPaid: true } } } }));
    expect(allowed.provider).toBeInstanceOf(FallbackProvider);
    expect(allowed.provider?.name).toBe("antigravity-cli");
  });

  it("detects exhausted quota with the existing rate-limit patterns plus the agy plan messages", () => {
    for (const m of ["HTTP 429", "RESOURCE_EXHAUSTED", "quota exceeded", "AI credits balance is too low to continue", "usage limit reached"]) {
      expect(isQuotaExhaustedError(new Error(m))).toBe(true);
    }
    expect(isQuotaExhaustedError(new Error("agy retornou resposta vazia"))).toBe(false);
  });
});

/** Scripted provider: records the options of every call and answers or throws as told. */
function fake(name: LlmProvider["name"], reply: string | Error): { provider: LlmProvider; calls: CallOptions[] } {
  const calls: CallOptions[] = [];
  const answer = (options?: CallOptions): string => {
    calls.push(options ?? {});
    if (reply instanceof Error) throw reply;
    return reply;
  };
  const provider: LlmProvider = {
    name,
    model: `${name}-default`,
    async completeJson(_p, _s, _i, options) {
      return answer(options);
    },
    async completeGroundedText(_p, options) {
      return { text: answer(options), sources: [], queries: [] };
    },
  };
  return { provider, calls };
}

describe("FallbackProvider", () => {
  const schema = z.object({ ok: z.boolean() });
  const make = (primary: () => LlmProvider, alternative: () => LlmProvider, model?: string) => {
    const warn = vi.fn();
    return { provider: new FallbackProvider("script", primary, alternative, model, warn), warn };
  };

  it("uses only the primary (with the task model) while it works", async () => {
    const p = fake("antigravity-cli", '{"ok":true}');
    const a = fake("gemini", '{"ok":false}');
    const { provider, warn } = make(() => p.provider, () => a.provider, "alt-model");
    await expect(generateJson("q", schema, { provider, model: "primary-model" })).resolves.toEqual({ ok: true });
    expect(p.calls).toMatchObject([{ model: "primary-model" }]);
    expect(a.calls).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back once when the quota ends, giving the alternative ITS model, not the primary's", async () => {
    const p = fake("antigravity-cli", new Error("agy retornou status ERROR: AI credits balance is too low"));
    const a = fake("antigravity-cli", '{"ok":true}');
    const { provider, warn } = make(() => p.provider, () => a.provider, "gemini-3.8-flash-low");
    await expect(generateJson("q", schema, { provider, model: "claude-x", retries: 0 })).resolves.toEqual({ ok: true });
    expect(p.calls).toHaveLength(1); // no backoff loop against an exhausted primary
    expect(a.calls).toMatchObject([{ model: "gemini-3.8-flash-low" }]);
    expect(warn.mock.calls[0]![0]).toMatch(/script: cota esgotada.*alternativa antigravity-cli/);

    const noModel = make(() => fake("antigravity-cli", new Error("boom")).provider, () => a.provider);
    await generateJson("q", schema, { provider: noModel.provider, model: "claude-x" });
    expect(a.calls.at(-1)?.model).toBeUndefined(); // alternative default model
    expect(noModel.warn.mock.calls[0]![0]).toMatch(/falha/);
  });

  it("falls back when the primary cannot even be built (missing key), and for grounded text too", async () => {
    const a = fake("antigravity-cli", "texto");
    const { provider } = make(() => { throw new Error("GEMINI_API_KEY is not set"); }, () => a.provider);
    await expect(generateGroundedText("q", { provider })).resolves.toMatchObject({ text: "texto" });
    expect(provider.name).toBe("antigravity-cli");
  });

  it("does not fall back on output that merely fails validation, and surfaces the alternative's error when both fail", async () => {
    const p = fake("antigravity-cli", "not json");
    const a = fake("gemini", '{"ok":true}');
    const { provider } = make(() => p.provider, () => a.provider);
    await expect(generateJson("q", schema, { provider, retries: 0 })).rejects.toThrow(/invalid JSON/);
    expect(a.calls).toEqual([]);

    const both = make(() => fake("antigravity-cli", new Error("primary down")).provider, () => fake("antigravity-cli", new Error("alternative down")).provider);
    await expect(generateJson("q", schema, { provider: both.provider })).rejects.toThrow(/alternative down/);
  });
});
