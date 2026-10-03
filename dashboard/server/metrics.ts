// YouTube stats cache + append-only history in data/metrics/snapshots.jsonl. The API is called at most
// once per refresh interval (default 30 min) plus manual refreshes spaced >= 60 s apart. On startup the
// last snapshot on disk counts as the cache, so server restarts do not spend quota.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readUploadHistory } from "../../src/shared/history.js";
import type { MetricsSnapshot, YoutubeStatus } from "../shared/api.js";
import { config, paths } from "./config.js";
import { fetchChannel, fetchVideos } from "./youtube.js";

const { apiKey, channelId, refreshIntervalMs, manualMinIntervalMs } = config.youtube;
const TICK_MS = 60_000;

let snapshots: MetricsSnapshot[] = [];
let lastAttemptAt: number | null = null;
let lastError: string | null = null;
let trackedVideos = 0;
let inFlight: Promise<void> | null = null;

async function loadSnapshots(): Promise<MetricsSnapshot[]> {
  let text = "";
  try {
    text = await readFile(paths.snapshots, "utf8");
  } catch {
    return [];
  }
  const out: MetricsSnapshot[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as MetricsSnapshot;
      if (typeof parsed.at === "string" && typeof parsed.videos === "object") out.push(parsed);
    } catch {
      // skip a torn/corrupt line instead of failing the whole history
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export function getSnapshots(): readonly MetricsSnapshot[] {
  return snapshots;
}

async function publishedVideoIds(): Promise<string[]> {
  const history = await readUploadHistory(paths.history);
  return [...new Set(history.records.map((r) => r.videoId))];
}

async function doRefresh(): Promise<void> {
  lastAttemptAt = Date.now();
  if (!apiKey) {
    lastError = "YOUTUBE_API_KEY não configurada no .env";
    return;
  }
  const ids = await publishedVideoIds();
  trackedVideos = ids.length;
  if (ids.length === 0 && !channelId) {
    // Nothing to fetch yet (no uploads, no channel id). No quota was spent, so do not start the
    // cooldown: the next tick re-checks history.json and fetches as soon as the first upload appears.
    lastError = null;
    lastAttemptAt = null;
    return;
  }
  try {
    const [videos, channel] = await Promise.all([
      fetchVideos(apiKey, ids),
      channelId ? fetchChannel(apiKey, channelId) : Promise.resolve(null),
    ]);
    if (channelId && !channel) throw new Error(`Canal ${channelId} não encontrado (verifique YOUTUBE_CHANNEL_ID)`);
    const snapshot: MetricsSnapshot = {
      at: new Date().toISOString(),
      channel,
      videos: Object.fromEntries(
        [...videos].map(([id, v]) => [id, { views: v.views, likes: v.likes, comments: v.comments }]),
      ),
    };
    await mkdir(dirname(paths.snapshots), { recursive: true });
    await appendFile(paths.snapshots, `${JSON.stringify(snapshot)}\n`, "utf8");
    snapshots.push(snapshot);
    lastError = null;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    console.warn(`[youtube] falha ao atualizar: ${lastError}`);
  }
}

function refresh(): Promise<void> {
  inFlight ??= doRefresh().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

function lastFetchMs(): number | null {
  const last = snapshots.at(-1);
  return last ? Date.parse(last.at) : null;
}

function dueForAutoRefresh(now: number): boolean {
  const reference = Math.max(lastFetchMs() ?? 0, lastAttemptAt ?? 0);
  return now - reference >= refreshIntervalMs;
}

/** Manual "atualizar": refused with retryAfterMs when called less than 60 s after the previous attempt. */
export async function manualRefresh(): Promise<{ ok: boolean; retryAfterMs?: number; message: string }> {
  const elapsed = lastAttemptAt === null ? Infinity : Date.now() - lastAttemptAt;
  if (elapsed < manualMinIntervalMs) {
    const retryAfterMs = manualMinIntervalMs - elapsed;
    return { ok: false, retryAfterMs, message: `Aguarde ${Math.ceil(retryAfterMs / 1000)} s para atualizar de novo.` };
  }
  await refresh();
  if (lastError) return { ok: false, message: lastError };
  if (trackedVideos === 0 && !channelId) {
    return { ok: true, message: "Nada para consultar ainda: nenhum vídeo publicado e YOUTUBE_CHANNEL_ID vazio." };
  }
  return { ok: true, message: "Estatísticas do YouTube atualizadas." };
}

export function youtubeStatus(): YoutubeStatus {
  const fetched = lastFetchMs();
  const reference = Math.max(fetched ?? 0, lastAttemptAt ?? 0);
  const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
  return {
    apiKeyConfigured: !!apiKey,
    channelConfigured: !!channelId,
    trackedVideos,
    refreshIntervalMinutes: refreshIntervalMs / 60_000,
    lastFetchAt: iso(fetched),
    lastAttemptAt: iso(lastAttemptAt),
    lastError,
    nextAutoRefreshAt: apiKey && reference ? iso(reference + refreshIntervalMs) : null,
    manualAvailableAt: lastAttemptAt === null ? null : iso(lastAttemptAt + manualMinIntervalMs),
    snapshotCount: snapshots.length,
    channel: snapshots.at(-1)?.channel ?? null,
  };
}

/** Loads the snapshot history and starts the background cadence. */
export async function startMetrics(): Promise<void> {
  snapshots = await loadSnapshots();
  trackedVideos = (await publishedVideoIds()).length;
  const tick = (): void => {
    if (dueForAutoRefresh(Date.now())) void refresh();
  };
  tick();
  setInterval(tick, TICK_MS).unref();
}
