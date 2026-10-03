// Client-side derivations from /api/runs for the charts (all local data, cheap to recompute).
import { STAGE_NAMES, type RunSummary, type StageName } from "../shared/api";

export const isFailure = (r: RunSummary): boolean => r.status === "failed" || r.status === "interrupted";

const timeFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
/** Short label for a run on chart axes: "03/10 00:41". */
export const runLabel = (r: RunSummary): string => timeFmt.format(new Date(r.createdAt)).replace(",", "");

/** Runs oldest -> newest (charts read left to right in time). */
export const chronological = (runs: RunSummary[]): RunSummary[] =>
  [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

export function countBy<T>(items: T[], key: (item: T) => string | null | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    if (k) out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

/** Sum of the last 7 points vs the 7 before them (series ordered oldest -> newest). */
export function weekOverWeek(series: number[]): { current: number; previous: number } {
  const current = series.slice(-7).reduce((a, b) => a + b, 0);
  const previous = series.slice(-14, -7).reduce((a, b) => a + b, 0);
  return { current, previous };
}

export function failuresByStage(runs: RunSummary[]): { stage: StageName; falhas: number }[] {
  const counts = countBy(runs.filter(isFailure), (r) => r.failure?.stage);
  return STAGE_NAMES.map((stage) => ({ stage, falhas: counts.get(stage) ?? 0 }));
}

export type StageRow = { run: string; runId: string } & Partial<Record<StageName, number>>;

/** Minutes spent per stage (latest attempt) for runs that executed at least one stage. */
export function stageDurations(runs: RunSummary[]): StageRow[] {
  return chronological(runs)
    .filter((r) => r.stages.some((s) => s.durationMs != null && s.durationMs > 0))
    .map((r) => {
      const row: StageRow = { run: runLabel(r), runId: r.runId };
      for (const s of r.stages) if (s.durationMs != null) row[s.name] = Math.round(s.durationMs / 600) / 100;
      return row;
    });
}

/** Best relevance score per scene (null = no scored clip for that scene). */
export function sceneScores(run: RunSummary): (number | null)[] {
  const count = Math.max(run.sceneCount ?? 0, ...run.clips.map((c) => c.sceneIndex + 1));
  const best: (number | null)[] = Array.from({ length: count }, () => null);
  for (const clip of run.clips) {
    if (clip.relevanceScore == null) continue;
    const prev = best[clip.sceneIndex];
    best[clip.sceneIndex] = prev == null ? clip.relevanceScore : Math.max(prev, clip.relevanceScore);
  }
  return best;
}

/** Clips per integer relevance score 0..10 across all runs. */
export function relevanceHistogram(runs: RunSummary[]): { score: string; clipes: number }[] {
  const bins = Array.from({ length: 11 }, () => 0);
  for (const run of runs) {
    for (const clip of run.clips) {
      if (clip.relevanceScore != null) bins[Math.max(0, Math.min(10, Math.round(clip.relevanceScore)))]! += 1;
    }
  }
  return bins.map((clipes, score) => ({ score: String(score), clipes }));
}

export function sumCounts(runs: RunSummary[], pick: (r: RunSummary) => Record<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const run of runs) for (const [k, n] of Object.entries(pick(run))) out.set(k, (out.get(k) ?? 0) + n);
  return out;
}
