import { youtube as youtubeApi } from "@googleapis/youtube";
import type { PipelineConfig } from "../lib/config.js";
import type { Logger } from "../lib/logger.js";
import { loadAuthorizedClient } from "../lib/youtubeAuth.js";
import { resumableUpload } from "../lib/youtubeUpload.js";
import type { RunContext, VideoMetadata, YouTubePrivacyStatus } from "../types.js";
import { publishAll, type PublishDeps } from "./runner.js";
import type { PublishableContext, Publisher, PublisherConnection, SessionHooks } from "./types.js";

export const LOCKED_PRIVATE_WARNING = "YouTube travou o vídeo como privado (projeto não auditado)";

/** YouTube settings = the `upload` section of the config (kept as-is for backward compatibility). */
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

function asPrivacy(value: unknown): YouTubePrivacyStatus | undefined {
  return value === "public" || value === "unlisted" || value === "private" ? value : undefined;
}

export function videoUrl(videoId: string): string {
  return `https://youtube.com/shorts/${videoId}`;
}

// ---------------------------------------------------------------------------------------------
// YouTube API access
// ---------------------------------------------------------------------------------------------

/** Kept as the injectable YouTube API surface (tests fake it). */
export type UploadSessionHooks = SessionHooks;

export interface YouTubeUploader {
  upload(filePath: string, resource: unknown, onProgress: (done: number, total: number) => void, session?: UploadSessionHooks): Promise<{ id: string }>;
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

function asConnection(uploader: YouTubeUploader): PublisherConnection {
  return {
    publish: (filePath, payload, onProgress, session) => uploader.upload(filePath, payload, onProgress, session),
    verify: (postId) => uploader.getPrivacyStatus(postId),
    close: () => uploader.close(),
  };
}

// ---------------------------------------------------------------------------------------------
// Publisher
// ---------------------------------------------------------------------------------------------

export function createYouTubePublisher(settings: UploadSettings, createUploader: () => Promise<YouTubeUploader> = createYouTubeUploader): Publisher {
  return {
    id: "youtube",
    settings: { enabled: settings.enabled, maxPostsPerDay: settings.maxUploadsPerDay, requestedPrivacy: settings.privacyStatus },
    // Exact log texts of the YouTube-only stage (the dashboard reads these logs).
    texts: {
      logPrefix: "",
      enabledSetting: "upload.enabled",
      managementConsole: "YouTube Studio",
      lockedPrivateWarning: LOCKED_PRIVATE_WARNING,
    },
    blockers: () => [],
    buildPost: (ctx: PublishableContext) => buildVideoResource(ctx.metadata, settings),
    connect: async () => asConnection(await createUploader()),
    postUrl: videoUrl,
  };
}

// ---------------------------------------------------------------------------------------------
// YouTube-only entry point (the stage before publishers existed; kept for callers and tests)
// ---------------------------------------------------------------------------------------------

export interface UploadDeps extends PublishDeps {
  createUploader: () => Promise<YouTubeUploader>;
}

/** Publishes `ctx` on YouTube only, with exactly the behaviour of the original upload stage. */
export async function uploadRun(ctx: RunContext, settings: UploadSettings, deps: UploadDeps, log: Logger): Promise<RunContext> {
  return publishAll(ctx, [createYouTubePublisher(settings, deps.createUploader)], settings, deps, log);
}
