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
import type { CutChannel, CutsConfig } from "./config.js";
import type { HumorJob } from "./humor.js";
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

/**
 * Burned-in text detector (PP-OCRv3 DB, opencv_zoo, Apache-2.0), pinned to a commit: 2 423 490 bytes. Lets the
 * cut renderer keep our captions off the creator's own captions and the TikTok watermark.
 */
export const TEXT_DETECTOR: ModelFile = {
  label: "PP-OCRv3 text detector (~2.4 MB)",
  url: "https://github.com/opencv/opencv_zoo/raw/48b10fa505aeb51fbd127fc60a5c660040e823b7/models/text_detection_ppocr/text_detection_en_ppocrv3_2023may.onnx",
  file: join(paths.root, "models", "textdet", "text_detection_en_ppocrv3_2023may.onnx"),
  minBytes: 2_300_000,
  maxBytes: 2_600_000,
};

/** Caption font of the cuts: Montserrat ExtraBold (SIL OFL 1.1), pinned to a commit: 455 468 bytes. */
export const MONTSERRAT: ModelFile = {
  label: "Montserrat ExtraBold font (~450 KB)",
  url: "https://github.com/JulietaUla/Montserrat/raw/555facfb2a18c72c3c0380f0d9c0f060453a9058/fonts/ttf/Montserrat-ExtraBold.ttf",
  file: join(paths.root, "models", "fonts", "Montserrat-ExtraBold.ttf"),
  minBytes: 400_000,
  maxBytes: 500_000,
};

/** Caption font of the "impacto" style: Anton (SIL OFL 1.1, Google Fonts), pinned to a commit: 170 812 bytes. */
export const ANTON: ModelFile = {
  label: "Anton font (~170 KB)",
  url: "https://github.com/google/fonts/raw/e0a8124cf36bb7c32ca68e5d46d6acdbc3df866a/ofl/anton/Anton-Regular.ttf",
  file: join(paths.root, "models", "fonts", "Anton-Regular.ttf"),
  minBytes: 150_000,
  maxBytes: 200_000,
};

export type CaptionStyle = NonNullable<CutChannel["captionStyle"]>;

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
  /** Jokes / emoji / effects for python/cuts/humor.py (cuts/humor.ts); null = none. */
  humor?: HumorJob | null;
  out: string;
  words: TranscriptWord[];
}

export interface RenderInput {
  source: string;
  framing: CutsConfig["clip"]["framing"];
  credit: string;
  captions: CutsConfig["clip"]["captions"];
  /** The channel's caption look (absent = "padrao"). */
  captionStyle?: CaptionStyle;
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
      humor: z.object({ jokes: z.number(), emojis: z.number(), effects: z.number() }).optional(),
      placement: z.object({ textBoxesSeen: z.number(), captionsMoved: z.number(), captionsSkipped: z.number(), emojisMoved: z.number() }).optional(),
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
  extras: { font?: string | null; captionFont?: string | null; watermark?: WatermarkPayload | null; textModel?: string | null } = {},
): Record<string, unknown> {
  return {
    source: input.source,
    yunet,
    asdModel,
    textModel: extras.textModel ?? null,
    watermark: extras.watermark ?? null,
    ffmpeg,
    framing: input.framing,
    credit: input.credit,
    captions: { ...input.captions, style: input.captionStyle ?? "padrao" },
    captionFont: extras.captionFont ?? null,
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
  // Without Anton the "impacto" captions keep the caps/size/outline in the default font.
  const captionFont = input.captionStyle === "impacto" ? await ensureModelFile(ANTON, fetch, log).catch(() => null) : null;
  const watermark = watermarkPayload(resolveWatermarkFiles(loadConfig().watermark, log));
  // Without it captions only avoid faces (burned-in text is not seen).
  const textModel = await ensureModelFile(TEXT_DETECTOR, fetch, log).catch((error: unknown) => {
    log(`WARN text detector unavailable, captions will not avoid burned-in text: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  const { ffmpeg } = resolveFfmpegBinaries();
  return runPythonJson({
    script: "python/cuts/render_clip.py",
    python: resolveCutsPython(),
    stdin: buildRenderPayload(input, yunet, ffmpeg, asdModel, { font, captionFont, watermark, textModel }),
    schema: RenderResultSchema,
    timeoutMs: 90 * 60 * 1000,
    onStderrLine: log,
  });
}
