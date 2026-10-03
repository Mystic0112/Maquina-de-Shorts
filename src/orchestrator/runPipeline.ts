import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig, paths } from "./lib/config.js";
import { drainLlmUsage, mergeLlmUsage } from "./lib/llmClient.js";
import { describeError, getLogger } from "./lib/logger.js";
import { redactSecrets } from "./lib/redact.js";
import { pruneRuns, resolveRetention } from "./lib/retention.js";
import { RunRejectedError, StageFailedError } from "./lib/rejection.js";
import { createRunContext, loadRunContext, readContextFile, saveRunContext } from "./lib/runContext.js";
import type { RunContext, Stage, StageName, TopicAvoidance } from "./types.js";

export interface StageDefinition {
  name: StageName;
  /** True when this stage's output section is already present in the context. */
  isDone(ctx: RunContext): boolean;
  /** Lazy import so a missing/broken later stage never blocks running earlier ones. */
  load(): Promise<Stage>;
}

export const STAGES: readonly StageDefinition[] = [
  { name: "01-pickTopic", isDone: (c) => !!c.topic, load: async () => (await import("./stages/01-pickTopic.js")).run },
  {
    name: "02-generateScript",
    isDone: (c) => !!c.script,
    load: async () => (await import("./stages/02-generateScript.js")).run,
  },
  {
    name: "02b-factCheck",
    // A failed check is never "done". Runs with footage but no factCheck predate this stage: never
    // rewrite their script (they can't be published anyway: 08 requires a fact-check verdict).
    isDone: (c) => (c.factCheck ? c.factCheck.verdict !== "fail" : (c.footage?.length ?? 0) > 0),
    load: async () => (await import("./stages/02b-factCheck.js")).run,
  },
  {
    name: "03-fetchFootage",
    isDone: (c) => (c.footage?.length ?? 0) > 0,
    load: async () => (await import("./stages/03-fetchFootage.js")).run,
  },
  {
    name: "04-synthesizeVoice",
    isDone: (c) => !!c.narration,
    load: async () => (await import("./stages/04-synthesizeVoice.js")).run,
  },
  {
    name: "05-buildCaptions",
    isDone: (c) => !!c.captions,
    load: async () => (await import("./stages/05-buildCaptions.js")).run,
  },
  {
    name: "06-renderVideo",
    isDone: (c) => !!c.render,
    load: async () => (await import("./stages/06-renderVideo.js")).run,
  },
  {
    name: "07-generateMetadata",
    isDone: (c) => !!c.metadata,
    load: async () => (await import("./stages/07-generateMetadata.js")).run,
  },
  {
    name: "08-uploadYouTube",
    // Skipped uploads (disabled / daily cap) are retried on resume; a finished upload never repeats.
    isDone: (c) => c.upload?.status === "uploaded",
    load: async () => (await import("./stages/08-uploadYouTube.js")).run,
  },
];

/** Accepts the full name ("05-buildCaptions"), the number ("05" / "5") or the suffix ("buildCaptions"). */
export function findStage(query: string): StageDefinition {
  const q = query.trim().toLowerCase();
  const stage = STAGES.find((s) => {
    const [num = "", suffix = ""] = s.name.toLowerCase().split("-");
    return s.name.toLowerCase() === q || num === q.padStart(2, "0") || suffix === q;
  });
  if (!stage) throw new Error(`Unknown stage "${query}". Valid: ${STAGES.map((s) => s.name).join(", ")}`);
  return stage;
}

/** Folds the LLM calls made since the last drain into ctx.llmUsage under this stage. */
function withStageUsage(ctx: RunContext, stage: StageName): RunContext {
  const llmUsage = mergeLlmUsage(ctx.llmUsage, stage, drainLlmUsage());
  return llmUsage ? { ...ctx, llmUsage } : ctx;
}

export class RejectedRunError extends Error {}

/** A rejected run (fact-check / quality) must never be continued: it would publish what was rejected. */
export function assertNotRejected(ctx: RunContext): void {
  if (ctx.rejection) {
    throw new RejectedRunError(
      `Run ${ctx.runId} was rejected by ${ctx.rejection.stage} (${ctx.rejection.reason})` +
        `${ctx.rejection.retriedAs ? ` and retried as ${ctx.rejection.retriedAs}` : ""}; it cannot be resumed. Start a new run.`,
    );
  }
}

