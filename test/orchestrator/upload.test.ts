import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { UploadRecord } from "../../src/shared/history.js";
import type { Logger } from "../../src/orchestrator/lib/logger.js";
import { appendUploadRecord, checkDailyCap } from "../../src/orchestrator/lib/uploadHistory.js";
import { mergeTokens, parseClientSecret } from "../../src/orchestrator/lib/youtubeAuth.js";
import { nextOffsetFromRange, resumableUpload, type FetchLike } from "../../src/orchestrator/lib/youtubeUpload.js";
import {
  buildVideoResource,
  isLockedPrivate,
  LOCKED_PRIVATE_WARNING,
  uploadRun,
  type UploadDeps,
  type UploadSettings,
  type YouTubeUploader,
} from "../../src/orchestrator/stages/08-uploadYouTube.js";
import { footageHash, scriptHash } from "../../src/orchestrator/lib/contentHash.js";
import type { RunContext, Script } from "../../src/orchestrator/types.js";

const NOW = new Date("2026-10-03T12:00:00Z");
const hoursAgo = (h: number): string => new Date(NOW.getTime() - h * 3600_000).toISOString();

function record(publishedAt: string, over: Partial<UploadRecord> = {}): UploadRecord {
  return {
    runId: `run-${publishedAt}`, videoId: "vid", title: "t", publishedAt, privacyStatus: "unlisted",
    requestedPrivacyStatus: "unlisted", categoryId: "27", topicCategoryId: "espaco", ...over,
  };
}

describe("checkDailyCap (rolling 24 h)", () => {
  it("allows while under the cap", () => {
    expect(checkDailyCap([record(hoursAgo(1)), record(hoursAgo(30))], 2, NOW)).toEqual({ allowed: true, count: 1, max: 2 });
  });

  it("blocks at the cap and says when the next slot opens", () => {
    const cap = checkDailyCap([record(hoursAgo(20)), record(hoursAgo(5)), record(hoursAgo(1))], 3, NOW);
    expect(cap).toMatchObject({ allowed: false, count: 3 });
    expect(cap.nextSlotAt).toBe(new Date(NOW.getTime() + 4 * 3600_000).toISOString());
  });

  it("ignores uploads older than 24 h and future timestamps", () => {
    expect(checkDailyCap([record(hoursAgo(24.5)), record(hoursAgo(-2))], 1, NOW).allowed).toBe(true);
  });

  it("maxUploadsPerDay 0 always blocks", () => {
    expect(checkDailyCap([], 0, NOW).allowed).toBe(false);
  });
});

describe("appendUploadRecord", () => {
  it("creates, appends and keeps unknown entries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hist-"));
    const file = join(dir, "data", "history.json");
    await appendUploadRecord(record(hoursAgo(2)), file);
    writeFileSync(file, JSON.stringify([...JSON.parse(readFileSync(file, "utf8")), { legacy: true }]));
    await appendUploadRecord(record(hoursAgo(1)), file);
    const saved = JSON.parse(readFileSync(file, "utf8")) as unknown[];
    expect(saved).toHaveLength(3);
    expect(saved[1]).toEqual({ legacy: true });
    expect(readdirSync(join(dir, "data"))).toEqual(["history.json"]); // no tmp left behind
  });

  it("moves an unreadable file aside instead of overwriting it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hist-"));
    const file = join(dir, "history.json");
    writeFileSync(file, "{not json");
    const { movedCorruptTo } = await appendUploadRecord(record(hoursAgo(1)), file);
    expect(movedCorruptTo).toMatch(/history\.json\.corrupt-/);
    expect(readFileSync(movedCorruptTo ?? "", "utf8")).toBe("{not json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(1);
  });

  it("refuses invalid records", async () => {
    await expect(appendUploadRecord({ ...record(hoursAgo(1)), videoId: "" }, join(tmpdir(), "never.json"))).rejects.toThrow();
  });
});

describe("youtubeAuth helpers", () => {
  it("parses a Desktop client file", () => {
    expect(parseClientSecret({ installed: { client_id: "id", client_secret: "s", redirect_uris: ["http://localhost"] } }))
      .toEqual({ clientId: "id", clientSecret: "s", kind: "installed" });
    expect(() => parseClientSecret({ other: {} })).toThrow();
  });

  it("keeps the stored refresh token when a refresh omits it, and takes a rotated one", () => {
    const stored = { refresh_token: "r1", access_token: "a1", expiry_date: 1 };
    expect(mergeTokens(stored, { access_token: "a2", expiry_date: 2 })).toEqual({ refresh_token: "r1", access_token: "a2", expiry_date: 2 });
    expect(mergeTokens(stored, { refresh_token: "r2" }).refresh_token).toBe("r2");
  });
});

