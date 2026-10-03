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
}

export type StageName =
  | "01-pickTopic"
  | "02-generateScript"
  | "03-fetchFootage"
  | "04-synthesizeVoice"
  | "05-buildCaptions"
  | "06-renderVideo";

export type Stage = (ctx: RunContext) => Promise<RunContext>;
