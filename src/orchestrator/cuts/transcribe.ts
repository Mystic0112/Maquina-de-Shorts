/** Runs python/cuts/transcribe.py (project .venv: faster-whisper) and loads the resulting transcript.json. */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { env } from "../lib/config.js";
import { runPythonJson } from "../lib/python.js";

export const TranscriptSchema = z.object({
  segments: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })),
  words: z.array(z.object({ word: z.string(), start: z.number(), end: z.number() })),
  duration: z.number().optional(),
  model: z.string().optional(),
  /** RMS level (dBFS) per `hop` seconds; jump cuts use it to tell laughter from dead air. Older transcripts lack it. */
  loudness: z.object({ hop: z.number().positive(), db: z.array(z.number()) }).optional(),
});
export type Transcript = z.infer<typeof TranscriptSchema>;
export type TranscriptSegment = Transcript["segments"][number];
export type TranscriptWord = Transcript["words"][number];

const SummarySchema = z.object({ path: z.string(), segments: z.number(), words: z.number() });

export async function loadTranscript(file: string): Promise<Transcript> {
  const parsed = TranscriptSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
  if (!parsed.success) throw new Error(`Invalid transcript ${file}:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** Transcribes once (reuses an existing transcript.json next to the source unless it predates the loudness track). */
export async function transcribeVideo(videoPath: string, outPath: string, log: (m: string) => void): Promise<Transcript> {
  if (!existsSync(outPath) || !(await loadTranscript(outPath)).loudness) {
    const args = ["--video", videoPath, "--out", outPath];
    const model = env("CUTS_WHISPER_MODEL");
    const device = env("CUTS_WHISPER_DEVICE");
    if (model) args.push("--model", model);
    if (device) args.push("--device", device);
    const summary = await runPythonJson({
      script: "python/cuts/transcribe.py",
      args,
      schema: SummarySchema,
      timeoutMs: 60 * 60 * 1000,
      onStderrLine: log,
    });
    log(`transcript: ${summary.segments} segments, ${summary.words} words`);
  }
  return loadTranscript(outPath);
}
