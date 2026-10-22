/**
 * New-video detection for cuts: the channel's official RSS feed + a processed-videos journal.
 * The feed does not flag live streams; see `isLikelyLive` for the heuristic we can apply.
 */
import { join } from "node:path";
import { paths } from "../lib/config.js";
import { runBinary } from "../lib/ffmpeg.js";
import { readJsonIfExists, withFileLock, writeFileAtomic } from "../lib/fileLock.js";

export interface FeedVideo {
  videoId: string;
  title: string;
  /** ISO 8601 from <published>. */
  published: string;
  url: string;
  /** Known for TikTok listings (the YouTube RSS has no duration). */
  durationSeconds?: number;
}

/**
 * `yt-dlp --flat-playlist -J https://www.tiktok.com/@handle` -> newest-first videos. TikTok has no title: the
 * caption (description) stands in for it.
 */
export function parseTikTokListing(json: unknown, handle: string): FeedVideo[] {
  const entries = ((json ?? {}) as { entries?: Record<string, unknown>[] }).entries ?? [];
  const videos: FeedVideo[] = [];
  for (const e of entries) {
    const videoId = typeof e.id === "string" && /^\d{8,25}$/.test(e.id) ? e.id : null;
    if (!videoId) continue;
    const text = [e.title, e.description].find((v): v is string => typeof v === "string" && v.trim() !== "") ?? "";
    const timestamp = typeof e.timestamp === "number" ? e.timestamp : null;
    videos.push({
      videoId,
      title: text.trim(),
      published: timestamp ? new Date(timestamp * 1000).toISOString() : "",
      url: `https://www.tiktok.com/${handle}/video/${videoId}`,
      durationSeconds: typeof e.duration === "number" ? e.duration : undefined,
    });
  }
  return videos;
}

export const FEED_URL = (channelId: string): string => `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;

const ENTRY_RE = /<entry>([\s\S]*?)<\/entry>/g;

function tag(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return match?.[1]?.trim();
}

function unescapeXml(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

/** Pulls id/title/published out of every <entry> (regex parser: the YouTube feed is small and regular). */
export function parseFeed(xml: string): FeedVideo[] {
  const videos: FeedVideo[] = [];
  for (const [, entry] of xml.matchAll(ENTRY_RE)) {
    const videoId = tag(entry ?? "", "yt:videoId");
    if (!videoId || !/^[\w-]{11}$/.test(videoId)) continue;
    videos.push({
      videoId,
      title: unescapeXml(tag(entry ?? "", "title") ?? ""),
      published: tag(entry ?? "", "published") ?? "",
      url: `https://www.youtube.com/watch?v=${videoId}`,
    });
  }
  return videos;
}

/**
 * The RSS has no live marker. Titles with "ao vivo"/"live"/🔴 are skipped as a cheap heuristic; yt-dlp
 * later refuses in-progress lives anyway (`is_live`), so a false negative only costs one failed download.
 */
export function isLikelyLive(video: FeedVideo): boolean {
  // 🔴 stays outside \b: a word boundary never sits next to an emoji (non-word on both sides).
  return /\b(ao vivo|live)\b|🔴/i.test(video.title);
}

export async function fetchChannelFeed(channelId: string, fetchFn: typeof fetch = fetch): Promise<FeedVideo[]> {
  const response = await fetchFn(FEED_URL(channelId), { headers: { "user-agent": "maquina-de-shorts/cuts" } });
  if (!response.ok) throw new Error(`RSS feed for ${channelId} returned HTTP ${response.status}`);
  return parseFeed(await response.text());
}

// ---------------------------------------------------------------------------------------------
// Processed journal (anti-duplicate)
// ---------------------------------------------------------------------------------------------

export interface ProcessedEntry {
  channelId: string;
  videoId: string;
  at: string;
  /** "done" produced clips; "skipped" is remembered too so we never retry an age-gated/failed video forever. */
  status: "done" | "skipped";
  reason?: string;
  runIds?: string[];
}

export const PROCESSED_FILE = join(paths.data, "cuts", "processed.json");

async function readJournal(file: string): Promise<ProcessedEntry[]> {
  const raw = await readJsonIfExists(file);
  return Array.isArray(raw) ? (raw as ProcessedEntry[]) : [];
}

export async function listProcessed(file = PROCESSED_FILE): Promise<ProcessedEntry[]> {
  return readJournal(file);
}

export async function isProcessed(videoId: string, file = PROCESSED_FILE): Promise<boolean> {
  return (await readJournal(file)).some((e) => e.videoId === videoId);
}

/** Appends (or replaces) the entry for a video under a file lock + atomic write. */
export async function markProcessed(entry: Omit<ProcessedEntry, "at">, file = PROCESSED_FILE): Promise<void> {
  await withFileLock(`${file}.lock`, { waitMs: 10_000, staleMs: 60_000 }, async () => {
    const entries = (await readJournal(file)).filter((e) => e.videoId !== entry.videoId);
    entries.push({ ...entry, at: new Date().toISOString() });
    await writeFileAtomic(file, `${JSON.stringify(entries, null, 2)}\n`);
  });
}

/** Videos from the feed that are not in the journal and do not look like lives. */
export function pickNewVideos(feed: readonly FeedVideo[], processed: readonly ProcessedEntry[]): FeedVideo[] {
  const seen = new Set(processed.map((e) => e.videoId));
  return feed.filter((v) => !seen.has(v.videoId) && !isLikelyLive(v));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How many videos of this channel may still be processed now: `maxPerDay` minus the "done" journal entries
 * of the last 24 h (skipped videos produced nothing and do not count), so repeated --scan runs share one quota.
 */
export function remainingDailyQuota(processed: readonly ProcessedEntry[], channelId: string, maxPerDay: number, now = Date.now()): number {
  const recent = processed.filter((e) => e.channelId === channelId && e.status === "done" && now - Date.parse(e.at) < DAY_MS);
  // A compilation journals each of its source videos with the same runIds: count it once.
  const units = new Set(recent.map((e) => e.runIds?.join(",") || e.videoId));
  return Math.max(0, maxPerDay - units.size);
}

/** Newest TikTok posts of @handle, listed by yt-dlp (no login, no download). */
export async function fetchTikTokFeed(handle: string, ytDlp: string, limit = 30): Promise<FeedVideo[]> {
  const { stdout } = await runBinary(ytDlp, ["--flat-playlist", "-J", "--no-warnings", "--playlist-items", `1:${limit}`, `https://www.tiktok.com/${handle}`], 3 * 60 * 1000);
  return parseTikTokListing(JSON.parse(stdout) as unknown, handle);
}
