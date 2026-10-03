// Stage 06 — compose footage + narration + captions into <runDir>/final.mp4 with Remotion.
//
// Local files: the headless browser cannot read arbitrary absolute Windows paths, so every input is
// staged (hard link, copy fallback) into a small dedicated public dir with URL-safe names, that dir
// is passed to bundle({ publicDir }) and the composition reads it through staticFile().

import { existsSync } from "node:fs";
import { copyFile, link, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle, type WebpackOverrideFn } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { buildRenderPlan, COMPOSITION_ID, type StagedAsset, type VideoConfig } from "../../remotion/props.js";
import type { RenderResult, RunContext } from "../types.js";

export { buildInputProps, buildRenderPlan } from "../../remotion/props.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STAGING_DIR_NAME = "_remotion_public";
const OUTPUT_FILE_NAME = "final.mp4";
const RENDER_TIMEOUT_MS = 120_000;
/**
 * Capped-CRF H.264: constant quality (CRF 20 keeps caption edges clean) with an x264 VBV ceiling, so
 * noisy footage can't balloon the file. YouTube re-encodes anyway; ~8 Mbps is plenty for 1080x1920.
 */
const ENCODING = { crf: 20, encodingMaxRate: "8M", encodingBufferSize: "8M", audioBitrate: "192k" } as const;

const log = (message: string): void => console.log(`[06-renderVideo] ${message}`);

function findUp(relativePath: string, fromDir: string): string {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, relativePath);
    if (existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) throw new Error(`renderVideo: could not find ${relativePath} above ${fromDir}`);
  }
}

async function loadVideoConfig(): Promise<VideoConfig> {
  const configPath = findUp(path.join("config", "pipeline.config.json"), HERE);
  const parsed = JSON.parse(await readFile(configPath, "utf8")) as { video: VideoConfig };
  const { width, height, fps } = parsed.video;
  return { width, height, fps };
}

function remotionEntryPoint(): string {
  const remotionDir = path.resolve(HERE, "..", "..", "remotion");
  const tsEntry = path.join(remotionDir, "index.ts");
  return existsSync(tsEntry) ? tsEntry : path.join(remotionDir, "index.js");
}

/** Lets webpack resolve NodeNext-style `./Foo.js` imports to the `.ts`/`.tsx` sources. */
const withNodeNextExtensions: WebpackOverrideFn = (config) => ({
  ...config,
  resolve: { ...config.resolve, extensionAlias: { ".js": [".tsx", ".ts", ".js"], ".mjs": [".mts", ".mjs"] } },
});

async function stageAsset(asset: StagedAsset, publicDir: string): Promise<void> {
  if (!existsSync(asset.sourcePath)) throw new Error(`renderVideo: missing input file ${asset.sourcePath}`);
  const target = path.join(publicDir, ...asset.publicPath.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await link(asset.sourcePath, target); // instant and free on the same volume
  } catch {
    await copyFile(asset.sourcePath, target); // cross-volume or FS without hard links
  }
}

async function stageAssets(assets: StagedAsset[], publicDir: string): Promise<void> {
  await rm(publicDir, { recursive: true, force: true });
  await mkdir(publicDir, { recursive: true });
  await Promise.all(assets.map((asset) => stageAsset(asset, publicDir)));
}

function progressLogger(label: string): (progress: number) => void {
  let lastBucket = -1;
  return (progress) => {
    const bucket = Math.floor(progress * 10);
    if (bucket === lastBucket) return;
    lastBucket = bucket;
    log(`${label} ${Math.round(progress * 100)}%`);
  };
}

async function bundleComposition(publicDir: string, outDir: string): Promise<string> {
  const report = progressLogger("bundling");
  return bundle({
    entryPoint: remotionEntryPoint(),
    publicDir,
    outDir,
    webpackOverride: withNodeNextExtensions,
    onProgress: (percent) => report(percent / 100),
  });
}

async function renderComposition(serveUrl: string, inputProps: Record<string, unknown>, outputPath: string): Promise<void> {
  const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps, logLevel: "warn" });
  const report = progressLogger("rendering");
  await renderMedia({
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
  const video = await loadVideoConfig();
  const { props, assets } = buildRenderPlan(ctx, video);
  const publicDir = path.join(ctx.runDir, STAGING_DIR_NAME);
  const bundleDir = await mkdtemp(path.join(os.tmpdir(), "short-bundle-"));
  const outputPath = path.join(ctx.runDir, OUTPUT_FILE_NAME);
  const startedAt = Date.now();

  try {
    await stageAssets(assets, publicDir);
    const serveUrl = await bundleComposition(publicDir, bundleDir);
    await renderComposition(serveUrl, props, outputPath);
  } finally {
    await rm(publicDir, { recursive: true, force: true });
    await rm(bundleDir, { recursive: true, force: true });
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
