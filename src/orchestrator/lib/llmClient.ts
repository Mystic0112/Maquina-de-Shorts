import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { GoogleGenAI, ThinkingLevel, type ThinkingConfig } from "@google/genai";
import { z } from "zod";
import type { LlmUsage, LlmUsageByModel, LlmUsageTotals, StageName } from "../types.js";
import { env, paths } from "./config.js";
import { AntigravityCliProvider } from "./antigravityCli.js";

// Re-exported so existing imports keep working after the move to antigravityCli.ts.
export { AntigravityCliProvider, DEFAULT_ANTIGRAVITY_MODEL, DEFAULT_ANTIGRAVITY_CLI_PATH } from "./antigravityCli.js";

export type LlmProviderName = "gemini" | "anthropic" | "antigravity-cli";

export const DEFAULT_GEMINI_MODEL = "gemini-flash-latest";
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";

export interface LlmImage {
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  data: Buffer;
}

/**
 * Reasoning effort for one call. "default" leaves the model's own default; the levels map to Gemini
 * thinkingLevel (Anthropic: ignored, extended thinking is off unless requested).
 */
export type ThinkingSetting = "default" | "minimal" | "low" | "medium" | "high";

export interface CallOptions {
  thinking?: ThinkingSetting;
  temperature?: number;
  /** Model for this call only (per-stage routing, see config `llm.models`); overrides the provider's default. */
  model?: string;
}

export interface WebSource {
  /** Page (or provider redirect) URL. Gemini returns vertexaisearch redirect links that expire. */
  uri: string;
  /** Page title; for Gemini grounding this is usually the domain (e.g. "nasa.gov"). */
  title?: string;
}

/** Free text written with live web search, plus the sources the provider attached to it. */
export interface GroundedText {
  text: string;
  sources: WebSource[];
  /** Search queries the model issued (when the provider reports them). */
  queries: string[];
}

/** A provider turns a prompt (+ optional images) and a target schema into raw JSON text. */
export interface LlmProvider {
  readonly name: LlmProviderName;
  readonly model: string;
  completeJson(prompt: string, schema: z.ZodType, images?: readonly LlmImage[], options?: CallOptions): Promise<string>;
  /**
   * Free-text answer grounded on web search. Separate from completeJson because Gemini silently skips
   * the search when a JSON response schema is also requested.
   */
  completeGroundedText(prompt: string, options?: CallOptions): Promise<GroundedText>;
}

export interface GenerateJsonOptions extends CallOptions {
  provider?: LlmProvider;
  /** Extra attempts after the first when the output fails JSON/zod validation. Default 1. */
  retries?: number;
  /** Extra attempts after rate-limit (429/RESOURCE_EXHAUSTED) errors, on top of SDK retries. Default 4. */
  rateLimitRetries?: number;
}

// ---------------------------------------------------------------------------------------------
// Rate-limit backoff
// ---------------------------------------------------------------------------------------------

export function isRateLimitError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const status = (error as { status?: unknown }).status;
  if (status === 429) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b|RESOURCE_EXHAUSTED|rate.?limit|quota/i.test(message);
}

/** Exponential backoff with full jitter: random in [base*2^n / 2, base*2^n], capped. */
export function backoffDelayMs(retry: number, baseMs = 4000, capMs = 60_000, random: () => number = Math.random): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** retry);
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Retries `fn` on rate-limit errors with jittered backoff; other errors propagate immediately. */
export async function withRateLimitRetry<T>(fn: () => Promise<T>, retries = 4, delay = backoffDelayMs): Promise<T> {
  for (let retry = 0; ; retry++) {
    try {
      return await fn();
    } catch (error) {
      if (!isRateLimitError(error) || retry >= retries) throw error;
      await sleep(delay(retry));
    }
  }
}

export class LlmOutputError extends Error {}

// ---------------------------------------------------------------------------------------------
// Usage accounting: providers record every response; the orchestrator drains per stage.
// ---------------------------------------------------------------------------------------------

export interface LlmCallUsage {
  provider: LlmProviderName;
  model: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  /** True for calls with web search/grounding enabled (billed separately by the providers). */
  grounded?: boolean;
}

const pendingUsage: LlmCallUsage[] = [];

export function recordLlmUsage(usage: LlmCallUsage): void {
  pendingUsage.push(usage);
}

