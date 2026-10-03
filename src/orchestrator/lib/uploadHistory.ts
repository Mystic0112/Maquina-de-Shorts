import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { HISTORY_RELATIVE_PATH, isUploadRecord, readUploadHistory, type UploadRecord } from "../../shared/history.js";
import { paths } from "./config.js";

export function historyPath(): string {
  return paths.fromRoot(HISTORY_RELATIVE_PATH);
}

export const DAY_MS = 24 * 60 * 60 * 1000;

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

export async function readHistoryRecords(file = historyPath()): Promise<UploadRecord[]> {
  return (await readUploadHistory(file)).records;
}

/**
 * Appends one record atomically (tmp + rename). Existing entries are kept as-is, even ones the shared
 * validator would skip. An unreadable file is moved aside (history.json.corrupt-<ts>) instead of being
 * overwritten, so nothing is silently lost.
 */
export async function appendUploadRecord(record: UploadRecord, file = historyPath()): Promise<{ movedCorruptTo?: string }> {
  if (!isUploadRecord(record)) throw new Error("Refusing to write an invalid UploadRecord to the upload history");
  await mkdir(dirname(file), { recursive: true });
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
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  await rename(tmp, file);
  return movedCorruptTo ? { movedCorruptTo } : {};
}
