import { existsSync } from "node:fs";
import { join } from "node:path";
import { youtube as youtubeApi } from "@googleapis/youtube";
import type { ActualPrivacyStatus, UploadRecord } from "../../shared/history.js";
import { loadConfig, type PipelineConfig } from "../lib/config.js";
import { readJsonIfExists, withFileLock, writeFileAtomic } from "../lib/fileLock.js";
import { contentBindingProblems } from "../lib/contentHash.js";
import { getLogger, type Logger } from "../lib/logger.js";
import { licenseKind, uniqueClips, usableCreatorName } from "./07-generateMetadata.js";
import { saveRunContext } from "../lib/runContext.js";
import {
  appendUploadRecord,
  checkDailyCap,
  readHistoryRecords,
  UPLOAD_LOCK,
  uploadLockPath,
} from "../lib/uploadHistory.js";
import { loadAuthorizedClient } from "../lib/youtubeAuth.js";
import { resumableUpload, UploadSessionLostError } from "../lib/youtubeUpload.js";
import type { RunContext, UploadResult, VideoMetadata, YouTubePrivacyStatus } from "../types.js";

export const LOCKED_PRIVATE_WARNING = "YouTube travou o vídeo como privado (projeto não auditado)";
export const JOURNAL_FILE = "upload.journal.json";

export interface UploadSettings {
  enabled: boolean;
  privacyStatus: YouTubePrivacyStatus;
  categoryId: string;
  maxUploadsPerDay: number;
  containsSyntheticMedia: boolean;
  /** Only with script.factCheck=false: allows publishing scripts that were never fact-checked. */
  allowWithoutFactCheck?: boolean;
}

export function resolveUploadSettings(upload: PipelineConfig["upload"]): UploadSettings {
  return {
    enabled: upload.enabled ?? false,
    privacyStatus: upload.privacyStatus,
    categoryId: String(upload.categoryId),
    maxUploadsPerDay: upload.maxUploadsPerDay,
    containsSyntheticMedia: upload.containsSyntheticMedia ?? false,
    allowWithoutFactCheck: upload.allowWithoutFactCheck ?? false,
  };
}

/** videos.insert resource. */
export function buildVideoResource(metadata: VideoMetadata, settings: UploadSettings) {
  return {
    snippet: {
      title: metadata.title,
      description: metadata.description,
      tags: metadata.tags,
      categoryId: metadata.categoryId || settings.categoryId,
      defaultLanguage: metadata.defaultLanguage,
      defaultAudioLanguage: metadata.defaultAudioLanguage,
    },
    status: {
      privacyStatus: settings.privacyStatus,
      selfDeclaredMadeForKids: false,
      embeddable: true,
      license: "youtube",
      // Altered/synthetic content disclosure. The narration is a synthetic (non-cloned, clearly non-real)
      // voice over real/archival imagery, which YouTube's disclosure policy does not require labelling;
      // kept configurable (upload.containsSyntheticMedia) in case the policy or the content changes.
      containsSyntheticMedia: settings.containsSyntheticMedia,
    },
  };
}

/** True when YouTube applied "private" although the pipeline asked for public/unlisted. */
export function isLockedPrivate(requested: YouTubePrivacyStatus, actual: ActualPrivacyStatus | undefined): boolean {
  return requested !== "private" && actual === "private";
}

function asPrivacy(value: unknown): YouTubePrivacyStatus | undefined {
  return value === "public" || value === "unlisted" || value === "private" ? value : undefined;
}

// ---------------------------------------------------------------------------------------------
// Publishability gate (the upload stage re-checks the run's own verdicts; never trust stage order alone)
// ---------------------------------------------------------------------------------------------

export class UploadBlockedError extends Error {}

