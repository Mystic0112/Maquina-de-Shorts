import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { UploadRecord } from "../../src/shared/history.js";
import { footageHash, scriptHash } from "../../src/orchestrator/lib/contentHash.js";
import { InstagramApiError, requestJson, type HttpFetch, type HttpRequest } from "../../src/orchestrator/lib/instagramApi.js";
import type { InstagramToken } from "../../src/orchestrator/lib/instagramAuth.js";
import { fetchManyReelInsights, fetchReelInsights, parseInsights } from "../../src/orchestrator/lib/instagramInsights.js";
import type { Logger } from "../../src/orchestrator/lib/logger.js";
import { redactSecrets, registerSecret } from "../../src/orchestrator/lib/redact.js";
import { StageFailedError } from "../../src/orchestrator/lib/rejection.js";
import { buildTitle, fitDescription, MODIFIED_NOTE } from "../../src/orchestrator/stages/07-generateMetadata.js";
import { buildInstagramCaption, CAPTION_MAX, countHashtags, HASHTAGS_MAX, missingAttributions } from "../../src/orchestrator/publishers/instagramCaption.js";
import { createInstagramPublisher, REEL_COVER_OFFSET_MS, ruploadUrl, type PublishReelOptions } from "../../src/orchestrator/publishers/instagram.js";
import { TunnelError, type VideoTunnel } from "../../src/orchestrator/lib/cloudflaredTunnel.js";
import { VISUAL_DEFAULTS } from "../../src/shared/settings.js";
import { journalFile, publishAll, type PublishDeps } from "../../src/orchestrator/publishers/runner.js";
import { createYouTubePublisher, type YouTubeUploader } from "../../src/orchestrator/publishers/youtube.js";
import type { FootageClip, RunContext, Script } from "../../src/orchestrator/types.js";

