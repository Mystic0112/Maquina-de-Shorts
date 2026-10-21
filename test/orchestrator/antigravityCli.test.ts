import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as childProcess from "node:child_process";
import {
  AntigravityCliProvider,
  DEFAULT_ANTIGRAVITY_CLI_PATH,
  drainLlmUsage,
  LlmOutputError,
  type LlmProvider,
} from "../../src/orchestrator/lib/llmClient.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

interface SpawnCall {
  command: string;
  args: string[];
  options: childProcess.SpawnOptions;
  /** Prompt the provider wrote to the child's stdin. */
  stdin?: string;
}

interface FakeAgy {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  delayMs?: number;
}

/** Fake agy child: records the spawn, waits delayMs after stdin closes, prints stdout/stderr and exits. */
function mockSpawn(fakeOrSequence: FakeAgy | FakeAgy[], onStart: () => void = () => undefined, onEnd: () => void = () => undefined): SpawnCall[] {
  const spawnCalls: SpawnCall[] = [];
  const sequence = Array.isArray(fakeOrSequence) ? [...fakeOrSequence] : [fakeOrSequence];
  vi.mocked(childProcess.spawn).mockImplementation((command, args, options) => {
    // One fake per spawn, in order; the last one repeats for any further spawn.
    const fake = sequence.length > 1 ? sequence.shift()! : sequence[0]!;
    spawnCalls.push({ command, args: args as string[], options });
    onStart();
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = vi.fn();
    let stdinText = "";
    child.stdin.on("data", (chunk: Buffer) => (stdinText += chunk.toString("utf8")));
    child.stdin.on("finish", () => {
      setTimeout(() => {
        spawnCalls[spawnCalls.length - 1]!.stdin = stdinText;
        if (fake.stderr) child.stderr.write(fake.stderr);
        if (fake.stdout) child.stdout.write(fake.stdout);
        child.stdout.end();
        child.stderr.end();
        onEnd();
        child.emit("close", fake.exitCode ?? 0);
      }, fake.delayMs ?? 0);
    });
    return child;
  });
  return spawnCalls;
}

function mockSpawnSuccess(responseObj: Record<string, unknown>, exitCode = 0): SpawnCall[] {
  return mockSpawn({ stdout: JSON.stringify(responseObj), exitCode });
}

function mockSpawnFailure(exitCode: number, stderrText = "Process failed"): SpawnCall[] {
  return mockSpawn({ stderr: stderrText, exitCode });
}

const SUCCESS = { status: "SUCCESS", usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 1 } };

function fakeFallback(): LlmProvider {
  return {
    name: "gemini",
    model: "gemini-flash-latest",
    completeJson: vi.fn().mockResolvedValue('{"fallback": true}'),
    completeGroundedText: vi.fn().mockResolvedValue({ text: "grounded", sources: [], queries: [] }),
  };
}

