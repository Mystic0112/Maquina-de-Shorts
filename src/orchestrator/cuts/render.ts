/**
 * Runs python/cuts/render_clip.py in the dedicated OpenCV venv (CUTS_PYTHON) for all clips of a video at
 * once; the script parallelises per clip. YuNet's ONNX model is fetched once into models/yunet/.
 */
import { existsSync } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { env, loadConfig, paths } from "../lib/config.js";
import { resolveFfmpegBinaries } from "../lib/ffmpeg.js";
import { runPythonJson } from "../lib/python.js";
import { resolveWatermarkFiles, type ResolvedWatermark } from "../lib/watermark.js";
import type { CutsConfig } from "./config.js";
import type { Interval } from "./jumpcut.js";
import type { TranscriptWord } from "./transcribe.js";

export interface ModelFile {
  label: string;
  url: string;
  file: string;
  /** Size window of a good download (anything else is an HTML error page or a truncation). */
  minBytes: number;
  maxBytes: number;
}

/** YuNet face detector (opencv_zoo, 2023mar release: 232 589 bytes). */
export const YUNET: ModelFile = {
  label: "YuNet face detector (~230 KB)",
  url: "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
  file: join(paths.root, "models", "yunet", "face_detection_yunet_2023mar.onnx"),
  minBytes: 200_000,
  maxBytes: 300_000,
};
export const YUNET_FILE = YUNET.file;

/** Caption font of the cuts: Montserrat ExtraBold (SIL OFL 1.1), pinned to a commit: 455 468 bytes. */
export const MONTSERRAT: ModelFile = {
  label: "Montserrat ExtraBold font (~450 KB)",
  url: "https://github.com/JulietaUla/Montserrat/raw/555facfb2a18c72c3c0380f0d9c0f060453a9058/fonts/ttf/Montserrat-ExtraBold.ttf",
  file: join(paths.root, "models", "fonts", "Montserrat-ExtraBold.ttf"),
  minBytes: 400_000,
  maxBytes: 500_000,
};

/** What render_clip.py draws as the owner's brand mark (null = none). */
export interface WatermarkPayload {
  text: string | null;
  image: string | null;
  position: string;
  opacity: number;
  size: number;
}

export function watermarkPayload(wm: ResolvedWatermark): WatermarkPayload | null {
  const text = wm.settings.text.trim() || null;
  if (!wm.settings.enabled || (!text && !wm.imagePath)) return null;
  const { position, opacity, size } = wm.settings;
  return { text, image: wm.imagePath, position, opacity, size };
}

/** Light-ASD active speaker detector (MIT), TalkSet fine-tune, pinned to a commit: 4 175 289 bytes. */
export const LIGHT_ASD: ModelFile = {
  label: "Light-ASD speaker detector (~4 MB)",
  url: "https://github.com/Junhua-Liao/Light-ASD/raw/ed38c232de5efe0261dbd68627c0ade7cdfe14eb/weight/finetuning_TalkSet.model",
  file: join(paths.root, "models", "lightasd", "finetuning_TalkSet.model"),
  minBytes: 4_100_000,
  maxBytes: 4_300_000,
};
export const SPEAKER_HOLD_SECONDS = 1.2;

export interface RenderJob {
  start: number;
  end: number;
  /** Absolute source intervals to keep (jump cuts, see jumpcut.ts); absent = the whole window. */
  keep?: Interval[];
  out: string;
  words: TranscriptWord[];
}

export interface RenderInput {
  source: string;
  framing: CutsConfig["clip"]["framing"];
  credit: string;
  captions: CutsConfig["clip"]["captions"];
  jobs: RenderJob[];
  workers?: number;
}

