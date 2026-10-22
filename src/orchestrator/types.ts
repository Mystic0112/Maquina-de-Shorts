import type { Platform } from "../shared/platforms.js";

// Shared contract between stages. Each stage reads RunContext, fills its own section, and the
// orchestrator persists it to render_output/<runId>/context.json after every stage.

export interface TopicPick {
  categoryId: string;
  categoryLabel: string;
  seedPrompt: string;
  /** Narrative format drawn by 01-pickTopic so consecutive videos don't share one template (e.g. "lista", "mito-verdade"). */
  format?: string;
}

/** A stretch of a scene's narration that gets its own image (see lib/beats.ts). */
export interface SceneBeat {
  /** Literal substring of the scene narration, in narration order; the image switches when it starts being spoken. */
  phrase: string;
  /** English search naming exactly the concrete thing the phrase mentions. */
  footageQuery: string;
}

export interface ScriptScene {
  narration: string;
  footageQuery: string; // English search terms for stock footage (= beats[0].footageQuery when beats exist)
  /** 1-3 beats, narration order. Absent in older runs: the whole scene is one beat. */
  beats?: SceneBeat[];
}

export interface Script {
  title: string;
  hook: string;
  scenes: ScriptScene[];
  cta: string;
  language: string; // e.g. "pt-BR"
  /** 3-5 word on-screen hook/cover text shown in the first seconds (fact-checked like the title). */
  overlayText?: string;
  /** Specific (may name a historical place/mission/artwork/deceased figure) query for the opening shot. */
  hookFootageQuery?: string;
}

export interface FootageClip {
  sceneIndex: number;
  path: string; // absolute path to the downloaded file
  kind: "video" | "image";
  durationSeconds: number;
  width: number;
  height: number;
  source: string;
  sourceUrl: string;
  creator: string;
  license: string;
  relevanceScore?: number; // 0-10 from the visual relevance gate (03-fetchFootage), when enabled
  relevanceReason?: string;
  /** Reviewer said the clip fits the narration (verdict.matches). A scene only "passes" with matches + score. */
  relevanceMatches?: boolean;
  borrowedFromScene?: number; // set when this scene had no usable clip and reuses another scene's clip
  /** Beat of the scene this clip was searched and reviewed for (absent: whole scene / retry / borrowed clip). */
  beatIndex?: number;
  /** Reviewer said a human face (photo, statue or painting) is the main subject; only such clips get a zoom. */
  hasFace?: boolean;
  /** License deed URL from the adapter (e.g. https://creativecommons.org/licenses/by/4.0/), when known. */
  licenseUrl?: string;
  /** Author profile URL (e.g. Commons user page), when the adapter knows it. */
  creatorUrl?: string;
}

export interface WordTiming {
  word: string;
  startMs: number;
  endMs: number;
  /** Content word worth highlighting (noun, number, key verb); set by 05-buildCaptions. Absent = treat as emphasized. */
  emphasis?: boolean;
}

export interface Narration {
  audioPath: string; // absolute path to narration.wav (Gemini TTS) or narration.mp3 (legacy edge-tts)
  durationMs: number;
  words: WordTiming[];
}

export interface CaptionCue {
  text: string; // a short group of words shown together
  startMs: number;
  endMs: number;
  words: WordTiming[]; // for per-word highlight
}

export interface SceneTiming {
  sceneIndex: number;
  startMs: number;
  endMs: number;
}

export interface Captions {
  cues: CaptionCue[];
  scenes: SceneTiming[];
}

export type EditAssetKind = "sticker" | "lottie" | "sfx" | "image";
export type EditPlacement = "top" | "side-left" | "side-right" | "corner";
export type EditIntensity = "sutil" | "normal" | "forte";

/** Library asset (assets/memes/inventory.json entry) resolved to an absolute file path by 05b-planEdits. */
export interface EditAsset {
  id: string;
  kind: EditAssetKind;
  path: string;
  source: string;
  sourceUrl: string;
  author?: string;
  license: string;
  licenseUrl?: string;
  /** CC BY / CC BY-SA: credited in the description like CC BY footage. */
  attributionRequired: boolean;
  durationMs?: number;
  width?: number;
  height?: number;
}

