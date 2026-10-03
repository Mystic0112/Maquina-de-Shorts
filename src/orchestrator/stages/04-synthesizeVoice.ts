import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { loadConfig, paths } from "../lib/config.js";
import { getLogger } from "../lib/logger.js";
import { runPythonJson } from "../lib/python.js";
import type { Narration, RunContext, Script } from "../types.js";

const TTS_SCRIPT = "python/tts/synthesize.py";
const TTS_TIMEOUT_MS = 5 * 60 * 1000;

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
});

/** The exact text the TTS speaks; 05-buildCaptions aligns against the same segments. */
export function buildNarrationText(script: Pick<Script, "hook" | "scenes" | "cta">): string {
  return [script.hook, ...script.scenes.map((s) => s.narration), script.cta]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
}

export async function run(ctx: RunContext): Promise<RunContext> {
  if (!ctx.script) throw new Error("04-synthesizeVoice requires ctx.script (run 02-generateScript first)");
  const log = getLogger(ctx.runId);
  const voice = loadConfig().voice;
  await mkdir(ctx.runDir, { recursive: true });
  const textFile = join(ctx.runDir, "narration.txt");
  await writeFile(textFile, buildNarrationText(ctx.script), "utf8");

  const args = ["--text-file", textFile, "--voice", voice.name, "--out-dir", ctx.runDir];
  if (voice.rate) args.push(`--rate=${voice.rate}`);
  log.info(`Synthesizing narration with ${voice.name}${voice.rate ? ` (rate ${voice.rate})` : ""}`);
  const result = await runPythonJson({
    script: TTS_SCRIPT,
    args,
    timeoutMs: TTS_TIMEOUT_MS,
    schema: NarrationSchema,
    onStderrLine: (line) => log.debug(`[tts] ${line}`),
  });
  if (result.words.length === 0) throw new Error("TTS returned no word timings; captions cannot be built");
  const narration: Narration = {
    ...result,
    audioPath: isAbsolute(result.audioPath) ? result.audioPath : paths.fromRoot(result.audioPath),
  };
  const seconds = narration.durationMs / 1000;
  log.info(`Narration: ${seconds.toFixed(1)} s, ${narration.words.length} words`);
  const { minSeconds, maxSeconds } = loadConfig().video;
  if (seconds < minSeconds || seconds > maxSeconds) {
    log.warn(`Narration length ${seconds.toFixed(1)} s is outside the ${minSeconds}-${maxSeconds} s target`);
  }
  return { ...ctx, narration };
}
