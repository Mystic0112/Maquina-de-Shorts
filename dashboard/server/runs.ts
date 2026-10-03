// Builds RunSummary objects from render_output/<runId>/context.json + logs/<runId>.log. Read-only and
// tolerant: either file may be missing, partial or mid-write.
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type { RunContext } from "../../src/orchestrator/types.js";
import {
  STAGE_NAMES,
  type ClipInfo,
  type RunStatus,
  type RunSummary,
  type StageInfo,
  type StageName,
} from "../shared/api.js";
import { paths } from "./config.js";
import { parseRunLog, type LogEvent, type ParsedLog } from "./logParser.js";
import { ensureThumbnail } from "./thumbnails.js";

/** A run whose last event is "stage started" counts as running while its log changed this recently. */
const RUNNING_GRACE_MS = 15 * 60_000;
export const RUN_ID_PATTERN = /^[\w-]+$/;

/** Mirrors STAGES[].isDone in src/orchestrator/runPipeline.ts (not imported: that module pulls pipeline deps). */
const STAGE_OUTPUT: Record<StageName, (c: RunContext) => boolean> = {
  "01-pickTopic": (c) => !!c.topic,
  "02-generateScript": (c) => !!c.script,
  "03-fetchFootage": (c) => (c.footage?.length ?? 0) > 0,
  "04-synthesizeVoice": (c) => !!c.narration,
  "05-buildCaptions": (c) => !!c.captions,
  "06-renderVideo": (c) => !!c.render,
};

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null; // missing, unreadable or being rewritten right now
  }
}

async function readLog(runId: string): Promise<{ parsed: ParsedLog; mtimeMs: number } | null> {
  const file = join(paths.logs, `${runId}.log`);
  try {
    const [text, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
    return { parsed: parseRunLog(text), mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

async function listNames(dir: string, filter: (name: string, isDir: boolean) => boolean): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => filter(e.name, e.isDirectory())).map((e) => e.name);
  } catch {
    return [];
  }
}

/** "20261003-003038-449c" -> local date, used only when nothing better exists. */
function dateFromRunId(runId: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(runId);
  if (!m) return new Date(0).toISOString();
  const [, y, mo, d, h, mi, s] = m.map(Number) as number[];
  return new Date(y!, mo! - 1, d!, h!, mi!, s!).toISOString();
}

/** Inside render_output only, so the video endpoint can never stream arbitrary files. */
export function isInsideRenderOutput(file: string): boolean {
  const rel = relative(paths.renderOutput, resolve(file));
  return !!rel && !rel.startsWith("..") && !rel.includes(":");
}

function buildStages(events: LogEvent[], ctx: RunContext | null, logFresh: boolean): StageInfo[] {
  const lastStageEvent = events.filter((e) => e.kind !== "run-start" && e.kind !== "run-finished").at(-1);
  return STAGE_NAMES.map((name): StageInfo => {
    const own = events.filter((e) => "stage" in e && e.stage === name && e.kind !== "run-finished");
    const real = own.filter((e) => e.kind !== "skipped");
    const latest = real.at(-1);
    const info: StageInfo = { name, status: "pending", durationMs: null, startedAt: null, endedAt: null };
    if (latest?.kind === "started") {
      info.startedAt = latest.at;
      info.status = latest === lastStageEvent && logFresh ? "running" : "interrupted";
    } else if (latest?.kind === "done" || latest?.kind === "failed") {
      info.status = latest.kind;
      info.durationMs = latest.durationMs;
      info.endedAt = latest.at;
      info.startedAt = new Date(Date.parse(latest.at) - latest.durationMs).toISOString();
    } else if (own.length > 0 || (ctx && STAGE_OUTPUT[name](ctx))) {
      info.status = "skipped"; // output came from a fixture or an earlier run
    }
    return info;
  });
}

function decideStatus(ctx: RunContext | null, events: LogEvent[], logFresh: boolean): RunStatus {
  if (ctx?.render?.videoPath) return "complete";
  const last = events.filter((e) => e.kind !== "skipped" && e.kind !== "run-start").at(-1);
  // Run folder deleted but the log proves the render finished: the video was generated (file is gone).
  if (!ctx && events.some((e) => e.kind === "done" && e.stage === "06-renderVideo") && last?.kind !== "failed") {
    return "complete";
  }
  if (last?.kind === "failed") return "failed";
  if (last?.kind === "started") {
    return logFresh ? "running" : "interrupted";
  }
  return "partial";
}

function describeFailure(
  status: RunStatus,
  events: LogEvent[],
  stages: StageInfo[],
  lastLogAt: string | null,
): RunSummary["failure"] {
  if (status === "failed") {
    const failed = events.filter((e) => e.kind === "failed").at(-1);
    return failed?.kind === "failed" ? { stage: failed.stage, message: failed.message, at: failed.at } : null;
  }
  if (status === "interrupted") {
    const stuck = stages.find((s) => s.status === "interrupted");
    if (!stuck) return null;
    const message = "Execução interrompida: o processo parou sem registrar o fim da etapa.";
    return { stage: stuck.name, message, at: lastLogAt ?? stuck.startedAt ?? "" };
  }
  return null;
}

function summarizeClips(ctx: RunContext | null): Pick<RunSummary, "clips" | "sources" | "licenses" | "avgRelevance"> {
  const clips: ClipInfo[] = (ctx?.footage ?? []).map((c) => ({
    sceneIndex: c.sceneIndex,
    kind: c.kind,
    source: c.source,
    sourceUrl: c.sourceUrl,
    creator: c.creator,
    license: c.license,
    durationSeconds: c.durationSeconds,
    relevanceScore: typeof c.relevanceScore === "number" ? c.relevanceScore : null,
    relevanceReason: c.relevanceReason ?? null,
  }));
  const count = (key: "source" | "license"): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const c of clips) out[c[key]] = (out[c[key]] ?? 0) + 1;
    return out;
  };
  const scores = clips.map((c) => c.relevanceScore).filter((s): s is number => s !== null);
  const avgRelevance = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  return { clips, sources: count("source"), licenses: count("license"), avgRelevance };
}

