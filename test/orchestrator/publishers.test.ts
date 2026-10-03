import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { UploadRecord } from "../../src/shared/history.js";
import { footageHash, scriptHash } from "../../src/orchestrator/lib/contentHash.js";
import type { Logger } from "../../src/orchestrator/lib/logger.js";
import { StageFailedError } from "../../src/orchestrator/lib/rejection.js";
import { createPublishers } from "../../src/orchestrator/publishers/index.js";
import { journalFile, LEGACY_YOUTUBE_JOURNAL, publishAll, UploadBlockedError, type PublishDeps } from "../../src/orchestrator/publishers/runner.js";
import type { Publisher, PublisherConnection } from "../../src/orchestrator/publishers/types.js";
import { createYouTubePublisher, type UploadSettings, type YouTubeUploader } from "../../src/orchestrator/publishers/youtube.js";
import type { PipelineConfig } from "../../src/orchestrator/lib/config.js";
import type { PlatformId, RunContext, Script } from "../../src/orchestrator/types.js";

const NOW = new Date("2026-10-03T12:00:00Z");
const script: Script = { title: "Vênus", hook: "Um dia em Vênus.", scenes: [], cta: "Siga.", language: "pt-BR" };

function publishable(over: Partial<RunContext> = {}): RunContext {
  const dir = mkdtempSync(join(tmpdir(), "pub-run-"));
  writeFileSync(join(dir, "final.mp4"), "mp4");
  return {
    runId: "20261003-120000-pub1", runDir: dir, createdAt: NOW.toISOString(),
    topic: { categoryId: "espaco", categoryLabel: "Espaço", seedPrompt: "p" },
    script, footage: [],
    render: { videoPath: join(dir, "final.mp4"), durationSeconds: 50, width: 1080, height: 1920 },
    metadata: { title: "Vênus #Shorts", description: "d", tags: ["venus"], categoryId: "27", defaultLanguage: "pt-BR", defaultAudioLanguage: "pt-BR" },
    factCheck: { verdict: "pass", rounds: 1, claimsChecked: 2, claims: [], corrections: [], sources: [], searchQueries: [], scriptHash: scriptHash(script) },
    quality: { passingScenes: 5, totalScenes: 5, passingRatio: 1, minPassingSceneRatio: 0.6, minScore: 6, verdict: "pass", contentHash: footageHash(script, []) },
    ...over,
  };
}

function recordingLog() {
  const lines: string[] = [];
  const log: Logger = {
    filePath: "",
    debug: () => undefined,
    info: (m) => lines.push(`I ${m}`),
    warn: (m) => lines.push(`W ${m}`),
    error: (m) => lines.push(`E ${m}`),
  };
  return { log, lines };
}

const ytSettings: UploadSettings = { enabled: true, privacyStatus: "unlisted", categoryId: "27", maxUploadsPerDay: 3, containsSyntheticMedia: false };

function world(history: UploadRecord[] = []) {
  const posted: string[] = [];
  const sessions: { platform: string; uri?: string }[] = [];
  const deps: PublishDeps = {
    readHistory: async () => [...history],
    appendHistory: async (r) => (history.push(r), {}),
    now: () => NOW,
  };
  const youtubeUploader: YouTubeUploader = {
    upload: async (_f, _r, _p, session) => {
      sessions.push({ platform: "youtube", uri: session?.sessionUri });
      await session?.onSession("https://upload/yt-session");
      posted.push("youtube");
      return { id: `yt${posted.length}` };
    },
    getPrivacyStatus: async () => "unlisted",
    close: async () => undefined,
  };
  const youtube = (settings: Partial<UploadSettings> = {}) => createYouTubePublisher({ ...ytSettings, ...settings }, async () => youtubeUploader);
  return { deps, history, posted, sessions, youtube };
}

