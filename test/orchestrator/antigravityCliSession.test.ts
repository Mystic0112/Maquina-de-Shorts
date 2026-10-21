import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as childProcess from "node:child_process";
import { AntigravityCliProvider, drainLlmUsage } from "../../src/orchestrator/lib/llmClient.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

type Reply = { result: Record<string, unknown> } | "hang" | "die";

interface FakeProcess {
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  prompts: string[];
  kill: ReturnType<typeof vi.fn>;
  stdinEnded: boolean;
}

/** Fake stream-json agy: one stdin line per question, `reply(n)` decides the answer (n counts all questions). */
function mockStreamAgy(reply: (n: number, prompt: string) => Reply): FakeProcess[] {
  const processes: FakeProcess[] = [];
  let questions = 0;
  vi.mocked(childProcess.spawn).mockImplementation((_command, args, options) => {
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    let closed = false;
    const close = (code: number | null): void => {
      if (closed) return;
      closed = true;
      setImmediate(() => child.emit("close", code));
    };
    child.kill = vi.fn(() => close(null));
    const proc: FakeProcess = { args: args as string[], cwd: String(options.cwd), env: options.env as any, prompts: [], kill: child.kill, stdinEnded: false };
    processes.push(proc);
    child.stdout.write('{"event":"init","conversation_id":"c","init":{"model":"m"}}\n{}\n');
    let buffer = "";
    child.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, nl)) as { event: string; message: { content: string } };
        buffer = buffer.slice(nl + 1);
        expect(message.event).toBe("user");
        proc.prompts.push(message.message.content);
        const answer = reply(++questions, message.message.content);
        if (answer === "hang") continue;
        if (answer === "die") {
          child.stderr.write("crashed");
          close(1);
          continue;
        }
        // Split the result line in two chunks to exercise the line buffering.
        const line = `${JSON.stringify({ event: "result", result: answer.result })}\n`;
        setImmediate(() => {
          child.stdout.write('{"event":"step_update"}\n' + line.slice(0, 10));
          child.stdout.write(line.slice(10));
        });
      }
    });
    child.stdin.on("finish", () => {
      proc.stdinEnded = true;
      close(0);
    });
    return child;
  });
  return processes;
}

const ok = (response: string, cumulative = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0 }): Reply => ({
  result: { status: "SUCCESS", response, usage: cumulative },
});

const schema = z.object({ score: z.number() });
const image = { mimeType: "image/jpeg" as const, data: Buffer.from([0xff, 0xd8]) };