export const RenderResultSchema = z.object({
  clips: z.array(
    z.object({
      out: z.string(),
      frames: z.number(),
      fps: z.number(),
      seconds: z.number(),
      analysisSeconds: z.number(),
      facesSeen: z.number(),
      speakerSwitches: z.number(),
      faceCoverage: z.number(),
      keptSeconds: z.number().optional(),
      /** "light-asd" (audio-visual model) or "mouth" (fallback heuristic). */
      speakerMethod: z.string().optional(),
      /** Times the camera opened up because two or more people talked at once. */
      groupShots: z.number().optional(),
    }),
  ),
});
export type RenderResult = z.infer<typeof RenderResultSchema>;

/** Words inside the window (with a small tolerance for Whisper boundaries). */
export function wordsInWindow(words: readonly TranscriptWord[], start: number, end: number): TranscriptWord[] {
  return words.filter((w) => w.start >= start - 0.05 && w.end <= end + 0.05);
}

/** The JSON handed to render_clip.py on stdin. */
export function buildRenderPayload(
  input: RenderInput,
  yunet: string,
  ffmpeg: string,
  asdModel: string | null = null,
  extras: { font?: string | null; watermark?: WatermarkPayload | null } = {},
): Record<string, unknown> {
  return {
    source: input.source,
    yunet,
    asdModel,
    watermark: extras.watermark ?? null,
    ffmpeg,
    framing: input.framing,
    credit: input.credit,
    captions: input.captions,
    holdSeconds: SPEAKER_HOLD_SECONDS,
    font: extras.font ?? env("CUTS_FONT"),
    workers: input.workers,
    jobs: input.jobs,
  };
}

/** Downloads a model file once into models/ (size-checked, atomic rename). */
export async function ensureModelFile(model: ModelFile, fetchFn: typeof fetch = fetch, log?: (m: string) => void): Promise<string> {
  if (existsSync(model.file) && (await stat(model.file)).size >= model.minBytes) return model.file;
  log?.(`downloading ${model.label} (one-time) to ${model.file}`);
  const response = await fetchFn(model.url);
  if (!response.ok) throw new Error(`${model.label} download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < model.minBytes || bytes.length > model.maxBytes) {
    throw new Error(`${model.label} download has unexpected size ${bytes.length} bytes`);
  }
  await mkdir(join(model.file, ".."), { recursive: true });
  const tmp = `${model.file}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, model.file);
  return model.file;
}

export const ensureYunetModel = (fetchFn: typeof fetch = fetch, file = YUNET.file, log?: (m: string) => void): Promise<string> =>
  ensureModelFile({ ...YUNET, file }, fetchFn, log);

export function resolveCutsPython(): string {
  const configured = env("CUTS_PYTHON");
  if (configured) return paths.fromRoot(configured);
  const local = process.platform === "win32" ? paths.fromRoot(".venv-cuts", "Scripts", "python.exe") : paths.fromRoot(".venv-cuts", "bin", "python");
  if (existsSync(local)) return local;
  throw new Error("Set CUTS_PYTHON in .env to a Python with opencv-python-headless, numpy and pillow (see README, Cortes)");
}

export async function renderClips(input: RenderInput, log: (m: string) => void): Promise<RenderResult> {
  const yunet = await ensureYunetModel(fetch, YUNET_FILE, log);
  // Without the speaker detector the render falls back to the mouth-movement heuristic (worse on vlogs).
  const asdModel = await ensureModelFile(LIGHT_ASD, fetch, log).catch((error: unknown) => {
    log(`WARN Light-ASD unavailable, speaker detection falls back to mouth movement: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  // CUTS_FONT overrides; without it, Montserrat (a missing font falls back to the system fonts in Python).
  const font = env("CUTS_FONT") ?? (await ensureModelFile(MONTSERRAT, fetch, log).catch(() => null));
  const watermark = watermarkPayload(resolveWatermarkFiles(loadConfig().watermark, log));
  const { ffmpeg } = resolveFfmpegBinaries();
  return runPythonJson({
    script: "python/cuts/render_clip.py",
    python: resolveCutsPython(),
    stdin: buildRenderPayload(input, yunet, ffmpeg, asdModel, { font, watermark }),
    schema: RenderResultSchema,
    timeoutMs: 90 * 60 * 1000,
    onStderrLine: log,
  });
}
