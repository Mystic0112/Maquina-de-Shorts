/**
 * Titles that went viral on other channels of the same niche (data/datasets/viral/shorts.jsonl, collected at home
 * by scripts/collect_shorts_stats.ts), shown to the agy as STYLE examples when it writes a title. A Laya model
 * trained to predict virality from the title alone did no better than chance (AUC 0.48, 2026-10-22), so the data
 * is used as in-context examples instead. Without the file the prompts simply carry no examples.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../lib/config.js";
import type { ShortStat } from "./shortsStats.js";

export const SHORTS_FILE = join(paths.data, "datasets", "viral", "shorts.jsonl");

/** Hashtags and @mentions out, spaces collapsed; too short/long titles are not useful examples. */
export function cleanTitle(title: string): string | null {
  const text = title.replace(/[#@][\p{L}\p{N}_.]+/gu, "").replace(/\s+/g, " ").trim();
  return text.length >= 12 && text.length <= 100 ? text : null;
}

/** The most viral titles of a group, at most `perChannel` from each channel so one channel's voice does not dominate. */
export function pickTitleExamples(rows: readonly ShortStat[], group: string, n = 15, perChannel = 2): string[] {
  const used = new Map<string, number>();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of [...rows].filter((x) => x.group === group && x.label === "viral").sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0))) {
    const title = cleanTitle(r.title);
    if (!title || seen.has(title.toLowerCase()) || (used.get(r.channelId) ?? 0) >= perChannel) continue;
    seen.add(title.toLowerCase());
    used.set(r.channelId, (used.get(r.channelId) ?? 0) + 1);
    out.push(title);
    if (out.length === n) break;
  }
  return out;
}

const cache = new Map<string, ShortStat[]>();

/** Examples for prompts; [] when the dataset was never collected on this machine. */
export function titleExamples(group: "cortes" | "curiosidades", n = 15, file = SHORTS_FILE): string[] {
  if (!existsSync(file)) return [];
  let rows = cache.get(file);
  if (!rows) {
    rows = readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ShortStat);
    cache.set(file, rows);
  }
  return pickTitleExamples(rows, group, n);
}

/** The prompt block: style only, never the subject, and the honesty rules still apply. */
export function titleExamplesBlock(examples: readonly string[], niche: string): string {
  if (examples.length === 0) return "";
  return [
    `Títulos de Shorts de ${niche} que VIRALIZARAM em outros canais (copie só o ESTILO: ritmo, palavra forte, pergunta, caixa alta; nunca o assunto, e as regras de honestidade continuam valendo):`,
    ...examples.map((t) => `- ${t}`),
  ].join("\n");
}
