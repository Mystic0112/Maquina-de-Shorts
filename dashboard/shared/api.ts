// JSON contract between the dashboard server and the React client.
import type {
  FactCheckSummary,
  LlmUsage,
  QualitySummary,
  RunRejection,
  StageName,
  UploadResult,
  VideoMetadata,
} from "../../src/orchestrator/types.js";

import type { CaptionSettings, ScriptSettings, VisualSettings, VoiceExtras } from "../../src/shared/settings.js";

export type { FactCheckSummary, LlmUsage, QualitySummary, RunRejection, StageName, UploadResult, VideoMetadata };
export type { CaptionSettings, ScriptSettings, VisualSettings, VoiceExtras };
export type ResolvedScript = Required<Omit<ScriptSettings, "cta">> & Pick<ScriptSettings, "cta">;

/** Execution order (see STAGES in src/orchestrator/runPipeline.ts). */
export const STAGE_NAMES: readonly StageName[] = [
  "01-pickTopic",
  "02-generateScript",
  "02b-factCheck",
  "03-fetchFootage",
  "04-synthesizeVoice",
  "05-buildCaptions",
  "05b-planEdits",
  "06-renderVideo",
  "07-generateMetadata",
  "08-uploadYouTube",
];

/** "02b-factCheck" -> "02b" */
export const stageCode = (stage: StageName): string => stage.split("-")[0] ?? stage;

/**
 * complete = render exists; partial = stopped on purpose (--until) or by a single-stage run;
 * rejected = a quality gate (fact-check, footage relevance) refused the run and the pipeline retried
 * with a new topic: a deliberate decision, not a crash.
 */
export type RunStatus = "complete" | "failed" | "running" | "interrupted" | "partial" | "rejected";
/** bypassed = the stage ran but intentionally did nothing (e.g. upload disabled or daily cap reached). */
export type StageStatus = "done" | "failed" | "running" | "interrupted" | "skipped" | "pending" | "bypassed";

export interface StageInfo {
  name: StageName;
  status: StageStatus;
  durationMs: number | null;
  startedAt: string | null;
  endedAt: string | null;
  /** Short pt-BR explanation for neutral states (e.g. "upload desligado"). */
  note?: string;
}

export interface ClipInfo {
  sceneIndex: number;
  kind: "video" | "image";
  source: string;
  sourceUrl: string;
  creator: string;
  license: string;
  durationSeconds: number;
  relevanceScore: number | null;
  relevanceReason: string | null;
}

export interface RunSummary {
  runId: string;
  createdAt: string;
  lastActivityAt: string;
  status: RunStatus;
  lastStageReached: StageName | null;
  failure: { stage: StageName; message: string; at: string } | null;
  hasContext: boolean;
  hasLog: boolean;
  /** format = narrative format drawn by 01-pickTopic ("lista", "mito-verdade"…); null on older runs. */
  topic: { categoryId: string; categoryLabel: string; format: string | null } | null;
  title: string | null;
  /** Hook/cover text shown on screen in the first seconds (Script.overlayText); null on older runs. */
  overlayText: string | null;
  /** Captions carry per-word emphasis marks (needed by the "keywords" highlight); false on older runs. */
  captionKeywords: boolean;
  sceneCount: number | null;
  clips: ClipInfo[];
  sources: Record<string, number>;
  licenses: Record<string, number>;
  avgRelevance: number | null;
  narrationMs: number | null;
  video: { path: string; exists: boolean; sizeBytes: number | null; durationSeconds: number } | null;
  /** When the video finished rendering (latest 06-renderVideo "done"); null unless complete. */
  completedAt: string | null;
  /** Wall time of the latest successful 06-renderVideo stage. */
  renderTimeMs: number | null;
  stages: StageInfo[];
  /** Served thumbnail of final.mp4 (generated lazily); null until it exists. */
  thumbUrl: string | null;
  /** Footage quality gate summary (context.quality), when the pipeline wrote one. */
  quality: QualitySummary | null;
  /** LLM calls/tokens of the run (context.llmUsage), when the pipeline wrote them. */
  llmUsage: LlmUsage | null;
  /** 02b-factCheck findings (originalScript dropped to keep the payload small). */
  factCheck: Omit<FactCheckSummary, "originalScript"> | null;
  metadata: VideoMetadata | null;
  upload: UploadResult | null;
  rejection: RunRejection | null;
}

export interface CategoryInfo {
  id: string;
  label: string;
}

/** Reference prices for the LLM cost ESTIMATE (configurable; never billing data). */
export interface LlmPricing {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  configured: boolean;
}

export interface VideoStats {
  views: number;
  likes: number | null;
  comments: number | null;
}

export interface ChannelStats {
  title: string | null;
  /** null when the channel hides its subscriber count. */
  subscribers: number | null;
  views: number;
  videoCount: number;
}

/** One line of data/metrics/snapshots.jsonl. */
export interface MetricsSnapshot {
  at: string;
  channel: ChannelStats | null;
  videos: Record<string, VideoStats>;
}

export interface YoutubeStatus {
  apiKeyConfigured: boolean;
  channelConfigured: boolean;
  trackedVideos: number;
  refreshIntervalMinutes: number;
  lastFetchAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  nextAutoRefreshAt: string | null;
  manualAvailableAt: string | null;
  snapshotCount: number;
  channel: ChannelStats | null;
}