describe("resumableUpload", () => {
  const dir = mkdtempSync(join(tmpdir(), "up-"));
  const file = join(dir, "final.mp4");
  writeFileSync(file, Buffer.alloc(1000, 7));

  function fakeYouTube(script: ((req: { method: string; headers: Record<string, string> }) => { status: number; headers?: Record<string, string>; body?: string })[]) {
    const calls: { method: string; headers: Record<string, string>; bytes: number }[] = [];
    const fetch: FetchLike = async (_url, init) => {
      calls.push({ method: init.method, headers: init.headers, bytes: init.body instanceof Uint8Array ? init.body.length : 0 });
      const step = script.shift();
      if (!step) throw new Error("unexpected request");
      const r = step(init);
      return { status: r.status, headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null }, text: async () => r.body ?? "" };
    };
    return { fetch, calls };
  }

  it("uploads in chunks following 308 Range responses", async () => {
    const { fetch, calls } = fakeYouTube([
      () => ({ status: 200, headers: { location: "https://upload/session" } }),
      () => ({ status: 308, headers: { range: "bytes=0-399" } }),
      () => ({ status: 308, headers: { range: "bytes=0-799" } }),
      () => ({ status: 200, body: JSON.stringify({ id: "abc123" }) }),
    ]);
    const progress: number[] = [];
    const video = await resumableUpload({
      filePath: file, resource: { snippet: {} }, parts: ["snippet", "status"], getAccessToken: async () => "tok",
      fetch, chunkBytes: 400, onProgress: (d) => progress.push(d),
    });
    expect(video.id).toBe("abc123");
    expect(calls.map((c) => c.headers["Content-Range"] ?? c.method)).toEqual(["POST", "bytes 0-399/1000", "bytes 400-799/1000", "bytes 800-999/1000"]);
    expect(calls[0]?.headers["X-Upload-Content-Length"]).toBe("1000");
    expect(progress.at(-1)).toBe(1000);
  });

  it("recovers from a 503 by asking the session for its offset", async () => {
    const { fetch, calls } = fakeYouTube([
      () => ({ status: 200, headers: { location: "https://upload/session" } }),
      () => ({ status: 503 }),
      () => ({ status: 308, headers: { range: "bytes=0-499" } }), // status query
      () => ({ status: 201, body: JSON.stringify({ id: "xyz" }) }),
    ]);
    const video = await resumableUpload({
      filePath: file, resource: {}, parts: ["snippet"], getAccessToken: async () => "tok", fetch, chunkBytes: 1000, sleep: async () => undefined,
    });
    expect(video.id).toBe("xyz");
    expect(calls[2]?.headers["Content-Range"]).toBe("bytes */1000");
    expect(calls[3]?.headers["Content-Range"]).toBe("bytes 500-999/1000");
  });

  it("fails fast on a 4xx", async () => {
    const { fetch } = fakeYouTube([
      () => ({ status: 200, headers: { location: "https://upload/session" } }),
      () => ({ status: 403, body: "quotaExceeded" }),
    ]);
    await expect(
      resumableUpload({ filePath: file, resource: {}, parts: ["snippet"], getAccessToken: async () => "t", fetch }),
    ).rejects.toThrow(/HTTP 403.*quotaExceeded/);
  });

  it("parses Range headers", () => {
    expect(nextOffsetFromRange("bytes=0-262143")).toBe(262144);
    expect(nextOffsetFromRange(null)).toBe(0);
  });
});

const boundScript: Script = { title: "Vênus", hook: "h", scenes: [], cta: "c", language: "pt-BR" };

