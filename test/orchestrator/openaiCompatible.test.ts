import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { PipelineConfig } from "../../src/orchestrator/lib/config.js";
import { drainLlmUsage, generateGroundedText, generateJson, generateJsonWithImages, isTimeoutError, withRateLimitRetry } from "../../src/orchestrator/lib/llmClient.js";
import { resolveTaskSettings } from "../../src/orchestrator/lib/llmTasks.js";
import {
  OpenAiCompatibleProvider,
  OpenAiHttpError,
  SearchUnsupportedError,
  VisionUnsupportedError,
  openAiCompatibleFromConfig,
} from "../../src/orchestrator/lib/openaiCompatible.js";
import { QuotaExhaustedError } from "../../src/orchestrator/lib/quota.js";
import { redactSecrets } from "../../src/orchestrator/lib/redact.js";
import { isStorableKey } from "../../src/orchestrator/lib/secretStore.js";
import { isLocalBaseUrl, isPaidLlmProvider, LlmSettingsSchema, parseOpenAiBaseUrl, type LlmSettings } from "../../src/shared/settings.js";

/** The key every test uses: it must never show up in anything the provider prints or throws. */
const CANARY = "sk-canary-0123456789abcdef";

interface Seen {
  url: string;
  headers: IncomingHttpHeaders;
  raw: string;
  body: Record<string, any>;
}
type Reply = (res: ServerResponse, seen: Seen) => void;

let server: Server;
let base: string;
let seen: Seen[];
let replies: Reply[];

const json =
  (status: number, payload: unknown, headers: Record<string, string> = {}): Reply =>
  (res) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(payload));
  };
const answer = (content: string): Reply =>
  json(200, { model: "m-served", choices: [{ finish_reason: "stop", message: { content } }], usage: { prompt_tokens: 7, completion_tokens: 3 } });
const failure = (status: number, message: string, extra: object = {}, headers: Record<string, string> = {}): Reply =>
  json(status, { error: { message, ...extra } }, headers);

