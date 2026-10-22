/**
 * Training data for the "what goes viral" decision model (Laya), taken from OTHER channels: our channel starts
 * from zero subscribers, so its own numbers say nothing yet (owner, 2026-10-22). yt-dlp lists a channel's Shorts
 * (title + views, no download); each Short is labelled against its own channel, so a big channel does not look
 * "viral" just for being big, and small channels with a breakout Short (the case of a brand-new channel) count.
 */

/** The newest Shorts are still collecting views: they are listed but not labelled. */
export const SKIP_NEWEST = 10;
/** Views ≥ this × the channel median = "viral"; ≤ WEAK_RATIO × median = "fraco". */
export const VIRAL_RATIO = 3;
export const WEAK_RATIO = 0.5;
/** A channel needs at least this many labelled Shorts for its median to mean anything. */
export const MIN_LABELLED = 15;

export type ViralLabel = "viral" | "normal" | "fraco";

export interface ShortStat {
  channelId: string;
  channelName: string;
  subscribers: number | null;
  /** "cortes" or "curiosidades" (or whatever group the channel list gives). */
  group: string;
  videoId: string;
  title: string;
  views: number;
  /** 0 = newest Short of the channel. */
  position: number;
  /** views / channel median (labelled Shorts only). */
  ratio: number | null;
  label: ViralLabel | null;
}

interface FlatEntry {
  id?: unknown;
  title?: unknown;
  view_count?: unknown;
  channel_id?: unknown;
  channel?: unknown;
}

interface FlatPlaylist {
  channel?: unknown;
  channel_id?: unknown;
  channel_follower_count?: unknown;
  uploader?: unknown;
  entries?: FlatEntry[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** `yt-dlp --flat-playlist -J <channel>/shorts` -> unlabelled rows (Shorts without a view count are dropped). */
export function parseShortsTab(json: unknown, group: string): ShortStat[] {
  const tab = (json ?? {}) as FlatPlaylist;
  const channelId = str(tab.channel_id) ?? "";
  const channelName = str(tab.channel) ?? str(tab.uploader) ?? channelId;
  const subscribers = num(tab.channel_follower_count);
  const rows: ShortStat[] = [];
  (tab.entries ?? []).forEach((e, position) => {
    const videoId = str(e.id);
    const title = str(e.title);
    const views = num(e.view_count);
    if (!videoId || !title || views === null) return;
    rows.push({ channelId, channelName, subscribers, group, videoId, title, views, position, ratio: null, label: null });
  });
  return rows;
}

/** Labels one channel's Shorts against that channel's median (skipping the newest; too few = no labels). */
export function labelChannel(rows: readonly ShortStat[]): ShortStat[] {
  const settled = rows.filter((r) => r.position >= SKIP_NEWEST);
  if (settled.length < MIN_LABELLED) return rows.map((r) => ({ ...r, ratio: null, label: null }));
  const base = Math.max(1, median(settled.map((r) => r.views)));
  return rows.map((r) => {
    if (r.position < SKIP_NEWEST) return { ...r, ratio: null, label: null };
    const ratio = Math.round((r.views / base) * 100) / 100;
    const label: ViralLabel = ratio >= VIRAL_RATIO ? "viral" : ratio <= WEAK_RATIO ? "fraco" : "normal";
    return { ...r, ratio, label };
  });
}

export interface ChannelCandidate {
  channelId: string;
  channelName: string;
  /** How many search results came from this channel. */
  hits: number;
  queries: string[];
}

/** `yt-dlp --flat-playlist -J ytsearchN:<query>` results -> channels that keep showing up for the theme. */
export function tallyCandidates(searches: readonly { query: string; json: unknown }[]): ChannelCandidate[] {
  const byId = new Map<string, ChannelCandidate>();
  for (const { query, json } of searches) {
    for (const e of ((json ?? {}) as FlatPlaylist).entries ?? []) {
      const channelId = str(e.channel_id);
      if (!channelId) continue;
      const c = byId.get(channelId) ?? { channelId, channelName: str(e.channel) ?? channelId, hits: 0, queries: [] };
      c.hits += 1;
      if (!c.queries.includes(query)) c.queries.push(query);
      byId.set(channelId, c);
    }
  }
  return [...byId.values()].sort((a, b) => b.hits - a.hits);
}
