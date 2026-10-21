import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream";
import { minimalChildEnv } from "./childEnv.js";

/**
 * Temporary public HTTPS URL for one local video (Cloudflare "quick tunnel", no account needed), so
 * Instagram can fetch it with `video_url`. While the tunnel is open ANYONE who knows the random
 * *.trycloudflare.com URL can download the video: keep it open only for the upload window and always close it.
 */
export interface VideoTunnel {
  url: string;
  close: () => Promise<void>;
}

export const VIDEO_PATH = "/video.mp4";
export const DEFAULT_TUNNEL_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------------------------
// Range header (RFC 9110 §14): one range only; anything else is answered with 416
// ---------------------------------------------------------------------------------------------

export type RangeRequest = { kind: "full" } | { kind: "partial"; start: number; end: number } | { kind: "unsatisfiable" };

const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/;

function toInt(digits: string): number | undefined {
  if (digits === "") return undefined;
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : Number.NaN;
}

/**
 * `bytes=start-end`, `bytes=start-` or `bytes=-suffix` against a file of `size` bytes. An end past the
 * file is clamped to the last byte (RFC 9110); a start past the file, start > end, a zero suffix,
 * several ranges or any malformed value is unsatisfiable.
 */
export function parseRange(header: string | undefined, size: number): RangeRequest {
  if (header === undefined) return { kind: "full" };
  const match = RANGE_PATTERN.exec(header.trim());
  if (!match || size <= 0) return { kind: "unsatisfiable" };
  const first = toInt(match[1] ?? "");
  const last = toInt(match[2] ?? "");
  if (Number.isNaN(first) || Number.isNaN(last)) return { kind: "unsatisfiable" };
  if (first === undefined) {
    if (last === undefined || last === 0) return { kind: "unsatisfiable" };
    return { kind: "partial", start: Math.max(0, size - last), end: size - 1 };
  }
  if (first >= size || (last !== undefined && last < first)) return { kind: "unsatisfiable" };
  return { kind: "partial", start: first, end: Math.min(last ?? size - 1, size - 1) };
}

// ---------------------------------------------------------------------------------------------
// Local HTTP server: GET/HEAD on /video.mp4 only
// ---------------------------------------------------------------------------------------------

function sendStatus(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Length": "0", "Cache-Control": "no-store", ...headers });
  res.end();
}

function streamBody(res: ServerResponse, open: () => Readable): void {
  let body: Readable;
  try {
    body = open();
  } catch {
    res.destroy();
    return;
  }
  // pipeline destroys both sides on a read error or a client abort; the error is not rethrown.
  pipeline(body, res, () => undefined);
}

export function handleVideoRequest(videoPath: string, size: number, req: IncomingMessage, res: ServerResponse): void {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname !== VIDEO_PATH) return sendStatus(res, 404);
  if (req.method !== "GET" && req.method !== "HEAD") return sendStatus(res, 405, { Allow: "GET, HEAD" });
  const range = parseRange(req.headers.range, size);
  if (range.kind === "unsatisfiable") return sendStatus(res, 416, { "Content-Range": `bytes */${size}` });
  const [start, end] = range.kind === "partial" ? [range.start, range.end] : [0, size - 1];
  const headers: Record<string, string> = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Length": String(Math.max(0, end - start + 1)),
    ...(range.kind === "partial" ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
  };
  res.writeHead(range.kind === "partial" ? 206 : 200, headers);
  if (req.method === "HEAD" || size === 0) return void res.end();
  streamBody(res, () => createReadStream(videoPath, { start, end }));
}

/** Listens on 127.0.0.1 (random port); only cloudflared reaches it. */
export async function startVideoServer(videoPath: string): Promise<{ server: Server; port: number }> {
  const size = (await stat(videoPath)).size;
  const server = createServer((req, res) => handleVideoRequest(videoPath, size, req, res));
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { server, port: (server.address() as { port: number }).port };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  await closed;
}

// ---------------------------------------------------------------------------------------------
// cloudflared process
// ---------------------------------------------------------------------------------------------

