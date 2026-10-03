import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
 * Error codes meaning "someone else has (or is releasing) the lock right now". On Windows, creating a
 * file whose previous incarnation is still delete-pending fails with EPERM/EACCES rather than EEXIST.
 */
const BUSY_CODES = new Set(["EEXIST", "EPERM", "EACCES", "EBUSY"]);
/** The short-lived takeover guard is itself considered abandoned after this. */
const TAKEOVER_STALE_MS = 30_000;

function isBusy(error: unknown): boolean {
  return BUSY_CODES.has((error as NodeJS.ErrnoException).code ?? "");
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Creates `path` exclusively with `content`; false when it already exists (or is being deleted). */
async function tryCreate(path: string, content: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, "wx");
  } catch (error) {
    if (isBusy(error)) return false;
    throw error;
  }
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
  return true;
}

async function isStale(path: string, staleMs: number): Promise<boolean> {
  try {
    return Date.now() - (await stat(path)).mtimeMs > staleMs;
  } catch {
    return false; // gone or delete-pending: not ours to judge, just retry
  }
}

async function readToken(path: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && "token" in parsed ? String((parsed as { token: unknown }).token) : undefined;
  } catch {
    return undefined;
  }
}

async function removeQuietly(path: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    try {
      await rm(path, { force: true });
      return;
    } catch (error) {
      if (!isBusy(error)) return;
      await sleep(10 * (i + 1));
    }
  }
}

/**
 * Removes an abandoned lock. Only one process at a time may do this (guarded by "<lock>.takeover",
 * itself created exclusively), and it re-checks staleness while holding the guard, so a fresh lock that
 * another waiter has just created is never deleted. Afterwards everyone races the normal "wx" create.
 */
async function takeOverStale(lockPath: string, staleMs: number, token: string): Promise<void> {
  const guard = `${lockPath}.takeover`;
  if (!(await tryCreate(guard, JSON.stringify({ token, at: new Date().toISOString() })))) {
    if (await isStale(guard, TAKEOVER_STALE_MS)) await removeQuietly(guard);
    return;
  }
  try {
    if (await isStale(lockPath, staleMs)) await removeQuietly(lockPath);
  } finally {
    await removeQuietly(guard);
  }
}

/** Releases the lock only if it still carries our token (a takeover may have replaced it). */
async function release(lockPath: string, token: string): Promise<void> {
  if ((await readToken(lockPath)) === token) await removeQuietly(lockPath);
}

/**
 * Exclusive cross-process lock via an O_EXCL lock file holding an owner token. Busy/delete-pending errors
 * mean "wait"; abandoned locks (older than staleMs) are taken over by one waiter at a time.
 */
export async function withFileLock<T>(lockPath: string, options: LockOptions, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  const token = randomBytes(12).toString("hex");
  const content = JSON.stringify({ token, pid: process.pid, at: new Date().toISOString() });
  const started = Date.now();
  const pollMs = options.pollMs ?? 50;
  while (!(await tryCreate(lockPath, content))) {
    if (await isStale(lockPath, options.staleMs)) {
      await takeOverStale(lockPath, options.staleMs, token);
      continue;
    }
    if (Date.now() - started > options.waitMs) {
      throw new LockTimeoutError(`Timed out after ${options.waitMs} ms waiting for lock ${lockPath}`);
    }
    await sleep(pollMs + Math.random() * pollMs);
  }
  try {
    return await fn();
  } finally {
    await release(lockPath, token);
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
