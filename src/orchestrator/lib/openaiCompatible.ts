/**
 * LLM provider for any server that speaks the OpenAI chat API: OpenAI/GPT, OpenRouter, Ollama, LM Studio and local
 * gateways (OmniRoute and similar are just "a generic OpenAI-compatible gateway", not a dependency). No SDK: plain
 * fetch to POST {baseUrl}/chat/completions.
 *
 * Config: `llm.openaiCompatible` { baseUrl, model } (not secrets, see src/shared/settings.ts) + the optional key
 * OPENAI_COMPAT_API_KEY (Ollama has none). The key travels ONLY in the Authorization header; it is never put in the URL,
 * the body, a log or an error message (every error text is scrubbed). A key is never sent over plain http to a host
 * outside this computer / local network, and redirects are not followed (they could carry it elsewhere).
 *
 * JSON output: first `response_format: json_schema` (strict). If the server refuses it (400/422) or ignores it (the
 * answer is not JSON), it steps down ONCE to "JSON described in the prompt" with `json_object`, and to no
 * response_format at all if the server refuses that too (LM Studio only accepts json_schema/text). The step is
 * remembered per model for the process. The caller's zod validation (generateJsonWithImages) always has the last word.
 *
 * Quota: HTTP 402, `insufficient_quota` and "exceeded your current quota"/"insufficient credits" messages become the
 * typed QuotaExhaustedError (lib/quota.ts) so the per-task fallback and the loop stop at once. A plain 429 is a
 * per-minute limit: Retry-After is honoured twice here, then the error (status 429) goes to withRateLimitRetry.
 *
 * Web search: this API has none. completeGroundedText throws SearchUnsupportedError (exported); callers that need
 * sources (the fact-check) must catch it and use another path or provider; it never returns text without sources.
 */
import { SearchUnsupportedError } from "./searchSupport.js";
import { z } from "zod";
import { isLocalBaseUrl, parseOpenAiBaseUrl, type OpenAiCompatibleSettings } from "../../shared/settings.js";
import { LlmOutputError, recordLlmUsage, type CallOptions, type GroundedText, type LlmImage, type LlmProvider } from "./llmClient.js";
import { QuotaExhaustedError } from "./quota.js";
import { redactSecrets, registerSecret, REDACTED } from "./redact.js";

const DEFAULT_TIMEOUT_MS = 180_000;
/** In-provider waits for a 429 that announces Retry-After; after these the error goes to withRateLimitRetry. */
const RETRY_AFTER_ATTEMPTS = 2;
const MAX_RETRY_AFTER_MS = 60_000;
/** A longer announced wait is not a rate limit any more: treat it as the quota being gone. */
const QUOTA_WAIT_MS = 10 * 60_000;
const ERROR_TEXT_CHARS = 400;

/** The model cannot read images (vision). Plain Error subclass so the per-task fallback treats it as a failure. */
export class VisionUnsupportedError extends Error {
  constructor(model: string) {
    super(
      `O modelo "${model}" não aceita imagem (visão). Escolha um modelo com visão para esta tarefa ` +
        "(por exemplo llava ou qwen2.5vl no Ollama, gpt-4o-mini na OpenAI) ou use outro provedor.",
    );
    this.name = "VisionUnsupportedError";
  }
}

/** HTTP failure; `status` makes isRateLimitError (llmClient.ts) recognise a 429. */
export class OpenAiHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OpenAiHttpError";
  }
}

