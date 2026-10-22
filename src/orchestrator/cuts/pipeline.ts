/**
 * Cuts flow for one video: channel gate -> download -> transcript -> LLM selection -> meaning/title review ->
 * jump-cut plan -> render -> one run folder per clip (render_output/<runId>/final.mp4 + context.json).
 * Stages 07/08 are NOT run.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../lib/config.js";
import type { Logger } from "../lib/logger.js";
import { runDirFor } from "../lib/runContext.js";
import { assertChannelAuthorized, clipRangeFor, type CutChannel, type CutsConfig, type Framing } from "./config.js";
import { buildCutRunContext, FINAL_FILE, newCutRunId, saveCutContext } from "./context.js";
import { downloadSource, LoginRequiredError, sourceDir, videoUrl } from "./download.js";
import { markProcessed, PROCESSED_FILE } from "./feed.js";
import { keptSeconds, planKeep } from "./jumpcut.js";
import { renderClips, wordsInWindow } from "./render.js";
import { selectClips, transcriptSlice, verifyPicks, type ClipPick } from "./select.js";
import { loadTranscript, transcribeVideo, type Transcript } from "./transcribe.js";
import type { CutRunContext } from "./types.js";

export interface ProcessOptions {
  framing?: Framing;
  clips?: number;
  /** Dev mode: use this mp4 instead of downloading. */
  source?: string;
  /** Dev mode: use this transcript.json instead of running Whisper. */
  transcript?: string;
  videoTitle?: string;
  /** Dev mode: skip the journal write. */
  noJournal?: boolean;
}

export interface StepTiming {
  step: string;
  seconds: number;
}

export interface ProcessResult {
  runs: CutRunContext[];
  timings: StepTiming[];
}

async function timed<T>(timings: StepTiming[], step: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    timings.push({ step, seconds: Number(((Date.now() - started) / 1000).toFixed(1)) });
  }
}

export async function processVideo(
  channel: CutChannel,
  videoId: string,
  config: CutsConfig,
  log: Logger,
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  assertChannelAuthorized(channel);
  const timings: StepTiming[] = [];
  const framing = options.framing ?? config.clip.framing;
  const clipSettings = { ...clipRangeFor(channel, config), perVideo: options.clips ?? config.clip.perVideo };
  const dir = sourceDir(channel.id, videoId);
  await mkdir(dir, { recursive: true });

  const source = await timed(timings, "download", async () => {
    if (options.source) return { path: options.source, title: options.videoTitle ?? videoId };
    return downloadSource(channel.id, videoId, config.download, (m) => log.info(m));
  });
  const transcript: Transcript = await timed(timings, "transcribe", () =>
    options.transcript ? loadTranscript(options.transcript) : transcribeVideo(source.path, join(dir, "transcript.json"), (m) => log.info(m)),
  );
  const proposed = await timed(timings, "select", () =>
    selectClips({ channelName: channel.name, videoTitle: source.title, transcript, clip: clipSettings, style: channel.style }),
  );
  proposed.forEach((p, i) => log.info(`clip ${i + 1}: ${p.start.toFixed(1)}-${p.end.toFixed(1)} s "${p.title}" (${p.reason})`));
  const review = await timed(timings, "verify", () => verifyPicks(proposed, transcript));
  review.rejected.forEach(({ pick, verdict }) => log.warn(`dropped "${pick.title}": ${verdict?.problem || "no verdict from the reviewer"}`));
  const picks = review.approved;
  if (picks.length === 0) {
    log.warn("every proposed clip failed the meaning/title review; nothing rendered");
    return { runs: [], timings };
  }

  const runIds = picks.map((_, i) => newCutRunId(i));
  const jobs = picks.map((p, i) => {
    const keep = planKeep(transcript.words, transcript.loudness, p.start, p.end);
    log.info(`clip "${p.title}": ${keep.length} piece(s), ${keptSeconds(keep)} of ${(p.end - p.start).toFixed(1)} s kept`);
    return { start: p.start, end: p.end, keep, out: join(runDirFor(runIds[i] as string), FINAL_FILE), words: wordsInWindow(transcript.words, p.start, p.end) };
  });
  const rendered = await timed(timings, "render", () =>
    renderClips({ source: source.path, framing, credit: channel.credit, captions: config.clip.captions, jobs }, (m) => log.info(m)),
  );
  rendered.clips.forEach((c, i) => log.info(`clip ${i + 1}: ${c.frames} frames in ${c.seconds} s (faces ${c.facesSeen}, switches ${c.speakerSwitches}, face coverage ${Math.round(c.faceCoverage * 100)}%)`));

  const runs = await timed(timings, "context", () => Promise.all(picks.map((p, i) => writeRun(runIds[i] as string, channel, videoId, source.title, p, transcript, framing, jobs[i]?.out as string, keptSeconds(jobs[i]?.keep ?? [])))));
  if (!options.noJournal) {
    await markProcessed({ channelId: channel.id, videoId, status: "done", runIds: runs.map((r) => r.runId) });
  }
  log.info(`${runs.length} cut(s) ready in ${paths.renderOutput} from ${videoUrl(videoId)} (not published; stages 07/08 not run)`);
  return { runs, timings };
}

/**
 * processVideo, except a video that needs a login (age/privacy gate) is journaled as "skipped" and yields no
 * runs ("nothing to do") instead of failing; used by both --video and --scan.
 */
export async function processOrSkip(
  channel: CutChannel,
  videoId: string,
  config: CutsConfig,
  log: Logger,
  options: ProcessOptions = {},
  run: typeof processVideo = processVideo,
  journal = PROCESSED_FILE,
): Promise<ProcessResult> {
  try {
    return await run(channel, videoId, config, log, options);
  } catch (error) {
    if (!(error instanceof LoginRequiredError)) throw error;
    log.warn(`${videoId}: ${error.message}`);
    await markProcessed({ channelId: channel.id, videoId, status: "skipped", reason: error.message }, journal);
    return { runs: [], timings: [] };
  }
}

async function writeRun(runId: string, channel: CutChannel, videoId: string, videoTitle: string, pick: ClipPick, transcript: Transcript, framing: Framing, videoPath: string, durationSeconds: number): Promise<CutRunContext> {
  const ctx = buildCutRunContext({ runId, channel, videoId, videoTitle, pick, narration: transcriptSlice(transcript, pick.start, pick.end), framing, videoPath, durationSeconds });
  await saveCutContext(ctx);
  return ctx;
}
