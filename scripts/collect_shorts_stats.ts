/**
 * Collects public Shorts metrics (title + views, NO video download) from channels in our niches, as training
 * data for the "what goes viral" model. Runs on the home PC.
 *
 *   npx tsx scripts/collect_shorts_stats.ts --discover            # search the themes -> candidates.json
 *   npx tsx scripts/collect_shorts_stats.ts --collect [--max 200] # Shorts of each channel -> shorts.jsonl
 *
 * --collect reads data/datasets/viral/channels.json ([{ "id": "UC…", "group": "cortes" }]) when it exists, else
 * the discovered candidates seen in ≥ 2 searches. Everything lands in data/datasets/viral/ (git-ignored).
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadCutsConfig } from "../src/orchestrator/cuts/config.js";
import { paths } from "../src/orchestrator/lib/config.js";
import { runBinary } from "../src/orchestrator/lib/ffmpeg.js";
import { labelChannel, parseShortsTab, tallyCandidates, withTitles, type ChannelCandidate, type ShortStat } from "../src/orchestrator/viral/shortsStats.js";

const OUT_DIR = join(paths.root, "data", "datasets", "viral");
const CANDIDATES = join(OUT_DIR, "candidates.json");
const CHANNELS = join(OUT_DIR, "channels.json");
const SHORTS = join(OUT_DIR, "shorts.jsonl");
const PAUSE_MS = 2000; // be gentle with YouTube between listings
const TIMEOUT_MS = 3 * 60 * 1000;

/** Themes of the owner's focus list (2026-10-22) plus our own curiosity niche; group = how rows are tagged. */
const QUERIES: { query: string; group: string }[] = [
  ...["acf", "ricardinho acf", "alemão da caravan", "celso etnrlz", "capaceti", "renato cariani", "toguro", "thiago tcar", "igor 3k", "flow podcast", "redcast", "spectrum debate", "pablo marçal", "nikolas ferreira", "kim kataguiri", "lucas pavanato"].map((q) => ({
    query: `cortes ${q} #shorts`,
    group: "cortes",
  })),
  ...["curiosidades", "você sabia", "curiosidades história", "curiosidades ciência", "curiosidades espaço"].map((q) => ({ query: `${q} #shorts`, group: "curiosidades" })),
];

function ytDlp(): string {
  const configured = existsSync(join(paths.config, "cuts.json")) ? loadCutsConfig().download.ytDlp : "yt-dlp";
  return configured.includes("/") || configured.includes("\\") ? paths.fromRoot(configured) : configured;
}

/**
 * Default language = numbers yt-dlp parses (views, subscribers); `pt` = the original Brazilian titles. Both are
 * needed: with lang=pt the titles come untranslated but "23 mil visualizações" is parsed as 23 and subscribers
 * vanish; without it the numbers are right but titles come machine-translated to English.
 */
async function flatJson(target: string, extra: string[] = [], lang?: "pt"): Promise<unknown> {
  const langArgs = lang ? ["--extractor-args", `youtube:lang=${lang}`] : [];
  const { stdout } = await runBinary(ytDlp(), ["--flat-playlist", "-J", "--no-warnings", ...langArgs, ...extra, target], TIMEOUT_MS);
  return JSON.parse(stdout) as unknown;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function discover(): Promise<void> {
  const searches: { query: string; json: unknown }[] = [];
  for (const { query, group } of QUERIES) {
    try {
      searches.push({ query, json: await flatJson(`ytsearch40:${query}`) });
      console.log(`searched "${query}"`);
    } catch (error) {
      console.warn(`search "${query}" failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
    }
    await sleep(PAUSE_MS);
  }
  const candidates = tallyCandidates(searches).map((c) => {
    // The group most of the channel's searches belong to (a cuts channel can show up once for "curiosidades").
    const groups = c.queries.map((q) => QUERIES.find((x) => x.query === q)?.group ?? "cortes");
    const cortes = groups.filter((g) => g === "cortes").length;
    return { ...c, group: cortes * 2 >= groups.length ? "cortes" : "curiosidades" };
  });
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(CANDIDATES, `${JSON.stringify(candidates, null, 2)}\n`);
  console.log(`${candidates.length} channel(s); ${candidates.filter((c) => c.hits >= 2).length} seen in ≥ 2 searches -> ${CANDIDATES}`);
}

async function channelList(): Promise<{ id: string; group: string }[]> {
  if (existsSync(CHANNELS)) return JSON.parse(await readFile(CHANNELS, "utf8")) as { id: string; group: string }[];
  if (!existsSync(CANDIDATES)) throw new Error("run --discover first (or write data/datasets/viral/channels.json)");
  const candidates = JSON.parse(await readFile(CANDIDATES, "utf8")) as (ChannelCandidate & { group?: string })[];
  return candidates.filter((c) => c.hits >= 2).map((c) => ({ id: c.channelId, group: c.group ?? "cortes" }));
}

async function collect(max: number): Promise<void> {
  const channels = await channelList();
  const rows: ShortStat[] = [];
  for (const { id, group } of channels) {
    const url = id.startsWith("UC") ? `https://www.youtube.com/channel/${id}/shorts` : `${id.replace(/\/$/, "")}/shorts`;
    try {
      const items = ["--playlist-items", `1:${max}`];
      const counts = await flatJson(url, items);
      await sleep(PAUSE_MS);
      const labelled = labelChannel(withTitles(parseShortsTab(counts, group), await flatJson(url, items, "pt")));
      rows.push(...labelled);
      const viral = labelled.filter((r) => r.label === "viral").length;
      console.log(`${labelled[0]?.channelName ?? id}: ${labelled.length} Shorts, ${viral} viral`);
    } catch (error) {
      console.warn(`${id} failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
    }
    await sleep(PAUSE_MS);
  }
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(SHORTS, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const count = (l: string) => rows.filter((r) => r.label === l).length;
  console.log(`${rows.length} Shorts from ${new Set(rows.map((r) => r.channelId)).size} channel(s): viral ${count("viral")}, normal ${count("normal")}, fraco ${count("fraco")}, unlabelled ${rows.filter((r) => !r.label).length} -> ${SHORTS}`);
}

const { values } = parseArgs({ options: { discover: { type: "boolean" }, collect: { type: "boolean" }, max: { type: "string" } }, strict: true });
if (values.discover) await discover();
else if (values.collect) await collect(Number(values.max ?? 200));
else console.error("Usage: npx tsx scripts/collect_shorts_stats.ts --discover | --collect [--max 200]");
