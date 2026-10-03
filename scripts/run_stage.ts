/**
 * Runs a single stage against an existing run, always re-executing it (even if its output exists).
 *   npm run stage -- 05-buildCaptions --run 20261003-143012-a1b2
 */
import { parseArgs } from "node:util";
import { executeStage, findStage } from "../src/orchestrator/runPipeline.js";
import { loadRunContext } from "../src/orchestrator/lib/runContext.js";

const USAGE = "Usage: npm run stage -- <stageName> --run <runId>";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: { run: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const [stageName] = positionals;
  if (!stageName || !values.run || positionals.length > 1) throw new Error(USAGE);
  const stage = findStage(stageName);
  const ctx = await loadRunContext(values.run);
  await executeStage(stage, ctx);
}

main().catch((error: unknown) => {
  console.error(`Stage failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
