/**
 * Central secret redaction for anything that may reach logs, context.json or the console: library error
 * messages (e.g. requests' "for url: ...?key=..."), subprocess stderr, adapter error arrays.
 */

/** Env vars whose literal values must never appear in output. */
export const SECRET_ENV_VARS = [
  "GEMINI_API_KEY",
  "ANTHROPIC_API_KEY",
  "YOUTUBE_API_KEY",
  "PEXELS_API_KEY",
  "PIXABAY_API_KEY",
] as const;

export const REDACTED = "***";

const SECRET_NAMES = "key|api_key|apikey|token|access_token|refresh_token|id_token|client_secret|code_verifier";
/** query strings and form bodies: "?key=..", "&token=..", and a form body's first "client_secret=.." */
const QUERY_SECRET = new RegExp(`((?:^|[?&\\s"'])(?:${SECRET_NAMES})=)[^&\\s"'<>]+`, "gi");
/** JSON bodies: "refresh_token": "..." */
const JSON_SECRET = new RegExp(`("(?:${SECRET_NAMES})"\\s*:\\s*")[^"]*(")`, "gi");
const BEARER = /(\bBearer\s+)[A-Za-z0-9._~+/-]+=*/g;
/** Short values would mask ordinary words; real keys are long. */
const MIN_LITERAL_LENGTH = 8;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function secretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  return SECRET_ENV_VARS.map((name) => env[name]?.trim() ?? "").filter((v) => v.length >= MIN_LITERAL_LENGTH);
}

/** Masks secret query parameters, bearer tokens and literal values of the known secret env vars. */
export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text.replace(QUERY_SECRET, `$1${REDACTED}`).replace(JSON_SECRET, `$1${REDACTED}$2`).replace(BEARER, `$1${REDACTED}`);
  for (const value of secretValues(env)) out = out.replace(new RegExp(escapeRegExp(value), "g"), REDACTED);
  return out;
}

/** Redacts every string inside a JSON-like value (adapter error arrays, API payloads). */
export function redactDeep<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof value === "string") return redactSecrets(value, env) as T;
  if (Array.isArray(value)) return value.map((v: unknown) => redactDeep(v, env)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, env)])) as T;
  }
  return value;
}
