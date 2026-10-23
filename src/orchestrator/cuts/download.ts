/**
 * Source download with yt-dlp (no cookies/login) into data/cuts/sources/<channelId>/<videoId>/source.mp4,
 * re-encoded to H.264 when the codec is AV1 (OpenCV cannot decode AV1).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { minimalChildEnv } from "../lib/childEnv.js";
import { paths } from "../lib/config.js";
import { probeVideo, resolveFfmpegBinaries, runBinary } from "../lib/ffmpeg.js";
import type { CutsConfig } from "./config.js";

export const SOURCE_FILE = "source.mp4";
const TITLE_FILE = "title.txt";
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const REENCODE_TIMEOUT_MS = 60 * 60 * 1000;

export class LoginRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginRequiredError";
  }
}

export function sourceDir(channelId: string, videoId: string): string {
  return join(paths.data, "cuts", "sources", channelId, videoId);
}

export function videoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/** Page URL of a source video on its platform (YouTube watch page or TikTok post). */
export function sourceVideoUrl(channel: { platform: "youtube" | "tiktok"; id: string }, videoId: string): string {
  return channel.platform === "tiktok" ? `https://www.tiktok.com/${channel.id}/video/${videoId}` : videoUrl(videoId);
}

/** Accepts a full watch/shorts/youtu.be URL or a bare 11-char id. */
export function parseVideoId(input: string): string {
  const trimmed = input.trim();
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;
  const match = /(?:[?&]v=|youtu\.be\/|\/shorts\/|\/live\/)([\w-]{11})/.exec(trimmed);
  if (!match?.[1]) throw new Error(`Not a YouTube video URL or id: ${input}`);
  return match[1];
}

export function buildYtDlpArgs(
  url: string,
  outputPath: string,
  titlePath: string,
  maxHeight: number,
  platform: "youtube" | "tiktok" = "youtube",
  ffmpegDir = resolveFfmpegBinaries().dir,
): string[] {
  // TikTok serves muxed files (h264 or h265 "bytevc1"); YouTube splits video and audio.
  const format =
    platform === "tiktok"
      ? `b[vcodec^=h264][height<=${maxHeight}]/b[vcodec^=avc][height<=${maxHeight}]/b`
      : `bv*[vcodec^=avc1][height<=${maxHeight}]+ba[ext=m4a]/bv*[height<=${maxHeight}][ext=mp4]+ba[ext=m4a]/b[height<=${maxHeight}]`;
  return [
    "--no-playlist",
    "--no-update",
    "--no-cookies",
    "--no-progress",
    "-f",
    // H.264 first (OpenCV decodes it); AV1/HEVC only as a fallback, re-encoded afterwards by ensureH264.
    format,
    "--merge-output-format",
    "mp4",
    // The home PC has no ffmpeg on PATH: without this yt-dlp leaves .f137.mp4 + .f140.m4a unmerged.
    ...(ffmpegDir ? ["--ffmpeg-location", ffmpegDir] : []),
    "--print-to-file",
    "%(title)s",
    titlePath,
    "-o",
    outputPath,
    url,
  ];
}

const LOGIN_PATTERNS = [/sign in to confirm your age/i, /age-restricted/i, /login required/i, /cookies/i, /private video/i];

export function isLoginRequiredOutput(stderr: string): boolean {
  return LOGIN_PATTERNS.some((re) => re.test(stderr));
}

function runYtDlp(exe: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(exe, [...args], { cwd: paths.root, shell: false, windowsHide: true, env: minimalChildEnv() });
    let stderr = "";
    const timer = setTimeout(() => child.kill(), DOWNLOAD_TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (c: string) => (stderr += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start ${exe}: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolvePromise(stderr);
      if (isLoginRequiredOutput(stderr)) {
        return reject(new LoginRequiredError(`yt-dlp needs a login for this video (age/privacy gate); skipping`));
      }
      reject(new Error(`yt-dlp exited with ${code}:\n${stderr.slice(-3000)}`));
    });
  });
}

/** download.ytDlp: a name on PATH, or a path (relative paths start at the project root). */
export function ytDlpExecutable(config: CutsConfig["download"]): string {
  return config.ytDlp.includes("/") || config.ytDlp.includes("\\") ? paths.fromRoot(config.ytDlp) : config.ytDlp;
}

export interface DownloadedSource {
  path: string;
  title: string;
  codec: string;
  durationSeconds: number;
}

/** Downloads once (idempotent: a present source.mp4 is reused) and ensures an H.264 stream. */
export async function downloadSource(
  channelId: string,
  videoId: string,
  config: CutsConfig["download"],
  log: (message: string) => void,
  url = videoUrl(videoId),
  platform: "youtube" | "tiktok" = "youtube",
): Promise<DownloadedSource> {
  const dir = sourceDir(channelId, videoId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, SOURCE_FILE);
  const titlePath = join(dir, TITLE_FILE);
  if (!existsSync(path)) {
    const exe = ytDlpExecutable(config);
    log(`downloading ${url} (max ${config.maxHeight}p) with ${config.ytDlp}`);
    await runYtDlp(exe, buildYtDlpArgs(url, path, titlePath, config.maxHeight, platform));
  }
  await ensureH264(path, log);
  const probe = await probeVideo(path);
  const title = existsSync(titlePath) ? (await readFile(titlePath, "utf8")).trim() : videoId;
  return { path, title, codec: probe.codec, durationSeconds: probe.durationSeconds };
}

export function buildReencodeArgs(input: string, output: string): string[] {
  return ["-y", "-i", input, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "copy", output];
}

/** Codecs the cut renderer (OpenCV + the reduced ffmpeg) should not be trusted with: re-encoded to H.264. */
const REENCODE_CODECS = new Set(["av1", "hevc", "h265"]);

/** OpenCV cannot read AV1 (and HEVC support varies by build): re-encode in place to H.264. */
export async function ensureH264(path: string, log: (message: string) => void): Promise<void> {
  const probe = await probeVideo(path);
  if (!REENCODE_CODECS.has(probe.codec)) return;
  const { ffmpeg } = resolveFfmpegBinaries();
  const tmp = path.replace(/\.mp4$/, ".h264.mp4");
  log(`source is ${probe.codec}; re-encoding to H.264 (${Math.round(probe.durationSeconds)} s of video, this takes a while)`);
  await runBinary(ffmpeg, buildReencodeArgs(path, tmp), REENCODE_TIMEOUT_MS);
  await rename(tmp, path);
}