export type RevenueResult =
  | { status: "not_connected"; message: string }
  | { status: "not_monetized"; message: string }
  | { status: "ok"; currency: string; periodStart: string; periodEnd: string; estimatedRevenue: number };

export interface Monetization {
  subscribers: { current: number | null; target: number };
  shortsViews: { target: number; windowDays: number; trackedViews: number | null; note: string };
}

export interface Overview {
  generatedAt: string;
  kpis: {
    videosGenerated: number;
    videosPublished: number;
    /** complete / (complete + failed + interrupted); null when nothing finished yet. */
    successRate: number | null;
    finishedRuns: number;
    failuresLast7d: number;
    totalViews: number | null;
    viewsLast7d: { value: number; since: string; partial: boolean } | null;
    subscribers: number | null;
  };
  generatedPerDay: { day: string; gerados: number; falhas: number }[];
  viewsPerDay: { day: string; views: number }[];
  subscribersOverTime: { at: string; subscribers: number }[];
  health: {
    lastSuccessAt: string | null;
    avgRenderMs: number | null;
    lastRun: { runId: string; status: RunStatus; at: string } | null;
  };
  history: { exists: boolean; count: number; errors: string[] };
  youtube: YoutubeStatus;
  revenue: RevenueResult;
  monetization: Monetization;
  /** Topic categories in config/topics.seed.json order (drives the fixed category colors). */
  categories: CategoryInfo[];
  /** Target video length from config/pipeline.config.json (video.minSeconds/maxSeconds). */
  targetSeconds: { min: number; max: number } | null;
  llmPricing: LlmPricing;
}

export interface VideoRow {
  key: string;
  runId: string | null;
  title: string;
  date: string;
  status: RunStatus | "published_only";
  videoDurationSeconds: number | null;
  localPath: string | null;
  /** Server URL that streams the local final.mp4, when it exists. */
  localUrl: string | null;
  thumbUrl: string | null;
  categoryId: string | null;
  metadata: VideoMetadata | null;
  upload: UploadResult | null;
  youtube: {
    videoId: string;
    url: string;
    privacyStatus: string;
    publishedAt: string;
    stats: VideoStats | null;
  } | null;
}

/* ---------- Configurações ---------- */
export interface FieldError {
  /** Dotted path into the edited document, e.g. "captions.maxFontPx" or "categories.0.prompts.1". */
  path: string;
  message: string;
}

export interface KeyStatus {
  name: string;
  label: string;
  /** Only whether it is set: secret values never leave the server. */
  configured: boolean;
}

export interface SettingsPayload {
  /** Content hash of the file on disk; sent back on save to detect concurrent edits. */
  version: string;
  /** The raw file (unknown keys included), the document the page edits. */
  config: Record<string, unknown>;
  valid: boolean;
  errors: FieldError[];
  resolved: {
    captions: Required<CaptionSettings>;
    visual: Required<VisualSettings>;
    script: ResolvedScript;
    voice: Required<VoiceExtras>;
  };
  defaults: {
    captions: Required<CaptionSettings>;
    visual: Required<VisualSettings>;
    script: ResolvedScript;
    voice: Required<VoiceExtras>;
  };
  /** Caption font id -> CSS font stack. */
  fonts: Record<string, string>;
  /** JSON Schema of PipelineConfigSchema (drives slider ranges and client-side validation). */
  schema: unknown;
  keys: KeyStatus[];
}

export interface TopicCategory {
  id: string;
  label: string;
  prompts: string[];
  [extra: string]: unknown;
}

export interface TopicsPayload {
  version: string;
  data: { categories: TopicCategory[]; [extra: string]: unknown };
  errors: FieldError[];
}

/** One entry of config/cuts.json (mirrors ChannelSchema in src/orchestrator/cuts/config.ts). */
export interface CutChannelDraft {
  id: string;
  name: string;
  enabled: boolean;
  blocked?: string;
  style?: "vlog" | "podcast";
  minSeconds?: number;
  maxSeconds?: number;
  authorization?: { url: string; date?: string; note?: string; conditions?: string[] };
  credit: string;
  maxVideosPerDay?: number;
  [extra: string]: unknown;
}

export interface CutsPayload {
  version: string;
  /** false = config/cuts.json does not exist yet; `data` comes from cuts.example.json and saving creates it. */
  exists: boolean;
  data: { channels: CutChannelDraft[]; [extra: string]: unknown };
  errors: FieldError[];
}

export interface ResolveChannelResponse {
  ok: boolean;
  message: string;
  id?: string;
  name?: string;
  url?: string;
}

export interface SaveResponse {
  ok: boolean;
  message: string;
  version?: string;
  backup?: string;
  errors?: FieldError[];
}

export interface VoiceInfo {
  name: string;
  locale: string;
  gender: string;
  friendlyName: string;
  personalities: string[];
}

export interface VoiceSampleResponse {
  ok: boolean;
  message: string;
  url?: string;
  cached?: boolean;
  /** Settings the installed synthesizer could not apply (e.g. pitch before --pitch existed). */
  ignored?: string[];
}

export interface PreviewResponse {
  status: "ok" | "unavailable" | "superseded" | "error";
  message?: string;
  url?: string;
  ms?: number;
  cached?: boolean;
  runId?: string;
}

export interface RefreshResponse {
  ok: boolean;
  message: string;
  youtube: YoutubeStatus;
}