/** Runs one stage, logs its timing and LLM usage, and persists the context it returns. */
export async function executeStage(stage: StageDefinition, ctx: RunContext): Promise<RunContext> {
  assertNotRejected(ctx);
  const log = getLogger(ctx.runId);
  const started = performance.now();
  log.info(`>> ${stage.name} started`);
  drainLlmUsage(); // usage recorded outside any stage is not attributable to this run
  try {
    const run = await stage.load();
    const next = withStageUsage(await run(ctx), stage.name);
    await saveRunContext(next);
    const usage = next.llmUsage?.byStage[stage.name];
    const usageNote = usage ? `, LLM ${usage.calls} call(s) ${usage.inputTokens} in / ${usage.outputTokens} out tokens` : "";
    log.info(`<< ${stage.name} done in ${formatMs(performance.now() - started)}${usageNote}`);
    return next;
  } catch (error) {
    log.error(`xx ${stage.name} failed after ${formatMs(performance.now() - started)}: ${describeError(error)}`);
    if (error instanceof RunRejectedError) {
      // Persist the stage's findings (e.g. the fact-check summary) together with its LLM usage.
      const rejected = withStageUsage(error.ctx, stage.name);
      await saveRunContext(rejected).catch(() => undefined);
      throw new RunRejectedError(error.message, rejected);
    }
    // Partial results (e.g. one platform published, another failed) are kept; otherwise the input context.
    const keep = error instanceof StageFailedError ? error.ctx : ctx;
    await saveRunContext(withStageUsage(keep, stage.name)).catch(() => undefined);
    throw error;
  }
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export interface PipelineOptions {
  resume?: string;
  until?: string;
  fixture?: string;
}

export async function prepareContext(options: PipelineOptions): Promise<RunContext> {
  if (options.resume && options.fixture) throw new Error("Use either --resume or --fixture, not both");
  if (options.resume) return loadRunContext(options.resume);
  const fresh = await createRunContext();
  if (!options.fixture) return fresh;
  const ctx: RunContext = { ...fixtureContent(await readContextFile(resolveUserPath(options.fixture))), runId: fresh.runId, runDir: fresh.runDir, createdAt: fresh.createdAt };
  await saveRunContext(ctx);
  return ctx;
}

/**
 * What a fixture contributes to a new run: content only. Verdicts, the rendered video and anything about
 * publishing are dropped, so a fixture made from an uploaded run can never re-upload its final.mp4 and
 * every verdict is recomputed for the new run.
 */
export function fixtureContent(fixture: RunContext): Omit<RunContext, "runId" | "runDir" | "createdAt"> {
  const {
    runId: _runId, runDir: _runDir, createdAt: _createdAt,
    render: _render, metadata: _metadata, upload: _upload, quality: _quality, factCheck: _factCheck,
    rejection: _rejection, llmUsage: _llmUsage,
    ...content
  } = fixture;
  return content;
}

/** Relative paths are tried against the cwd first, then the project root. */
export function resolveUserPath(input: string): string {
  const fromCwd = resolve(process.cwd(), input);
  if (existsSync(fromCwd)) return fromCwd;
  const fromRoot = paths.fromRoot(input);
  if (existsSync(fromRoot)) return fromRoot;
  throw new Error(`File not found: ${input}`);
}

// ---------------------------------------------------------------------------------------------
// Quality gate retry loop
// ---------------------------------------------------------------------------------------------

/** Exit code when every attempt failed the footage quality gate (no publishable video). */
export const EXIT_QUALITY_GATE = 3;

export class QualityGateError extends Error {
  constructor(
    message: string,
    readonly runIds: readonly string[],
  ) {
    super(message);
    this.name = "QualityGateError";
  }
}

const QUALITY_GATED_STAGE: StageName = "03-fetchFootage";

interface AttemptInfo {
  attempt: number;
  maxAttempts: number;
  previousRunIds: string[];
}

type AttemptResult = { ok: true; ctx: RunContext } | { ok: false; ctx: RunContext };

/**
 * Runs stages up to untilIndex. The attempt fails (-> retry with a new topic) when a stage rejects the
 * run (RunRejectedError, e.g. fact-check) or right after 03 when its footage quality verdict is "fail".
 */
async function runAttempt(ctx: RunContext, untilIndex: number, info: AttemptInfo): Promise<AttemptResult> {
  assertNotRejected(ctx);
  const log = getLogger(ctx.runId);
  for (const stage of STAGES.slice(0, untilIndex + 1)) {
    if (stage.isDone(ctx)) log.info(`-- ${stage.name} skipped (output already present)`);
    else {
      try {
        ctx = await executeStage(stage, ctx);
      } catch (error) {
        if (!(error instanceof RunRejectedError)) throw error;
        const rejected: RunContext = { ...error.ctx, rejection: { stage: stage.name, reason: error.message, ...info } };
        await saveRunContext(rejected);
        return { ok: false, ctx: rejected };
      }
    }
    if (stage.name !== QUALITY_GATED_STAGE || !ctx.quality) continue;
    ctx = { ...ctx, quality: { ...ctx.quality, ...info } };
    await saveRunContext(ctx);
    if (ctx.quality?.verdict === "fail") return { ok: false, ctx };
  }
  return { ok: true, ctx };
}

/** Pure: what the next attempt must avoid (accumulates across attempts). */
export function nextAvoidance(failed: RunContext): TopicAvoidance {
  const prev = failed.avoid ?? { topics: [], titles: [] };
  const topic = failed.topic ? [{ categoryId: failed.topic.categoryId, seedPrompt: failed.topic.seedPrompt }] : [];
  const title = failed.script ? [failed.script.title] : [];
  return { topics: [...prev.topics, ...topic], titles: [...prev.titles, ...title] };
}

/** Fresh run dir for the next attempt; the failed run keeps its own context.json and log. */
async function startRetryAttempt(failed: RunContext): Promise<RunContext> {
  const next: RunContext = { ...(await createRunContext()), avoid: nextAvoidance(failed) };
  await saveRunContext(next);
  await saveRunContext({
    ...failed,
    ...(failed.rejection ? { rejection: { ...failed.rejection, retriedAs: next.runId } } : {}),
    ...(failed.quality?.verdict === "fail" ? { quality: { ...failed.quality, retriedAs: next.runId } } : {}),
  });
  return next;
}

export function maxAttemptsFromConfig(): number {
  return 1 + (loadConfig().pipeline?.maxScriptAttempts ?? 2);
}

/** Disk retention (config.storage) at pipeline start; never fails the run. */
async function pruneOldRuns(ctx: RunContext): Promise<void> {
  const log = getLogger(ctx.runId);
  try {
    const summary = await pruneRuns(resolveRetention(loadConfig().storage), { exclude: [ctx.runId] });
    if (summary.deletedRuns.length || summary.trimmedRuns.length) {
      log.info(`Retention: deleted ${summary.deletedRuns.length} old failed run(s), trimmed ${summary.trimmedRuns.length} uploaded run(s)`);
    }
    for (const e of summary.errors) log.warn(`Retention: ${e}`);
  } catch (error) {
    log.warn(`Retention skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function runPipeline(options: PipelineOptions): Promise<RunContext> {
  const untilIndex = options.until ? STAGES.indexOf(findStage(options.until)) : STAGES.length - 1;
  const maxAttempts = maxAttemptsFromConfig();
  const started = performance.now();
  const mode = options.resume ? "resume" : options.fixture ? `fixture ${options.fixture}` : "new run";
  let ctx = await prepareContext(options);
  await pruneOldRuns(ctx);
  const previousRunIds: string[] = [];
  for (let attempt = 1; ; attempt++) {
    const log = getLogger(ctx.runId);
    const attemptNote = attempt > 1 ? `attempt ${attempt}/${maxAttempts} after ${previousRunIds.join(", ")}` : mode;
    log.info(`Run ${ctx.runId} (${attemptNote}) -> ${ctx.runDir}`);
    const result = await runAttempt(ctx, untilIndex, { attempt, maxAttempts, previousRunIds: [...previousRunIds] });
    if (result.ok) {
      const total = formatMs(performance.now() - started);
      log.info(`Run ${result.ctx.runId} finished through ${STAGES[untilIndex]?.name} in ${total} (attempt ${attempt})`);
      return result.ctx;
    }
    const reason = result.ctx.rejection?.reason ?? result.ctx.quality?.reason ?? "quality gate failed";
    previousRunIds.push(result.ctx.runId);
    if (attempt >= maxAttempts) {
      const message = `QUALITY GATE: no publishable video after ${attempt} attempt(s) (${previousRunIds.join(", ")}); last: ${reason}`;
      log.error(message);
      throw new QualityGateError(message, previousRunIds);
    }
    ctx = await startRetryAttempt(result.ctx);
    log.warn(`QUALITY GATE failed for ${result.ctx.runId}: ${reason}. Retrying with a new topic as ${ctx.runId}`);
  }
}

function parseCliOptions(argv: string[]): PipelineOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      resume: { type: "string" },
      until: { type: "string" },
      fixture: { type: "string" },
    },
    strict: true,
  });
  return { resume: values.resume, until: values.until, fixture: values.fixture };
}

async function main(): Promise<void> {
  try {
    await runPipeline(parseCliOptions(process.argv.slice(2)));
  } catch (error) {
    console.error(`Pipeline failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    process.exitCode = error instanceof QualityGateError ? EXIT_QUALITY_GATE : 1;
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const normalize = (p: string): string => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  return normalize(entry) === normalize(fileURLToPath(import.meta.url));
}

if (isEntryPoint()) await main();
