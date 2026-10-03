import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { paths } from "../lib/config.js";
import { getLogger } from "../lib/logger.js";
import type { RunContext, TopicAvoidance, TopicPick } from "../types.js";

const TopicsSeedSchema = z.object({
  categories: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        prompts: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
});

export type TopicsSeed = z.infer<typeof TopicsSeedSchema>;

/** history.json is written by a later (upload) stage; accept an array or { entries: [...] }. */
const HistoryEntrySchema = z.object({ categoryId: z.string().optional() }).loose();
const HistorySchema = z.union([
  z.array(HistoryEntrySchema),
  z.object({ entries: z.array(HistoryEntrySchema) }).loose(),
]);

export type RandomFn = () => number;

type Category = TopicsSeed["categories"][number];

/**
 * Random category + seed prompt. Never repeats an avoided (category, seed) pair when any other pair exists;
 * prefers categories that neither failed this invocation nor were used by the previous video.
 */
export function pickTopic(
  seed: TopicsSeed,
  lastCategoryId: string | undefined,
  random: RandomFn = Math.random,
  avoid: TopicAvoidance["topics"] = [],
): TopicPick {
  const isAvoided = (c: Category, prompt: string): boolean =>
    avoid.some((a) => a.categoryId === c.id && a.seedPrompt === prompt);
  const failedCategories = new Set(avoid.map((a) => a.categoryId));
  const open = seed.categories
    .map((c) => ({ ...c, prompts: c.prompts.filter((p) => !isAvoided(c, p)) }))
    .filter((c) => c.prompts.length > 0);
  const tiers = [
    open.filter((c) => !failedCategories.has(c.id) && c.id !== lastCategoryId),
    open.filter((c) => !failedCategories.has(c.id)),
    open.filter((c) => c.id !== lastCategoryId),
    open,
    seed.categories,
  ];
  const pool = tiers.find((t) => t.length > 0) ?? seed.categories;
  const category = pickOne(pool, random);
  return { categoryId: category.id, categoryLabel: category.label, seedPrompt: pickOne(category.prompts, random) };
}

function pickOne<T>(items: readonly T[], random: RandomFn): T {
  const item = items[Math.floor(random() * items.length)] ?? items[0];
  if (item === undefined) throw new Error("Cannot pick from an empty list");
  return item;
}

function loadSeed(): TopicsSeed {
  const file = join(paths.config, "topics.seed.json");
  const result = TopicsSeedSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!result.success) throw new Error(`Invalid ${file}:\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** Last used category, or undefined when there is no usable history (missing/invalid file is fine). */
export function readLastCategoryId(historyFile: string = join(paths.data, "history.json")): string | undefined {
  if (!existsSync(historyFile)) return undefined;
  try {
    const parsed = HistorySchema.safeParse(JSON.parse(readFileSync(historyFile, "utf8")));
    if (!parsed.success) return undefined;
    const entries = Array.isArray(parsed.data) ? parsed.data : parsed.data.entries;
    return [...entries].reverse().find((e) => e.categoryId)?.categoryId;
  } catch {
    // Corrupt history must never block a run; it only steers variety.
    return undefined;
  }
}

export async function run(ctx: RunContext): Promise<RunContext> {
  const log = getLogger(ctx.runId);
  const lastCategoryId = readLastCategoryId();
  const avoid = ctx.avoid?.topics ?? [];
  const topic = pickTopic(loadSeed(), lastCategoryId, Math.random, avoid);
  const notes = [
    lastCategoryId ? `last category "${lastCategoryId}"` : "",
    avoid.length ? `${avoid.length} failed topic(s)` : "",
  ].filter(Boolean);
  log.info(`Topic: [${topic.categoryLabel}] ${topic.seedPrompt}${notes.length ? ` (avoiding ${notes.join(", ")})` : ""}`);
  return { ...ctx, topic };
}