beforeEach(async () => {
  seen = [];
  replies = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const entry: Seen = { url: req.url ?? "", headers: req.headers, raw, body: raw ? JSON.parse(raw) : {} };
      seen.push(entry);
      (replies.shift() ?? failure(500, "no reply queued"))(res, entry);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const Out = z.object({ title: z.string(), score: z.number() });
const provider = (extra: Partial<ConstructorParameters<typeof OpenAiCompatibleProvider>[0]> = {}) =>
  new OpenAiCompatibleProvider({ baseUrl: base, apiKey: CANARY, model: "llama3.2", ...extra });
const VALID = JSON.stringify({ title: "ok", score: 1 });
const JPEG = { mimeType: "image/jpeg" as const, data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) };

describe("request shape", () => {
  it("posts to {baseUrl}/chat/completions with the key only in Authorization and a strict json_schema", async () => {
    replies.push(answer(VALID));
    const text = await provider().completeJson("Gere o título", Out);
    expect(text).toBe(VALID);
    const r = seen[0]!;
    expect(r.url).toBe("/v1/chat/completions");
    expect(r.headers["authorization"]).toBe(`Bearer ${CANARY}`);
    expect(r.raw).not.toContain(CANARY);
    expect(r.url).not.toContain(CANARY);
    expect(r.body["model"]).toBe("llama3.2");
    expect(r.body["messages"]).toEqual([{ role: "user", content: "Gere o título" }]);
    expect(r.body["response_format"]).toMatchObject({ type: "json_schema", json_schema: { name: "resposta", strict: true } });
    expect(r.body["response_format"].json_schema.schema).toMatchObject({ type: "object", required: ["title", "score"] });
    expect(r.body["response_format"].json_schema.schema.$schema).toBeUndefined();
    expect(r.body["temperature"]).toBeUndefined();
  });

  it("sends no Authorization without a key (Ollama) and the per-call model wins over the default", async () => {
    replies.push(answer(VALID));
    await provider({ apiKey: undefined }).completeJson("x", Out, [], { model: "qwen2.5", temperature: 0.2 });
    expect(seen[0]!.headers["authorization"]).toBeUndefined();
    expect(seen[0]!.body["model"]).toBe("qwen2.5");
    expect(seen[0]!.body["temperature"]).toBe(0.2);
  });

  it("explains in Portuguese when there is no model at all", async () => {
    await expect(provider({ model: undefined }).completeJson("x", Out)).rejects.toThrow(/nenhum modelo definido/);
    expect(seen).toHaveLength(0);
  });

  it("drops the temperature once when the model rejects it", async () => {
    replies.push(failure(400, "Unsupported value: 'temperature' does not support 0.9 with this model."), answer(VALID));
    expect(await provider().completeJson("x", Out, [], { temperature: 0.9 })).toBe(VALID);
    expect(seen[0]!.body["temperature"]).toBe(0.9);
    expect(seen[1]!.body["temperature"]).toBeUndefined();
    expect(seen[1]!.body["response_format"].type).toBe("json_schema");
  });

  it("records usage and strips <think> blocks of reasoning models", async () => {
    drainLlmUsage();
    replies.push(answer(`<think>hmm\n{"a":1}</think>\n${VALID}`));
    expect(await provider().completeJson("x", Out)).toBe(VALID);
    expect(drainLlmUsage()).toEqual([{ provider: "openai-compatible", model: "m-served", inputTokens: 7, outputTokens: 3 }]);
  });
});

describe("JSON output: schema, then prompt, always validated", () => {
  it("steps down ONCE when json_schema is refused: JSON in the prompt + json_object, remembered per model", async () => {
    replies.push(failure(400, "Invalid parameter: response_format of type json_schema is not supported"), answer(VALID), answer(VALID));
    const p = provider();
    expect(await p.completeJson("Gere", Out)).toBe(VALID);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.body["response_format"]).toEqual({ type: "json_object" });
    expect(seen[1]!.body["messages"][0].content).toMatch(/^Gere[\s\S]*JSON Schema[\s\S]*"title"/);
    await p.completeJson("Gere", Out); // starts from the step that worked: no new probing
    expect(seen).toHaveLength(3);
    expect(seen[2]!.body["response_format"]).toEqual({ type: "json_object" });
  });

  it("falls to no response_format when json_object is refused too (LM Studio)", async () => {
    replies.push(
      failure(400, "'response_format.type' must be 'json_schema' or 'text'"),
      failure(400, "'response_format.type' must be 'json_schema' or 'text'"),
      answer(VALID),
    );
    expect(await provider().completeJson("Gere", Out)).toBe(VALID);
    expect(seen.map((s) => s.body["response_format"]?.type)).toEqual(["json_schema", "json_object", undefined]);
    expect(seen[2]!.body["messages"][0].content).toMatch(/JSON Schema/);
  });

  it("steps down when the server ignores response_format and answers in prose", async () => {
    replies.push(answer("Claro! Aqui está o resultado."), answer("```json\n" + VALID + "\n```"));
    expect(await provider().completeJson("Gere", Out)).toBe("```json\n" + VALID + "\n```");
    expect(seen[1]!.body["response_format"]).toEqual({ type: "json_object" });
  });

  it("invalid JSON for the caller's zod schema is corrected by generateJson (still validated)", async () => {
    replies.push(answer(JSON.stringify({ title: "ok" })), answer(VALID));
    const out = await generateJson("Gere", Out, { provider: provider() });
    expect(out).toEqual({ title: "ok", score: 1 });
    expect(seen).toHaveLength(2);
    expect(seen[1]!.body["messages"][0].content).toMatch(/rejeitada pela validação/);
  });

  it("a persistent 400 that is not about the format still fails with a clear status", async () => {
    replies.push(failure(400, "bad a"), failure(400, "bad b"), failure(400, "bad c"));
    await expect(provider().completeJson("x", Out)).rejects.toThrow(/HTTP 400 de http:\/\/127\.0\.0\.1:\d+\/v1: bad c/);
    expect(seen).toHaveLength(3);
  });

  it("fails clearly on an empty answer, a refusal and a cut-off answer", async () => {
    replies.push(answer(""));
    await expect(provider().completeJson("x", Out)).rejects.toThrow(/resposta vazia/);
    replies.push(json(200, { choices: [{ message: { content: null, refusal: "não posso" } }] }));
    await expect(provider().completeJson("x", Out)).rejects.toThrow(/recusou/);
    replies.push(json(200, { choices: [{ finish_reason: "length", message: { content: '{"a":' } }] }));
    await expect(provider().completeJson("x", Out)).rejects.toThrow(/limite de tokens/);
  });
});

