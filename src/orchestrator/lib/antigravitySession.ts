/**
 * One long-lived `agy --input-format stream-json --output-format stream-json` process that answers several
 * questions in the same conversation, so the CLI's ~15-33k tokens of internal instructions are paid once
 * per session instead of once per call. Same security rules as the one-shot path (the caller builds the
 * args): --sandbox, --disable-slash-commands, cwd in a private temp folder holding only this session's
 * images, minimal child env without API keys, never --dangerously-skip-permissions.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { minimalChildEnv } from "./childEnv.js";

/** How long a closing session may take to exit after stdin ends before we kill it. */
const CLOSE_GRACE_MS = 5_000;
const STDERR_KEEP_CHARS = 3000;

export interface StreamUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
}

/** `result` event payload. `usage`/`duration_seconds` are cumulative for the whole session. */
export interface StreamResult {
  status?: string;
  response?: string;
  error?: string;
  denied_actions?: Array<{ action?: string; display_name?: string }>;
  usage?: StreamUsage;
}

export interface SessionAnswer {
  result: StreamResult;
  /** Usage of this question only (cumulative usage minus the previous result of the same session). */
  usage: Required<StreamUsage>;
  stderr: string;
}

interface Pending {
  resolve: (answer: SessionAnswer) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const liveSessions = new Set<AgySession>();
let exitHookInstalled = false;

/** Sessions are unref'd while idle; this kills whatever is still open when Node exits. */
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const session of liveSessions) session.killNow();
  });
}

const ZERO_USAGE: Required<StreamUsage> = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0 };

export class AgySession {
  turns = 0;
  dead = false;
  private stdoutBuffer = "";
  private stderrText = "";
  private pending?: Pending;
  private previousUsage = ZERO_USAGE;
  private exited: Promise<void>;

  private constructor(
    readonly dir: string,
    private readonly child: ChildProcessWithoutNullStreams,
  ) {
    // "error" too: a spawn failure (ENOENT) may never emit "close".
    this.exited = new Promise((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (this.stderrText = (this.stderrText + chunk.toString("utf8")).slice(-STDERR_KEEP_CHARS)));
    // EPIPE when the child already died: the "close" handler reports the failure.
    child.stdin.on("error", () => (this.dead = true));
    child.on("error", (error) => this.fail(error));
    child.on("close", (code) => this.fail(new Error(`agy finalizou com código ${code}: ${this.stderrText.trim() || "(sem stderr)"}`)));
    // ponytail: unref so an idle session never keeps Node alive; the per-question timer holds the loop while busy.
    for (const handle of [child, child.stdin, child.stdout, child.stderr]) (handle as { unref?: () => void }).unref?.();
  }

  static async open(cliPath: string, args: readonly string[]): Promise<AgySession> {
    const dir = await mkdtemp(join(tmpdir(), "agy-img-"));
    const child = spawn(cliPath, [...args], {
      cwd: dir,
      env: minimalChildEnv([], process.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const session = new AgySession(dir, child);
    liveSessions.add(session);
    installExitHook();
    return session;
  }

  /** One question at a time (the provider guarantees it). Timeout kills the process: the session is dead. */
  ask(prompt: string, timeoutMs: number): Promise<SessionAnswer> {
    if (this.dead) return Promise.reject(new Error("sessão do agy já encerrada"));
    if (this.pending) return Promise.reject(new Error("sessão do agy ocupada"));
    this.turns++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(`agy excedeu o tempo limite de ${Math.round(timeoutMs / 1000)} s${this.stderrTail()}`));
        this.killNow();
      }, timeoutMs);
      this.pending = { resolve, reject, timer };
      this.child.stdin.write(`${JSON.stringify({ event: "user", message: { content: prompt } })}\n`, "utf8");
    });
  }

  /** Graceful: end stdin, wait for exit, kill after a grace period, then delete the image folder. */
  async close(): Promise<void> {
    liveSessions.delete(this);
    this.dead = true;
    this.child.stdin.end();
    const killTimer = setTimeout(() => this.child.kill("SIGKILL"), CLOSE_GRACE_MS);
    await this.exited;
    clearTimeout(killTimer);
    await rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
  }

  /** Synchronous variant for the exit hook and timeouts. */
  killNow(): void {
    this.dead = true;
    this.child.kill("SIGKILL");
    if (!liveSessions.delete(this)) return;
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch {
      // the folder is in the OS temp dir; leaving it behind on exit is harmless
    }
  }

  stderrTail(): string {
    const t = this.stderrText.trim();
    return t ? `\n--- stderr ---\n${t}` : "";
  }

  private onStdout(text: string): void {
    this.stdoutBuffer += text;
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      this.onLine(line);
    }
  }

  /** Only `result` matters; `init`, `step_update` and the bare `{}` lines are progress noise. */
  private onLine(line: string): void {
    if (!line) return;
    let event: { event?: string; result?: StreamResult };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      return;
    }
    if (event.event !== "result" || !event.result || !this.pending) return;
    const { resolve, timer } = this.pending;
    this.pending = undefined;
    clearTimeout(timer);
    resolve({ result: event.result, usage: this.usageDelta(event.result.usage), stderr: this.stderrText });
  }

  private usageDelta(cumulative: StreamUsage = {}): Required<StreamUsage> {
    const current = { ...ZERO_USAGE, ...cumulative };
    const previous = this.previousUsage;
    this.previousUsage = current;
    const delta = (key: keyof StreamUsage): number => Math.max(0, current[key] - previous[key]);
    return {
      input_tokens: delta("input_tokens"),
      output_tokens: delta("output_tokens"),
      thinking_tokens: delta("thinking_tokens"),
      cache_read_tokens: delta("cache_read_tokens"),
    };
  }

  private fail(error: Error): void {
    this.dead = true;
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.reject(error);
  }
}
