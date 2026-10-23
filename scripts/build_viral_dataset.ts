/**
 * data/datasets/viral/shorts.jsonl (from collect_shorts_stats.ts) -> train/eval sets for `laya train`.
 *   npx tsx scripts/build_viral_dataset.ts [--target viral|fraco] [--hooks]
 * --target = the question ("viral" failed on titles alone; "fraco" = will it flop?). --hooks adds duration and
 * opening speech from hooks.jsonl (collect_shorts_stats.ts --hooks) and keeps only the Shorts that have one.
 * Output: train.<variant>.jsonl + eval.<variant>.jsonl, variant = target[-hook].
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { paths } from "../src/orchestrator/lib/config.js";
import { buildLayaSets, LAYA_QUESTIONS, type LayaTarget, type ShortHook, type ShortStat } from "../src/orchestrator/viral/shortsStats.js";

const DIR = join(paths.root, "data", "datasets", "viral");
const { values } = parseArgs({ options: { target: { type: "string", default: "viral" }, hooks: { type: "boolean" } }, strict: true });
const target = values.target as LayaTarget;
if (!(target in LAYA_QUESTIONS)) throw new Error(`--target must be one of: ${Object.keys(LAYA_QUESTIONS).join(", ")}`);

const readJsonl = async <T>(file: string): Promise<T[]> => (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
const rows = await readJsonl<ShortStat>(join(DIR, "shorts.jsonl"));
let hooks: Map<string, ShortHook> | undefined;
if (values.hooks) {
  const file = join(DIR, "hooks.jsonl");
  if (!existsSync(file)) throw new Error("hooks.jsonl not found: run collect_shorts_stats.ts --hooks first");
  hooks = new Map((await readJsonl<ShortHook>(file)).map((h) => [h.videoId, h]));
}

const { train, eval: evalRows } = buildLayaSets(rows, { target, hooks });
const variant = `${target}${hooks ? "-hook" : ""}`;
const jsonl = (items: unknown[]) => items.map((i) => JSON.stringify(i)).join("\n") + "\n";
await writeFile(join(DIR, `train.${variant}.jsonl`), jsonl(train));
await writeFile(join(DIR, `eval.${variant}.jsonl`), jsonl(evalRows));
const pos = (items: { expected: Partial<Record<LayaTarget, boolean>> }[]) => items.filter((i) => i.expected[target]).length;
console.log(`${variant}: train ${train.length} (${pos(train)} ${target}) | eval ${evalRows.length} (${pos(evalRows)} ${target}, real proportion) -> ${DIR}`);
