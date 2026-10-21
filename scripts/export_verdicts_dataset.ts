/**
 * Builds the local vision-judge dataset (LlamaFactory, ShareGPT multimodal / OpenAI-style messages) from every
 * footage_verdicts.jsonl in render_output/<runId>/ and data/verdicts/<runId>/.
 *
 *   npx tsx scripts/export_verdicts_dataset.ts [--out data/datasets/vision_judge] [--min-runs 1]
 *
 * Writes <out>/train.json, <out>/val.json, <out>/dataset_info.json, <out>/stats.json and copies the frames to
 * <out>/images/<runId>/ (paths in the dataset are relative to <out>, LlamaFactory's default media_dir).
 * The split is 90/10 by run (hash of the runId), so clips of the same scene never land in both sets.
 * Below --min-runs usable runs nothing is written.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { paths } from "../src/orchestrator/lib/config.js";
import { RUN_ID_PATTERN } from "../src/orchestrator/lib/recentTopics.js";
import { buildRelevancePrompt, classifyClip, RelevanceVerdictSchema, resolveRelevanceSettings } from "../src/orchestrator/lib/relevance.js";
import { VERDICTS_ARCHIVE_DIR, VERDICTS_FILE, type VerdictRecord } from "../src/orchestrator/lib/verdictLog.js";

export const DATASET_NAME = "vision_judge";

export interface RunVerdicts {
  runId: string;
  runDir: string;
  records: VerdictRecord[];
}

export interface Example {
  messages: { role: "user" | "assistant"; content: string }[];
  images: string[];
}

/** One entry per runId; render_output wins over the archive (retention only archives runs it deletes). */
export async function collectRuns(roots: readonly string[]): Promise<{ runs: RunVerdicts[]; malformed: number }> {
  const runs = new Map<string, RunVerdicts>();
  let malformed = 0;
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const runId of (await readdir(root)).filter((d) => RUN_ID_PATTERN.test(d) && !runs.has(d))) {
      const file = join(root, runId, VERDICTS_FILE);
      if (!existsSync(file)) continue;
      const records: VerdictRecord[] = [];
      for (const line of (await readFile(file, "utf8")).split("\n").filter((l) => l.trim())) {
        try {
          records.push(JSON.parse(line) as VerdictRecord);
        } catch {
          malformed++;
        }
      }
      runs.set(runId, { runId, runDir: join(root, runId), records });
    }
  }
  return { runs: [...runs.values()], malformed };
}

/** ~10% of runs go to validation; stable as the dataset grows (a run never changes side). */
export function isValidationRun(runId: string): boolean {
  return createHash("sha1").update(runId).digest().readUInt32BE(0) % 10 === 0;
}

/** Verdict JSON with exactly the schema's fields, in schema order. */
function verdictJson(verdict: NonNullable<VerdictRecord["verdict"]>): string {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(RelevanceVerdictSchema.shape)) {
    const value = verdict[key as keyof typeof verdict];
    if (value !== undefined) out[key] = value;
  }
  return JSON.stringify(out);
}

/** Single-clip reviewer prompt (as sent with batchSize 1), one <image> token per frame. */
export function toExample(record: VerdictRecord, images: string[]): Example {
  const c = record.context;
  const prompt = buildRelevancePrompt({ narration: c.narration, footageQuery: c.footageQuery }, images.length, c.title, record.kind, c.hook, c.beat);
  return {
    messages: [
      { role: "user", content: `${"<image>".repeat(images.length)}${prompt}` },
      { role: "assistant", content: verdictJson(record.verdict!) },
    ],
    images,
  };
}

export function datasetInfo(): Record<string, unknown> {
  const entry = (file: string) => ({
    file_name: file,
    formatting: "sharegpt",
    columns: { messages: "messages", images: "images" },
    tags: { role_tag: "role", content_tag: "content", user_tag: "user", assistant_tag: "assistant" },
  });
  return { [`${DATASET_NAME}_train`]: entry("train.json"), [`${DATASET_NAME}_val`]: entry("val.json") };
}

interface Stats {
  runs: { total: number; train: number; val: number };
  examples: { total: number; train: number; val: number };
  approved: number;
  rejected: number;
  byReason: { textOrLogo: number; people: number; wrongEraOrPlace: number; lowScoreOrNoMatch: number };
  bySource: Record<string, { total: number; approved: number }>;
  skipped: { error: number; missingFrames: number; malformed: number };
}

