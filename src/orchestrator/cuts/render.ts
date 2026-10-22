/**
 * Runs python/cuts/render_clip.py in the dedicated OpenCV venv (CUTS_PYTHON) for all clips of a video at
 * once; the script parallelises per clip. YuNet's ONNX model is fetched once into models/yunet/.
 */
import { existsSync } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { env, paths } from "../lib/config.js";
import { resolveFfmpegBinaries } from "../lib/ffmpeg.js";
import { runPythonJson } from "../lib/python.js";
import type { CutsConfig } from "./config.js";
import type { TranscriptWord } from "./transcribe.js";

export const YUNET_URL = "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx";
export const YUNET_FILE = join(paths.root, "models", "yunet", "face_detection_yunet_2023mar.onnx");
/** The 2023mar release is 232 589 bytes; anything far from that is a bad download (HTML error page, truncation). */
const YUNET_MIN_BYTES = 200_000;
const YUNET_MAX_BYTES = 300_000;
export const SPEAKER_HOLD_SECONDS = 1.2;

export interface RenderJob {
  start: number;
  end: number;
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
    }),
  ),
});
export type RenderResult = z.infer<typeof RenderResultSchema>;

/** Words inside the window (with a small tolerance for Whisper boundaries). */
export function wordsInWindow(words: readonly TranscriptWord[], start: number, end: number): TranscriptWord[] {
  return words.filter((w) => w.start >= start - 0.05 && w.end <= end + 0.05);
}

/** The JSON handed to render_clip.py on stdin. */
export function buildRenderPayload(input: RenderInput, yunet: string, ffmpeg: string): Record<string, unknown> {
  return {
    source: input.source,
    yunet,
    ffmpeg,
    framing: input.framing,
    credit: input.credit,
    captions: input.captions,
    holdSeconds: SPEAKER_HOLD_SECONDS,
    font: env("CUTS_FONT"),
    workers: input.workers,
    jobs: input.jobs,
  };
}

export async function ensureYunetModel(fetchFn: typeof fetch = fetch, file = YUNET_FILE, log?: (m: string) => void): Promise<string> {
  if (existsSync(file) && (await stat(file)).size >= YUNET_MIN_BYTES) return file;
  log?.(`downloading YuNet face detector (one-time, ~230 KB) to ${file}`);
  const response = await fetchFn(YUNET_URL);
  if (!response.ok) throw new Error(`YuNet download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < YUNET_MIN_BYTES || bytes.length > YUNET_MAX_BYTES) {
    throw new Error(`YuNet download has unexpected size ${bytes.length} bytes (expected about 232 589)`);
  }
  await mkdir(join(file, ".."), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, file);
  return file;
}

export function resolveCutsPython(): string {
  const configured = env("CUTS_PYTHON");
  if (configured) return paths.fromRoot(configured);
  const local = process.platform === "win32" ? paths.fromRoot(".venv-cuts", "Scripts", "python.exe") : paths.fromRoot(".venv-cuts", "bin", "python");
  if (existsSync(local)) return local;
  throw new Error("Set CUTS_PYTHON in .env to a Python with opencv-python-headless, numpy and pillow (see README, Cortes)");
}

export async function renderClips(input: RenderInput, log: (m: string) => void): Promise<RenderResult> {
  const yunet = await ensureYunetModel(fetch, YUNET_FILE, log);
  const { ffmpeg } = resolveFfmpegBinaries();
  return runPythonJson({
    script: "python/cuts/render_clip.py",
    python: resolveCutsPython(),
    stdin: buildRenderPayload(input, yunet, ffmpeg),
    schema: RenderResultSchema,
    timeoutMs: 90 * 60 * 1000,
    onStderrLine: log,
  });
}
