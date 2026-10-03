// Shared contract between stages. Each stage reads RunContext, fills its own section, and the
// orchestrator persists it to render_output/<runId>/context.json after every stage.

export interface TopicPick {
  categoryId: string;
  categoryLabel: string;
  seedPrompt: string;
}

export interface ScriptScene {
  narration: string;
  footageQuery: string; // English search terms for stock footage
}

export interface Script {
  title: string;
  hook: string;
  scenes: ScriptScene[];
  cta: string;
  language: string; // e.g. "pt-BR"
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
  borrowedFromScene?: number; // set when this scene had no usable clip and reuses another scene's clip
}

export interface WordTiming {
  word: string;
  startMs: number;
  endMs: number;
}

export interface Narration {
  audioPath: string; // absolute path to narration.mp3
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
}

/** Written by 07-generateMetadata; already validated against YouTube limits. */
export interface VideoMetadata {
  title: string; // <= 100 chars, includes #Shorts
  description: string; // <= 5000 chars, includes image credits
  tags: string[]; // <= 500 chars as YouTube counts them
  categoryId: string;
  defaultLanguage: string;
  defaultAudioLanguage: string;
}

export type YouTubePrivacyStatus = "public" | "unlisted" | "private";

/** Written by 08-uploadYouTube. */
export interface UploadResult {
  /** uploaded; skipped-disabled (upload.enabled=false); skipped-cap (daily limit reached). */
  status: "uploaded" | "skipped-disabled" | "skipped-cap";
  videoId?: string;
  url?: string;
  requestedPrivacyStatus: YouTubePrivacyStatus;
  /** What YouTube actually applied (videos.list after upload). */
  privacyStatus?: YouTubePrivacyStatus;
  /** True when YouTube forced "private" although public/unlisted was requested (unaudited API project). */
  lockedPrivate?: boolean;
  uploadedAt?: string;
  reason?: string;
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
  render?: RenderResult;
  quality?: QualitySummary;
  llmUsage?: LlmUsage;
  avoid?: TopicAvoidance;
  factCheck?: FactCheckSummary;
  metadata?: VideoMetadata;
  upload?: UploadResult;
  rejection?: RunRejection;
}

/** Execution order: 01, 02, 02b, 03, 04, 05, 06, 07, 08 (see STAGES in runPipeline.ts). */
export type StageName =
  | "01-pickTopic"
  | "02-generateScript"
  | "02b-factCheck"
  | "03-fetchFootage"
  | "04-synthesizeVoice"
  | "05-buildCaptions"
  | "06-renderVideo"
  | "07-generateMetadata"
  | "08-uploadYouTube";

export type Stage = (ctx: RunContext) => Promise<RunContext>;
