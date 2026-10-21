import { readFile } from "node:fs/promises";
import { resolveInstagram, type InstagramSettings } from "../../shared/settings.js";
import {
  ensureFreshToken,
  instagramTokenPath,
  instagramTokenProblems,
  readInstagramTokenSync,
  type InstagramToken,
} from "../lib/instagramAuth.js";
import {
  defaultHttp,
  formBody,
  GRAPH_VERSION,
  graphUrl,
  InstagramApiError,
  requestJson,
  RUPLOAD_HOST,
  stringField,
  unwrapData,
  type HttpFetch,
} from "../lib/instagramApi.js";
import { serveVideoTunnel, type VideoTunnel } from "../lib/cloudflaredTunnel.js";
import { UploadSessionLostError } from "../lib/youtubeUpload.js";
import type { RunContext } from "../types.js";
import { buildInstagramCaption } from "./instagramCaption.js";
import type { PublishableContext, Publisher, PublisherConnection, SessionHooks } from "./types.js";

/**
 * Instagram Reels publisher ("Instagram API with Instagram Login", host graph.instagram.com).
 * Flow per Meta's Content Publishing guide:
 *   content_publishing_limit -> POST /<IG_ID>/media (media_type=REELS, upload_type=resumable) ->
 *   POST rupload.facebook.com/ig-api-upload/<ver>/<container> (whole file, offset + file_size headers) ->
 *   GET /<container>?fields=status_code until FINISHED -> POST /<IG_ID>/media_publish -> GET permalink.
 * Default outside tests: instead of rupload, the container gets `video_url` pointing at a temporary cloudflared
 * tunnel (lib/cloudflaredTunnel.ts) that stays open only until the container leaves IN_PROGRESS.
 * The container id is journaled (SessionHooks.onSession) BEFORE any byte is sent, so a retry inspects and
 * resumes that same container and never creates a second post.
 * https://developers.facebook.com/documentation/instagram-platform/content-publishing
 * https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media
 */

export const MAX_REEL_BYTES = 300 * 1024 * 1024;
/** Meta documents 50 (content_publishing_limit reference); used only when the API omits quota_total. */
export const DEFAULT_QUOTA_TOTAL = 50;
export const LOCKED_PRIVATE_WARNING = "Instagram publicou o Reel como privado";
/**
 * Reel cover frame (`thumb_offset`, ms; Meta: "for videos and reels, the location in milliseconds of the frame used
 * as the cover", default 0 = first frame). 1.2 s falls inside the on-screen hook text window (visual.overlayHookSeconds,
 * 2.5 s by default, at least 1 s), after its entrance animation, so the grid shows the overlay text, not a fade-in.
 */
export const REEL_COVER_OFFSET_MS = 1200;

export function resolveInstagramSettings(section: InstagramSettings | undefined): Required<InstagramSettings> {
  return resolveInstagram(section);
}

export interface InstagramPost {
  caption: string;
  /** Cover frame in ms (thumb_offset); undefined = Meta's default (first frame). */
  coverOffsetMs?: number;
}

// ---------------------------------------------------------------------------------------------
// API surface (injectable; createGraphClient is the real one)
// ---------------------------------------------------------------------------------------------

export type ContainerStatusCode = "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED";

export interface ContainerState {
  statusCode: ContainerStatusCode | string;
  status?: string;
}

export interface UploadState {
  bytes?: number;
  complete: boolean;
}

export interface MediaSummary {
  id: string;
  caption?: string;
  permalink?: string;
}

export interface InstagramClient {
  publishingLimit(): Promise<{ usage: number; total: number }>;
  createReelContainer(caption: string, coverOffsetMs?: number, videoUrl?: string): Promise<{ id: string; uploadUri?: string }>;
  getContainer(containerId: string): Promise<ContainerState>;
  /** Best effort (video_status); undefined when the API does not tell. */
  uploadState(containerId: string): Promise<UploadState | undefined>;
  uploadVideo(containerId: string, uploadUri: string | undefined, bytes: Uint8Array, offset: number, fileSize: number): Promise<void>;
  publishContainer(containerId: string): Promise<string>;
  getMedia(mediaId: string): Promise<MediaSummary>;
  recentMedia(): Promise<MediaSummary[]>;
}

