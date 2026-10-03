import { open, stat } from "node:fs/promises";

/**
 * YouTube resumable upload (https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol).
 * googleapis' videos.insert only does single-request multipart uploads, so the protocol is implemented
 * here directly: start a session, PUT the file in chunks, and on network/5xx errors ask the server how
 * many bytes it has (308 + Range) and continue from there.
 */

export const UPLOAD_ENDPOINT = "https://www.googleapis.com/upload/youtube/v3/videos";
/** Must be a multiple of 256 KiB (except the last chunk). */
export const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array | string }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface ResumableUploadOptions {
  filePath: string;
  /** videos.insert resource (snippet + status). */
  resource: unknown;
  /** Parts to set, e.g. ["snippet", "status"]. */
  parts: readonly string[];
  /** Returns a valid bearer token (refreshing as needed); called before every request. */
  getAccessToken: () => Promise<string>;
  fetch?: FetchLike;
  chunkBytes?: number;
  maxRetries?: number;
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
  sleep?: (ms: number) => Promise<void>;
  mimeType?: string;
  /** Resume this existing session instead of starting a new upload. */
  sessionUri?: string;
  /** Called (and awaited) with the new session URI before any byte is sent. */
  onSession?: (sessionUri: string) => void | Promise<void>;
  /** Consecutive 308 responses without progress before giving up. Default 5. */
  maxStalls?: number;
  /** Total wall-clock budget for the upload. Default 45 min. */
  timeBudgetMs?: number;
  now?: () => number;
}

export const DEFAULT_TIME_BUDGET_MS = 45 * 60 * 1000;

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/** "bytes=0-524287" -> next offset 524288; missing header means nothing was stored. */
export function nextOffsetFromRange(range: string | null): number {
  const match = range ? /bytes=0-(\d+)/.exec(range) : null;
  return match ? Number(match[1]) + 1 : 0;
}

export function backoffMs(retry: number): number {
  const ceiling = Math.min(64_000, 1000 * 2 ** retry);
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

async function startSession(o: Required<Pick<ResumableUploadOptions, "fetch" | "mimeType">> & ResumableUploadOptions, size: number): Promise<string> {
  const url = `${UPLOAD_ENDPOINT}?uploadType=resumable&part=${encodeURIComponent(o.parts.join(","))}`;
  const response = await o.fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await o.getAccessToken()}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": o.mimeType,
      "X-Upload-Content-Length": String(size),
    },
    body: JSON.stringify(o.resource),
  });
  const location = response.headers.get("location");
  if (response.status !== 200 || !location) {
    throw new UploadError(`Could not start upload session (HTTP ${response.status}): ${(await response.text()).slice(0, 500)}`, response.status);
  }
  return location;
}

async function readChunk(filePath: string, offset: number, length: number): Promise<Uint8Array> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Uploads the file and returns the created video resource (parsed JSON). */
export class UploadSessionLostError extends UploadError {}

type Video = { id: string } & Record<string, unknown>;
type UploadState = { offset: number } | { video: Video } | { lost: number };

/**
 * Uploads the file and returns the created video resource (parsed JSON).
 * - `sessionUri` resumes an earlier session (crash/retry) instead of opening a new upload; a session the
 *   server no longer knows (404/410) throws UploadSessionLostError: the caller must NOT blindly re-upload.
 * - `onSession` is awaited before the first byte is sent, so the URI can be persisted first.
 * - Gives up after `maxStalls` consecutive responses without progress, `maxRetries` transient errors in a
 *   row, or when `timeBudgetMs` is exceeded.
 */
