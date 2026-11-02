/**
 * API keys typed in the dashboard (Configurações > Chaves). They live in secrets/api-keys.json: outside git, written
 * atomically with mode 0600 (POSIX; on Windows the file inherits the owner-only ACL of the user's profile folder).
 * The pipeline loads them into process.env at start (a value already set in the environment or .env wins), so every
 * existing `env("GEMINI_API_KEY")` keeps working. The dashboard API only ever reports whether a key is set, never its
 * value, and never writes keys to config/pipeline.config.json or to logs.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerSecret } from "./redact.js";

export interface StorableKey {
  name: string;
  label: string;
}

/** The only names the store accepts (the panel cannot write arbitrary environment variables). */
export const STORABLE_KEYS: readonly StorableKey[] = [
  { name: "GEMINI_API_KEY", label: "Gemini (roteiro, filtro visual e voz; API paga)" },
  { name: "ANTHROPIC_API_KEY", label: "Anthropic / Claude (API paga)" },
  { name: "YOUTUBE_API_KEY", label: "YouTube Data API (estatísticas públicas)" },
  { name: "PEXELS_API_KEY", label: "Pexels (imagens)" },
  { name: "PIXABAY_API_KEY", label: "Pixabay (imagens e sons)" },
];

export const STORE_FILE = "api-keys.json";
/** Printable ASCII without spaces: what real API keys look like. Keeps pasted junk, newlines and JSON out. */
const VALUE_PATTERN = /^[\x21-\x7e]{8,512}$/;

export const isStorableKey = (name: string): boolean => STORABLE_KEYS.some((k) => k.name === name);

/** Where the store lives; MAQUINA_SECRETS_DIR points tests (and odd setups) elsewhere. */
export function secretsDir(root: string): string {
  return process.env["MAQUINA_SECRETS_DIR"]?.trim() || join(root, "secrets");
}

export class SecretStoreError extends Error {}

export function validateKeyValue(value: unknown): string {
  if (typeof value !== "string") throw new SecretStoreError("Envie a chave como texto.");
  const trimmed = value.trim();
  // The message never repeats the value.
  if (!VALUE_PATTERN.test(trimmed)) throw new SecretStoreError("A chave deve ter de 8 a 512 caracteres, sem espaços nem quebras de linha.");
  return trimmed;
}

function storePath(dir: string): string {
  return join(dir, STORE_FILE);
}

/** Stored keys; unknown names and non-string values in the file are ignored. A missing/corrupt file is an empty store. */
export function readStore(dir: string): Record<string, string> {
  const file = storePath(dir);
  if (!existsSync(file)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object") return {};
    return Object.fromEntries(Object.entries(raw).filter(([k, v]) => isStorableKey(k) && typeof v === "string" && v.length > 0)) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeStore(dir: string, keys: Record<string, string>): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = storePath(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Windows: no POSIX modes; the profile folder's ACL applies.
  }
  renameSync(tmp, file);
}

export function setStoredKey(dir: string, name: string, value: unknown): void {
  if (!isStorableKey(name)) throw new SecretStoreError("Esta chave não pode ser guardada pelo painel.");
  const key = validateKeyValue(value);
  writeStore(dir, { ...readStore(dir), [name]: key });
  registerSecret(key);
}

/** True when the key was in the store. */
export function removeStoredKey(dir: string, name: string): boolean {
  const keys = readStore(dir);
  if (!(name in keys)) return false;
  delete keys[name];
  if (Object.keys(keys).length === 0) rmSync(storePath(dir), { force: true });
  else writeStore(dir, keys);
  return true;
}

/** Fills the variables the environment (or .env) left unset and masks every stored value in logs. */
export function applyStoredKeys(dir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const applied: string[] = [];
  for (const [name, value] of Object.entries(readStore(dir))) {
    registerSecret(value);
    if (env[name]?.trim()) continue;
    env[name] = value;
    applied.push(name);
  }
  return applied;
}
