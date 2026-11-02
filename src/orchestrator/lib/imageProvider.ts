/**
 * Pluggable image provider for `script.imageSource: "ilustrado"`: a small interface (descriptions in, image
 * clips out) so the generator can change without touching stage 03. Chosen by `script.imageProvider`
 * (absent = "agy", so old configs keep working); what happens when it fails or its quota runs out is
 * `script.imageFallback`.
 *
 * Providers today: "agy" (the Antigravity CLI image tool, plan credits, lib/illustrate.ts).
 *
 * Extension points, NOT implemented (do not add them without the owner's OK):
 *  - an image API (Gemini / OpenAI): paid per image, so never a silent fallback, only chosen explicitly;
 *  - a local ComfyUI / Stable Diffusion XL server over HTTP: measured on the home RTX 3050 at 29-57 s per image,
 *    6 GB of VRAM and a quality clearly below agy's, so it is a reserve, not the main source.
 * To add one: put its name in the `imageProvider` enum (src/shared/settings.ts), write an ImageProvider whose
 * `generate` returns FootageClip[] (kind "image", source/license filled like ILLUSTRATION_*) and throws
 * QuotaExhaustedError (lib/quota.ts) when told its allowance is over, and register it in IMAGE_PROVIDERS below.
 * The dashboard selector and the config validation follow the enum.
 */
import { join } from "node:path";
import type { ScriptSettings } from "../../shared/settings.js";
import { AGY_PROVIDER, generateIllustrations } from "./illustrate.js";
import type { Logger } from "./logger.js";
import { QuotaExhaustedError } from "./quota.js";
import { redactSecrets } from "./redact.js";
import type { FootageClip } from "../types.js";

export type ImageProviderName = NonNullable<ScriptSettings["imageProvider"]>;
export type ImageFallback = NonNullable<ScriptSettings["imageFallback"]>;

/** One image wanted: the scene slot it belongs to (kept in the clip's sceneIndex) and its description. */
export interface ImageQuery {
  sceneIndex: number;
  query: string;
}

export interface ImageProvider {
  readonly name: ImageProviderName;
  /**
   * One clip per query it could make (failed ones are logged and skipped). When the provider's quota is over it
   * stops at once and throws QuotaExhaustedError with the clips already made in `partial`.
   */
  generate(queries: readonly ImageQuery[], outDir: string, log: Logger): Promise<FootageClip[]>;
}

export const IMAGE_PROVIDERS: Record<ImageProviderName, ImageProvider> = {
  [AGY_PROVIDER]: { name: AGY_PROVIDER, generate: (queries, outDir, log) => generateIllustrations(queries, outDir, log) },
};

export function getImageProvider(name: ImageProviderName = "agy"): ImageProvider {
  return IMAGE_PROVIDERS[name];
}

/** Stock search for the images the provider did not deliver (the stage's own adapter, with its license filters). */
export type StockSearch = (queries: ImageQuery[], outDir: string, log: Logger) => Promise<FootageClip[]>;

export interface GeneratedImages {
  clips: FootageClip[];
  /** True when stock footage was searched: the run then needs the stock retry round and resolution penalty. */
  usedStock: boolean;
}

/**
 * Asks the provider for every query. With fallback "nenhum" a quota error goes up (the run stops cleanly);
 * with "acervo" the missing images (quota stop, provider error or failed images) are searched in the stock
 * libraries while the generated ones are kept. The fallback never reaches a paid API.
 * With "acervo" the quota error is not rethrown, so its original text stays out of the log on purpose:
 * scripts/loop.ps1 stops the loop on the quota keywords and the run did not fail.
 */
export async function generateImages(
  provider: ImageProvider,
  queries: readonly ImageQuery[],
  outDir: string,
  log: Logger,
  fallback: ImageFallback,
  stock: StockSearch,
): Promise<GeneratedImages> {
  let clips: FootageClip[] = [];
  let failure: unknown;
  try {
    clips = await provider.generate(queries, outDir, log);
  } catch (error) {
    if (fallback !== "acervo") throw error;
    failure = error;
    clips = error instanceof QuotaExhaustedError ? error.partial : [];
  }
  const have = new Set(clips.map((c) => c.sceneIndex));
  const missing = queries.filter((q) => !have.has(q.sceneIndex));
  if (fallback !== "acervo" || missing.length === 0) return { clips, usedStock: false };
  const why =
    failure instanceof QuotaExhaustedError
      ? "the image allowance is used up"
      : failure
        ? `the image provider failed (${redactSecrets(failure instanceof Error ? failure.message : String(failure))})`
        : "some images were not generated";
  log.warn(`Image provider "${provider.name}": ${why}; searching stock footage for ${missing.length} of ${queries.length} image(s) (fallback "acervo")`);
  const found = await stock(missing, join(outDir, "acervo"), log);
  return { clips: [...clips, ...found], usedStock: true };
}
