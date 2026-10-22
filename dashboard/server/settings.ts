// Read/write of the user-editable config files (config/pipeline.config.json, config/topics.seed.json).
// Validation reuses the pipeline's own zod schema (src/orchestrator/lib/config.ts); the file is written
// exactly as submitted (unknown keys survive), atomically, after backing up the previous version.
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { PipelineConfigSchema } from "../../src/orchestrator/lib/config.js";
import {
  CAPTION_DEFAULTS,
  CAPTION_FONTS,
  resolveCaptions,
  resolveScript,
  resolveVisual,
  resolveVoiceExtras,
  SCRIPT_DEFAULTS,
  VISUAL_DEFAULTS,
  VOICE_EXTRAS_DEFAULTS,
  WATERMARK_DEFAULTS,
} from "../../src/shared/settings.js";
import type { FieldError, KeyStatus, SettingsPayload, TopicsPayload } from "../shared/api.js";
import { envIsSet, envValue, paths, projectRoot } from "./config.js";

const BACKUP_DIR = join(projectRoot, "config", "backups");

/** Thrown for user-fixable problems; the route turns it into a 4xx with field errors. */
export class SettingsError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly errors: FieldError[] = [],
  ) {
    super(message);
  }
}

export const versionOf = (text: string): string => createHash("sha1").update(text).digest("hex").slice(0, 16);

async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch {
    throw new SettingsError(500, `Não foi possível ler ${basename(file)}.`);
  }
}

function parseJson(text: string, file: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SettingsError(500, `${basename(file)} não é um JSON válido.`);
  }
}

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

/** Backup + write-to-temp + rename, so the pipeline never reads a half-written file. */
export async function atomicWrite(file: string, data: unknown): Promise<string> {
  await mkdir(BACKUP_DIR, { recursive: true });
  const backup = join(BACKUP_DIR, `${stamp()}-${basename(file)}`);
  if (existsSync(file)) await copyFile(file, backup);
  const text = `${JSON.stringify(data, null, 2)}\n`;
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text, "utf8");
  // Windows can refuse a rename while another process has the file open: retry briefly.
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, file);
      break;
    } catch (error) {
      if (attempt >= 5) {
        await rm(tmp, { force: true });
        throw error;
      }
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
    }
  }
  return backup;
}

/* ---------- zod issues -> pt-BR field errors ---------- */
interface ZodIssueLike {
  code: string;
  path: PropertyKey[];
  message: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  inclusive?: boolean;
  origin?: string;
  expected?: string;
  values?: unknown[];
}

function translate(issue: ZodIssueLike): string {
  const custom = !/^(Too|Invalid|Expected|Unrecognized)/.test(issue.message);
  if (custom) return issue.message;
  const n = (v: number | bigint | undefined) => String(v).replace(".", ",");
  switch (issue.code) {
    case "too_small":
      if (issue.origin === "string") return Number(issue.minimum) <= 1 ? "Campo obrigatório." : `Mínimo de ${n(issue.minimum)} caracteres.`;
      if (issue.origin === "array") return `Informe pelo menos ${n(issue.minimum)} item(ns).`;
      return issue.inclusive ? `O valor mínimo é ${n(issue.minimum)}.` : `Deve ser maior que ${n(issue.minimum)}.`;
    case "too_big":
      if (issue.origin === "string") return `Máximo de ${n(issue.maximum)} caracteres.`;
      return issue.inclusive ? `O valor máximo é ${n(issue.maximum)}.` : `Deve ser menor que ${n(issue.maximum)}.`;
    case "invalid_type":
      return issue.expected === "int" ? "Use um número inteiro." : `Tipo inválido (esperado: ${issue.expected ?? "outro"}).`;
    case "invalid_value":
      return `Opção inválida. Use: ${(issue.values ?? []).join(", ")}.`;
    case "invalid_format":
      return "Formato inválido.";
    case "not_multiple_of":
      return "Use um número inteiro.";
    default:
      return "Valor inválido.";
  }
}

const pathOf = (path: PropertyKey[]): string => path.map(String).join(".");

/** zod issues -> the pt-BR field errors the Configurações page shows. */
export const fieldErrors = (issues: readonly { path: PropertyKey[] }[]): FieldError[] =>
  issues.map((i) => ({ path: pathOf(i.path), message: translate(i as ZodIssueLike) }));

/* ---------- pipeline settings ---------- */
function crossFieldErrors(config: z.infer<typeof PipelineConfigSchema>): FieldError[] {
  const errors: FieldError[] = [];
  if (config.video.minSeconds > config.video.maxSeconds) {
    errors.push({ path: "video.maxSeconds", message: "A duração máxima deve ser maior ou igual à mínima." });
  }
  const s = config.script;
  if (s?.minWords != null && s.maxWords != null && s.minWords > s.maxWords) {
    errors.push({ path: "script.maxWords", message: "O máximo de palavras deve ser maior ou igual ao mínimo." });
  }
  if (s?.minScenes != null && s.maxScenes != null && s.minScenes > s.maxScenes) {
    errors.push({ path: "script.maxScenes", message: "O máximo de cenas deve ser maior ou igual ao mínimo." });
  }
  return errors;
}

