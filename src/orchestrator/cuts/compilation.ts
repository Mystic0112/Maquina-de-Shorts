/**
 * Compilations (channel style "compilacao"): the source videos are already short (TikTok sketches), so instead of
 * cutting a window out of one long video, the agy picks 2-6 recent videos that share a theme and fit 45-90 s, the
 * meaning/title review runs on the whole sequence, each video is rendered with the usual cut look (speaker camera,
 * jump cuts, captions, humor) and the parts are joined into one Short. Every source is credited with its link.
 * Reposting a whole video is "reused content" for YouTube; joining several by theme with our edit on top is the
 * transformation that keeps the channel monetizable (owner decision, 2026-10-22).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { resolveFfmpegBinaries, runBinary } from "../lib/ffmpeg.js";
import { generateJson, type LlmProvider, withCorrection } from "../lib/llmClient.js";
import type { Logger } from "../lib/logger.js";
import { runDirFor } from "../lib/runContext.js";
import { clipRangeFor, type CutChannel, type CutsConfig } from "./config.js";
import { buildCutRunContext, FINAL_FILE, newCutRunId, saveCutContext } from "./context.js";
import { downloadSource, sourceDir, sourceVideoUrl } from "./download.js";
import { markProcessed, type FeedVideo } from "./feed.js";
import { humorEnabled, planHumor } from "./humor.js";
import { keptSeconds, livelyMoments, planKeep } from "./jumpcut.js";
import { runCutMetadata } from "./metadata.js";
import { titleExamples, titleExamplesBlock } from "../viral/titleExamples.js";
import { renderClips } from "./render.js";
import { verifyPicks } from "./select.js";
import { transcribeVideo, type Transcript } from "./transcribe.js";
import type { CutRunContext } from "./types.js";

/** Newest unprocessed videos considered per compilation (each is downloaded and transcribed). */
export const MAX_CANDIDATES = 12;
export const MIN_PARTS = 2;
export const MAX_PARTS = 6;
const CONCAT_TIMEOUT_MS = 10 * 60 * 1000;

export interface Candidate {
  videoId: string;
  url: string;
  caption: string;
  durationSeconds: number;
  sourcePath: string;
  transcript: Transcript;
}

export const CompilationPickSchema = z.object({
  videoIds: z.array(z.string()).min(1),
  title: z.string().min(3).max(100),
  hook: z.string().min(3).max(200),
  reason: z.string().min(3),
});
export type CompilationPick = z.infer<typeof CompilationPickSchema>;

const text = (t: Transcript): string => t.segments.map((s) => s.text).join(" ").slice(0, 600);

export function buildCompilationPrompt(channelName: string, candidates: readonly Candidate[], range: { minSeconds: number; maxSeconds: number }, examples: readonly string[] = titleExamples("cortes")): string {
  return [
    `Você é editor de um canal de compilações de humor em português do Brasil. Os vídeos abaixo são do canal ${channelName}, todos curtos.`,
    `Monte UMA compilação para YouTube Shorts: escolha de ${MIN_PARTS} a ${MAX_PARTS} vídeos que combinem num mesmo tema ou na mesma vibe, com duração total entre ${range.minSeconds} e ${range.maxSeconds} segundos, e a ordem em que devem passar (o mais forte primeiro).`,
    "",
    "VÍDEOS (id, duração, legenda do autor e o que é falado):",
    ...candidates.map((c) => `- ${c.videoId} | ${c.durationSeconds.toFixed(0)} s | legenda: ${c.caption || "(sem legenda)"} | fala: ${text(c.transcript) || "(sem fala)"}`),
    "",
    ...(examples.length ? [titleExamplesBlock(examples, "cortes e humor"), ""] : []),
    "REGRAS: o título descreve com fidelidade o que acontece (sem mentir nem exagerar) e nunca humilha, xinga ou ridiculariza ninguém; em CAIXA ALTA só as palavras-chave, no máximo 2 emojis.",
    "",
    'Responda só com JSON: {"videoIds":["<id>","<id>"],"title":"<título>","hook":"<primeira frase que prende>","reason":"<qual é o tema>"}',
  ].join("\n");
}

export function validateCompilation(pick: CompilationPick, candidates: readonly Candidate[], range: { minSeconds: number; maxSeconds: number }): string[] {
  const issues: string[] = [];
  const byId = new Map(candidates.map((c) => [c.videoId, c]));
  if (pick.videoIds.length < MIN_PARTS || pick.videoIds.length > MAX_PARTS) issues.push(`use ${MIN_PARTS} to ${MAX_PARTS} videos (got ${pick.videoIds.length})`);
  if (new Set(pick.videoIds).size !== pick.videoIds.length) issues.push("a video is repeated");
  const unknown = pick.videoIds.filter((id) => !byId.has(id));
  if (unknown.length) issues.push(`unknown video id(s): ${unknown.join(", ")}`);
  const total = pick.videoIds.reduce((s, id) => s + (byId.get(id)?.durationSeconds ?? 0), 0);
  if (total < range.minSeconds || total > range.maxSeconds) issues.push(`total duration ${total.toFixed(0)} s is outside ${range.minSeconds}-${range.maxSeconds} s`);
  return issues;
}

export async function selectCompilation(
  channelName: string,
  candidates: readonly Candidate[],
  range: { minSeconds: number; maxSeconds: number },
  options: { provider?: LlmProvider; attempts?: number } = {},
): Promise<CompilationPick> {
  const prompt = buildCompilationPrompt(channelName, candidates, range);
  let current = prompt;
  let last = "";
  for (let attempt = 1; attempt <= (options.attempts ?? 3); attempt++) {
    const pick = await generateJson(current, CompilationPickSchema, { provider: options.provider, thinking: "low" });
    const issues = validateCompilation(pick, candidates, range);
    if (issues.length === 0) return pick;
    last = issues.join("\n");
    current = withCorrection(prompt, JSON.stringify(pick), last);
  }
  throw new Error(`Compilation pick still invalid:\n${last}`);
}

