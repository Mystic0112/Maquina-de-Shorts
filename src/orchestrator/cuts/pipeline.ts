/**
 * Cuts flow for one video: authorization gate -> download -> transcript -> LLM selection -> render ->
 * one run folder per clip (render_output/<runId>/final.mp4 + context.json). Stages 07/08 are NOT run.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../lib/config.js";
import type { Logger } from "../lib/logger.js";
import { runDirFor } from "../lib/runContext.js";
import { assertChannelAuthorized, type CutChannel, type CutsConfig, type Framing } from "./config.js";
import { buildCutRunContext, FINAL_FILE, newCutRunId, saveCutContext } from "./context.js";
import { downloadSource, sourceDir, videoUrl } from "./download.js";
import { markProcessed } from "./feed.js";
import { renderClips, wordsInWindow } from "./render.js";
import { selectClips, transcriptSlice, type ClipPick } from "./select.js";
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
  const clipSettings = { ...config.clip, perVideo: options.clips ?? config.clip.perVideo };
  const dir = sourceDir(channel.id, videoId);
  await mkdir(dir, { recursive: true });

  const source = await timed(timings, "download", async () => {
    if (options.source) return { path: options.source, title: options.videoTitle ?? videoId };
    return downloadSource(channel.id, videoId, config.download, (m) => log.info(m));
  });
  const transcript: Transcript = await timed(timings, "transcribe", () =>
    options.transcript ? loadTranscript(options.transcript) : transcribeVideo(source.path, join(dir, "transcript.json"), (m) => log.info(m)),
  );
  const picks = await timed(timings, "select", () =>
    selectClips({ channelName: channel.name, videoTitle: source.title, transcript, clip: clipSettings }),
  );
  picks.forEach((p, i) => log.info(`clip ${i + 1}: ${p.start.toFixed(1)}-${p.end.toFixed(1)} s "${p.title}" (${p.reason})`));

  const runIds = picks.map((_, i) => newCutRunId(i));
  const jobs = picks.map((p, i) => ({ start: p.start, end: p.end, out: join(runDirFor(runIds[i] as string), FINAL_FILE), words: wordsInWindow(transcript.words, p.start, p.end) }));
  const rendered = await timed(timings, "render", () =>
    renderClips({ source: source.path, framing, credit: channel.credit, captions: config.clip.captions, jobs }, (m) => log.info(m)),
  );
  rendered.clips.forEach((c, i) => log.info(`clip ${i + 1}: ${c.frames} frames in ${c.seconds} s (faces ${c.facesSeen}, switches ${c.speakerSwitches}, face coverage ${Math.round(c.faceCoverage * 100)}%)`));

  const runs = await timed(timings, "context", () => Promise.all(picks.map((p, i) => writeRun(runIds[i] as string, channel, videoId, source.title, p, transcript, framing, jobs[i]?.out as string))));
  if (!options.noJournal) {
    await markProcessed({ channelId: channel.id, videoId, status: "done", runIds: runs.map((r) => r.runId) });
  }
  log.info(`${runs.length} cut(s) ready in ${paths.renderOutput} from ${videoUrl(videoId)} (not published; stages 07/08 not run)`);
  return { runs, timings };
}

async function writeRun(runId: string, channel: CutChannel, videoId: string, videoTitle: string, pick: ClipPick, transcript: Transcript, framing: Framing, videoPath: string): Promise<CutRunContext> {
  const ctx = buildCutRunContext({ runId, channel, videoId, videoTitle, pick, narration: transcriptSlice(transcript, pick.start, pick.end), framing, videoPath });
  await saveCutContext(ctx);
  return ctx;
}