describe("08-uploadYouTube", () => {
  const dir = mkdtempSync(join(tmpdir(), "stage8-"));
  const videoPath = join(dir, "final.mp4");
  writeFileSync(videoPath, "mp4");
  const ctx: RunContext = {
    runId: "20261003-120000-abcd", runDir: dir, createdAt: NOW.toISOString(),
    topic: { categoryId: "espaco", categoryLabel: "Espaço", seedPrompt: "p" },
    render: { videoPath, durationSeconds: 56, width: 1080, height: 1920 },
    metadata: { title: "Vênus #Shorts", description: "d", tags: ["venus"], categoryId: "27", defaultLanguage: "pt-BR", defaultAudioLanguage: "pt-BR" },
    script: boundScript,
    footage: [],
    factCheck: { verdict: "pass", rounds: 1, claimsChecked: 3, claims: [], corrections: [], sources: [], searchQueries: [], scriptHash: scriptHash(boundScript) },
    quality: { passingScenes: 5, totalScenes: 5, passingRatio: 1, minPassingSceneRatio: 0.6, minScore: 6, verdict: "pass", contentHash: footageHash(boundScript, []) },
  };
  /** Each upload test gets its own run dir (the upload journal lives there). */
  const fresh = (): RunContext => ({ ...ctx, runDir: mkdtempSync(join(tmpdir(), "stage8-")) });
  const settings: UploadSettings = { enabled: true, privacyStatus: "unlisted", categoryId: "27", maxUploadsPerDay: 3, containsSyntheticMedia: false };

  function harness(actualPrivacy: "public" | "unlisted" | "private", history: UploadRecord[] = []) {
    const logs: string[] = [];
    const log: Logger = { filePath: "", debug: () => undefined, info: (m) => logs.push(`I ${m}`), warn: (m) => logs.push(`W ${m}`), error: (m) => logs.push(`E ${m}`) };
    const appended: UploadRecord[] = [];
    const uploads: unknown[] = [];
    const uploader: YouTubeUploader = {
      upload: async (_f, resource, onProgress) => (uploads.push(resource), onProgress(3, 3), { id: "vid42" }),
      getPrivacyStatus: async () => actualPrivacy,
      close: async () => undefined,
    };
    const deps: UploadDeps = {
      createUploader: async () => uploader,
      readHistory: async () => history,
      appendHistory: async (r) => (appended.push(r), {}),
      now: () => NOW,
    };
    return { deps, logs, appended, uploads, log };
  }

  it("skips without touching YouTube when upload.enabled is false", async () => {
    const h = harness("unlisted");
    h.deps.createUploader = async () => { throw new Error("must not be called"); };
    const out = await uploadRun(fresh(), { ...settings, enabled: false }, h.deps, h.log);
    expect(out.upload).toMatchObject({ status: "skipped-disabled", requestedPrivacyStatus: "unlisted" });
  });

  it("skips when the daily cap is reached", async () => {
    const h = harness("unlisted", [record(hoursAgo(1)), record(hoursAgo(2)), record(hoursAgo(3))]);
    const out = await uploadRun(fresh(), settings, h.deps, h.log);
    expect(out.upload?.status).toBe("skipped-cap");
    expect(h.uploads).toHaveLength(0);
  });

  it("uploads, records history and reports the actual privacy", async () => {
    const h = harness("unlisted");
    const out = await uploadRun(fresh(), settings, h.deps, h.log);
    expect(out.upload).toMatchObject({ status: "uploaded", videoId: "vid42", url: "https://youtube.com/shorts/vid42", privacyStatus: "unlisted", lockedPrivate: false });
    expect(h.appended[0]).toMatchObject({ runId: ctx.runId, videoId: "vid42", privacyStatus: "unlisted", requestedPrivacyStatus: "unlisted", topicCategoryId: "espaco" });
    expect(h.uploads[0]).toMatchObject({ status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false, containsSyntheticMedia: false } });
  });

  it("warns when YouTube locks the video as private", async () => {
    const h = harness("private");
    const out = await uploadRun(fresh(), settings, h.deps, h.log);
    expect(out.upload).toMatchObject({ privacyStatus: "private", requestedPrivacyStatus: "unlisted", lockedPrivate: true });
    expect(h.logs.some((l) => l.startsWith("W ") && l.includes(LOCKED_PRIVATE_WARNING))).toBe(true);
    expect(h.appended[0]?.privacyStatus).toBe("private");
  });

  it("never uploads the same run twice", async () => {
    const h = harness("unlisted", [record(hoursAgo(1), { runId: ctx.runId, videoId: "old" })]);
    const out = await uploadRun({ ...ctx, runDir: mkdtempSync(join(tmpdir(), "stage8-")) }, settings, h.deps, h.log);
    expect(out.upload).toMatchObject({ status: "uploaded", videoId: "old" });
    expect(h.uploads).toHaveLength(0);
    const again = await uploadRun(out, settings, harness("unlisted").deps, h.log);
    expect(again).toBe(out);
  });

  it("builds the videos.insert resource from metadata and settings", () => {
    const resource = buildVideoResource(ctx.metadata!, { ...settings, containsSyntheticMedia: true, privacyStatus: "public" });
    expect(resource.snippet).toMatchObject({ title: "Vênus #Shorts", categoryId: "27", defaultAudioLanguage: "pt-BR" });
    expect(resource.status).toMatchObject({ privacyStatus: "public", containsSyntheticMedia: true });
    expect(isLockedPrivate("private", "private")).toBe(false);
  });
});