/** The parts' speech on one timeline, so the meaning/title review sees the whole compilation. */
export function joinTranscripts(parts: readonly Candidate[]): Transcript {
  const segments: Transcript["segments"] = [];
  let offset = 0;
  for (const p of parts) {
    for (const s of p.transcript.segments) segments.push({ start: s.start + offset, end: s.end + offset, text: s.text });
    offset += p.durationSeconds;
  }
  return { segments, words: [] };
}

/** ffmpeg concat-demuxer list; single quotes in paths are escaped the way the demuxer expects. */
export function concatList(paths: readonly string[]): string {
  return paths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n";
}

export function buildConcatArgs(listFile: string, out: string): string[] {
  // Re-encode: parts can differ in fps/sample rate (TikTok mixes 30 and 60 fps); -r/-ar need no extra filters.
  return ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-movflags", "+faststart", out];
}

async function prepareCandidates(channel: CutChannel, feed: readonly FeedVideo[], config: CutsConfig, maxSeconds: number, log: Logger): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const video of feed.filter((v) => (v.durationSeconds ?? 0) <= maxSeconds).slice(0, MAX_CANDIDATES)) {
    try {
      const url = sourceVideoUrl(channel, video.videoId);
      const source = await downloadSource(channel.id, video.videoId, config.download, (m) => log.info(m), url, channel.platform);
      const transcript = await transcribeVideo(source.path, join(sourceDir(channel.id, video.videoId), "transcript.json"), (m) => log.info(m));
      out.push({ videoId: video.videoId, url, caption: video.title, durationSeconds: source.durationSeconds, sourcePath: source.path, transcript });
    } catch (error) {
      log.warn(`${video.videoId}: skipped (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return out;
}

/** One compilation from the channel's fresh videos; null when there is not enough material or the review refuses it. */
export async function processCompilation(channel: CutChannel, feed: readonly FeedVideo[], config: CutsConfig, log: Logger): Promise<CutRunContext | null> {
  const range = clipRangeFor(channel, config);
  const candidates = await prepareCandidates(channel, feed, config, range.maxSeconds, log);
  if (candidates.length < MIN_PARTS) {
    log.info(`${channel.name}: ${candidates.length} usable video(s), not enough for a compilation`);
    return null;
  }
  const pick = await selectCompilation(channel.name, candidates, range);
  const parts = pick.videoIds.map((id) => candidates.find((c) => c.videoId === id) as Candidate);
  const total = parts.reduce((s, p) => s + p.durationSeconds, 0);
  const review = await verifyPicks([{ start: 0, end: total, title: pick.title, hook: pick.hook, reason: pick.reason }], joinTranscripts(parts));
  if (review.approved.length === 0) {
    log.warn(`compilation "${pick.title}" refused by the review: ${review.rejected[0]?.verdict?.problem || "no verdict"}`);
    return null;
  }

  const runId = newCutRunId(0);
  const runDir = runDirFor(runId);
  await mkdir(join(runDir, "parts"), { recursive: true });
  const withHumor = humorEnabled(channel);
  const partFiles: string[] = [];
  let kept = 0;
  for (const [i, part] of parts.entries()) {
    const keep = planKeep(part.transcript.words, part.transcript.loudness, 0, part.durationSeconds);
    const words = part.transcript.words;
    const humor = withHumor
      ? await planHumor({ title: pick.title, channelName: channel.name, start: 0, end: part.durationSeconds, words, lively: livelyMoments(words, part.transcript.loudness, 0, part.durationSeconds) }, keep, { log: (m) => log.info(m) })
      : null;
    const out = join(runDir, "parts", `part_${String(i + 1).padStart(2, "0")}.mp4`);
    await renderClips({ source: part.sourcePath, framing: config.clip.framing, credit: channel.credit, captions: config.clip.captions, jobs: [{ start: 0, end: part.durationSeconds, keep, humor, out, words }] }, (m) => log.info(m));
    partFiles.push(out);
    kept += keptSeconds(keep);
  }
  const listFile = join(runDir, "parts", "concat.txt");
  await writeFile(listFile, concatList(partFiles));
  const finalPath = join(runDir, FINAL_FILE);
  await runBinary(resolveFfmpegBinaries().ffmpeg, buildConcatArgs(listFile, finalPath), CONCAT_TIMEOUT_MS);

  const sources = parts.map((p) => ({ videoId: p.videoId, url: p.url, title: p.caption }));
  const ctx = buildCutRunContext({
    runId,
    channel,
    videoId: parts[0]?.videoId as string,
    videoTitle: parts.map((p) => p.caption).filter(Boolean).join(" | ").slice(0, 300),
    pick: { start: 0, end: total, title: pick.title, hook: pick.hook, reason: pick.reason },
    narration: parts.map((p) => text(p.transcript)).join(" "),
    framing: config.clip.framing,
    videoPath: finalPath,
    durationSeconds: kept,
    sources,
  });
  await saveCutContext(ctx);
  let result: CutRunContext = ctx;
  try {
    result = await runCutMetadata(ctx);
    await saveCutContext(result);
  } catch (error) {
    log.warn(`compilation metadata failed (kept the video): ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const p of parts) await markProcessed({ channelId: channel.id, videoId: p.videoId, status: "done", runIds: [runId] });
  log.info(`compilation "${pick.title}": ${parts.length} video(s), ${kept.toFixed(1)} s -> ${finalPath} (not published)`);
  return result;
}