/** Reasons this run must not be published; empty = publishable. */
export function publishBlockers(ctx: RunContext, settings: Pick<UploadSettings, "allowWithoutFactCheck">): string[] {
  const blockers: string[] = [];
  if (ctx.rejection) blockers.push(`run was rejected by ${ctx.rejection.stage}: ${ctx.rejection.reason}`);
  if (ctx.quality?.verdict !== "pass") blockers.push(`footage quality verdict is "${ctx.quality?.verdict ?? "missing"}" (needs "pass")`);
  const fc = ctx.factCheck?.verdict;
  if (fc === "skipped") {
    if (!settings.allowWithoutFactCheck) blockers.push('script was not fact-checked (set upload.allowWithoutFactCheck=true to allow)');
  } else if (fc !== "pass" && fc !== "corrected") {
    blockers.push(`fact-check verdict is "${fc ?? "missing"}" (needs "pass" or "corrected")`);
  }
  // Verdicts only count for the exact script/footage they judged.
  blockers.push(...contentBindingProblems(ctx, { requireHashes: true }));
  // CC BY requires attribution: every credited clip needs a real author name.
  const unattributed = uniqueClips(ctx.footage ?? []).filter((c) => licenseKind(c) === "attribution" && !usableCreatorName(c.creator));
  if (unattributed.length > 0) {
    blockers.push(`${unattributed.length} CC BY clip(s) without a usable author name (${unattributed.map((c) => c.sourceUrl || c.path).join(", ")})`);
  }
  return blockers;
}

// ---------------------------------------------------------------------------------------------
// Upload journal: <runDir>/upload.journal.json survives crashes and failed context/history writes
// ---------------------------------------------------------------------------------------------

export interface UploadJournal {
  runId: string;
  status: "pending" | "uploaded";
  startedAt: string;
  requestedPrivacyStatus: YouTubePrivacyStatus;
  /** Resumable session URI: a retry resumes it instead of opening a second upload. */
  sessionUri?: string;
  videoId?: string;
  uploadedAt?: string;
}

export async function readJournal(runDir: string): Promise<UploadJournal | undefined> {
  const raw = await readJsonIfExists(join(runDir, JOURNAL_FILE));
  return raw && typeof raw === "object" ? (raw as UploadJournal) : undefined;
}

async function writeJournal(runDir: string, journal: UploadJournal): Promise<void> {
  await writeFileAtomic(join(runDir, JOURNAL_FILE), `${JSON.stringify(journal, null, 2)}\n`);
}

// ---------------------------------------------------------------------------------------------
// YouTube access (injected so the stage can be tested without network)
// ---------------------------------------------------------------------------------------------

export interface UploadSessionHooks {
  /** Resume this session instead of starting a new upload. */
  sessionUri?: string;
  /** Persist a new session URI before any byte is sent. */
  onSession: (sessionUri: string) => Promise<void>;
}

export interface YouTubeUploader {
  upload(
    filePath: string,
    resource: unknown,
    onProgress: (done: number, total: number) => void,
    session?: UploadSessionHooks,
  ): Promise<{ id: string }>;
  getPrivacyStatus(videoId: string): Promise<YouTubePrivacyStatus | undefined>;
  close(): Promise<void>;
}

export async function createYouTubeUploader(): Promise<YouTubeUploader> {
  const { client, flush } = await loadAuthorizedClient();
  const api = youtubeApi({ version: "v3", auth: client });
  const getAccessToken = async (): Promise<string> => {
    const { token } = await client.getAccessToken();
    if (!token) throw new Error("Could not obtain a YouTube access token (refresh failed?)");
    return token;
  };
  return {
    upload: (filePath, resource, onProgress, session) =>
      resumableUpload({
        filePath,
        resource,
        parts: ["snippet", "status"],
        getAccessToken,
        onProgress,
        sessionUri: session?.sessionUri,
        onSession: session?.onSession,
      }),
    async getPrivacyStatus(videoId) {
      const res = await api.videos.list({ part: ["status"], id: [videoId] });
      return asPrivacy(res.data.items?.[0]?.status?.privacyStatus);
    },
    close: flush,
  };
}

export interface UploadDeps {
  createUploader: () => Promise<YouTubeUploader>;
  /** Must throw when the history exists but cannot be trusted (fail-closed). */
  readHistory: () => Promise<UploadRecord[]>;
  appendHistory: (record: UploadRecord) => Promise<{ movedCorruptTo?: string }>;
  now: () => Date;
  /** Cross-process lock around "read history -> cap -> upload -> append". */
  lock?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Persists the context mid-stage (so the dashboard sees a pending/finished upload immediately). */
  saveContext?: (ctx: RunContext) => Promise<void>;
}

export const defaultUploadDeps: UploadDeps = {
  createUploader: createYouTubeUploader,
  readHistory: () => readHistoryRecords(),
  appendHistory: (record) => appendUploadRecord(record),
  now: () => new Date(),
  lock: (fn) => withFileLock(uploadLockPath(), UPLOAD_LOCK, fn),
  saveContext: saveRunContext,
};

