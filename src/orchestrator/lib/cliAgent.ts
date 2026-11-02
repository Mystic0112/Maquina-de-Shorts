/**
 * LLM provider for "command-line coding agents" that run on the user's own plan login, with no API key
 * (Claude Code today; Codex, opencode and Cursor later). One generic provider + one data object per agent
 * (`CliAgentProfile`). The agy provider (antigravityCli.ts) is separate and untouched.
 *
 * Security rules (AGENTS.md rule 2, do not weaken; they apply to every profile):
 *  - each call runs in a fresh EMPTY temp folder that holds only the images of that call (the child's cwd);
 *  - the child env is `minimalChildEnv` (an allowlist: no API keys) plus `profile.extraEnv`, minus `profile.neverEnv`
 *    (e.g. ANTHROPIC_API_KEY: with it the CLI would bill the API instead of the plan);
 *  - tools are off, or only the strictly needed one (read the images / web search); NEVER a flag that skips
 *    permissions and NEVER a rule that allows terminal commands.
 *
 * Profile contract (what a new agent must fill in):
 *  - `command`/`pathEnv`/`modelEnv`/`defaultModel`: executable, env var that overrides its path, env var and default
 *    for the model id of that agent;
 *  - `baseArgs`: headless + JSON output + no session on disk + no user customizations + no permission prompts;
 *  - `toolArgs(mode)`: flags per mode ("text" no tools, "images" read-only access to the temp folder, "search" web
 *    search only); `schemaArgs`, `modelArgs`, `effortArgs`: how to ask for a schema, a model and an effort;
 *  - `imagePrompt`/`searchPrompt`/`directInstruction`: how the prompt asks the agent to look at files / search / just answer;
 *  - `parseOutput(stdout)`: turns stdout into `CliAgentOutput` (structured answer, text, token usage, is-error flag);
 *    `undefined` = stdout is not the agent's JSON (the text is then used as the plain answer);
 *  - `authErrorPattern`/`missingCommandMessage`: texts for "not logged in" and "command not found";
 *  - plan quota errors need no field: the text of a failed call goes through `quotaErrorFrom` (lib/quota.ts), which
 *    throws the typed QuotaExhaustedError the per-task fallback and the loop already understand.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Semaphore, tail, writeImages } from "./antigravityCli.js";
import { minimalChildEnv } from "./childEnv.js";
import { env } from "./config.js";
import {
  dedupeSources,
  LlmOutputError,
  recordLlmUsage,
  toGeminiJsonSchema,
  type CallOptions,
  type GroundedText,
  type LlmImage,
  type LlmProvider,
  type LlmProviderName,
  type ThinkingSetting,
} from "./llmClient.js";
import { quotaErrorFrom } from "./quota.js";

export type CliAgentMode = "text" | "images" | "search";

export interface CliAgentOutput {
  /** The agent ended in an error; `text` says why (quota, login...). */
  isError: boolean;
  structured?: unknown;
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface CliAgentProfile {
  provider: LlmProviderName;
  command: string;
  pathEnv: string;
  modelEnv: string;
  defaultModel: string;
  extraEnv: readonly string[];
  neverEnv: readonly string[];
  baseArgs: readonly string[];
  toolArgs(mode: CliAgentMode): string[];
  schemaArgs(schemaJson: string): string[];
  modelArgs(model: string): string[];
  effortArgs(thinking: ThinkingSetting): string[];
  directInstruction: string;
  imagePrompt(files: readonly string[], prompt: string): string;
  searchPrompt(prompt: string): string;
  parseOutput(stdout: string): CliAgentOutput | undefined;
  authErrorPattern: RegExp;
  missingCommandMessage(cliPath: string): string;
}

const DEFAULT_TIMEOUT_S = 240;
const DEFAULT_CONCURRENCY = 2;

const GroundedSchema = z.object({
  text: z.string(),
  sources: z.array(z.object({ uri: z.string(), title: z.string().optional() })),
  queries: z.array(z.string()),
});

export interface CliAgentOptions {
  cliPath?: string;
  model?: string;
  /** Env names for timeout (seconds) and concurrency, e.g. CLAUDE_CLI_TIMEOUT_S. */
  timeoutEnv?: string;
  concurrencyEnv?: string;
}

export class CliAgentProvider implements LlmProvider {
  readonly name: LlmProviderName;
  readonly model: string;
  private readonly cliPath: string;
  private readonly timeoutS: number;
  private readonly semaphore: Semaphore;

  constructor(
    private readonly profile: CliAgentProfile,
    opts: CliAgentOptions = {},
  ) {
    this.name = profile.provider;
    this.cliPath = opts.cliPath || env(profile.pathEnv) || profile.command;
    this.model = opts.model || env(profile.modelEnv) || profile.defaultModel;
    this.timeoutS = Number(env(opts.timeoutEnv ?? "") ?? DEFAULT_TIMEOUT_S) || DEFAULT_TIMEOUT_S;
    this.semaphore = new Semaphore(Math.max(1, Number(env(opts.concurrencyEnv ?? "") ?? DEFAULT_CONCURRENCY) || DEFAULT_CONCURRENCY));
  }

