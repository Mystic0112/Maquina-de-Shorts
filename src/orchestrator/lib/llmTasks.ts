/**
 * Provider + model per task (config `llm.tasks`, see src/shared/settings.ts LLM_TASKS), several providers at once.
 *
 * Resolution (pure, `resolveTaskSettings`):
 *  - provider = tasks.<t>.provider, else (relevance only) footage.relevance.provider, else the machine's
 *    (LLM_PROVIDER). Nothing set = exactly the behaviour before this existed.
 *  - model = tasks.<t>.model; when the task has no provider of its own the legacy `llm.models.<t>` still applies;
 *    when it has one the legacy model is ignored (it is a model of ANOTHER provider).
 *  - fallback = tasks.<t>.fallback, tried once when the provider call fails or its quota ends. A fallback to a PAID
 *    provider (gemini/anthropic by API key) is dropped unless the owner set `allowPaid` on that very task.
 *
 * Callers spread `taskCallOptions("<task>")` into the options of generateJson / generateJsonWithImages /
 * generateGroundedText; with no configuration it returns `{}` (or just the legacy model), so the default
 * provider is used as always.
 */
import { isPaidLlmProvider, LLM_TASKS, type LlmProviderName, type LlmTaskName } from "../../shared/settings.js";
import type { z } from "zod";
import { loadConfig, type PipelineConfig } from "./config.js";
import {
  getDefaultProvider,
  getProviderByName,
  isQuotaExhaustedError,
  type CallOptions,
  type GroundedText,
  type LlmImage,
  type LlmProvider,
  type ThinkingSetting,
} from "./llmClient.js";

export interface ResolvedTask {
  /** Undefined = the machine's provider. */
  provider?: LlmProviderName;
  model?: string;
  thinking?: ThinkingSetting;
  fallback?: { provider: LlmProviderName; model?: string };
  /** Things the owner configured that are being ignored (e.g. a paid fallback without `allowPaid`). */
  warnings: string[];
}

export function resolveTaskSettings(task: LlmTaskName, config: Pick<PipelineConfig, "llm" | "footage">): ResolvedTask {
  const s = config.llm?.tasks?.[task];
  const def: { label: string; legacyModel?: keyof NonNullable<NonNullable<PipelineConfig["llm"]>["models"]> } = LLM_TASKS[task];
  const legacyProvider = task === "relevance" ? config.footage?.relevance?.provider : undefined;
  const provider = s?.provider ?? legacyProvider;
  const legacyModel = def.legacyModel ? config.llm?.models?.[def.legacyModel] : undefined;
  const model = s?.provider ? s.model : (s?.model ?? legacyModel);
  const warnings: string[] = [];
  let fallback: ResolvedTask["fallback"];
  const fb = s?.fallback;
  if (fb) {
    if (isPaidLlmProvider(fb.provider, config.llm) && !fb.allowPaid) {
      warnings.push(`alternativa "${fb.provider}" ignorada: é API paga e "allowPaid" não está ligado nesta tarefa`);
    } else {
      fallback = { provider: fb.provider, ...(fb.model ? { model: fb.model } : {}) };
    }
  }
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(s?.thinking ? { thinking: s.thinking } : {}),
    ...(fallback ? { fallback } : {}),
    warnings,
  };
}

/** Provider + model of one task, ready to spread into the options of a generate* call. Absent keys = defaults. */
export interface TaskCallOptions {
  provider?: LlmProvider;
  model?: string;
  thinking?: ThinkingSetting;
}

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

export function taskCallOptions(task: LlmTaskName, config: Pick<PipelineConfig, "llm" | "footage"> = loadConfig()): TaskCallOptions {
  const r = resolveTaskSettings(task, config);
  for (const w of r.warnings) warnOnce(`[llm] ${task}: ${w}`);
  const primary = (): LlmProvider => (r.provider ? getProviderByName(r.provider) : getDefaultProvider());
  const fb = r.fallback;
  // Lazy on purpose: a primary whose key is missing must still be able to fall back.
  const provider = fb
    ? new FallbackProvider(task, primary, () => getProviderByName(fb.provider), fb.model, warnOnce)
    : r.provider
      ? getProviderByName(r.provider)
      : undefined;
  return { ...(provider ? { provider } : {}), ...(r.model ? { model: r.model } : {}), ...(r.thinking ? { thinking: r.thinking } : {}) };
}

/**
 * Primary provider with one alternative. Falls back on ANY error thrown by the provider call (failure, timeout,
 * quota/credits gone): rate-limit retries then belong to the alternative, not to the exhausted primary. Output that
 * merely fails validation is not a provider failure and does not fall back. The alternative gets its own model
 * (the primary's model id means nothing to another provider).
 */
export class FallbackProvider implements LlmProvider {
  constructor(
    private readonly task: string,
    private readonly primary: () => LlmProvider,
    private readonly alternative: () => LlmProvider,
    private readonly alternativeModel: string | undefined,
    private readonly warn: (message: string) => void = warnOnce,
  ) {}

  get name(): LlmProviderName {
    return this.describe().name;
  }

  get model(): string {
    return this.describe().model;
  }

  /** Names for error messages and the verdict log: the primary's, or the alternative's when the primary cannot even be built. */
  private describe(): { name: LlmProviderName; model: string } {
    for (const make of [this.primary, this.alternative]) {
      try {
        const p = make();
        return { name: p.name, model: p.model };
      } catch {
        // ponytail: unbuildable provider (no key): try the next one; the call itself reports the real error.
      }
    }
    return { name: "antigravity-cli", model: "" };
  }

  private async withFallback<T>(call: (provider: LlmProvider, model: string | undefined) => Promise<T>, options: CallOptions): Promise<T> {
    try {
      return await call(this.primary(), options.model);
    } catch (error) {
      const alternative = this.alternative();
      const why = isQuotaExhaustedError(error) ? "cota esgotada" : "falha";
      const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
      this.warn(`[llm] ${this.task}: ${why} no provedor principal (${detail.slice(0, 160)}); usando a alternativa ${alternative.name}`);
      return await call(alternative, this.alternativeModel);
    }
  }

  completeJson(prompt: string, schema: z.ZodType, images: readonly LlmImage[] = [], options: CallOptions = {}): Promise<string> {
    return this.withFallback((p, model) => p.completeJson(prompt, schema, images, { ...options, model }), options);
  }

  completeGroundedText(prompt: string, options: CallOptions = {}): Promise<GroundedText> {
    return this.withFallback((p, model) => p.completeGroundedText(prompt, { ...options, model }), options);
  }
}
