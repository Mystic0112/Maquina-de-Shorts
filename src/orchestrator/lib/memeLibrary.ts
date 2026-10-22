// Sticker / SFX / Lottie library (assets/memes/): inventory schema, license gate and credits.
// Files live in assets/memes/files/ (git-ignored); only inventory.json is versioned.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { EditAsset } from "../types.js";
import { paths } from "./config.js";

export const MEME_LIBRARY_DIR = paths.fromRoot("assets", "memes");
export const INVENTORY_FILE = "inventory.json";
export const FILES_DIR = "files";

/** The only licenses the owner approved; anything else is refused at import and at load time. */
export const ALLOWED_LICENSES = [
  "CC0",
  "CC BY 4.0",
  "CC BY 3.0",
  "CC BY-SA 4.0",
  "Pixabay License",
  "Lottie Simple License",
  "Apache-2.0",
  "own",
] as const;
export type AllowedLicense = (typeof ALLOWED_LICENSES)[number];

export const ASSET_KINDS = ["sticker", "lottie", "sfx", "image"] as const;
export const ASSET_SOURCES = ["pixabay", "freesound", "lottiefiles", "openmoji", "noto", "twemoji", "generated", "manual"] as const;

export const MemeAssetSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,60}$/, "id: letras minúsculas, dígitos, _ ou -"),
  kind: z.enum(ASSET_KINDS),
  /** Relative to assets/memes/ (e.g. "files/pop.wav"). */
  file: z.string().min(1).refine((f) => !path.isAbsolute(f) && !f.includes(".."), "file: caminho relativo, sem .."),
  source: z.enum(ASSET_SOURCES),
  sourceUrl: z.string().min(1),
  author: z.string().optional(),
  license: z.enum(ALLOWED_LICENSES),
  licenseUrl: z.string().url().optional(),
  attributionRequired: z.boolean(),
  /** Emotions/situations in pt-BR ("surpresa", "erro", "vitória", ...). */
  tags: z.array(z.string().min(1)).min(1),
  durationMs: z.number().int().positive().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  addedAt: z.string().min(1),
});
export type MemeAsset = z.infer<typeof MemeAssetSchema>;

export const InventorySchema = z.object({ assets: z.array(MemeAssetSchema) });
export type Inventory = z.infer<typeof InventorySchema>;

export function isLicenseAllowed(license: string): license is AllowedLicense {
  return (ALLOWED_LICENSES as readonly string[]).includes(license);
}

/** CC BY and CC BY-SA need author + license + link in the description; the others don't. */
export function requiresAttribution(license: string): boolean {
  return /^CC BY/i.test(license);
}

export function assetPath(asset: Pick<MemeAsset, "file">, dir: string = MEME_LIBRARY_DIR): string {
  return path.join(dir, ...asset.file.split("/"));
}

/** Parses an inventory document, refusing any asset whose license is outside ALLOWED_LICENSES. */
export function parseInventory(raw: unknown): Inventory {
  const parsed = InventorySchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Inventário de memes inválido:\n${z.prettifyError(parsed.error)}`);
  const refused = parsed.data.assets.filter((a) => !isLicenseAllowed(a.license));
  if (refused.length > 0) throw new Error(`Licença não permitida: ${refused.map((a) => `${a.id} (${a.license})`).join(", ")}`);
  const ids = new Set<string>();
  for (const a of parsed.data.assets) {
    if (ids.has(a.id)) throw new Error(`Inventário de memes: id repetido "${a.id}"`);
    ids.add(a.id);
  }
  return parsed.data;
}

/** Missing inventory = empty library (the feature is opt-in). */
export async function loadInventory(dir: string = MEME_LIBRARY_DIR): Promise<MemeAsset[]> {
  const file = path.join(dir, INVENTORY_FILE);
  if (!existsSync(file)) return [];
  return parseInventory(JSON.parse(await readFile(file, "utf8"))).assets;
}

/** Problems a `check` must report: invalid licenses are already thrown by parseInventory. */
export function inventoryProblems(assets: readonly MemeAsset[], dir: string = MEME_LIBRARY_DIR): string[] {
  const problems: string[] = [];
  for (const a of assets) {
    if (!existsSync(assetPath(a, dir))) problems.push(`${a.id}: arquivo ausente (${a.file})`);
    if (requiresAttribution(a.license) !== a.attributionRequired) problems.push(`${a.id}: attributionRequired deveria ser ${requiresAttribution(a.license)} para ${a.license}`);
    if (a.kind === "sfx" && !a.durationMs) problems.push(`${a.id}: sfx sem durationMs`);
  }
  return problems;
}

/** Any of `tags` matches (accent/case-insensitive); `kind` narrows further. */
export function findByTags(assets: readonly MemeAsset[], tags: readonly string[], kind?: MemeAsset["kind"]): MemeAsset[] {
  const wanted = new Set(tags.map(normalizeTag));
  return assets.filter((a) => (!kind || a.kind === kind) && a.tags.some((t) => wanted.has(normalizeTag(t))));
}

const normalizeTag = (t: string): string => t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

export function toEditAsset(asset: MemeAsset, dir: string = MEME_LIBRARY_DIR): EditAsset {
  const { file: _file, tags: _tags, addedAt: _addedAt, ...rest } = asset;
  return { ...rest, path: assetPath(asset, dir) };
}

/** Same bullet style as 07-generateMetadata's CC BY lines; empty when nothing needs attribution. */
export const EDIT_CREDITS_HEADER = "Créditos dos efeitos e figurinhas:";
const EDIT_MODIFIED_NOTE = "(redimensionado e editado)";

export function creditsFor(assets: readonly Pick<EditAsset, "id" | "author" | "license" | "licenseUrl" | "sourceUrl" | "attributionRequired">[]): string {
  const seen = new Set<string>();
  const lines = assets
    .filter((a) => a.attributionRequired && !seen.has(a.sourceUrl) && seen.add(a.sourceUrl))
    .map((a) => {
      const license = a.licenseUrl ? `${a.license} (${a.licenseUrl})` : a.license;
      return `• ${a.author?.trim() || "Autor desconhecido"} — ${license} — ${a.sourceUrl} ${EDIT_MODIFIED_NOTE}`;
    });
  return lines.length > 0 ? [EDIT_CREDITS_HEADER, ...lines].join("\n") : "";
}
