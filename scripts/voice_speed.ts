/**
 * Remeasures a voice engine's speech rate (letters per second) from finished runs, to fill VOICE_ENGINE_INFO in
 * src/shared/voiceEngines.ts (stage 02 uses it to keep the hook inside ~3.5 s). Run it on runs made with ONE engine:
 *
 *   npm run voice-speed -- <runId> [<runId> ...]
 *
 * Reads render_output/<runId>/context.json (script + narration, so stages 02 and 04 must have run); prints the
 * rate of each run and the median. Writes nothing.
 */
import { loadRunContext } from "../src/orchestrator/lib/runContext.js";
import { RUN_ID_PATTERN } from "../src/orchestrator/lib/recentTopics.js";
import { measureLettersPerSecond } from "../src/orchestrator/stages/02-generateScript.js";
import { buildNarrationText } from "../src/orchestrator/stages/04-synthesizeVoice.js";

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

async function main(): Promise<number> {
  const runIds = process.argv.slice(2);
  if (runIds.length === 0 || runIds.some((id) => !RUN_ID_PATTERN.test(id))) {
    console.error("Uso: npm run voice-speed -- <runId> [<runId> ...]   (ex.: 20261022-101500-ab12; todos feitos com o mesmo motor de voz)");
    return 2;
  }
  const rates: number[] = [];
  for (const runId of runIds) {
    const ctx = await loadRunContext(runId);
    if (!ctx.script || !ctx.narration) {
      console.error(`[voice-speed] ${runId}: sem roteiro ou narração no context.json; pulado`);
      continue;
    }
    const seconds = ctx.narration.durationMs / 1000;
    const rate = measureLettersPerSecond(buildNarrationText(ctx.script), seconds);
    rates.push(rate);
    console.log(`${runId}  ${seconds.toFixed(1)} s  ${rate.toFixed(2)} letras/s`);
  }
  if (rates.length === 0) return 1;
  console.log(`\nMediana de ${rates.length} execução(ões): ${median(rates).toFixed(1)} letras/s (min ${Math.min(...rates).toFixed(1)}, max ${Math.max(...rates).toFixed(1)})`);
  console.log("Copie a mediana para lettersPerSecond do motor em src/shared/voiceEngines.ts e ponha measured: true.");
  return 0;
}

main().then((code) => process.exit(code), (error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
