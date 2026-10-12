import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { loadConfig, paths } from "../lib/config.js";
import { pcmToWav, synthesizeGeminiSpeech, type GeminiSpeechRequest, type SpeechAudio } from "../lib/geminiTts.js";
import { getLogger, type Logger } from "../lib/logger.js";
import { runPythonJson, scriptSupportsFlag } from "../lib/python.js";
import { RunRejectedError } from "../lib/rejection.js";
import { resolveVoiceExtras, type VoiceEngine, type VoiceExtras } from "../../shared/settings.js";
import type { Narration, RunContext, Script } from "../types.js";

const EDGE_TTS_SCRIPT = "python/tts/synthesize.py";
const ALIGN_SCRIPT = "python/tts/align_narration.py";
const TTS_TIMEOUT_MS = 5 * 60 * 1000;
/** Pause trimming + Whisper alignment take ~6 s per minute of audio; the first run also downloads the model. */
const ALIGN_TIMEOUT_MS = 10 * 60 * 1000;
/** synthesize.py stops retrying after this, leaving 20 s before the subprocess timeout. */
export const TTS_DEADLINE_SECONDS = 280;
/** Raw Gemini audio kept next to the trimmed narration.wav (for debugging and re-alignment). */
export const GEMINI_SOURCE_AUDIO = "narration.source.wav";

const NarrationSchema = z.object({
  audioPath: z.string().min(1),
  durationMs: z.number().positive(),
  words: z.array(
    z.object({
      word: z.string(),
      startMs: z.number().nonnegative(),
      endMs: z.number().nonnegative(),
    }),
  ),
  /** align_narration.py only: share of script words timed by their own recognized word. */
  alignment: z.object({ matchedRatio: z.number(), model: z.string() }).optional(),
});
type TtsResult = z.infer<typeof NarrationSchema>;

export type ResolvedVoice = Required<VoiceExtras> & { name: string };

export interface TtsJob {
  text: string;
  textFile: string;
  runDir: string;
  voice: ResolvedVoice;
  log: Logger;
}

/** One way of turning the narration text into audio + per-word timings. */
export interface TtsEngine {
  readonly name: VoiceEngine;
  describe(voice: ResolvedVoice): string;
  synthesize(job: TtsJob): Promise<TtsResult>;
}

/** synthesize.py CLI args; the "--flag=value" form keeps negative values (-10%, -2Hz) from parsing as flags. */
export function buildTtsArgs(textFile: string, voiceName: string, outDir: string, prosody: Required<VoiceExtras>): string[] {
  return [
    "--text-file", textFile,
    "--voice", voiceName,
    "--out-dir", outDir,
    `--rate=${prosody.rate}`,
    `--pitch=${prosody.pitch}`,
    `--volume=${prosody.volume}`,
    // synthesize.py drops MP3 frames so no pause between words exceeds this (0 = keep every pause).
    `--max-pause-ms=${prosody.maxPauseMs}`,
  ];
}

/** align_narration.py CLI args: trims pauses in the Gemini audio and times every script word. */
export function buildAlignArgs(audioFile: string, textFile: string, outDir: string, maxPauseMs: number): string[] {
  return ["--audio-in", audioFile, "--text-file", textFile, "--out-dir", outDir, `--max-pause-ms=${maxPauseMs}`];
}

/** The exact text the TTS speaks; 05-buildCaptions aligns against the same segments. */
export function buildNarrationText(script: Pick<Script, "hook" | "scenes" | "cta">): string {
  return [script.hook, ...script.scenes.map((s) => s.narration), script.cta]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
}

/** Python stderr: warnings/errors (e.g. a Whisper model download) are surfaced, the rest stays at debug. */
function stderrLogger(log: Logger, tag: string): (line: string) => void {
  return (line) => (/\b(WARNING|ERROR)\b/.test(line) ? log.warn(`[${tag}] ${line}`) : log.debug(`[${tag}] ${line}`));
}

