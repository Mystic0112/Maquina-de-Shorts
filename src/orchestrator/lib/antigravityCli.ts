/**
 * LLM provider backed by the Antigravity CLI (`agy`), which spends the owner's plan credits instead of
 * API billing. Each call is one sandboxed `agy --output-format json` process fed through stdin. The CLI
 * has no image flag: images are written to a temp folder used as the child's cwd and the prompt asks the
 * agent to view them. Security rules (do not weaken): --sandbox, --disable-slash-commands, cwd in a
 * temp folder holding only the images, minimal child env without API keys, never
 * --dangerously-skip-permissions.
 *
 * ANTIGRAVITY_CLI_SESSION_TURNS > 0 turns on the continuous-session mode for `completeJson`: questions go
 * to long-lived stream-json processes (see antigravitySession.ts) that are recycled after that many turns.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { minimalChildEnv } from "./childEnv.js";
import { env } from "./config.js";
import { AgySession, describeAgySpawnError } from "./antigravitySession.js";
import {
  dedupeSources,
  getProviderByName,
  LlmOutputError,
  recordLlmUsage,
  toGeminiJsonSchema,
  type CallOptions,
  type GroundedText,
  type LlmImage,
  type LlmProvider,
  type ThinkingSetting,
} from "./llmClient.js";

export const DEFAULT_ANTIGRAVITY_MODEL = "gemini-3.8-flash-medium";
export const DEFAULT_ANTIGRAVITY_CLI_PATH = "agy";
const DEFAULT_TIMEOUT_S = 240;
const DEFAULT_CONCURRENCY = 2;
/** Grace period after --print-timeout before we kill the process ourselves. */
const KILL_GRACE_MS = 30_000;
const STDERR_TAIL_CHARS = 1500;

/** Without --dangerously-skip-permissions any tool call is refused and the answer comes back empty. */
const DIRECT_ANSWER_INSTRUCTION = "Responda diretamente, sem executar comandos nem ler arquivos.";
/** Prepended on the one retry after the sandbox refused a tool call (the model tried a terminal command). */
const DENIED_RETRY_REMINDER =
  "IMPORTANTE: na tentativa anterior você tentou executar um comando e ele foi negado. NÃO execute comandos de terminal " +
  "nem abra arquivos que não foram indicados; use apenas a ferramenta de busca na web (quando pedida) e responda com o JSON.";

/**
 * Marks an LlmOutputError caused by the sandbox refusing a tool call (recoverable with a reminder). A symbol
 * instead of a subclass: llmClient.ts imports this module, so LlmOutputError is not constructed yet at load time.
 */
const DENIED_TOOL = Symbol("deniedTool");
export const isDeniedToolError = (error: unknown): boolean => typeof error === "object" && error !== null && DENIED_TOOL in error;

const EFFORT: Record<ThinkingSetting, string> = { default: "medium", minimal: "low", low: "low", medium: "medium", high: "high" };

const GroundedSchema = z.object({
  text: z.string(),
  sources: z.array(z.object({ uri: z.string(), title: z.string().optional() })),
  queries: z.array(z.string()),
});

interface CliWrapper {
  status?: string;
  response?: string;
  error?: string;
  structured_output?: unknown;
  /** Tools the agent tried to use and was refused (we never skip permissions). */
  denied_actions?: Array<{ action?: string; display_name?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number; thinking_tokens?: number };
}

/** ponytail: FIFO semaphore; enough for a handful of parallel clip reviews. */
class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

/**
 * Fallback to the paid Gemini API is off by default (owner's decision: zero cost). `fallback` injected
 * explicitly always wins; `null` disables it; `undefined` defers to ANTIGRAVITY_FALLBACK=none|gemini.
 */
function fallbackFromEnv(): LlmProvider | undefined {
  const mode = (env("ANTIGRAVITY_FALLBACK") ?? "none").toLowerCase();
  if (mode === "gemini" && env("GEMINI_API_KEY")) return getProviderByName("gemini");
  return undefined;
}

export class AntigravityCliProvider implements LlmProvider {
  readonly name = "antigravity-cli" as const;
  readonly model: string;
  private readonly cliPath: string;
  private readonly fallbackProvider?: LlmProvider;
  private readonly timeoutS: number;
  private readonly semaphore: Semaphore;
  private readonly concurrency: number;
  /** 0 = one process per call (original behaviour). */
  private readonly sessionTurns: number;
  /** Idle sessions per key (effective model args + whether the question carries images). */
  private readonly idleSessions = new Map<string, AgySession[]>();
  /** Open sessions (busy or idle); never more than `concurrency`. */
  private readonly openSessions = new Set<AgySession>();

