import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const dashboardDir = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
export const projectRoot = resolve(dashboardDir, "..");

export const paths = {
  renderOutput: join(projectRoot, "render_output"),
  logs: join(projectRoot, "logs"),
  history: join(projectRoot, "data", "history.json"),
  topicsConfig: join(projectRoot, "config", "topics.seed.json"),
  pipelineConfig: join(projectRoot, "config", "pipeline.config.json"),
  snapshots: join(projectRoot, "data", "metrics", "snapshots.jsonl"),
  clientDist: join(dashboardDir, "dist", "client"),
} as const;

/** Reads the root .env without touching process.env, so secrets stay inside this module's consumers. */
function readRootEnv(): Record<string, string | undefined> {
  try {
    return parseEnv(readFileSync(join(projectRoot, ".env"), "utf8"));
  } catch {
    return {};
  }
}

const rootEnv = readRootEnv();

/** process.env wins over the root .env (handy for one-off overrides). */
function env(name: string): string | undefined {
  const value = process.env[name] ?? rootEnv[name];
  return value?.trim() ? value.trim() : undefined;
}

/** For the Configurações page: whether a variable is set, never its value. */
export const envIsSet = (name: string): boolean => env(name) !== undefined;
/** Non-secret values only (e.g. file paths like YT_TOKEN_PATH). */
export const envValue = (name: string): string | undefined => env(name);

function positiveNumber(name: string, fallback: number): number {
  const parsed = Number(env(name));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  host: "127.0.0.1",
  port: positiveNumber("DASHBOARD_PORT", 5180),
  production: process.argv.includes("--prod"),
  youtube: {
    apiKey: env("YOUTUBE_API_KEY"),
    channelId: env("YOUTUBE_CHANNEL_ID"),
    refreshIntervalMs: positiveNumber("DASHBOARD_YT_REFRESH_MINUTES", 30) * 60_000,
    manualMinIntervalMs: 60_000,
  },
  /**
   * Reference USD prices per million tokens for the LLM cost ESTIMATE. Defaults follow Google's public
   * Gemini Flash list price (input 0.30, output incl. thinking 2.50); override in .env when they change.
   */
  llmPricing: {
    inputUsdPerMTok: positiveNumber("DASHBOARD_LLM_PRICE_INPUT_USD_PER_MTOK", 0.3),
    outputUsdPerMTok: positiveNumber("DASHBOARD_LLM_PRICE_OUTPUT_USD_PER_MTOK", 2.5),
    configured: !!env("DASHBOARD_LLM_PRICE_INPUT_USD_PER_MTOK") || !!env("DASHBOARD_LLM_PRICE_OUTPUT_USD_PER_MTOK"),
  },
} as const;