  async completeJson(prompt: string, schema: z.ZodType, images: readonly LlmImage[] = [], options: CallOptions = {}): Promise<string> {
    const out = await this.run(prompt, schema, images, options, images.length > 0 ? "images" : "text");
    return out.structured !== undefined ? JSON.stringify(out.structured) : out.text;
  }

  /** The agent searches the web with its own tool and reports sources in the JSON (same contract as the agy provider). */
  async completeGroundedText(prompt: string, options: CallOptions = {}): Promise<GroundedText> {
    const out = await this.run(prompt, GroundedSchema, [], options, "search");
    const parsed = GroundedSchema.safeParse(out.structured);
    if (!parsed.success) return { text: out.text, sources: [], queries: [] };
    return { ...parsed.data, sources: dedupeSources(parsed.data.sources) };
  }

  /** Arguments of one call (pure; exported through the provider for tests of the contract). */
  buildArgs(schema: z.ZodType, options: CallOptions, mode: CliAgentMode): string[] {
    const p = this.profile;
    const effort = options.thinking ? p.effortArgs(options.thinking) : [];
    return [...p.baseArgs, ...p.toolArgs(mode), ...p.schemaArgs(JSON.stringify(toGeminiJsonSchema(schema))), ...p.modelArgs(options.model ?? this.model), ...effort];
  }

  private async run(prompt: string, schema: z.ZodType, images: readonly LlmImage[], options: CallOptions, mode: CliAgentMode): Promise<CliAgentOutput> {
    const p = this.profile;
    const tempDir = await mkdtemp(join(tmpdir(), "cli-agent-"));
    try {
      const files = await writeImages(tempDir, images);
      const fullPrompt = mode === "images" ? p.imagePrompt(files, prompt) : mode === "search" ? p.searchPrompt(prompt) : `${p.directInstruction}\n\n${prompt}`;
      const args = this.buildArgs(schema, options, mode);
      const { stdout, stderr, code } = await this.semaphore.run(() => this.spawnCli(args, tempDir, fullPrompt));
      return this.check(stdout, stderr, code, options.model ?? this.model, mode === "search");
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private check(stdout: string, stderr: string, code: number | null, model: string, grounded: boolean): CliAgentOutput {
    const p = this.profile;
    const out = p.parseOutput(stdout) ?? { isError: false, text: stdout.trim() };
    // Usage first: a failed call may still have spent tokens.
    if (out.usage) {
      recordLlmUsage({ provider: this.name, model, inputTokens: out.usage.inputTokens, outputTokens: out.usage.outputTokens, ...(grounded ? { grounded: true } : {}) });
    }
    if (out.isError || code !== 0) {
      const text = [out.text, stderr, out.text ? "" : stdout].join("\n").trim();
      // Plan quota first: typed error, so the per-task fallback and the loop stop/switch instead of retrying.
      const quota = quotaErrorFrom(this.name, text);
      if (quota) throw quota;
      if (p.authErrorPattern.test(text)) {
        throw new Error(`${p.command}: sem login. Abra o ${p.command} num terminal e entre com a sua conta do plano (nenhuma chave de API é usada).`);
      }
      throw new Error(`${p.command} finalizou com código ${code}: ${text.slice(-600)}`);
    }
    if (out.structured === undefined && !out.text.trim()) throw new LlmOutputError(`${p.command} retornou resposta vazia${tail(stderr)}`);
    return out;
  }

  private spawnCli(args: readonly string[], cwd: string, prompt: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const childEnv = minimalChildEnv(this.profile.extraEnv, process.env);
    for (const name of this.profile.neverEnv) {
      for (const key of Object.keys(childEnv)) if (key.toLowerCase() === name.toLowerCase()) delete childEnv[key];
    }
    return new Promise((resolve, reject) => {
      const child = spawn(this.cliPath, [...args], { cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let out = "";
      let err = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, this.timeoutS * 1000);
      child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
      child.on("error", (error) => {
        clearTimeout(timer);
        const missing = ["ENOENT", "EINVAL"].includes((error as NodeJS.ErrnoException).code ?? "");
        reject(missing ? new Error(this.profile.missingCommandMessage(this.cliPath)) : error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) reject(new Error(`${this.profile.command} excedeu o tempo limite de ${this.timeoutS} s${tail(err)}`));
        else resolve({ stdout: out, stderr: err, code });
      });
      child.stdin.on("error", () => undefined); // EPIPE when the child died early: "close" reports it
      child.stdin.write(prompt, "utf8");
      child.stdin.end();
    });
  }
}
