/**
 * Renders ONE frame of an existing run with an optional style override (dashboard live preview).
 *
 *   npx tsx scripts/preview_still.ts --run <runId|latest> --time <seconds> --out <file.jpg> [--style <style.json>]
 *
 * style.json: partial {"captions": {...}, "visual": {...}} (see src/shared/settings.ts), merged over
 * config/pipeline.config.json. stdout carries exactly one JSON line: {"path": "...", "ms": <number>};
 * logs go to stderr. Exit code 1 with {"error": "..."} on stdout when it fails.
 * The Remotion bundle is cached on disk, so only the first call after a source change is slow.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { openBrowser, renderStill, selectComposition, type HeadlessBrowser } from "@remotion/renderer";
import { loadConfig, paths } from "../src/orchestrator/lib/config.js";
import { loadRunContext, readContextFile } from "../src/orchestrator/lib/runContext.js";
import type { RunContext } from "../src/orchestrator/types.js";
import {
  ensureBundle,
  newPublicPrefix,
  removeStagedAssets,
  renderStyleFrom,
  stageAssets,
  StyleOverrideSchema,
  videoConfigFrom,
  type StyleOverride,
} from "../src/remotion/node/renderKit.js";
import { buildRenderPlan, COMPOSITION_ID } from "../src/remotion/props.js";

const USAGE = "Usage: npx tsx scripts/preview_still.ts --run <runId|latest> --time <seconds> --out <file.jpg> [--style <style.json>]";
const RUN_ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]+$/;
const JPEG_QUALITY = 88;

const logErr = (message: string): void => console.error(`[preview_still] ${message}`);

type Args = { run: string; time: number; out: string; style?: string };

function parseCliArgs(): Args {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { run: { type: "string" }, time: { type: "string" }, out: { type: "string" }, style: { type: "string" } },
    strict: true,
  });
  const time = Number(values.time);
  if (!values.run || !values.out || values.time === undefined || !Number.isFinite(time) || time < 0) throw new Error(USAGE);
  return { run: values.run, time, out: path.resolve(values.out), style: values.style };
}

const isRenderable = (ctx: RunContext): boolean => Boolean(ctx.narration && ctx.captions && ctx.footage?.length);

/** Newest run (ids sort chronologically) that finished rendering. */
async function latestCompletedRunId(): Promise<string> {
  const ids = (await readdir(paths.renderOutput)).filter((name) => RUN_ID_PATTERN.test(name)).sort().reverse();
  for (const id of ids) {
    const file = path.join(paths.renderOutput, id, "context.json");
    if (!existsSync(file)) continue;
    const ctx = await readContextFile(file);
    if (ctx.render && isRenderable(ctx)) return id;
  }
  throw new Error(`no completed run found in ${paths.renderOutput}`);
}

async function loadStyleOverride(file: string | undefined): Promise<StyleOverride> {
  if (!file) return {};
  const parsed = StyleOverrideSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
  if (!parsed.success) throw new Error(`invalid style override ${file}: ${parsed.error.message}`);
  return parsed.data;
}

async function renderFrame(serveUrl: string, inputProps: Record<string, unknown>, frame: number, out: string): Promise<void> {
  let browser: HeadlessBrowser | undefined;
  try {
    browser = await openBrowser("chrome", { logLevel: "error" });
    const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps, puppeteerInstance: browser, logLevel: "error" });
    await renderStill({
      composition,
      serveUrl,
      inputProps,
      frame,
      output: out,
      imageFormat: "jpeg",
      jpegQuality: JPEG_QUALITY,
      overwrite: true,
      puppeteerInstance: browser,
      logLevel: "error",
    });
  } finally {
    await browser?.close({ silent: true });
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const args = parseCliArgs();
  const runId = args.run === "latest" ? await latestCompletedRunId() : args.run;
  const ctx = await loadRunContext(runId);
  if (!isRenderable(ctx)) throw new Error(`run ${runId} has no narration/captions/footage yet`);

  const config = loadConfig();
  const style = renderStyleFrom(config, await loadStyleOverride(args.style));
  const publicPrefix = newPublicPrefix();
  const { props, assets } = buildRenderPlan(ctx, videoConfigFrom(config), style, { publicPrefix });
  const frame = Math.min(props.durationInFrames - 1, Math.max(0, Math.round(args.time * props.fps)));

  const serveUrl = await ensureBundle(logErr);
  await mkdir(path.dirname(args.out), { recursive: true });
  try {
    await stageAssets(serveUrl, assets);
    await renderFrame(serveUrl, props, frame, args.out);
  } finally {
    await removeStagedAssets(serveUrl, publicPrefix);
  }
  process.stdout.write(`${JSON.stringify({ path: args.out, ms: Date.now() - startedAt })}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  logErr(message);
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.exitCode = 1;
});