/** Returns (and clears) the usage recorded since the previous drain. */
export function drainLlmUsage(): LlmCallUsage[] {
  return pendingUsage.splice(0, pendingUsage.length);
}

function addTotals<T extends LlmUsageTotals>(target: T, call: LlmCallUsage): T {
  const thinking = (target.thinkingTokens ?? 0) + (call.thinkingTokens ?? 0);
  const grounded = (target.groundedCalls ?? 0) + (call.grounded ? 1 : 0);
  return {
    ...target,
    calls: target.calls + 1,
    inputTokens: target.inputTokens + call.inputTokens,
    outputTokens: target.outputTokens + call.outputTokens,
    ...(thinking > 0 ? { thinkingTokens: thinking } : {}),
    ...(grounded > 0 ? { groundedCalls: grounded } : {}),
  };
}

/** Pure: folds a stage's calls into the run's usage summary (total, per model, per stage). */
export function mergeLlmUsage(current: LlmUsage | undefined, stage: StageName, calls: readonly LlmCallUsage[]): LlmUsage | undefined {
  if (calls.length === 0) return current;
  const empty: LlmUsageTotals = { calls: 0, inputTokens: 0, outputTokens: 0 };
  let usage: LlmUsage = current ?? { ...empty, byModel: [], byStage: {} };
  for (const call of calls) {
    const byModel = [...usage.byModel];
    const i = byModel.findIndex((m) => m.provider === call.provider && m.model === call.model);
    const base: LlmUsageByModel = byModel[i] ?? { provider: call.provider, model: call.model, ...empty };
    if (i >= 0) byModel[i] = addTotals(base, call);
    else byModel.push(addTotals(base, call));
    usage = {
      ...addTotals(usage, call),
      byModel,
      byStage: { ...usage.byStage, [stage]: addTotals(usage.byStage[stage] ?? empty, call) },
    };
  }
  return usage;
}

export async function generateJson<T>(
  prompt: string,
  schema: z.ZodType<T>,
  options: GenerateJsonOptions = {},
): Promise<T> {
  return generateJsonWithImages(prompt, [], schema, options);
}

/** Web-search-grounded free text (no JSON schema: see LlmProvider.completeGroundedText). */
export async function generateGroundedText(
  prompt: string,
  options: CallOptions & { provider?: LlmProvider; rateLimitRetries?: number } = {},
): Promise<GroundedText> {
  const provider = options.provider ?? getDefaultProvider();
  const callOptions: CallOptions = { thinking: options.thinking, temperature: options.temperature, model: options.model };
  const result = await withRateLimitRetry(
    () => provider.completeGroundedText(prompt, callOptions),
    options.rateLimitRetries ?? 4,
  );
  if (!result.text.trim()) throw new LlmOutputError(`${provider.name}/${provider.model} returned an empty grounded answer`);
  return { ...result, sources: dedupeSources(result.sources), queries: [...new Set(result.queries)] };
}

export function dedupeSources(sources: readonly WebSource[]): WebSource[] {
  const seen = new Set<string>();
  return sources.filter((s) => (seen.has(s.uri) ? false : (seen.add(s.uri), true)));
}

/** Same as generateJson, with images sent alongside the prompt in a single request. */
export async function generateJsonWithImages<T>(
  prompt: string,
  images: readonly LlmImage[],
  schema: z.ZodType<T>,
  options: GenerateJsonOptions = {},
): Promise<T> {
  const provider = options.provider ?? getDefaultProvider();
  const maxAttempts = 1 + (options.retries ?? 1);
  let currentPrompt = prompt;
  let lastError = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const callOptions: CallOptions = { thinking: options.thinking, temperature: options.temperature, model: options.model };
    const promptForAttempt = currentPrompt;
    const text = await withRateLimitRetry(
      () => provider.completeJson(promptForAttempt, schema, images, callOptions),
      options.rateLimitRetries ?? 4,
    );
    const result = validateJsonText(text, schema);
    if (result.ok) return result.value;
    lastError = result.error;
    currentPrompt = withCorrection(prompt, text, result.error);
  }
  throw new LlmOutputError(
    `${provider.name}/${provider.model} returned invalid JSON after ${maxAttempts} attempt(s):\n${lastError}`,
  );
}

