// Lazy thumbnails: one JPEG frame (~2 s in) per rendered video, cached next to it as
// render_output/<runId>/thumb.jpg. Generation runs in the background, one ffmpeg at a time, so API
// requests never wait for it; the UI shows a placeholder until the file appears.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveFfmpegBinaries } from "../../src/orchestrator/lib/ffmpeg.js";

/** Remotion's bundled ffmpeg for this platform (Windows/Linux/macOS), else ffmpeg on PATH. */
const { ffmpeg: FFMPEG, dir: FFMPEG_DIR } = resolveFfmpegBinaries();
const RETRY_AFTER_FAILURE_MS = 10 * 60_000;
const TIMEOUT_MS = 30_000;

const queue: string[] = []; // video paths waiting for a thumbnail
const failedAt = new Map<string, number>();
let working = false;

export const thumbPathFor = (videoPath: string): string => join(dirname(videoPath), "thumb.jpg");

function runFfmpeg(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    // cwd = ffmpeg's folder so Windows finds the DLLs that sit next to the exe.
    const child = spawn(FFMPEG, args, { cwd: FFMPEG_DIR, stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.on("error", () => resolve(false));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

async function generate(videoPath: string): Promise<boolean> {
  const target = thumbPathFor(videoPath);
  const tmp = `${target}.tmp.jpg`;
  const frameAt = async (seconds: number): Promise<boolean> => {
    const ok = await runFfmpeg([
      "-hide_banner", "-loglevel", "error", "-y",
      "-ss", String(seconds), "-i", videoPath,
      "-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "4", tmp,
    ]);
    return ok && existsSync(tmp);
  };
  // Very short videos have no frame at 2 s: fall back to the first frame.
  const ok = (await frameAt(2)) || (await frameAt(0));
  if (!ok) {
    await rm(tmp, { force: true });
    return false;
  }
  await rename(tmp, target); // atomic swap: readers never see a half-written JPEG
  return true;
}

async function drain(): Promise<void> {
  if (working) return;
  working = true;
  try {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const ok = await generate(next).catch(() => false);
      if (ok) failedAt.delete(next);
      else failedAt.set(next, Date.now());
    }
  } finally {
    working = false;
  }
}

const mtime = (file: string): Promise<number | null> => stat(file).then((s) => s.mtimeMs, () => null);

/**
 * Returns the thumbnail's mtime (usable as a cache-buster) when thumb.jpg exists, else null.
 * A missing or stale thumbnail (video re-rendered) is scheduled for background generation.
 */
export async function ensureThumbnail(videoPath: string): Promise<number | null> {
  const [thumbMtime, videoMtime] = await Promise.all([mtime(thumbPathFor(videoPath)), mtime(videoPath)]);
  const stale = videoMtime !== null && (thumbMtime === null || thumbMtime < videoMtime);
  const lastFailure = failedAt.get(videoPath);
  const backingOff = lastFailure !== undefined && Date.now() - lastFailure < RETRY_AFTER_FAILURE_MS;
  // A bare "ffmpeg" (PATH fallback) cannot be stat'ed; a missing binary then fails at spawn and backs off.
  const available = FFMPEG_DIR === undefined || existsSync(FFMPEG);
  if (stale && !backingOff && available && !queue.includes(videoPath)) {
    queue.push(videoPath);
    void drain();
  }
  return thumbMtime;
}