function progressLogger(log: Logger): (done: number, total: number) => void {
  let lastDecile = -1;
  return (done, total) => {
    const decile = total > 0 ? Math.floor((done / total) * 10) : 10;
    if (decile === lastDecile) return;
    lastDecile = decile;
    log.info(`Upload ${Math.min(100, decile * 10)}% (${(done / 1024 / 1024).toFixed(1)}/${(total / 1024 / 1024).toFixed(1)} MB)`);
  };
}

export function videoUrl(videoId: string): string {
  return `https://youtube.com/shorts/${videoId}`;
}

function uploadedResult(videoId: string, requested: YouTubePrivacyStatus, actual: ActualPrivacyStatus, uploadedAt: string): UploadResult {
  return {
    status: "uploaded",
    videoId,
    url: videoUrl(videoId),
    requestedPrivacyStatus: requested,
    privacyStatus: actual,
    lockedPrivate: isLockedPrivate(requested, actual),
    uploadedAt,
  };
}

function historyRecord(ctx: RunContext, videoId: string, requested: YouTubePrivacyStatus, actual: ActualPrivacyStatus, at: string): UploadRecord {
  return {
    runId: ctx.runId,
    videoId,
    title: ctx.metadata?.title ?? ctx.script?.title ?? ctx.runId,
    publishedAt: at,
    privacyStatus: actual,
    requestedPrivacyStatus: requested,
    categoryId: ctx.metadata?.categoryId ?? "27",
    topicCategoryId: ctx.topic?.categoryId ?? "unknown",
  };
}

// ---------------------------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------------------------

/** A previous attempt got a videoId but failed before recording it: record it now, never re-upload. */
async function completeJournaledUpload(ctx: RunContext, journal: UploadJournal & { videoId: string }, deps: UploadDeps, log: Logger): Promise<RunContext> {
  const history = await deps.readHistory();
  const existing = history.find((r) => r.runId === ctx.runId || r.videoId === journal.videoId);
  const at = journal.uploadedAt ?? deps.now().toISOString();
  if (!existing) {
    await deps.appendHistory(historyRecord(ctx, journal.videoId, journal.requestedPrivacyStatus, "unknown", at));
    log.warn(`Recovered upload ${journal.videoId} from ${JOURNAL_FILE} and recorded it in the history (privacy unknown)`);
  }
  const actual = existing?.privacyStatus ?? "unknown";
  return { ...ctx, upload: uploadedResult(journal.videoId, journal.requestedPrivacyStatus, actual, at) };
}

