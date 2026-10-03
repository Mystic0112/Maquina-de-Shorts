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
}

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
export async function resumableUpload(options: ResumableUploadOptions): Promise<{ id: string } & Record<string, unknown>> {
  const o = {
    ...options,
    fetch: options.fetch ?? (globalThis.fetch as unknown as FetchLike),
    mimeType: options.mimeType ?? "video/mp4",
  };
  const chunkBytes = o.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const maxRetries = o.maxRetries ?? 8;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const size = (await stat(o.filePath)).size;
  const session = await startSession(o, size);
  let offset = 0;
  let retries = 0;
  for (;;) {
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
    if (response && (status === 200 || status === 201)) {
      o.onProgress?.(size, size);
      return JSON.parse(await response.text()) as { id: string } & Record<string, unknown>;
    }
    if (response && status === 308) {
      offset = nextOffsetFromRange(response.headers.get("range"));
      retries = 0;
      o.onProgress?.(offset, size);
      continue;
    }
    if (status !== -1 && !RETRYABLE.has(status)) {
      throw new UploadError(`Upload rejected (HTTP ${status}): ${(await response?.text())?.slice(0, 500) ?? ""}`, status);
    }
    if (retries >= maxRetries) throw new UploadError(`Upload failed after ${retries} retries (last HTTP ${status})`, status);
    await sleep(backoffMs(retries++));
    const state = await queryUploadState(o, session, size);
    if ("video" in state) {
      o.onProgress?.(size, size);
      return state.video;
    }
    offset = state.offset;
  }
}

type UploadState = { offset: number } | { video: { id: string } & Record<string, unknown> };

/** Asks the session how much it already has (empty PUT with "bytes * /size"); 200/201 = already complete. */
async function queryUploadState(o: ResumableUploadOptions & { fetch: FetchLike }, session: string, size: number): Promise<UploadState> {
  try {
    const response = await o.fetch(session, {
      method: "PUT",
      headers: { Authorization: `Bearer ${await o.getAccessToken()}`, "Content-Length": "0", "Content-Range": `bytes */${size}` },
    });
    if (response.status === 200 || response.status === 201) {
      return { video: JSON.parse(await response.text()) as { id: string } & Record<string, unknown> };
    }
    return { offset: response.status === 308 ? nextOffsetFromRange(response.headers.get("range")) : 0 };
  } catch {
    return { offset: 0 }; // unknown: resend from the start; Content-Range lets the server reconcile
  }
}
