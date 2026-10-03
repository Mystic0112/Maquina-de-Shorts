import { redactSecrets } from "./redact.js";

/**
 * Minimal HTTP layer for the "Instagram API with Instagram Login" (graph.instagram.com) and Meta's
 * resumable upload host (rupload.facebook.com). Shared by auth, the Reels publisher and insights.
 *
 * Every error message is redacted at construction: tokens travel in query strings / form bodies
 * (`access_token=`) and in the rupload "Authorization: OAuth <token>" header, and error texts end up in
 * logs and in context.json (`publications.instagram.reason`).
 *
 * Docs: https://developers.facebook.com/documentation/instagram-platform/content-publishing
 */

export const GRAPH_VERSION = "v25.0";
export const GRAPH_HOST = "https://graph.instagram.com";
export const OAUTH_HOST = "https://api.instagram.com";
export const RUPLOAD_HOST = "https://rupload.facebook.com";

export interface HttpRequest {
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  text(): Promise<string>;
}

/** Injectable transport (tests pass fakes; nothing in the test suite touches the network). */
export type HttpFetch = (url: string, init: HttpRequest) => Promise<HttpResponse>;

export const DEFAULT_TIMEOUT_MS = 60_000;

type FetchFn = (url: string, init: { method: string; headers?: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal }) => Promise<HttpResponse>;

export const defaultHttp: HttpFetch = (url, init) =>
  (globalThis.fetch as unknown as FetchFn)(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

/** Graph error code for invalid/expired access tokens. */
export const INVALID_TOKEN_CODE = 190;

export class InstagramApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: number,
    readonly retriable = false,
  ) {
    super(redactSecrets(message));
    this.name = "InstagramApiError";
  }
}

/** "GET graph.instagram.com/v25.0/123/media": method + host + path, never the query string. */
export function describeRequest(method: string, url: string): string {
  try {
    const u = new URL(url);
    return `${method} ${u.host}${u.pathname}`;
  } catch {
    return `${method} (invalid url)`;
  }
}

export function graphUrl(path: string, params: Record<string, string> = {}, versioned = true): string {
  const base = versioned ? `${GRAPH_HOST}/${GRAPH_VERSION}` : GRAPH_HOST;
  const query = new URLSearchParams(params).toString();
  return `${base}/${path.replace(/^\/+/, "")}${query ? `?${query}` : ""}`;
}

export function formBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

/** Graph ({error:{message,code}}), OAuth ({error_type,code,error_message}) and rupload ({debug_info}) errors. */
export function apiErrorDetails(body: unknown): { message?: string; code?: number; retriable?: boolean } {
  const json = asObject(body);
  if (!json) return {};
  const graph = asObject(json.error);
  if (graph) {
    const message = [graph.message, graph.error_user_msg].filter((m) => typeof m === "string" && m).join(" / ");
    return { message: message || undefined, code: typeof graph.code === "number" ? graph.code : undefined, retriable: graph.is_transient === true };
  }
  if (typeof json.error_message === "string") {
    return { message: json.error_message, code: typeof json.code === "number" ? json.code : undefined };
  }
  const debug = asObject(json.debug_info);
  if (debug) return { message: typeof debug.message === "string" ? debug.message : String(debug.type ?? "upload failed"), retriable: debug.retriable === true };
  return {};
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Sends one request and returns the JSON object body; non-2xx and non-JSON answers throw InstagramApiError. */
export async function requestJson(http: HttpFetch, url: string, init: HttpRequest): Promise<Json> {
  const label = describeRequest(init.method, url);
  let response: HttpResponse;
  try {
    response = await http(url, init);
  } catch (error) {
    throw new InstagramApiError(`${label} failed: ${error instanceof Error ? error.message : String(error)}`, undefined, undefined, true);
  }
  const text = await response.text();
  const body = parseJson(text);
  if (response.status < 200 || response.status >= 300) {
    const details = apiErrorDetails(body);
    const hint = details.code === INVALID_TOKEN_CODE ? " (token inválido ou expirado: rode npm run auth:instagram)" : "";
    const message = details.message ?? text.slice(0, 300);
    throw new InstagramApiError(
      `${label} -> HTTP ${response.status}${details.code !== undefined ? ` (code ${details.code})` : ""}: ${message}${hint}`,
      response.status,
      details.code,
      details.retriable === true || isRetryableStatus(response.status),
    );
  }
  const json = asObject(body);
  if (!json) throw new InstagramApiError(`${label} returned a non-JSON body (HTTP ${response.status})`, response.status);
  return json;
}

/** Some endpoints document `{data:[{...}]}` while answering `{...}`: accept both. */
export function unwrapData(json: Json): Json {
  const data = json.data;
  if (Array.isArray(data) && data.length > 0) return asObject(data[0]) ?? json;
  return json;
}

export function stringField(json: Json, key: string): string | undefined {
  const value = json[key];
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}
