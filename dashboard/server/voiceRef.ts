// Configurações > Voz > Chatterbox: the recording of the voice to speak with (10-15 s), stored outside git in
// data/voice_ref/reference.<ext>. It is somebody's voice: the page asks for consent, and nothing here leaves the PC.
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectRoot } from "./config.js";
import { sniffAudio } from "./music.js";
import { SettingsError } from "./settings.js";

export const VOICE_REF_DIR = join(projectRoot, "data", "voice_ref");
export const MAX_VOICE_REF_BYTES = 10 * 1024 * 1024;
/** What synthesize_chatterbox.py accepts. */
const FORMATS = ["wav", "mp3", "flac"] as const;
type RefFormat = (typeof FORMATS)[number];

const relative = (ext: string): string => `data/voice_ref/reference.${ext}`;

/** Saves the reference (one at a time: older copies are removed) and returns the project-relative path for config. */
export async function saveVoiceReference(bytes: unknown, dir = VOICE_REF_DIR): Promise<string> {
  const format = Buffer.isBuffer(bytes) ? sniffAudio(bytes) : undefined;
  if (!format || !FORMATS.includes(format as RefFormat)) throw new SettingsError(400, "Envie um arquivo WAV, MP3 ou FLAC com 10 a 15 segundos de fala limpa.");
  await mkdir(dir, { recursive: true });
  const target = join(dir, `reference.${format}`);
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, bytes as Buffer);
  await rename(tmp, target);
  await Promise.all(FORMATS.filter((f) => f !== format).map((f) => rm(join(dir, `reference.${f}`), { force: true })));
  return relative(format);
}

/** Current reference file (absolute path) and its project-relative form, if any. */
export function voiceReference(dir = VOICE_REF_DIR): { file: string; path: string } | undefined {
  const ext = FORMATS.find((f) => existsSync(join(dir, `reference.${f}`)));
  return ext ? { file: join(dir, `reference.${ext}`), path: relative(ext) } : undefined;
}

export async function removeVoiceReference(dir = VOICE_REF_DIR): Promise<boolean> {
  const current = voiceReference(dir);
  if (!current) return false;
  await rm(current.file, { force: true });
  return true;
}