const NOW = new Date("2026-10-03T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const TOKEN = "IGAAfakeLongLivedAccessToken0123456789";
const IG_USER = "17841400000000001";

const script: Script = {
  title: "O dia em Vênus é mais longo que o ano",
  hook: "Em Vênus, um dia dura mais que um ano inteiro.",
  scenes: [{ narration: "Vênus gira muito devagar. Uma volta leva 243 dias terrestres.", footageQuery: "venus" }],
  cta: "Siga.",
  language: "pt-BR",
};

function clip(over: Partial<FootageClip> = {}): FootageClip {
  return {
    sceneIndex: 0, path: "/tmp/a.jpg", kind: "image", durationSeconds: 5, width: 1080, height: 1920,
    source: "wikimedia", sourceUrl: "https://commons.wikimedia.org/wiki/File:Venus.jpg", creator: "Ana Souza",
    license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", ...over,
  };
}

const FOOTAGE = [clip(), clip({ sourceUrl: "https://images.nasa.gov/details/PIA00271", source: "nasa", creator: "NASA/JPL", license: "Public Domain", licenseUrl: undefined })];

function metadataFor(footage: readonly FootageClip[], hashtags = ["#curiosidades", "#espaço", "#venus"]) {
  return {
    title: buildTitle(script.title),
    description: fitDescription({ hook: script.hook, context: "Vênus gira muito devagar.", hashtags }, footage),
    tags: ["venus"],
    categoryId: "27",
    defaultLanguage: "pt-BR",
    defaultAudioLanguage: "pt-BR",
  };
}

function publishable(footage: readonly FootageClip[] = FOOTAGE): RunContext {
  const dir = mkdtempSync(join(tmpdir(), "ig-run-"));
  writeFileSync(join(dir, "final.mp4"), Buffer.alloc(4096, 7));
  return {
    runId: "20261003-120000-ig01", runDir: dir, createdAt: NOW.toISOString(),
    topic: { categoryId: "espaco", categoryLabel: "Espaço", seedPrompt: "p" },
    script, footage: [...footage],
    render: { videoPath: join(dir, "final.mp4"), durationSeconds: 50, width: 1080, height: 1920 },
    metadata: metadataFor(footage),
    factCheck: { verdict: "pass", rounds: 1, claimsChecked: 2, claims: [], corrections: [], sources: [], searchQueries: [], scriptHash: scriptHash(script) },
    quality: { passingScenes: 1, totalScenes: 1, passingRatio: 1, minPassingSceneRatio: 0.6, minScore: 6, verdict: "pass", contentHash: footageHash(script, footage) },
  };
}

function recordingLog() {
  const lines: string[] = [];
  const log: Logger = {
    filePath: "",
    debug: () => undefined,
    // Same redaction the real logger applies to every line.
    info: (m) => lines.push(`I ${redactSecrets(m)}`),
    warn: (m) => lines.push(`W ${redactSecrets(m)}`),
    error: (m) => lines.push(`E ${redactSecrets(m)}`),
  };
  return { log, lines };
}

function tokenFile(over: Partial<InstagramToken> = {}): string {
  const file = join(mkdtempSync(join(tmpdir(), "ig-tok-")), "instagram.token.json");
  const token: InstagramToken = {
    accessToken: TOKEN, tokenType: "bearer", expiresAt: new Date(NOW.getTime() + 40 * DAY).toISOString(),
    issuedAt: new Date(NOW.getTime() - 20 * DAY).toISOString(), userId: IG_USER, username: "maquina.shorts", accountType: "MEDIA_CREATOR", ...over,
  };
  writeFileSync(file, JSON.stringify(token));
  return file;
}

// ---------------------------------------------------------------------------------------------
// Fake Graph API (graph.instagram.com + rupload.facebook.com); no network anywhere
// ---------------------------------------------------------------------------------------------

interface FakeContainer {
  id: string;
  caption: string;
  statusCode: string;
  uploadedBytes: number;
  pollsUntilFinished: number;
}

interface GraphOptions {
  quotaUsage?: number;
  /** IN_PROGRESS answers after the upload before FINISHED (Infinity = never finishes). */
  processingPolls?: number;
  /** rupload answers this many 503s first. */
  uploadFailures?: number;
  /** media_publish fails with a network error AFTER publishing (connection drop). */
  publishDropsConnection?: boolean;
  failContainerCreate?: boolean;
  /** rupload refuses bytes for a container that already has the whole file. */
  rejectReupload?: boolean;
}

function fakeGraph(opts: GraphOptions = {}) {
  const calls: { method: string; url: URL; init: HttpRequest }[] = [];
  const containers = new Map<string, FakeContainer>();
  const media: { id: string; caption: string; permalink: string }[] = [];
  let uploadFailures = opts.uploadFailures ?? 0;
  let nextContainer = 17900000000000001n;
  let nextMedia = 18000000000000001n;
  const ok = (body: unknown) => ({ status: 200, text: async () => JSON.stringify(body) });
  const fail = (status: number, message: string, code = 100) => ({ status, text: async () => JSON.stringify({ error: { message, type: "OAuthException", code } }) });
  const form = (init: HttpRequest) => Object.fromEntries(new URLSearchParams(String(init.body)));

  const http: HttpFetch = async (raw, init) => {
    const url = new URL(raw);
    calls.push({ method: init.method, url, init });
    if (url.host === "rupload.facebook.com") {
      expect(init.headers?.Authorization).toBe(`OAuth ${TOKEN}`);
      const c = containers.get(url.pathname.split("/").pop() ?? "");
      if (!c) return fail(400, "unknown container");
      if (uploadFailures-- > 0) return { status: 503, text: async () => "Service Unavailable" };
      if (opts.rejectReupload && c.uploadedBytes > 0) {
        return { status: 400, text: async () => JSON.stringify({ debug_info: { retriable: false, type: "ProcessingFailedError", message: "file already uploaded" } }) };
      }
      c.uploadedBytes = Number(init.headers?.offset) + (init.body as Uint8Array).length;
      return ok({ success: true, message: "Upload successful." });
    }
    expect(url.host).toBe("graph.instagram.com");
    const token = init.method === "GET" ? url.searchParams.get("access_token") : form(init).access_token;
    expect(token).toBe(TOKEN);
    const path = url.pathname.replace(/^\/v25\.0\//, "");
    if (init.method === "GET" && path === `${IG_USER}/content_publishing_limit`) {
      return ok({ data: [{ quota_usage: opts.quotaUsage ?? 2, config: { quota_total: 50, quota_duration: 86400 } }] });
    }
    if (init.method === "POST" && path === `${IG_USER}/media`) {
      if (opts.failContainerCreate) return fail(500, `boom for url https://graph.instagram.com/x?access_token=${TOKEN}`, 2);
      const body = form(init);
      if (body.video_url) expect(body.upload_type).toBeUndefined();
      expect(body).toMatchObject(body.video_url ? { media_type: "REELS" } : { media_type: "REELS", upload_type: "resumable" });
      const id = String(nextContainer++);
      // video_url: Meta downloads the file itself, so processing starts right away.
      const fetched = body.video_url ? 1 : 0;
      containers.set(id, { id, caption: body.caption ?? "", statusCode: "IN_PROGRESS", uploadedBytes: fetched, pollsUntilFinished: opts.processingPolls ?? 1 });
      return ok({ id, uri: `https://rupload.facebook.com/ig-api-upload/v25.0/${id}` });
    }
    if (init.method === "POST" && path === `${IG_USER}/media_publish`) {
      const c = containers.get(form(init).creation_id ?? "");
      if (!c || c.statusCode !== "FINISHED") return fail(400, "container not ready", 9007);
      c.statusCode = "PUBLISHED";
      const id = String(nextMedia++);
      media.unshift({ id, caption: c.caption, permalink: `https://www.instagram.com/reel/C${id.slice(-6)}/` });
      if (opts.publishDropsConnection) throw new TypeError("fetch failed (socket hang up)");
      return ok({ id });
    }
    if (init.method === "GET" && path === `${IG_USER}/media`) return ok({ data: media });
    const container = containers.get(path);
    if (init.method === "GET" && container) {
      if (url.searchParams.get("fields") === "video_status") return fail(400, "Tried accessing nonexisting field (video_status)", 100);
      if (container.statusCode === "IN_PROGRESS" && container.uploadedBytes > 0) {
        if (container.pollsUntilFinished-- <= 0) container.statusCode = "FINISHED";
      }
      return ok({ id: container.id, status_code: container.statusCode, status: container.statusCode });
    }
    const m = media.find((x) => x.id === path);
    if (init.method === "GET" && m) return ok({ id: m.id, permalink: m.permalink });
    return fail(400, `Unsupported request ${init.method} ${path}`);
  };
  return { http, calls, containers, media, created: () => calls.filter((c) => c.method === "POST" && c.url.pathname.endsWith(`${IG_USER}/media`)).length };
}

const FAST: PublishReelOptions = { sleep: async () => undefined, pollDelaysMs: [1000] };

function world(history: UploadRecord[] = []) {
  const deps: PublishDeps = { readHistory: async () => [...history], appendHistory: async (r) => (history.push(r), {}), now: () => NOW };
  return { deps, history };
}

function instagram(graph: ReturnType<typeof fakeGraph>, over: { file?: string; publishOptions?: PublishReelOptions; maxPostsPerDay?: number } = {}) {
  return createInstagramPublisher(
    { enabled: true, maxPostsPerDay: over.maxPostsPerDay ?? 3 },
    { tokenFile: over.file ?? tokenFile(), now: () => NOW, http: graph.http, publishOptions: over.publishOptions ?? FAST },
  );
}

// ---------------------------------------------------------------------------------------------
// Caption
// ---------------------------------------------------------------------------------------------

describe("Instagram caption", () => {
  it("reuses the fact-checked title, hook, hashtags and the exact YouTube credit lines, without #Shorts", () => {
    const meta = metadataFor(FOOTAGE);
    const caption = buildInstagramCaption(meta, FOOTAGE);
    expect(caption.startsWith(`${script.title}\n\n${script.hook}`)).toBe(true);
    expect(caption).not.toMatch(/#shorts/i);
    expect(caption).toContain("#curiosidades #espaço #venus");
    const credits = meta.description.split("\n\n").find((b) => b.startsWith("Créditos das imagens:"));
    expect(credits).toContain("Ana Souza");
    expect(caption).toContain(credits!);
    expect(caption).toContain(`https://commons.wikimedia.org/wiki/File:Venus.jpg ${MODIFIED_NOTE}`);
    expect(caption).toContain("Narração: voz sintética.");
    expect(missingAttributions(caption, FOOTAGE)).toEqual([]);
  });

  it("stays within 2200 chars by dropping context, then compacting credits, never dropping a CC BY credit", () => {
    const many = Array.from({ length: 14 }, (_, i) => clip({ sourceUrl: `https://commons.wikimedia.org/wiki/File:Venus_${i}_${"x".repeat(60)}.jpg`, creator: i % 2 ? "Ana Souza" : "Bruno Lima" }));
    const caption = buildInstagramCaption(metadataFor(many), many);
    expect(caption.length).toBeLessThanOrEqual(CAPTION_MAX);
    expect(missingAttributions(caption, many)).toEqual([]);
    expect(caption).not.toContain("Vênus gira muito devagar."); // context went first
  });

  it("keeps at most 30 hashtags", () => {
    const tags = Array.from({ length: 40 }, (_, i) => `#tag${i}`);
    const caption = buildInstagramCaption({ title: "T #Shorts", description: `Gancho.\n\n${tags.join(" ")}` }, []);
    expect(countHashtags(caption)).toBe(HASHTAGS_MAX);
  });

  it("refuses (blocker) when the CC BY credits alone cannot fit", () => {
    const huge = Array.from({ length: 40 }, (_, i) => clip({ creator: `Autor ${i}`, sourceUrl: `https://commons.wikimedia.org/wiki/File:${"y".repeat(50)}_${i}.jpg` }));
    expect(() => buildInstagramCaption(metadataFor([]), huge)).toThrow(/credits do not fit/);
    const ctx = { ...publishable(), footage: huge };
    expect(instagram(fakeGraph()).blockers(ctx)).toEqual([expect.stringMatching(/credits do not fit/)]);
  });
});

// ---------------------------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------------------------

describe("Instagram publisher", () => {
  it("happy path: quota -> container (journaled first) -> rupload -> FINISHED -> media_publish -> permalink", async () => {
    const graph = fakeGraph({ processingPolls: 2 });
    const w = world();
    const ctx = publishable();
    const { log, lines } = recordingLog();
    const out = await publishAll(ctx, [instagram(graph)], {}, w.deps, log);
    const steps = graph.calls.map((c) => `${c.method} ${c.url.host === "rupload.facebook.com" ? "rupload" : c.url.pathname.replace(/^\/v25\.0\//, "").replace(/\d{17}/g, "<id>")}${c.url.searchParams.get("fields") ? `?${c.url.searchParams.get("fields")}` : ""}`);
    expect(steps).toEqual([
      "GET <id>/content_publishing_limit?quota_usage,config",
      "POST <id>/media",
      "POST rupload",
      "GET <id>?id,status,status_code",
      "GET <id>?id,status,status_code",
      "GET <id>?id,status,status_code",
      "POST <id>/media_publish",
      "GET <id>?id,permalink",
      "GET <id>?id,permalink",
    ]);
    const upload = graph.calls.find((c) => c.url.host === "rupload.facebook.com")!;
    expect(upload.init.headers).toMatchObject({ offset: "0", file_size: "4096" });
    expect(Object.fromEntries(new URLSearchParams(String(graph.calls[1]!.init.body))).caption).toBe(buildInstagramCaption(ctx.metadata!, FOOTAGE));
    const mediaId = graph.media[0]!.id;
    expect(out.publications?.instagram).toMatchObject({ platform: "instagram", status: "uploaded", videoId: mediaId, url: graph.media[0]!.permalink, privacyStatus: "public" });
    expect(w.history).toEqual([expect.objectContaining({ platform: "instagram", runId: ctx.runId, videoId: mediaId })]);
    expect(JSON.parse(readFileSync(join(ctx.runDir, journalFile("instagram")), "utf8"))).toMatchObject({ status: "uploaded", videoId: mediaId, sessionUri: [...graph.containers.keys()][0] });
    expect(lines).toContain("I [instagram] Instagram quota: 2/50 posts in the last 24 h");
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("sets the Reel cover inside the on-screen hook text window (thumb_offset in ms)", async () => {
    const graph = fakeGraph();
    await publishAll(publishable(), [instagram(graph)], {}, world().deps, recordingLog().log);
    const container = graph.calls.find((c) => c.method === "POST" && c.url.pathname.endsWith(`${IG_USER}/media`))!;
    const body = Object.fromEntries(new URLSearchParams(String(container.init.body)));
    expect(body).toMatchObject({ media_type: "REELS", thumb_offset: String(REEL_COVER_OFFSET_MS) });
    expect(REEL_COVER_OFFSET_MS).toBeGreaterThan(0);
    expect(REEL_COVER_OFFSET_MS).toBeLessThan(VISUAL_DEFAULTS.overlayHookSeconds * 1000);
  });

  it("a retry inspects the journaled container and resumes it: never a second container or post", async () => {
    const graph = fakeGraph({ processingPolls: Infinity });
    const ctx = publishable();
    const w = world();
    let clock = 0;
    const timed: PublishReelOptions = { now: () => clock, sleep: async (ms) => void (clock += ms), pollTimeoutMs: 3000, pollDelaysMs: [1000] };
    const first = await publishAll(ctx, [instagram(graph, { publishOptions: timed })], {}, w.deps, recordingLog().log).catch((e: unknown) => e);
    expect((first as StageFailedError).ctx.publications?.instagram).toMatchObject({ status: "failed", reason: expect.stringMatching(/still processing.*resumes the same container/) });
    const journal = JSON.parse(readFileSync(join(ctx.runDir, journalFile("instagram")), "utf8")) as { sessionUri: string; videoId?: string };
    expect(journal.videoId).toBeUndefined();
    expect(graph.created()).toBe(1);

    graph.containers.get(journal.sessionUri)!.pollsUntilFinished = 0; // Meta finished processing meanwhile
    const { log, lines } = recordingLog();
    const out = await publishAll(ctx, [instagram(graph)], {}, w.deps, log);
    expect(graph.created()).toBe(1);
    expect(graph.calls.filter((c) => c.url.host === "rupload.facebook.com")).toHaveLength(1); // FINISHED: not uploaded again
    expect(graph.media).toHaveLength(1);
    expect(out.publications?.instagram).toMatchObject({ status: "uploaded", videoId: graph.media[0]!.id });
    expect(lines.some((l) => l.includes(`Resuming Instagram container ${journal.sessionUri} (status FINISHED)`))).toBe(true);
  });

  it("re-sending into a container that already has the file is refused; the status poll decides", async () => {
    const graph = fakeGraph({ processingPolls: Infinity, rejectReupload: true });
    const ctx = publishable();
    const w = world();
    let clock = 0;
    const timed: PublishReelOptions = { now: () => clock, sleep: async (ms) => void (clock += ms), pollTimeoutMs: 2000, pollDelaysMs: [1000] };
    await publishAll(ctx, [instagram(graph, { publishOptions: timed })], {}, w.deps, recordingLog().log).catch(() => undefined);
    graph.containers.get([...graph.containers.keys()][0]!)!.pollsUntilFinished = 2; // still processing at the retry
    const { log, lines } = recordingLog();
    const out = await publishAll(ctx, [instagram(graph)], {}, w.deps, log);
    expect(lines.some((l) => l.includes("Re-sending the video was refused") && l.includes("file already uploaded"))).toBe(true);
    expect(graph.created()).toBe(1);
    expect(out.publications?.instagram?.status).toBe("uploaded");
  });

  it("an upload interrupted before Meta got the file is resent into the same journaled container", async () => {
    const graph = fakeGraph({ uploadFailures: 3 });
    const ctx = publishable();
    const w = world();
    const first = await publishAll(ctx, [instagram(graph)], {}, w.deps, recordingLog().log).catch((e: unknown) => e);
    expect((first as StageFailedError).ctx.publications?.instagram?.reason).toMatch(/HTTP 503/);
    const { sessionUri } = JSON.parse(readFileSync(join(ctx.runDir, journalFile("instagram")), "utf8")) as { sessionUri: string };
    const out = await publishAll(ctx, [instagram(graph)], {}, w.deps, recordingLog().log);
    const uploads = graph.calls.filter((c) => c.url.host === "rupload.facebook.com");
    expect(uploads).toHaveLength(4);
    expect(uploads.every((c) => c.url.pathname.endsWith(`/${sessionUri}`))).toBe(true);
    expect(uploads[3]!.init.headers).toMatchObject({ offset: "0", file_size: "4096" }); // video_status unavailable: from byte 0
    expect(graph.created()).toBe(1);
    expect(out.publications?.instagram?.status).toBe("uploaded");
  });

  it("media_publish that drops the connection after publishing is recovered from the container, not re-published", async () => {
    const graph = fakeGraph({ publishDropsConnection: true });
    const w = world();
    const out = await publishAll(publishable(), [instagram(graph)], {}, w.deps, recordingLog().log);
    expect(graph.media).toHaveLength(1);
    expect(out.publications?.instagram).toMatchObject({ status: "uploaded", videoId: graph.media[0]!.id });
    expect(graph.calls.filter((c) => c.url.pathname.endsWith("/media_publish"))).toHaveLength(1);
  });

  it("a crash after media_publish (container PUBLISHED, no id journaled) records the existing post", async () => {
    const graph = fakeGraph();
    const ctx = publishable();
    await publishAll(ctx, [instagram(graph)], {}, world().deps, recordingLog().log);
    // Simulate losing everything after publish: journal back to pending with only the container id.
    const file = join(ctx.runDir, journalFile("instagram"));
    const journal = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...journal, status: "pending", videoId: undefined, uploadedAt: undefined }));
    const w = world();
    const out = await publishAll(ctx, [instagram(graph)], {}, w.deps, recordingLog().log);
    expect(graph.media).toHaveLength(1);
    expect(graph.created()).toBe(1);
    expect(out.publications?.instagram?.videoId).toBe(graph.media[0]!.id);
    expect(w.history.map((r) => r.videoId)).toEqual([graph.media[0]!.id]);
  });

  it("transient rupload failures retry into the same container", async () => {
    const graph = fakeGraph({ uploadFailures: 2 });
    const out = await publishAll(publishable(), [instagram(graph)], {}, world().deps, recordingLog().log);
    expect(out.publications?.instagram?.status).toBe("uploaded");
    expect(graph.calls.filter((c) => c.url.host === "rupload.facebook.com")).toHaveLength(3);
    expect(graph.created()).toBe(1);
  });

  it("status polling gives up after the timeout (with backoff between polls)", async () => {
    const graph = fakeGraph({ processingPolls: Infinity });
    let clock = 0;
    const waits: number[] = [];
    const options: PublishReelOptions = { now: () => clock, sleep: async (ms) => void (waits.push(ms), (clock += ms)), pollTimeoutMs: 60_000, pollDelaysMs: [5_000, 10_000, 30_000] };
    const error = await publishAll(publishable(), [instagram(graph, { publishOptions: options })], {}, world().deps, recordingLog().log).catch((e: unknown) => e);
    expect((error as StageFailedError).ctx.publications?.instagram?.reason).toMatch(/still processing container \d+ after 60 s/);
    expect(waits).toEqual([5_000, 10_000, 30_000, 15_000]);
    expect(graph.calls.some((c) => c.url.pathname.endsWith("/media_publish"))).toBe(false);
  });

  it("Meta's publishing limit blocks before any container is created", async () => {
    const graph = fakeGraph({ quotaUsage: 50 });
    const error = await publishAll(publishable(), [instagram(graph)], {}, world().deps, recordingLog().log).catch((e: unknown) => e);
    expect((error as StageFailedError).ctx.publications?.instagram).toMatchObject({ status: "failed", reason: expect.stringMatching(/publishing limit reached \(50\/50/) });
    expect(graph.created()).toBe(0);
  });

  it("the local daily cap counts only Instagram's own records", async () => {
    const records: UploadRecord[] = [1, 2, 3].map((h) => ({
      runId: `r${h}`, videoId: `v${h}`, title: "t", publishedAt: new Date(NOW.getTime() - h * 3600_000).toISOString(),
      privacyStatus: "public", requestedPrivacyStatus: "public", categoryId: "27", topicCategoryId: "espaco", platform: "youtube",
    }));
    const graph = fakeGraph();
    const out = await publishAll(publishable(), [instagram(graph, { maxPostsPerDay: 1 })], {}, world(records).deps, recordingLog().log);
    expect(out.publications?.instagram?.status).toBe("uploaded");
  });

  it("a missing or expired token blocks Instagram only; YouTube still publishes", async () => {
    const graph = fakeGraph();
    const w = world();
    const posted: string[] = [];
    const uploader: YouTubeUploader = {
      upload: async (_f, _r, _p, session) => (await session?.onSession("https://upload/yt"), posted.push("yt"), { id: "yt1" }),
      getPrivacyStatus: async () => "public",
      close: async () => undefined,
    };
    const youtube = createYouTubePublisher({ enabled: true, privacyStatus: "public", categoryId: "27", maxUploadsPerDay: 3, containsSyntheticMedia: false }, async () => uploader);
    const expired = tokenFile({ expiresAt: new Date(NOW.getTime() - 1).toISOString() });
    const { log, lines } = recordingLog();
    const error = await publishAll(publishable(), [instagram(graph, { file: expired }), youtube], {}, w.deps, log).catch((e: unknown) => e);
    const ctx = (error as StageFailedError).ctx;
    expect(ctx.publications?.youtube).toMatchObject({ status: "uploaded", videoId: "yt1" });
    expect(ctx.upload).toMatchObject({ status: "uploaded", videoId: "yt1" });
    expect(ctx.publications?.instagram).toMatchObject({ status: "failed", reason: expect.stringMatching(/blocked: Instagram token expired/) });
    expect(posted).toEqual(["yt"]);
    expect(graph.calls).toEqual([]);
    expect(w.history.map((r) => r.platform)).toEqual(["youtube"]);
    expect(lines.some((l) => l.startsWith("E [instagram] Publishing failed: blocked: Instagram token expired"))).toBe(true);
  });

  it("an Instagram API failure does not affect YouTube, and the token never reaches logs or context", async () => {
    const graph = fakeGraph({ failContainerCreate: true });
    registerSecret(TOKEN);
    const uploader: YouTubeUploader = { upload: async () => ({ id: "yt9" }), getPrivacyStatus: async () => "public", close: async () => undefined };
    const youtube = createYouTubePublisher({ enabled: true, privacyStatus: "public", categoryId: "27", maxUploadsPerDay: 3, containsSyntheticMedia: false }, async () => uploader);
    const { log, lines } = recordingLog();
    const error = await publishAll(publishable(), [youtube, instagram(graph)], {}, world().deps, log).catch((e: unknown) => e);
    const ctx = (error as StageFailedError).ctx;
    expect(ctx.publications?.youtube?.status).toBe("uploaded");
    expect(ctx.publications?.instagram?.status).toBe("failed");
    expect(ctx.publications?.instagram?.reason).toContain("access_token=***");
    expect(JSON.stringify(ctx)).not.toContain(TOKEN);
    expect(lines.join("\n")).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------------------------
// video_url through a temporary tunnel (fake tunnel; no cloudflared, no network)
// ---------------------------------------------------------------------------------------------

describe("Instagram via temporary tunnel", () => {
  const TUNNEL_URL = "https://quiet-river-blue-moon.trycloudflare.com/video.mp4";

  function fakeTunnel(fail?: Error) {
    const events: string[] = [];
    const serveTunnel = async (filePath: string): Promise<VideoTunnel> => {
      events.push(`open ${filePath.endsWith("final.mp4") ? "final.mp4" : filePath}`);
      if (fail) throw fail;
      return { url: TUNNEL_URL, close: async () => void events.push("close") };
    };
    return { serveTunnel, events };
  }

  function youtubeOk() {
    const posted: string[] = [];
    const uploader: YouTubeUploader = {
      upload: async (_f, _r, _p, session) => (await session?.onSession("https://upload/yt"), posted.push("yt"), { id: "yt1" }),
      getPrivacyStatus: async () => "public",
      close: async () => undefined,
    };
    const publisher = createYouTubePublisher({ enabled: true, privacyStatus: "public", categoryId: "27", maxUploadsPerDay: 3, containsSyntheticMedia: false }, async () => uploader);
    return { publisher, posted };
  }

  it("creates the container with video_url (no rupload) and closes the tunnel before media_publish", async () => {
    const graph = fakeGraph({ processingPolls: 1 });
    const tunnel = fakeTunnel();
    const order: string[] = [];
    const http: HttpFetch = async (raw, init) => {
      if (new URL(raw).pathname.endsWith("/media_publish")) order.push(`publish (tunnel events: ${tunnel.events.join(",")})`);
      return graph.http(raw, init);
    };
    const publisher = createInstagramPublisher({ enabled: true, maxPostsPerDay: 3 }, { tokenFile: tokenFile(), now: () => NOW, http, publishOptions: { ...FAST, serveTunnel: tunnel.serveTunnel } });
    const out = await publishAll(publishable(), [publisher], {}, world().deps, recordingLog().log);
    const create = graph.calls.find((c) => c.method === "POST" && c.url.pathname.endsWith(`${IG_USER}/media`))!;
    expect(Object.fromEntries(new URLSearchParams(String(create.init.body)))).toMatchObject({ media_type: "REELS", video_url: TUNNEL_URL });
    expect(graph.calls.some((c) => c.url.host === "rupload.facebook.com")).toBe(false);
    expect(tunnel.events).toEqual(["open final.mp4", "close"]);
    expect(order).toEqual(["publish (tunnel events: open final.mp4,close)"]);
    expect(out.publications?.instagram).toMatchObject({ status: "uploaded", videoId: graph.media[0]!.id });
  });

  it("the tunnel is closed when processing fails (container ERROR)", async () => {
    const graph = fakeGraph();
    const tunnel = fakeTunnel();
    const http: HttpFetch = async (raw, init) => {
      const res = await graph.http(raw, init);
      graph.containers.forEach((c) => (c.statusCode = "ERROR")); // Meta could not process the video
      return res;
    };
    const publisher = createInstagramPublisher({ enabled: true, maxPostsPerDay: 3 }, { tokenFile: tokenFile(), now: () => NOW, http, publishOptions: { ...FAST, serveTunnel: tunnel.serveTunnel } });
    const error = await publishAll(publishable(), [publisher], {}, world().deps, recordingLog().log).catch((e: unknown) => e);
    expect((error as StageFailedError).ctx.publications?.instagram).toMatchObject({ status: "failed", reason: expect.stringMatching(/is ERROR/) });
    expect(tunnel.events).toEqual(["open final.mp4", "close"]);
    expect(graph.media).toEqual([]);
  });

  it("cloudflared missing: Instagram fails with a clear reason, no container is created, YouTube still publishes", async () => {
    const graph = fakeGraph();
    const tunnel = fakeTunnel(new TunnelError("cloudflared não foi encontrado (cloudflared). Instale o Cloudflare Tunnel"));
    const yt = youtubeOk();
    const w = world();
    const ctx = publishable();
    const { log, lines } = recordingLog();
    const ig = instagram(graph, { publishOptions: { ...FAST, serveTunnel: tunnel.serveTunnel } });
    const error = await publishAll(ctx, [ig, yt.publisher], {}, w.deps, log).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StageFailedError);
    const out = (error as StageFailedError).ctx;
    expect(out.publications?.youtube).toMatchObject({ status: "uploaded", videoId: "yt1" });
    expect(out.publications?.instagram).toMatchObject({ status: "failed", reason: expect.stringMatching(/cloudflared não foi encontrado/) });
    expect(yt.posted).toEqual(["yt"]);
    expect(graph.created()).toBe(0);
    expect(w.history.map((r) => r.platform)).toEqual(["youtube"]);
    const journal = JSON.parse(readFileSync(join(ctx.runDir, journalFile("instagram")), "utf8")) as { sessionUri?: string };
    expect(journal.sessionUri).toBeUndefined(); // nothing to resume: the next run starts clean
    expect(lines.some((l) => l.startsWith("E [instagram] Publishing failed: cloudflared não foi encontrado"))).toBe(true);
  });

  it("serveTunnel: null keeps the resumable rupload path", async () => {
    const graph = fakeGraph();
    const out = await publishAll(publishable(), [instagram(graph, { publishOptions: { ...FAST, serveTunnel: null } })], {}, world().deps, recordingLog().log);
    expect(graph.calls.filter((c) => c.url.host === "rupload.facebook.com")).toHaveLength(1);
    expect(out.publications?.instagram?.status).toBe("uploaded");
  });

  it("a journaled container is resumed without opening a new tunnel", async () => {
    const graph = fakeGraph({ processingPolls: Infinity });
    const ctx = publishable();
    const w = world();
    let clock = 0;
    const first = fakeTunnel();
    const timed: PublishReelOptions = { now: () => clock, sleep: async (ms) => void (clock += ms), pollTimeoutMs: 3000, pollDelaysMs: [1000], serveTunnel: first.serveTunnel };
    await publishAll(ctx, [instagram(graph, { publishOptions: timed })], {}, w.deps, recordingLog().log).catch(() => undefined);
    expect(first.events).toEqual(["open final.mp4", "close"]); // closed on the poll timeout too
    const journal = JSON.parse(readFileSync(join(ctx.runDir, journalFile("instagram")), "utf8")) as { sessionUri: string };
    graph.containers.get(journal.sessionUri)!.pollsUntilFinished = 0;
    const second = fakeTunnel();
    const out = await publishAll(ctx, [instagram(graph, { publishOptions: { ...FAST, serveTunnel: second.serveTunnel } })], {}, w.deps, recordingLog().log);
    expect(second.events).toEqual([]);
    expect(graph.created()).toBe(1);
    expect(out.publications?.instagram?.status).toBe("uploaded");
  });
});

// ---------------------------------------------------------------------------------------------
// Redaction and request hygiene
// ---------------------------------------------------------------------------------------------

describe("Instagram secrets in errors and logs", () => {
  it.each([
    [`GET https://graph.instagram.com/v25.0/me?fields=user_id&access_token=${TOKEN}`, "GET https://graph.instagram.com/v25.0/me?fields=user_id&access_token=***"],
    [`access_token=${TOKEN}&creation_id=1`, "access_token=***&creation_id=1"],
    [`refresh_access_token?grant_type=ig_refresh_token&access_token=${TOKEN}`, "refresh_access_token?grant_type=ig_refresh_token&access_token=***"],
    [`Authorization: OAuth ${TOKEN}`, "Authorization: OAuth ***"],
    [`{"access_token":"${TOKEN}","expires_in":5184000}`, '{"access_token":"***","expires_in":5184000}'],
  ])("masks %s", (input, expected) => {
    expect(redactSecrets(input, {})).toBe(expected);
  });

  it("keeps ordinary 'OAuth client ...' prose intact", () => {
    expect(redactSecrets("OAuth client file not found", {})).toBe("OAuth client file not found");
  });

  it("masks a registered token literal anywhere and the Instagram app secret from the env", () => {
    registerSecret("IGQVJliteralTokenSeenInSomeBody1234");
    expect(redactSecrets("body: IGQVJliteralTokenSeenInSomeBody1234 end", {})).toBe("body: *** end");
    expect(redactSecrets("secret ig-app-secret-0123456789 leaked", { INSTAGRAM_APP_SECRET: "ig-app-secret-0123456789" })).toBe("secret *** leaked");
  });

  it("API errors carry method + path only (no query string) and are redacted at construction", async () => {
    const http: HttpFetch = async () => ({ status: 400, text: async () => JSON.stringify({ error: { message: `Invalid OAuth access token - Cannot parse access token ${TOKEN}`, code: 190 } }) });
    const error = (await requestJson(http, `https://graph.instagram.com/v25.0/me?access_token=${TOKEN}`, { method: "GET" }).catch((e: unknown) => e)) as InstagramApiError;
    expect(error).toBeInstanceOf(InstagramApiError);
    expect(error.code).toBe(190);
    expect(error.message).toMatch(/^GET graph\.instagram\.com\/v25\.0\/me -> HTTP 400 \(code 190\)/);
    expect(error.message).toContain("npm run auth:instagram");
    expect(error.message).not.toContain(TOKEN);
  });

  it("network errors never echo the URL", async () => {
    const http: HttpFetch = async () => {
      throw new TypeError("fetch failed");
    };
    const error = (await requestJson(http, `https://graph.instagram.com/v25.0/me?access_token=${TOKEN}`, { method: "GET" }).catch((e: unknown) => e)) as InstagramApiError;
    expect(error.message).toBe("GET graph.instagram.com/v25.0/me failed: fetch failed");
    expect(error.retriable).toBe(true);
  });

  it("uploads only ever go to rupload.facebook.com", () => {
    expect(ruploadUrl("17900000000000001", "https://rupload.facebook.com/ig-api-upload/v25.0/17900000000000001")).toBe("https://rupload.facebook.com/ig-api-upload/v25.0/17900000000000001");
    expect(ruploadUrl("17900000000000001", "https://evil.example/ig-api-upload/17900000000000001")).toBe("https://rupload.facebook.com/ig-api-upload/v25.0/17900000000000001");
    expect(() => ruploadUrl("../me")).toThrow(/Invalid Instagram container id/);
  });
});

// ---------------------------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------------------------

describe("Instagram insights", () => {
  const body = {
    data: [
      { name: "views", period: "lifetime", values: [{ value: 1520 }] },
      { name: "reach", period: "lifetime", values: [{ value: 1210 }] },
      { name: "likes", period: "lifetime", values: [{ value: 87 }] },
      { name: "comments", period: "lifetime", total_value: { value: 9 } },
    ],
  };

  it("maps views->plays, saved->saves and leaves metrics without data as null", () => {
    expect(parseInsights("18000000000000001", body, NOW)).toEqual({
      mediaId: "18000000000000001", plays: 1520, reach: 1210, likes: 87, comments: 9, saves: null, fetchedAt: NOW.toISOString(),
    });
  });

  it("requests the Reel metrics on graph.instagram.com and isolates per-media failures", async () => {
    const urls: URL[] = [];
    const http: HttpFetch = async (raw) => {
      const url = new URL(raw);
      urls.push(url);
      return url.pathname.includes("18000000000000002")
        ? { status: 400, text: async () => JSON.stringify({ error: { message: "Media not found", code: 100 } }) }
        : { status: 200, text: async () => JSON.stringify(body) };
    };
    const one = await fetchReelInsights("18000000000000001", { accessToken: TOKEN, http, now: () => NOW });
    expect(one.plays).toBe(1520);
    expect(urls[0]!.toString()).toBe(`https://graph.instagram.com/v25.0/18000000000000001/insights?metric=views%2Creach%2Clikes%2Ccomments%2Csaved&access_token=${TOKEN}`);
    const many = await fetchManyReelInsights(["18000000000000001", "18000000000000002"], { accessToken: TOKEN, http, now: () => NOW });
    expect(many[0]).toMatchObject({ plays: 1520 });
    expect(many[1]).toEqual({ mediaId: "18000000000000002", error: expect.stringContaining("Media not found") });
    expect(JSON.stringify(many)).not.toContain(TOKEN);
  });
});
