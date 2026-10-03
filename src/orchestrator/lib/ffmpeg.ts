import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { z } from "zod";

export interface FfmpegBinaries {
  ffmpeg: string;
  ffprobe: string;
  /** Directory holding the binaries (and their DLLs/shared libs); used as the child's cwd. */
  dir: string | undefined;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const STDERR_TAIL_CHARS = 3000;

/** Same platform → package mapping @remotion/renderer uses to find its compositor binaries. */
function compositorPackageCandidates(): string[] {
  const key = `${process.platform}-${process.arch}`;
  const map: Record<string, string[]> = {
    "win32-x64": ["@remotion/compositor-win32-x64-msvc"],
    "darwin-x64": ["@remotion/compositor-darwin-x64"],
    "darwin-arm64": ["@remotion/compositor-darwin-arm64"],
    "linux-x64": ["@remotion/compositor-linux-x64-gnu", "@remotion/compositor-linux-x64-musl"],
    "linux-arm64": ["@remotion/compositor-linux-arm64-gnu", "@remotion/compositor-linux-arm64-musl"],
  };
  return map[key] ?? [];
}

let cachedBinaries: FfmpegBinaries | undefined;

/** Remotion's bundled ffmpeg/ffprobe (resolved through node module resolution), else ffmpeg on PATH. */
export function resolveFfmpegBinaries(): FfmpegBinaries {
  if (cachedBinaries) return cachedBinaries;
  const require = createRequire(import.meta.url);
  const ext = process.platform === "win32" ? ".exe" : "";
  for (const pkg of compositorPackageCandidates()) {
    try {
      const dir = dirname(require.resolve(`${pkg}/package.json`));
      const ffmpeg = join(dir, `ffmpeg${ext}`);
      const ffprobe = join(dir, `ffprobe${ext}`);
      if (existsSync(ffmpeg) && existsSync(ffprobe)) return (cachedBinaries = { ffmpeg, ffprobe, dir });
    } catch {
      // Package not installed for this platform variant; try the next candidate.
    }
  }
  return (cachedBinaries = { ffmpeg: "ffmpeg", ffprobe: "ffprobe", dir: undefined });
}

export interface BinaryOutput {
  stdout: string;
  stderr: string;
}

/** Spawns a binary directly (args array, no shell) with a hard timeout; rejects with the stderr tail. */
export function runBinary(exe: string, args: readonly string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<BinaryOutput> {
  const { dir } = resolveFfmpegBinaries();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(exe, [...args], { cwd: dir, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start ${exe}: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`${exe} timed out after ${timeoutMs} ms${tail(stderr)}`));
      if (code !== 0) return reject(new Error(`${exe} exited with ${code ?? signal}${tail(stderr)}`));
      resolvePromise({ stdout, stderr });
    });
  });
}

function tail(stderr: string): string {
  const t = stderr.trim();
  return t ? `\n--- stderr ---\n${t.length > STDERR_TAIL_CHARS ? `...${t.slice(-STDERR_TAIL_CHARS)}` : t}` : "";
}

// ---------------------------------------------------------------------------------------------
// ffprobe
// ---------------------------------------------------------------------------------------------

const ProbeSchema = z.object({
  streams: z
    .array(
      z
        .object({
          codec_name: z.string().optional(),
          width: z.number().optional(),
          height: z.number().optional(),
          avg_frame_rate: z.string().optional(),
          r_frame_rate: z.string().optional(),
          duration: z.string().optional(),
          pix_fmt: z.string().optional(),
        })
        .loose(),
    )
    .default([]),
  format: z.object({ duration: z.string().optional(), size: z.string().optional() }).loose().optional(),
});

export interface ProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  pixFmt: string;
}

export async function probeVideo(path: string, timeoutMs = 60_000): Promise<ProbeResult> {
  const { ffprobe } = resolveFfmpegBinaries();
  const args = ["-v", "error", "-select_streams", "v:0", "-show_streams", "-show_format", "-of", "json", path];
  const { stdout } = await runBinary(ffprobe, args, timeoutMs);
  const parsed = ProbeSchema.parse(JSON.parse(stdout));
  const stream = parsed.streams[0];
  if (!stream?.width || !stream.height) throw new Error(`No video stream found in ${path}`);
  const duration = Number(parsed.format?.duration ?? stream.duration ?? 0);
  return {
    durationSeconds: Number.isFinite(duration) ? duration : 0,
    width: stream.width,
    height: stream.height,
    fps: parseRate(stream.avg_frame_rate) || parseRate(stream.r_frame_rate),
    codec: stream.codec_name ?? "unknown",
    pixFmt: stream.pix_fmt ?? "unknown",
  };
}

export function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [num, den] = rate.split("/").map(Number);
  if (num === undefined || !Number.isFinite(num)) return 0;
  if (den === undefined) return num;
  return den > 0 ? num / den : 0;
}

