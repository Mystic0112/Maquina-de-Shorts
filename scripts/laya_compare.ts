/**
 * Laya vs agy on one cuts transcript (measurement only: renders nothing, publishes nothing).
 * Laya ranks every candidate window; the agy picks clips from the full transcript as `npm run cuts` does.
 * For each agy pick it prints the rank Laya gave to the most overlapping window: if the agy's picks land in
 * Laya's top ~10, the agy can later receive only that shortlist (shorter prompt, faster selection).
 *
 *   npx tsx scripts/laya_compare.ts --transcript data/cuts/sources/<channel>/<video>/transcript.json [--title "..."] [--clips 3]
 *
 * Laya runs in LAYA_PYTHON (a Python with `laya` + torch; default: the cuts venv, CUTS_PYTHON).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadCutsConfig } from "../src/orchestrator/cuts/config.js";
import { resolveCutsPython } from "../src/orchestrator/cuts/render.js";
import { selectClips } from "../src/orchestrator/cuts/select.js";
import { loadTranscript } from "../src/orchestrator/cuts/transcribe.js";
import { env, paths } from "../src/orchestrator/lib/config.js";
import { runPythonJson } from "../src/orchestrator/lib/python.js";

const LayaSchema = z.object({
  model: z.string(),
  device: z.string(),
  loadSeconds: z.number(),
  scoreSeconds: z.number(),
  windows: z.array(z.object({ start: z.number(), end: z.number(), score: z.number(), answers: z.record(z.string(), z.number()) })),
});

const overlap = (a: { start: number; end: number }, b: { start: number; end: number }): number => {
  const inter = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  return inter / (Math.max(a.end, b.end) - Math.min(a.start, b.start));
};

const { values } = parseArgs({
  options: { transcript: { type: "string" }, title: { type: "string" }, clips: { type: "string" } },
  strict: true,
});
if (!values.transcript) throw new Error("Usage: npx tsx scripts/laya_compare.ts --transcript <transcript.json> [--title ...] [--clips 3]");
const transcriptPath = paths.fromRoot(values.transcript);
const titleFile = join(dirname(transcriptPath), "title.txt");
const videoTitle = values.title ?? (existsSync(titleFile) ? readFileSync(titleFile, "utf8").trim() : "vídeo");
const config = loadCutsConfig();
const clip = { ...config.clip, perVideo: values.clips ? Number(values.clips) : config.clip.perVideo };
const transcript = await loadTranscript(transcriptPath);

let started = Date.now();
const laya = await runPythonJson({
  script: "python/cuts/laya_rank.py",
  python: env("LAYA_PYTHON") ? paths.fromRoot(env("LAYA_PYTHON") as string) : resolveCutsPython(),
  args: ["--transcript", transcriptPath, "--min", String(clip.minSeconds), "--max", String(clip.maxSeconds)],
  schema: LayaSchema,
  envKeys: ["HF_HOME", "HF_HUB_CACHE", "HF_HUB_OFFLINE", "CUDA_VISIBLE_DEVICES"],
  timeoutMs: 20 * 60 * 1000,
  onStderrLine: (line) => console.error(line),
});
const layaSeconds = (Date.now() - started) / 1000;

started = Date.now();
const picks = await selectClips({ channelName: config.channels[0]?.name ?? "canal", videoTitle, transcript, clip, style: config.channels[0]?.style ?? "podcast" });
const agySeconds = (Date.now() - started) / 1000;

const rows = picks.map((pick) => {
  let rank = -1;
  let best = 0;
  laya.windows.forEach((w, i) => {
    const o = overlap(pick, w);
    if (o > best) [best, rank] = [o, i + 1];
  });
  return { agy: `${pick.start.toFixed(1)}-${pick.end.toFixed(1)} s`, title: pick.title, layaRank: rank, overlap: Number(best.toFixed(2)) };
});
console.table(rows);
console.log(
  JSON.stringify(
    {
      windows: laya.windows.length,
      device: laya.device,
      layaSeconds: Number(layaSeconds.toFixed(1)),
      layaModelLoadSeconds: laya.loadSeconds,
      layaScoreSeconds: laya.scoreSeconds,
      agySeconds: Number(agySeconds.toFixed(1)),
      agyPicksInLayaTop10: rows.filter((r) => r.layaRank >= 1 && r.layaRank <= 10).length,
      agyPicks: rows.length,
      layaTop5: laya.windows.slice(0, 5).map((w) => ({ start: w.start, end: w.end, score: w.score, ...w.answers })),
    },
    null,
    1,
  ),
);