function emptyStats(malformed: number): Stats {
  return {
    runs: { total: 0, train: 0, val: 0 },
    examples: { total: 0, train: 0, val: 0 },
    approved: 0,
    rejected: 0,
    byReason: { textOrLogo: 0, people: 0, wrongEraOrPlace: 0, lowScoreOrNoMatch: 0 },
    bySource: {},
    skipped: { error: 0, missingFrames: 0, malformed },
  };
}

function countVerdict(stats: Stats, record: VerdictRecord, minScore: number): void {
  const v = record.verdict!;
  const approved = classifyClip({ clip: {} as never, verdict: v }, minScore) === "pass";
  const source = (stats.bySource[record.source] ??= { total: 0, approved: 0 });
  source.total++;
  if (approved) {
    stats.approved++;
    source.approved++;
    return;
  }
  stats.rejected++;
  if (v.hasTextOrLogo) stats.byReason.textOrLogo++;
  if (v.hasIdentifiablePeople) stats.byReason.people++;
  if (v.wrongEraOrPlace) stats.byReason.wrongEraOrPlace++;
  if (!v.hasTextOrLogo && !v.hasIdentifiablePeople && !v.wrongEraOrPlace) stats.byReason.lowScoreOrNoMatch++;
}

export async function exportDataset(options: { roots: readonly string[]; out: string; minRuns: number }): Promise<Stats> {
  const { runs, malformed } = await collectRuns(options.roots);
  const minScore = resolveRelevanceSettings(undefined).minScore;
  const stats = emptyStats(malformed);
  const split = { train: [] as Example[], val: [] as Example[] };
  const copies: { from: string; to: string }[] = [];
  for (const run of runs) {
    const side = isValidationRun(run.runId) ? "val" : "train";
    let used = 0;
    for (const record of run.records) {
      if (!record.verdict) {
        stats.skipped.error++;
        continue;
      }
      const frames = record.framePaths.map((p) => join(run.runDir, p));
      if (frames.length === 0 || !frames.every((f) => existsSync(f))) {
        stats.skipped.missingFrames++;
        continue;
      }
      const images = frames.map((f) => `images/${run.runId}/${basename(f)}`);
      copies.push(...frames.map((from, i) => ({ from, to: join(options.out, images[i]!) })));
      split[side].push(toExample(record, images));
      countVerdict(stats, record, minScore);
      used++;
    }
    if (used > 0) stats.runs[side]++;
  }
  stats.runs.total = stats.runs.train + stats.runs.val;
  stats.examples = { total: split.train.length + split.val.length, train: split.train.length, val: split.val.length };
  if (stats.runs.total < Math.max(1, options.minRuns)) return stats;
  await rm(join(options.out, "images"), { recursive: true, force: true });
  for (const { from, to } of copies) {
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
  }
  const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;
  await writeFile(join(options.out, "train.json"), json(split.train));
  await writeFile(join(options.out, "val.json"), json(split.val));
  await writeFile(join(options.out, "dataset_info.json"), json(datasetInfo()));
  await writeFile(join(options.out, "stats.json"), json(stats));
  return stats;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { out: { type: "string", default: "data/datasets/vision_judge" }, "min-runs": { type: "string", default: "1" } },
  });
  const minRuns = Number(values["min-runs"]);
  if (!Number.isInteger(minRuns) || minRuns < 0) throw new Error(`--min-runs must be a non-negative integer, got "${values["min-runs"]}"`);
  const out = paths.fromRoot(values.out);
  const stats = await exportDataset({ roots: [paths.renderOutput, VERDICTS_ARCHIVE_DIR], out, minRuns });
  const e = stats.examples;
  console.log(`${e.total} exemplos (${e.train} treino, ${e.val} validação) de ${stats.runs.total} execução(ões)`);
  console.log(`Ignorados: ${stats.skipped.error} com erro, ${stats.skipped.missingFrames} sem quadros, ${stats.skipped.malformed} linhas inválidas`);
  if (stats.runs.total < Math.max(1, minRuns)) console.log(`Menos de ${Math.max(1, minRuns)} execução(ões) com exemplos: nada foi escrito.`);
  else console.log(`Dataset em ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
