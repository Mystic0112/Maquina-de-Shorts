// Minimal YouTube Data API v3 client (API key, public data only). The key never leaves this module:
// it is not logged, not returned, and scrubbed from any error text.
import type { ChannelStats, VideoStats } from "../shared/api.js";

const API_BASE = "https://www.googleapis.com/youtube/v3";
const BATCH_SIZE = 50; // videos.list accepts up to 50 ids per call (1 quota unit each call)

export interface VideoDetails extends VideoStats {
  title: string | null;
  publishedAt: string | null;
  durationIso: string | null;
}

interface ApiItem {
  id?: string;
  snippet?: { title?: string; publishedAt?: string };
  statistics?: Record<string, string | boolean | undefined>;
  contentDetails?: { duration?: string };
}

function scrub(text: string, apiKey: string): string {
  return apiKey ? text.split(apiKey).join("***") : text;
}

async function apiGet(apiKey: string, endpoint: string, params: Record<string, string>): Promise<ApiItem[]> {
  const url = new URL(`${API_BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("key", apiKey);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const body = (await res.json().catch(() => null)) as { items?: ApiItem[]; error?: { message?: string } } | null;
    if (!res.ok) throw new Error(`YouTube ${endpoint}: HTTP ${res.status} ${body?.error?.message ?? ""}`.trim());
    return body?.items ?? [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(scrub(message, apiKey));
  }
}

function num(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

export async function fetchVideos(apiKey: string, ids: string[]): Promise<Map<string, VideoDetails>> {
  const out = new Map<string, VideoDetails>();
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const items = await apiGet(apiKey, "videos", { part: "statistics,snippet,contentDetails", id: batch.join(",") });
    for (const item of items) {
      if (!item.id) continue;
      out.set(item.id, {
        views: num(item.statistics?.viewCount) ?? 0,
        likes: num(item.statistics?.likeCount), // hidden like counts come back absent
        comments: num(item.statistics?.commentCount),
        title: item.snippet?.title ?? null,
        publishedAt: item.snippet?.publishedAt ?? null,
        durationIso: item.contentDetails?.duration ?? null,
      });
    }
  }
  return out;
}

export async function fetchChannel(apiKey: string, channelId: string): Promise<ChannelStats | null> {
  const [item] = await apiGet(apiKey, "channels", { part: "statistics,snippet", id: channelId });
  if (!item) return null;
  const hidden = item.statistics?.hiddenSubscriberCount === true;
  return {
    title: item.snippet?.title ?? null,
    subscribers: hidden ? null : num(item.statistics?.subscriberCount),
    views: num(item.statistics?.viewCount) ?? 0,
    videoCount: num(item.statistics?.videoCount) ?? 0,
  };
}
