import { EventEmitter } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as childProcess from "node:child_process";
import { CliAgentProvider } from "../../src/orchestrator/lib/cliAgent.js";
import { CLAUDE_CODE_PROFILE, parseClaudeOutput } from "../../src/orchestrator/lib/claudeCodeProfile.js";
import { drainLlmUsage, generateJson, generateJsonWithImages, getProviderByName, isQuotaExhaustedError } from "../../src/orchestrator/lib/llmClient.js";
import { FallbackProvider, resolveTaskSettings } from "../../src/orchestrator/lib/llmTasks.js";
import { QuotaExhaustedError } from "../../src/orchestrator/lib/quota.js";
import { LlmTaskSettingSchema } from "../../src/shared/settings.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

interface SpawnCall {
  command: string;
  args: string[];
  options: childProcess.SpawnOptions;
  stdin: string;
  /** Files in the child's cwd at spawn time. */
  cwdFiles: string[];
}
interface Fake {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** Emits a spawn error (e.g. ENOENT) instead of running. */
  spawnError?: string;
}

/** Fake `claude`: one fake per spawn in order, the last repeats. Records args, env, stdin and the cwd listing. */
function mockClaude(fakes: Fake | Fake[]): SpawnCall[] {
  const calls: SpawnCall[] = [];
  const queue = Array.isArray(fakes) ? [...fakes] : [fakes];
  vi.mocked(childProcess.spawn).mockImplementation((command, args, options) => {
    const fake = queue.length > 1 ? queue.shift()! : queue[0]!;
    const cwd = String((options as childProcess.SpawnOptions).cwd);
    const call: SpawnCall = { command, args: args as string[], options, stdin: "", cwdFiles: readdirSync(cwd) };
    calls.push(call);
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = vi.fn();
    child.stdin.on("data", (chunk: Buffer) => (call.stdin += chunk.toString("utf8")));
    child.stdin.on("finish", () =>
      setTimeout(() => {
        if (fake.spawnError) {
          child.emit("error", Object.assign(new Error(`spawn ${command} ${fake.spawnError}`), { code: fake.spawnError }));
          return;
        }
        if (fake.stderr) child.stderr.write(fake.stderr);
        if (fake.stdout) child.stdout.write(fake.stdout);
        child.stdout.end();
        child.stderr.end();
        child.emit("close", fake.exitCode ?? 0);
      }, 0),
    );
    return child;
  });
  return calls;
}

const ok = (extra: Record<string, unknown> = {}): Fake => ({
  stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 }, ...extra }),
});
const Schema = z.object({ score: z.number() });
const img = { mimeType: "image/png" as const, data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) };
const has = (args: string[], ...seq: string[]) => args.some((_, i) => seq.every((s, j) => args[i + j] === s));

