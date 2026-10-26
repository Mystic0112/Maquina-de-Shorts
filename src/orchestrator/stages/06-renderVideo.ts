// Stage 06 — compose footage + narration + captions into <runDir>/final.mp4 with Remotion.
//
// Styling comes from config/pipeline.config.json (`captions` / `visual`, defaults filled by
// src/shared/settings.ts) and travels to the composition inside inputProps.
// Local files: see src/remotion/node/renderKit.ts (cached bundle + per-render hard-linked assets).

import path from "node:path";
import { makeCancelSignal, renderMedia, selectComposition } from "@remotion/renderer";
import { loadConfig } from "../lib/config.js";
import { contentBindingProblems } from "../lib/contentHash.js";
import { resolveWatermarkFiles } from "../lib/watermark.js";
import { ANTON, ensureModelFile } from "../cuts/render.js";
import { buildRenderPlan, COMPOSITION_ID, type RenderPlan, type ShortProps } from "../../remotion/props.js";
import { ensureBundle, newPublicPrefix, removeStagedAssets, renderStyleFrom, stageAssets, videoConfigFrom } from "../../remotion/node/renderKit.js";
import type { RenderResult, RunContext } from "../types.js";

export { buildInputProps, buildRenderPlan } from "../../remotion/props.js";

const OUTPUT_FILE_NAME = "final.mp4";
const RENDER_TIMEOUT_MS = 120_000;
/** Whole-render budget (render.totalTimeoutSeconds in config); a hung Chrome/ffmpeg can't block the run. */
const DEFAULT_TOTAL_RENDER_TIMEOUT_S = 600;
/**
 * Capped-CRF H.264: constant quality (CRF 20 keeps caption edges clean) with an x264 VBV ceiling, so
 * noisy footage can't balloon the file. YouTube re-encodes anyway; ~8 Mbps is plenty for 1080x1920.
 */
const ENCODING = { crf: 20, encodingMaxRate: "8M", encodingBufferSize: "8M", audioBitrate: "192k" } as const;

const log = (message: string): void => console.log(`[06-renderVideo] ${message}`);

function progressLogger(label: string): (progress: number) => void {
  let lastBucket = -1;
  return (progress) => {
    const bucket = Math.floor(progress * 10);
    if (bucket === lastBucket) return;
    lastBucket = bucket;
    log(`${label} ${Math.round(progress * 100)}%`);
  };
}

/** One-line summary of the shot plan for the run log: shot count, longest shot, hook text. */
export function describePlan(props: ShortProps, skippedLottieCues = 0): string {
  const shots = props.scenes.flatMap((s) => s.segments);
  const longest = Math.max(0, ...shots.map((s) => s.durationInFrames)) / props.fps;
  const overlay = props.overlay ? `"${props.overlay.text}" for ${(props.overlay.endFrame / props.fps).toFixed(1)}s` : "none";
  const edits = props.edits.length ? `, ${props.edits.length} edit cue(s)` : "";
  const lottie = skippedLottieCues ? ` (${skippedLottieCues} lottie cue(s) skipped: install @remotion/lottie)` : "";
  return `${shots.length} shots in ${props.scenes.length} scenes (longest ${longest.toFixed(1)}s), ${(props.durationInFrames / props.fps).toFixed(2)}s total, hook text: ${overlay}${edits}${lottie}`;
}

async function renderComposition(
  serveUrl: string,
  inputProps: Record<string, unknown>,
  outputPath: string,
  totalTimeoutMs: number,
): Promise<void> {
  const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps, logLevel: "warn" });
  const report = progressLogger("rendering");
  const { cancelSignal, cancel } = makeCancelSignal();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    cancel();
  }, totalTimeoutMs);
  try {
    await renderWith(composition, serveUrl, inputProps, outputPath, cancelSignal, report);
  } catch (error) {
    if (timedOut) throw new Error(`Render cancelled after the ${Math.round(totalTimeoutMs / 1000)} s total render timeout`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function renderWith(
  composition: Awaited<ReturnType<typeof selectComposition>>,
  serveUrl: string,
  inputProps: Record<string, unknown>,
  outputPath: string,
  cancelSignal: ReturnType<typeof makeCancelSignal>["cancelSignal"],
  report: (progress: number) => void,
): Promise<void> {
  await renderMedia({
    cancelSignal,
    composition,
    serveUrl,
    inputProps,
    codec: "h264",
    audioCodec: "aac",
    pixelFormat: "yuv420p",
    colorSpace: "bt709",
    ...ENCODING,
    outputLocation: outputPath,
    overwrite: true,
    timeoutInMilliseconds: RENDER_TIMEOUT_MS,
    logLevel: "warn",
    onProgress: ({ progress }) => report(progress),
  });
}

export async function run(ctx: RunContext): Promise<RunContext> {
  // Never render content whose fact-check / footage verdicts were computed for something else.
  const stale = contentBindingProblems(ctx, { requireHashes: false });
  if (stale.length > 0) throw new Error(`Refusing to render ${ctx.runId}: ${stale.join("; ")}`);
  const config = loadConfig();
  const publicPrefix = newPublicPrefix();
  const watermark = resolveWatermarkFiles(config.watermark, log);
  const style = renderStyleFrom(config);
  // Anton is downloaded once (pinned, size-checked) like the cuts' caption fonts; without it the system fallback is used.
  const captionFontFile = style.captions.font === "anton" ? await ensureModelFile(ANTON, fetch, log).catch(() => null) : null;
  if (style.captions.font === "anton" && !captionFontFile) log("WARN Anton font unavailable, captions fall back to Impact");
  const plan: RenderPlan = buildRenderPlan(ctx, videoConfigFrom(config), style, { publicPrefix, watermark, captionFontFile });
  const { props, assets } = plan;
  const outputPath = path.join(ctx.runDir, OUTPUT_FILE_NAME);
  const startedAt = Date.now();
  log(describePlan(props, plan.skippedLottieCues));

  const serveUrl = await ensureBundle(log);
  try {
    await stageAssets(serveUrl, assets);
    const totalTimeoutS = config.render?.totalTimeoutSeconds ?? DEFAULT_TOTAL_RENDER_TIMEOUT_S;
    await renderComposition(serveUrl, props, outputPath, totalTimeoutS * 1000);
  } finally {
    await removeStagedAssets(serveUrl, publicPrefix);
  }

  const render: RenderResult = {
    videoPath: outputPath,
    durationSeconds: props.durationInFrames / props.fps,
    width: props.width,
    height: props.height,
  };
  log(`done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s -> ${outputPath}`);
  return { ...ctx, render };
}