describe("images", () => {
  it("sends images as data URLs in image_url parts, text first", async () => {
    replies.push(answer(VALID));
    await provider().completeJson("Descreva", Out, [JPEG, { mimeType: "image/png", data: Buffer.from("abc") }]);
    expect(seen[0]!.body["messages"][0].content).toEqual([
      { type: "text", text: "Descreva" },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${JPEG.data.toString("base64")}` } },
      { type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from("abc").toString("base64")}` } },
    ]);
  });

  it("a model without vision gives a clear Portuguese error (typed), at once, not a format fallback", async () => {
    for (const [status, message] of [
      [400, "llama3.2 does not support image input"],
      [400, "This model is not multimodal: vision is not available"],
      [422, "unknown variant `image_url`, expected `text`; image input is not supported"],
    ] as const) {
      replies.push(failure(status, message));
      const before = seen.length;
      const error = await provider().completeJson("x", Out, [JPEG]).catch((e: unknown) => e);
      expect(error, message).toBeInstanceOf(VisionUnsupportedError);
      expect((error as Error).message).toMatch(/não aceita imagem \(visão\)/);
      expect(seen.length - before).toBe(1);
    }
  });

  it("the same 400 text without images is not taken for a vision problem", async () => {
    replies.push(failure(400, "vision is mentioned"), failure(400, "vision is mentioned"), failure(400, "vision is mentioned"));
    const error = await provider().completeJson("x", Out).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(VisionUnsupportedError);
  });

  it("generateJsonWithImages works end to end", async () => {
    replies.push(answer(VALID));
    expect(await generateJsonWithImages("x", [JPEG], Out, { provider: provider() })).toEqual({ title: "ok", score: 1 });
  });
});

describe("rate limit and quota", () => {
  it("a 429 with Retry-After is retried in the provider (twice), then handed to the generic retry as status 429", async () => {
    const limited = () => failure(429, "Rate limit reached for requests", {}, { "retry-after": "0" });
    replies.push(limited(), limited(), answer(VALID));
    expect(await provider().completeJson("x", Out)).toBe(VALID);
    expect(seen).toHaveLength(3);

    replies.push(limited(), limited(), limited());
    const error = await provider().completeJson("x", Out).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenAiHttpError);
    expect((error as OpenAiHttpError).status).toBe(429);
    expect(error).not.toBeInstanceOf(QuotaExhaustedError);
    expect(seen).toHaveLength(6);
  });

  it("insufficient_quota (429), 402 credits and 'exceeded your current quota' become QuotaExhaustedError, never retried", async () => {
    const cases: Reply[] = [
      failure(429, "You exceeded your current quota, please check your plan and billing details.", { type: "insufficient_quota", code: "insufficient_quota" }),
      failure(402, "Insufficient credits. Add more using https://openrouter.ai/credits"),
      failure(429, "You exceeded your current quota"),
      failure(403, "insufficient_quota"),
    ];
    for (const reply of cases) {
      replies.push(reply);
      const before = seen.length;
      const error = await withRateLimitRetry(() => provider().completeJson("x", Out), 4, () => 0).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(QuotaExhaustedError);
      expect((error as QuotaExhaustedError).provider).toBe("openai-compatible");
      expect((error as Error).message).toMatch(/Text quota exhausted/);
      expect(seen.length - before).toBe(1);
    }
  });

  it("a Retry-After of an hour is treated as the quota being gone, with the wait announced", async () => {
    replies.push(failure(429, "Rate limit reached", {}, { "retry-after": "3600" }));
    const error = (await provider().completeJson("x", Out).catch((e: unknown) => e)) as QuotaExhaustedError;
    expect(error).toBeInstanceOf(QuotaExhaustedError);
    expect(error.retryAfterMinutes).toBe(60);
    expect(seen).toHaveLength(1);
  });

  it("401 and 404 say what to check, in Portuguese", async () => {
    replies.push(failure(401, "Incorrect API key"));
    await expect(provider().completeJson("x", Out)).rejects.toThrow(/recusou a chave[\s\S]*OPENAI_COMPAT_API_KEY/);
    replies.push(failure(404, "model not found"));
    await expect(provider().completeJson("x", Out)).rejects.toThrow(/URL base[\s\S]*\/v1[\s\S]*nome do modelo/);
  });

  it("a timeout is worded so the generic retry recognises it", async () => {
    replies.push(() => undefined); // never answers
    const error = await provider({ timeoutMs: 50 }).completeJson("x", Out).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(isTimeoutError(error)).toBe(true);
  });
});

