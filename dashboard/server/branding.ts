// Configurações > Marca d'água: the owner's logo, stored outside git in data/branding/logo.png.
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectRoot } from "./config.js";
import { SettingsError } from "./settings.js";

/** Project-relative path saved in pipeline.config.json (watermark.image). */
export const LOGO_RELATIVE = "data/branding/logo.png";
export const LOGO_FILE = join(projectRoot, ...LOGO_RELATIVE.split("/"));
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const isPng = (bytes: Buffer): boolean => bytes.length > PNG_SIGNATURE.length && bytes.subarray(0, 8).equals(PNG_SIGNATURE);

export async function saveLogo(bytes: unknown): Promise<string> {
  if (!Buffer.isBuffer(bytes) || !isPng(bytes)) throw new SettingsError(400, "Envie uma imagem PNG (de preferência com fundo transparente).");
  await mkdir(join(LOGO_FILE, ".."), { recursive: true });
  const tmp = `${LOGO_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, LOGO_FILE);
  return LOGO_RELATIVE;
}

export const logoExists = (): boolean => existsSync(LOGO_FILE);
