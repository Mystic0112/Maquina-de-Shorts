import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { assertChannelAuthorized, ChannelNotAuthorizedError, parseCutsConfig, type CutChannel } from "../../src/orchestrator/cuts/config.js";
import { buildCutRunContext } from "../../src/orchestrator/cuts/context.js";
import { buildReencodeArgs, buildYtDlpArgs, isLoginRequiredOutput, LoginRequiredError, parseVideoId } from "../../src/orchestrator/cuts/download.js";
import { isLikelyLive, isProcessed, listProcessed, markProcessed, parseFeed, pickNewVideos, remainingDailyQuota, type ProcessedEntry } from "../../src/orchestrator/cuts/feed.js";
import { processOrSkip } from "../../src/orchestrator/cuts/pipeline.js";
import { buildRenderPayload, wordsInWindow } from "../../src/orchestrator/cuts/render.js";
import { buildSelectPrompt, selectClips, snapToSegments, transcriptSlice, validatePicks } from "../../src/orchestrator/cuts/select.js";
import type { LlmProvider } from "../../src/orchestrator/lib/llmClient.js";

const channel: CutChannel = {
  id: "UCvgSmIdI92W4KnP15fJwfwA",
  name: "ACF",
  enabled: true,
  authorization: { url: "https://example.com/post", conditions: ["crédito: ACF (@media.acf)"] },
  credit: "Cortes do canal ACF (@media.acf)",
};

const exampleConfig = JSON.parse(readFileSync(join(import.meta.dirname, "../../config/cuts.example.json"), "utf8")) as unknown;

describe("authorization gate", () => {
  it("accepts an enabled channel with an authorization url", () => {
    expect(() => assertChannelAuthorized(channel)).not.toThrow();
  });
  it("refuses a channel without authorization url, with a clear message", () => {
    const noUrl = { ...channel, authorization: { ...channel.authorization, url: "  " } };
    expect(() => assertChannelAuthorized(noUrl)).toThrow(ChannelNotAuthorizedError);
    expect(() => assertChannelAuthorized(noUrl)).toThrow(/authorization\.url/);
  });
  it("refuses a disabled channel even with a url", () => {
    expect(() => assertChannelAuthorized({ ...channel, enabled: false })).toThrow(/enabled: false/);
  });
  it("the shipped example is valid and NOT authorized (ACF link pending)", () => {
    const config = parseCutsConfig(exampleConfig, "cuts.example.json");
    expect(config.channels[0]?.id).toBe("UCvgSmIdI92W4KnP15fJwfwA");
    expect(() => assertChannelAuthorized(config.channels[0] as CutChannel)).toThrow(ChannelNotAuthorizedError);
    expect(() => parseCutsConfig({ ...(exampleConfig as object), clip: { minSeconds: 60, maxSeconds: 30, perVideo: 1, framing: "face", captions: { wordsPerCue: 3, color: "#FFE11A" } } })).toThrow(/minSeconds/);
  });
});

const FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
 <title>ACF</title>
 <entry><id>yt:video:H4pkbm4ypUw</id><yt:videoId>H4pkbm4ypUw</yt:videoId><yt:channelId>UCvgSmIdI92W4KnP15fJwfwA</yt:channelId>
  <title>OU QUEBRA OU PASSA DOS 800WHP! &amp; mais</title><published>2026-10-18T12:00:00+00:00</published></entry>
 <entry><id>yt:video:abcdefghijk</id><yt:videoId>abcdefghijk</yt:videoId><title>Live AO VIVO da oficina</title><published>2026-10-17T12:00:00+00:00</published></entry>