type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function validateJsonText<T>(text: string, schema: z.ZodType<T>): ValidationResult<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(text));
  } catch (error) {
    return { ok: false, error: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const result = schema.safeParse(parsed);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: z.prettifyError(result.error) };
}

/** Appends the previous answer and its problems so the model can fix them on the next attempt. */
export function withCorrection(prompt: string, previousAnswer: string, problems: string): string {
  return [
    prompt,
    "",
    "---",
    "Sua resposta anterior foi rejeitada pela validação automática.",
    `Resposta anterior:\n${previousAnswer.slice(0, 6000)}`,
    `Problemas encontrados:\n${problems}`,
    "Gere novamente o JSON completo, corrigindo todos os problemas. Responda somente com o JSON.",
  ].join("\n");
}

function stripCodeFence(text: string): string {
  const match = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text);
  return match?.[1] ?? text.trim();
}

let defaultProvider: LlmProvider | undefined;
const providerCache = new Map<string, LlmProvider>();

/** Env-configured provider, created once so SDK clients (and their connection pools) are reused. */
export function getDefaultProvider(): LlmProvider {
  defaultProvider ??= createProviderFromEnv();
  return defaultProvider;
}

export function getProviderByName(name: LlmProviderName): LlmProvider {
  const cached = providerCache.get(name);
  if (cached) return cached;
  let provider: LlmProvider;
  if (name === "gemini") {
    provider = new GeminiProvider(requireKey("GEMINI_API_KEY"), env("GEMINI_MODEL") ?? DEFAULT_GEMINI_MODEL);
  } else if (name === "anthropic") {
    provider = new AnthropicProvider(requireKey("ANTHROPIC_API_KEY"), env("ANTHROPIC_MODEL") ?? DEFAULT_ANTHROPIC_MODEL);
  } else if (name === "antigravity-cli") {
    provider = new AntigravityCliProvider(env("ANTIGRAVITY_CLI_PATH"), env("ANTIGRAVITY_MODEL"));
  } else {
    throw new Error(`Unknown LLM provider "${name}". Use "gemini", "anthropic" or "antigravity-cli".`);
  }
  providerCache.set(name, provider);
  return provider;
}

export function createProviderFromEnv(): LlmProvider {
  const name = (env("LLM_PROVIDER") ?? "gemini").toLowerCase() as LlmProviderName;
  return getProviderByName(name);
}

function requireKey(name: string): string {
  const key = env(name);
  if (!key) {
    throw new Error(
      `${name} is not set. Set ${name} in .env at ${paths.fromRoot(".env")} (copy .env.example) ` +
        `or choose another provider with LLM_PROVIDER=gemini|anthropic.`,
    );
  }
  return key;
}

class GeminiProvider implements LlmProvider {
  readonly name = "gemini" as const;
  private readonly client: GoogleGenAI;

  constructor(apiKey: string, readonly model: string) {
    // SDK-level retries with backoff on 408/429/5xx.
    this.client = new GoogleGenAI({ apiKey, httpOptions: { timeout: 120_000, retryOptions: { attempts: 4 } } });
  }

  /** Sends the request at the requested level, stepping up (minimal -> low -> ... -> default) on rejection. */
  private generateWithThinking<T>(model: string, requested: ThinkingSetting, send: (cfg: ThinkingConfig | undefined) => Promise<T>): Promise<T> {
    return thinkingLevels.run(model, requested, (level) => send(toGeminiThinking(level)));
  }

