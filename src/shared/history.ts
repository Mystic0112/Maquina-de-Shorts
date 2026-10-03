// Upload history: data/history.json, written by the upload stage (one entry per published video) and
// read by the dashboard. Dependency-free on purpose so any package (pipeline, dashboard) can import it.

import { readFile } from "node:fs/promises";
import { PLATFORMS, type Platform } from "./platforms.js";

export const HISTORY_RELATIVE_PATH = "data/history.json";

export const PRIVACY_STATUSES = ["public", "unlisted", "private"] as const;
export type PrivacyStatus = (typeof PRIVACY_STATUSES)[number];
/** Actual status may be "unknown" when the post-upload videos.list lookup failed. */
export type ActualPrivacyStatus = PrivacyStatus | "unknown";

export { PLATFORMS, type Platform };

export interface UploadRecord {
  /** Where it was published; absent in records written before multi-platform support = "youtube". */
  platform?: Platform;
  /** Pipeline run that produced the video (render_output/<runId>). */
  runId: string;
  /** YouTube video id returned by videos.insert. */
  videoId: string;
  title: string;
  /** ISO 8601 timestamp of the upload. */
  publishedAt: string;
  /** Status YouTube actually applied (unverified API projects force "private"); "unknown" if not read. */
  privacyStatus: ActualPrivacyStatus;
  /** Status the pipeline asked for. */
  requestedPrivacyStatus: PrivacyStatus;
  /** YouTube category id, e.g. "27" (Education). */
  categoryId: string;
  /** Pipeline topic category (TopicPick.categoryId), e.g. "espaco". */
  topicCategoryId: string;
}

/** The whole file: a JSON array of UploadRecord. */
export type UploadHistory = UploadRecord[];

export interface UploadHistoryRead {
  /** False when data/history.json does not exist yet (no upload has happened). */
  exists: boolean;
  records: UploadRecord[];
  /** Problems found (invalid JSON, malformed entries). Malformed entries are skipped, never thrown. */
  errors: string[];
}

const STRING_FIELDS = ["runId", "videoId", "title", "publishedAt", "categoryId", "topicCategoryId"] as const;

function isPrivacyStatus(value: unknown): value is PrivacyStatus {
  return typeof value === "string" && (PRIVACY_STATUSES as readonly string[]).includes(value);
}

/** Returns the problems with one entry; an empty array means it is a valid UploadRecord. */
export function validateUploadRecord(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["not an object"];
  const entry = value as Record<string, unknown>;
  const problems: string[] = [];
  for (const field of STRING_FIELDS) {
    if (typeof entry[field] !== "string" || entry[field] === "") problems.push(`${field} must be a non-empty string`);
  }
  if (typeof entry.publishedAt === "string" && Number.isNaN(Date.parse(entry.publishedAt))) {
    problems.push("publishedAt must be an ISO date");
  }
  if (!isPrivacyStatus(entry.privacyStatus) && entry.privacyStatus !== "unknown") {
    problems.push(`privacyStatus must be one of ${PRIVACY_STATUSES.join("|")}|unknown`);
  }
  if (entry.platform !== undefined && !(PLATFORMS as readonly unknown[]).includes(entry.platform)) {
    problems.push(`platform must be one of ${PLATFORMS.join("|")}`);
  }
  if (!isPrivacyStatus(entry.requestedPrivacyStatus)) {
    problems.push(`requestedPrivacyStatus must be one of ${PRIVACY_STATUSES.join("|")}`);
  }
  return problems;
}

/** Platform of a record ("youtube" for records written before the field existed). */
export function recordPlatform(record: Pick<UploadRecord, "platform">): Platform {
  return record.platform ?? "youtube";
}

export function isUploadRecord(value: unknown): value is UploadRecord {
  return validateUploadRecord(value).length === 0;
}

/** Validates already-parsed JSON; keeps the valid entries and reports the rest. */
export function parseUploadHistory(raw: unknown): { records: UploadRecord[]; errors: string[] } {
  if (!Array.isArray(raw)) return { records: [], errors: ["history must be a JSON array"] };
  const records: UploadRecord[] = [];
  const errors: string[] = [];
  raw.forEach((entry: unknown, index) => {
    const problems = validateUploadRecord(entry);
    if (problems.length === 0) records.push(entry as UploadRecord);
    else errors.push(`entry ${index}: ${problems.join("; ")}`);
  });
  return { records, errors };
}

/** Reads and validates data/history.json. Never throws: a missing file is a normal empty state. */
export async function readUploadHistory(filePath: string): Promise<UploadHistoryRead> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { exists: !missing, records: [], errors: missing ? [] : [`cannot read history: ${String(error)}`] };
  }
  try {
    return { exists: true, ...parseUploadHistory(JSON.parse(text) as unknown) };
  } catch (error) {
    return { exists: true, records: [], errors: [`invalid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