export const edgeTtsEngine: TtsEngine = {
  name: "edge-tts",
  describe: (v) => `edge-tts ${v.name} (rate ${v.rate}, pitch ${v.pitch}, volume ${v.volume}, max pause ${v.maxPauseMs} ms)`,
  async synthesize({ textFile, runDir, voice, log }) {
    const args = buildTtsArgs(textFile, voice.name, runDir, voice);
    if (await scriptSupportsFlag(EDGE_TTS_SCRIPT, "--deadline-seconds")) args.push(`--deadline-seconds=${TTS_DEADLINE_SECONDS}`);
    return runPythonJson({
      script: EDGE_TTS_SCRIPT,
      args,
      timeoutMs: TTS_TIMEOUT_MS,
      schema: NarrationSchema,
      onStderrLine: stderrLogger(log, "tts"),
      envKeys: [],
    });
  },
};

export type SpeechSynthesizer = (request: GeminiSpeechRequest) => Promise<SpeechAudio>;

/** Gemini TTS -> narration.source.wav -> align_narration.py (pause trimming + Whisper word timings). */
export function createGeminiEngine(speak: SpeechSynthesizer = (request) => synthesizeGeminiSpeech(request)): TtsEngine {
  return {
    name: "gemini",
    describe: (v) => `Gemini ${v.geminiModel} voice ${v.geminiVoice} (max pause ${v.maxPauseMs} ms)`,
    async synthesize({ text, textFile, runDir, voice, log }) {
      const audio = await speak({ text, model: voice.geminiModel, voice: voice.geminiVoice, style: voice.style });
      const sourceFile = join(runDir, GEMINI_SOURCE_AUDIO);
      await writeFile(sourceFile, pcmToWav(audio));
      log.info(`Gemini audio: ${(audio.pcm.length / 2 / audio.sampleRate).toFixed(1)} s; trimming pauses and aligning words`);
      return runPythonJson({
        script: ALIGN_SCRIPT,
        args: buildAlignArgs(sourceFile, textFile, runDir, voice.maxPauseMs),
        timeoutMs: ALIGN_TIMEOUT_MS,
        schema: NarrationSchema,
        onStderrLine: stderrLogger(log, "align"),
        envKeys: [],
      });
    },
  };
}

export function selectTtsEngine(engine: VoiceEngine): TtsEngine {
  return engine === "edge-tts" ? edgeTtsEngine : createGeminiEngine();
}

export async function run(ctx: RunContext, engineFor: (engine: VoiceEngine) => TtsEngine = selectTtsEngine): Promise<RunContext> {
  if (!ctx.script) throw new Error("04-synthesizeVoice requires ctx.script (run 02-generateScript first)");
  const log = getLogger(ctx.runId);
  const config = loadConfig();
  const voice: ResolvedVoice = { ...resolveVoiceExtras(config.voice), name: config.voice.name };
  await mkdir(ctx.runDir, { recursive: true });
  const text = buildNarrationText(ctx.script);
  const textFile = join(ctx.runDir, "narration.txt");
  await writeFile(textFile, text, "utf8");

  const engine = engineFor(voice.engine);
  log.info(`Synthesizing narration with ${engine.describe(voice)}`);
  const { alignment, ...result } = await engine.synthesize({ text, textFile, runDir: ctx.runDir, voice, log });
  if (result.words.length === 0) throw new Error("TTS returned no word timings; captions cannot be built");
  const narration: Narration = {
    ...result,
    audioPath: isAbsolute(result.audioPath) ? result.audioPath : paths.fromRoot(result.audioPath),
  };
  const seconds = narration.durationMs / 1000;
  const aligned = alignment ? `, ${(alignment.matchedRatio * 100).toFixed(0)}% of words matched by ${alignment.model}` : "";
  log.info(`Narration: ${seconds.toFixed(1)} s, ${narration.words.length} words (${(narration.words.length / seconds).toFixed(2)} words/s${aligned})`);
  const { minSeconds, maxSeconds } = config.video;
  const next: RunContext = { ...ctx, narration };
  if (seconds < minSeconds || seconds > maxSeconds) {
    // A Short outside the target length is not publishable: reject so the pipeline tries a new topic.
    throw new RunRejectedError(`Narration is ${seconds.toFixed(1)} s, outside the ${minSeconds}-${maxSeconds} s target`, next);
  }
  return next;
}
