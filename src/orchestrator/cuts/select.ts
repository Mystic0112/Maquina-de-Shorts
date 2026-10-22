/**
 * Picks the clips worth cutting from a transcript: an LLM "viral cuts editor" proposes N windows that start
 * and end on segment boundaries; invalid answers are sent back with `withCorrection` until they fit. A second
 * call (`verifyPicks`) then checks each pick against the surrounding conversation: a cut that changes what the
 * person meant, or a title that lies or demoralizes, is dropped (the owner's cuts rule, 2026-10-22).
 */
import { z } from "zod";
import { generateJson, type LlmProvider, withCorrection } from "../lib/llmClient.js";
import type { CutChannel, CutsConfig } from "./config.js";
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
  style: CutChannel["style"];
}

/** What makes a good clip for each kind of source (from the owner's reference clips, 2026-10-22). */
const STYLE_GUIDE: Record<CutChannel["style"], string[]> = {
  vlog: [
    "- é um vlog (câmera na mão, oficina, rua): escolha uma HISTÓRIA COMPLETA, uma \"saga\" com situação, problema ou tensão e desfecho (a risada, a revelação, o resultado);",
    "- prefira trechos com humor, zoeira entre as pessoas, susto, carro quebrando ou dando certo;",
    "- só a parte essencial da história: corte a enrolação do começo e termine logo depois do desfecho.",
  ],
  podcast: [
    "- é um podcast (conversa sentada): escolha uma ideia completa, uma história ou uma opinião forte com conclusão;",
    "- prefira revelação, história pessoal, número surpreendente, polêmica bem explicada, humor.",
  ],
};

const RULES = [
  "REGRAS QUE NUNCA PODEM SER QUEBRADAS:",
  "- o trecho não pode mudar o sentido do que a pessoa quis dizer (nada de começar ou terminar no meio de um raciocínio de forma que ele diga outra coisa; se a resposta só faz sentido com a pergunta, inclua a pergunta);",
  "- o título descreve com fidelidade o que acontece no trecho: sem mentir, sem prometer o que não tem;",
  "- nunca desmoralize ninguém: nada de título que humilhe, xingue ou ridicularize uma pessoa; ria da situação, não da pessoa;",
  "- em política: título neutro, que diz o que foi dito, sem \"destruiu\", \"humilhou\", \"lacrou\".",
];

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
    ...STYLE_GUIDE[input.style],
    "- cada trecho funciona SOZINHO (quem nunca viu o vídeo entende e fica até o fim);",
    "- comece no meio da ação: a primeira frase já prende (uma pergunta, uma provocação, um problema), sem cumprimento nem introdução;",
    "- início e fim exatamente em fronteiras de segmento da transcrição (use os tempos listados);",
    "- sem sobreposição entre trechos.",
    "",
    ...RULES,
    "",
    "Título no estilo dos cortes que viralizam: o apelido de quem aparece + a situação, com as palavras-chave em CAIXA ALTA e no máximo 2 emojis (ex.: \"ALEMÃO passou HORAS DE TERROR no Skyline 😂\").",
    "",
    "Responda somente com JSON no formato:",
    '{"clips":[{"start":<segundos>,"end":<segundos>,"title":"<título>","hook":"<a primeira frase do trecho que prende>","reason":"<por que funciona>"}]}',
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

/** Seconds of conversation shown before and after each pick to judge whether its meaning survives the cut. */
export const VERIFY_CONTEXT_SECONDS = 120;

export const PickVerdictSchema = z.object({
  verdicts: z.array(
    z.object({
      clip: z.number().int().positive(),
      meaningPreserved: z.boolean(),
      titleFaithful: z.boolean(),
      respectful: z.boolean(),
      problem: z.string(),
    }),
  ),
});
export type PickVerdict = z.infer<typeof PickVerdictSchema>["verdicts"][number];

function segmentsText(transcript: Transcript, from: number, to: number): string {
  return transcript.segments
    .filter((s) => s.end > from && s.start < to)
    .map((s) => s.text)
    .join(" ");
}

export function buildVerifyPrompt(picks: readonly ClipPick[], transcript: Transcript): string {
  const blocks = picks.map((p, i) =>
    [
      `CORTE ${i + 1} — título: "${p.title}"`,
      `ANTES (contexto, não entra no corte): ${segmentsText(transcript, p.start - VERIFY_CONTEXT_SECONDS, p.start) || "(início do vídeo)"}`,
      `O CORTE: ${transcriptSlice(transcript, p.start, p.end)}`,
      `DEPOIS (contexto, não entra no corte): ${segmentsText(transcript, p.end, p.end + VERIFY_CONTEXT_SECONDS) || "(fim do vídeo)"}`,
    ].join("\n"),
  );
  return [
    "Você revisa cortes de vídeo antes da publicação. Para cada corte abaixo, compare o trecho cortado com a conversa ao redor e responda:",
    "- meaningPreserved: quem vê só o corte entende o que a pessoa quis dizer, sem o sentido mudar em relação ao contexto? (false se o corte tira uma ressalva, uma ironia ou a pergunta que muda a resposta)",
    "- titleFaithful: o título descreve o que acontece no corte, sem mentir nem exagerar a ponto de enganar?",
    "- respectful: o título não humilha, não xinga e não ridiculariza nenhuma pessoa?",
    "- problem: uma frase curta com o problema, ou \"\" se estiver tudo certo.",
    "",
    ...blocks.flatMap((b) => [b, ""]),
    'Responda somente com JSON: {"verdicts":[{"clip":1,"meaningPreserved":true,"titleFaithful":true,"respectful":true,"problem":""}]}',
  ].join("\n");
}

/** Keeps only the picks the reviewer approves on all three checks; a pick without a verdict is dropped. */
export async function verifyPicks(
  picks: readonly ClipPick[],
  transcript: Transcript,
  options: SelectOptions = {},
): Promise<{ approved: ClipPick[]; rejected: { pick: ClipPick; verdict?: PickVerdict }[] }> {
  if (picks.length === 0) return { approved: [], rejected: [] };
  const answer = await generateJson(buildVerifyPrompt(picks, transcript), PickVerdictSchema, { provider: options.provider, model: options.model, thinking: "low" });
  const approved: ClipPick[] = [];
  const rejected: { pick: ClipPick; verdict?: PickVerdict }[] = [];
  picks.forEach((pick, i) => {
    const verdict = answer.verdicts.find((v) => v.clip === i + 1);
    if (verdict?.meaningPreserved && verdict.titleFaithful && verdict.respectful) approved.push(pick);
    else rejected.push({ pick, verdict });
  });
  return { approved, rejected };
}