const ID_PATTERN = /^\d{1,40}$/;

function assertId(id: string, what: string): string {
  if (!ID_PATTERN.test(id)) throw new InstagramApiError(`Invalid Instagram ${what} id "${id.slice(0, 40)}"`);
  return id;
}

/** Only rupload.facebook.com ever receives the token in an upload; anything else falls back to the documented URL. */
export function ruploadUrl(containerId: string, uri?: string): string {
  if (uri) {
    try {
      const u = new URL(uri);
      if (u.protocol === "https:" && u.host === new URL(RUPLOAD_HOST).host) return u.toString();
    } catch {
      // malformed uri: use the documented one below
    }
  }
  return `${RUPLOAD_HOST}/ig-api-upload/${GRAPH_VERSION}/${assertId(containerId, "container")}`;
}

function numberField(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function toMedia(raw: unknown): MediaSummary | undefined {
  const json = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
  const id = json ? stringField(json, "id") : undefined;
  return json && id ? { id, caption: stringField(json, "caption"), permalink: stringField(json, "permalink") } : undefined;
}

export function createGraphClient(token: Pick<InstagramToken, "accessToken" | "userId">, http: HttpFetch = defaultHttp): InstagramClient {
  const auth = { access_token: token.accessToken };
  const userId = assertId(token.userId, "user");
  const get = (path: string, params: Record<string, string>) => requestJson(http, graphUrl(path, { ...params, ...auth }), { method: "GET" });
  const post = (path: string, params: Record<string, string>) =>
    requestJson(http, graphUrl(path), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({ ...params, ...auth }),
    });
  return {
    async publishingLimit() {
      const json = unwrapData(await get(`${userId}/content_publishing_limit`, { fields: "quota_usage,config" }));
      const config = json.config && typeof json.config === "object" ? (json.config as Record<string, unknown>) : {};
      return { usage: numberField(json.quota_usage) ?? 0, total: numberField(config.quota_total) ?? DEFAULT_QUOTA_TOTAL };
    },
    async createReelContainer(caption, coverOffsetMs, videoUrl) {
      const params: Record<string, string> = { media_type: "REELS", caption };
      if (videoUrl) {
        params.video_url = videoUrl;
      } else {
        params.upload_type = "resumable";
      }
      if (coverOffsetMs !== undefined && coverOffsetMs >= 0) params.thumb_offset = String(Math.round(coverOffsetMs));
      const json = await post(`${userId}/media`, params);
      const id = stringField(json, "id");
      if (!id) throw new InstagramApiError("Container creation returned no id");
      return { id: assertId(id, "container"), uploadUri: stringField(json, "uri") };
    },
    async getContainer(containerId) {
      const json = await get(assertId(containerId, "container"), { fields: "id,status,status_code" });
      return { statusCode: stringField(json, "status_code") ?? "UNKNOWN", status: stringField(json, "status") };
    },
    async uploadState(containerId) {
      try {
        const json = await get(assertId(containerId, "container"), { fields: "video_status" });
        const phase = (json.video_status as { uploading_phase?: { status?: unknown; bytes_transferred?: unknown } } | undefined)?.uploading_phase;
        if (!phase) return undefined;
        return { bytes: numberField(phase.bytes_transferred), complete: phase.status === "complete" };
      } catch {
        return undefined; // field not available on this host/version: caller restarts from byte 0 (same container)
      }
    },
    async uploadVideo(containerId, uploadUri, bytes, offset, fileSize) {
      const json = await requestJson(http, ruploadUrl(containerId, uploadUri), {
        method: "POST",
        headers: { Authorization: `OAuth ${token.accessToken}`, offset: String(offset), file_size: String(fileSize) },
        body: bytes,
        timeoutMs: 20 * 60 * 1000,
      });
      if (json.success !== true) throw new InstagramApiError(`Video upload not accepted: ${JSON.stringify(json).slice(0, 300)}`, undefined, undefined, true);
    },
    async publishContainer(containerId) {
      const json = await post(`${userId}/media_publish`, { creation_id: assertId(containerId, "container") });
      const id = stringField(json, "id");
      if (!id) throw new InstagramApiError("media_publish returned no media id");
      return id;
    },
    async getMedia(mediaId) {
      const media = toMedia(await get(assertId(mediaId, "media"), { fields: "id,permalink" }));
      if (!media) throw new InstagramApiError(`Media ${mediaId} not found`);
      return media;
    },
    async recentMedia() {
      const json = await get(`${userId}/media`, { fields: "id,caption,permalink,timestamp", limit: "25" });
      return (Array.isArray(json.data) ? json.data : []).map(toMedia).filter((m): m is MediaSummary => !!m);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Publishing algorithm
// ---------------------------------------------------------------------------------------------

export class InstagramPublishingLimitError extends Error {}
export class InstagramContainerError extends Error {}
export class InstagramPollTimeoutError extends Error {}

export interface PublishReelOptions {
  sleep?: (ms: number) => Promise<void>;
  /** Milliseconds clock (polling budget). */
  now?: () => number;
  /** Meta recommends checking status for no more than 5 minutes. */
  pollTimeoutMs?: number;
  pollDelaysMs?: readonly number[];
  maxUploadAttempts?: number;
  readVideo?: (filePath: string) => Promise<Uint8Array>;
  /**
   * Serves the video at a temporary public URL for `video_url` (default: cloudflared quick tunnel; none under
   * NODE_ENV=test). `null` forces the resumable upload to rupload.facebook.com.
   */
  serveTunnel?: ServeTunnel | null;
}

export type ServeTunnel = (filePath: string) => Promise<VideoTunnel>;

export const DEFAULT_POLL_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_POLL_DELAYS_MS = [5_000, 10_000, 15_000, 30_000, 30_000, 60_000] as const;

type Log = NonNullable<SessionHooks["log"]>;
const silent: Log = { info: () => undefined, warn: () => undefined };
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Resolved {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  pollTimeoutMs: number;
  pollDelaysMs: readonly number[];
  maxUploadAttempts: number;
  readVideo: (filePath: string) => Promise<Uint8Array>;
  serveTunnel?: ServeTunnel;
}

function resolveOptions(o: PublishReelOptions): Resolved {
  return {
    sleep: o.sleep ?? realSleep,
    now: o.now ?? Date.now,
    pollTimeoutMs: o.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
    pollDelaysMs: o.pollDelaysMs ?? DEFAULT_POLL_DELAYS_MS,
    maxUploadAttempts: o.maxUploadAttempts ?? 3,
    readVideo: o.readVideo ?? readFile,
    serveTunnel: o.serveTunnel === null ? undefined : (o.serveTunnel ?? (process.env.NODE_ENV === "test" ? undefined : serveVideoTunnel)),
  };
}

function normalizeCaption(text: string | undefined): string {
  return (text ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
}

/** The container is PUBLISHED but the media id was never recorded: find the post, never publish again. */
async function findPublishedMedia(client: InstagramClient, containerId: string, caption: string): Promise<string> {
  const wanted = normalizeCaption(caption);
  const match = (await client.recentMedia()).find((m) => normalizeCaption(m.caption) === wanted);
  if (match) return match.id;
  throw new Error(
    `Instagram container ${containerId} is already PUBLISHED but its post was not found among the latest 25 posts. ` +
      "Not publishing again: check the Instagram app and record the post manually if needed.",
  );
}

async function assertQuota(client: InstagramClient, log: Log): Promise<void> {
  const { usage, total } = await client.publishingLimit();
  if (usage >= total) throw new InstagramPublishingLimitError(`Instagram publishing limit reached (${usage}/${total} posts in 24 h, content_publishing_limit)`);
  log.info(`Instagram quota: ${usage}/${total} posts in the last 24 h`);
}

type Resume = { kind: "published"; mediaId: string } | { kind: "upload"; offset: number } | { kind: "processing" } | { kind: "new" };

function isMissingObject(error: unknown): boolean {
  return error instanceof InstagramApiError && (error.code === 100 || error.status === 404);
}

/** Decides what to do with a journaled container (the retry path). */
async function inspectContainer(client: InstagramClient, containerId: string, caption: string, log: Log): Promise<Resume> {
  let state: ContainerState;
  try {
    state = await client.getContainer(containerId);
  } catch (error) {
    if (isMissingObject(error)) throw new UploadSessionLostError(`Instagram container ${containerId} no longer exists`);
    throw error;
  }
  log.warn(`Resuming Instagram container ${containerId} (status ${state.statusCode}) instead of creating a new one`);
  if (state.statusCode === "PUBLISHED") return { kind: "published", mediaId: await findPublishedMedia(client, containerId, caption) };
  if (state.statusCode === "FINISHED") return { kind: "processing" };
  if (state.statusCode === "ERROR" || state.statusCode === "EXPIRED") {
    // Neither state was ever published (Meta: ERROR = failed, EXPIRED = not published within 24 h).
    log.warn(`Container ${containerId} is ${state.statusCode}${state.status ? ` (${state.status})` : ""}; creating a new container`);
    return { kind: "new" };
  }
  const upload = await client.uploadState(containerId);
  if (upload?.complete) return { kind: "processing" };
  return { kind: "upload", offset: upload?.bytes ?? 0 };
}

async function uploadFile(
  client: InstagramClient,
  container: { id: string; uploadUri?: string },
  filePath: string,
  startOffset: number,
  onProgress: (done: number, total: number) => void,
  o: Resolved,
  log: Log,
): Promise<void> {
  const bytes = await o.readVideo(filePath);
  if (bytes.length === 0 || bytes.length > MAX_REEL_BYTES) throw new InstagramContainerError(`Video has ${bytes.length} bytes (Reels accept 1 byte to 300 MB)`);
  let offset = Math.min(Math.max(0, startOffset), bytes.length);
  for (let attempt = 1; ; attempt++) {
    onProgress(offset, bytes.length);
    try {
      await client.uploadVideo(container.id, container.uploadUri, bytes.subarray(offset), offset, bytes.length);
      onProgress(bytes.length, bytes.length);
      return;
    } catch (error) {
      if (!(error instanceof InstagramApiError && error.retriable) || attempt >= o.maxUploadAttempts) throw error;
      log.warn(`Upload attempt ${attempt} failed (${error.message}); retrying the same container`);
      await o.sleep(2000 * 2 ** attempt);
      const state = await client.uploadState(container.id);
      if (state?.complete) return onProgress(bytes.length, bytes.length);
      offset = state?.bytes ?? 0;
    }
  }
}

/**
 * Resuming an IN_PROGRESS container whose upload state is unknown: Meta may already have the whole file
 * and refuse the bytes again. A definitive (non-retriable) refusal is left to the status poll to judge.
 */
async function resendFile(...args: Parameters<typeof uploadFile>): Promise<void> {
  const log = args[6];
  try {
    await uploadFile(...args);
  } catch (error) {
    if (!(error instanceof InstagramApiError) || error.retriable) throw error;
    log.warn(`Re-sending the video was refused (${error.message}); checking the container status instead`);
  }
}

/** Polls status_code with growing delays until FINISHED/PUBLISHED, failing on ERROR/EXPIRED or timeout. */
async function waitForContainer(client: InstagramClient, containerId: string, o: Resolved): Promise<"FINISHED" | "PUBLISHED"> {
  const started = o.now();
  let transient = 0;
  for (let i = 0; ; i++) {
    const state = await client.getContainer(containerId).catch((error: unknown) => {
      if (!(error instanceof InstagramApiError && error.retriable) || ++transient > 3) throw error;
      return undefined;
    });
    if (state?.statusCode === "FINISHED" || state?.statusCode === "PUBLISHED") return state.statusCode;
    if (state?.statusCode === "ERROR" || state?.statusCode === "EXPIRED") {
      throw new InstagramContainerError(`Instagram container ${containerId} is ${state.statusCode}${state.status ? `: ${state.status}` : ""}`);
    }
    const remaining = o.pollTimeoutMs - (o.now() - started);
    if (remaining <= 0) {
      throw new InstagramPollTimeoutError(
        `Instagram still processing container ${containerId} after ${Math.round(o.pollTimeoutMs / 1000)} s; the next attempt resumes the same container`,
      );
    }
    await o.sleep(Math.min(remaining, o.pollDelaysMs[Math.min(i, o.pollDelaysMs.length - 1)] ?? 30_000));
  }
}

/** media_publish; if the call fails after Meta actually published, the container says PUBLISHED: recover. */
async function publishContainer(client: InstagramClient, containerId: string, caption: string): Promise<string> {
  try {
    return await client.publishContainer(containerId);
  } catch (error) {
    const state = await client.getContainer(containerId).catch(() => undefined);
    if (state?.statusCode === "PUBLISHED") return findPublishedMedia(client, containerId, caption);
    throw error;
  }
}

export async function publishReel(
  client: InstagramClient,
  filePath: string,
  post: InstagramPost,
  onProgress: (done: number, total: number) => void,
  session: SessionHooks,
  options: PublishReelOptions = {},
): Promise<{ id: string }> {
  const o = resolveOptions(options);
  const log = session.log ?? silent;
  const resume: Resume = session.sessionUri ? await inspectContainer(client, assertId(session.sessionUri, "container"), post.caption, log) : { kind: "new" };
  if (resume.kind === "published") return { id: resume.mediaId };
  await assertQuota(client, log);
  let container: { id: string; uploadUri?: string } = { id: session.sessionUri ?? "" };
  let state: "FINISHED" | "PUBLISHED";
  if (resume.kind === "new" && o.serveTunnel) {
    ({ container, state } = await publishViaTunnel(client, o.serveTunnel, filePath, post, session, o, log));
  } else {
    if (resume.kind === "new") {
      container = await createContainer(client, post, session, log);
      await uploadFile(client, container, filePath, 0, onProgress, o, log);
    }
    if (resume.kind === "upload") await resendFile(client, container, filePath, resume.offset, onProgress, o, log);
    state = await waitForContainer(client, container.id, o);
  }
  if (state === "PUBLISHED") return { id: await findPublishedMedia(client, container.id, post.caption) };
  return { id: await publishContainer(client, container.id, post.caption) };
}

async function createContainer(client: InstagramClient, post: InstagramPost, session: SessionHooks, log: Log, videoUrl?: string): Promise<{ id: string; uploadUri?: string }> {
  const container = await client.createReelContainer(post.caption, post.coverOffsetMs, videoUrl);
  await session.onSession(container.id); // journaled right away: a retry resumes this container
  log.info(`Created Instagram container ${container.id}`);
  return container;
}

/**
 * `video_url` flow: Meta downloads the video from a temporary public tunnel while the container is
 * IN_PROGRESS. The tunnel is closed as soon as processing ends (or anything fails), before media_publish.
 */
async function publishViaTunnel(
  client: InstagramClient,
  serveTunnel: ServeTunnel,
  filePath: string,
  post: InstagramPost,
  session: SessionHooks,
  o: Resolved,
  log: Log,
): Promise<{ container: { id: string; uploadUri?: string }; state: "FINISHED" | "PUBLISHED" }> {
  log.info("Opening a temporary HTTPS tunnel so Instagram can download the video");
  const tunnel = await serveTunnel(filePath);
  try {
    const container = await createContainer(client, post, session, log, tunnel.url);
    return { container, state: await waitForContainer(client, container.id, o) };
  } finally {
    await tunnel.close().catch((error: unknown) => log.warn(`Could not close the temporary tunnel: ${error instanceof Error ? error.message : String(error)}`));
    log.info("Temporary tunnel closed");
  }
}

// ---------------------------------------------------------------------------------------------
// Publisher
// ---------------------------------------------------------------------------------------------

export interface InstagramPublisherDeps {
  tokenFile?: string;
  now?: () => Date;
  http?: HttpFetch;
  /** Overrides the Graph client (tests). Receives the (refreshed) token. */
  createClient?: (token: InstagramToken) => InstagramClient;
  publishOptions?: PublishReelOptions;
  /** Reel cover frame in ms (default REEL_COVER_OFFSET_MS). */
  coverOffsetMs?: number;
}

function profileUrl(tokenFile: string): string {
  try {
    const { username } = readInstagramTokenSync(tokenFile);
    return username ? `https://www.instagram.com/${encodeURIComponent(username)}/reels/` : "https://www.instagram.com/";
  } catch {
    return "https://www.instagram.com/";
  }
}

function captionProblems(ctx: RunContext): string[] {
  if (!ctx.metadata) return [];
  try {
    buildInstagramCaption(ctx.metadata, ctx.footage ?? []);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

export function createInstagramPublisher(settings: Required<InstagramSettings>, deps: InstagramPublisherDeps = {}): Publisher {
  const tokenFile = deps.tokenFile ?? instagramTokenPath();
  const now = deps.now ?? (() => new Date());
  const http = deps.http ?? defaultHttp;
  const permalinks = new Map<string, string>();

  const connect = async (): Promise<PublisherConnection> => {
    const warnings: string[] = [];
    const token = await ensureFreshToken({ file: tokenFile, http, now: now(), warn: (m) => warnings.push(m) });
    const client = (deps.createClient ?? ((t: InstagramToken) => createGraphClient(t, http)))(token);
    return {
      async publish(filePath, payload, onProgress, session) {
        for (const w of warnings.splice(0)) session.log?.warn(w);
        const result = await publishReel(client, filePath, payload as InstagramPost, onProgress, session, deps.publishOptions);
        const media = await client.getMedia(result.id).catch(() => undefined);
        if (media?.permalink) permalinks.set(result.id, media.permalink);
        return result;
      },
      // Professional accounts are always public; reading the post back confirms it exists.
      verify: async (postId) => {
        const media = await client.getMedia(postId);
        if (media.permalink) permalinks.set(postId, media.permalink);
        return "public";
      },
      close: async () => undefined,
    };
  };

  return {
    id: "instagram",
    settings: { enabled: settings.enabled, maxPostsPerDay: settings.maxPostsPerDay, requestedPrivacy: "public" },
    texts: {
      logPrefix: "[instagram] ",
      enabledSetting: "instagram.enabled",
      managementConsole: "the Instagram app (profile > Reels)",
      lockedPrivateWarning: LOCKED_PRIVATE_WARNING,
    },
    blockers: (ctx) => [...instagramTokenProblems(tokenFile, now()), ...captionProblems(ctx)],
    buildPost: (ctx: PublishableContext): InstagramPost => ({
      caption: buildInstagramCaption(ctx.metadata, ctx.footage ?? []),
      coverOffsetMs: deps.coverOffsetMs ?? REEL_COVER_OFFSET_MS,
    }),
    connect,
    postUrl: (postId) => permalinks.get(postId) ?? profileUrl(tokenFile),
  };
}
