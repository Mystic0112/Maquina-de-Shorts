import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { RunContext } from "../types.js";
import { paths } from "./config.js";

const CONTEXT_FILE = "context.json";

const RunContextHeaderSchema = z
  .object({
    runId: z.string().min(1),
    runDir: z.string(),
    createdAt: z.string(),
  })
  .loose();

/** e.g. 20261003-143012-a1b2 — sortable, filesystem-safe, unique enough for a few runs per day. */
export function generateRunId(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${date}-${time}-${randomBytes(2).toString("hex")}`;
}

export function runDirFor(runId: string): string {
  if (!/^[\w.-]+$/.test(runId)) throw new Error(`Invalid runId "${runId}"`);
  return join(paths.renderOutput, runId);
}

export async function createRunContext(): Promise<RunContext> {
  const runId = generateRunId();
  const runDir = runDirFor(runId);
  await mkdir(runDir, { recursive: true });
  const ctx: RunContext = { runId, runDir, createdAt: new Date().toISOString() };
  await saveRunContext(ctx);
  return ctx;
}

export async function loadRunContext(runId: string): Promise<RunContext> {
  const runDir = runDirFor(runId);
  const file = join(runDir, CONTEXT_FILE);
  if (!existsSync(file)) throw new Error(`No ${CONTEXT_FILE} for run "${runId}" (expected at ${file})`);
  const ctx = await readContextFile(file);
  // The run folder on disk is the source of truth (the project may have moved since the run started).
  return { ...ctx, runId, runDir };
}

export async function readContextFile(file: string): Promise<RunContext> {
  const raw: unknown = JSON.parse(await readFile(file, "utf8"));
  const result = RunContextHeaderSchema.safeParse(raw);
  if (!result.success) throw new Error(`Invalid run context in ${file}:\n${z.prettifyError(result.error)}`);
  return result.data as RunContext;
}

/** Atomic write (tmp + rename) so a crash never leaves a truncated context.json behind. */
export async function saveRunContext(ctx: RunContext): Promise<void> {
  await mkdir(ctx.runDir, { recursive: true });
  const file = join(ctx.runDir, CONTEXT_FILE);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(ctx, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}
