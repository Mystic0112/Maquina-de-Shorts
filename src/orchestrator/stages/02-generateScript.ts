import { z } from "zod";
import { resolveScript, type ScriptSettings } from "../../shared/settings.js";
import { env, loadConfig } from "../lib/config.js";
import { generateJson, withCorrection } from "../lib/llmClient.js";
import { getLogger } from "../lib/logger.js";
import { findSimilarSubject, loadRecentSubjects } from "../lib/recentTopics.js";
import { RunRejectedError } from "../lib/rejection.js";
import type { RunContext, Script, TopicPick } from "../types.js";

/** Script settings after defaults (see src/shared/settings.ts). */
export type ResolvedScriptSettings = ReturnType<typeof resolveScript>;
export type ScriptTone = ResolvedScriptSettings["tone"];

const QUERY_WORDS = { min: 2, max: 4 } as const;
/**
 * After the corrective retry, accept slightly-off scripts (with a warning) instead of failing the run.
 * Proportional to the configured range; the defaults 130-190 give the historical 115-215.
 */
const TOLERANCE_FACTORS = { min: 115 / 130, max: 215 / 190 } as const;

export interface WordRange {
  min: number;
  max: number;
}

export function wordRange(s: ResolvedScriptSettings): WordRange {
  return { min: s.minWords, max: s.maxWords };
}

export function wordTolerance(s: ResolvedScriptSettings): WordRange {
  return { min: Math.round(s.minWords * TOLERANCE_FACTORS.min), max: Math.round(s.maxWords * TOLERANCE_FACTORS.max) };
}

/** Fixed closing line from settings, or undefined when the model should write its own. */
export function fixedCta(s: Pick<ScriptSettings, "cta">): string | undefined {
  const cta = s.cta?.trim();
  return cta ? cta : undefined;
}

const SceneSchema = z.object({
  narration: z.string().min(10).describe("Narração da cena em pt-BR (1-3 frases curtas)"),
  footageQuery: z.string().min(3).describe("2-4 English words describing generic, filmable footage"),
});

/** What the model returns. `cta` is optional because a fixed CTA removes it from the schema. */
export interface LlmScript {
  title: string;
  hook: string;
  scenes: { narration: string; footageQuery: string }[];
  cta?: string;
}

export function buildLlmScriptSchema(s: ResolvedScriptSettings): z.ZodType<LlmScript> {
  const base = z.object({
    title: z.string().min(5).max(95).describe("Título do Short em pt-BR, chamativo, sem clickbait enganoso"),
    hook: z.string().min(10).describe("Primeira frase: gancho de curiosidade forte, em pt-BR"),
    scenes: z.array(SceneSchema).min(s.minScenes).max(s.maxScenes),
  });
  if (fixedCta(s)) return base;
  return base.extend({ cta: z.string().min(3).describe("CTA curto em pt-BR pedindo para seguir o canal") });
}

/** Default-settings schema, kept for callers that only need the shape. */
export const LlmScriptSchema = buildLlmScriptSchema(resolveScript());