describe("claude-code provider (CliAgentProvider + Claude Code profile)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    drainLlmUsage();
    for (const name of ["CLAUDE_CLI_PATH", "CLAUDE_CLI_MODEL", "CLAUDE_CLI_TIMEOUT_S", "CLAUDE_CLI_CONCURRENCY"]) vi.stubEnv(name, "");
  });
  afterEach(() => vi.unstubAllEnvs());

  const provider = () => new CliAgentProvider(CLAUDE_CODE_PROFILE, { timeoutEnv: "CLAUDE_CLI_TIMEOUT_S", concurrencyEnv: "CLAUDE_CLI_CONCURRENCY" });

  it("text call: headless JSON, schema, tools off, no persistence, empty temp cwd removed afterwards, usage recorded", async () => {
    const calls = mockClaude(ok({ structured_output: { score: 7 } }));
    const text = await provider().completeJson("Dê a nota", Schema);
    expect(JSON.parse(text)).toEqual({ score: 7 });

    const c = calls[0]!;
    expect(c.command).toBe("claude");
    expect(c.args).toEqual(expect.arrayContaining(["-p", "--no-session-persistence", "--safe-mode", "--strict-mcp-config", "--disable-slash-commands"]));
    expect(has(c.args, "--output-format", "json")).toBe(true);
    expect(has(c.args, "--tools", "")).toBe(true);
    expect(has(c.args, "--permission-mode", "dontAsk")).toBe(true);
    expect(has(c.args, "--model", "sonnet")).toBe(true);
    const schemaArg = c.args[c.args.indexOf("--json-schema") + 1]!;
    expect(JSON.parse(schemaArg)).toMatchObject({ type: "object", properties: { score: { type: "number" } } });
    expect(c.args).not.toContain("--allowedTools");
    expect(c.args).not.toContain("--dangerously-skip-permissions");
    expect(c.args.join(" ")).not.toMatch(/Bash|--bare/);
    expect(c.stdin).toContain("Dê a nota");
    expect(c.cwdFiles).toEqual([]);
    expect(existsSync(String(c.options.cwd))).toBe(false);
    expect(String(c.options.cwd)).toMatch(/cli-agent-/);
    // input counts cache tokens too (they are what the plan meters)
    expect(drainLlmUsage()).toEqual([{ provider: "claude-code", model: "sonnet", inputTokens: 150, outputTokens: 20 }]);
  });

  it("with images: Read only (never allowed outside the cwd), cwd holds only the images, prompt lists them in order", async () => {
    const calls = mockClaude(ok({ result: '{"score": 9}' }));
    const text = await provider().completeJson("Avalie", Schema, [img, img]);
    expect(text).toBe('{"score": 9}');

    const c = calls[0]!;
    expect(has(c.args, "--tools", "Read")).toBe(true);
    expect(c.args).not.toContain("--allowedTools");
    expect(c.cwdFiles.sort()).toEqual(["frame_0.png", "frame_1.png"]);
    expect(c.stdin).toMatch(/image 1: ".*frame_0\.png"/);
    expect(c.stdin).toMatch(/image 2: ".*frame_1\.png"/);
    expect(existsSync(String(c.options.cwd))).toBe(false);
  });

  it("grounded call: only WebSearch, allowed explicitly; sources come from the structured answer; usage flagged grounded", async () => {
    const calls = mockClaude(ok({ structured_output: { text: "Fato.", sources: [{ uri: "https://a.org", title: "A" }, { uri: "https://a.org" }], queries: ["q"] } }));
    const out = await provider().completeGroundedText("Confira o fato");
    expect(out).toEqual({ text: "Fato.", sources: [{ uri: "https://a.org", title: "A" }], queries: ["q"] });
    const c = calls[0]!;
    expect(has(c.args, "--tools", "WebSearch", "--allowedTools", "WebSearch")).toBe(true);
    expect(c.args.join(" ")).not.toMatch(/Bash|WebFetch|Read/);
    expect(c.stdin).toContain("WebSearch");
    expect(drainLlmUsage()[0]).toMatchObject({ grounded: true });
  });

  it("effort and per-call model are passed; unknown thinking adds nothing", async () => {
    const calls = mockClaude(ok({ structured_output: { score: 1 } }));
    await provider().completeJson("x", Schema, [], { thinking: "high", model: "opus" });
    await provider().completeJson("x", Schema, [], { thinking: "default" });
    expect(has(calls[0]!.args, "--model", "opus")).toBe(true);
    expect(has(calls[0]!.args, "--effort", "high")).toBe(true);
    expect(calls[1]!.args).not.toContain("--effort");
  });

  it("child env never carries ANTHROPIC_API_KEY (or any key) even when the process has them; the login folder variables pass", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-FAKE0000000000000000000000");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "fake-token");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-oauth");
    vi.stubEnv("GEMINI_API_KEY", "AIzaFAKE0000000000000000000000000000");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/some/config");
    vi.stubEnv("HOME", "/some/home");
    const calls = mockClaude(ok({ structured_output: { score: 1 } }));
    await provider().completeJson("x", Schema);
    const childEnv = calls[0]!.options.env as Record<string, string>;
    expect(Object.keys(childEnv).filter((k) => /ANTHROPIC|GEMINI|OAUTH|API_KEY|TOKEN/i.test(k))).toEqual([]);
    expect(childEnv["HOME"]).toBe("/some/home");
    expect(childEnv["CLAUDE_CONFIG_DIR"]).toBe("/some/config");
  });

  it("invalid JSON: generateJson retries once with the correction in the prompt", async () => {
    const calls = mockClaude([ok({ result: "não é json" }), ok({ structured_output: { score: 3 } })]);
    const value = await generateJson("Nota?", Schema, { provider: provider() });
    expect(value).toEqual({ score: 3 });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.stdin).toMatch(/rejeitada pela validação/);
    expect(calls[1]!.stdin).toContain("não é json");
  });

  it("structured output that breaks the zod schema is also corrected (zod stays the judge)", async () => {
    const calls = mockClaude([ok({ structured_output: { score: "alto" } }), ok({ structured_output: { score: 3 } })]);
    expect(await generateJsonWithImages("Nota?", [img], Schema, { provider: provider() })).toEqual({ score: 3 });
    expect(calls[1]!.stdin).toMatch(/Problemas encontrados/);
  });

  it("plan quota (is_error result) becomes QuotaExhaustedError, without rate-limit backoff, and is recognised as quota", async () => {
    const calls = mockClaude({ stdout: JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "You've hit your session limit · resets in 3h25m", usage: { input_tokens: 1, output_tokens: 0 } }), exitCode: 1 });
    const error = await generateJson("x", Schema, { provider: provider() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QuotaExhaustedError);
    expect((error as QuotaExhaustedError).provider).toBe("claude-code");
    expect((error as QuotaExhaustedError).retryAfterMinutes).toBe(205);
    expect(isQuotaExhaustedError(error)).toBe(true);
    expect(calls).toHaveLength(1); // no backoff retries
  });

  it("quota text on stderr with an empty stdout is detected too; weekly/Opus limits as well", async () => {
    mockClaude({ stderr: "Error: You've hit your weekly limit", exitCode: 1 });
    await expect(provider().completeJson("x", Schema)).rejects.toBeInstanceOf(QuotaExhaustedError);
    mockClaude({ stdout: JSON.stringify({ is_error: true, result: "You've hit your Opus limit" }), exitCode: 1 });
    await expect(provider().completeJson("x", Schema)).rejects.toBeInstanceOf(QuotaExhaustedError);
  });

  it("the per-task fallback takes over when the plan quota ends", async () => {
    mockClaude({ stdout: JSON.stringify({ is_error: true, result: "You've hit your session limit" }), exitCode: 1 });
    const alt = { name: "antigravity-cli" as const, model: "m", completeJson: vi.fn().mockResolvedValue('{"score": 1}'), completeGroundedText: vi.fn() };
    const warn = vi.fn();
    const fb = new FallbackProvider("script", () => provider(), () => alt, undefined, warn);
    expect(await fb.completeJson("x", Schema)).toBe('{"score": 1}');
    expect(warn.mock.calls[0]![0]).toMatch(/cota esgotada/);
  });

  it("not logged in: clear message that mentions the plan login and no API key", async () => {
    mockClaude({ stdout: JSON.stringify({ is_error: true, result: "Not logged in · Please run /login" }), exitCode: 1 });
    await expect(provider().completeJson("x", Schema)).rejects.toThrow(/sem login.*plano.*nenhuma chave/);
  });

  it("claude missing: clear message with the way out", async () => {
    mockClaude({ spawnError: "ENOENT" });
    await expect(provider().completeJson("x", Schema)).rejects.toThrow(/Claude Code \(claude\) não encontrado.*CLAUDE_CLI_PATH/);
  });

  it("CLAUDE_CLI_PATH and CLAUDE_CLI_MODEL override the command and the default model", async () => {
    vi.stubEnv("CLAUDE_CLI_PATH", "meu-claude");
    vi.stubEnv("CLAUDE_CLI_MODEL", "haiku");
    const calls = mockClaude(ok({ structured_output: { score: 1 } }));
    const p = provider();
    await p.completeJson("x", Schema);
    expect(calls[0]!.command).toBe("meu-claude");
    expect(has(calls[0]!.args, "--model", "haiku")).toBe(true);
    expect(p.model).toBe("haiku");
  });

  it("parseClaudeOutput reads the object form, the array form and the content-block result; plain text is not the agent's JSON", () => {
    expect(parseClaudeOutput('{"type":"result","result":"oi","usage":{"input_tokens":2,"output_tokens":3}}')).toEqual({ isError: false, text: "oi", usage: { inputTokens: 2, outputTokens: 3 } });
    expect(parseClaudeOutput('[{"type":"system"},{"type":"result","subtype":"error_max_turns","result":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}]')).toEqual({ isError: true, text: "ab" });
    expect(parseClaudeOutput("só texto")).toBeUndefined();
  });

  it("registry: claude-code is buildable and valid in the task schema; old configs (no llm section) never resolve to it", () => {
    expect(getProviderByName("claude-code").name).toBe("claude-code");
    expect(LlmTaskSettingSchema.parse({ provider: "claude-code", fallback: { provider: "claude-code" } }).provider).toBe("claude-code");
    expect(resolveTaskSettings("script", { llm: undefined, footage: undefined } as never).provider).toBeUndefined();
  });
});