/** A minimal second platform, as a future publishers/<platform>.ts would provide it. */
function fakePublisher(
  id: PlatformId,
  opts: { failConnect?: boolean; failPublish?: boolean; blockers?: string[]; enabled?: boolean; maxPostsPerDay?: number; posted?: string[] } = {},
): Publisher {
  const connection: PublisherConnection = {
    publish: async (_f, _payload, onProgress, session) => {
      if (opts.failPublish) throw new Error(`${id} API: 500 Internal Server Error`);
      await session.onSession(`https://upload/${id}-session`);
      onProgress(1, 1);
      opts.posted?.push(id);
      return { id: `${id}-post-1` };
    },
    verify: async () => "public",
    close: async () => undefined,
  };
  return {
    id,
    settings: { enabled: opts.enabled ?? true, maxPostsPerDay: opts.maxPostsPerDay ?? 50, requestedPrivacy: "public" },
    texts: { logPrefix: `[${id}] `, enabledSetting: `publish.${id}.enabled`, managementConsole: `${id} app`, lockedPrivateWarning: `${id} locked it` },
    blockers: () => opts.blockers ?? [],
    buildPost: (ctx) => ({ caption: ctx.metadata.description }),
    connect: async () => {
      if (opts.failConnect) throw new Error(`${id} token expired`);
      return connection;
    },
    postUrl: (postId) => `https://${id}.example/p/${postId}`,
  };
}

function yt(publishedHoursAgo: number, over: Partial<UploadRecord> = {}): UploadRecord {
  return {
    runId: `other-${publishedHoursAgo}`, videoId: `v${publishedHoursAgo}`, title: "t",
    publishedAt: new Date(NOW.getTime() - publishedHoursAgo * 3600_000).toISOString(),
    privacyStatus: "unlisted", requestedPrivacyStatus: "unlisted", categoryId: "27", topicCategoryId: "espaco", ...over,
  };
}

describe("registry", () => {
  it("YouTube (from the upload section) first, then Instagram (off by default, 3/day)", () => {
    const config = { upload: { privacyStatus: "public", categoryId: "27", maxUploadsPerDay: 2, enabled: true } } as unknown as PipelineConfig;
    const publishers = createPublishers(config);
    expect(publishers.map((p) => p.id)).toEqual(["youtube", "instagram"]);
    expect(publishers[0]?.settings).toEqual({ enabled: true, maxPostsPerDay: 2, requestedPrivacy: "public" });
    expect(publishers[1]?.settings).toEqual({ enabled: false, maxPostsPerDay: 3, requestedPrivacy: "public" });
  });

  it("Instagram is configured from its own section", () => {
    const config = { upload: { privacyStatus: "public", categoryId: "27", maxUploadsPerDay: 2 }, instagram: { enabled: true, maxPostsPerDay: 5 } } as unknown as PipelineConfig;
    expect(createPublishers(config)[1]?.settings).toEqual({ enabled: true, maxPostsPerDay: 5, requestedPrivacy: "public" });
  });
});

