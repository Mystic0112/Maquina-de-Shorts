/**
 * LLM provider backed by the Antigravity CLI (`agy`), which spends the owner's plan credits instead of
 * API billing. Each call is one sandboxed `agy --output-format json` process fed through stdin. The CLI
 * has no image flag: images are written to a temp folder used as the child's cwd and the prompt asks the
 * agent to view them. Security rules (do not weaken): --sandbox, --disable-slash-commands, cwd in a
 * temp folder holding only the images, minimal child env without API keys, never
 * --dangerously-skip-permissions.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { minimalChildEnv } from "./childEnv.js";
import { env } from "./config.js";
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
const DEFAULT_TIMEOUT_S = 180;
const DEFAULT_CONCURRENCY = 2;
/** Grace period after --print-timeout before we kill the process ourselves. */
const KILL_GRACE_MS = 30_000;
const STDERR_TAIL_CHARS = 1500;

/** Without --dangerously-skip-permissions any tool call is refused and the answer comes back empty. */
const DIRECT_ANSWER_INSTRUCTION = "Responda diretamente, sem executar comandos nem ler arquivos.";

const EFFORT: Record<ThinkingSetting, string> = { default: "medium", minimal: "low", low: "low", medium: "medium", high: "high" };

const GroundedSchema = z.object({
  text: z.string(),
  sources: z.array(z.object({ uri: z.string(), title: z.string().optional() })),
  queries: z.array(z.string()),
});

interface CliWrapper {
  status?: string;
  response?: string;
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

  constructor(cliPath?: string, model?: string, fallback?: LlmProvider | null) {
    this.cliPath = cliPath || env("ANTIGRAVITY_CLI_PATH") || DEFAULT_ANTIGRAVITY_CLI_PATH;
    this.model = model || env("ANTIGRAVITY_MODEL") || DEFAULT_ANTIGRAVITY_MODEL;
    this.fallbackProvider = fallback === null ? undefined : (fallback ?? fallbackFromEnv());
    this.timeoutS = Number(env("ANTIGRAVITY_CLI_TIMEOUT_S") ?? DEFAULT_TIMEOUT_S);
    this.semaphore = new Semaphore(Math.max(1, Number(env("ANTIGRAVITY_CLI_CONCURRENCY") ?? DEFAULT_CONCURRENCY)));
  }

  async completeJson(
    prompt: string,
    schema: z.ZodType,
    images: readonly LlmImage[] = [],
    options: CallOptions = {},
  ): Promise<string> {
    try {
      const result = await this.invokeAgy(images.length > 0 ? prompt : `${DIRECT_ANSWER_INSTRUCTION}\n\n${prompt}`, schema, images, options);
      return result.structured_output !== undefined ? JSON.stringify(result.structured_output) : (result.response ?? "");
    } catch (error) {
      if (!this.fallbackProvider) throw error;
      this.warnFallback(error);
      return await this.fallbackProvider.completeJson(prompt, schema, images, options);
    }
  }

  /** The CLI is an agent with a web search tool; we ask it to search and report its sources in the JSON. */
  async completeGroundedText(prompt: string, options: CallOptions = {}): Promise<GroundedText> {
    const wrapped = [
      "Antes de responder, pesquise na web (use sua ferramenta de busca) para fundamentar a resposta.",
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
      const { stdout, stderr } = await this.semaphore.run(() => this.spawnCli(args, tempDir, fullPrompt));
      return this.parseResult(stdout, stderr, modelToUse, grounded);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private buildArgs(schema: z.ZodType, options: CallOptions): { args: string[]; modelToUse: string } {
    const args = [
      "--output-format", "json",
      "--sandbox",
      "--disable-slash-commands",
      "--print-timeout", `${this.timeoutS}s`,
      "--json-schema", JSON.stringify(toGeminiJsonSchema(schema)),
    ];
    let modelToUse = this.model;
    if (options.thinking && (!this.model || this.model.startsWith("gemini-3.8-flash"))) {
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
        reject(error);
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
    if (wrapper.status && wrapper.status !== "SUCCESS") throw new LlmOutputError(`agy retornou status ${wrapper.status}`);
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
    // A refused tool call ends as SUCCESS with an empty response; surface what was denied.
    if (wrapper.structured_output === undefined && !wrapper.response?.trim()) {
      const denied = wrapper.denied_actions?.length ? ` (ações negadas: ${JSON.stringify(wrapper.denied_actions)})` : "";
      throw new LlmOutputError(`agy retornou resposta vazia${denied}${tail(stderr)}`);
    }
    return wrapper;
  }
}

const EXT: Record<LlmImage["mimeType"], string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

async function writeImages(dir: string, images: readonly LlmImage[]): Promise<string[]> {
  const files: string[] = [];
  for (const [i, img] of images.entries()) {
    const filePath = join(dir, `frame_${i}.${EXT[img.mimeType]}`);
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
