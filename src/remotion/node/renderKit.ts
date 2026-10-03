// Node-side rendering toolkit shared by stage 06 (full video) and scripts/preview_still.ts (one frame).
// Never imported by the browser bundle.
//
// Bundle cache: the Remotion webpack bundle depends only on source code, so it is built once into
// node_modules/.cache/short-remotion-bundle/<hash of sources + versions>/ and reused. Run assets are
// NOT baked into it: each render hard-links its files into <bundle>/public/<unique prefix>/ (the
// renderer serves that folder from disk per request) and removes them afterwards, so concurrent
// renders of different runs can share one bundle. This also keeps Windows paths with spaces/accents
// away from the browser: staticFile() only ever sees ASCII names.

import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, link, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle, type WebpackOverrideFn } from "@remotion/bundler";
import { z } from "zod";
import { paths, type PipelineConfig } from "../../orchestrator/lib/config.js";
import { CaptionSettingsSchema, resolveCaptions, resolveVisual, VisualSettingsSchema } from "../../shared/settings.js";
import type { StagedAsset, VideoConfig } from "../props.js";
import type { RenderStyle } from "../shared.js";

export type Log = (message: string) => void;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REMOTION_SRC = path.resolve(HERE, "..");
const SHARED_SRC = path.resolve(HERE, "..", "..", "shared");
const CACHE_ROOT = path.join(paths.root, "node_modules", ".cache", "short-remotion-bundle");
const VERSIONED_PACKAGES = ["remotion", "@remotion/bundler", "@remotion/renderer", "react", "react-dom", "zod"];
const STALE_MS = 6 * 60 * 60 * 1000;

/** Partial {captions, visual} override, e.g. from the dashboard's live preview. */
export const StyleOverrideSchema = z.object({
  captions: CaptionSettingsSchema.optional(),
  visual: VisualSettingsSchema.optional(),
});
export type StyleOverride = z.infer<typeof StyleOverrideSchema>;

export function videoConfigFrom(config: PipelineConfig): VideoConfig {
  const { width, height, fps } = config.video;
  return { width, height, fps };
}

/** Config sections (possibly partial) with an optional override merged on top, then defaults filled. */
export function renderStyleFrom(config: Pick<PipelineConfig, "captions" | "visual">, override: StyleOverride = {}): RenderStyle {
  const defined = <T extends object>(o: T | undefined): Partial<T> =>
    Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;
  return {
    captions: resolveCaptions({ ...defined(config.captions), ...defined(override.captions) }),
    visual: resolveVisual({ ...defined(config.visual), ...defined(override.visual) }),
  };
}

// ---------------------------------------------------------------- bundle cache

function remotionEntryPoint(): string {
  const tsEntry = path.join(REMOTION_SRC, "index.ts");
  return existsSync(tsEntry) ? tsEntry : path.join(REMOTION_SRC, "index.js");
}

/** Lets webpack resolve NodeNext-style `./Foo.js` imports to the `.ts`/`.tsx` sources. */
const withNodeNextExtensions: WebpackOverrideFn = (config) => ({
  ...config,
  resolve: { ...config.resolve, extensionAlias: { ".js": [".tsx", ".ts", ".js"], ".mjs": [".mts", ".mjs"] } },
});

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile() && !/\.test\.[cm]?[jt]sx?$/.test(e.name))
    .map((e) => path.join(e.parentPath, e.name))
    .filter((file) => !file.startsWith(HERE + path.sep)) // this Node-only folder never reaches the bundle
    .sort();
}

async function packageVersion(name: string): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(path.join(paths.root, "node_modules", name, "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "?";
  } catch {
    return "missing";
  }
}

/** Hash of everything that can change the bundle's output. */
export async function bundleCacheKey(): Promise<string> {
  const hash = createHash("sha256");
  for (const file of [...(await listSourceFiles(REMOTION_SRC)), ...(await listSourceFiles(SHARED_SRC))]) {
    hash.update(path.relative(paths.root, file).replaceAll("\\", "/"));
    hash.update(await readFile(file));
  }
  for (const name of VERSIONED_PACKAGES) hash.update(`${name}@${await packageVersion(name)}`);
  return hash.digest("hex").slice(0, 16);
}

