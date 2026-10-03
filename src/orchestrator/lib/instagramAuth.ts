import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { env, paths } from "./config.js";
import { uniqueTmpPath } from "./fileLock.js";
import {
  defaultHttp,
  formBody,
  GRAPH_HOST,
  graphUrl,
  InstagramApiError,
  OAUTH_HOST,
  requestJson,
  stringField,
  unwrapData,
  type HttpFetch,
} from "./instagramApi.js";
import { registerSecret } from "./redact.js";

/**
 * Business Login for Instagram ("Instagram API with Instagram Login"):
 * authorize (instagram.com) -> code -> short-lived token (api.instagram.com, 1 h) -> long-lived token
 * (graph.instagram.com/access_token, 60 days) -> refresh (graph.instagram.com/refresh_access_token).
 * https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login
 *
 * Secrets never reach logs: errors mention file paths only, and every loaded token is registered with the
 * redactor so a stray echo of it is masked.
 */

export const INSTAGRAM_SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
  "instagram_business_manage_insights",
] as const;

/** Must be registered verbatim in the Meta app (Instagram > API setup with Instagram login > Business login settings). */
export const INSTAGRAM_REDIRECT_URI = "https://mystic0112.github.io/Maquina-de-Shorts/oauth/callback.html";
export const AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
export const AUTH_COMMAND = "npm run auth:instagram";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Refresh once fewer than this many days remain (Meta allows refreshing tokens at least 24 h old). */
export const REFRESH_WHEN_DAYS_LEFT = 10;
const MIN_TOKEN_AGE_FOR_REFRESH_MS = DAY_MS;

export function instagramTokenPath(): string {
  return paths.fromRoot("secrets", "instagram.token.json");
}

// ---------------------------------------------------------------------------------------------
// App credentials (.env)
// ---------------------------------------------------------------------------------------------

export interface AppCredentials {
  appId: string;
  appSecret: string;
}

export function loadAppCredentials(read: (name: string) => string | undefined = env): AppCredentials {
  const appId = read("INSTAGRAM_APP_ID");
  const appSecret = read("INSTAGRAM_APP_SECRET");
  const missing = [!appId && "INSTAGRAM_APP_ID", !appSecret && "INSTAGRAM_APP_SECRET"].filter(Boolean);
  if (!appId || !appSecret) throw new Error(`Faltam no .env: ${missing.join(", ")} (Meta app > Instagram > API setup with Instagram login).`);
  if (!/^\d{5,25}$/.test(appId)) throw new Error("INSTAGRAM_APP_ID no .env deve ser o número do Instagram App ID.");
  registerSecret(appSecret);
  return { appId, appSecret };
}

// ---------------------------------------------------------------------------------------------
// state = "<loopback port>.<nonce>" (the GitHub Pages callback validates the same pattern)
// ---------------------------------------------------------------------------------------------

/** Kept in sync with docs/oauth/callback.html (a test checks it). */
export const STATE_PATTERN = /^([1-9][0-9]{3,4})\.([0-9a-f]{32})$/;

export function createState(port: number, nonce: string = randomBytes(16).toString("hex")): string {
  const state = `${port}.${nonce}`;
  if (!parseState(state)) throw new Error(`Invalid OAuth state for port ${port}`);
  return state;
}

export function parseState(state: string): { port: number; nonce: string } | undefined {
  const match = STATE_PATTERN.exec(state);
  if (!match) return undefined;
  const port = Number(match[1]);
  if (port < 1024 || port > 65535) return undefined;
  return { port, nonce: match[2] as string };
}

