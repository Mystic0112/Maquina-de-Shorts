import { existsSync } from "node:fs";
import { youtube as youtubeApi } from "@googleapis/youtube";
import type { UploadRecord } from "../../shared/history.js";
import { loadConfig, type PipelineConfig } from "../lib/config.js";
import { getLogger, type Logger } from "../lib/logger.js";
import { appendUploadRecord, checkDailyCap, readHistoryRecords } from "../lib/uploadHistory.js";
import { loadAuthorizedClient } from "../lib/youtubeAuth.js";
import { resumableUpload } from "../lib/youtubeUpload.js";
import type { RunContext, UploadResult, VideoMetadata, YouTubePrivacyStatus } from "../types.js";

export const LOCKED_PRIVATE_WARNING = "YouTube travou o vídeo como privado (projeto não auditado)";

export interface UploadSettings {
  enabled: boolean;
  privacyStatus: YouTubePrivacyStatus;
  categoryId: string;
  maxUploadsPerDay: number;
  containsSyntheticMedia: boolean;
}

export function resolveUploadSettings(upload: PipelineConfig["upload"]): UploadSettings {
  return {
    enabled: upload.enabled ?? false,
    privacyStatus: upload.privacyStatus,
    categoryId: String(upload.categoryId),
    maxUploadsPerDay: upload.maxUploadsPerDay,
    containsSyntheticMedia: upload.containsSyntheticMedia ?? false,
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
export function isLockedPrivate(requested: YouTubePrivacyStatus, actual: YouTubePrivacyStatus | undefined): boolean {
  return requested !== "private" && actual === "private";
}

function asPrivacy(value: unknown): YouTubePrivacyStatus | undefined {
  return value === "public" || value === "unlisted" || value === "private" ? value : undefined;
}

// ---------------------------------------------------------------------------------------------
// YouTube access (injected so the stage can be tested without network)
// ---------------------------------------------------------------------------------------------

export interface YouTubeUploader {
  upload(filePath: string, resource: unknown, onProgress: (done: number, total: number) => void): Promise<{ id: string }>;
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
    upload: (filePath, resource, onProgress) =>
      resumableUpload({ filePath, resource, parts: ["snippet", "status"], getAccessToken, onProgress }),
    async getPrivacyStatus(videoId) {
      const res = await api.videos.list({ part: ["status"], id: [videoId] });
      return asPrivacy(res.data.items?.[0]?.status?.privacyStatus);
    },
    close: flush,
  };
}

export interface UploadDeps {
  createUploader: () => Promise<YouTubeUploader>;
  readHistory: () => Promise<UploadRecord[]>;
  appendHistory: (record: UploadRecord) => Promise<{ movedCorruptTo?: string }>;
  now: () => Date;
}

export const defaultUploadDeps: UploadDeps = {
  createUploader: createYouTubeUploader,
  readHistory: () => readHistoryRecords(),
  appendHistory: (record) => appendUploadRecord(record),
  now: () => new Date(),
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

// ---------------------------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------------------------

export async function uploadRun(ctx: RunContext, settings: UploadSettings, deps: UploadDeps, log: Logger): Promise<RunContext> {
  const requested = settings.privacyStatus;
  if (ctx.upload?.status === "uploaded" && ctx.upload.videoId) {
    log.warn(`Already uploaded as ${ctx.upload.videoId}; not uploading again`);
    return ctx;
  }
  if (!settings.enabled) {
    log.info("Upload disabled (upload.enabled=false in config): skipping 08-uploadYouTube");
    return { ...ctx, upload: { status: "skipped-disabled", requestedPrivacyStatus: requested, reason: "upload.enabled=false" } };
  }
  if (!ctx.metadata) throw new Error("08-uploadYouTube requires ctx.metadata (run 07-generateMetadata first)");
  if (!ctx.render?.videoPath || !existsSync(ctx.render.videoPath)) throw new Error("08-uploadYouTube requires a rendered final.mp4");

  const history = await deps.readHistory();
  const previous = history.find((r) => r.runId === ctx.runId);
  if (previous) {
    log.warn(`Run ${ctx.runId} is already in the upload history as ${previous.videoId}; not uploading again`);
    return { ...ctx, upload: { status: "uploaded", videoId: previous.videoId, url: videoUrl(previous.videoId), requestedPrivacyStatus: previous.requestedPrivacyStatus, privacyStatus: previous.privacyStatus, uploadedAt: previous.publishedAt } };
  }
  const cap = checkDailyCap(history, settings.maxUploadsPerDay, deps.now());
  if (!cap.allowed) {
    const reason = `daily cap reached (${cap.count}/${cap.max} in 24 h; next slot ${cap.nextSlotAt ?? "unknown"})`;
    log.warn(`Upload skipped: ${reason}. Upload later with: npm run stage -- 08-uploadYouTube --run ${ctx.runId}`);
    return { ...ctx, upload: { status: "skipped-cap", requestedPrivacyStatus: requested, reason } };
  }

  const uploader = await deps.createUploader();
  try {
    log.info(`Uploading "${ctx.metadata.title}" as ${requested} (${cap.count}/${cap.max} uploads in the last 24 h)`);
    const video = await uploader.upload(ctx.render.videoPath, buildVideoResource(ctx.metadata, settings), progressLogger(log));
    const actual = (await uploader.getPrivacyStatus(video.id)) ?? requested;
    const lockedPrivate = isLockedPrivate(requested, actual);
    if (lockedPrivate) {
      log.warn(`${LOCKED_PRIVATE_WARNING}: pediu "${requested}", ficou "${actual}". Vídeo ${videoUrl(video.id)}`);
    }
    const uploadedAt = deps.now().toISOString();
    const record: UploadRecord = {
      runId: ctx.runId,
      videoId: video.id,
      title: ctx.metadata.title,
      publishedAt: uploadedAt,
      privacyStatus: actual,
      requestedPrivacyStatus: requested,
      categoryId: ctx.metadata.categoryId,
      topicCategoryId: ctx.topic?.categoryId ?? "unknown",
    };
    const { movedCorruptTo } = await deps.appendHistory(record);
    if (movedCorruptTo) log.warn(`data/history.json was unreadable; moved to ${movedCorruptTo} and started a new history`);
    const upload: UploadResult = {
      status: "uploaded",
      videoId: video.id,
      url: videoUrl(video.id),
      requestedPrivacyStatus: requested,
      privacyStatus: actual,
      lockedPrivate,
      uploadedAt,
    };
    log.info(`Uploaded: ${upload.url} (privacy: requested ${requested}, actual ${actual})`);
    return { ...ctx, upload };
  } finally {
    await uploader.close();
  }
}

export function videoUrl(videoId: string): string {
  return `https://youtube.com/shorts/${videoId}`;
}

export async function run(ctx: RunContext): Promise<RunContext> {
  return uploadRun(ctx, resolveUploadSettings(loadConfig().upload), defaultUploadDeps, getLogger(ctx.runId));
}
