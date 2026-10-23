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
/** Below this median the ratios are noise (282 views on a 25-subscriber channel came out "viral"). */
export const MIN_MEDIAN_VIEWS = 1000;

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

/** Swaps in the original-language titles (from a lang=pt listing of the same tab), matched by video id. */
export function withTitles(rows: readonly ShortStat[], originalTab: unknown): ShortStat[] {
  const titles = new Map<string, string>();
  for (const e of ((originalTab ?? {}) as FlatPlaylist).entries ?? []) {
    const id = str(e.id);
    const title = str(e.title);
    if (id && title) titles.set(id, title);
  }
  return rows.map((r) => ({ ...r, title: titles.get(r.videoId) ?? r.title }));
}

/** Labels one channel's Shorts against that channel's median (skipping the newest; too few = no labels). */
export function labelChannel(rows: readonly ShortStat[]): ShortStat[] {
  const settled = rows.filter((r) => r.position >= SKIP_NEWEST);
  if (settled.length < MIN_LABELLED) return rows.map((r) => ({ ...r, ratio: null, label: null }));
  const base = median(settled.map((r) => r.views));
  if (base < MIN_MEDIAN_VIEWS) return rows.map((r) => ({ ...r, ratio: null, label: null }));
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

// ---------------------------------------------------------------------------------------------
// Laya fine-tuning rows (`laya train --data train.jsonl --eval eval.jsonl`)
// ---------------------------------------------------------------------------------------------

/**
 * The decision the model learns (same wording at inference). "viral" failed on titles alone (AUC 0.48,
 * 2026-10-22); "fraco" (will it flop?) is the second try: knowing what to avoid is usually easier to learn.
 */
export const LAYA_QUESTIONS = {
  viral: { viral: { type: "noul", instructions: "Este Short tende a viralizar, com muito mais visualizações que a média do próprio canal?" } },
  fraco: { fraco: { type: "noul", instructions: "Este Short tende a flopar, com bem menos visualizações que a média do próprio canal?" } },
} as const;
export type LayaTarget = keyof typeof LAYA_QUESTIONS;
export const VIRAL_QUESTION = LAYA_QUESTIONS.viral;

export interface LayaRow {
  state: string;
  questions: (typeof LAYA_QUESTIONS)[LayaTarget];
  /** `expected` = hard target in laya train ({state, questions, expected}); `gold` there means probabilities. */
  expected: Partial<Record<LayaTarget, boolean>>;
}

/** Duration and opening speech of a Short (from its auto captions, no video download). */
export interface ShortHook {
  videoId: string;
  durationSeconds: number | null;
  hook: string;
}

/** What the model sees: theme, title and, when collected, duration + opening speech (never the channel). */
export function layaState(group: string, title: string, hook?: ShortHook): string {
  const base = `Tema: ${group}. Título do Short: ${title}`;
  if (!hook) return base;
  const duration = hook.durationSeconds === null ? "" : ` Duração: ${Math.round(hook.durationSeconds)} s.`;
  return `${base}.${duration} Começo da fala: ${hook.hook || "(sem fala)"}`;
}

/** Deterministic channel -> split (≈ evalShare of the channels go to eval, whole channels only: no leakage). */
export function isEvalChannel(channelId: string, evalShare = 0.15): boolean {
  let h = 2166136261;
  for (const ch of channelId) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  // murmur3 finaliser: FNV alone leaves the high bits clustered for ids that differ only at the end.
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 2 ** 32 < evalShare;
}

/**
 * Labelled rows -> train/eval sets. Positive = the target label ("viral" or "fraco"); the rest are negatives,
 * downsampled so there are at most `negativesPerPositive` per positive in train (eval keeps the real proportion).
 * With `hooks`, rows without a collected hook are dropped (same rows for every state, comparable runs).
 */
export function buildLayaSets(
  rows: readonly ShortStat[],
  options: { target?: LayaTarget; hooks?: ReadonlyMap<string, ShortHook>; negativesPerPositive?: number } = {},
): { train: LayaRow[]; eval: LayaRow[] } {
  const { target = "viral", hooks, negativesPerPositive = 3 } = options;
  const toRow = (r: ShortStat): LayaRow => ({
    state: layaState(r.group, r.title, hooks?.get(r.videoId)),
    questions: LAYA_QUESTIONS[target],
    expected: { [target]: r.label === target },
  });
  const labelled = rows.filter((r) => r.label !== null && (!hooks || hooks.has(r.videoId)));
  const evalRows = labelled.filter((r) => isEvalChannel(r.channelId)).map(toRow);
  const trainAll = labelled.filter((r) => !isEvalChannel(r.channelId));
  const positives = trainAll.filter((r) => r.label === target);
  const negatives = trainAll.filter((r) => r.label !== target);
  // Every k-th negative: deterministic, keeps channels mixed, no RNG to seed.
  const step = Math.max(1, Math.floor(negatives.length / Math.max(1, positives.length * negativesPerPositive)));
  const kept = negatives.filter((_, i) => i % step === 0);
  return { train: [...positives, ...kept].map(toRow), eval: evalRows };
}

// ---------------------------------------------------------------------------------------------
// Opening speech ("hook") from the Short's captions, written by yt-dlp as json3 (no video download)
// ---------------------------------------------------------------------------------------------

/** Seconds of speech kept as the hook (a Short decides in its first seconds if the viewer stays). */
export const HOOK_SECONDS = 8;
const HOOK_MAX_CHARS = 240;
/** Caption files in preference order: manual first, then the original-language auto captions. */
export const CAPTION_LANGS = ["pt", "pt-BR", "pt-orig", "pt-BR-orig"] as const;

interface Json3 {
  events?: { tStartMs?: number; segs?: { utf8?: string }[] }[];
}

/** json3 captions -> what is said in the first HOOK_SECONDS, one line. */
export function hookFromJson3(json: unknown, seconds = HOOK_SECONDS): string {
  const parts: string[] = [];
  for (const e of (json as Json3 | null)?.events ?? []) {
    if ((e.tStartMs ?? 0) >= seconds * 1000) break;
    for (const s of e.segs ?? []) if (s.utf8) parts.push(s.utf8);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, HOOK_MAX_CHARS);
}

/** Which of the written caption files to use: `<id>.<lang>.json3`, first CAPTION_LANGS match. */
export function pickCaptionFile(files: readonly string[], videoId: string): string | undefined {
  for (const lang of CAPTION_LANGS) {
    const name = `${videoId}.${lang}.json3`;
    if (files.includes(name)) return name;
  }
  return undefined;
}
