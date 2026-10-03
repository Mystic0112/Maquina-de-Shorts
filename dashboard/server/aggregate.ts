// Turns runs + upload history + metric snapshots into the payloads the UI renders.
import { readFile } from "node:fs/promises";
import { readUploadHistory, type UploadHistoryRead } from "../../src/shared/history.js";
import type { CategoryInfo, MetricsSnapshot, Overview, RunSummary, VideoRow } from "../shared/api.js";
import { config, paths } from "./config.js";
import { getSnapshots, youtubeStatus } from "./metrics.js";
import { getRevenue } from "./revenue.js";
import { listRuns } from "./runs.js";

const DAY_MS = 86_400_000;
const CHART_DAYS = 14;

/** Local calendar day (the machine's timezone), e.g. "2026-10-03". */
function dayKey(iso: string | number): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function lastDays(count: number): string[] {
  return Array.from({ length: count }, (_, i) => dayKey(Date.now() - (count - 1 - i) * DAY_MS));
}

/** Total views of the videos we published (from history.json) in one snapshot. */
function trackedViews(snapshot: MetricsSnapshot, ids: Set<string>): number {
  let total = 0;
  for (const [id, stats] of Object.entries(snapshot.videos)) if (ids.has(id)) total += stats.views;
  return total;
}

function viewsSeries(snapshots: readonly MetricsSnapshot[], ids: Set<string>): Overview["viewsPerDay"] {
  const endOfDay = new Map<string, number>(); // last snapshot of each day wins
  for (const s of snapshots) endOfDay.set(dayKey(s.at), trackedViews(s, ids));
  const days = [...endOfDay.entries()];
  return days.slice(1).map(([day, total], i) => ({ day, views: Math.max(0, total - days[i]![1]) }));
}

function viewsLast7d(snapshots: readonly MetricsSnapshot[], ids: Set<string>): Overview["kpis"]["viewsLast7d"] {
  const latest = snapshots.at(-1);
  if (!latest || snapshots.length < 2) return null;
  const cutoff = Date.parse(latest.at) - 7 * DAY_MS;
  const baseline = snapshots.filter((s) => Date.parse(s.at) <= cutoff).at(-1);
  const from = baseline ?? snapshots[0]!;
  return { value: trackedViews(latest, ids) - trackedViews(from, ids), since: from.at, partial: !baseline };
}

function generatedPerDay(runs: RunSummary[]): Overview["generatedPerDay"] {
  const rows = new Map(lastDays(CHART_DAYS).map((day) => [day, { day, gerados: 0, falhas: 0 }]));
  for (const run of runs) {
    const row = rows.get(dayKey(run.createdAt));
    if (!row) continue;
    if (run.status === "complete") row.gerados += 1;
    if (run.status === "failed" || run.status === "interrupted") row.falhas += 1;
  }
  return [...rows.values()];
}