// ---------------------------------------------------------------------------------------------
// Normalization (pure arg building)
// ---------------------------------------------------------------------------------------------

export interface NormalizeTarget {
  width: number;
  height: number;
  fps: number;
  /** Maximum seconds kept from each clip. */
  maxSeconds: number;
}

export interface NormalizeWindow {
  skipSeconds: number;
  keepSeconds: number;
}

/** Skip min(1 s, 10% of the clip) to dodge fades/title cards, then keep up to maxSeconds. */
export function computeNormalizeWindow(sourceDurationSeconds: number, maxSeconds: number): NormalizeWindow {
  const duration = Number.isFinite(sourceDurationSeconds) && sourceDurationSeconds > 0 ? sourceDurationSeconds : 0;
  const skipSeconds = round3(Math.min(1, duration * 0.1));
  const remaining = duration > 0 ? duration - skipSeconds : maxSeconds;
  return { skipSeconds, keepSeconds: round3(Math.max(0, Math.min(maxSeconds, remaining))) };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Scale to cover the target frame, then center-crop. Remotion's trimmed ffmpeg build only ships a few
 * filters (no fps/setsar), so frame rate and square pixels are set with output options instead.
 */
export function coverCropFilter(width: number, height: number): string {
  return `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`;
}

export function buildVideoNormalizeArgs(
  input: string,
  output: string,
  sourceDurationSeconds: number,
  target: NormalizeTarget,
): string[] {
  const { skipSeconds, keepSeconds } = computeNormalizeWindow(sourceDurationSeconds, target.maxSeconds);
  return [
    "-hide_banner", "-nostdin", "-y", "-v", "error",
    ...(skipSeconds > 0 ? ["-ss", String(skipSeconds)] : []),
    "-i", input,
    "-t", String(keepSeconds),
    "-map", "0:v:0",
    "-vf", coverCropFilter(target.width, target.height),
    "-r", String(target.fps), "-fps_mode", "cfr",
    "-aspect", `${target.width}:${target.height}`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
    "-an", "-sn", "-dn", "-map_metadata", "-1",
    "-movflags", "+faststart",
    output,
  ];
}

/** Stills become a single cover-cropped JPEG at the target size (kind stays "image"). */
export function buildImageNormalizeArgs(input: string, output: string, target: Pick<NormalizeTarget, "width" | "height">): string[] {
  return [
    "-hide_banner", "-nostdin", "-y", "-v", "error",
    "-i", input,
    "-map", "0:v:0",
    "-vf", coverCropFilter(target.width, target.height),
    "-frames:v", "1", "-update", "1", "-q:v", "3",
    output,
  ];
}

// ---------------------------------------------------------------------------------------------
// Frame sampling (for the visual relevance gate)
// ---------------------------------------------------------------------------------------------

export const DEFAULT_FRAME_FRACTIONS: readonly number[] = [0.2, 0.5, 0.8];

/** Seconds at which to sample frames; stills (duration 0) get a single frame at 0. */
export function frameTimestamps(durationSeconds: number, fractions: readonly number[] = DEFAULT_FRAME_FRACTIONS): number[] {
  if (!(durationSeconds > 0)) return [0];
  return fractions.map((f) => round3(Math.min(Math.max(f, 0), 0.98) * durationSeconds));
}

/** One JPEG frame at `atSeconds`, fitted inside a maxSize x maxSize box. */
export function buildFrameExtractArgs(input: string, output: string, atSeconds: number, maxSize = 512): string[] {
  return [
    "-hide_banner", "-nostdin", "-y", "-v", "error",
    // "-ss 0" on a still-image input yields zero frames with this ffmpeg build, so only seek when needed.
    ...(atSeconds > 0 ? ["-ss", String(atSeconds)] : []),
    "-i", input,
    "-map", "0:v:0",
    "-frames:v", "1", "-update", "1",
    "-vf", `scale=${maxSize}:${maxSize}:force_original_aspect_ratio=decrease`,
    "-q:v", "4",
    output,
  ];
}

/** Extracts frames to `<outDir>/<baseName>_<i>.jpg`, returns their bytes and removes the files. */
export async function extractFrames(
  input: string,
  durationSeconds: number,
  outDir: string,
  baseName: string,
  fractions: readonly number[] = DEFAULT_FRAME_FRACTIONS,
): Promise<Buffer[]> {
  const { ffmpeg } = resolveFfmpegBinaries();
  await mkdir(outDir, { recursive: true });
  const frames: Buffer[] = [];
  for (const [i, at] of frameTimestamps(durationSeconds, fractions).entries()) {
    const output = join(outDir, `${baseName}_${i}.jpg`);
    await runBinary(ffmpeg, buildFrameExtractArgs(input, output, at), 60_000);
    if (existsSync(output)) frames.push(await readFile(output));
    await rm(output, { force: true });
  }
  if (frames.length === 0) throw new Error(`No frames could be extracted from ${input}`);
  return frames;
}