/** One sticker/sound placed at a narration instant (validated by lib/editPlan.ts). */
export interface EditCue {
  atMs: number;
  assetId: string;
  kind: EditAssetKind;
  placement: EditPlacement;
  durationMs: number;
  intensity: EditIntensity;
  /** Model's one-line reason (pt-BR), for the log/dashboard. */
  why: string;
}

/** Written by 05b-planEdits (only when editing.enabled and the library has assets). */
export interface EditPlan {
  cues: EditCue[];
  /** Assets referenced by `cues` (credits + render need license/path without re-reading the library). */
  assets: EditAsset[];
  /** editing.sfxVolume at planning time. */
  sfxVolume: number;
}

export interface RenderResult {
  videoPath: string;
  durationSeconds: number;
  width: number;
  height: number;
}

/**
 * Run-level footage quality gate (written by 03-fetchFootage, attempt fields by runPipeline).
 * A scene "passes" when it has its own (not borrowed) clip scoring >= minScore.
 */
export interface QualitySummary {
  passingScenes: number;
  totalScenes: number;
  passingRatio: number; // passingScenes / totalScenes
  minPassingSceneRatio: number; // threshold from config footage.minPassingSceneRatio
  minScore: number; // per-clip pass threshold from config footage.relevance.minScore
  /** pass = may render; fail = blocked before render; skipped = relevance gate disabled. */
  verdict: "pass" | "fail" | "skipped";
  reason?: string;
  /** 1-based attempt number within one pipeline invocation (each attempt has its own run dir). */
  attempt?: number;
  maxAttempts?: number;
  /** runIds of earlier failed attempts of the same invocation, oldest first. */
  previousRunIds?: string[];
  /** runId of the attempt that replaced this one after a "fail" verdict. */
  retriedAs?: string;
  /** sha256 of script + selected footage this verdict was computed on (see lib/contentHash.ts). */
  contentHash?: string;
}

/** Topics/titles a retry attempt must steer away from (set by runPipeline on quality-gate retries). */
export interface TopicAvoidance {
  topics: { categoryId: string; seedPrompt: string }[];
  titles: string[];
}

export interface LlmUsageTotals {
  calls: number;
  inputTokens: number; // prompt tokens incl. images (and cached input, Anthropic)
  outputTokens: number; // response tokens incl. thinking/reasoning tokens
  thinkingTokens?: number; // part of outputTokens, when the provider reports it
  groundedCalls?: number; // calls with web search/grounding enabled (priced per request on top of tokens)
}

export interface LlmUsageByModel extends LlmUsageTotals {
  provider: string; // "gemini" | "anthropic"
  model: string;
}

/** Aggregated LLM usage of a run, for cost estimates. Calls = provider responses (retries count). */
export interface LlmUsage extends LlmUsageTotals {
  byModel: LlmUsageByModel[];
  byStage: Partial<Record<StageName, LlmUsageTotals>>;
}

export type FactCheckVerdict = "supported" | "unsupported" | "misleading";

export interface FactCheckClaim {
  /** Claim as written in the script (pt-BR). */
  claim: string;
  verdict: FactCheckVerdict;
  /** Accurate statement (pt-BR) for unsupported/misleading claims. */
  correction?: string;
  /** 1-based fact-check round that produced this verdict (round 2 re-checks a corrected script). */
  round: number;
}

/**
 * Written by 02b-factCheck. pass = no changes needed; corrected = script rewritten and re-verified;
 * fail = could not be made accurate (the run is rejected and retried with a new topic);
 * skipped = disabled by config script.factCheck=false.
 */
