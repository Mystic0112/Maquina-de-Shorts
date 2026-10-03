import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./config.js";
import { redactSecrets } from "./redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  readonly filePath: string;
}

const consoleLevels: ReadonlySet<LogLevel> = new Set(
  process.env.LOG_LEVEL === "debug" ? ["debug", "info", "warn", "error"] : ["info", "warn", "error"],
);

const loggers = new Map<string, Logger>();

/**
 * One logger per run: console (debug hidden unless LOG_LEVEL=debug) + append to logs/<runId>.log.
 * Sync appends keep line order intact even when the process dies mid-stage.
 */
export function getLogger(runId: string): Logger {
  const existing = loggers.get(runId);
  if (existing) return existing;
  const logger = createLogger(runId);
  loggers.set(runId, logger);
  return logger;
}

function createLogger(runId: string): Logger {
  mkdirSync(paths.logs, { recursive: true });
  const filePath = join(paths.logs, `${runId}.log`);
  const write = (level: LogLevel, message: string): void => {
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${redactSecrets(message)}`;
    appendFileSync(filePath, `${line}\n`, "utf8");
    if (!consoleLevels.has(level)) return;
    const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
    stream.write(`${line}\n`);
  };
  return {
    filePath,
    debug: (m) => write("debug", m),
    info: (m) => write("info", m),
    warn: (m) => write("warn", m),
    error: (m) => write("error", m),
  };
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return redactSecrets(error.stack ?? `${error.name}: ${error.message}`);
  return redactSecrets(String(error));
}