  async completeJson(
    prompt: string,
    schema: z.ZodType,
    images: readonly LlmImage[] = [],
    options: CallOptions = {},
  ): Promise<string> {
    const parts = [
      { text: prompt },
      ...images.map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.data.toString("base64") } })),
    ];
    const thinkingSetting = options.thinking ?? "default";
    // options.model is taken as-is: it must be a Gemini API model id, not an agy alias.
    const model = options.model ?? this.model;
    const request = (thinkingConfig: ThinkingConfig | undefined) =>
      this.client.models.generateContent({
        model,
        contents: [{ role: "user", parts }],
        config: {
          responseMimeType: "application/json",
          responseJsonSchema: toGeminiJsonSchema(schema),
          temperature: options.temperature ?? 0.9,
          ...(thinkingConfig ? { thinkingConfig } : {}),
        },
      });
    const response = await this.generateWithThinking(model, thinkingSetting, request);
    const meta = response.usageMetadata;
    const thinking = meta?.thoughtsTokenCount ?? 0;
    recordLlmUsage({
      provider: this.name,
      model: response.modelVersion ?? model,
      inputTokens: (meta?.promptTokenCount ?? 0) + (meta?.toolUsePromptTokenCount ?? 0),
      outputTokens: (meta?.candidatesTokenCount ?? 0) + thinking,
      ...(thinking > 0 ? { thinkingTokens: thinking } : {}),
    });
    const text = response.text;
    if (!text) {
      const reason = response.candidates?.[0]?.finishReason ?? response.promptFeedback?.blockReason ?? "unknown";
      throw new LlmOutputError(`Gemini returned no text (reason: ${reason})`);
    }
    return text;
  }

  async completeGroundedText(prompt: string, options: CallOptions = {}): Promise<GroundedText> {
    const thinkingSetting = options.thinking ?? "default";
    const model = options.model ?? this.model;
    const request = (thinkingConfig: ThinkingConfig | undefined) =>
      this.client.models.generateContent({
        model,
        contents: prompt,
        config: {
          tools: [{ googleSearch: {} }],
          temperature: options.temperature ?? 0.2,
          ...(thinkingConfig ? { thinkingConfig } : {}),
        },
      });
    const response = await this.generateWithThinking(model, thinkingSetting, request);
    const meta = response.usageMetadata;
    const thinking = meta?.thoughtsTokenCount ?? 0;
    recordLlmUsage({
      provider: this.name,
      model: response.modelVersion ?? model,
      inputTokens: (meta?.promptTokenCount ?? 0) + (meta?.toolUsePromptTokenCount ?? 0),
      outputTokens: (meta?.candidatesTokenCount ?? 0) + thinking,
      ...(thinking > 0 ? { thinkingTokens: thinking } : {}),
      grounded: true,
    });
    const grounding = response.candidates?.[0]?.groundingMetadata;
    const sources = (grounding?.groundingChunks ?? []).flatMap((chunk) =>
      chunk.web?.uri ? [{ uri: chunk.web.uri, ...(chunk.web.title ? { title: chunk.web.title } : {}) }] : [],
    );
    return { text: response.text ?? "", sources, queries: grounding?.webSearchQueries ?? [] };
  }
}

class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic" as const;
  private readonly client: Anthropic;

  constructor(apiKey: string, readonly model: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 3 });
  }

  async completeJson(prompt: string, schema: z.ZodType, images: readonly LlmImage[] = [], options: CallOptions = {}): Promise<string> {
    const content: Anthropic.ContentBlockParam[] = [
      ...images.map(
        (img): Anthropic.ImageBlockParam => ({
          type: "image",
          source: { type: "base64", media_type: img.mimeType, data: img.data.toString("base64") },
        }),
      ),
      { type: "text", text: prompt },
    ];
    const message = await this.client.messages.create({
      // options.model must be an Anthropic API model id (agy aliases like "claude-sonnet-5-5-low" are not).
      model: options.model ?? this.model,
      max_tokens: 4096,
      messages: [{ role: "user", content }],
      output_config: { format: zodOutputFormat(schema) },
    });
    const u = message.usage;
    recordLlmUsage({
      provider: this.name,
      model: message.model,
      inputTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      outputTokens: u.output_tokens,
    });
    if (message.stop_reason === "refusal" || message.stop_reason === "max_tokens") {
      throw new LlmOutputError(`Anthropic stopped with "${message.stop_reason}"`);
    }
    return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  }

  /** Claude's server-side web search tool; sources come from its web_search_tool_result blocks. */
  async completeGroundedText(prompt: string, options: CallOptions = {}): Promise<GroundedText> {
    const message = await this.client.messages.create({
      model: options.model ?? this.model,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 8 }],
    });
    const u = message.usage;
    recordLlmUsage({
      provider: this.name,
      model: message.model,
      inputTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      outputTokens: u.output_tokens,
      grounded: true,
    });
    const sources: WebSource[] = [];
    const queries: string[] = [];
    for (const block of message.content) {
      if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
        for (const r of block.content) sources.push({ uri: r.url, title: r.title });
      } else if (block.type === "server_tool_use" && block.name === "web_search") {
        const query = (block.input as { query?: unknown }).query;
        if (typeof query === "string") queries.push(query);
      }
    }
    const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    return { text, sources, queries };
  }
}