export interface FactCheckSummary {
  verdict: "pass" | "corrected" | "fail" | "skipped";
  rounds: number;
  claimsChecked: number; // claims reviewed in round 1
  claims: FactCheckClaim[];
  /** Human-readable list of edits applied to the script (pt-BR). */
  corrections: string[];
  titleBefore?: string;
  titleAfter?: string;
  /** Web sources the grounded check consulted (Gemini: redirect links + domain as title). */
  sources: { uri: string; title?: string }[];
  searchQueries: string[];
  reason?: string;
  /** Script as written by 02-generateScript, kept when the fact-check changed it. */
  originalScript?: Script;
  /** sha256 of the script this verdict applies to (the checked/corrected script; see lib/contentHash.ts). */
  scriptHash?: string;
}

/** Written by 07-generateMetadata; already validated against YouTube limits. */
export interface VideoMetadata {
  title: string; // <= 100 chars; the fact-checked script title (#Shorts goes in the description hashtags)
  description: string; // <= 5000 chars, includes image credits
  tags: string[]; // <= 500 chars as YouTube counts them
  categoryId: string;
  defaultLanguage: string;
  defaultAudioLanguage: string;
}

export type YouTubePrivacyStatus = "public" | "unlisted" | "private";

/** Written by 08-uploadYouTube for YouTube (kept for the dashboard; see also RunContext.publications). */
export interface UploadResult {
  /**
   * uploaded; pending (an upload was started and may still be resumable: see upload.youtube.journal.json,
   * formerly upload.journal.json, in the run dir); skipped-disabled (upload.enabled=false); skipped-cap
   * (daily limit reached).
   */
  status: "uploaded" | "pending" | "skipped-disabled" | "skipped-cap";
  videoId?: string;
  url?: string;
  requestedPrivacyStatus: YouTubePrivacyStatus;
  /** What YouTube actually applied (videos.list after upload); "unknown" when that lookup failed. */
  privacyStatus?: YouTubePrivacyStatus | "unknown";
  /** True when YouTube forced "private" although public/unlisted was requested (unaudited API project). */
  lockedPrivate?: boolean;
  uploadedAt?: string;
  reason?: string;
}

/** Platforms a video can be published to (one publisher each, see src/orchestrator/publishers/). */
export type PlatformId = Platform;

/**
 * Per-platform outcome of 08-uploadYouTube (the publishing stage). Same fields as UploadResult, plus
 * "failed" (this platform's publish threw; the others still ran) with the error in `reason`.
 */
export interface PublicationResult extends Omit<UploadResult, "status"> {
  platform: PlatformId;
  status: UploadResult["status"] | "failed";
}

/** A stage rejected the run on quality grounds (e.g. fact-check); runPipeline retries with a new topic. */
export interface RunRejection {
  stage: StageName;
  reason: string;
  attempt?: number;
  maxAttempts?: number;
  previousRunIds?: string[];
  retriedAs?: string;
}

export interface RunContext {
  runId: string;
  runDir: string; // absolute path to render_output/<runId>
  createdAt: string;
  topic?: TopicPick;
  script?: Script;
  footage?: FootageClip[];
  narration?: Narration;
  captions?: Captions;
  edits?: EditPlan;
  render?: RenderResult;
  quality?: QualitySummary;
  llmUsage?: LlmUsage;
  avoid?: TopicAvoidance;
  factCheck?: FactCheckSummary;
  metadata?: VideoMetadata;
  /** YouTube result (dashboard compatibility). */
  upload?: UploadResult;
  /** Result per platform; YouTube's entry mirrors `upload`. */
  publications?: Partial<Record<PlatformId, PublicationResult>>;
  rejection?: RunRejection;
}

/** Execution order: 01, 02, 02b, 03, 04, 05, 05b, 06, 07, 08 (see STAGES in runPipeline.ts). */
export type StageName =
  | "01-pickTopic"
  | "02-generateScript"
  | "02b-factCheck"
  | "03-fetchFootage"
  | "04-synthesizeVoice"
  | "05-buildCaptions"
  | "05b-planEdits"
  | "06-renderVideo"
  | "07-generateMetadata"
  | "08-uploadYouTube";

export type Stage = (ctx: RunContext) => Promise<RunContext>;