describe("publishAll: one platform's failure never stops the others", () => {
  it.each([
    ["failing platform after YouTube", false],
    ["failing platform before YouTube", true],
  ])("%s: YouTube is still published and recorded, the stage fails with every result kept", async (_label, failingFirst) => {
    const w = world();
    const { log, lines } = recordingLog();
    const failing = fakePublisher("instagram", { failPublish: true });
    const publishers = failingFirst ? [failing, w.youtube()] : [w.youtube(), failing];
    const error = await publishAll(publishable(), publishers, {}, w.deps, log).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StageFailedError);
    const ctx = (error as StageFailedError).ctx;
    expect(ctx.publications?.youtube).toMatchObject({ status: "uploaded", videoId: "yt1", url: "https://youtube.com/shorts/yt1" });
    expect(ctx.publications?.instagram).toMatchObject({ platform: "instagram", status: "failed", reason: "instagram API: 500 Internal Server Error" });
    expect(ctx.upload).toMatchObject({ status: "uploaded", videoId: "yt1" }); // dashboard field still filled
    expect(w.history.map((r) => [r.platform, r.videoId])).toEqual([["youtube", "yt1"]]);
    expect(lines).toContain("E [instagram] Publishing failed: instagram API: 500 Internal Server Error");
  });

  it("a platform whose login is broken does not stop YouTube either", async () => {
    const w = world();
    const error = await publishAll(publishable(), [fakePublisher("tiktok", { failConnect: true }), w.youtube()], {}, w.deps, recordingLog().log).catch((e: unknown) => e);
    expect((error as StageFailedError).ctx.publications).toMatchObject({ youtube: { status: "uploaded" }, tiktok: { status: "failed" } });
    expect(w.posted).toEqual(["youtube"]);
  });

  it("platform-specific blockers only block that platform", async () => {
    const w = world();
    const error = await publishAll(publishable(), [w.youtube(), fakePublisher("tiktok", { blockers: ["video shorter than 60 s"] })], {}, w.deps, recordingLog().log).catch((e: unknown) => e);
    const ctx = (error as StageFailedError).ctx;
    expect(ctx.publications?.youtube?.status).toBe("uploaded");
    expect(ctx.publications?.tiktok).toMatchObject({ status: "failed", reason: "blocked: video shorter than 60 s" });
  });

  it("shared gates block every platform (nothing is published anywhere)", async () => {
    const w = world();
    const posted: string[] = [];
    const ctx = publishable({ quality: { ...publishable().quality!, verdict: "fail" } });
    const error = await publishAll(ctx, [w.youtube(), fakePublisher("instagram", { posted })], {}, w.deps, recordingLog().log).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UploadBlockedError);
    expect([...w.posted, ...posted]).toEqual([]);
  });

  it("all platforms succeed: no error, one history record per platform", async () => {
    const w = world();
    const posted: string[] = [];
    const out = await publishAll(publishable(), [w.youtube(), fakePublisher("instagram", { posted })], {}, w.deps, recordingLog().log);
    expect(out.publications).toMatchObject({ youtube: { status: "uploaded" }, instagram: { status: "uploaded", url: "https://instagram.example/p/instagram-post-1" } });
    expect(w.history.map((r) => r.platform)).toEqual(["youtube", "instagram"]);
  });
});

describe("per-platform daily caps and duplicate checks", () => {
  it("each platform counts only its own records (legacy records without platform are YouTube's)", async () => {
    const w = world([yt(1), yt(2, { platform: "youtube" }), yt(3)]);
    const posted: string[] = [];
    const out = await publishAll(publishable(), [w.youtube(), fakePublisher("instagram", { posted, maxPostsPerDay: 1 })], {}, w.deps, recordingLog().log);
    expect(out.publications?.youtube).toMatchObject({ status: "skipped-cap" });
    expect(out.upload?.status).toBe("skipped-cap");
    expect(out.publications?.instagram?.status).toBe("uploaded");
    expect(posted).toEqual(["instagram"]);
  });

  it("a platform at its own cap is skipped while YouTube publishes", async () => {
    const w = world([yt(1, { platform: "instagram" })]);
    const out = await publishAll(publishable(), [w.youtube(), fakePublisher("instagram", { maxPostsPerDay: 1 })], {}, w.deps, recordingLog().log);
    expect(out.publications?.youtube?.status).toBe("uploaded");
    expect(out.publications?.instagram?.status).toBe("skipped-cap");
  });

  it("a run already published on one platform is still published on the other", async () => {
    const ctx = publishable();
    const w = world([yt(1, { runId: ctx.runId, videoId: "old-yt" })]);
    const posted: string[] = [];
    const out = await publishAll(ctx, [w.youtube(), fakePublisher("instagram", { posted })], {}, w.deps, recordingLog().log);
    expect(out.publications?.youtube?.videoId).toBe("old-yt");
    expect(w.posted).toEqual([]);
    expect(posted).toEqual(["instagram"]);
  });
});

