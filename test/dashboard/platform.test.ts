import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { storableKeyStatus } from "../../dashboard/server/keys.js";
import { buildPlatformStatus, defaultKokoroPython, groupedKeyNames, platformApp, readTests, recordTest, runProbeChild, type PlatformDeps, type PlatformInputs } from "../../dashboard/server/platform.js";
import type { KeyStatus } from "../../dashboard/shared/api.js";
import type { LlmProvider } from "../../src/orchestrator/lib/llmClient.js";
import { PROBE_PROMPT, probeProvider, safeProbeMessage } from "../../src/orchestrator/lib/providerProbe.js";
import { setStoredKey, STORABLE_KEYS } from "../../src/orchestrator/lib/secretStore.js";
import { LLM_PROVIDER_NAMES } from "../../src/shared/settings.js";

const CANARY = "AIzaCANARY0000000000000000000000000000xyz"; // not a real key
const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "platform-test-"));
  dirs.push(d);
  return d;
};
const previous = { secrets: process.env["MAQUINA_SECRETS_DIR"], gemini: process.env["GEMINI_API_KEY"] };
afterAll(() => {
  for (const [name, value] of [["MAQUINA_SECRETS_DIR", previous.secrets], ["GEMINI_API_KEY", previous.gemini]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const key = (name: string, configured: boolean): KeyStatus => ({ name, label: name, configured });
const inputs = (over: Partial<PlatformInputs> = {}): PlatformInputs => ({ keys: [], llm: undefined, exists: () => false, env: () => undefined, fileExists: () => false, tests: {}, ...over });

describe("buildPlatformStatus", () => {
  it("lists every provider with installed/configured/tested and detects the CLIs without support", () => {
    const tests = { gemini: { ok: true, at: "2026-11-02T10:00:00.000Z", message: "ok" } };
    const status = buildPlatformStatus(inputs({ keys: [key("GEMINI_API_KEY", true)], exists: (c) => c === "claude" || c === "codex", tests }));
    expect(status.providers.map((p) => p.name)).toEqual([...LLM_PROVIDER_NAMES]);
    const by = Object.fromEntries(status.providers.map((p) => [p.name, p]));
    expect(by["claude-code"]).toMatchObject({ kind: "cli", installed: true, available: true, paid: false });
    expect(by["antigravity-cli"]).toMatchObject({ kind: "cli", installed: false, available: false });
    expect(by["claude-code"]!.notes.join(" ")).toMatch(/termos/); // the registry note is reused
    expect(by["gemini"]).toMatchObject({ kind: "api", configured: true, paid: true, keyNames: ["GEMINI_API_KEY"], lastTest: tests.gemini });
    expect(by["anthropic"]).toMatchObject({ configured: false, available: false });
    expect(by["anthropic"]!.reason).toMatch(/ANTHROPIC_API_KEY/);
    expect(status.detectedClis.map((c) => [c.id, c.detected])).toEqual([["codex", true], ["opencode", false], ["cursor-agent", false]]);
  });

  it("openai-compatible: free with a local URL, paid otherwise", () => {
    const by = (llm: unknown) => buildPlatformStatus(inputs({ llm: llm as never })).providers.find((p) => p.name === "openai-compatible")!;
    expect(by({ openaiCompatible: { baseUrl: "http://localhost:11434/v1" } })).toMatchObject({ paid: false, available: true });
    expect(by({ openaiCompatible: { baseUrl: "https://openrouter.ai/api/v1" } })).toMatchObject({ paid: true, available: false });
    expect(by(undefined)).toMatchObject({ paid: true, available: false });
  });

  it("reports voice and image readiness", () => {
    const missing = buildPlatformStatus(inputs());
    expect(missing.voice["elevenlabs"]).toMatchObject({ ready: false });
    expect(missing.voice["elevenlabs"]!.detail).toMatch(/ELEVENLABS_API_KEY/);
    expect(missing.voice["elevenlabs"]!.note).toMatch(/NÃO COMERCIAL/);
    expect(missing.voice["chatterbox"]).toMatchObject({ ready: false, detail: expect.stringMatching(/CHATTERBOX_PYTHON/) });
    expect(missing.voice["chatterbox"]!.note).toMatch(/consentimento|autorizou/);
    expect(missing.images["ilustrado"]).toMatchObject({ ready: false });
    const ok = buildPlatformStatus(inputs({ keys: [key("ELEVENLABS_API_KEY", true)], exists: () => true, env: (n) => (n === "KOKORO_PYTHON" ? "py" : undefined), fileExists: () => true }));
    expect(ok.voice["elevenlabs"]!.ready).toBe(true);
    expect(ok.voice["kokoro"]!.ready).toBe(true);
    expect(ok.images["ilustrado"]!.ready).toBe(true);
  });

  it("finds Kokoro at the setup's default folder when KOKORO_PYTHON is not set (the loop does the same)", () => {
    const standard = defaultKokoroPython("C:\\Users\\x\\AppData\\Local")!;
    expect(standard.replace(/\\/g, "/")).toMatch(/maquina-tts\/kokoro\/Scripts\/python\.exe$/);
    const env = (n: string) => (n === "LOCALAPPDATA" ? "C:\\Users\\x\\AppData\\Local" : undefined);
    const found = buildPlatformStatus(inputs({ env, fileExists: (p) => p === standard }));
    expect(found.voice["kokoro"]).toMatchObject({ ready: true, detail: expect.stringMatching(/setup_kokoro/) });
    expect(buildPlatformStatus(inputs({ env, fileExists: () => false })).voice["kokoro"]).toMatchObject({ ready: false, detail: expect.stringMatching(/KOKORO_PYTHON/) });
    expect(defaultKokoroPython(undefined)).toBeUndefined();
  });

  it("shows every storable key in exactly one card", () => {
    expect([...groupedKeyNames()].sort()).toEqual(STORABLE_KEYS.map((k) => k.name).sort());
  });
});

describe("last results file", () => {
  it("round-trips, ignores unknown providers and junk, and never stores more than ok/at/message/ms", () => {
    const file = join(tmp(), "t.json");
    expect(readTests(file)).toEqual({});
    recordTest("gemini", { ok: false, at: "2026-11-02T10:00:00.000Z", message: "falhou", ms: 12 }, file);
    recordTest("anthropic", { ok: true, at: "2026-11-02T10:01:00.000Z", message: "ok" }, file);
    expect(Object.keys(readTests(file))).toEqual(["gemini", "anthropic"]);
    expect(readFileSync(file, "utf8")).not.toMatch(/key|token/i);
  });
});

describe("probeProvider (the one fixed call)", () => {
  const fake = (completeJson: LlmProvider["completeJson"]): (() => LlmProvider) => () => ({ name: "gemini", model: "m-1", completeJson, completeGroundedText: () => Promise.reject(new Error("unused")) });
  it("sends only the fixed prompt and accepts {ok:true}", async () => {
    const seen: string[] = [];
    const out = await probeProvider(fake((p: string, _s: z.ZodType) => (seen.push(p), Promise.resolve('{"ok": true}'))), 1000);
    expect(seen).toEqual([PROBE_PROMPT]);
    expect(out.ok).toBe(true);
    expect(out.message).toMatch(/m-1/);
  });
  it("fails on a wrong answer without echoing it, and redacts errors", async () => {
    process.env["GEMINI_API_KEY"] = CANARY;
    const wrong = await probeProvider(fake(() => Promise.resolve(`resposta com ${CANARY}`)), 1000);
    expect(wrong.ok).toBe(false);
    expect(wrong.message).not.toContain(CANARY);
    const boom = await probeProvider(fake(() => Promise.reject(new Error(`HTTP 401 for url ?key=${CANARY} Bearer ${CANARY}`))), 1000);
    expect(boom.ok).toBe(false);
    expect(boom.message).not.toContain(CANARY);
    expect(safeProbeMessage("x".repeat(500)).length).toBeLessThanOrEqual(200);
  });
  it("gives up at the timeout", async () => {
    const out = await probeProvider(fake(() => new Promise(() => undefined)), 30);
    expect(out).toMatchObject({ ok: false });
    expect(out.message).toMatch(/tempo esgotado/);
  });
});

describe("routes /api/platform", () => {
  let server: Server | undefined;
  let base = "";
  let clock = 1_000_000;
  const calls: string[] = [];
  const timeouts: number[] = [];
  let probeMessage = "ok";
  let probeOk = true;
  const start = async (over: PlatformDeps = {}): Promise<string> => {
    const file = join(tmp(), "platform-tests.json");
    const secrets = tmp();
    process.env["MAQUINA_SECRETS_DIR"] = secrets;
    process.env["GEMINI_API_KEY"] = CANARY;
    setStoredKey(secrets, "GEMINI_API_KEY", CANARY);
    const app = platformApp({
      exists: (c) => c === "claude",
      testsFile: file,
      now: () => clock,
      minIntervalMs: 5000,
      keys: storableKeyStatus,
      llm: () => Promise.resolve(undefined),
      probe: (name, timeoutMs) => (calls.push(name), timeouts.push(timeoutMs), Promise.resolve({ ok: probeOk, message: probeMessage, ms: 1234 })),
      ...over,
    });
    await new Promise<void>((resolve) => (server = app.listen(0, "127.0.0.1", () => resolve())));
    base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/platform`;
    return file;
  };
  const stop = (): Promise<void> => new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
  afterEach(async () => {
    await stop();
    server = undefined;
    calls.length = 0;
    timeouts.length = 0;
    probeOk = true;
    probeMessage = "ok";
    clock += 1_000_000;
  });
  const post = (name: string, body: unknown = {}, headers: Record<string, string> = { "Content-Type": "application/json" }) =>
    fetch(`${base}/test/${name}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

  it("tests a free provider once, records the result and shows it afterwards", async () => {
    const file = await start();
    const res = await post("claude-code");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; ran: boolean; test: { ok: boolean; at: string; ms: number } };
    expect(body).toMatchObject({ ok: true, ran: true, test: { ok: true, ms: 1234 } });
    expect(calls).toEqual(["claude-code"]);
    expect(readTests(file)["claude-code"]).toMatchObject({ ok: true });
    const status = (await (await fetch(base)).json()) as { providers: { name: string; lastTest?: { ok: boolean } }[] };
    expect(status.providers.find((p) => p.name === "claude-code")?.lastTest?.ok).toBe(true);
  });

  it("redacts the key from a failure message (answer and saved file) and never lets the canary out of any route", async () => {
    const file = await start();
    probeOk = false;
    probeMessage = `Falhou: HTTP 401 url?key=${CANARY} Authorization: Bearer ${CANARY} ${CANARY}`;
    const bodies: string[] = [];
    const grab = async (res: Response): Promise<number> => (bodies.push(await res.text()), res.status);
    expect(await grab(await fetch(base))).toBe(200);
    expect(await grab(await post("gemini"))).toBe(400); // paid, no confirmation
    expect(await grab(await post("gemini", { confirmPaid: true }))).toBe(200);
    expect(await grab(await post("gemini", { confirmPaid: true }))).toBe(429); // too soon
    expect(await grab(await post("nao-existe"))).toBe(404);
    expect(await grab(await post("claude-code", "{}", { "Content-Type": "text/plain" }))).toBe(415);
    expect(await grab(await post("anthropic", { confirmPaid: true }))).toBe(200); // no key: not run
    expect(await grab(await fetch(base))).toBe(200);
    bodies.push(readFileSync(file, "utf8"));
    expect(bodies.length).toBe(9);
    for (const text of bodies) expect(text).not.toContain(CANARY);
    expect(readTests(file)["gemini"]).toMatchObject({ ok: false });
  });

  it("refuses a paid provider without confirmPaid (400) and does not call it", async () => {
    await start();
    for (const bad of [{}, { confirmPaid: "true" }, { confirmPaid: 1 }, { confirmPaid: false }]) expect((await post("gemini", bad)).status).toBe(400);
    expect(calls).toEqual([]);
    expect((await post("gemini", { confirmPaid: true })).status).toBe(200);
    expect(calls).toEqual(["gemini"]);
  });

  it("treats openai-compatible as paid unless its saved URL is local", async () => {
    await start({ llm: () => Promise.resolve({ openaiCompatible: { baseUrl: "http://localhost:11434/v1" } }) });
    expect((await post("openai-compatible")).status).toBe(200);
    expect(calls).toEqual(["openai-compatible"]);
    expect(timeouts).toEqual([120_000]); // a local model may need over a minute to load on the first call
    await stop();
    calls.length = 0;
    await start({ llm: () => Promise.resolve({ openaiCompatible: { baseUrl: "https://openrouter.ai/api/v1" } }) });
    expect((await post("openai-compatible")).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("limits to one call per provider per interval", async () => {
    await start();
    expect((await post("claude-code")).status).toBe(200);
    const again = await post("claude-code");
    expect(again.status).toBe(429);
    expect(again.headers.get("retry-after")).toBe("5");
    expect(calls.length).toBe(1);
    clock += 6000;
    expect((await post("claude-code")).status).toBe(200);
    expect(calls.length).toBe(2);
  });

  it("does not call a provider that is not usable here, and says why", async () => {
    await start({ exists: () => false });
    const res = await post("antigravity-cli");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, ran: false, message: expect.stringMatching(/não encontrado/) });
    expect(calls).toEqual([]);
  });
});

describe("runProbeChild", () => {
  it("answers a readable failure for a provider name that does not exist (real child process)", async () => {
    const out = await runProbeChild("nao-existe" as never, 5000);
    expect(out).toMatchObject({ ok: false, message: expect.stringMatching(/desconhecido/) });
  }, 30_000);
});
