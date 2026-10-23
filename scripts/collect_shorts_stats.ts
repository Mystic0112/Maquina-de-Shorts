/**
 * Collects public Shorts metrics (title + views, NO video download) from channels in our niches, as training
 * data for the "what goes viral" model. Runs on the home PC.
 *
 *   npx tsx scripts/collect_shorts_stats.ts --discover            # search the themes -> candidates.json
 *   npx tsx scripts/collect_shorts_stats.ts --collect [--max 200] # Shorts of each channel -> shorts.jsonl
 *   npx tsx scripts/collect_shorts_stats.ts --hooks               # duration + first seconds of speech -> hooks.jsonl
 *
 * --collect reads data/datasets/viral/channels.json ([{ "id": "UC…", "group": "cortes" }]) when it exists, else
 * the discovered candidates seen in ≥ 2 searches. --hooks reads each labelled Short's captions (one yt-dlp call
 * per Short, no video download), is resumable (skips ids already in hooks.jsonl) and stops when YouTube starts
 * refusing. Everything lands in data/datasets/viral/ (git-ignored).
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadCutsConfig } from "../src/orchestrator/cuts/config.js";
import { paths } from "../src/orchestrator/lib/config.js";
import { runBinary } from "../src/orchestrator/lib/ffmpeg.js";
import { CAPTION_LANGS, hookFromJson3, labelChannel, parseShortsTab, pickCaptionFile, tallyCandidates, withTitles, type ChannelCandidate, type ShortHook, type ShortStat } from "../src/orchestrator/viral/shortsStats.js";

const OUT_DIR = join(paths.root, "data", "datasets", "viral");
const CANDIDATES = join(OUT_DIR, "candidates.json");
const CHANNELS = join(OUT_DIR, "channels.json");
const SHORTS = join(OUT_DIR, "shorts.jsonl");
const HOOKS = join(OUT_DIR, "hooks.jsonl");
const SUBS_DIR = join(OUT_DIR, "subs-tmp");
/** This many failures in a row = YouTube is refusing (bot check, 429): stop and resume later. */
const MAX_FAILS_IN_A_ROW = 8;
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

const readJsonl = async <T>(file: string): Promise<T[]> =>
  existsSync(file) ? (await readFile(file, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as T) : [];

async function hookOf(videoId: string): Promise<ShortHook> {
  await rm(SUBS_DIR, { recursive: true, force: true });
  await mkdir(SUBS_DIR, { recursive: true });
  const { stdout } = await runBinary(
    ytDlp(),
    ["--skip-download", "--no-simulate", "--no-warnings", "--no-playlist", "--write-subs", "--write-auto-subs", "--sub-langs", CAPTION_LANGS.join(","), "--sub-format", "json3", "--print", "%(duration)s", "-o", join(SUBS_DIR, "%(id)s.%(ext)s"), `https://www.youtube.com/shorts/${videoId}`],
    TIMEOUT_MS,
  );
  const duration = Number(stdout.trim().split("\n").at(-1));
  const file = pickCaptionFile(await readdir(SUBS_DIR), videoId);
  const hook = file ? hookFromJson3(JSON.parse(await readFile(join(SUBS_DIR, file), "utf8"))) : "";
  return { videoId, durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null, hook };
}

async function hooks(): Promise<void> {
  const rows = (await readJsonl<ShortStat>(SHORTS)).filter((r) => r.label !== null);
  if (rows.length === 0) throw new Error("run --collect first");
  const done = new Set((await readJsonl<ShortHook>(HOOKS)).map((h) => h.videoId));
  const todo = rows.filter((r) => !done.has(r.videoId));
  console.log(`${done.size} hook(s) already collected, ${todo.length} to go`);
  let fails = 0;
  for (const [i, r] of todo.entries()) {
    try {
      const h = await hookOf(r.videoId);
      await appendFile(HOOKS, `${JSON.stringify(h)}\n`);
      fails = 0;
      if (i % 50 === 0) console.log(`${i + 1}/${todo.length} ${r.videoId}: ${h.durationSeconds ?? "?"} s, "${h.hook.slice(0, 60)}"`);
    } catch (error) {
      console.warn(`${r.videoId} failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
      if (++fails >= MAX_FAILS_IN_A_ROW) {
        console.error(`${fails} failures in a row: YouTube is probably refusing. Run --hooks again later (it resumes).`);
        process.exitCode = 1;
        break;
      }
    }
    await sleep(PAUSE_MS);
  }
  await rm(SUBS_DIR, { recursive: true, force: true });
  const all = await readJsonl<ShortHook>(HOOKS);
  console.log(`${all.length} hook(s), ${all.filter((h) => h.hook).length} with speech -> ${HOOKS}`);
}

const { values } = parseArgs({ options: { discover: { type: "boolean" }, collect: { type: "boolean" }, hooks: { type: "boolean" }, max: { type: "string" } }, strict: true });
if (values.discover) await discover();
else if (values.collect) await collect(Number(values.max ?? 200));
else if (values.hooks) await hooks();
else console.error("Usage: npx tsx scripts/collect_shorts_stats.ts --discover | --collect [--max 200] | --hooks");