export function buildAuthorizeUrl(appId: string, state: string, redirectUri = INSTAGRAM_REDIRECT_URI): string {
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: INSTAGRAM_SCOPES.join(","),
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

// ---------------------------------------------------------------------------------------------
// Callback parsing (loopback request or text pasted in the terminal)
// ---------------------------------------------------------------------------------------------

const CODE_PATTERN = /^[A-Za-z0-9_.-]{10,2048}$/;

export class AuthCallbackError extends Error {}

/** Meta appends "#_" to the redirect; it is not part of the code. */
export function cleanCode(raw: string): string | undefined {
  const code = raw.trim().replace(/#_?$/, "");
  return CODE_PATTERN.test(code) ? code : undefined;
}

/** Query of the loopback /callback request (or of a pasted callback URL): error, state check, code. */
export function parseCallbackParams(params: URLSearchParams, expectedState: string): string {
  const error = params.get("error");
  if (error) {
    const reason = params.get("error_reason") ?? params.get("error_description") ?? error;
    throw new AuthCallbackError(`Autorização negada ou cancelada (${reason.replace(/[^\w .,+-]/g, "").slice(0, 80)}).`);
  }
  if (params.get("state") !== expectedState) throw new AuthCallbackError("Resposta com 'state' inválido (rode o comando de novo).");
  const code = cleanCode(params.get("code") ?? "");
  if (!code) throw new AuthCallbackError("Resposta sem código de autorização válido.");
  return code;
}

/**
 * Text pasted in the terminal: the bare code shown by the callback page, or a full URL containing
 * `code=` (whose state is then checked).
 */
export function parseCallbackInput(input: string, expectedState: string): string {
  const text = input.trim();
  if (/[?&]code=|[?&]error=/.test(text)) {
    let params: URLSearchParams;
    try {
      params = new URL(text).searchParams;
    } catch {
      params = new URLSearchParams(text.slice(text.indexOf("?") + 1));
    }
    return parseCallbackParams(params, expectedState);
  }
  const code = cleanCode(text);
  if (!code) throw new AuthCallbackError("Isso não parece um código de autorização (copie o código inteiro da página).");
  return code;
}

// ---------------------------------------------------------------------------------------------
// Token file (secrets/instagram.token.json)
// ---------------------------------------------------------------------------------------------

export const InstagramTokenSchema = z.object({
  accessToken: z.string().min(10),
  tokenType: z.string().optional(),
  /** ISO time the long-lived token expires. */
  expiresAt: z.string(),
  /** ISO time this token was issued (login or last refresh); refresh needs it to be >= 24 h old. */
  issuedAt: z.string(),
  /** Instagram professional account id (<IG_ID>) used in /<IG_ID>/media paths. */
  userId: z.string().min(1),
  username: z.string().optional(),
  accountType: z.string().optional(),
  permissions: z.array(z.string()).optional(),
});

export type InstagramToken = z.infer<typeof InstagramTokenSchema>;

/** Atomic write (unique tmp + rename, owner-only mode): a crash never corrupts the only copy. */
export async function saveInstagramToken(token: InstagramToken, file = instagramTokenPath()): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = uniqueTmpPath(file);
  try {
    await writeFile(tmp, `${JSON.stringify(token, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

function parseTokenFile(text: string, file: string): InstagramToken {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`Instagram token file ${file} is not valid JSON. Run "${AUTH_COMMAND}" again.`);
  }
  const parsed = InstagramTokenSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Instagram token file ${file} is incomplete. Run "${AUTH_COMMAND}" again.`);
  registerSecret(parsed.data.accessToken);
  return parsed.data;
}

export async function loadInstagramToken(file = instagramTokenPath()): Promise<InstagramToken> {
  if (!existsSync(file)) throw new Error(`Instagram token not found (${file}). Run "${AUTH_COMMAND}" once to authorize the account.`);
  return parseTokenFile(await readFile(file, "utf8"), file);
}

/** Sync variant for publisher blockers (which are synchronous). */
export function readInstagramTokenSync(file = instagramTokenPath()): InstagramToken {
  if (!existsSync(file)) throw new Error(`Instagram token not found (${file}). Run "${AUTH_COMMAND}" once to authorize the account.`);
  return parseTokenFile(readFileSync(file, "utf8"), file);
}

export function tokenExpired(token: Pick<InstagramToken, "expiresAt">, now: Date): boolean {
  const expires = Date.parse(token.expiresAt);
  return !Number.isFinite(expires) || expires <= now.getTime();
}

/** Reasons the stored token cannot publish (empty = usable). */
export function instagramTokenProblems(file: string, now: Date): string[] {
  let token: InstagramToken;
  try {
    token = readInstagramTokenSync(file);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  if (tokenExpired(token, now)) return [`Instagram token expired at ${token.expiresAt}. Run "${AUTH_COMMAND}" again.`];
  return [];
}

export function needsRefresh(token: Pick<InstagramToken, "expiresAt" | "issuedAt">, now: Date): boolean {
  if (tokenExpired(token, now)) return false; // expired tokens cannot be refreshed: log in again
  const left = Date.parse(token.expiresAt) - now.getTime();
  const age = now.getTime() - Date.parse(token.issuedAt);
  return left < REFRESH_WHEN_DAYS_LEFT * DAY_MS && Number.isFinite(age) && age >= MIN_TOKEN_AGE_FOR_REFRESH_MS;
}

// ---------------------------------------------------------------------------------------------
// Token endpoints
// ---------------------------------------------------------------------------------------------

function expiresAtFrom(json: Record<string, unknown>, now: Date): string {
  const seconds = Number(json.expires_in);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new InstagramApiError("Token response without a valid expires_in");
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

export interface ShortLivedToken {
  accessToken: string;
  userId?: string;
  permissions: string[];
}

/** POST api.instagram.com/oauth/access_token (form body; the code is valid for 1 h, single use). */
export async function exchangeCode(code: string, creds: AppCredentials, http: HttpFetch = defaultHttp, redirectUri = INSTAGRAM_REDIRECT_URI): Promise<ShortLivedToken> {
  const json = unwrapData(
    await requestJson(http, `${OAUTH_HOST}/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({ client_id: creds.appId, client_secret: creds.appSecret, grant_type: "authorization_code", redirect_uri: redirectUri, code }),
    }),
  );
  const accessToken = stringField(json, "access_token");
  if (!accessToken) throw new InstagramApiError("Code exchange returned no access_token");
  registerSecret(accessToken);
  const permissions = Array.isArray(json.permissions)
    ? json.permissions.map(String)
    : (stringField(json, "permissions") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  return { accessToken, userId: stringField(json, "user_id"), permissions };
}

/** GET graph.instagram.com/access_token?grant_type=ig_exchange_token (60-day token). */
export async function exchangeForLongLived(shortToken: string, appSecret: string, http: HttpFetch = defaultHttp, now = new Date()): Promise<{ accessToken: string; tokenType?: string; expiresAt: string }> {
  const url = `${GRAPH_HOST}/access_token?${new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: appSecret, access_token: shortToken }).toString()}`;
  const json = await requestJson(http, url, { method: "GET" });
  const accessToken = stringField(json, "access_token");
  if (!accessToken) throw new InstagramApiError("Long-lived token exchange returned no access_token");
  registerSecret(accessToken);
  return { accessToken, tokenType: stringField(json, "token_type"), expiresAt: expiresAtFrom(json, now) };
}

export interface InstagramProfile {
  userId: string;
  username?: string;
  accountType?: string;
}

/** GET /me?fields=user_id,username,account_type (user_id = the professional account id, <IG_ID>). */
export async function fetchProfile(accessToken: string, http: HttpFetch = defaultHttp): Promise<InstagramProfile> {
  const json = unwrapData(await requestJson(http, graphUrl("me", { fields: "user_id,username,account_type", access_token: accessToken }), { method: "GET" }));
  const userId = stringField(json, "user_id") ?? stringField(json, "id");
  if (!userId) throw new InstagramApiError("/me returned no user_id");
  return { userId, username: stringField(json, "username"), accountType: stringField(json, "account_type") };
}

/** Full login after the code arrives: short token -> long-lived token -> profile -> saved file. */
export async function completeLogin(
  code: string,
  creds: AppCredentials,
  options: { http?: HttpFetch; now?: Date; file?: string } = {},
): Promise<InstagramToken> {
  const http = options.http ?? defaultHttp;
  const now = options.now ?? new Date();
  const short = await exchangeCode(code, creds, http);
  const long = await exchangeForLongLived(short.accessToken, creds.appSecret, http, now);
  const profile = await fetchProfile(long.accessToken, http);
  const token: InstagramToken = {
    accessToken: long.accessToken,
    tokenType: long.tokenType,
    expiresAt: long.expiresAt,
    issuedAt: now.toISOString(),
    userId: profile.userId,
    username: profile.username,
    accountType: profile.accountType,
    permissions: short.permissions,
  };
  await saveInstagramToken(token, options.file);
  return token;
}

/** GET graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token: another 60 days. */
export async function refreshToken(token: InstagramToken, http: HttpFetch = defaultHttp, now = new Date()): Promise<InstagramToken> {
  const url = `${GRAPH_HOST}/refresh_access_token?${new URLSearchParams({ grant_type: "ig_refresh_token", access_token: token.accessToken }).toString()}`;
  const json = await requestJson(http, url, { method: "GET" });
  const accessToken = stringField(json, "access_token");
  if (!accessToken) throw new InstagramApiError("Token refresh returned no access_token");
  registerSecret(accessToken);
  return { ...token, accessToken, tokenType: stringField(json, "token_type") ?? token.tokenType, expiresAt: expiresAtFrom(json, now), issuedAt: now.toISOString() };
}

export interface FreshTokenOptions {
  file?: string;
  http?: HttpFetch;
  now?: Date;
  /** Warnings (refresh failed but the current token still works). */
  warn?: (message: string) => void;
}

/**
 * Loads the token and, when fewer than 10 days remain, refreshes it and persists the rotated token
 * before returning it. An expired token throws (a new login is needed); a failed refresh of a token that
 * still works only warns.
 */
export async function ensureFreshToken(options: FreshTokenOptions = {}): Promise<InstagramToken> {
  const file = options.file ?? instagramTokenPath();
  const now = options.now ?? new Date();
  const token = await loadInstagramToken(file);
  if (tokenExpired(token, now)) throw new Error(`Instagram token expired at ${token.expiresAt}. Run "${AUTH_COMMAND}" again.`);
  if (!needsRefresh(token, now)) return token;
  try {
    const fresh = await refreshToken(token, options.http ?? defaultHttp, now);
    await saveInstagramToken(fresh, file);
    return fresh;
  } catch (error) {
    options.warn?.(`Could not refresh the Instagram token (expires ${token.expiresAt}): ${error instanceof Error ? error.message : String(error)}`);
    return token;
  }
}