function keyStatus(): KeyStatus[] {
  const fileFromEnv = (name: string, fallback: string): boolean => {
    const rel = envValue(name) ?? fallback;
    return existsSync(join(projectRoot, rel));
  };
  return [
    { name: "GEMINI_API_KEY", label: "Gemini (roteiro e filtro visual)", configured: envIsSet("GEMINI_API_KEY") },
    { name: "YOUTUBE_API_KEY", label: "YouTube Data API (estatísticas públicas)", configured: envIsSet("YOUTUBE_API_KEY") },
    { name: "PEXELS_API_KEY", label: "Pexels (footage)", configured: envIsSet("PEXELS_API_KEY") },
    { name: "YOUTUBE_CHANNEL_ID", label: "ID do canal (inscritos)", configured: envIsSet("YOUTUBE_CHANNEL_ID") },
    {
      name: "YT_CLIENT_SECRET_PATH",
      label: "OAuth: client secret do Google",
      configured: fileFromEnv("YT_CLIENT_SECRET_PATH", "secrets/youtube.client_secret.json"),
    },
    {
      name: "YT_TOKEN_PATH",
      label: "OAuth: token do canal (npm run auth:youtube)",
      configured: fileFromEnv("YT_TOKEN_PATH", "secrets/youtube.token.json"),
    },
  ];
}

let jsonSchemaCache: unknown;
const jsonSchema = (): unknown =>
  (jsonSchemaCache ??= z.toJSONSchema(PipelineConfigSchema, { io: "input", unrepresentable: "any" }));

export async function getSettings(): Promise<SettingsPayload> {
  const text = await readText(paths.pipelineConfig);
  const config = parseJson(text, paths.pipelineConfig) as Record<string, unknown>;
  const parsed = PipelineConfigSchema.safeParse(config);
  const typed = parsed.success ? parsed.data : undefined;
  return {
    version: versionOf(text),
    config,
    valid: parsed.success,
    errors: parsed.success ? [] : parsed.error.issues.map((i) => ({ path: pathOf(i.path), message: translate(i as ZodIssueLike) })),
    resolved: {
      captions: resolveCaptions(typed?.captions),
      visual: resolveVisual(typed?.visual),
      script: resolveScript(typed?.script),
      voice: resolveVoiceExtras(typed?.voice),
    },
    defaults: {
      captions: CAPTION_DEFAULTS,
      visual: VISUAL_DEFAULTS,
      script: SCRIPT_DEFAULTS,
      voice: VOICE_EXTRAS_DEFAULTS,
      watermark: WATERMARK_DEFAULTS,
    },
    fonts: CAPTION_FONTS,
    schema: jsonSchema(),
    keys: keyStatus(),
  };
}

export async function putSettings(body: unknown, expectedVersion: string | undefined): Promise<{ version: string; backup: string }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new SettingsError(400, "Envie o objeto de configuração completo.");
  }
  const current = await readText(paths.pipelineConfig);
  if (expectedVersion && expectedVersion !== versionOf(current)) {
    throw new SettingsError(409, "O arquivo foi alterado por outro processo desde que você abriu a página. Recarregue para ver a versão atual.");
  }
  const parsed = PipelineConfigSchema.safeParse(body);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((i) => ({ path: pathOf(i.path), message: translate(i as ZodIssueLike) }));
    throw new SettingsError(422, "Corrija os campos destacados.", errors);
  }
  const cross = crossFieldErrors(parsed.data);
  if (cross.length) throw new SettingsError(422, "Corrija os campos destacados.", cross);
  const backup = await atomicWrite(paths.pipelineConfig, body); // body, not parsed.data: unknown keys survive
  return { version: versionOf(`${JSON.stringify(body, null, 2)}\n`), backup: basename(backup) };
}

/* ---------- topics ---------- */
const TOPIC_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

function validateTopics(body: unknown): FieldError[] {
  const errors: FieldError[] = [];
  const categories = (body as { categories?: unknown } | null)?.categories;
  if (!Array.isArray(categories)) return [{ path: "categories", message: "Envie a lista de categorias." }];
  if (categories.length === 0) errors.push({ path: "categories", message: "Mantenha pelo menos uma categoria." });
  const seen = new Set<string>();
  categories.forEach((raw: unknown, i) => {
    const c = (raw ?? {}) as { id?: unknown; label?: unknown; prompts?: unknown };
    if (typeof c.id !== "string" || !TOPIC_ID.test(c.id)) {
      errors.push({ path: `categories.${i}.id`, message: "Use letras minúsculas, números e hífen (ex.: ciencia)." });
    } else if (seen.has(c.id)) {
      errors.push({ path: `categories.${i}.id`, message: `O id "${c.id}" está repetido.` });
    } else seen.add(c.id);
    if (typeof c.label !== "string" || !c.label.trim()) errors.push({ path: `categories.${i}.label`, message: "Campo obrigatório." });
    if (!Array.isArray(c.prompts) || c.prompts.length === 0) {
      errors.push({ path: `categories.${i}.prompts`, message: "Adicione pelo menos um prompt." });
    } else {
      c.prompts.forEach((p: unknown, j) => {
        if (typeof p !== "string" || !p.trim()) errors.push({ path: `categories.${i}.prompts.${j}`, message: "O prompt não pode ficar vazio." });
      });
    }
  });
  return errors;
}

export async function getTopics(): Promise<TopicsPayload> {
  const text = await readText(paths.topicsConfig);
  const data = parseJson(text, paths.topicsConfig) as TopicsPayload["data"];
  return { version: versionOf(text), data, errors: validateTopics(data) };
}

export async function putTopics(body: unknown, expectedVersion: string | undefined): Promise<{ version: string; backup: string }> {
  const current = await readText(paths.topicsConfig);
  if (expectedVersion && expectedVersion !== versionOf(current)) {
    throw new SettingsError(409, "Os temas foram alterados por outro processo. Recarregue para ver a versão atual.");
  }
  const errors = validateTopics(body);
  if (errors.length) throw new SettingsError(422, "Corrija os campos destacados.", errors);
  const backup = await atomicWrite(paths.topicsConfig, body);
  return { version: versionOf(`${JSON.stringify(body, null, 2)}\n`), backup: basename(backup) };
}