export async function resumableUpload(options: ResumableUploadOptions): Promise<Video> {
  const o = {
    ...options,
    fetch: options.fetch ?? (globalThis.fetch as unknown as FetchLike),
    mimeType: options.mimeType ?? "video/mp4",
  };
  const chunkBytes = o.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const maxRetries = o.maxRetries ?? 8;
  const maxStalls = o.maxStalls ?? 5;
  const now = o.now ?? (() => Date.now());
  const deadline = now() + (o.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const size = (await stat(o.filePath)).size;

  let session: string;
  let offset = 0;
  if (o.sessionUri) {
    session = o.sessionUri;
    const state = await queryUploadState(o, session, size);
    if ("video" in state) return finish(o, size, state.video);
    if ("lost" in state) throw new UploadSessionLostError(`Previous upload session is gone (HTTP ${state.lost}); check YouTube Studio before uploading again`, state.lost);
    offset = state.offset;
  } else {
    session = await startSession(o, size);
    await o.onSession?.(session);
  }

  let retries = 0;
  let stalls = 0;
  for (;;) {
    if (now() > deadline) throw new UploadError(`Upload exceeded its time budget (${Math.round((o.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS) / 60000)} min) at ${offset}/${size} bytes`);
    let status: number;
    let response: Awaited<ReturnType<FetchLike>> | undefined;
    try {
      const end = Math.min(offset + chunkBytes, size);
      const body = await readChunk(o.filePath, offset, end - offset);
      response = await o.fetch(session, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${await o.getAccessToken()}`,
          "Content-Length": String(body.length),
          "Content-Range": size === 0 ? "bytes */0" : `bytes ${offset}-${end - 1}/${size}`,
        },
        body,
      });
      status = response.status;
    } catch (error) {
      status = -1; // network error: treat like a retryable 5xx
      if (retries >= maxRetries) throw new UploadError(`Upload failed after ${retries} retries: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response && (status === 200 || status === 201)) return finish(o, size, JSON.parse(await response.text()) as Video);
    if (response && status === 308) {
      const next = nextOffsetFromRange(response.headers.get("range"));
      stalls = next > offset ? 0 : stalls + 1;
      if (stalls >= maxStalls) throw new UploadError(`Upload made no progress after ${stalls} attempts at ${offset}/${size} bytes`, 308);
      offset = next;
      retries = 0;
      o.onProgress?.(offset, size);
      continue;
    }
    if (status === 404 || status === 410) throw new UploadSessionLostError(`Upload session expired (HTTP ${status})`, status);
    if (status !== -1 && !RETRYABLE.has(status)) {
      throw new UploadError(`Upload rejected (HTTP ${status}): ${(await response?.text())?.slice(0, 500) ?? ""}`, status);
    }
    if (retries >= maxRetries) throw new UploadError(`Upload failed after ${retries} retries (last HTTP ${status})`, status);
    await sleep(backoffMs(retries++));
    const state = await queryUploadState(o, session, size);
    if ("video" in state) return finish(o, size, state.video);
    if ("lost" in state) throw new UploadSessionLostError(`Upload session expired (HTTP ${state.lost})`, state.lost);
    offset = state.offset;
  }
}

function finish(o: ResumableUploadOptions, size: number, video: Video): Video {
  if (!video || typeof video.id !== "string" || !video.id) throw new UploadError("Upload finished but YouTube returned no video id");
  o.onProgress?.(size, size);
  return video;
}

/** Asks the session how much it already has (empty PUT with "bytes * /size"); 200/201 = already complete. */
async function queryUploadState(o: ResumableUploadOptions & { fetch: FetchLike }, session: string, size: number): Promise<UploadState> {
  try {
    const response = await o.fetch(session, {
      method: "PUT",
      headers: { Authorization: `Bearer ${await o.getAccessToken()}`, "Content-Length": "0", "Content-Range": `bytes */${size}` },
    });
    if (response.status === 200 || response.status === 201) return { video: JSON.parse(await response.text()) as Video };
    if (response.status === 404 || response.status === 410) return { lost: response.status };
    return { offset: response.status === 308 ? nextOffsetFromRange(response.headers.get("range")) : 0 };
  } catch {
    return { offset: 0 }; // unknown: resend from the start; Content-Range lets the server reconcile
  }
}
