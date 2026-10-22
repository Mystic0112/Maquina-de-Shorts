/**
 * Maintains the sticker/SFX library in assets/memes/ (inventory.json + files/, see src/orchestrator/lib/memeLibrary.ts).
 *
 *   npm run memes -- add-pixabay --query "boom" --kind sticker|image --limit 10 --tags "explosão,surpresa"
 *   npm run memes -- add-file --file x.json --kind lottie --source lottiefiles --url https://... --license "Lottie Simple License" --tags "..."
 *   npm run memes -- add-emoji --set openmoji|noto|twemoji --codepoints 1F62E,1F4A5 --tags "surpresa,explosão"
 *   npm run memes -- list | check | demo
 *
 * Every import records source URL, author and license; licenses outside ALLOWED_LICENSES are refused.
 * Downloads are capped at 25 per command (no bulk scraping). Exit codes: 0 ok, 1 error, 2 missing API key.
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { env } from "../src/orchestrator/lib/config.js";
import { DEMO_ASSETS, writeDemoAssets } from "../src/orchestrator/lib/memeDemo.js";
import {
  ALLOWED_LICENSES,
  ASSET_KINDS,
  ASSET_SOURCES,
  assetPath,
  FILES_DIR,
  INVENTORY_FILE,
  inventoryProblems,
  isLicenseAllowed,
  loadInventory,
  MEME_LIBRARY_DIR,
  MemeAssetSchema,
  requiresAttribution,
  type MemeAsset,
} from "../src/orchestrator/lib/memeLibrary.js";

const MAX_PER_COMMAND = 25;
const EXIT_NO_KEY = 2;
const dir = MEME_LIBRARY_DIR;

const log = (message: string): void => console.log(`[memes] ${message}`);

class UsageError extends Error {}

function tagsOf(raw: string | undefined): string[] {
  const tags = (raw ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  if (tags.length === 0) throw new UsageError("--tags é obrigatório (emoções/situações em pt-BR separadas por vírgula, ex.: surpresa,erro)");
  return tags;
}

function slug(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
}

async function saveInventory(assets: MemeAsset[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, INVENTORY_FILE), `${JSON.stringify({ assets }, null, 2)}\n`);
}

/** Validates each new asset, refuses disallowed licenses and duplicate ids, then persists. */
async function addAssets(incoming: MemeAsset[]): Promise<void> {
  const current = await loadInventory(dir);
  const ids = new Set(current.map((a) => a.id));
  const added: MemeAsset[] = [];
  for (const raw of incoming) {
    const asset = MemeAssetSchema.parse(raw);
    if (!isLicenseAllowed(asset.license)) throw new Error(`Licença não permitida: ${asset.license}`);
    if (ids.has(asset.id)) {
      log(`${asset.id} já está no inventário, pulado`);
      continue;
    }
    ids.add(asset.id);
    added.push(asset);
  }
  await saveInventory([...current, ...added]);
  log(`${added.length} asset(s) adicionados; inventário com ${current.length + added.length}`);
}