  constructor(cliPath?: string, model?: string, fallback?: LlmProvider | null) {
    this.cliPath = cliPath || env("ANTIGRAVITY_CLI_PATH") || DEFAULT_ANTIGRAVITY_CLI_PATH;
    this.model = model || env("ANTIGRAVITY_MODEL") || DEFAULT_ANTIGRAVITY_MODEL;
    this.fallbackProvider = fallback === null ? undefined : (fallback ?? fallbackFromEnv());
    this.timeoutS = Number(env("ANTIGRAVITY_CLI_TIMEOUT_S") ?? DEFAULT_TIMEOUT_S);
    this.concurrency = Math.max(1, Number(env("ANTIGRAVITY_CLI_CONCURRENCY") ?? DEFAULT_CONCURRENCY));
    this.semaphore = new Semaphore(this.concurrency);
    this.sessionTurns = Math.max(0, Math.floor(Number(env("ANTIGRAVITY_CLI_SESSION_TURNS") ?? 0)) || 0);
  }

  /** Closes every open session. Optional: idle sessions never keep Node alive and are killed on exit. */
  async closeSessions(): Promise<void> {
    const sessions = [...this.openSessions];
    this.openSessions.clear();
    this.idleSessions.clear();
    await Promise.all(sessions.map((s) => s.close()));
  }

  async completeJson(
    prompt: string,
    schema: z.ZodType,
    images: readonly LlmImage[] = [],
    options: CallOptions = {},
  ): Promise<string> {
    try {
      const ownPrompt = images.length > 0 ? prompt : `${DIRECT_ANSWER_INSTRUCTION}\n\n${prompt}`;
      if (this.sessionTurns > 0) return (await this.askInSession(ownPrompt, schema, images, options)).response ?? "";
      const result = await this.invokeAgy(ownPrompt, schema, images, options);
      return result.structured_output !== undefined ? JSON.stringify(result.structured_output) : (result.response ?? "");
    } catch (error) {
      if (!this.fallbackProvider) throw error;
      this.warnFallback(error);
      return await this.fallbackProvider.completeJson(prompt, schema, images, options);
    }
  }

  /**
   * The CLI is an agent with a web search tool; we ask it to search and report its sources in the JSON.
   * Always a one-shot process, even in session mode: grounded calls are few (fact check), long, and rely
   * on --json-schema, which stream-json applies only to the first answer of a session.
   */
  async completeGroundedText(prompt: string, options: CallOptions = {}): Promise<GroundedText> {
    const wrapped = [
      "Antes de responder, pesquise na web (use sua ferramenta de busca) para fundamentar a resposta.",
      "Não execute comandos de terminal nem abra arquivos: só a ferramenta de busca na web e a sua resposta.",
      "Responda em JSON com: text (a resposta completa), sources (as páginas consultadas, cada uma com uri = URL completa e title)",
      "e queries (as buscas que você fez). Se não conseguir pesquisar, responda mesmo assim com sources vazio.",
      "",
      prompt,
    ].join("\n");
    try {
      const result = await this.invokeAgy(wrapped, GroundedSchema, [], options, true);
      const parsed = GroundedSchema.safeParse(result.structured_output);
      if (!parsed.success) return { text: result.response ?? "", sources: [], queries: [] };
      return { ...parsed.data, sources: dedupeSources(parsed.data.sources) };
    } catch (error) {
      if (!this.fallbackProvider) throw error;
      this.warnFallback(error);
      return await this.fallbackProvider.completeGroundedText(prompt, options);
    }
  }

  private warnFallback(error: unknown): void {
    console.warn(
      `[antigravity-cli] Falha no CLI (${error instanceof Error ? error.message : String(error)}). Recorrendo ao fallback ${this.fallbackProvider?.name}...`,
    );
  }

