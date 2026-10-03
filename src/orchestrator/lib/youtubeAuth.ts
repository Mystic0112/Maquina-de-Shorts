import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { OAuth2Client, type Credentials } from "google-auth-library";
import { z } from "zod";
import { env, paths } from "./config.js";

// Secrets never reach logs: errors below mention file paths only, never file contents or tokens.

export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
  "https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
] as const;

export const AUTH_COMMAND = "npm run auth:youtube";

export function clientSecretPath(): string {
  return paths.fromRoot(env("YT_CLIENT_SECRET_PATH") ?? "secrets/youtube.client_secret.json");
}

export function tokenPath(): string {
  return paths.fromRoot(env("YT_TOKEN_PATH") ?? "secrets/youtube.token.json");
}

const ClientSecretBlockSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  redirect_uris: z.array(z.string()).optional(),
});

const ClientSecretFileSchema = z.union([
  z.object({ installed: ClientSecretBlockSchema }),
  z.object({ web: ClientSecretBlockSchema }),
]);

export interface ClientSecret {
  clientId: string;
  clientSecret: string;
  kind: "installed" | "web";
}

/** Parses Google's downloaded OAuth client JSON ({"installed": {...}} for Desktop clients). */
export function parseClientSecret(raw: unknown): ClientSecret {
  const parsed = ClientSecretFileSchema.safeParse(raw);
  if (!parsed.success) throw new Error("OAuth client file is not a Google 'installed'/'web' client JSON");
  const [kind, block] = "installed" in parsed.data ? (["installed", parsed.data.installed] as const) : (["web", parsed.data.web] as const);
  return { clientId: block.client_id, clientSecret: block.client_secret, kind };
}

export async function loadClientSecret(file = clientSecretPath()): Promise<ClientSecret> {
  if (!existsSync(file)) throw new Error(`OAuth client file not found: ${file} (download it from Google Cloud Console)`);
  try {
    return parseClientSecret(JSON.parse(await readFile(file, "utf8")) as unknown);
  } catch (error) {
    throw new Error(`Cannot read OAuth client file ${file}: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
}

export function createOAuthClient(secret: ClientSecret, redirectUri?: string): OAuth2Client {
  return new OAuth2Client({ clientId: secret.clientId, clientSecret: secret.clientSecret, redirectUri });
}

/**
 * Merges freshly issued tokens into the stored ones. Google omits refresh_token on most refreshes, so the
 * old one must survive; when it does rotate, the new one wins.
 */
export function mergeTokens(stored: Credentials, fresh: Credentials): Credentials {
  const merged: Credentials = { ...stored };
  for (const [key, value] of Object.entries(fresh) as [keyof Credentials, Credentials[keyof Credentials]][]) {
    if (value !== undefined && value !== null) (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}

/** Atomic write (tmp + rename) so a crash mid-write never corrupts the only copy of the refresh token. */
export async function saveToken(tokens: Credentials, file = tokenPath()): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(tokens, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, file);
}

export async function loadToken(file = tokenPath()): Promise<Credentials> {
  if (!existsSync(file)) throw new Error(`YouTube token not found (${file}). Run "${AUTH_COMMAND}" once to authorize the channel.`);
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("refresh_token" in parsed)) {
    throw new Error(`YouTube token file ${file} has no refresh_token. Run "${AUTH_COMMAND}" again.`);
  }
  return parsed as Credentials;
}

/**
 * Persists every token refresh back to disk (serialised, so concurrent refreshes cannot interleave
 * writes). Returns a function that resolves once pending writes are flushed.
 */
export function persistTokenRefreshes(client: OAuth2Client, initial: Credentials, file = tokenPath()): () => Promise<void> {
  let current = initial;
  let pending: Promise<void> = Promise.resolve();
  client.on("tokens", (fresh: Credentials) => {
    current = mergeTokens(current, fresh);
    const snapshot = current;
    pending = pending.then(() => saveToken(snapshot, file)).catch((error: unknown) => {
      console.error(`[youtube] could not persist refreshed token to ${file}: ${error instanceof Error ? error.message : "error"}`);
    });
  });
  return () => pending;
}

export interface AuthorizedClient {
  client: OAuth2Client;
  /** Wait for refreshed tokens to be written before the process exits. */
  flush: () => Promise<void>;
}

/** OAuth client with the stored credentials; refreshed access/refresh tokens are saved back to disk. */
export async function loadAuthorizedClient(): Promise<AuthorizedClient> {
  const secret = await loadClientSecret();
  const tokens = await loadToken();
  const client = createOAuthClient(secret);
  client.setCredentials(tokens);
  return { client, flush: persistTokenRefreshes(client, tokens) };
}
