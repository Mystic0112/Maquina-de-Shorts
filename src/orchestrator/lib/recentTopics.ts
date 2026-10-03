import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { HISTORY_RELATIVE_PATH, readUploadHistory } from "../../shared/history.js";
import type { RunContext } from "../types.js";
import { paths } from "./config.js";

/** A subject the channel already covered (published) or generated recently. */
export interface RecentSubject {
  title: string;
  at: string;
  source: "uploaded" | "generated";
}

export const RUN_ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{4}$/;

const STOPWORDS = new Set(
  (
    "para como mais quando onde sobre entre pelo pela pelos pelas isso esse essa este esta esses essas estes estas " +
    "aquele aquela foram eram porque qual quais quem cada muito muita muitos muitas pouco pouca tudo todo toda todos " +
    "todas nunca sempre ainda depois antes desde contra seus suas dele dela deles delas voce voces sabia mesmo mesma " +
    "verdade segredo segredos incrivel incriveis surpreendente curioso curiosa curiosos curiosas fato fatos real reais " +
    "historia esquecido esquecida mito misterio misteriosa misterioso ninguem quase existe virou fazia fazem shorts"
  ).split(" "),
);

function stem(token: string): string {
  return token.length > 4 && token.endsWith("s") ? token.slice(0, -1) : token;
}

/** Distinctive words of a title: accent-free, lowercase, no stopwords/short words, light plural stemming. */
export function contentTokens(text: string): Set<string> {
  const words = text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/#\w+/g, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  return new Set(words.map(stem));
}

/** Overlap coefficient: shared tokens / tokens of the shorter title. */
export function titleSimilarity(a: string, b: string): { score: number; shared: string[] } {
  const ta = contentTokens(a);
  const tb = contentTokens(b);
  const shared = [...ta].filter((t) => tb.has(t));
  const smaller = Math.min(ta.size, tb.size);
  return { score: smaller === 0 ? 0 : shared.length / smaller, shared };
}

export const SIMILARITY_THRESHOLD = 0.6;

/** The most similar recent subject when it crosses the threshold (needs >= 2 shared distinctive words). */
export function findSimilarSubject(title: string, recent: readonly RecentSubject[], threshold = SIMILARITY_THRESHOLD): (RecentSubject & { score: number; shared: string[] }) | undefined {
  let best: (RecentSubject & { score: number; shared: string[] }) | undefined;
  for (const subject of recent) {
    const sim = titleSimilarity(title, subject.title);
    if (sim.shared.length >= 2 && sim.score >= threshold && (!best || sim.score > best.score)) best = { ...subject, ...sim };
  }
  return best;
}

function cleanTitle(title: string): string {
  return title.replace(/\s*#shorts\b/gi, "").trim();
}

/**
 * Last `limit` subjects: published titles from data/history.json plus script titles of recent runs
 * (render_output/<runId>/context.json, including scripts rejected later), newest first, deduplicated.
 */
export async function loadRecentSubjects(excludeRunId?: string, limit = 30): Promise<RecentSubject[]> {
  const subjects: RecentSubject[] = [];
  const history = await readUploadHistory(paths.fromRoot(HISTORY_RELATIVE_PATH));
  for (const r of history.records) subjects.push({ title: cleanTitle(r.title), at: r.publishedAt, source: "uploaded" });
  if (existsSync(paths.renderOutput)) {
    const dirs = (await readdir(paths.renderOutput)).filter((d) => RUN_ID_PATTERN.test(d) && d !== excludeRunId);
    for (const dir of dirs) {
      try {
        const ctx = JSON.parse(await readFile(join(paths.renderOutput, dir, "context.json"), "utf8")) as RunContext;
        const titles = [ctx.script?.title, ctx.factCheck?.originalScript?.title].filter((t): t is string => !!t);
        for (const title of titles) subjects.push({ title: cleanTitle(title), at: ctx.createdAt, source: "generated" });
      } catch {
        // Unreadable/partial run: nothing to learn from it.
      }
    }
  }
  const seen = new Set<string>();
  return subjects
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .filter((s) => {
      const key = [...contentTokens(s.title)].sort().join(" ") || s.title.toLowerCase();
      return seen.has(key) ? false : (seen.add(key), true);
    })
    .slice(0, limit);
}
