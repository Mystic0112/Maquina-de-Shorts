import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { recordPlatform, type ActualPrivacyStatus, type PrivacyStatus, type UploadRecord } from "../../shared/history.js";
import { readJsonIfExists, writeFileAtomic } from "../lib/fileLock.js";
import type { Logger } from "../lib/logger.js";
import { StageFailedError } from "../lib/rejection.js";
import { checkDailyCap } from "../lib/uploadHistory.js";
import { UploadSessionLostError } from "../lib/youtubeUpload.js";
import type { PlatformId, PublicationResult, RunContext, UploadResult } from "../types.js";
import { publishBlockers, type SharedGateSettings } from "./gates.js";
import type { PublishableContext, Publisher } from "./types.js";

// ---------------------------------------------------------------------------------------------
// Journal: <runDir>/upload.<platform>.journal.json survives crashes and failed context/history writes
// ---------------------------------------------------------------------------------------------

/** Journal written by the YouTube-only version of the stage; still read (and migrated) for YouTube. */
export const LEGACY_YOUTUBE_JOURNAL = "upload.journal.json";

export function journalFile(platform: PlatformId): string {
  return `upload.${platform}.journal.json`;
}

/** Field names are those of the original YouTube journal, so old journals stay readable. */
export interface PublishJournal {
  runId: string;
  platform?: PlatformId;
  status: "pending" | "uploaded";
  startedAt: string;
  requestedPrivacyStatus: PrivacyStatus;
  /** Resumable session: a retry resumes it instead of opening a second upload. */
  sessionUri?: string;
  /** Post id on the platform (YouTube video id). */
  videoId?: string;
  uploadedAt?: string;
}

function asJournal(raw: unknown): PublishJournal | undefined {
  return raw && typeof raw === "object" ? (raw as PublishJournal) : undefined;
}

export async function readPublishJournal(runDir: string, platform: PlatformId): Promise<PublishJournal | undefined> {
  const current = asJournal(await readJsonIfExists(join(runDir, journalFile(platform))));
  if (current || platform !== "youtube") return current;
  return asJournal(await readJsonIfExists(join(runDir, LEGACY_YOUTUBE_JOURNAL)));
}

async function writePublishJournal(runDir: string, platform: PlatformId, journal: PublishJournal): Promise<void> {
  await writeFileAtomic(join(runDir, journalFile(platform)), `${JSON.stringify({ ...journal, platform }, null, 2)}\n`);
  // Migrated: the per-platform file now holds everything the legacy one had.
  const legacy = join(runDir, LEGACY_YOUTUBE_JOURNAL);
  if (platform === "youtube" && existsSync(legacy)) await rm(legacy, { force: true });
}

// ---------------------------------------------------------------------------------------------
// Dependencies (injected so publishing can be tested without network)
// ---------------------------------------------------------------------------------------------

export interface PublishDeps {
  /** Must throw when the history exists but cannot be trusted (fail-closed). */
  readHistory: () => Promise<UploadRecord[]>;
  appendHistory: (record: UploadRecord) => Promise<{ movedCorruptTo?: string }>;
  now: () => Date;
  /** Cross-process lock around "read history -> cap -> publish -> append". */
  lock?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Persists the context mid-stage (so the dashboard sees a pending/finished upload immediately). */
  saveContext?: (ctx: RunContext) => Promise<void>;
}

/** Shared gates failed: nothing is published on any platform. */
export class UploadBlockedError extends StageFailedError {}

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

/** True when the platform applied "private" although public/unlisted was requested. */
export function isLockedPrivate(requested: PrivacyStatus, actual: ActualPrivacyStatus | undefined): boolean {
  return requested !== "private" && actual === "private";
}