const GEMINI_THINKING_LEVELS: Record<Exclude<ThinkingSetting, "default">, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

const THINKING_ORDER: readonly ThinkingSetting[] = ["minimal", "low", "medium", "high"];

/**
 * In-process cache of the thinking level each model accepts for each requested level. The first call
 * for a (model, level) pair probes up the fallback chain while concurrent callers wait for it, so a
 * rejected level costs at most one 400 per process (= per pipeline run).
 */
export class ThinkingLevelCache {
  private readonly accepted = new Map<string, ThinkingSetting>();
  private readonly probes = new Map<string, Promise<ThinkingSetting>>();

  constructor(private readonly onFallback: (model: string, rejected: ThinkingSetting) => void = () => undefined) {}

  acceptedLevel(model: string, requested: ThinkingSetting): ThinkingSetting | undefined {
    return this.accepted.get(`${model}|${requested}`);
  }

  async run<T>(model: string, requested: ThinkingSetting, send: (level: ThinkingSetting) => Promise<T>): Promise<T> {
    const key = `${model}|${requested}`;
    const known = this.accepted.get(key);
    if (known) return send(known);
    const inFlight = this.probes.get(key);
    if (inFlight) {
      const level = await inFlight.catch(() => undefined);
      return level ? send(level) : this.run(model, requested, send); // probe failed: probe again ourselves
    }
    let settle: (level: ThinkingSetting) => void = () => undefined;
    let fail: (error: unknown) => void = () => undefined;
    this.probes.set(key, new Promise<ThinkingSetting>((res, rej) => ((settle = res), (fail = rej))));
    try {
      const { result, level } = await this.probe(model, requested, send);
      this.accepted.set(key, level);
      settle(level);
      return result;
    } catch (error) {
      fail(error); // waiters retry on their own; the next caller probes again
      throw error;
    } finally {
      this.probes.delete(key);
    }
  }

  private async probe<T>(
    model: string,
    requested: ThinkingSetting,
    send: (level: ThinkingSetting) => Promise<T>,
  ): Promise<{ result: T; level: ThinkingSetting }> {
    for (const level of thinkingFallbackChain(requested)) {
      try {
        return { result: await send(level), level };
      } catch (error) {
        if (level === "default" || !isThinkingRejection(error)) throw error;
        this.onFallback(model, level);
      }
    }
    throw new Error("unreachable: thinking fallback chain ends with default");
  }
}

const thinkingLevels = new ThinkingLevelCache((model, level) =>
  console.warn(`[llm] ${model} rejected thinking level "${level}"; using the next level up`),
);

/** Requested level first, then progressively higher levels, finally the model default. */
export function thinkingFallbackChain(requested: ThinkingSetting): ThinkingSetting[] {
  const start = THINKING_ORDER.indexOf(requested);
  return start < 0 ? ["default"] : [...THINKING_ORDER.slice(start), "default"];
}

export function toGeminiThinking(setting: ThinkingSetting): ThinkingConfig | undefined {
  return setting === "default" ? undefined : { thinkingLevel: GEMINI_THINKING_LEVELS[setting] };
}

/** 400 caused by an unsupported thinking level/config for this model. */
function isThinkingRejection(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  const message = error instanceof Error ? error.message : String(error);
  return (status === 400 || /\b400\b|INVALID_ARGUMENT/.test(message)) && /thinking/i.test(message);
}

/** JSON Schema keywords Gemini's responseJsonSchema accepts (per @google/genai docs); others are dropped. */
const GEMINI_SCHEMA_KEYS = new Set([
  "$id", "$defs", "$ref", "$anchor", "type", "format", "title", "description", "enum", "items",
  "prefixItems", "minItems", "maxItems", "minimum", "maximum", "anyOf", "oneOf", "properties",
  "additionalProperties", "required", "propertyOrdering",
]);

export function toGeminiJsonSchema(schema: z.ZodType): unknown {
  return sanitizeSchemaNode(z.toJSONSchema(schema, { io: "output" }));
}

function sanitizeSchemaNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeSchemaNode);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue;
    out[key] = key === "properties" || key === "$defs" ? mapValues(value, sanitizeSchemaNode) : sanitizeSchemaNode(value);
  }
  return out;
}

function mapValues(value: unknown, fn: (v: unknown) => unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fn(v)]));
}
