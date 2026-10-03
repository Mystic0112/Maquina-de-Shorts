import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { HISTORY_RELATIVE_PATH, readUploadHistory, type UploadRecord } from "../../shared/history.js";
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

/** Pure: topic category of the most recent upload (data/history.json, written by 08-uploadYouTube). */
export function lastTopicCategory(records: readonly UploadRecord[]): string | undefined {
  const latest = [...records].sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt)).at(-1);
  return latest && latest.topicCategoryId !== "unknown" ? latest.topicCategoryId : undefined;
}

/** Last used topic category, or undefined without usable history (a missing/invalid file never blocks a run). */
export async function readLastCategoryId(historyFile: string = paths.fromRoot(HISTORY_RELATIVE_PATH)): Promise<string | undefined> {
  return lastTopicCategory((await readUploadHistory(historyFile)).records);
}

export async function run(ctx: RunContext): Promise<RunContext> {
  const log = getLogger(ctx.runId);
  const lastCategoryId = await readLastCategoryId();
  const avoid = ctx.avoid?.topics ?? [];
  const topic = pickTopic(loadSeed(), lastCategoryId, Math.random, avoid);
  const notes = [
    lastCategoryId ? `last category "${lastCategoryId}"` : "",
    avoid.length ? `${avoid.length} failed topic(s)` : "",
  ].filter(Boolean);
  log.info(`Topic: [${topic.categoryLabel}] ${topic.seedPrompt}${notes.length ? ` (avoiding ${notes.join(", ")})` : ""}`);
  return { ...ctx, topic };
}