type FormatMode = "schema" | "object" | "none";
const NEXT_MODE: Record<FormatMode, FormatMode | undefined> = { schema: "object", object: "none", none: undefined };

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  /** Optional: local servers have none. */
  apiKey?: string;
  /** Default model; `options.model` of a call (per-task) wins. */
  model?: string;
  timeoutMs?: number;
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name = "openai-compatible" as const;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  /** response_format step to start from, per model (lowered when the server refused or ignored a stricter one). */
  private readonly modes = new Map<string, FormatMode>();

  constructor(opts: OpenAiCompatibleOptions) {
    const url = parseOpenAiBaseUrl(opts.baseUrl);
    if (!url.ok) throw new Error(`openai-compatible: ${url.error}`);
    this.baseUrl = url.url;
    this.apiKey = opts.apiKey?.trim() || undefined;
    if (this.apiKey && !isLocalBaseUrl(this.baseUrl) && this.baseUrl.startsWith("http://")) {
      throw new Error("openai-compatible: a chave só pode ser enviada por https (ou para um servidor deste computador/rede local). Troque http:// por https:// na URL base.");
    }
    this.model = opts.model?.trim() ?? "";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    registerSecret(this.apiKey);
  }

  async completeJson(prompt: string, schema: z.ZodType, images: readonly LlmImage[] = [], options: CallOptions = {}): Promise<string> {
    const model = this.modelFor(options);
    const jsonSchema = z.toJSONSchema(schema, { io: "output" }) as Record<string, unknown>;
    delete jsonSchema["$schema"];
    let mode: FormatMode = this.modes.get(model) ?? "schema";
    let useTemperature = options.temperature !== undefined;
    for (;;) {
      const body = {
        model,
        messages: [{ role: "user", content: userContent(mode === "schema" ? prompt : promptWithSchema(prompt, jsonSchema), images) }],
        ...(useTemperature ? { temperature: options.temperature } : {}),
        ...(mode === "schema"
          ? { response_format: { type: "json_schema", json_schema: { name: "resposta", strict: true, schema: jsonSchema } } }
          : mode === "object"
            ? { response_format: { type: "json_object" } }
            : {}),
      };
      try {
        const content = await this.chat(body, model);
        // A server that ignores response_format answers in prose: step down once instead of burning a correction attempt.
        const next = NEXT_MODE[mode];
        if (next && !looksLikeJson(content)) {
          this.modes.set(model, next);
          mode = next;
          continue;
        }
        return content;
      } catch (error) {
        if (!(error instanceof OpenAiHttpError) || (error.status !== 400 && error.status !== 422)) throw error;
        if (images.length > 0 && IMAGE_REJECTION.test(error.message)) throw new VisionUnsupportedError(model);
        if (useTemperature && /temperature/i.test(error.message)) {
          useTemperature = false;
          continue;
        }
        const next = NEXT_MODE[mode];
        if (!next) throw error;
        this.modes.set(model, next);
        mode = next;
      }
    }
  }

  /** No web search in the OpenAI chat API: see the file header. */
  completeGroundedText(): Promise<GroundedText> {
    return Promise.reject(new SearchUnsupportedError(this.name));
  }

  private modelFor(options: CallOptions): string {
    const model = options.model?.trim() || this.model;
    if (!model) {
      throw new Error(
        "openai-compatible: nenhum modelo definido. Preencha o modelo em Configurações > IA por tarefa (por exemplo llama3.2 no Ollama) ou o modelo da tarefa.",
      );
    }
    return model;
  }

  /** One request (with the Retry-After waits); returns the answer text. HTTP failures become typed errors. */
  private async chat(body: unknown, model: string): Promise<string> {
    for (let waited = 0; ; waited++) {
      const response = await this.post(body);
      if (response.ok) return this.readAnswer(await response.json().catch(() => undefined), model);
      const text = await response.text().catch(() => "");
      const retryAfter = response.headers.get("retry-after");
      const failure = this.httpError(response.status, text, retryAfter);
      const ms = retryAfterMs(retryAfter);
      if (failure instanceof OpenAiHttpError && failure.status === 429 && ms !== undefined && ms <= MAX_RETRY_AFTER_MS && waited < RETRY_AFTER_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, ms));
        continue;
      }
      throw failure;
    }
  }

  private async post(body: unknown): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new Error(`A chamada a ${this.baseUrl} excedeu o tempo limite de ${Math.round(this.timeoutMs / 1000)} s`);
      }
      const cause = (error as { cause?: { code?: unknown } }).cause;
      const code = typeof cause?.code === "string" ? ` (${cause.code})` : "";
      throw new Error(this.scrub(`Não consegui falar com ${this.baseUrl}${code}. O servidor está ligado e a URL base está certa?`));
    }
  }

  private readAnswer(json: unknown, model: string): string {
    const data = (json ?? {}) as ChatResponse;
    const choice = data.choices?.[0];
    const usage = data.usage;
    recordLlmUsage({
      provider: this.name,
      model: data.model ?? model,
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      ...(usage?.completion_tokens_details?.reasoning_tokens ? { thinkingTokens: usage.completion_tokens_details.reasoning_tokens } : {}),
    });
    if (choice?.message?.refusal) throw new LlmOutputError(this.scrub(`${this.name}/${model} recusou responder: ${choice.message.refusal}`));
    const raw = choice?.message?.content;
    const text = (Array.isArray(raw) ? raw.map((p) => p.text ?? "").join("") : (raw ?? ""))
      .replace(/<think>[\s\S]*?<\/think>/gi, "") // reasoning models served by Ollama/LM Studio
      .trim();
    if (choice?.finish_reason === "length") throw new LlmOutputError(`${this.name}/${model}: resposta cortada pelo limite de tokens do modelo`);
    if (!text) throw new LlmOutputError(`${this.name}/${model} devolveu resposta vazia`);
    return text;
  }

  /** Typed error for a failed HTTP status. The text never carries the key (scrub) and is shortened. */
  private httpError(status: number, bodyText: string, retryAfter: string | null): Error {
    const info = parseErrorBody(bodyText);
    const detail = this.scrub(info.message || bodyText).slice(0, ERROR_TEXT_CHARS);
    const waitMs = retryAfterMs(retryAfter);
    const quotaLike =
      status === 402 ||
      info.code === "insufficient_quota" ||
      info.type === "insufficient_quota" ||
      (QUOTA_STATUS.has(status) && QUOTA_TEXT.test(`${info.message} ${info.code}`));
    if (quotaLike || (status === 429 && waitMs !== undefined && waitMs > QUOTA_WAIT_MS)) {
      const minutes = waitMs !== undefined ? Math.max(1, Math.ceil(waitMs / 60_000)) : undefined;
      return new QuotaExhaustedError(this.name, detail || `HTTP ${status}`, minutes, "Text quota");
    }
    if (status === 429) return new OpenAiHttpError(429, `HTTP 429 (limite de requisições por minuto) em ${this.baseUrl}: ${detail}`);
    if (status === 401 || status === 403) {
      return new OpenAiHttpError(status, `O servidor ${this.baseUrl} recusou a chave (HTTP ${status}). Confira OPENAI_COMPAT_API_KEY em Chaves e acessos. ${detail}`);
    }
    if (status === 404) {
      return new OpenAiHttpError(404, `HTTP 404 em ${this.baseUrl}/chat/completions: confira a URL base (em geral termina em /v1) e o nome do modelo. ${detail}`);
    }
    return new OpenAiHttpError(status, `HTTP ${status} de ${this.baseUrl}: ${detail}`);
  }

  private scrub(text: string): string {
    const out = redactSecrets(text);
    return this.apiKey ? out.split(this.apiKey).join(REDACTED) : out;
  }
}

