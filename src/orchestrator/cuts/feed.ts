/**
 * New-video detection for cuts: the channel's official RSS feed + a processed-videos journal.
 * The feed does not flag live streams; see `isLikelyLive` for the heuristic we can apply.
 */
import { join } from "node:path";
import { paths } from "../lib/config.js";
import { readJsonIfExists, withFileLock, writeFileAtomic } from "../lib/fileLock.js";

export interface FeedVideo {
  videoId: string;
  title: string;
  /** ISO 8601 from <published>. */
  published: string;
  url: string;
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
 * The RSS has no live marker. Titles with "ao vivo"/"live" are skipped as a cheap heuristic; yt-dlp
 * later refuses in-progress lives anyway (`is_live`), so a false negative only costs one failed download.
 */
export function isLikelyLive(video: FeedVideo): boolean {
  return /\b(ao vivo|live|🔴)\b/i.test(video.title);
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
