import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

const PACKAGE_NAME = "maquina-de-fazer-dinheiro";

/**
 * Walks up from this file until it finds the project's package.json. Independent of process.cwd(),
 * so the pipeline works no matter where it is launched from (scheduler, IDE, another folder).
 */
function findProjectRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath) && readPackageName(pkgPath) === PACKAGE_NAME) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not locate project root (package.json named "${PACKAGE_NAME}") above ${startDir}`);
    }
    dir = parent;
  }
}

function readPackageName(pkgPath: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
    return z.object({ name: z.string() }).safeParse(parsed).data?.name;
  } catch {
    // Unreadable/invalid package.json is not ours; keep walking up.
    return undefined;
  }
}

export const projectRoot: string = findProjectRoot(dirname(fileURLToPath(import.meta.url)));

export const paths = {
  root: projectRoot,
  config: join(projectRoot, "config"),
  data: join(projectRoot, "data"),
  logs: join(projectRoot, "logs"),
  renderOutput: join(projectRoot, "render_output"),
  /** Resolves a project-relative path (forward slashes allowed) to an absolute path. */
  fromRoot: (...segments: string[]): string => resolve(projectRoot, ...segments),
} as const;

dotenv.config({ path: join(projectRoot, ".env"), quiet: true });

const PipelineConfigSchema = z.object({
  video: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().positive(),
    minSeconds: z.number().positive(),
    maxSeconds: z.number().positive(),
  }),
  voice: z.object({
    engine: z.string(),
    name: z.string().min(1),
    language: z.string().min(1),
    rate: z.string().regex(/^[+-]\d+%$/).optional(),
  }),
  upload: z
    .object({
      privacyStatus: z.enum(["private", "unlisted", "public"]),
      categoryId: z.string(),
      maxUploadsPerDay: z.number().int().nonnegative(),
    })
    .loose(),
  pipeline: z
    .object({
      /** Extra topic/script attempts after a quality-gate failure; default 2. */
      maxScriptAttempts: z.number().int().nonnegative().optional(),
    })
    .optional(),
  footage: z
    .object({
      sources: z.array(z.string()).optional(),
      clipsPerQuery: z.number().int().positive().optional(),
      minDurationSeconds: z.number().positive().optional(),
      /** Media kinds requested from the adapter; default ["video", "image"]. */
      kinds: z.array(z.enum(["video", "image"])).min(1).optional(),
      /** Run-level gate: fraction of scenes that must have a passing clip; default 0.6. */
      minPassingSceneRatio: z.number().min(0).max(1).optional(),
      relevance: z
        .object({
          /** false skips the LLM vision gate (debugging); default true. */
          enabled: z.boolean().optional(),
          /** Minimum 0-10 score for a clip to pass; default 6. */
          minScore: z.number().min(0).max(10).optional(),
          /** Last-resort floor for below-threshold clips; default 4. */
          fallbackMinScore: z.number().min(0).max(10).optional(),
          /** Clips kept per scene among those that pass; default 2. */
          keepPerScene: z.number().int().positive().optional(),
          /** Parallel vision calls; default 4 (rate-limit errors back off and retry). */
          concurrency: z.number().int().positive().optional(),
          /** Reasoning effort for scoring calls; default "minimal" (lowest Gemini level). */
          thinking: z.enum(["default", "minimal", "low", "medium", "high"]).optional(),
        })
        .optional(),
    })
    .optional(),
});

export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;

let cachedConfig: PipelineConfig | undefined;

export function loadConfig(): PipelineConfig {
  if (cachedConfig) return cachedConfig;
  const configPath = join(paths.config, "pipeline.config.json");
  const raw: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  const result = PipelineConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid ${configPath}:\n${z.prettifyError(result.error)}`);
  }
  cachedConfig = result.data;
  return cachedConfig;
}

/** Reads a trimmed env var, treating empty strings as unset. */
export function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}
