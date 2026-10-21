import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseRange,
  serveVideoTunnel,
  startVideoServer,
  TunnelError,
  type SpawnTunnel,
  type TunnelProcess,
} from "../../src/orchestrator/lib/cloudflaredTunnel.js";

const SIZE = 1000;
const CONTENT = Buffer.from(Array.from({ length: SIZE }, (_, i) => i % 251));

function videoFile(bytes: Buffer = CONTENT): string {
  const file = join(mkdtempSync(join(tmpdir(), "tunnel-")), "final.mp4");
  writeFileSync(file, bytes);
  return file;
}

// ---------------------------------------------------------------------------------------------
// Range parsing
// ---------------------------------------------------------------------------------------------

describe("parseRange", () => {
  it.each([
    [undefined, { kind: "full" }],
    ["bytes=0-99", { kind: "partial", start: 0, end: 99 }],
    ["bytes=0-0", { kind: "partial", start: 0, end: 0 }],
    ["bytes=500-", { kind: "partial", start: 500, end: 999 }],
    ["bytes=999-", { kind: "partial", start: 999, end: 999 }],
    ["bytes=-100", { kind: "partial", start: 900, end: 999 }],
    ["bytes=-5000", { kind: "partial", start: 0, end: 999 }],
    ["bytes=900-5000", { kind: "partial", start: 900, end: 999 }], // end past the file is clamped (RFC 9110)
    ["  bytes=1-2  ", { kind: "partial", start: 1, end: 2 }],
  ] as const)("%s -> %o", (header, expected) => {
    expect(parseRange(header, SIZE)).toEqual(expected);
  });

  it.each([
    "bytes=1000-",
    "bytes=1000-1001",
    "bytes=5-4",
    "bytes=-0",
    "bytes=-",
    "bytes=",
    "bytes=abc-def",
    "bytes=1.5-2",
    "bytes=-1-2",
    "bytes=0-1,5-9",
    "items=0-1",
    "bytes 0-1",
    "",
    "bytes=99999999999999999999-",
    "bytes=0-99999999999999999999",
  ])("%s is unsatisfiable", (header) => {
    expect(parseRange(header, SIZE)).toEqual({ kind: "unsatisfiable" });
  });

  it("an empty file satisfies no range", () => {
    expect(parseRange("bytes=0-", 0)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange(undefined, 0)).toEqual({ kind: "full" });
  });
});

// ---------------------------------------------------------------------------------------------
// Local server (loopback only)
// ---------------------------------------------------------------------------------------------

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