function uploaded(p: Publisher, postId: string, requested: PrivacyStatus, actual: ActualPrivacyStatus, at: string): PublicationResult {
  return {
    platform: p.id,
    status: "uploaded",
    videoId: postId,
    url: p.postUrl(postId),
    requestedPrivacyStatus: requested,
    privacyStatus: actual,
    lockedPrivate: isLockedPrivate(requested, actual),
    uploadedAt: at,
  };
}

function toUploadResult(pub: PublicationResult): UploadResult | undefined {
  if (pub.status === "failed") return undefined;
  const { platform: _platform, status, ...rest } = pub;
  return { ...rest, status };
}

/** Stores a platform's result; YouTube's is mirrored into ctx.upload for the dashboard. */
export function withPublication(ctx: RunContext, pub: PublicationResult): RunContext {
  const upload = pub.platform === "youtube" ? toUploadResult(pub) : undefined;
  return { ...ctx, publications: { ...ctx.publications, [pub.platform]: pub }, ...(upload ? { upload } : {}) };
}

function existingPublication(ctx: RunContext, p: Publisher): PublicationResult | undefined {
  const pub = ctx.publications?.[p.id];
  if (pub?.status === "uploaded" && pub.videoId) return pub;
  if (p.id === "youtube" && ctx.upload?.status === "uploaded" && ctx.upload.videoId) return { ...ctx.upload, platform: "youtube" };
  return undefined;
}

function historyRecord(ctx: RunContext, p: Publisher, postId: string, requested: PrivacyStatus, actual: ActualPrivacyStatus, at: string): UploadRecord {
  return {
    platform: p.id,
    runId: ctx.runId,
    videoId: postId,
    title: ctx.metadata?.title ?? ctx.script?.title ?? ctx.runId,
    publishedAt: at,
    privacyStatus: actual,
    requestedPrivacyStatus: requested,
    categoryId: ctx.metadata?.categoryId ?? "27",
    topicCategoryId: ctx.topic?.categoryId ?? "unknown",
  };
}

function forPlatform(records: readonly UploadRecord[], platform: PlatformId): UploadRecord[] {
  return records.filter((r) => recordPlatform(r) === platform);
}

