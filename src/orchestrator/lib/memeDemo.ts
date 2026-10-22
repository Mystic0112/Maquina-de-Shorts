// Demo library: 3 SVG stickers drawn here + 1 synthesized "pop" WAV, no network and no image library.
// `npm run memes -- demo` writes them to assets/memes/files/; tests write them to a temp dir.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { assetPath, FILES_DIR, INVENTORY_FILE, type MemeAsset } from "./memeLibrary.js";

const DEMO_ADDED_AT = "2026-10-21T00:00:00.000Z";

function face(mouth: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><circle cx="100" cy="100" r="92" fill="#FFD83D" stroke="#B88900" stroke-width="8"/>
<circle cx="68" cy="80" r="14" fill="#2b2b2b"/><circle cx="132" cy="80" r="14" fill="#2b2b2b"/>${mouth}</svg>`;
}

const SVGS: Record<string, string> = {
  "demo-surpresa": face('<ellipse cx="100" cy="138" rx="22" ry="30" fill="#2b2b2b"/>'),
  "demo-erro": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><circle cx="100" cy="100" r="92" fill="#E23D3D" stroke="#8E1B1B" stroke-width="8"/>
<path d="M60 60 L140 140 M140 60 L60 140" stroke="#fff" stroke-width="22" stroke-linecap="round"/></svg>`,
  "demo-vitoria": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><polygon points="100,12 124,72 188,76 138,116 154,180 100,146 46,180 62,116 12,76 76,72" fill="#FFC928" stroke="#B88900" stroke-width="8" stroke-linejoin="round"/></svg>`,
};

/** 150 ms "pop": sine sweep 900 -> 250 Hz with an exponential decay, 22.05 kHz mono 16-bit PCM. */
export function popWav(durationMs = 150, sampleRate = 22_050): Buffer {
  const samples = Math.round((durationMs / 1000) * sampleRate);
  const pcm = Buffer.alloc(samples * 2);
  let phase = 0;
  for (let i = 0; i < samples; i++) {
    const t = i / samples;
    phase += (2 * Math.PI * (900 - 650 * t)) / sampleRate;
    pcm.writeInt16LE(Math.round(Math.sin(phase) * Math.exp(-5 * t) * 0.8 * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const DEMO_SHAPES: Pick<MemeAsset, "id" | "kind" | "file" | "tags" | "width" | "height" | "durationMs">[] = [
  { id: "demo-surpresa", kind: "sticker", file: `${FILES_DIR}/demo-surpresa.svg`, tags: ["surpresa", "pergunta", "choque"], width: 200, height: 200 },
  { id: "demo-erro", kind: "sticker", file: `${FILES_DIR}/demo-erro.svg`, tags: ["erro", "negação", "mito"], width: 200, height: 200 },
  { id: "demo-vitoria", kind: "sticker", file: `${FILES_DIR}/demo-vitoria.svg`, tags: ["vitória", "aplauso", "recorde"], width: 200, height: 200 },
  { id: "demo-pop", kind: "sfx", file: `${FILES_DIR}/demo-pop.wav`, tags: ["pop", "surpresa", "explosão"], durationMs: 150 },
];

export const DEMO_ASSETS: MemeAsset[] = DEMO_SHAPES.map((a) => ({
  ...a,
  source: "generated" as const,
  sourceUrl: "generated://maquina-de-shorts/demo",
  author: "Máquina de Shorts",
  license: "own" as const,
  attributionRequired: false,
  addedAt: DEMO_ADDED_AT,
}));

/** Writes the demo files (and an inventory listing them when `withInventory`) into `dir`. */
export async function writeDemoAssets(dir: string, withInventory = true): Promise<MemeAsset[]> {
  await mkdir(path.join(dir, FILES_DIR), { recursive: true });
  for (const asset of DEMO_ASSETS) {
    const svg = SVGS[asset.id];
    await writeFile(assetPath(asset, dir), svg ?? popWav(asset.durationMs));
  }
  if (withInventory) await writeFile(path.join(dir, INVENTORY_FILE), `${JSON.stringify({ assets: DEMO_ASSETS }, null, 2)}\n`);
  return DEMO_ASSETS;
}
