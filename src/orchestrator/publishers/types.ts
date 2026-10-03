import type { PrivacyStatus } from "../../shared/history.js";
import type { PlatformId, RunContext, VideoMetadata } from "../types.js";

/**
 * A publisher posts the rendered video to one platform. The shared runner (runner.ts) owns everything
 * that must behave the same everywhere: publishability gates, the per-platform journal, the cross-process
 * lock around "read history -> daily cap -> publish -> append history", duplicate detection and recovery.
 * A publisher only knows its platform: settings, extra blockers, the post payload and the API calls.
 *
 * Adding a platform = one file implementing this interface + one line in publishers/index.ts.
 */

/** Context guaranteed to the publish path (gates passed, metadata and video present). */
export type PublishableContext = RunContext & { metadata: VideoMetadata; render: NonNullable<RunContext["render"]> };

export interface PublisherSettings {
  enabled: boolean;
  /** Rolling-24h cap for this platform (counted only over this platform's history records). */
  maxPostsPerDay: number;
  /** Visibility requested for new posts. */
  requestedPrivacy: PrivacyStatus;
}

export interface SessionHooks {
  /** Resume this upload session (from the journal) instead of starting a new upload. */
  sessionUri?: string;
  /** Persist a new session id/URI before any byte is sent. */
  onSession: (sessionUri: string) => Promise<void>;
}

/** An authenticated connection, opened only when something is actually published. */
export interface PublisherConnection {
  publish(
    filePath: string,
    payload: unknown,
    onProgress: (done: number, total: number) => void,
    session: SessionHooks,
  ): Promise<{ id: string }>;
  /** Visibility the platform actually applied (undefined when it cannot tell). */
  verify(postId: string): Promise<PrivacyStatus | undefined>;
  close(): Promise<void>;
}

/** Texts that differ per platform (YouTube keeps the exact log lines the dashboard already knows). */
export interface PublisherTexts {
  /** Prefix for every log line of this publisher ("" for YouTube, e.g. "[instagram] " for others). */
  logPrefix: string;
  /** Config path that enables it, shown when disabled (e.g. "upload.enabled"). */
  enabledSetting: string;
  /** Where to check a post manually when an upload session is lost (e.g. "YouTube Studio"). */
  managementConsole: string;
  /** Warning when the platform forced the post private although public/unlisted was requested. */
  lockedPrivateWarning: string;
}

export interface Publisher {
  readonly id: PlatformId;
  readonly settings: PublisherSettings;
  readonly texts: PublisherTexts;
  /** Platform-specific reasons not to publish this run (shared gates are checked by the runner). */
  blockers(ctx: RunContext): string[];
  /** Platform payload built from ctx.metadata (title/description/tags, privacy, flags...). */
  buildPost(ctx: PublishableContext): unknown;
  connect(): Promise<PublisherConnection>;
  postUrl(postId: string): string;
}
