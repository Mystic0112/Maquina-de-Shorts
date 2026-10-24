// Configurações > Músicas: the owner's predefined songs for beat-synced edits, stored outside git in data/music/
// (audio files + library.json). Only licensed music belongs here; the page says so.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { projectRoot } from "./config.js";
import { SettingsError } from "./settings.js";

export const MUSIC_DIR = join(projectRoot, "data", "music");
export const MAX_TRACK_BYTES = 40 * 1024 * 1024;
const LIBRARY_FILE = "library.json";
export const TRACK_ID = /^[a-z0-9][a-z0-9-]{2,70}$/;

export interface MusicTrack {
  id: string;
  /** Name the owner sees in the list. */
  name: string;
  /** File inside data/music/. */
  file: string;
  bytes: number;
  addedAt: string;
}

/** File extension from the first bytes (the extension the browser sends is not trusted). */
export function sniffAudio(bytes: Buffer): "mp3" | "wav" | "m4a" | "ogg" | "flac" | undefined {
  if (bytes.length < 12) return undefined;
  const ascii = (from: number, to: number) => bytes.subarray(from, to).toString("latin1");
  if (ascii(0, 3) === "ID3" || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) return "mp3";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "wav";
  if (ascii(4, 8) === "ftyp") return "m4a";
  if (ascii(0, 4) === "OggS") return "ogg";
  if (ascii(0, 4) === "fLaC") return "flac";
  return undefined;
}

export const cleanTrackName = (raw: unknown): string => (typeof raw === "string" ? raw : "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);

function slug(name: string): string {
  const base = name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return base || "musica";
}

export async function listTracks(dir = MUSIC_DIR): Promise<MusicTrack[]> {
  const file = join(dir, LIBRARY_FILE);
  if (!existsSync(file)) return [];
  try {
    const data: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(data)) return [];
    return data.filter((t): t is MusicTrack => !!t && typeof t === "object" && TRACK_ID.test(String((t as MusicTrack).id)) && typeof (t as MusicTrack).file === "string" && /^[\w.-]+$/.test((t as MusicTrack).file));
  } catch {
    return [];
  }
}

async function saveLibrary(tracks: MusicTrack[], dir: string): Promise<void> {
  const file = join(dir, LIBRARY_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(tracks, null, 2)}\n`);
  await rename(tmp, file);
}

export async function addTrack(name: unknown, bytes: unknown, dir = MUSIC_DIR): Promise<MusicTrack> {
  const clean = cleanTrackName(name);
  if (!clean) throw new SettingsError(400, "Dê um nome para a música.");
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new SettingsError(400, "Envie um arquivo de áudio (MP3, WAV, M4A, OGG ou FLAC).");
  if (bytes.length > MAX_TRACK_BYTES) throw new SettingsError(413, "A música passa de 40 MB.");
  const ext = sniffAudio(bytes);
  if (!ext) throw new SettingsError(400, "Esse arquivo não parece ser um áudio (MP3, WAV, M4A, OGG ou FLAC).");
  await mkdir(dir, { recursive: true });
  const tracks = await listTracks(dir);
  if (tracks.some((t) => t.name.toLowerCase() === clean.toLowerCase())) throw new SettingsError(409, "Já existe uma música com esse nome.");
  const id = `${slug(clean)}-${randomBytes(3).toString("hex")}`;
  const file = `${id}.${ext}`;
  const target = join(dir, file);
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, target);
  const track: MusicTrack = { id, name: clean, file, bytes: bytes.length, addedAt: new Date().toISOString() };
  await saveLibrary([...tracks, track], dir);
  return track;
}

export async function removeTrack(id: string, dir = MUSIC_DIR): Promise<boolean> {
  if (!TRACK_ID.test(id)) return false;
  const tracks = await listTracks(dir);
  const track = tracks.find((t) => t.id === id);
  if (!track) return false;
  await saveLibrary(tracks.filter((t) => t.id !== id), dir);
  await rm(join(dir, track.file), { force: true });
  return true;
}

/** Absolute path of a library track, or undefined. */
export async function trackPath(id: string, dir = MUSIC_DIR): Promise<string | undefined> {
  if (!TRACK_ID.test(id)) return undefined;
  const track = (await listTracks(dir)).find((t) => t.id === id);
  const file = track ? join(dir, track.file) : undefined;
  return file && existsSync(file) ? file : undefined;
}
