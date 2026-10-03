// Stage 08 — publishing. Keeps its historical name (the dashboard parses "08-uploadYouTube" in the logs)
// but now runs every enabled publisher from src/orchestrator/publishers/ (only YouTube exists today).

import { loadConfig } from "../lib/config.js";
import { withFileLock } from "../lib/fileLock.js";
import { getLogger } from "../lib/logger.js";
import { saveRunContext } from "../lib/runContext.js";
import { appendUploadRecord, readHistoryRecords, UPLOAD_LOCK, uploadLockPath } from "../lib/uploadHistory.js";
import { createPublishers, sharedGateSettings } from "../publishers/index.js";
import { journalFile, publishAll, type PublishDeps } from "../publishers/runner.js";
import { createYouTubeUploader, type UploadDeps } from "../publishers/youtube.js";
import type { RunContext } from "../types.js";

// Re-exports: callers and tests written against the YouTube-only stage keep working.
export { publishBlockers } from "../publishers/gates.js";
export { isLockedPrivate, LEGACY_YOUTUBE_JOURNAL, readPublishJournal, UploadBlockedError } from "../publishers/runner.js";
export {
  buildVideoResource,
  createYouTubeUploader,
  LOCKED_PRIVATE_WARNING,
  resolveUploadSettings,
  uploadRun,
  videoUrl,
  type UploadDeps,
  type UploadSessionHooks,
  type UploadSettings,
  type YouTubeUploader,
} from "../publishers/youtube.js";

/** YouTube's journal file in the run dir (the legacy "upload.journal.json" is still read and migrated). */
export const JOURNAL_FILE = journalFile("youtube");

export const defaultPublishDeps: PublishDeps = {
  readHistory: () => readHistoryRecords(),
  appendHistory: (record) => appendUploadRecord(record),
  now: () => new Date(),
  lock: (fn) => withFileLock(uploadLockPath(), UPLOAD_LOCK, fn),
  saveContext: saveRunContext,
};

/** Defaults for the YouTube-only `uploadRun` entry point. */
export const defaultUploadDeps: UploadDeps = { ...defaultPublishDeps, createUploader: createYouTubeUploader };

export async function run(ctx: RunContext): Promise<RunContext> {
  const config = loadConfig();
  return publishAll(ctx, createPublishers(config), sharedGateSettings(config), defaultPublishDeps, getLogger(ctx.runId));
}
