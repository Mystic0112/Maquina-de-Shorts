/**
 * Picks the clips worth cutting from a transcript: an LLM "viral cuts editor" proposes N windows that start
 * and end on segment boundaries; invalid answers are sent back with `withCorrection` until they fit.
 */
import { z } from "zod";
import { generateJson, type LlmProvider, withCorrection } from "../lib/llmClient.js";
import type { CutsConfig } from "./config.js";
import type { Transcript, TranscriptSegment } from "./transcribe.js";

export const ClipPickSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().positive(),
  title: z.string().min(3).max(100),
  hook: z.string().min(3).max(200),
  reason: z.string().min(3),
});
export const ClipPicksSchema = z.object({ clips: z.array(ClipPickSchema).min(1) });
export type ClipPick = z.infer<typeof ClipPickSchema>;

export interface SelectInput {
  channelName: string;
  videoTitle: string;
  transcript: Transcript;
  clip: Pick<CutsConfig["clip"], "minSeconds" | "maxSeconds" | "perVideo">;
}

const fmt = (s: number): string => s.toFixed(2);

export function buildSelectPrompt(input: SelectInput): string {
  const lines = input.transcript.segments.map((s) => `[${fmt(s.start)} - ${fmt(s.end)}] ${s.text}`);
  return [
    "Você é um editor de cortes virais para YouTube Shorts e TikTok em português do Brasil.",
    `Canal: ${input.channelName}. Vídeo: "${input.videoTitle}".`,
    "Abaixo está a transcrição com o tempo (em segundos) de cada segmento.",
    "",
    `Escolha os ${input.clip.perVideo} melhores trechos para virar cortes verticais, obedecendo:`,
    `- duração entre ${input.clip.minSeconds} e ${input.clip.maxSeconds} segundos;`,
    "- cada trecho funciona SOZINHO (quem nunca viu o vídeo entende e fica até o fim);",
    "- início e fim exatamente em fronteiras de segmento da transcrição (use os tempos listados);",
    "- sem sobreposição entre trechos;",
    "- prefira momentos com gancho forte: revelação, polêmica, número surpreendente, história, humor.",
    "",
    "Responda somente com JSON no formato:",
    '{"clips":[{"start":<segundos>,"end":<segundos>,"title":"<título curto chamativo>","hook":"<frase de gancho para os 2 primeiros segundos>","reason":"<por que funciona>"}]}',
    "",
    "TRANSCRIÇÃO:",
    ...lines,
  ].join("\n");
}

export interface ValidationIssue {
  index: number;
  problem: string;
}

/** Each pick must sit on segment boundaries, respect the duration window and not overlap another pick. */
export function validatePicks(picks: readonly ClipPick[], segments: readonly TranscriptSegment[], clip: SelectInput["clip"]): ValidationIssue[] {
  const starts = new Set(segments.map((s) => fmt(s.start)));
  const ends = new Set(segments.map((s) => fmt(s.end)));
  const issues: ValidationIssue[] = [];
  picks.forEach((pick, index) => {
    const duration = pick.end - pick.start;
    if (duration < clip.minSeconds || duration > clip.maxSeconds) {
      issues.push({ index, problem: `duration ${fmt(duration)} s is outside ${clip.minSeconds}-${clip.maxSeconds} s` });
    }
    if (!starts.has(fmt(pick.start))) issues.push({ index, problem: `start ${fmt(pick.start)} is not a segment start` });
    if (!ends.has(fmt(pick.end))) issues.push({ index, problem: `end ${fmt(pick.end)} is not a segment end` });
    picks.forEach((other, j) => {
      if (j <= index) return;
      if (pick.start < other.end && other.start < pick.end) issues.push({ index, problem: `overlaps clip ${j + 1}` });
    });
  });
  return issues;
}

/** Nudges start/end onto the nearest segment boundary (tolerates sub-second LLM rounding). */
export function snapToSegments(pick: ClipPick, segments: readonly TranscriptSegment[], toleranceSeconds = 0.75): ClipPick {
  const nearest = (value: number, candidates: number[]): number => {
    let best = value;
    let bestDistance = Infinity;
    for (const c of candidates) {
      const d = Math.abs(c - value);
      if (d < bestDistance) [best, bestDistance] = [c, d];
    }
    return bestDistance <= toleranceSeconds ? best : value;
  };
  return {
    ...pick,
    start: nearest(pick.start, segments.map((s) => s.start)),
    end: nearest(pick.end, segments.map((s) => s.end)),
  };
}

export function describeIssues(issues: readonly ValidationIssue[]): string {
  return issues.map((i) => `clip ${i.index + 1}: ${i.problem}`).join("\n");
}

export interface SelectOptions {
  provider?: LlmProvider;
  attempts?: number;
  model?: string;
}

/** Asks the LLM, snaps, validates; on problems re-asks with the correction preamble (up to `attempts`). */
export async function selectClips(input: SelectInput, options: SelectOptions = {}): Promise<ClipPick[]> {
  const prompt = buildSelectPrompt(input);
  const attempts = options.attempts ?? 3;
  let currentPrompt = prompt;
  let lastIssues = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const answer = await generateJson(currentPrompt, ClipPicksSchema, { provider: options.provider, model: options.model, thinking: "low" });
    const picks = answer.clips.map((p) => snapToSegments(p, input.transcript.segments)).slice(0, input.clip.perVideo);
    const issues = validatePicks(picks, input.transcript.segments, input.clip);
    if (issues.length === 0) return picks.sort((a, b) => a.start - b.start);
    lastIssues = describeIssues(issues);
    currentPrompt = withCorrection(prompt, JSON.stringify(answer), lastIssues);
  }
  throw new Error(`Clip selection still invalid after ${attempts} attempt(s):\n${lastIssues}`);
}

/** Transcript text spoken inside [start, end]. */
export function transcriptSlice(transcript: Transcript, start: number, end: number): string {
  return transcript.segments
    .filter((s) => s.start >= start - 0.01 && s.end <= end + 0.01)
    .map((s) => s.text)
    .join(" ");
}