describe("AntigravityCliProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    drainLlmUsage();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("DEFAULT_ANTIGRAVITY_CLI_PATH is simply 'agy' without fixed user paths", () => {
    expect(DEFAULT_ANTIGRAVITY_CLI_PATH).toBe("agy");
  });

  it("spawns agy with --sandbox, without --dangerously-skip-permissions, and with minimalChildEnv", async () => {
    const spawnCalls = mockSpawnSuccess({
      status: "SUCCESS",
      response: '{"score": 9, "matches": true}',
      usage: { input_tokens: 120, output_tokens: 45, thinking_tokens: 15 },
    });

    const provider = new AntigravityCliProvider(undefined, "gemini-3.8-flash", null);
    const result = await provider.completeJson("Analise a imagem", z.object({ score: z.number() }), [
      { mimeType: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff]) },
    ]);

    expect(result).toBe('{"score": 9, "matches": true}');
    expect(spawnCalls).toHaveLength(1);

    const call = spawnCalls[0]!;
    expect(call.command).toBe("agy");
    expect(call.args).toContain("--sandbox");
    expect(call.args).not.toContain("--dangerously-skip-permissions");
    expect(call.args).toContain("--output-format");
    expect(call.args).toContain("json");

    // cwd deve ser uma pasta temporária isolada
    expect(call.options.cwd).toBeDefined();
    expect(String(call.options.cwd)).toMatch(/agy-img-/);

    // env não deve vazar chaves da API
    const childEnv = call.options.env as Record<string, string>;
    expect(childEnv).toBeDefined();
    expect(childEnv.GEMINI_API_KEY).toBeUndefined();
    expect(childEnv.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("records modelToUse in recordLlmUsage based on thinking option", async () => {
    mockSpawnSuccess({
      status: "SUCCESS",
      response: '{"verdict": "ok"}',
      usage: { input_tokens: 200, output_tokens: 80, thinking_tokens: 40 },
    });

    const provider = new AntigravityCliProvider("custom-agy", "gemini-3.8-flash", null);
    await provider.completeJson("Prompt", z.any(), [], { thinking: "medium" });

    const usage = drainLlmUsage();
    expect(usage).toHaveLength(1);
    expect(usage[0]!.provider).toBe("antigravity-cli");
    expect(usage[0]!.model).toBe("gemini-3.8-flash-medium");
    expect(usage[0]!.inputTokens).toBe(200);
    expect(usage[0]!.outputTokens).toBe(80);
    expect(usage[0]!.thinkingTokens).toBe(40);
  });

  it("options.model wins over the constructor model and the thinking mapping; suffixed models get no --effort", async () => {
    const spawnCalls = mockSpawnSuccess({ ...SUCCESS, structured_output: {} });
    const provider = new AntigravityCliProvider(undefined, "gemini-3.8-flash", null);
    await provider.completeJson("q", z.object({}), [], { thinking: "high", model: "claude-sonnet-5-5-low" });
    const args = spawnCalls[0]!.args;
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-5-5-low");
    expect(args).not.toContain("--effort");
    expect(drainLlmUsage()[0]!.model).toBe("claude-sonnet-5-5-low");
  });

  it("options.model without a -low/-medium/-high suffix maps thinking to --effort", async () => {
    const spawnCalls = mockSpawnSuccess({ ...SUCCESS, structured_output: {} });
    const provider = new AntigravityCliProvider(undefined, undefined, null);
    await provider.completeJson("q", z.object({}), [], { thinking: "high", model: "gemini-4-argon" });
    const args = spawnCalls[0]!.args;
    expect(args[args.indexOf("--model") + 1]).toBe("gemini-4-argon");
    expect(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2)).toEqual(["--effort", "high"]);
  });

  it("options.model also applies to completeGroundedText", async () => {
    const spawnCalls = mockSpawnSuccess({ ...SUCCESS, structured_output: { text: "t", sources: [], queries: [] } });
    const provider = new AntigravityCliProvider(undefined, undefined, null);
    await provider.completeGroundedText("q", { model: "claude-sonnet-5-5-medium" });
    const args = spawnCalls[0]!.args;
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-5-5-medium");
    expect(args).not.toContain("--effort");
  });

  it("throws LlmOutputError when agy returns status !== SUCCESS instead of swallowing it", async () => {
    mockSpawnSuccess({
      status: "ERROR",
      response: "A tool required command permission and was denied",
    });

    const provider = new AntigravityCliProvider(undefined, undefined, null);
    await expect(provider.completeJson("Prompt", z.any())).rejects.toThrow(
      /agy retornou status ERROR/,
    );
  });

  it("invokes fallbackProvider when CLI fails and fallback is provided", async () => {
    mockSpawnFailure(1, "Command not found or permission error");

    const fallback = fakeFallback();
    const provider = new AntigravityCliProvider(undefined, undefined, fallback);
    const result = await provider.completeJson("Prompt", z.any());

    expect(result).toBe('{"fallback": true}');
    expect(fallback.completeJson).toHaveBeenCalledTimes(1);
  });

  it("propagates error when CLI fails and fallback is null", async () => {
    mockSpawnFailure(127, "Fatal error");

    const provider = new AntigravityCliProvider(undefined, undefined, null);
    await expect(provider.completeJson("Prompt", z.any())).rejects.toThrow(
      /agy finalizou com código 127/,
    );
  });

  it("passes --json-schema from zod, prefixes text-only prompts, and returns structured_output as JSON text", async () => {
    const spawnCalls = mockSpawnSuccess({ ...SUCCESS, response: "ignored", structured_output: { answer: "42" } });

    const provider = new AntigravityCliProvider(undefined, undefined, null);
    const text = await provider.completeJson("Qual a resposta?", z.object({ answer: z.string() }));

    expect(JSON.parse(text)).toEqual({ answer: "42" });
    const args = spawnCalls[0]!.args;
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1]!)).toMatchObject({ type: "object", required: ["answer"] });
    expect(args).toContain("--disable-slash-commands");
    expect(args.slice(args.indexOf("--print-timeout"), args.indexOf("--print-timeout") + 2)).toEqual(["--print-timeout", "180s"]);
    expect(spawnCalls[0]!.stdin).toMatch(/^Responda diretamente, sem executar comandos nem ler arquivos\.\n\nQual a resposta\?$/);
  });

  it("does not prefix the direct-answer instruction when images are attached", async () => {
    const spawnCalls = mockSpawnSuccess({ ...SUCCESS, structured_output: { score: 1 } });
    const provider = new AntigravityCliProvider(undefined, undefined, null);
    await provider.completeJson("Avalie", z.object({ score: z.number() }), [{ mimeType: "image/png", data: Buffer.from("x") }]);
    expect(spawnCalls[0]!.stdin).not.toContain("Responda diretamente");
    expect(spawnCalls[0]!.stdin).toMatch(/view_file[\s\S]*frame_0\.png[\s\S]*Avalie/);
  });

  it("reads ANTIGRAVITY_CLI_TIMEOUT_S for --print-timeout", async () => {
    vi.stubEnv("ANTIGRAVITY_CLI_TIMEOUT_S", "45");
    const spawnCalls = mockSpawnSuccess({ ...SUCCESS, structured_output: {} });
    await new AntigravityCliProvider(undefined, undefined, null).completeJson("q", z.object({}));
    expect(spawnCalls[0]!.args).toContain("45s");
  });

  it("retries once with a reminder after a denied tool call, then throws naming denied_actions and the stderr tail", async () => {
    const spawnCalls = mockSpawn({
      stdout: JSON.stringify({ ...SUCCESS, response: "", denied_actions: [{ action: "command", display_name: "RunCommand" }] }),
      stderr: 'jetski: no output produced — a tool required the "command" permission',
    });
    const provider = new AntigravityCliProvider(undefined, undefined, null);
    const error = await provider.completeJson("q", z.any()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmOutputError);
    expect((error as Error).message).toMatch(/resposta vazia.*"display_name":"RunCommand"[\s\S]*no output produced/);
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0]!.stdin).not.toContain("IMPORTANTE: na tentativa anterior");
    expect(spawnCalls[1]!.stdin).toMatch(/^IMPORTANTE: na tentativa anterior[\s\S]*NÃO execute comandos[\s\S]*\nq$/);
  });

  it("recovers when the retry after a denied tool call answers", async () => {
    const spawnCalls = mockSpawn([
      { stdout: JSON.stringify({ ...SUCCESS, response: "", denied_actions: [{ action: "command", display_name: "RunCommand" }] }) },
      { stdout: JSON.stringify({ ...SUCCESS, structured_output: { answer: "42" } }) },
    ]);
    const provider = new AntigravityCliProvider(undefined, undefined, null);
    await expect(provider.completeJson("q", z.object({ answer: z.string() }))).resolves.toBe(JSON.stringify({ answer: "42" }));
    expect(spawnCalls).toHaveLength(2);
  });

  it("grounded prompt forbids terminal commands and file access", async () => {
    const spawnCalls = mockSpawnSuccess({ ...SUCCESS, structured_output: { text: "t", sources: [], queries: [] } });
    await new AntigravityCliProvider(undefined, undefined, null).completeGroundedText("pergunta");
    expect(spawnCalls[0]!.stdin).toMatch(/Não execute comandos de terminal nem abra arquivos/);
  });

  it("throws LlmOutputError on an empty answer without denied_actions", async () => {
    mockSpawnSuccess({ ...SUCCESS, response: "   " });
    const provider = new AntigravityCliProvider(undefined, undefined, null);
    await expect(provider.completeJson("q", z.any())).rejects.toThrow(/agy retornou resposta vazia/);
  });

  it("runs at most ANTIGRAVITY_CLI_CONCURRENCY (default 2) agy processes at once", async () => {
    let active = 0;
    let peak = 0;
    const spawnCalls = mockSpawn(
      { stdout: JSON.stringify({ ...SUCCESS, structured_output: {} }), delayMs: 30 },
      () => (peak = Math.max(peak, ++active)),
      () => active--,
    );
    const provider = new AntigravityCliProvider(undefined, undefined, null);
    await Promise.all([1, 2, 3, 4].map(() => provider.completeJson("q", z.object({}))));
    expect(spawnCalls).toHaveLength(4);
    expect(peak).toBe(2);
  });

  it("completeGroundedText asks for sources/queries via --json-schema and dedupes sources", async () => {
    const structured_output = {
      text: "A Voyager 1 foi lançada em 1977.",
      sources: [{ uri: "https://nasa.gov/voyager", title: "NASA" }, { uri: "https://nasa.gov/voyager" }],
      queries: ["voyager 1 launch"],
    };
    const spawnCalls = mockSpawnSuccess({ ...SUCCESS, structured_output });
    const provider = new AntigravityCliProvider(undefined, undefined, null);
    const result = await provider.completeGroundedText("Quando a Voyager 1 foi lançada?");

    expect(result).toEqual({
      text: "A Voyager 1 foi lançada em 1977.",
      sources: [{ uri: "https://nasa.gov/voyager", title: "NASA" }],
      queries: ["voyager 1 launch"],
    });
    const args = spawnCalls[0]!.args;
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1]!)).toMatchObject({ required: ["text", "sources", "queries"] });
    expect(args).toContain("--sandbox");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(spawnCalls[0]!.stdin).toMatch(/pesquise na web[\s\S]*Quando a Voyager 1/);
    expect(spawnCalls[0]!.stdin).not.toContain("Responda diretamente");
    expect(drainLlmUsage()[0]).toMatchObject({ provider: "antigravity-cli", grounded: true });
  });

  it("fallback is off by default: CLI errors propagate even with GEMINI_API_KEY set", async () => {
    vi.stubEnv("GEMINI_API_KEY", "AIzaFAKE_not_a_real_key_000000000000000");
    vi.stubEnv("ANTIGRAVITY_FALLBACK", "");
    mockSpawnFailure(1, "boom");
    const provider = new AntigravityCliProvider();
    await expect(provider.completeJson("q", z.any())).rejects.toThrow(/agy finalizou com código 1/);
    await expect(provider.completeGroundedText("q")).rejects.toThrow(/agy finalizou com código 1/);
  });

  it("ANTIGRAVITY_FALLBACK=gemini without GEMINI_API_KEY creates no fallback", async () => {
    vi.stubEnv("ANTIGRAVITY_FALLBACK", "gemini");
    vi.stubEnv("GEMINI_API_KEY", "");
    mockSpawnFailure(1, "boom");
    await expect(new AntigravityCliProvider().completeJson("q", z.any())).rejects.toThrow(/agy finalizou com código 1/);
  });

  it("ANTIGRAVITY_FALLBACK=gemini uses the injected fallback for JSON and grounded calls", async () => {
    vi.stubEnv("ANTIGRAVITY_FALLBACK", "gemini");
    mockSpawnFailure(1, "boom");
    const fallback = fakeFallback();
    const provider = new AntigravityCliProvider(undefined, undefined, fallback);
    expect(await provider.completeJson("q", z.any())).toBe('{"fallback": true}');
    expect(await provider.completeGroundedText("q")).toEqual({ text: "grounded", sources: [], queries: [] });
    expect(fallback.completeJson).toHaveBeenCalledTimes(1);
    expect(fallback.completeGroundedText).toHaveBeenCalledTimes(1);
  });
});
