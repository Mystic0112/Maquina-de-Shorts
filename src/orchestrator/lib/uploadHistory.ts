import { existsSync } from "node:fs";
import { readFile, rename } from "node:fs/promises";
import { HISTORY_RELATIVE_PATH, isUploadRecord, readUploadHistory, type UploadRecord } from "../../shared/history.js";
import { paths } from "./config.js";
import { withFileLock, writeFileAtomic } from "./fileLock.js";

export function historyPath(): string {
  return paths.fromRoot(HISTORY_RELATIVE_PATH);
}

/** Held across "read cap -> upload -> append history" so two processes can't both pass the cap check. */
export function uploadLockPath(): string {
  return paths.fromRoot("data", "upload.lock");
}

export const DAY_MS = 24 * 60 * 60 * 1000;
/** History writes are fast; a lock older than this belongs to a crashed process. */
const HISTORY_LOCK = { staleMs: 60_000, waitMs: 30_000 } as const;
/** Uploads can take a while; beyond this the holder is assumed dead. */
export const UPLOAD_LOCK = { staleMs: 3 * 60 * 60 * 1000, waitMs: 10 * 60 * 1000 } as const;

export class HistoryUnreadableError extends Error {}

export interface DailyCapCheck {
  allowed: boolean;
  /** Uploads in the rolling 24 h window ending at `now`. */
  count: number;
  max: number;
  /** When the oldest upload in the window leaves it (only when blocked). */
  nextSlotAt?: string;
}

/** Pure: rolling-24h upload cap. */
export function checkDailyCap(records: readonly UploadRecord[], maxPerDay: number, now: Date = new Date()): DailyCapCheck {
  const windowStart = now.getTime() - DAY_MS;
  const recent = records
    .map((r) => Date.parse(r.publishedAt))
    .filter((t) => Number.isFinite(t) && t > windowStart && t <= now.getTime())
    .sort((a, b) => a - b);
  if (recent.length < maxPerDay) return { allowed: true, count: recent.length, max: maxPerDay };
  const oldestBlocking = recent[recent.length - maxPerDay] ?? recent[0] ?? now.getTime();
  return { allowed: false, count: recent.length, max: maxPerDay, nextSlotAt: new Date(oldestBlocking + DAY_MS).toISOString() };
}

/**
 * Strict read for the upload path (fail-closed): a missing file is an empty history, but a file that
 * exists and is unreadable or holds invalid entries throws, because the daily cap and the duplicate
 * check would otherwise silently pass.
 */
export async function readHistoryRecords(file = historyPath()): Promise<UploadRecord[]> {
  const read = await readUploadHistory(file);
  if (read.errors.length > 0) {
    throw new HistoryUnreadableError(
      `Upload history ${file} is unreadable or has invalid entries (${read.errors.slice(0, 3).join("; ")}). ` +
        "Uploads are blocked until it is fixed (restore it or remove the bad entries).",
    );
  }
  return read.records;
}

/**
 * Appends one record under an exclusive lock (read-modify-write cannot interleave across processes) and
 * writes atomically with a unique tmp name. Existing entries are kept as-is. An unreadable file is moved
 * aside (history.json.corrupt-<ts>) instead of being overwritten, so nothing is silently lost.
 */
export async function appendUploadRecord(record: UploadRecord, file = historyPath()): Promise<{ movedCorruptTo?: string }> {
  if (!isUploadRecord(record)) throw new Error("Refusing to write an invalid UploadRecord to the upload history");
  return withFileLock(`${file}.lock`, HISTORY_LOCK, async () => {
    let entries: unknown[] = [];
    let movedCorruptTo: string | undefined;
    if (existsSync(file)) {
      try {
        const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
        if (!Array.isArray(parsed)) throw new Error("not an array");
        entries = parsed;
      } catch {
        movedCorruptTo = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        await rename(file, movedCorruptTo);
      }
    }
    entries.push(record);
    await writeFileAtomic(file, `${JSON.stringify(entries, null, 2)}\n`);
    return movedCorruptTo ? { movedCorruptTo } : {};
  });
}