describe("journals per platform", () => {
  it("each platform writes its own journal", async () => {
    const w = world();
    const ctx = publishable();
    await publishAll(ctx, [w.youtube(), fakePublisher("instagram")], {}, w.deps, recordingLog().log);
    expect(JSON.parse(readFileSync(join(ctx.runDir, journalFile("youtube")), "utf8"))).toMatchObject({ platform: "youtube", status: "uploaded", videoId: "yt1" });
    expect(JSON.parse(readFileSync(join(ctx.runDir, journalFile("instagram")), "utf8"))).toMatchObject({ platform: "instagram", videoId: "instagram-post-1" });
  });

  it("the legacy upload.journal.json is resumed for YouTube and migrated", async () => {
    const w = world();
    const ctx = publishable();
    writeFileSync(join(ctx.runDir, LEGACY_YOUTUBE_JOURNAL), JSON.stringify({ runId: ctx.runId, status: "pending", startedAt: NOW.toISOString(), requestedPrivacyStatus: "unlisted", sessionUri: "https://upload/legacy" }));
    await publishAll(ctx, [w.youtube()], {}, w.deps, recordingLog().log);
    expect(w.sessions).toEqual([{ platform: "youtube", uri: "https://upload/legacy" }]);
    expect(existsSync(join(ctx.runDir, LEGACY_YOUTUBE_JOURNAL))).toBe(false);
    expect(existsSync(join(ctx.runDir, journalFile("youtube")))).toBe(true);
  });

  it("a finished legacy journal is recovered (recorded, never re-uploaded)", async () => {
    const w = world();
    const ctx = publishable();
    writeFileSync(join(ctx.runDir, LEGACY_YOUTUBE_JOURNAL), JSON.stringify({ runId: ctx.runId, status: "uploaded", startedAt: NOW.toISOString(), requestedPrivacyStatus: "unlisted", videoId: "legacy-vid" }));
    const out = await publishAll(ctx, [w.youtube({ enabled: false })], {}, w.deps, recordingLog().log);
    expect(out.upload).toMatchObject({ status: "uploaded", videoId: "legacy-vid" });
    expect(w.history.map((r) => r.videoId)).toEqual(["legacy-vid"]);
    expect(w.posted).toEqual([]);
  });

  it("another platform's finished journal is recovered even when that platform is now disabled", async () => {
    const w = world();
    const ctx = publishable();
    writeFileSync(join(ctx.runDir, journalFile("instagram")), JSON.stringify({ runId: ctx.runId, platform: "instagram", status: "uploaded", startedAt: NOW.toISOString(), requestedPrivacyStatus: "public", videoId: "ig-1" }));
    const out = await publishAll(ctx, [w.youtube(), fakePublisher("instagram", { enabled: false })], {}, w.deps, recordingLog().log);
    expect(out.publications?.instagram).toMatchObject({ status: "uploaded", videoId: "ig-1" });
    expect(w.history.map((r) => [r.platform, r.videoId])).toEqual([["instagram", "ig-1"], ["youtube", "yt1"]]);
  });
});

describe("YouTube log lines are unchanged", () => {
  it("disabled, upload and success lines keep the YouTube-only wording (no platform prefix)", async () => {
    const w = world();
    const off = recordingLog();
    await publishAll(publishable(), [w.youtube({ enabled: false })], {}, w.deps, off.log);
    expect(off.lines).toEqual(["I Upload disabled (upload.enabled=false in config): skipping 08-uploadYouTube"]);
    const on = recordingLog();
    await publishAll(publishable(), [w.youtube()], {}, w.deps, on.log);
    expect(on.lines).toContain('I Uploading "Vênus #Shorts" as unlisted (0/3 uploads in the last 24 h)');
    expect(on.lines).toContain("I Uploaded: https://youtube.com/shorts/yt1 (privacy: requested unlisted, actual unlisted)");
  });
});
