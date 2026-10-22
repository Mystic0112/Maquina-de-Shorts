import { describe, expect, it } from "vitest";
import { buildConcatArgs, concatList, joinTranscripts, validateCompilation, type Candidate } from "../../src/orchestrator/cuts/compilation.js";
import { clipRangeFor, parseCutsConfig } from "../../src/orchestrator/cuts/config.js";
import { buildYtDlpArgs, sourceVideoUrl } from "../../src/orchestrator/cuts/download.js";
import { parseTikTokListing, remainingDailyQuota, type ProcessedEntry } from "../../src/orchestrator/cuts/feed.js";
import { cutCreditBlock } from "../../src/orchestrator/cuts/metadata.js";
import { parseChannelInput, resolveChannel } from "../../dashboard/server/cuts.js";

const tiktok = { id: "@capacetii", platform: "tiktok" as const, name: "Capaceti", enabled: true, style: "compilacao" as const, credit: "Vídeos de @capacetii no TikTok" };
const base = { clip: { minSeconds: 30, maxSeconds: 60, perVideo: 3, framing: "face" as const, captions: { wordsPerCue: 3, color: "#FFE11A" } }, download: { maxHeight: 1080, ytDlp: "yt-dlp" } };

describe("TikTok sources and compilations", () => {
  it("accepts a TikTok @handle channel and still refuses a malformed id per platform", () => {
    const config = parseCutsConfig({ ...base, channels: [tiktok] });
    expect(config.channels[0]).toMatchObject({ platform: "tiktok", style: "compilacao" });
    expect(clipRangeFor(config.channels[0] as never, config)).toEqual({ minSeconds: 45, maxSeconds: 90 });
    expect(() => parseCutsConfig({ ...base, channels: [{ ...tiktok, id: "UCvgSmIdI92W4KnP15fJwfwA" }] })).toThrow(/@handle/);
    expect(() => parseCutsConfig({ ...base, channels: [{ ...tiktok, platform: "youtube" }] })).toThrow(/UCxxx/);
  });

  it("lists TikTok posts (caption as title) and builds their URLs and download format", () => {
    const listing = { entries: [{ id: "7675525390068141332", title: "", description: "ROTA DE SP 🥶", duration: 28, timestamp: 1787097525 }, { id: "x", title: "bad id" }] };
    const videos = parseTikTokListing(listing, "@capacetii");
    expect(videos).toEqual([{ videoId: "7675525390068141332", title: "ROTA DE SP 🥶", published: new Date(1787097525000).toISOString(), url: "https://www.tiktok.com/@capacetii/video/7675525390068141332", durationSeconds: 28 }]);
    expect(sourceVideoUrl(tiktok, "123")).toBe("https://www.tiktok.com/@capacetii/video/123");
    const args = buildYtDlpArgs("u", "/o.mp4", "/t.txt", 1080, "tiktok");
    expect(args[args.indexOf("-f") + 1]).toMatch(/^b\[vcodec\^=h264\]/);
  });

  it("counts a compilation once against the daily limit", () => {
    const now = Date.parse("2026-10-22T20:00:00Z");
    const e = (videoId: string, runIds: string[]): ProcessedEntry => ({ channelId: "@capacetii", videoId, at: "2026-10-22T19:00:00Z", status: "done", runIds });
    expect(remainingDailyQuota([e("a", ["r1"]), e("b", ["r1"]), e("c", ["r1"])], "@capacetii", 2, now)).toBe(1);
  });

  const cand = (videoId: string, durationSeconds: number): Candidate => ({ videoId, url: `u/${videoId}`, caption: `c${videoId}`, durationSeconds, sourcePath: `/s/${videoId}.mp4`, transcript: { segments: [{ start: 0, end: 2, text: `fala ${videoId}` }], words: [] } });
  const pick = (videoIds: string[]) => ({ videoIds, title: "TÍTULO", hook: "h", reason: "r" });
  const range = { minSeconds: 45, maxSeconds: 90 };

  it("validates the agy's pick: count, repeats, unknown ids and total length", () => {
    const candidates = [cand("a", 20), cand("b", 30), cand("c", 50)];
    expect(validateCompilation(pick(["a", "b"]), candidates, range)).toEqual([]);
    expect(validateCompilation(pick(["a"]), candidates, range).join()).toMatch(/2 to 6/);
    expect(validateCompilation(pick(["a", "a", "b"]), candidates, range).join()).toMatch(/repeated/);
    expect(validateCompilation(pick(["a", "z"]), candidates, range).join()).toMatch(/unknown video id\(s\): z/);
    expect(validateCompilation(pick(["b", "c", "a"]), candidates, range).join()).toMatch(/100 s is outside/);
  });

  it("joins the parts on one timeline, lists them for the concat demuxer and credits every original", () => {
    expect(joinTranscripts([cand("a", 20), cand("b", 30)]).segments.map((s) => [s.start, s.text])).toEqual([[0, "fala a"], [20, "fala b"]]);
    expect(concatList(["/r/part_01.mp4", "/r/it's.mp4"])).toBe("file '/r/part_01.mp4'\nfile '/r/it'\\''s.mp4'\n");
    expect(buildConcatArgs("/l.txt", "/f.mp4")).toEqual(expect.arrayContaining(["-f", "concat", "-safe", "0", "-r", "30", "-ar", "48000"]));
    const credit = cutCreditBlock({ channelName: "Capaceti", sourceUrl: "u/a", credit: "Vídeos de @capacetii no TikTok", sources: [{ videoId: "a", url: "u/a", title: "" }, { videoId: "b", url: "u/b", title: "" }] });
    expect(credit).toBe("Compilação de vídeos do canal Capaceti. Originais:\nu/a\nu/b\nVídeos de @capacetii no TikTok\n(trecho recortado e editado)");
  });

  it("the panel takes a TikTok profile link without any lookup", async () => {
    expect(parseChannelInput("https://www.tiktok.com/@capacetii?lang=pt-BR")).toEqual({ kind: "tiktok", handle: "capacetii" });
    expect(parseChannelInput("tiktok.com/@capacetii/video/123")).toEqual({ kind: "tiktok", handle: "capacetii" });
    await expect(resolveChannel("tiktok.com/@capacetii", (() => { throw new Error("no network") }) as never)).resolves.toMatchObject({ ok: true, id: "@capacetii", platform: "tiktok" });
  });
});