export function countWords(text: string): number {
  return text.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

export function countSpokenWords(script: Pick<LlmScript, "hook" | "scenes" | "cta">): number {
  return countWords([script.hook, ...script.scenes.map((s) => s.narration), script.cta ?? ""].join(" "));
}

/** The model's output with the fixed CTA (if any) applied — the text that will actually be spoken. */
export function withEffectiveCta(raw: LlmScript, s: ResolvedScriptSettings): LlmScript & { cta: string } {
  return { ...raw, cta: fixedCta(s) ?? raw.cta?.trim() ?? "" };
}

/** Problems the JSON schema cannot express, checked on the spoken script (fixed CTA included). */
export function findScriptProblems(script: LlmScript, s: ResolvedScriptSettings = resolveScript()): string[] {
  const problems: string[] = [];
  const range = wordRange(s);
  const words = countSpokenWords(script);
  if (words < range.min || words > range.max) {
    problems.push(
      `O texto falado (hook + cenas + cta) tem ${words} palavras; precisa ter entre ${range.min} e ${range.max}.` +
        (words < range.min ? " Desenvolva mais as cenas." : " Corte frases e enxugue as cenas."),
    );
  }
  if (!fixedCta(s) && !script.cta?.trim()) problems.push(`Falta o "cta".`);
  script.scenes.forEach((scene, i) => {
    const n = countWords(scene.footageQuery);
    if (n < QUERY_WORDS.min || n > QUERY_WORDS.max) {
      problems.push(`scenes[${i}].footageQuery "${scene.footageQuery}" tem ${n} palavras; use de 2 a 4 palavras em inglês.`);
    }
  });
  return problems;
}

export function isWithinTolerance(script: LlmScript, s: ResolvedScriptSettings = resolveScript()): boolean {
  const words = countSpokenWords(script);
  const tolerance = wordTolerance(s);
  return words >= tolerance.min && words <= tolerance.max;
}

/** Libraries the footage adapter can query; keyed stock sites only count when their key is configured. */
export function footageLibraries(): string {
  const libs = ["NASA (imagens e vídeos de domínio público)", "Wikimedia Commons"];
  if (env("PEXELS_API_KEY")) libs.push("Pexels");
  if (env("PIXABAY_API_KEY")) libs.push("Pixabay");
  return libs.join(", ");
}

/** Retry attempts: steer away from subjects whose footage failed the quality gate. */
export function avoidanceInstructions(titles: readonly string[]): string {
  if (titles.length === 0) return "";
  const list = titles.map((t) => `- "${t}"`).join("\n");
  return `
IMPORTANTE: estes roteiros já foram tentados e descartados porque não havia imagens de acervo adequadas:
${list}
Escolha um assunto claramente diferente (não repita o mesmo fato, lugar ou objeto), de preferência algo fácil de
ilustrar com imagens reais de acervo (fenômenos naturais, planetas e missões espaciais, paisagens, animais, ruínas).
`;
}

export const TONE_INSTRUCTIONS: Record<ScriptTone, string> = {
  curioso:
    "curioso e intrigante: fale como alguém que acabou de descobrir algo fascinante e quer contar a um amigo; perguntas retóricas pontuais e revelações graduais.",
  empolgado:
    "empolgado e enérgico: ritmo rápido, frases curtas e exclamativas na medida certa, transmitindo entusiasmo genuíno sem exagerar nem soar forçado.",
  misterioso:
    "misterioso e envolvente: crie suspense, revele as informações aos poucos e use pausas dramáticas (frases curtas) antes das revelações, sem inventar mistério onde não há.",
  didatico:
    "didático e claro: explique como um bom professor, com comparações do dia a dia e uma ideia por frase, sem jargão e sem soar infantil.",
};

/** Target for the model: middle of the configured range. */
function targetWords(range: WordRange): number {
  return Math.round((range.min + range.max) / 2);
}

function lengthRule(s: ResolvedScriptSettings): string {
  const range = wordRange(s);
  const cta = fixedCta(s);
  if (!cta) {
    return `- Texto falado TOTAL (hook + todas as narrações das cenas + cta) entre ${range.min} e ${range.max} palavras. Mire em ~${targetWords(range)}.`;
  }
  const ctaWords = countWords(cta);
  const min = Math.max(1, range.min - ctaWords);
  const max = Math.max(min, range.max - ctaWords);
  return `- Hook + todas as narrações das cenas devem somar entre ${min} e ${max} palavras (o CTA fixo acrescenta mais ${ctaWords}). Mire em ~${targetWords({ min, max })}.`;
}

function ctaRule(s: ResolvedScriptSettings): string {
  const cta = fixedCta(s);
  if (cta) {
    return `- NÃO escreva CTA: o vídeo sempre termina com a frase fixa "${cta}", narrada logo após a última cena. Faça a última cena conduzir naturalmente até ela.`;
  }
  return `- "cta": curtíssimo (até 8 palavras), pedindo para seguir o canal para mais curiosidades.`;
}

/** Subjects already used: the model must pick something else (topic repetition guard). */
export function recentSubjectsInstructions(recentTitles: readonly string[]): string {
  if (recentTitles.length === 0) return "";
  return [
    "",
    "Assuntos JÁ USADOS recentemente no canal (escolha outro assunto; não repita o mesmo fato, objeto ou episódio, nem com outras palavras):",
    ...recentTitles.map((t) => `- ${t}`),
    "",
  ].join("\n");
}

export function buildScriptPrompt(
  topic: TopicPick,
  avoidTitles: readonly string[] = [],
  settings: ResolvedScriptSettings = resolveScript(),
  libraries: string = footageLibraries(),
  recentTitles: readonly string[] = [],
): string {
  const spoken = fixedCta(settings) ? "hook e cenas" : "hook, cenas e cta";
  return `Você é roteirista de um canal brasileiro de YouTube Shorts de curiosidades (história, ciência, espaço).
Escreva o roteiro de um Short narrado em português do Brasil.

Categoria: ${topic.categoryLabel}
Tema/ângulo: ${topic.seedPrompt}
Escolha você um fato específico dentro desse ângulo.
${avoidanceInstructions(avoidTitles)}${recentSubjectsInstructions(recentTitles)}
Tom de voz do roteiro: ${TONE_INSTRUCTIONS[settings.tone]}

Regras de conteúdo:
- Todo o texto narrado (${spoken}) em pt-BR natural, falado, frases curtas e diretas.
${lengthRule(settings)}
- "hook": a primeira frase é um gancho de curiosidade forte que prende nos 2 primeiros segundos (pergunta intrigante ou afirmação surpreendente). Não comece com "Você sabia".
- ${settings.minScenes} a ${settings.maxScenes} cenas, cada uma com 1 a 3 frases que avançam a história; a última cena fecha com um desfecho satisfatório.
- Use apenas fatos bem estabelecidos e amplamente documentados. Evite números exatos, a menos que sejam consenso de livro didático; prefira aproximações ("cerca de", "mais de").
- Nada de alegações de saúde, finanças ou política. Nada de teorias da conspiração ou especulação apresentada como fato.
- Escreva números por extenso quando curtos e evite siglas difíceis de pronunciar.
${ctaRule(settings)}
- "title": título do Short em pt-BR, até 70 caracteres, instigante mas honesto.

Regras para "footageQuery" (uma por cena, em INGLÊS):
- O vídeo de fundo vem automaticamente de ${libraries}. Um revisor automático descarta vídeos que não mostrem o que a cena narra.
- 2 a 4 palavras nomeando COISAS CONCRETAS E VISÍVEIS que esses acervos têm, nunca conceitos abstratos (nada de "slow rotation", "time paradox", "mystery").
- Bons exemplos: "venus planet nasa", "volcano lava flow", "ancient pyramids aerial", "spiral galaxy", "old parchment map", "ocean waves storm", "lightning storm night".
- Para espaço, prefira termos que a NASA usa (nome do planeta/objeto + "nasa", "planet", "telescope", "rocket launch").
- NUNCA use nomes de pessoas, marcas, logotipos, filmes, livros ou outras obras protegidas; nada de texto na tela.
- Cada consulta deve ilustrar o que a narração da cena descreve, mas de forma genérica o bastante para ter resultados.

Responda somente com o JSON no formato pedido.`;
}

async function requestScript(prompt: string, s: ResolvedScriptSettings): Promise<LlmScript & { cta: string }> {
  return withEffectiveCta(await generateJson(prompt, buildLlmScriptSchema(s)), s);
}

export function toScript(raw: LlmScript, s: ResolvedScriptSettings, language: string): Script {
  const spoken = withEffectiveCta(raw, s);
  return {
    title: spoken.title.trim(),
    hook: spoken.hook.trim(),
    scenes: spoken.scenes.map((sc) => ({ narration: sc.narration.trim(), footageQuery: sc.footageQuery.trim() })),
    cta: spoken.cta,
    language,
  };
}

export async function run(ctx: RunContext): Promise<RunContext> {
  if (!ctx.topic) throw new Error("02-generateScript requires ctx.topic (run 01-pickTopic first)");
  const log = getLogger(ctx.runId);
  const config = loadConfig();
  const settings = resolveScript(config.script);
  const recent = await loadRecentSubjects(ctx.runId);
  const prompt = buildScriptPrompt(ctx.topic, ctx.avoid?.titles ?? [], settings, footageLibraries(), recent.map((r) => r.title));
  let raw = await requestScript(prompt, settings);
  const repeated = findSimilarSubject(raw.title, recent);
  if (repeated) {
    log.warn(`Script "${raw.title}" repeats a recent subject ("${repeated.title}", shared: ${repeated.shared.join(", ")}); asking for another subject`);
    raw = await requestScript(
      withCorrection(prompt, JSON.stringify(raw, null, 2), `O assunto repete um vídeo recente ("${repeated.title}"). Escolha um assunto completamente diferente.`),
      settings,
    );
    const again = findSimilarSubject(raw.title, recent);
    if (again) {
      throw new RunRejectedError(`Script repeats a recent subject twice ("${raw.title}" ~ "${again.title}")`, ctx);
    }
  }
  let problems = findScriptProblems(raw, settings);
  if (problems.length > 0) {
    log.warn(`Script needs a corrective retry:\n- ${problems.join("\n- ")}`);
    raw = await requestScript(withCorrection(prompt, JSON.stringify(raw, null, 2), problems.join("\n")), settings);
    problems = findScriptProblems(raw, settings);
  }
  if (problems.length > 0) {
    if (!isWithinTolerance(raw, settings)) throw new Error(`Script still invalid after retry:\n- ${problems.join("\n- ")}`);
    log.warn(`Accepting script with minor issues:\n- ${problems.join("\n- ")}`);
  }
  const script = toScript(raw, settings, config.voice.language);
  const ctaNote = fixedCta(settings) ? ", fixed CTA" : "";
  log.info(
    `Script "${script.title}": ${script.scenes.length} scenes, ${countSpokenWords(script)} spoken words ` +
      `(range ${settings.minWords}-${settings.maxWords}, tone ${settings.tone}${ctaNote})`,
  );
  return { ...ctx, script };
}