async function performUpload(ctx: RunContext & { metadata: VideoMetadata; render: { videoPath: string } }, settings: UploadSettings, deps: UploadDeps, log: Logger): Promise<RunContext> {
  const requested = settings.privacyStatus;
  const history = await deps.readHistory();
  const previous = history.find((r) => r.runId === ctx.runId);
  if (previous) {
    log.warn(`Run ${ctx.runId} is already in the upload history as ${previous.videoId}; not uploading again`);
    return { ...ctx, upload: uploadedResult(previous.videoId, previous.requestedPrivacyStatus, previous.privacyStatus, previous.publishedAt) };
  }
  const cap = checkDailyCap(history, settings.maxUploadsPerDay, deps.now());
  if (!cap.allowed) {
    const reason = `daily cap reached (${cap.count}/${cap.max} in 24 h; next slot ${cap.nextSlotAt ?? "unknown"})`;
    log.warn(`Upload skipped: ${reason}. Upload later with: npm run stage -- 08-uploadYouTube --run ${ctx.runId}`);
    return { ...ctx, upload: { status: "skipped-cap", requestedPrivacyStatus: requested, reason } };
  }

  const earlier = await readJournal(ctx.runDir);
  let journal: UploadJournal = {
    runId: ctx.runId,
    status: "pending",
    startedAt: earlier?.startedAt ?? deps.now().toISOString(),
    requestedPrivacyStatus: requested,
    ...(earlier?.sessionUri ? { sessionUri: earlier.sessionUri } : {}),
  };
  await writeJournal(ctx.runDir, journal);
  await deps.saveContext?.({ ...ctx, upload: { status: "pending", requestedPrivacyStatus: requested } });

  const uploader = await deps.createUploader();
  try {
    if (journal.sessionUri) log.warn(`Resuming the upload session started at ${journal.startedAt} instead of uploading again`);
    log.info(`Uploading "${ctx.metadata.title}" as ${requested} (${cap.count}/${cap.max} uploads in the last 24 h)`);
    let video: { id: string };
    try {
      video = await uploader.upload(ctx.render.videoPath, buildVideoResource(ctx.metadata, settings), progressLogger(log), {
        sessionUri: journal.sessionUri,
        onSession: async (sessionUri) => {
          journal = { ...journal, sessionUri };
          await writeJournal(ctx.runDir, journal);
        },
      });
    } catch (error) {
      if (error instanceof UploadSessionLostError) {
        throw new Error(
          `${error.message}. The earlier upload may or may not have finished: check YouTube Studio, then delete ` +
            `${join(ctx.runDir, JOURNAL_FILE)} to allow a new upload.`,
        );
      }
      throw error;
    }
    const uploadedAt = deps.now().toISOString();
    // Record the video id before anything else can fail: a retry must never upload it again.
    journal = { ...journal, status: "uploaded", videoId: video.id, uploadedAt };
    await writeJournal(ctx.runDir, journal);
    await deps.saveContext?.({ ...ctx, upload: uploadedResult(video.id, requested, "unknown", uploadedAt) });

    let actual: ActualPrivacyStatus = "unknown";
    try {
      actual = (await uploader.getPrivacyStatus(video.id)) ?? "unknown";
    } catch (error) {
      log.warn(`Uploaded ${video.id} but could not read its privacy status: ${error instanceof Error ? error.message : String(error)}`);
    }
    const { movedCorruptTo } = await deps.appendHistory(historyRecord(ctx, video.id, requested, actual, uploadedAt));
    if (movedCorruptTo) log.warn(`data/history.json was unreadable; moved to ${movedCorruptTo} and started a new history`);
    const upload = uploadedResult(video.id, requested, actual, uploadedAt);
    if (upload.lockedPrivate) log.warn(`${LOCKED_PRIVATE_WARNING}: pediu "${requested}", ficou "${actual}". Vídeo ${upload.url}`);
    log.info(`Uploaded: ${upload.url} (privacy: requested ${requested}, actual ${actual})`);
    return { ...ctx, upload };
  } finally {
    await uploader.close();
  }
}

export async function uploadRun(ctx: RunContext, settings: UploadSettings, deps: UploadDeps, log: Logger): Promise<RunContext> {
  const requested = settings.privacyStatus;
  if (ctx.upload?.status === "uploaded" && ctx.upload.videoId) {
    log.warn(`Already uploaded as ${ctx.upload.videoId}; not uploading again`);
    return ctx;
  }
  // A video that already reached YouTube is always recorded first, whatever the gates say now.
  const journal = await readJournal(ctx.runDir);
  if (journal?.videoId) {
    const recover = () => completeJournaledUpload(ctx, { ...journal, videoId: journal.videoId as string }, deps, log);
    return deps.lock ? deps.lock(recover) : recover();
  }
  if (!settings.enabled) {
    log.info("Upload disabled (upload.enabled=false in config): skipping 08-uploadYouTube");
    return { ...ctx, upload: { status: "skipped-disabled", requestedPrivacyStatus: requested, reason: "upload.enabled=false" } };
  }
  const blockers = publishBlockers(ctx, settings);
  if (blockers.length > 0) throw new UploadBlockedError(`Refusing to upload ${ctx.runId}: ${blockers.join("; ")}`);
  const { metadata, render } = ctx;
  if (!metadata) throw new Error("08-uploadYouTube requires ctx.metadata (run 07-generateMetadata first)");
  if (!render?.videoPath || !existsSync(render.videoPath)) throw new Error("08-uploadYouTube requires a rendered final.mp4");

  const run = async (): Promise<RunContext> => {
    const latest = await readJournal(ctx.runDir); // re-read under the lock
    if (latest?.videoId) return completeJournaledUpload(ctx, { ...latest, videoId: latest.videoId }, deps, log);
    return performUpload({ ...ctx, metadata, render }, settings, deps, log);
  };
  return deps.lock ? deps.lock(run) : run();
}

export async function run(ctx: RunContext): Promise<RunContext> {
  return uploadRun(ctx, resolveUploadSettings(loadConfig().upload), defaultUploadDeps, getLogger(ctx.runId));
}
