/**
 * data/datasets/viral/shorts.jsonl (from collect_shorts_stats.ts) -> train.jsonl + eval.jsonl for `laya train`.
 *   npx tsx scripts/build_viral_dataset.ts
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../src/orchestrator/lib/config.js";
import { buildLayaSets, type ShortStat } from "../src/orchestrator/viral/shortsStats.js";

const DIR = join(paths.root, "data", "datasets", "viral");
const rows = (await readFile(join(DIR, "shorts.jsonl"), "utf8"))
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as ShortStat);
const { train, eval: evalRows } = buildLayaSets(rows);
const jsonl = (items: unknown[]) => items.map((i) => JSON.stringify(i)).join("\n") + "\n";
await writeFile(join(DIR, "train.jsonl"), jsonl(train));
await writeFile(join(DIR, "eval.jsonl"), jsonl(evalRows));
const pos = (items: { gold: { viral: boolean } }[]) => items.filter((i) => i.gold.viral).length;
console.log(`train ${train.length} (${pos(train)} viral) | eval ${evalRows.length} (${pos(evalRows)} viral, real proportion) -> ${DIR}`);
