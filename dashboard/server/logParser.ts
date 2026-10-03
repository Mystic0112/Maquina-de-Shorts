// Parses logs/<runId>.log, written by src/orchestrator/lib/logger.ts:
//   2026-10-03T03:30:38.453Z [INFO] Run <id> (<mode>) -> <dir>
//   ... [INFO] >> 03-fetchFootage started
//   ... [INFO] << 03-fetchFootage done in 50.2 s        (or "in 20 ms")
//   ... [ERROR] xx 06-renderVideo failed after 61.7 s: Error: ...   (may continue on untimestamped lines)
//   ... [INFO] -- 01-pickTopic skipped (output already present)
//   ... [INFO] Run <id> finished through 06-renderVideo in 208.3 s
import { STAGE_NAMES, type StageName } from "../shared/api.js";

export type LogEvent =
  | { kind: "run-start"; at: string; mode: string }
  | { kind: "run-finished"; at: string; stage: StageName }
  | { kind: "started"; at: string; stage: StageName }
  | { kind: "done"; at: string; stage: StageName; durationMs: number }
  | { kind: "failed"; at: string; stage: StageName; durationMs: number; message: string }
  | { kind: "skipped"; at: string; stage: StageName };

export interface ParsedLog {
  events: LogEvent[];
  firstAt: string | null;
  lastAt: string | null;
}

const LINE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) \[(\w+)\] (.*)$/;
const DURATION = String.raw`([\d.]+) (ms|s)`;
const PATTERNS = {
  runStart: /^Run \S+ \((.+?)\) -> /,
  runFinished: /^Run \S+ finished through (\S+) in /,
  started: /^>> (\S+) started$/,
  done: new RegExp(String.raw`^<< (\S+) done in ${DURATION}`),
  failed: new RegExp(String.raw`^xx (\S+) failed after ${DURATION}: ?(.*)$`),
  skipped: /^-- (\S+) skipped/,
};
const MAX_ERROR_CHARS = 2000;

function toMs(value: string, unit: string): number {
  const n = Number(value);
  return unit === "ms" ? n : Math.round(n * 1000);
}

function asStage(name: string | undefined): StageName | null {
  return (STAGE_NAMES as readonly string[]).includes(name ?? "") ? (name as StageName) : null;
}

export function parseRunLog(text: string): ParsedLog {
  const events: LogEvent[] = [];
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  let openFailure: Extract<LogEvent, { kind: "failed" }> | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = LINE.exec(rawLine);
    if (!line) {
      // Untimestamped line: continuation of a multi-line error message.
      if (openFailure && rawLine.trim() && openFailure.message.length < MAX_ERROR_CHARS) {
        openFailure.message = `${openFailure.message}\n${rawLine}`.slice(0, MAX_ERROR_CHARS);
      }
      continue;
    }
    openFailure = null;
    const [, at = "", , message = ""] = line;
    firstAt ??= at;
    lastAt = at;

    let m: RegExpExecArray | null;
    if ((m = PATTERNS.runFinished.exec(message))) {
      const stage = asStage(m[1]);
      if (stage) events.push({ kind: "run-finished", at, stage });
    } else if ((m = PATTERNS.runStart.exec(message))) {
      events.push({ kind: "run-start", at, mode: m[1] ?? "" });
    } else if ((m = PATTERNS.started.exec(message))) {
      const stage = asStage(m[1]);
      if (stage) events.push({ kind: "started", at, stage });
    } else if ((m = PATTERNS.done.exec(message))) {
      const stage = asStage(m[1]);
      if (stage) events.push({ kind: "done", at, stage, durationMs: toMs(m[2] ?? "0", m[3] ?? "ms") });
    } else if ((m = PATTERNS.failed.exec(message))) {
      const stage = asStage(m[1]);
      if (stage) {
        openFailure = { kind: "failed", at, stage, durationMs: toMs(m[2] ?? "0", m[3] ?? "ms"), message: m[4] ?? "" };
        events.push(openFailure);
      }
    } else if ((m = PATTERNS.skipped.exec(message))) {
      const stage = asStage(m[1]);
      if (stage) events.push({ kind: "skipped", at, stage });
    }
  }
  return { events, firstAt, lastAt };
}