  private async invokeAgy(
    prompt: string,
    schema: z.ZodType,
    images: readonly LlmImage[],
    options: CallOptions,
    grounded = false,
  ): Promise<CliWrapper> {
    const tempDir = await mkdtemp(join(tmpdir(), "agy-img-"));
    try {
      const tempFiles = await writeImages(tempDir, images);
      const fullPrompt = tempFiles.length > 0 ? imagePrompt(tempFiles, prompt) : prompt;
      const { args, modelToUse } = this.buildArgs(schema, options);
      try {
        const { stdout, stderr } = await this.semaphore.run(() => this.spawnCli(args, tempDir, fullPrompt));
        return this.parseResult(stdout, stderr, modelToUse, grounded);
      } catch (error) {
        if (!isDeniedToolError(error)) throw error;
        // One retry: the model usually answers directly once told the tool is off-limits (seen in fact checks).
        console.warn(`[antigravity-cli] comando negado pelo sandbox; repetindo a chamada com lembrete (${modelToUse})`);
        const { stdout, stderr } = await this.semaphore.run(() => this.spawnCli(args, tempDir, `${DENIED_RETRY_REMINDER}\n\n${fullPrompt}`));
        return this.parseResult(stdout, stderr, modelToUse, grounded);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Session mode. No --json-schema: under stream-json the CLI enforces it only on the first answer, adds a
   * "finish" turn and repeats the first structured_output on later results, so the schema goes in the prompt
   * and the caller validates the text with zod. No --print-timeout either (we time each question ourselves).
   */
  private async askInSession(prompt: string, schema: z.ZodType, images: readonly LlmImage[], options: CallOptions): Promise<CliWrapper> {
    const { args: modelArgs, modelToUse } = this.modelArgs(options);
    const key = `${modelArgs.join(" ")}|${images.length > 0 ? "images" : "text"}`;
    const schemaLine = `O JSON deve seguir este JSON Schema: ${JSON.stringify(toGeminiJsonSchema(schema))}`;
    return await this.semaphore.run(async () => {
      const session = await this.takeSession(key, modelArgs);
      try {
        const files = await writeImages(session.dir, images, `t${session.turns + 1}_`);
        const fullPrompt = files.length > 0 ? imagePrompt(files, prompt) : `${prompt}\n\nResponda somente com o JSON.`;
        const answer = await session.ask(`${fullPrompt}\n${schemaLine}`, this.timeoutS * 1000);
        // cache_read_tokens (answer.usage) has no LlmCallUsage field; it is the instructions reused from the session.
        const usage = { input_tokens: answer.usage.input_tokens, output_tokens: answer.usage.output_tokens, thinking_tokens: answer.usage.thinking_tokens };
        const { status, response, error, denied_actions } = answer.result;
        return this.checkWrapper({ status, response, error, denied_actions, usage }, answer.stderr, modelToUse, false);
      } finally {
        this.releaseSession(key, session);
      }
    });
  }

  /** Called inside the semaphore, so at most `concurrency - 1` other sessions are busy. */
  private async takeSession(key: string, modelArgs: readonly string[]): Promise<AgySession> {
    const idle = this.idleSessions.get(key) ?? [];
    let session: AgySession | undefined;
    while ((session = idle.pop())) if (!session.dead) return session;
    if (this.openSessions.size >= this.concurrency) {
      // Make room by closing an idle session of another model/kind.
      for (const [otherKey, list] of this.idleSessions) {
        const victim = list.shift();
        if (!victim) continue;
        if (list.length === 0) this.idleSessions.delete(otherKey);
        this.openSessions.delete(victim);
        void victim.close();
        break;
      }
    }
    const args = ["--print=", "--input-format", "stream-json", "--output-format", "stream-json", "--sandbox", "--disable-slash-commands", ...modelArgs];
    const fresh = await AgySession.open(this.cliPath, args);
    this.openSessions.add(fresh);
    return fresh;
  }

  /** Back to the idle list, or closed when it died (timeout, crash) or reached ANTIGRAVITY_CLI_SESSION_TURNS. */
  private releaseSession(key: string, session: AgySession): void {
    if (!session.dead && session.turns < this.sessionTurns) {
      this.idleSessions.set(key, [...(this.idleSessions.get(key) ?? []), session]);
      return;
    }
    this.openSessions.delete(session);
    void session.close();
  }

  private buildArgs(schema: z.ZodType, options: CallOptions): { args: string[]; modelToUse: string } {
    const { args: modelArgs, modelToUse } = this.modelArgs(options);
    const args = [
      "--output-format", "json",
      "--sandbox",
      "--disable-slash-commands",
      "--print-timeout", `${this.timeoutS}s`,
      "--json-schema", JSON.stringify(toGeminiJsonSchema(schema)),
      ...modelArgs,
    ];
    return { args, modelToUse };
  }

  private modelArgs(options: CallOptions): { args: string[]; modelToUse: string } {
    const args: string[] = [];
    // An explicit per-call model wins over ANTIGRAVITY_MODEL and over the thinking -> flash-suffix mapping.
    let modelToUse = options.model ?? this.model;
    if (!options.model && options.thinking && (!this.model || this.model.startsWith("gemini-3.8-flash"))) {
      if (options.thinking === "minimal" || options.thinking === "low") modelToUse = "gemini-3.8-flash-low";
      else if (options.thinking === "high") modelToUse = "gemini-3.8-flash-high";
      else modelToUse = "gemini-3.8-flash-medium";
    }
    if (modelToUse) args.push("--model", modelToUse);
    if (options.thinking && !/-low|-medium|-high|-xhigh|-max$/.test(modelToUse)) {
      args.push("--effort", EFFORT[options.thinking] ?? "low");
    }
    return { args, modelToUse };
  }

  private spawnCli(args: readonly string[], cwd: string, prompt: string): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.cliPath, [...args], {
        cwd,
        env: minimalChildEnv([], process.env),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let out = "";
      let err = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, this.timeoutS * 1000 + KILL_GRACE_MS);
      child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(describeAgySpawnError(error, this.cliPath));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) reject(new Error(`agy excedeu o tempo limite de ${this.timeoutS} s${tail(err)}`));
        else if (code === 0) resolve({ stdout: out, stderr: err });
        else reject(new Error(`agy finalizou com código ${code}: ${err || out}`));
      });
      child.stdin.write(prompt, "utf8");
      child.stdin.end();
    });
  }

  private parseResult(stdout: string, stderr: string, modelToUse: string, grounded: boolean): CliWrapper {
    const rawText = stdout.trim();
    let wrapper: CliWrapper | undefined;
    try {
      wrapper = JSON.parse(rawText) as CliWrapper;
    } catch {
      // stdout is not the JSON wrapper: treat it as the plain answer
    }
    if (!wrapper) {
      if (!rawText) throw new LlmOutputError(`agy retornou resposta vazia${tail(stderr)}`);
      return { response: rawText };
    }
    return this.checkWrapper(wrapper, stderr, modelToUse, grounded);
  }

  private checkWrapper(wrapper: CliWrapper, stderr: string, modelToUse: string, grounded: boolean): CliWrapper {
    if (wrapper.usage) {
      recordLlmUsage({
        provider: this.name,
        model: modelToUse,
        inputTokens: wrapper.usage.input_tokens ?? 0,
        outputTokens: wrapper.usage.output_tokens ?? 0,
        thinkingTokens: wrapper.usage.thinking_tokens ?? 0,
        ...(grounded ? { grounded: true } : {}),
      });
    }
    // Usage first: a failed turn still spent tokens (and in session mode its delta is already consumed).
    if (wrapper.status && wrapper.status !== "SUCCESS") {
      throw new LlmOutputError(`agy retornou status ${wrapper.status}${wrapper.error ? `: ${wrapper.error}` : ""}`);
    }
    // A refused tool call ends as SUCCESS with an empty response; surface what was denied.
    if (wrapper.structured_output === undefined && !wrapper.response?.trim()) {
      if (wrapper.denied_actions?.length) {
        const error = new LlmOutputError(`agy retornou resposta vazia (ações negadas: ${JSON.stringify(wrapper.denied_actions)})${tail(stderr)}`);
        throw Object.assign(error, { [DENIED_TOOL]: true });
      }
      throw new LlmOutputError(`agy retornou resposta vazia${tail(stderr)}`);
    }
    return wrapper;
  }
}