async function isOlderThan(target: string, ms: number): Promise<boolean> {
  try {
    return Date.now() - (await stat(target)).mtimeMs > ms;
  } catch {
    return false;
  }
}

/** Drops bundles built from older sources (only stale ones, a concurrent render may still use a recent one). */
async function pruneStaleBundles(currentKey: string): Promise<void> {
  for (const name of await readdir(CACHE_ROOT).catch(() => [] as string[])) {
    if (name === currentKey || name.startsWith("_")) continue;
    const dir = path.join(CACHE_ROOT, name);
    if (await isOlderThan(dir, STALE_MS)) await rm(dir, { recursive: true, force: true });
  }
}

async function buildBundle(key: string, log: Log): Promise<string> {
  const finalDir = path.join(CACHE_ROOT, key);
  const tmpDir = `${finalDir}.tmp-${randomBytes(4).toString("hex")}`;
  const emptyPublic = path.join(CACHE_ROOT, "_empty-public");
  await mkdir(emptyPublic, { recursive: true });
  let lastDecile = -1;
  await bundle({
    entryPoint: remotionEntryPoint(),
    publicDir: emptyPublic,
    outDir: tmpDir,
    webpackOverride: withNodeNextExtensions,
    onProgress: (percent) => {
      const decile = Math.floor(percent / 10);
      if (decile !== lastDecile) log(`bundling ${percent}%`);
      lastDecile = decile;
    },
  });
  try {
    await rename(tmpDir, finalDir);
  } catch (error) {
    // Another process won the race and published the same bundle first: use theirs.
    await rm(tmpDir, { recursive: true, force: true });
    if (!existsSync(path.join(finalDir, "index.html"))) throw error;
  }
  return finalDir;
}

/** Returns the serveUrl (folder) of an up-to-date bundle, building it only when sources changed. */
export async function ensureBundle(log: Log): Promise<string> {
  const key = await bundleCacheKey();
  const dir = path.join(CACHE_ROOT, key);
  if (existsSync(path.join(dir, "index.html"))) return dir;
  log(`building Remotion bundle ${key} (cached for next renders)`);
  await mkdir(CACHE_ROOT, { recursive: true });
  const built = await buildBundle(key, log);
  await pruneStaleBundles(key);
  return built;
}

// ---------------------------------------------------------------- per-render asset staging

const STAGING_ROOT = "runs";

/** Unique public-dir namespace for one render. */
export function newPublicPrefix(): string {
  return `${STAGING_ROOT}/${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

async function stageAsset(asset: StagedAsset, publicDir: string): Promise<void> {
  if (!existsSync(asset.sourcePath)) throw new Error(`missing input file ${asset.sourcePath}`);
  const target = path.join(publicDir, ...asset.publicPath.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await link(asset.sourcePath, target); // instant and free on the same volume
  } catch {
    await copyFile(asset.sourcePath, target); // cross-volume or FS without hard links
  }
}

/** Places the assets (whose publicPaths carry the render's prefix) into the bundle's public dir. */
export async function stageAssets(serveUrl: string, assets: StagedAsset[]): Promise<void> {
  const publicDir = path.join(serveUrl, "public");
  await sweepStaleStaging(publicDir);
  await Promise.all(assets.map((asset) => stageAsset(asset, publicDir)));
}

export async function removeStagedAssets(serveUrl: string, publicPrefix: string): Promise<void> {
  await rm(path.join(serveUrl, "public", ...publicPrefix.split("/")), { recursive: true, force: true });
}

/** Leftovers of crashed renders (hard links, so they cost no space, but keep the folder tidy). */
async function sweepStaleStaging(publicDir: string): Promise<void> {
  const root = path.join(publicDir, STAGING_ROOT);
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const dir = path.join(root, name);
    if (await isOlderThan(dir, STALE_MS)) await rm(dir, { recursive: true, force: true });
  }
}
