import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi, beforeEach } from "vitest";
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
}

function mockSpawnSuccess(responseObj: { status?: string; response?: string; usage?: Record<string, number> }, exitCode = 0) {
  const spawnCalls: SpawnCall[] = [];
  vi.mocked(childProcess.spawn).mockImplementation((command, args, options) => {
    spawnCalls.push({ command, args: args as string[], options });
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();

    child.stdin.on("finish", () => {
      process.nextTick(() => {
        child.stdout.write(JSON.stringify(responseObj));
        child.stdout.end();
        child.stderr.end();
        child.emit("close", exitCode);
      });
    });

    return child;
  });
  return spawnCalls;
}

function mockSpawnFailure(exitCode: number, stderrText = "Process failed") {
  const spawnCalls: SpawnCall[] = [];
  vi.mocked(childProcess.spawn).mockImplementation((command, args, options) => {
    spawnCalls.push({ command, args: args as string[], options });
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();

    child.stdin.on("finish", () => {
      process.nextTick(() => {
        child.stderr.write(stderrText);
        child.stdout.end();
        child.stderr.end();
        child.emit("close", exitCode);
      });
    });

    return child;
  });
  return spawnCalls;
}

describe("AntigravityCliProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    drainLlmUsage();
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

    const fallback: LlmProvider = {
      name: "gemini",
      model: "gemini-flash-latest",
      completeJson: vi.fn().mockResolvedValue('{"fallback": true}'),
      completeGroundedText: vi.fn().mockResolvedValue({ text: "grounded", sources: [], queries: [] }),
    };

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
});