describe("web search", () => {
  it("completeGroundedText throws the typed SearchUnsupportedError and never calls the server", async () => {
    const error = await generateGroundedText("fato?", { provider: provider() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SearchUnsupportedError);
    expect((error as Error).message).toMatch(/não tem busca na web/);
    expect(seen).toHaveLength(0);
  });
});

describe("base URL and key validation", () => {
  it("accepts http/https, drops the trailing slash", () => {
    expect(parseOpenAiBaseUrl("http://localhost:11434/v1/")).toEqual({ ok: true, url: "http://localhost:11434/v1" });
    expect(parseOpenAiBaseUrl(" https://openrouter.ai/api/v1 ")).toEqual({ ok: true, url: "https://openrouter.ai/api/v1" });
    expect(parseOpenAiBaseUrl("http://localhost:1234")).toEqual({ ok: true, url: "http://localhost:1234" });
  });

  it("rejects other schemes, credentials, fragments, queries and garbage", () => {
    for (const bad of [
      "ftp://x/v1",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "http://user:pass@localhost/v1",
      "http://user@localhost/v1",
      "http://localhost/v1#frag",
      "http://localhost/v1#",
      "http://localhost/v1?key=abc",
      "http://localhost/v1?",
      "localhost:11434",
      "",
      "   ",
    ]) {
      expect(parseOpenAiBaseUrl(bad).ok, bad).toBe(false);
    }
  });

  it("the config schema applies the same rules, and an old config without the section still parses", () => {
    expect(LlmSettingsSchema.parse({ models: { script: "x" } }).openaiCompatible).toBeUndefined();
    expect(LlmSettingsSchema.parse({ openaiCompatible: { baseUrl: "http://localhost:11434/v1", model: "llama3.2" } }).openaiCompatible).toEqual({
      baseUrl: "http://localhost:11434/v1",
      model: "llama3.2",
    });
    const bad = LlmSettingsSchema.safeParse({ openaiCompatible: { baseUrl: "http://u:p@localhost/v1" } });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toMatch(/usuário nem senha/);
  });

  it("the provider refuses a bad URL, and a key over plain http outside the local network", () => {
    expect(() => new OpenAiCompatibleProvider({ baseUrl: "ftp://x/v1" })).toThrow(/http:\/\/ ou https:\/\//);
    expect(() => new OpenAiCompatibleProvider({ baseUrl: "http://example.com/v1", apiKey: CANARY })).toThrow(/https/);
    expect(() => new OpenAiCompatibleProvider({ baseUrl: "http://192.168.1.20:1234/v1", apiKey: CANARY })).not.toThrow();
    expect(() => new OpenAiCompatibleProvider({ baseUrl: "https://example.com/v1", apiKey: CANARY })).not.toThrow();
  });

  it("openAiCompatibleFromConfig explains a missing URL and a missing key for a remote server", () => {
    expect(() => openAiCompatibleFromConfig(undefined, undefined)).toThrow(/falta a URL base[\s\S]*11434/);
    expect(() => openAiCompatibleFromConfig({ baseUrl: "https://openrouter.ai/api/v1" }, undefined)).toThrow(/OPENAI_COMPAT_API_KEY/);
    expect(openAiCompatibleFromConfig({ baseUrl: "http://localhost:11434/v1", model: "llama3.2" }, undefined).model).toBe("llama3.2");
    expect(openAiCompatibleFromConfig({ baseUrl: "https://openrouter.ai/api/v1" }, CANARY).name).toBe("openai-compatible");
  });

  it("the key is a storable secret and is masked wherever redactSecrets runs", () => {
    expect(isStorableKey("OPENAI_COMPAT_API_KEY")).toBe(true);
    expect(redactSecrets(`falhou com ${CANARY} no meio`, { OPENAI_COMPAT_API_KEY: CANARY })).not.toContain(CANARY);
  });
});

describe("paid or local (isPaidLlmProvider)", () => {
  const llm = (baseUrl?: string): Pick<LlmSettings, "openaiCompatible"> => ({ openaiCompatible: baseUrl ? { baseUrl } : undefined });

  it("local and private-network servers are free; everything else (and a missing/invalid URL) is paid", () => {
    for (const url of [
      "http://localhost:11434/v1",
      "http://127.0.0.1:1234/v1",
      "http://127.5.6.7/v1",
      "http://[::1]:8080/v1",
      "http://meu-pc.local:1234/v1",
      "http://ia.localhost/v1",
      "http://10.0.0.5/v1",
      "http://172.16.0.1/v1",
      "http://172.31.255.1/v1",
      "http://192.168.0.10:1234/v1",
    ]) {
      expect(isLocalBaseUrl(url), url).toBe(true);
      expect(isPaidLlmProvider("openai-compatible", llm(url)), url).toBe(false);
    }
    for (const url of [
      "https://openrouter.ai/api/v1",
      "https://api.openai.com/v1",
      "http://172.32.0.1/v1",
      "http://172.15.0.1/v1",
      "http://192.169.0.1/v1",
      "http://11.0.0.1/v1",
      "http://localhost.evil.com/v1",
      "http://127.0.0.1.evil.com/v1",
      "http://evil-local/v1",
      "http://8.8.8.8/v1",
    ]) {
      expect(isLocalBaseUrl(url), url).toBe(false);
      expect(isPaidLlmProvider("openai-compatible", llm(url)), url).toBe(true);
    }
    expect(isPaidLlmProvider("openai-compatible")).toBe(true);
    expect(isPaidLlmProvider("openai-compatible", llm("não é url"))).toBe(true);
    expect(isPaidLlmProvider("gemini")).toBe(true);
    expect(isPaidLlmProvider("antigravity-cli")).toBe(false);
  });

  const cfg = (baseUrl: string, allowPaid?: boolean) =>
    ({
      llm: LlmSettingsSchema.parse({
        openaiCompatible: { baseUrl },
        tasks: { script: { provider: "antigravity-cli", fallback: { provider: "openai-compatible", ...(allowPaid ? { allowPaid } : {}) } } },
      }),
    }) as Pick<PipelineConfig, "llm" | "footage">;

  it("as a fallback: a local server needs no allowPaid; a remote one is ignored without it", () => {
    expect(resolveTaskSettings("script", cfg("http://localhost:11434/v1")).fallback).toEqual({ provider: "openai-compatible" });
    const remote = resolveTaskSettings("script", cfg("https://openrouter.ai/api/v1"));
    expect(remote.fallback).toBeUndefined();
    expect(remote.warnings[0]).toMatch(/openai-compatible.*allowPaid/);
    expect(resolveTaskSettings("script", cfg("https://openrouter.ai/api/v1", true)).fallback).toEqual({ provider: "openai-compatible" });
  });
});

describe("the key never leaks", () => {
  it("not in thrown errors (even when the server echoes it), logs or the URL", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "info")];
    const thrown: string[] = [];
    const run = async (reply: Reply): Promise<void> => {
      replies.push(reply);
      const e = await provider().completeJson("x", Out).catch((err: unknown) => err);
      thrown.push(e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e));
    };
    await run(failure(401, `Incorrect API key provided: ${CANARY}`));
    await run(failure(500, `internal error, header was Authorization: Bearer ${CANARY} and key=${CANARY}`));
    await run((res) => (res.writeHead(502), res.end(`bad gateway ${CANARY}`)));
    await run(failure(402, `Insufficient credits for key ${CANARY}`));
    await run(json(200, { choices: [{ message: { content: null, refusal: `nope ${CANARY}` } }] }));
    await run((res) => (res.writeHead(302, { location: `http://127.0.0.1:1/x?key=${CANARY}` }), res.end()));
    // connection refused
    const dead = new OpenAiCompatibleProvider({ baseUrl: "http://127.0.0.1:1/v1", apiKey: CANARY, model: "m" });
    thrown.push(String(await dead.completeJson("x", Out).catch((err: unknown) => (err as Error).message)));
    expect(thrown.filter((t) => t.includes(CANARY))).toEqual([]);
    expect(thrown[0]).toMatch(/recusou a chave/);
    expect(thrown[6]).toMatch(/Não consegui falar com/);
    const logged = spies.flatMap((s) => s.mock.calls.flat()).map(String).join("\n");
    expect(logged).not.toContain(CANARY);
    expect(seen.every((s) => !s.url.includes(CANARY) && !s.raw.includes(CANARY))).toBe(true);
  });
});