async function describeVideo(ctx: RunContext | null): Promise<RunSummary["video"]> {
  const render = ctx?.render;
  if (!render?.videoPath) return null;
  let sizeBytes: number | null = null;
  try {
    sizeBytes = (await stat(render.videoPath)).size;
  } catch {
    // file deleted or moved after rendering
  }
  return { path: render.videoPath, exists: sizeBytes !== null, sizeBytes, durationSeconds: render.durationSeconds };
}

async function buildRun(runId: string): Promise<RunSummary> {
  const [ctx, log] = await Promise.all([
    readJson<RunContext>(join(paths.renderOutput, runId, "context.json")),
    readLog(runId),
  ]);
  const events = log?.parsed.events ?? [];
  const logFresh = log !== null && Date.now() - log.mtimeMs < RUNNING_GRACE_MS;
  const status = decideStatus(ctx, events, logFresh);
  const stages = buildStages(events, ctx, logFresh);
  const lastRender = events.filter((e) => e.kind === "done" && e.stage === "06-renderVideo").at(-1);

  const reachedFromCtx = ctx ? STAGE_NAMES.filter((s) => STAGE_OUTPUT[s](ctx)).at(-1) : undefined;
  const reachedFromLog = stages.filter((s) => s.status === "done").at(-1)?.name;
  const createdAt = ctx?.createdAt ?? log?.parsed.firstAt ?? dateFromRunId(runId);

  return {
    runId,
    createdAt,
    lastActivityAt: log?.parsed.lastAt ?? createdAt,
    status,
    lastStageReached: reachedFromCtx ?? reachedFromLog ?? null,
    failure: describeFailure(status, events, stages, log?.parsed.lastAt ?? null),
    hasContext: ctx !== null,
    hasLog: log !== null,
    topic: ctx?.topic ? { categoryId: ctx.topic.categoryId, categoryLabel: ctx.topic.categoryLabel } : null,
    title: ctx?.script?.title ?? null,
    sceneCount: ctx?.script?.scenes?.length ?? null,
    ...summarizeClips(ctx),
    narrationMs: ctx?.narration?.durationMs ?? null,
    video: await describeVideo(ctx),
    completedAt: status === "complete" ? (lastRender?.at ?? log?.parsed.lastAt ?? createdAt) : null,
    renderTimeMs: lastRender?.kind === "done" ? lastRender.durationMs : null,
    stages,
    thumbUrl: await thumbUrlFor(runId, ctx),
    quality: readQuality(ctx),
    llmUsage: readLlmUsage(ctx),
  };
}

async function thumbUrlFor(runId: string, ctx: RunContext | null): Promise<string | null> {
  const videoPath = ctx?.render?.videoPath;
  if (!videoPath || !isInsideRenderOutput(videoPath)) return null;
  const version = await ensureThumbnail(videoPath);
  return version === null ? null : `/api/runs/${encodeURIComponent(runId)}/thumb.jpg?v=${Math.round(version)}`;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** context.json is written by another process: only pass the sections through when they look sane. */
function readQuality(ctx: RunContext | null): RunSummary["quality"] {
  const q = ctx?.quality;
  if (!q || !isNum(q.passingScenes) || !isNum(q.totalScenes) || !["pass", "fail", "skipped"].includes(q.verdict)) {
    return null;
  }
  return q;
}

function readLlmUsage(ctx: RunContext | null): RunSummary["llmUsage"] {
  const u = ctx?.llmUsage;
  if (!u || !isNum(u.calls) || !isNum(u.inputTokens) || !isNum(u.outputTokens)) return null;
  return { ...u, byModel: Array.isArray(u.byModel) ? u.byModel : [], byStage: u.byStage ?? {} };
}

/** All runs, newest first: run folders (except "_*") plus runs known only from their log. */
export async function listRuns(): Promise<RunSummary[]> {
  const [dirs, logs] = await Promise.all([
    listNames(paths.renderOutput, (name, isDir) => isDir && !name.startsWith("_")),
    listNames(paths.logs, (name, isDir) => !isDir && name.endsWith(".log") && !name.startsWith("_")),
  ]);
  const ids = new Set([...dirs, ...logs.map((name) => name.slice(0, -".log".length))]);
  const runs = await Promise.all([...ids].filter((id) => RUN_ID_PATTERN.test(id)).map(buildRun));
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