function call(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

const servers: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function serve(file = videoFile()) {
  const { server, port } = await startVideoServer(file);
  servers.push({ close: () => new Promise<void>((r) => (server.listening ? (server.closeAllConnections(), server.close(() => r())) : r())) });
  return { server, port };
}

describe("video server", () => {
  it("GET /video.mp4 sends the whole file", async () => {
    const { port } = await serve();
    const r = await call(port, "GET", "/video.mp4");
    expect(r.status).toBe(200);
    expect(r.headers).toMatchObject({ "content-type": "video/mp4", "accept-ranges": "bytes", "content-length": String(SIZE) });
    expect(r.body.equals(CONTENT)).toBe(true);
  });

  it("GET with a valid range sends 206 and only those bytes", async () => {
    const { port } = await serve();
    const r = await call(port, "GET", "/video.mp4", { Range: "bytes=10-19" });
    expect(r.status).toBe(206);
    expect(r.headers).toMatchObject({ "content-range": `bytes 10-19/${SIZE}`, "content-length": "10" });
    expect(r.body.equals(CONTENT.subarray(10, 20))).toBe(true);
    const suffix = await call(port, "GET", "/video.mp4", { Range: "bytes=-3" });
    expect(suffix.body.equals(CONTENT.subarray(SIZE - 3))).toBe(true);
  });

  it.each(["bytes=1000-", "bytes=5-4", "bytes=abc", "bytes=0-1,3-4", "bytes=-0"])("Range %s -> 416 with bytes */size, and the server keeps serving", async (range) => {
    const { port } = await serve();
    const r = await call(port, "GET", "/video.mp4", { Range: range });
    expect(r.status).toBe(416);
    expect(r.headers["content-range"]).toBe(`bytes */${SIZE}`);
    expect(r.body.length).toBe(0);
    expect((await call(port, "GET", "/video.mp4")).status).toBe(200);
  });

  it("HEAD sends the headers only", async () => {
    const { port } = await serve();
    const r = await call(port, "HEAD", "/video.mp4");
    expect(r.status).toBe(200);
    expect(r.headers["content-length"]).toBe(String(SIZE));
    expect(r.body.length).toBe(0);
    const ranged = await call(port, "HEAD", "/video.mp4", { Range: "bytes=0-9" });
    expect(ranged.status).toBe(206);
    expect(ranged.headers["content-length"]).toBe("10");
    expect(ranged.body.length).toBe(0);
  });

  it.each(["POST", "PUT", "DELETE", "OPTIONS"])("%s -> 405 (Allow: GET, HEAD)", async (method) => {
    const { port } = await serve();
    const r = await call(port, method, "/video.mp4");
    expect(r.status).toBe(405);
    expect(r.headers.allow).toBe("GET, HEAD");
  });

  it.each(["/", "/video.mp4/", "/other.mp4", "/../final.mp4", "/VIDEO.MP4"])("%s -> 404", async (path) => {
    const { port } = await serve();
    expect((await call(port, "GET", path)).status).toBe(404);
  });

  it("a query string does not change the path", async () => {
    const { port } = await serve();
    expect((await call(port, "GET", "/video.mp4?x=1")).status).toBe(200);
  });

  it("a read error after the headers (file gone) drops that response only; the server keeps running", async () => {
    const file = videoFile();
    const { port } = await serve(file);
    rmSync(file);
    const outcome = await call(port, "GET", "/video.mp4").then(
      (r) => `status ${r.status}, ${r.body.length} bytes`,
      (e: Error) => `error ${e.message}`,
    );
    expect(outcome).not.toBe(`status 200, ${SIZE} bytes`);
    expect((await call(port, "HEAD", "/video.mp4")).status).toBe(200);
  });

  it("a client that aborts mid-download does not crash the server", async () => {
    const big = Buffer.alloc(8 * 1024 * 1024, 1);
    const { port } = await serve(videoFile(big));
    await new Promise<void>((resolve) => {
      const req = request({ host: "127.0.0.1", port, path: "/video.mp4", agent: false }, (res) => {
        res.once("data", () => {
          req.destroy();
          resolve();
        });
      });
      req.on("error", () => undefined);
      req.end();
    });
    expect((await call(port, "HEAD", "/video.mp4")).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
// cloudflared process (fake; never spawned for real)
// ---------------------------------------------------------------------------------------------

class FakeProcess extends EventEmitter implements TunnelProcess {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  kill(): boolean {
    this.killed = true;
    this.exitCode = 0;
    setImmediate(() => this.emit("exit", 0));
    return true;
  }
}

function fakeSpawn(script: (cp: FakeProcess) => void) {
  const spawned: { bin: string; args: readonly string[]; cp: FakeProcess }[] = [];
  const spawnProcess: SpawnTunnel = (bin, args) => {
    const cp = new FakeProcess();
    spawned.push({ bin, args, cp });
    setImmediate(() => script(cp));
    return cp;
  };
  return { spawnProcess, spawned };
}

function portOf(args: readonly string[]): number {
  return Number(new URL(args[args.indexOf("--url") + 1] ?? "").port);
}

async function isListening(port: number): Promise<boolean> {
  return call(port, "HEAD", "/video.mp4").then(
    () => true,
    () => false,
  );
}

const READY = [
  "INF Requesting new quick Tunnel on trycloudflare.com...\n",
  "INF |  https://quiet-river-blue-moon.trycloudflare.com  |\n",
  "INF Registered tunnel connection connIndex=0 location=gru01 protocol=quic\n",
];

describe("serveVideoTunnel", () => {
  it("returns <tunnel>/video.mp4 once the URL is printed and a connection is registered; close() stops everything", async () => {
    const fake = fakeSpawn((cp) => READY.forEach((line) => cp.stderr.write(line)));
    const tunnel = await serveVideoTunnel(videoFile(), { spawnProcess: fake.spawnProcess, bin: "cloudflared" });
    expect(tunnel.url).toBe("https://quiet-river-blue-moon.trycloudflare.com/video.mp4");
    const { args, cp } = fake.spawned[0]!;
    expect(args.slice(0, 3)).toEqual(["tunnel", "--no-autoupdate", "--url"]);
    expect(args[3]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const port = portOf(args);
    expect(await isListening(port)).toBe(true);
    await tunnel.close();
    await tunnel.close(); // idempotent
    expect(cp.killed).toBe(true);
    expect(await isListening(port)).toBe(false);
  });

  it("a URL split across output chunks is still found", async () => {
    const fake = fakeSpawn((cp) => {
      cp.stdout.write("INF |  https://quiet-river-");
      cp.stdout.write("blue-moon.trycloudflare.com  |\n");
      cp.stdout.write(READY[2]!);
    });
    const tunnel = await serveVideoTunnel(videoFile(), { spawnProcess: fake.spawnProcess, bin: "cloudflared" });
    expect(tunnel.url).toBe("https://quiet-river-blue-moon.trycloudflare.com/video.mp4");
    await tunnel.close();
  });

  it("cloudflared not installed (ENOENT): clear TunnelError, server closed", async () => {
    const fake = fakeSpawn((cp) => cp.emit("error", Object.assign(new Error("spawn cloudflared ENOENT"), { code: "ENOENT" })));
    const error = await serveVideoTunnel(videoFile(), { spawnProcess: fake.spawnProcess, bin: "cloudflared" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TunnelError);
    expect((error as Error).message).toMatch(/cloudflared não foi encontrado/);
    expect(await isListening(portOf(fake.spawned[0]!.args))).toBe(false);
  });

  it("spawn itself throwing is also reported as a TunnelError and closes the server", async () => {
    let port = 0;
    const spawnProcess: SpawnTunnel = (_bin, args) => {
      port = portOf(args);
      throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
    };
    const error = await serveVideoTunnel(videoFile(), { spawnProcess, bin: "cloudflared" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TunnelError);
    expect(await isListening(port)).toBe(false);
  });

  it("no URL within the timeout: TunnelError, process killed, server closed", async () => {
    const fake = fakeSpawn((cp) => cp.stderr.write("INF Requesting new quick Tunnel on trycloudflare.com...\n"));
    const error = await serveVideoTunnel(videoFile(), { spawnProcess: fake.spawnProcess, bin: "cloudflared", timeoutMs: 50 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TunnelError);
    expect((error as Error).message).toMatch(/não abriu o túnel/);
    expect(fake.spawned[0]!.cp.killed).toBe(true);
    expect(await isListening(portOf(fake.spawned[0]!.args))).toBe(false);
  });

  it("URL printed but no registered connection within the timeout is a failure too", async () => {
    const fake = fakeSpawn((cp) => cp.stderr.write(READY[1]!));
    const error = await serveVideoTunnel(videoFile(), { spawnProcess: fake.spawnProcess, bin: "cloudflared", timeoutMs: 50 }).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/conexão não registrada/);
    expect(fake.spawned[0]!.cp.killed).toBe(true);
  });

  it("api.trycloudflare.com in an error message is never taken for the tunnel URL", async () => {
    const fake = fakeSpawn((cp) => {
      cp.stderr.write('ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: timeout\n');
      cp.exitCode = 1;
      cp.emit("exit", 1);
    });
    const error = await serveVideoTunnel(videoFile(), { spawnProcess: fake.spawnProcess, bin: "cloudflared", timeoutMs: 1000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TunnelError);
    expect((error as Error).message).toMatch(/encerrou \(código 1\)/);
    expect(await isListening(portOf(fake.spawned[0]!.args))).toBe(false);
  });

  it("a missing video file fails before anything is spawned", async () => {
    const fake = fakeSpawn(() => undefined);
    await expect(serveVideoTunnel(join(tmpdir(), "does-not-exist-final.mp4"), { spawnProcess: fake.spawnProcess })).rejects.toThrow();
    expect(fake.spawned).toEqual([]);
  });
});