</feed>`;

describe("rss feed + journal", () => {
  it("parses entries with id, title (unescaped) and date", () => {
    const videos = parseFeed(FEED_XML);
    expect(videos).toHaveLength(2);
    expect(videos[0]).toMatchObject({ videoId: "H4pkbm4ypUw", title: "OU QUEBRA OU PASSA DOS 800WHP! & mais", published: "2026-10-18T12:00:00+00:00" });
    expect(videos[0]?.url).toBe("https://www.youtube.com/watch?v=H4pkbm4ypUw");
  });
  it("skips processed videos and likely lives", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "cuts-journal-")), "processed.json");
    expect(await isProcessed("H4pkbm4ypUw", file)).toBe(false);
    await markProcessed({ channelId: channel.id, videoId: "H4pkbm4ypUw", status: "done", runIds: ["r1"] }, file);
    await markProcessed({ channelId: channel.id, videoId: "H4pkbm4ypUw", status: "done", runIds: ["r1", "r2"] }, file);
    const journal = JSON.parse(readFileSync(file, "utf8")) as { videoId: string; runIds: string[] }[];
    expect(journal).toHaveLength(1);
    expect(journal[0]?.runIds).toEqual(["r1", "r2"]);
    expect(await isProcessed("H4pkbm4ypUw", file)).toBe(true);
    expect(pickNewVideos(parseFeed(FEED_XML), journal.map((e) => ({ ...e, channelId: channel.id, at: "", status: "done" as const })))).toEqual([]);
    expect(pickNewVideos(parseFeed(FEED_XML), []).map((v) => v.videoId)).toEqual(["H4pkbm4ypUw"]);
  });
});

describe("live heuristic, daily quota and login-gated videos", () => {
  const video = (title: string) => ({ videoId: "H4pkbm4ypUw", title, published: "", url: "" });

  it("flags lives by title, including the 🔴 emoji, but not words that merely contain 'live'", () => {
    expect(isLikelyLive(video("🔴 AO VIVO: corrida"))).toBe(true);
    expect(isLikelyLive(video("🔴 corrida agora"))).toBe(true);
    expect(isLikelyLive(video("Treino ao vivo"))).toBe(true);
    expect(isLikelyLive(video("LIVE de sábado"))).toBe(true);
    expect(isLikelyLive(video("A lively build of an old car"))).toBe(false);
  });

  it("counts only this channel's 'done' videos of the last 24 h against maxVideosPerDay", () => {
    const now = Date.parse("2026-10-22T12:00:00Z");
    const entry = (at: string, extra: Partial<ProcessedEntry> = {}): ProcessedEntry => ({ channelId: channel.id, videoId: at, at, status: "done", ...extra });
    const journal = [
      entry("2026-10-22T08:00:00Z"),
      entry("2026-10-21T12:30:00Z"),
      entry("2026-10-21T11:00:00Z"), // older than 24 h
      entry("2026-10-22T09:00:00Z", { status: "skipped" }),
      entry("2026-10-22T10:00:00Z", { channelId: "UCotherotherotherother00" }),
    ];
    expect(remainingDailyQuota(journal, channel.id, 3, now)).toBe(1);
    expect(remainingDailyQuota(journal, channel.id, 2, now)).toBe(0);
    expect(remainingDailyQuota(journal, channel.id, 1, now)).toBe(0);
    expect(remainingDailyQuota([], channel.id, 1, now)).toBe(1);
  });

  it("a login-gated video is journaled as skipped and yields no runs (exit 3), other errors propagate", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "cuts-journal-")), "processed.json");
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    const config = parseCutsConfig(exampleConfig, "cuts.example.json");
    const gated = vi.fn().mockRejectedValue(new LoginRequiredError("yt-dlp needs a login for this video (age/privacy gate); skipping"));
    await expect(processOrSkip(channel, "H4pkbm4ypUw", config, log, {}, gated, file)).resolves.toEqual({ runs: [], timings: [] });
    expect(await listProcessed(file)).toMatchObject([{ channelId: channel.id, videoId: "H4pkbm4ypUw", status: "skipped", reason: expect.stringMatching(/login/) }]);

    const broken = vi.fn().mockRejectedValue(new Error("disk full"));
    await expect(processOrSkip(channel, "abcdefghijk", config, log, {}, broken, file)).rejects.toThrow(/disk full/);
    expect(await isProcessed("abcdefghijk", file)).toBe(false);
  });
});

const segments = [
  { start: 0, end: 10, text: "a" },
  { start: 10, end: 25, text: "b" },
  { start: 25, end: 45, text: "c" },
  { start: 45, end: 70, text: "d" },
  { start: 70, end: 100, text: "e" },
];
const clip = { minSeconds: 30, maxSeconds: 60, perVideo: 2 };
const pick = (start: number, end: number) => ({ start, end, title: "Título", hook: "Gancho", reason: "porque sim" });

describe("clip selection", () => {
  it("validates duration, boundaries and overlap", () => {
    expect(validatePicks([pick(10, 45), pick(45, 100)], segments, clip)).toEqual([]);
    const issues = validatePicks([pick(10, 25), pick(12, 70), pick(0, 70)], segments, clip);
    expect(issues.map((i) => i.problem)).toEqual(expect.arrayContaining([
      expect.stringMatching(/duration 15\.00 s is outside/),
      expect.stringMatching(/start 12\.00 is not a segment start/),
      expect.stringMatching(/overlaps clip 3/),
      expect.stringMatching(/duration 70\.00 s is outside/),
    ]));
  });
  it("snaps near-miss boundaries and slices the transcript", () => {
    expect(snapToSegments(pick(10.4, 44.7), segments)).toMatchObject({ start: 10, end: 45 });
    expect(snapToSegments(pick(17, 45), segments).start).toBe(17);
    expect(transcriptSlice({ segments, words: [] }, 10, 45)).toBe("b c");
    expect(buildSelectPrompt({ channelName: "ACF", videoTitle: "T", transcript: { segments, words: [] }, clip })).toContain("[10.00 - 25.00] b");
  });
  it("re-asks with a correction when the model answers out of bounds", async () => {
    const answers = [
      JSON.stringify({ clips: [pick(10, 25), pick(30, 70)] }),
      JSON.stringify({ clips: [pick(10, 45), pick(45, 100)] }),
    ];
    const completeJson = vi.fn(async (prompt: string) => {
      if (completeJson.mock.calls.length === 2) expect(prompt).toMatch(/rejeitada pela validação[\s\S]*duration 15\.00/);
      return answers.shift() as string;
    });
    const provider = { name: "fake", model: "m", completeJson, completeGroundedText: vi.fn() } as unknown as LlmProvider;
    const picks = await selectClips({ channelName: "ACF", videoTitle: "T", transcript: { segments, words: [] }, clip }, { provider, attempts: 3 });
    expect(picks.map((p) => [p.start, p.end])).toEqual([[10, 45], [45, 100]]);
    expect(completeJson).toHaveBeenCalledTimes(2);
  });
});

describe("cut run context", () => {
  it("fills the RunContext fields the dashboard and stages 07/08 read, plus cut provenance", () => {
    const ctx = buildCutRunContext({ runId: "20261021-120000-ab12", channel, videoId: "H4pkbm4ypUw", videoTitle: "Vídeo", pick: pick(10, 45), narration: "b c", framing: "open", videoPath: "/x/final.mp4" });
    expect(ctx.runId).toBe("20261021-120000-ab12");
    expect(ctx.runDir).toMatch(/render_output[\\/]20261021-120000-ab12$/);
    expect(ctx.script).toEqual({ title: "Título", hook: "Gancho", scenes: [{ narration: "b c", footageQuery: "" }], cta: "", language: "pt-BR" });
    expect(ctx.render).toEqual({ videoPath: "/x/final.mp4", durationSeconds: 35, width: 1080, height: 1920 });
    expect(ctx.cut).toMatchObject({ channelId: channel.id, videoId: "H4pkbm4ypUw", sourceUrl: "https://www.youtube.com/watch?v=H4pkbm4ypUw", start: 10, end: 45, credit: channel.credit, authorizationUrl: "https://example.com/post", framing: "open" });
  });
});

describe("yt-dlp and render arguments", () => {
  it("parses ids from urls", () => {
    expect(parseVideoId("https://www.youtube.com/watch?v=H4pkbm4ypUw&t=10")).toBe("H4pkbm4ypUw");
    expect(parseVideoId("https://youtu.be/H4pkbm4ypUw")).toBe("H4pkbm4ypUw");
    expect(parseVideoId("H4pkbm4ypUw")).toBe("H4pkbm4ypUw");
    expect(() => parseVideoId("nope")).toThrow(/Not a YouTube/);
  });
  it("downloads without cookies, no playlist, no update, H.264 first, capped height", () => {
    const args = buildYtDlpArgs("https://www.youtube.com/watch?v=H4pkbm4ypUw", "/d/source.mp4", "/d/title.txt", 1080);
    expect(args).toEqual(expect.arrayContaining(["--no-playlist", "--no-update", "--no-cookies", "--merge-output-format", "mp4"]));
    expect(args[args.indexOf("-f") + 1]).toMatch(/^bv\*\[vcodec\^=avc1\]\[height<=1080\]/);
    expect(args.at(-1)).toBe("https://www.youtube.com/watch?v=H4pkbm4ypUw");
    expect(args).not.toContain("--cookies-from-browser");
    expect(isLoginRequiredOutput("ERROR: Sign in to confirm your age")).toBe(true);
    expect(isLoginRequiredOutput("ERROR: HTTP Error 403")).toBe(false);
    expect(buildReencodeArgs("/a.mp4", "/b.mp4")).toEqual(expect.arrayContaining(["-c:v", "libx264", "-c:a", "copy"]));
  });
  it("builds the render payload with hysteresis, framing, captions and the words of each window", () => {
    const words = [{ word: "x", start: 9, end: 9.5 }, { word: "y", start: 10, end: 10.4 }, { word: "z", start: 44.8, end: 45.02 }];
    const jobs = [{ start: 10, end: 45, out: "/o/a.mp4", words: wordsInWindow(words, 10, 45) }];
    expect(jobs[0]?.words.map((w) => w.word)).toEqual(["y", "z"]);
    const payload = buildRenderPayload({ source: "/s.mp4", framing: "open", credit: channel.credit, captions: { wordsPerCue: 3, color: "#FFE11A" }, jobs }, "/m/yunet.onnx", "ffmpeg");
    expect(payload).toMatchObject({ source: "/s.mp4", yunet: "/m/yunet.onnx", framing: "open", holdSeconds: 1.2, captions: { wordsPerCue: 3, color: "#FFE11A" }, credit: channel.credit });
    expect((payload.jobs as unknown[]).length).toBe(1);
  });
});
