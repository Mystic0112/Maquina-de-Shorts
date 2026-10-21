import { existsSync } from "node:fs";
import { cp, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RunContext } from "../types.js";
import { paths, type PipelineConfig } from "./config.js";
import { RUN_ID_PATTERN } from "./recentTopics.js";
import { VERDICT_FRAMES_DIR, VERDICTS_ARCHIVE_DIR, VERDICTS_FILE } from "./verdictLog.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** upload.journal.json (legacy YouTube) and upload.<platform>.journal.json. */
const JOURNAL_NAME = /^upload(\.[a-z]+)?\.journal\.json$/;
/** Non-uploaded runs younger than this are never deleted, whatever the config says. */
export const MIN_KEEP_UNUPLOADED_DAYS = 3;

export interface RetentionSettings {
  keepFailedRunsDays: number;
  keepUploadedVideosDays: number;
}

export function resolveRetention(storage: PipelineConfig["storage"]): RetentionSettings {
  return {
    keepFailedRunsDays: Math.max(MIN_KEEP_UNUPLOADED_DAYS, storage?.keepFailedRunsDays ?? 3),
    keepUploadedVideosDays: storage?.keepUploadedVideosDays ?? 14,
  };
}

export type RetentionAction = "keep" | "delete-run" | "trim-uploaded";

function isFailed(ctx: RunContext): boolean {
  return !!ctx.rejection || ctx.quality?.verdict === "fail" || ctx.factCheck?.verdict === "fail";
}

/**
 * Pure decision for one run:
 * - uploaded runs older than keepUploadedVideosDays lose final.mp4 + footage (context/log/thumbnail/verdicts stay);
 * - rejected/failed runs, and runs that crashed before rendering, are deleted after keepFailedRunsDays;
 * - rendered-but-not-uploaded runs are always kept (they may still be published).
 * `lastActivity` (latest mtime in the run dir) protects runs still being worked on.
 */
export function retentionAction(ctx: RunContext, lastActivity: Date, now: Date, settings: RetentionSettings): RetentionAction {
  const ageDays = (now.getTime() - Math.max(Date.parse(ctx.createdAt) || 0, lastActivity.getTime())) / DAY_MS;
  if (ctx.upload?.status === "uploaded") {
    const uploadedAt = Date.parse(ctx.upload.uploadedAt ?? "") || Date.parse(ctx.createdAt) || now.getTime();
    return (now.getTime() - uploadedAt) / DAY_MS > settings.keepUploadedVideosDays ? "trim-uploaded" : "keep";
  }
  const unfinished = !ctx.render;
  if ((isFailed(ctx) || unfinished) && ageDays > Math.max(MIN_KEEP_UNUPLOADED_DAYS, settings.keepFailedRunsDays)) return "delete-run";
  return "keep";
}

export interface PruneSummary {
  deletedRuns: string[];
  trimmedRuns: string[];
  errors: string[];
}

async function latestMtime(dir: string): Promise<Date> {
  let latest = (await stat(dir)).mtimeMs;
  for (const name of await readdir(dir)) {
    try {
      latest = Math.max(latest, (await stat(join(dir, name))).mtimeMs);
    } catch {
      // vanished: ignore
    }
  }
  return new Date(latest);
}

/** Copies the verdict log + frames (dataset material, a few MB at most) out of a run about to be deleted. */
export async function archiveVerdicts(runDir: string, archiveDir: string): Promise<void> {
  for (const name of [VERDICTS_FILE, VERDICT_FRAMES_DIR]) {
    if (existsSync(join(runDir, name))) await cp(join(runDir, name), join(archiveDir, name), { recursive: true });
  }
}

/** Applies the retention policy to render_output/. Never throws; problems are reported in `errors`. */
export async function pruneRuns(
  settings: RetentionSettings,
  options: { now?: Date; root?: string; exclude?: readonly string[]; verdictsArchive?: string } = {},
): Promise<PruneSummary> {
  const root = options.root ?? paths.renderOutput;
  const archive = options.verdictsArchive ?? VERDICTS_ARCHIVE_DIR;
  const now = options.now ?? new Date();
  const summary: PruneSummary = { deletedRuns: [], trimmedRuns: [], errors: [] };
  if (!existsSync(root)) return summary;
  for (const runId of (await readdir(root)).filter((d) => RUN_ID_PATTERN.test(d) && !options.exclude?.includes(d))) {
    const dir = join(root, runId);
    try {
      const contextFile = join(dir, "context.json");
      if (!existsSync(contextFile)) continue;
      const ctx = JSON.parse(await readFile(contextFile, "utf8")) as RunContext;
      // A publish journal without a finished upload = a publish that may still be resumed: never touch it.
      const hasJournal = (await readdir(dir)).some((name) => JOURNAL_NAME.test(name));
      if (!hasJournal || ctx.upload?.status === "uploaded") {
        const action = retentionAction(ctx, await latestMtime(dir), now, settings);
        if (action === "delete-run") {
          await archiveVerdicts(dir, join(archive, runId)); // a failed copy keeps the run (reported in errors)
          await rm(dir, { recursive: true, force: true });
          summary.deletedRuns.push(runId);
        } else if (action === "trim-uploaded" && (existsSync(join(dir, "final.mp4")) || existsSync(join(dir, "footage")))) {
          await rm(join(dir, "final.mp4"), { force: true });
          await rm(join(dir, "footage"), { recursive: true, force: true });
          summary.trimmedRuns.push(runId);
        }
      }
    } catch (error) {
      summary.errors.push(`${runId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return summary;
}
