import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rm, stat, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

export interface LockOptions {
  /** A lock file older than this is considered abandoned (crashed holder) and is taken over. */
  staleMs: number;
  /** Give up waiting after this long. */
  waitMs: number;
  pollMs?: number;
}

export class LockTimeoutError extends Error {}

/**
 * Exclusive lock via an O_EXCL lock file ("wx"). Works across processes on the same machine (the
 * scheduler and a manual `npm run stage` can't interleave). Stale locks are removed by mtime age.
 */
export async function withFileLock<T>(lockPath: string, options: LockOptions, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  const started = Date.now();
  const pollMs = options.pollMs ?? 50;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await isStale(lockPath, options.staleMs)) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() - started > options.waitMs) {
        throw new LockTimeoutError(`Timed out after ${options.waitMs} ms waiting for lock ${lockPath}`);
      }
      await new Promise((r) => setTimeout(r, pollMs + Math.random() * pollMs));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true });
  }
}

async function isStale(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs > staleMs;
  } catch {
    return false; // vanished between open and stat: just retry
  }
}

/** Unique temp name per writer, so concurrent writers never clobber each other's tmp file. */
export function uniqueTmpPath(file: string): string {
  return `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
}

/** Atomic text write: unique tmp + rename. */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = uniqueTmpPath(file);
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

export async function readJsonIfExists(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