/** Builds the provider from `llm.openaiCompatible` + OPENAI_COMPAT_API_KEY, with errors a non-programmer can act on. */
export function openAiCompatibleFromConfig(settings: OpenAiCompatibleSettings | undefined, apiKey: string | undefined): OpenAiCompatibleProvider {
  const baseUrl = settings?.baseUrl?.trim();
  if (!baseUrl) {
    throw new Error(
      "openai-compatible: falta a URL base. Preencha em Configurações > IA por tarefa (llm.openaiCompatible.baseUrl). " +
        "Exemplos: http://localhost:11434/v1 (Ollama), http://localhost:1234/v1 (LM Studio), https://openrouter.ai/api/v1 (OpenRouter).",
    );
  }
  const parsed = parseOpenAiBaseUrl(baseUrl);
  if (parsed.ok && !isLocalBaseUrl(parsed.url) && !apiKey?.trim()) {
    throw new Error("openai-compatible: este servidor não é local e precisa de chave. Cadastre OPENAI_COMPAT_API_KEY em Configurações > Chaves e acessos.");
  }
  return new OpenAiCompatibleProvider({ baseUrl, ...(apiKey ? { apiKey } : {}), ...(settings?.model ? { model: settings.model } : {}) });
}

interface ChatResponse {
  model?: string;
  choices?: { finish_reason?: string; message?: { content?: string | { text?: string }[] | null; refusal?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
}

/** Text first, then the images as data URLs; plain string when there is no image (the widest server support). */
function userContent(prompt: string, images: readonly LlmImage[]): unknown {
  if (images.length === 0) return prompt;
  return [
    { type: "text", text: prompt },
    ...images.map((img) => ({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.data.toString("base64")}` } })),
  ];
}

function promptWithSchema(prompt: string, schema: unknown): string {
  return `${prompt}\n\nResponda SOMENTE com um objeto JSON válido (sem texto antes ou depois, sem markdown) que siga este JSON Schema:\n${JSON.stringify(schema)}`;
}

function looksLikeJson(text: string): boolean {
  const body = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text)?.[1] ?? text;
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
}

function parseErrorBody(text: string): { message: string; code: string; type: string } {
  const str = (v: unknown): string => (typeof v === "string" || typeof v === "number" ? String(v) : "");
  try {
    const raw = JSON.parse(text) as { error?: unknown; message?: unknown };
    const e = (typeof raw.error === "object" && raw.error !== null ? raw.error : raw) as { message?: unknown; code?: unknown; type?: unknown };
    return { message: str(e.message) || str(raw.error), code: str(e.code), type: str(e.type) };
  } catch {
    return { message: text, code: "", type: "" };
  }
}

/** Seconds or an HTTP date -> milliseconds; undefined when absent or unreadable. */
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** Statuses where a quota/credits text counts (OpenAI answers 429, OpenRouter 402, some gateways 403). */
const QUOTA_STATUS = new Set([402, 403, 429]);
/** Documented wording: OpenAI "exceeded your current quota"/insufficient_quota, OpenRouter "Insufficient credits"/"free-models-per-day". */
const QUOTA_TEXT = /insufficient[_ ](?:quota|credits?|funds|balance)|exceeded your current quota|out of credits|credits?[^.]{0,30}(?:exhausted|depleted|too low)|per[- ]day/i;
/** What servers say when the model cannot take images. Only checked when images were sent. */
const IMAGE_REJECTION = /image[ _](?:input|url|content)|support\w*[^.]{0,30}image|image[^.]{0,30}(?:not|un)support|\bvision\b|multimodal|modalit/i;

export { SearchUnsupportedError };