describe("AntigravityCliProvider session mode (ANTIGRAVITY_CLI_SESSION_TURNS)", () => {
  let provider: AntigravityCliProvider | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    drainLlmUsage();
    vi.stubEnv("ANTIGRAVITY_CLI_SESSION_TURNS", "6");
    vi.stubEnv("ANTIGRAVITY_FALLBACK", "none");
  });

  afterEach(async () => {
    await provider?.closeSessions();
    provider = undefined;
    vi.unstubAllEnvs();
  });

  it("answers several questions in one stream-json process with the same security flags", async () => {
    vi.stubEnv("GEMINI_API_KEY", "AIzaFAKE_not_a_real_key_000000000000000");
    const procs = mockStreamAgy((n) => ok(`{"score": ${n}}`));
    provider = new AntigravityCliProvider(undefined, undefined, null);
    for (const n of [1, 2, 3]) expect(await provider.completeJson("Avalie", schema, [], { thinking: "low" })).toBe(`{"score": ${n}}`);

    expect(procs).toHaveLength(1);
    const { args, cwd, env, prompts } = procs[0]!;
    expect(args).toEqual(expect.arrayContaining(["--input-format", "stream-json", "--output-format", "--sandbox", "--disable-slash-commands"]));
    expect(args.filter((a) => a === "stream-json")).toHaveLength(2);
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--json-schema");
    expect(args[args.indexOf("--model") + 1]).toBe("gemini-3.8-flash-low");
    expect(cwd).toMatch(/agy-img-/);
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toMatch(/^Responda diretamente[\s\S]*Avalie[\s\S]*JSON Schema: \{.*"score"/);
  });

  it("records per-question usage as the delta of the cumulative session usage", async () => {
    const cumulative = [
      { input_tokens: 100, output_tokens: 10, thinking_tokens: 1, cache_read_tokens: 5000 },
      { input_tokens: 250, output_tokens: 30, thinking_tokens: 4, cache_read_tokens: 9000 },
    ];
    mockStreamAgy((n) => ({ result: { status: "SUCCESS", response: "{}", usage: cumulative[n - 1] } }));
    provider = new AntigravityCliProvider(undefined, undefined, null);
    await provider.completeJson("a", z.object({}));
    await provider.completeJson("b", z.object({}));
    expect(drainLlmUsage().map((u) => [u.inputTokens, u.outputTokens, u.thinkingTokens])).toEqual([
      [100, 10, 1],
      [150, 20, 3],
    ]);
  });

  it("closes the session after N questions and opens a new one", async () => {
    vi.stubEnv("ANTIGRAVITY_CLI_SESSION_TURNS", "2");
    const procs = mockStreamAgy(() => ok("{}"));
    provider = new AntigravityCliProvider(undefined, undefined, null);
    for (let i = 0; i < 3; i++) await provider.completeJson("q", z.object({}));
    expect(procs.map((p) => p.prompts.length)).toEqual([2, 1]);
    await vi.waitFor(() => expect(existsSync(procs[0]!.cwd)).toBe(false));
    expect(procs[0]!.stdinEnded).toBe(true);
  });

  it("a timeout kills the session process and the next question gets a new one", async () => {
    vi.stubEnv("ANTIGRAVITY_CLI_TIMEOUT_S", "0.05");
    vi.stubEnv("ANTIGRAVITY_CLI_CONCURRENCY", "1");
    const procs = mockStreamAgy((n) => (n === 1 ? "hang" : ok("{}")));
    provider = new AntigravityCliProvider(undefined, undefined, null);
    const [first, second] = await Promise.allSettled([
      provider.completeJson("q1", z.object({})),
      // Concurrency 1 forces the second question to wait behind the hung one.
      new Promise((r) => setTimeout(r, 5)).then(() => provider!.completeJson("q2", z.object({}))),
    ]);
    expect(first).toMatchObject({ status: "rejected", reason: { message: expect.stringMatching(/tempo limite/) } });
    expect(second).toMatchObject({ status: "fulfilled", value: "{}" });
    expect(procs[0]!.kill).toHaveBeenCalledWith("SIGKILL");
    expect(procs).toHaveLength(2);
  });

  it("status ERROR rejects only that question; the session keeps answering", async () => {
    const procs = mockStreamAgy((n) => (n === 2 ? { result: { status: "ERROR", error: "model overloaded" } } : ok("{}")));
    provider = new AntigravityCliProvider(undefined, undefined, null);
    await provider.completeJson("q1", z.object({}));
    await expect(provider.completeJson("q2", z.object({}))).rejects.toThrow(/status ERROR: model overloaded/);
    await provider.completeJson("q3", z.object({}));
    expect(procs).toHaveLength(1);
    expect(procs[0]!.prompts).toHaveLength(3);
  });

  it("empty answers fail like the one-shot path; a crashed process is replaced", async () => {
    const procs = mockStreamAgy((n) => (n === 1 ? ok("  ") : n === 2 ? "die" : ok("{}")));
    provider = new AntigravityCliProvider(undefined, undefined, null);
    await expect(provider.completeJson("q1", z.object({}))).rejects.toThrow(/resposta vazia/);
    await expect(provider.completeJson("q2", z.object({}))).rejects.toThrow(/código 1: crashed/);
    expect(await provider.completeJson("q3", z.object({}))).toBe("{}");
    expect(procs.map((p) => p.prompts.length)).toEqual([2, 1]);
  });

  it("images get unique per-turn names in the session folder; image and text questions use different sessions", async () => {
    const procs = mockStreamAgy(() => ok('{"score": 1}'));
    provider = new AntigravityCliProvider(undefined, undefined, null);
    await provider.completeJson("img1", schema, [image]);
    await provider.completeJson("img2", schema, [image, image]);
    await provider.completeJson("txt", schema);
    expect(procs).toHaveLength(2);
    const [imgProc, txtProc] = procs;
    expect(imgProc!.prompts[0]).toMatch(/view_file[\s\S]*t1_frame_0\.jpg[\s\S]*img1/);
    expect(imgProc!.prompts[1]).toMatch(/t2_frame_0\.jpg[\s\S]*t2_frame_1\.jpg/);
    expect(existsSync(`${imgProc!.cwd}/t1_frame_0.jpg`)).toBe(true);
    expect(txtProc!.prompts[0]).toMatch(/^Responda diretamente/);
  });

  it("never runs more than ANTIGRAVITY_CLI_CONCURRENCY sessions", async () => {
    vi.stubEnv("ANTIGRAVITY_CLI_CONCURRENCY", "2");
    const procs = mockStreamAgy(() => ok("{}"));
    provider = new AntigravityCliProvider(undefined, undefined, null);
    await Promise.all([1, 2, 3, 4, 5].map(() => provider!.completeJson("q", z.object({}))));
    expect(procs).toHaveLength(2);
    // A different model has to evict an idle session instead of opening a third one.
    await provider.completeJson("q", z.object({}), [], { model: "other-model" });
    expect(procs).toHaveLength(3);
    await vi.waitFor(() => expect(procs.filter((p) => p.stdinEnded)).toHaveLength(1));
  });

  it("grounded calls stay one-shot even in session mode", async () => {
    vi.mocked(childProcess.spawn).mockImplementationOnce((_c, args) => {
      const child = new EventEmitter() as any;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = vi.fn();
      child.stdin.on("finish", () => {
        expect(args).toContain("--json-schema");
        expect(args).not.toContain("stream-json");
        child.stdout.end(JSON.stringify({ status: "SUCCESS", structured_output: { text: "t", sources: [], queries: [] } }));
        setImmediate(() => child.emit("close", 0));
      });
      return child;
    });
    provider = new AntigravityCliProvider(undefined, undefined, null);
    expect((await provider.completeGroundedText("q")).text).toBe("t");
  });

  it("ANTIGRAVITY_CLI_SESSION_TURNS=0 keeps the one-shot json path", async () => {
    vi.stubEnv("ANTIGRAVITY_CLI_SESSION_TURNS", "0");
    let args: string[] = [];
    vi.mocked(childProcess.spawn).mockImplementation((_c, a) => {
      args = a as string[];
      const child = new EventEmitter() as any;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = vi.fn();
      child.stdin.on("finish", () => {
        child.stdout.end(JSON.stringify({ status: "SUCCESS", structured_output: { score: 1 } }));
        setImmediate(() => child.emit("close", 0));
      });
      return child;
    });
    provider = new AntigravityCliProvider(undefined, undefined, null);
    expect(await provider.completeJson("q", schema)).toBe('{"score":1}');
    expect(args).toContain("--json-schema");
    expect(args).not.toContain("stream-json");
  });
});