const EXT: Record<LlmImage["mimeType"], string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

async function writeImages(dir: string, images: readonly LlmImage[], prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const [i, img] of images.entries()) {
    const filePath = join(dir, `${prefix}frame_${i}.${EXT[img.mimeType]}`);
    await writeFile(filePath, img.data);
    files.push(filePath);
  }
  return files;
}

/** Files are listed in the order the images were passed: "image N" in the prompt is the N-th file. */
function imagePrompt(files: readonly string[], prompt: string): string {
  const header =
    files.length === 1
      ? "Examine o seguinte arquivo de imagem usando APENAS a ferramenta view_file (não execute comandos no terminal nem use outras ferramentas):"
      : `Examine TODOS os ${files.length} arquivos de imagem abaixo usando APENAS a ferramenta view_file (não execute comandos no terminal nem use outras ferramentas). Eles estão na ordem em que são numerados nas instruções ("image 1" = o primeiro arquivo, "image 2" = o segundo, e assim por diante); arquivos diferentes podem pertencer a candidatos diferentes:`;
  return [
    header,
    ...files.map((f, i) => `- image ${i + 1}: "${f}"`),
    "",
    prompt,
    "",
    "Responda somente com o JSON correspondente.",
  ].join("\n");
}

function tail(text: string): string {
  const t = text.trim();
  return t ? `\n--- stderr ---\n${t.length > STDERR_TAIL_CHARS ? `...${t.slice(-STDERR_TAIL_CHARS)}` : t}` : "";
}