function progressLogger(log: Logger, prefix: string): (done: number, total: number) => void {
  let lastDecile = -1;
  return (done, total) => {
    const decile = total > 0 ? Math.floor((done / total) * 10) : 10;
    if (decile === lastDecile) return;
    lastDecile = decile;
    log.info(`${prefix}Upload ${Math.min(100, decile * 10)}% (${(done / 1024 / 1024).toFixed(1)}/${(total / 1024 / 1024).toFixed(1)} MB)`);
  };
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------------------------
// One platform
// ---------------------------------------------------------------------------------------------

/** A previous attempt got a post id but failed before recording it: record it now, never re-publish. */
async function recoverJournaled(ctx: RunContext, p: Publisher, journal: PublishJournal & { videoId: string }, deps: PublishDeps, log: Logger): Promise<RunContext> {
  const history = forPlatform(await deps.readHistory(), p.id);
  const existing = history.find((r) => r.runId === ctx.runId || r.videoId === journal.videoId);
  const at = journal.uploadedAt ?? deps.now().toISOString();
  if (!existing) {
    await deps.appendHistory(historyRecord(ctx, p, journal.videoId, journal.requestedPrivacyStatus, "unknown", at));
    log.warn(`${p.texts.logPrefix}Recovered upload ${journal.videoId} from ${journalFile(p.id)} and recorded it in the history (privacy unknown)`);
  }
  return withPublication(ctx, uploaded(p, journal.videoId, journal.requestedPrivacyStatus, existing?.privacyStatus ?? "unknown", at));
}

async function performPublish(ctx: PublishableContext, p: Publisher, deps: PublishDeps, log: Logger): Promise<RunContext> {
  const prefix = p.texts.logPrefix;
  const requested = p.settings.requestedPrivacy;
  const history = forPlatform(await deps.readHistory(), p.id);
  const previous = history.find((r) => r.runId === ctx.runId);
  if (previous) {
    log.warn(`${prefix}Run ${ctx.runId} is already in the upload history as ${previous.videoId}; not uploading again`);
    return withPublication(ctx, uploaded(p, previous.videoId, previous.requestedPrivacyStatus, previous.privacyStatus, previous.publishedAt));
  }
  const cap = checkDailyCap(history, p.settings.maxPostsPerDay, deps.now());
  if (!cap.allowed) {
    const reason = `daily cap reached (${cap.count}/${cap.max} in 24 h; next slot ${cap.nextSlotAt ?? "unknown"})`;
    log.warn(`${prefix}Upload skipped: ${reason}. Upload later with: npm run stage -- 08-uploadYouTube --run ${ctx.runId}`);
    return withPublication(ctx, { platform: p.id, status: "skipped-cap", requestedPrivacyStatus: requested, reason });
  }

  const earlier = await readPublishJournal(ctx.runDir, p.id);
  let journal: PublishJournal = {
    runId: ctx.runId,
    platform: p.id,
    status: "pending",
    startedAt: earlier?.startedAt ?? deps.now().toISOString(),
    requestedPrivacyStatus: requested,
    ...(earlier?.sessionUri ? { sessionUri: earlier.sessionUri } : {}),
  };
  await writePublishJournal(ctx.runDir, p.id, journal);
  await deps.saveContext?.(withPublication(ctx, { platform: p.id, status: "pending", requestedPrivacyStatus: requested }));

  const connection = await p.connect();
  try {
    if (journal.sessionUri) log.warn(`${prefix}Resuming the upload session started at ${journal.startedAt} instead of uploading again`);
    log.info(`${prefix}Uploading "${ctx.metadata.title}" as ${requested} (${cap.count}/${cap.max} uploads in the last 24 h)`);
    let post: { id: string };
    try {
      post = await connection.publish(ctx.render.videoPath, p.buildPost(ctx), progressLogger(log, prefix), {
        sessionUri: journal.sessionUri,
        onSession: async (sessionUri) => {
          journal = { ...journal, sessionUri };
          await writePublishJournal(ctx.runDir, p.id, journal);
        },
        log: { info: (m) => log.info(`${prefix}${m}`), warn: (m) => log.warn(`${prefix}${m}`) },
      });
    } catch (error) {
      if (error instanceof UploadSessionLostError) {
        throw new Error(
          `${error.message}. The earlier upload may or may not have finished: check ${p.texts.managementConsole}, then delete ` +
            `${join(ctx.runDir, journalFile(p.id))} to allow a new upload.`,
        );
      }
      throw error;
    }
    const uploadedAt = deps.now().toISOString();
    // Record the post id before anything else can fail: a retry must never publish it again.
    journal = { ...journal, status: "uploaded", videoId: post.id, uploadedAt };
    await writePublishJournal(ctx.runDir, p.id, journal);
    await deps.saveContext?.(withPublication(ctx, uploaded(p, post.id, requested, "unknown", uploadedAt)));

    let actual: ActualPrivacyStatus = "unknown";
    try {
      actual = (await connection.verify(post.id)) ?? "unknown";
    } catch (error) {
      log.warn(`${prefix}Uploaded ${post.id} but could not read its privacy status: ${errorText(error)}`);
    }
    const { movedCorruptTo } = await deps.appendHistory(historyRecord(ctx, p, post.id, requested, actual, uploadedAt));
    if (movedCorruptTo) log.warn(`data/history.json was unreadable; moved to ${movedCorruptTo} and started a new history`);
    const pub = uploaded(p, post.id, requested, actual, uploadedAt);
    if (pub.lockedPrivate) log.warn(`${prefix}${p.texts.lockedPrivateWarning}: pediu "${requested}", ficou "${actual}". Vídeo ${pub.url}`);
    log.info(`${prefix}Uploaded: ${pub.url} (privacy: requested ${requested}, actual ${actual})`);
    return withPublication(ctx, pub);
  } finally {
    await connection.close();
  }
}

// ---------------------------------------------------------------------------------------------
// All platforms
// ---------------------------------------------------------------------------------------------

/**
 * Publishes the run on every enabled platform. Order of safety checks (per platform):
 * already published -> journal recovery (always, even if now disabled/blocked) -> enabled? ->
 * shared gates (any failure blocks ALL platforms) -> platform blockers -> lock { history dup check ->
 * daily cap -> publish -> record }. One platform's failure never stops the others; the stage fails at the
 * end (StageFailedError carrying every result) if any platform failed.
 */
export async function publishAll(
  input: RunContext,
  publishers: readonly Publisher[],
  shared: SharedGateSettings,
  deps: PublishDeps,
  log: Logger,
): Promise<RunContext> {
  let ctx = input;
  const failures: string[] = [];
  const fail = (p: Publisher, error: unknown): void => {
    const reason = errorText(error);
    failures.push(`${p.id}: ${reason}`);
    log.error(`${p.texts.logPrefix}Publishing failed: ${reason}`);
    ctx = withPublication(ctx, { ...ctx.publications?.[p.id], platform: p.id, status: "failed", requestedPrivacyStatus: p.settings.requestedPrivacy, reason });
  };
  const locked = <T>(fn: () => Promise<T>): Promise<T> => (deps.lock ? deps.lock(fn) : fn());

  const pending: Publisher[] = [];
  for (const p of publishers) {
    const existing = existingPublication(ctx, p);
    if (existing) {
      log.warn(`${p.texts.logPrefix}Already uploaded as ${existing.videoId}; not uploading again`);
      continue;
    }
    // A post that already reached the platform is always recorded first, whatever the gates say now.
    const journal = await readPublishJournal(ctx.runDir, p.id);
    if (journal?.videoId) {
      const snapshot = ctx;
      try {
        ctx = await locked(() => recoverJournaled(snapshot, p, { ...journal, videoId: journal.videoId as string }, deps, log));
      } catch (error) {
        fail(p, error);
      }
      continue;
    }
    if (!p.settings.enabled) {
      log.info(`${p.texts.logPrefix}Upload disabled (${p.texts.enabledSetting}=false in config): skipping 08-uploadYouTube`);
      ctx = withPublication(ctx, { platform: p.id, status: "skipped-disabled", requestedPrivacyStatus: p.settings.requestedPrivacy, reason: `${p.texts.enabledSetting}=false` });
      continue;
    }
    pending.push(p);
  }

  if (pending.length > 0) {
    const blockers = publishBlockers(ctx, shared);
    if (blockers.length > 0) throw new UploadBlockedError(`Refusing to upload ${ctx.runId}: ${blockers.join("; ")}`, ctx);
    const { metadata, render } = ctx;
    if (!metadata) throw new StageFailedError("08-uploadYouTube requires ctx.metadata (run 07-generateMetadata first)", ctx);
    if (!render?.videoPath || !existsSync(render.videoPath)) throw new StageFailedError("08-uploadYouTube requires a rendered final.mp4", ctx);

    for (const p of pending) {
      try {
        const own = p.blockers(ctx);
        if (own.length > 0) throw new Error(`blocked: ${own.join("; ")}`);
        const snapshot: PublishableContext = { ...ctx, metadata, render };
        ctx = await locked(async () => {
          const latest = await readPublishJournal(snapshot.runDir, p.id); // re-read under the lock
          if (latest?.videoId) return recoverJournaled(snapshot, p, { ...latest, videoId: latest.videoId }, deps, log);
          return performPublish(snapshot, p, deps, log);
        });
      } catch (error) {
        fail(p, error);
      }
    }
  }

  if (failures.length > 0) throw new StageFailedError(`Publishing failed on ${failures.join(" | ")}`, ctx);
  return ctx;
}