/** The subset of ChildProcess the tunnel uses (a fake in tests). */
export interface TunnelProcess {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(): boolean;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number | null) => void): this;
  once(event: "exit", listener: (code: number | null) => void): this;
}

export type SpawnTunnel = (bin: string, args: readonly string[]) => TunnelProcess;

export interface TunnelOptions {
  timeoutMs?: number;
  spawnProcess?: SpawnTunnel;
  bin?: string;
}

const CLOUDFLARED_PATHS = [
  "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
  "C:\\Program Files\\cloudflared\\cloudflared.exe",
];

function findCloudflared(): string {
  return CLOUDFLARED_PATHS.find((p) => existsSync(p)) ?? "cloudflared"; // else: PATH lookup
}

// "api.trycloudflare.com" shows up in cloudflared's own error messages: never take it for the tunnel.
const URL_PATTERN = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i;
const REGISTERED_PATTERN = /Registered tunnel connection/i;
const OUTPUT_TAIL_CHARS = 4000;

const defaultSpawn: SpawnTunnel = (bin, args) =>
  spawn(bin, [...args], { stdio: ["ignore", "pipe", "pipe"], env: minimalChildEnv(), windowsHide: true });

export class TunnelError extends Error {}

function missingBinaryMessage(bin: string): string {
  return (
    `cloudflared não foi encontrado (${bin}). Instale o Cloudflare Tunnel (winget install --id Cloudflare.cloudflared) ` +
    "para publicar no Instagram por URL temporária."
  );
}

/** Resolves with the public URL once cloudflared printed it AND registered a connection; rejects on error, exit or timeout. */
function waitForTunnelUrl(cp: TunnelProcess, bin: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let output = "";
    let url: string | undefined;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(url as string);
    };
    const timer = setTimeout(
      () => finish(new TunnelError(`cloudflared não abriu o túnel em ${Math.round(timeoutMs / 1000)} s${url ? " (URL recebida, conexão não registrada)" : ""}`)),
      timeoutMs,
    );
    const onData = (chunk: Buffer | string): void => {
      output = (output + chunk.toString()).slice(-OUTPUT_TAIL_CHARS);
      url ??= URL_PATTERN.exec(output)?.[0];
      if (url && REGISTERED_PATTERN.test(output)) finish();
    };
    cp.stdout?.on("data", onData);
    cp.stderr?.on("data", onData);
    cp.on("error", (error: Error & { code?: string }) =>
      finish(new TunnelError(error.code === "ENOENT" ? missingBinaryMessage(bin) : `cloudflared falhou ao iniciar: ${error.message}`)),
    );
    cp.on("exit", (code) => finish(new TunnelError(`cloudflared encerrou (código ${code ?? "?"}) antes de abrir o túnel`)));
  });
}

async function stopProcess(cp: TunnelProcess, graceMs = 5000): Promise<void> {
  if (cp.exitCode !== null || cp.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, graceMs);
    cp.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  try {
    cp.kill();
  } catch {
    return; // already gone
  }
  await exited;
}

/**
 * Serves `videoPath` at `<random>.trycloudflare.com/video.mp4`. Throws a TunnelError (and leaves nothing
 * running) when cloudflared is missing, exits, or gives no URL within `timeoutMs`. `close()` is idempotent.
 */
export async function serveVideoTunnel(videoPath: string, options: TunnelOptions = {}): Promise<VideoTunnel> {
  const { server, port } = await startVideoServer(videoPath);
  const bin = options.bin ?? findCloudflared();
  let cp: TunnelProcess | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      if (cp) await stopProcess(cp);
      await closeServer(server);
    })());
  try {
    cp = (options.spawnProcess ?? defaultSpawn)(bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`]);
    const url = await waitForTunnelUrl(cp, bin, options.timeoutMs ?? DEFAULT_TUNNEL_TIMEOUT_MS);
    return { url: `${url}${VIDEO_PATH}`, close };
  } catch (error) {
    await close();
    if (error instanceof TunnelError) throw error;
    const code = (error as { code?: string }).code;
    throw new TunnelError(code === "ENOENT" ? missingBinaryMessage(bin) : `cloudflared falhou ao iniciar: ${String(error)}`);
  }
}