async function readJsonFile(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** Category order from config/topics.seed.json; categories seen only in runs are appended after. */
async function readCategories(runs: RunSummary[]): Promise<CategoryInfo[]> {
  const raw = (await readJsonFile(paths.topicsConfig)) as { categories?: { id?: unknown; label?: unknown }[] } | null;
  const out: CategoryInfo[] = [];
  for (const c of raw?.categories ?? []) {
    if (typeof c.id === "string" && typeof c.label === "string") out.push({ id: c.id, label: c.label });
  }
  for (const run of runs) {
    if (run.topic && !out.some((c) => c.id === run.topic!.categoryId)) {
      out.push({ id: run.topic.categoryId, label: run.topic.categoryLabel });
    }
  }
  return out;
}

async function readTargetSeconds(): Promise<Overview["targetSeconds"]> {
  const raw = (await readJsonFile(paths.pipelineConfig)) as { video?: { minSeconds?: unknown; maxSeconds?: unknown } } | null;
  const { minSeconds, maxSeconds } = raw?.video ?? {};
  return typeof minSeconds === "number" && typeof maxSeconds === "number" ? { min: minSeconds, max: maxSeconds } : null;
}

function historySummary(history: UploadHistoryRead): Overview["history"] {
  return { exists: history.exists, count: history.records.length, errors: history.errors };
}

export async function buildOverview(): Promise<Overview> {
  const [runs, history, revenue, targetSeconds] = await Promise.all([
    listRuns(),
    readUploadHistory(paths.history),
    getRevenue(),
    readTargetSeconds(),
  ]);
  const snapshots = getSnapshots();
  const ids = new Set(history.records.map((r) => r.videoId));
  const latest = snapshots.at(-1);
  const youtube = youtubeStatus();

  const complete = runs.filter((r) => r.status === "complete");
  const failed = runs.filter((r) => r.status === "failed" || r.status === "interrupted");
  const weekAgo = Date.now() - 7 * DAY_MS;
  const renderTimes = complete.map((r) => r.renderTimeMs).filter((ms): ms is number => ms !== null);
  const lastSuccess = complete.map((r) => r.completedAt ?? r.createdAt).sort().at(-1) ?? null;
  const subscribers = youtube.channel?.subscribers ?? null;
  const totalViews = latest && ids.size > 0 ? trackedViews(latest, ids) : null;

  return {
    generatedAt: new Date().toISOString(),
    kpis: {
      videosGenerated: complete.length,
      videosPublished: history.records.length,
      successRate: complete.length + failed.length > 0 ? complete.length / (complete.length + failed.length) : null,
      finishedRuns: complete.length + failed.length,
      failuresLast7d: failed.filter((r) => Date.parse(r.failure?.at || r.lastActivityAt) >= weekAgo).length,
      totalViews,
      viewsLast7d: ids.size > 0 ? viewsLast7d(snapshots, ids) : null,
      subscribers,
    },
    generatedPerDay: generatedPerDay(runs),
    viewsPerDay: ids.size > 0 ? viewsSeries(snapshots, ids) : [],
    subscribersOverTime: snapshots
      .filter((s) => typeof s.channel?.subscribers === "number")
      .map((s) => ({ at: s.at, subscribers: s.channel!.subscribers! })),
    health: {
      lastSuccessAt: lastSuccess,
      avgRenderMs: renderTimes.length ? renderTimes.reduce((a, b) => a + b, 0) / renderTimes.length : null,
      lastRun: runs[0] ? { runId: runs[0].runId, status: runs[0].status, at: runs[0].lastActivityAt } : null,
    },
    history: historySummary(history),
    youtube,
    revenue,
    monetization: {
      subscribers: { current: subscribers, target: 1000 },
      shortsViews: {
        target: 10_000_000,
        windowDays: 90,
        trackedViews: totalViews,
        note:
          "O requisito é de 10 milhões de views válidas de Shorts públicos nos últimos 90 dias. A API pública não informa " +
          "esse número: o valor ao lado é a soma das views totais dos vídeos publicados pela máquina, só como referência.",
      },
    },
    categories: await readCategories(runs),
    targetSeconds,
    llmPricing: { ...config.llmPricing },
  };
}

export async function buildVideoRows(): Promise<VideoRow[]> {
  const [runs, history] = await Promise.all([listRuns(), readUploadHistory(paths.history)]);
  const latest = getSnapshots().at(-1);
  const uploadsByRun = new Map(history.records.map((r) => [r.runId, r]));
  const runIds = new Set(runs.map((r) => r.runId));

  const youtubeOf = (record: UploadHistoryRead["records"][number] | undefined): VideoRow["youtube"] =>
    record
      ? {
          videoId: record.videoId,
          url: `https://www.youtube.com/shorts/${encodeURIComponent(record.videoId)}`,
          privacyStatus: record.privacyStatus,
          publishedAt: record.publishedAt,
          stats: latest?.videos[record.videoId] ?? null,
        }
      : null;

  const rows: VideoRow[] = runs.map((run) => {
    const upload = uploadsByRun.get(run.runId);
    return {
      key: run.runId,
      runId: run.runId,
      title: upload?.title ?? run.title ?? (run.hasContext ? "(sem roteiro)" : "(pasta removida, só o log)"),
      date: upload?.publishedAt ?? run.createdAt,
      status: run.status,
      videoDurationSeconds: run.video?.durationSeconds ?? null,
      localPath: run.video?.exists ? run.video.path : null,
      localUrl: run.video?.exists ? `/api/runs/${encodeURIComponent(run.runId)}/video` : null,
      thumbUrl: run.thumbUrl,
      categoryId: run.topic?.categoryId ?? null,
      youtube: youtubeOf(upload),
    };
  });
  for (const record of history.records) {
    if (runIds.has(record.runId)) continue; // run folder was cleaned up; keep the published video visible
    rows.push({
      key: `yt-${record.videoId}`,
      runId: record.runId,
      title: record.title,
      date: record.publishedAt,
      status: "published_only",
      videoDurationSeconds: null,
      localPath: null,
      localUrl: null,
      thumbUrl: null,
      categoryId: record.topicCategoryId,
      youtube: youtubeOf(record),
    });
  }
  return rows.sort((a, b) => b.date.localeCompare(a.date));
}