async function download(url: string, target: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { "User-Agent": "maquina-de-shorts/0.1 (asset importer)" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return bytes;
}

// ---------------------------------------------------------------- Pixabay

const PixabayHitSchema = z.object({ id: z.number(), pageURL: z.string(), user: z.string(), largeImageURL: z.string(), imageWidth: z.number(), imageHeight: z.number() });
const PixabayResponseSchema = z.object({ hits: z.array(PixabayHitSchema) });

async function addPixabay(values: Record<string, string | undefined>): Promise<void> {
  const kind = values.kind;
  if (kind === "sfx") {
    // Checked 2026-10: Pixabay exposes images and videos via https://pixabay.com/api/ and /api/videos/ only; sounds have
    // no public API. Download the sound in the browser and register it with add-file (source pixabay, Pixabay License).
    throw new UsageError("A Pixabay não tem API pública de áudio. Baixe o som no site e registre com: add-file --kind sfx --source pixabay --license \"Pixabay License\" --url <página do som> ...");
  }
  if (kind !== "sticker" && kind !== "image") throw new UsageError("--kind deve ser sticker ou image (sfx: veja add-file)");
  if (!values.query) throw new UsageError("--query é obrigatório");
  const tags = tagsOf(values.tags);
  const key = env("PIXABAY_API_KEY");
  if (!key) {
    console.error("[memes] PIXABAY_API_KEY não está no .env (a mesma chave do adaptador de footage serve). Nada foi baixado.");
    process.exitCode = EXIT_NO_KEY;
    return;
  }
  const limit = Math.min(MAX_PER_COMMAND, Math.max(1, Number(values.limit ?? 10)));
  const params = new URLSearchParams({ key, q: values.query, image_type: kind === "sticker" ? "vector" : "all", safesearch: "true", per_page: String(Math.max(3, limit)) });
  const res = await fetch(`https://pixabay.com/api/?${params}`);
  if (!res.ok) throw new Error(`Pixabay API: HTTP ${res.status}`);
  const { hits } = PixabayResponseSchema.parse(await res.json());
  const assets: MemeAsset[] = [];
  for (const hit of hits.slice(0, limit)) {
    const ext = path.extname(new URL(hit.largeImageURL).pathname).toLowerCase() || ".jpg";
    const id = `pixabay-${hit.id}`;
    await download(hit.largeImageURL, path.join(dir, FILES_DIR, `${id}${ext}`));
    assets.push({
      id, kind, file: `${FILES_DIR}/${id}${ext}`, source: "pixabay", sourceUrl: hit.pageURL, author: hit.user,
      license: "Pixabay License", licenseUrl: "https://pixabay.com/service/license-summary/", attributionRequired: false,
      tags, width: hit.imageWidth, height: hit.imageHeight, addedAt: new Date().toISOString(),
    });
    log(`baixado ${id} (${hit.user}) ${hit.pageURL}`);
  }
  await addAssets(assets);
}

// ---------------------------------------------------------------- emoji sets

type EmojiSet = { url: (hex: string) => string; page: (hex: string) => string; ext: string; author: string; license: MemeAsset["license"]; licenseUrl: string; size?: number };

const EMOJI_SETS: Record<"openmoji" | "noto" | "twemoji", EmojiSet> = {
  openmoji: {
    url: (hex) => `https://openmoji.org/data/color/svg/${hex.toUpperCase()}.svg`,
    page: (hex) => `https://openmoji.org/library/emoji-${hex.toUpperCase()}/`,
    ext: ".svg", author: "OpenMoji (openmoji.org)", license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
  },
  noto: {
    url: (hex) => `https://raw.githubusercontent.com/googlefonts/noto-emoji/main/png/128/emoji_u${hex.toLowerCase().replace(/-/g, "_")}.png`,
    page: () => "https://github.com/googlefonts/noto-emoji",
    ext: ".png", author: "Google (Noto Emoji)", license: "Apache-2.0", licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0", size: 128,
  },
  twemoji: {
    url: (hex) => `https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/svg/${hex.toLowerCase()}.svg`,
    page: () => "https://github.com/jdecked/twemoji",
    ext: ".svg", author: "Twitter, Inc. and other contributors (Twemoji)", license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  },
};

async function addEmoji(values: Record<string, string | undefined>): Promise<void> {
  const set = EMOJI_SETS[values.set as keyof typeof EMOJI_SETS];
  if (!set) throw new UsageError("--set deve ser openmoji, noto ou twemoji");
  const codepoints = (values.codepoints ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  if (codepoints.length === 0) throw new UsageError("--codepoints é obrigatório (hex separados por vírgula, ex.: 1F62E,1F4A5; sequências com '-')");
  if (codepoints.length > MAX_PER_COMMAND) throw new UsageError(`No máximo ${MAX_PER_COMMAND} emojis por comando`);
  if (!codepoints.every((c) => /^[0-9a-fA-F]{2,6}(-[0-9a-fA-F]{2,6})*$/.test(c))) throw new UsageError("codepoint inválido (use hex como 1F62E ou 1F468-200D-1F4BB)");
  const tags = tagsOf(values.tags);
  const assets: MemeAsset[] = [];
  for (const hex of codepoints) {
    const id = `${values.set}-${hex.toLowerCase()}`;
    await download(set.url(hex), path.join(dir, FILES_DIR, `${id}${set.ext}`));
    assets.push({
      id, kind: "sticker", file: `${FILES_DIR}/${id}${set.ext}`, source: values.set as MemeAsset["source"], sourceUrl: set.page(hex), author: set.author,
      license: set.license, licenseUrl: set.licenseUrl, attributionRequired: requiresAttribution(set.license), tags,
      ...(set.size ? { width: set.size, height: set.size } : {}), addedAt: new Date().toISOString(),
    });
    log(`baixado ${id} (${set.license})`);
  }
  await addAssets(assets);
}

// ---------------------------------------------------------------- manual file

/** Duration of a PCM WAV from its header (sfx files need durationMs); undefined for other formats. */
function wavDurationMs(bytes: Buffer): number | undefined {
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF") return undefined;
  const byteRate = bytes.readUInt32LE(28);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunk = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (chunk === "data") return byteRate ? Math.round((size / byteRate) * 1000) : undefined;
    offset += 8 + size + (size % 2);
  }
  return undefined;
}

async function addFile(values: Record<string, string | undefined>): Promise<void> {
  const { file, kind, source, url, license } = values;
  if (!file || !kind || !source || !url || !license) throw new UsageError("add-file exige --file --kind --source --url --license --tags");
  if (!(ASSET_KINDS as readonly string[]).includes(kind)) throw new UsageError(`--kind deve ser um de ${ASSET_KINDS.join(", ")}`);
  if (!(ASSET_SOURCES as readonly string[]).includes(source)) throw new UsageError(`--source deve ser um de ${ASSET_SOURCES.join(", ")}`);
  if (!isLicenseAllowed(license)) throw new UsageError(`Licença "${license}" não permitida. Aceitas: ${ALLOWED_LICENSES.join(", ")}`);
  const sourceFile = path.resolve(file);
  if (!existsSync(sourceFile)) throw new UsageError(`Arquivo não encontrado: ${sourceFile}`);
  const tags = tagsOf(values.tags);
  const ext = path.extname(sourceFile).toLowerCase();
  const id = values.id ?? `${source}-${slug(path.basename(sourceFile, ext))}`;
  const bytes = await readFile(sourceFile);
  const durationMs = values["duration-ms"] ? Number(values["duration-ms"]) : wavDurationMs(bytes);
  if ((kind === "sfx" || kind === "lottie") && !durationMs) throw new UsageError("--duration-ms é obrigatório para sfx/lottie (WAV é lido do cabeçalho)");
  const target = path.join(dir, FILES_DIR, `${id}${ext}`);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(sourceFile, target);
  await addAssets([{
    id, kind: kind as MemeAsset["kind"], file: `${FILES_DIR}/${id}${ext}`, source: source as MemeAsset["source"], sourceUrl: url,
    ...(values.author ? { author: values.author } : {}), license, ...(values["license-url"] ? { licenseUrl: values["license-url"] } : {}),
    attributionRequired: requiresAttribution(license), tags, ...(durationMs ? { durationMs } : {}), addedAt: new Date().toISOString(),
  }]);
}

// ---------------------------------------------------------------- list / check / demo

async function list(): Promise<void> {
  const assets = await loadInventory(dir);
  if (assets.length === 0) return log(`inventário vazio (${path.join(dir, INVENTORY_FILE)})`);
  for (const a of assets) {
    const ok = existsSync(assetPath(a, dir)) ? "ok" : "ARQUIVO AUSENTE";
    log(`${a.id.padEnd(28)} ${a.kind.padEnd(7)} ${a.license.padEnd(21)} ${ok.padEnd(15)} ${a.tags.join(",")}`);
  }
}

async function check(): Promise<void> {
  const assets = await loadInventory(dir); // throws on invalid schema / disallowed license / duplicate id
  const problems = inventoryProblems(assets, dir);
  for (const p of problems) console.error(`[memes] ${p}`);
  if (problems.length > 0) throw new Error(`${problems.length} problema(s) no inventário`);
  log(`inventário ok: ${assets.length} asset(s), todas as licenças permitidas, todos os arquivos presentes`);
}

async function demo(): Promise<void> {
  await writeDemoAssets(dir, !existsSync(path.join(dir, INVENTORY_FILE)));
  await addAssets(DEMO_ASSETS);
  log(`arquivos de demonstração em ${path.join(dir, FILES_DIR)}`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      query: { type: "string" }, kind: { type: "string" }, limit: { type: "string" }, tags: { type: "string" },
      file: { type: "string" }, source: { type: "string" }, url: { type: "string" }, license: { type: "string" },
      "license-url": { type: "string" }, author: { type: "string" }, id: { type: "string" }, "duration-ms": { type: "string" },
      set: { type: "string" }, codepoints: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const commands: Record<string, () => Promise<void>> = {
    "add-pixabay": () => addPixabay(values), "add-file": () => addFile(values), "add-emoji": () => addEmoji(values), list, check, demo,
  };
  const command = commands[positionals[0] ?? ""];
  if (!command || positionals.length !== 1) throw new UsageError(`Comandos: ${Object.keys(commands).join(", ")} (veja o cabeçalho de scripts/memes.ts)`);
  await command();
}

main().catch((error: unknown) => {
  console.error(`[memes] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
