import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { resolveScript, type ScriptSettings } from "../../shared/settings.js";
import { env, loadConfig, paths } from "../lib/config.js";
import { generateJson, withCorrection } from "../lib/llmClient.js";
import { getLogger } from "../lib/logger.js";
import { containsWord, isEmphasisWord, normalizeToken, spellNumber, textTokens, titleKeyTokens } from "../lib/ptBr.js";
import { findSimilarSubject, loadRecentSubjects, RUN_ID_PATTERN } from "../lib/recentTopics.js";
import { RunRejectedError } from "../lib/rejection.js";
import { beatProblems, MAX_BEATS, sanitizeBeats } from "../lib/beats.js";
import type { RunContext, SceneBeat, Script, TopicPick } from "../types.js";

/** Script settings after defaults (see src/shared/settings.ts). */
export type ResolvedScriptSettings = ReturnType<typeof resolveScript>;
export type ScriptTone = ResolvedScriptSettings["tone"];
export type ScriptFormat = ResolvedScriptSettings["formats"][number];

/**
 * After the corrective retry, accept slightly-off scripts (with a warning) instead of failing the run.
 * Proportional to the configured range; the defaults 130-190 give the historical 115-215.
 */
const TOLERANCE_FACTORS = { min: 115 / 130, max: 215 / 190 } as const;

/** Hook limits: it must land inside ~3.5 s of speech. */
export const HOOK_MAX_WORDS = 12;
export const HOOK_MAX_SECONDS = 3.5;
/** The concrete subject must be named this early in the hook (~5 words, counted as tokens). */
export const HOOK_LEAD_WORDS = 6;
/**
 * Gemini TTS (Fenrir) measured 15.2 letters/s (letters only, no spaces) on the one real run so far
 * (2026-10-12); edge-tts was ~15-16. Re-measure from narration.words once more runs exist.
 */
const LETTERS_PER_SECOND = 15;
const PAUSE_SECONDS = 0.25;
export const OVERLAY_WORDS = { min: 3, max: 5 } as const;
export const OVERLAY_MAX_CHARS = 32;
export const CTA_MAX_WORDS = 5;

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

/** Footage query length in words: generic queries stay short; named subjects need a few more words. */
export function queryWordRange(s: Pick<ResolvedScriptSettings, "specificFootage">): WordRange {
  return { min: 2, max: s.specificFootage ? 6 : 4 };
}

/** Fixed closing line from settings, or undefined when the model should write its own. */
export function fixedCta(s: Pick<ScriptSettings, "cta">): string | undefined {
  const cta = s.cta?.trim();
  return cta ? cta : undefined;
}

/** False when the model writes no CTA: a fixed CTA replaces it (always wins), or ctaStyle "nenhum" drops it. */
export function modelWritesCta(s: Pick<ResolvedScriptSettings, "cta" | "ctaStyle">): boolean {
  return !fixedCta(s) && s.ctaStyle !== "nenhum";
}

function sceneSchema(s: ResolvedScriptSettings) {
  const q = queryWordRange(s);
  const query = (what: string) => z.string().min(3).describe(`${q.min}-${q.max} English words naming ${what}`);
  return z.object({
    narration: z.string().min(10).describe("Narração da cena em pt-BR (1-3 frases curtas)"),
    footageQuery: query("filmable footage of this scene's era and place (= the first beat's footageQuery)"),
    beats: z
      .array(
        z.object({
          phrase: z.string().min(1).describe("Trecho LITERAL da narração desta cena (copiado palavra por palavra), na ordem em que é dito"),
          footageQuery: query("exactly the concrete thing this phrase mentions"),
        }),
      )
      .min(1)
      .max(MAX_BEATS)
      .describe("1 a 3 trechos da narração, cada um com a imagem da coisa concreta citada nele"),
  });
}

/** What the model returns. `cta` is optional because a fixed CTA (or ctaStyle "nenhum") removes it from the schema. */
export interface LlmScript {
  title: string;
  hook: string;
  scenes: { narration: string; footageQuery: string; beats?: SceneBeat[] }[];
  cta?: string;
  overlayText?: string;
  hookFootageQuery?: string;
}

export function buildLlmScriptSchema(s: ResolvedScriptSettings): z.ZodType<LlmScript> {
  const base = z.object({
    title: z.string().min(5).max(95).describe("Título do Short em pt-BR, curioso e honesto"),
    overlayText: z.string().min(3).max(60).describe('Texto da tela/capa, 3 a 5 palavras, ex.: "A LUA TEM CHEIRO?"'),
    hook: z.string().min(10).describe("Primeira frase (até 12 palavras): assunto concreto + fato mais forte logo no início"),
    hookFootageQuery: z.string().min(3).describe("English search query for the single most iconic visual of the hook"),
    scenes: z.array(sceneSchema(s)).min(s.minScenes).max(s.maxScenes),
  });
  if (!modelWritesCta(s)) return base;
  return base.extend({ cta: z.string().min(3).describe('CTA curtíssimo em pt-BR (até 5 palavras), sem a palavra "canal"') });
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
  const cta = fixedCta(s) ?? (s.ctaStyle === "nenhum" ? "" : (raw.cta?.trim() ?? ""));
  return { ...raw, cta };
}

// ---------------------------------------------------------------------------------------------
// Validators (what the JSON schema cannot express)
// ---------------------------------------------------------------------------------------------

/** Rough narration time of a line (edge-tts pt-BR), used to keep the hook inside ~3.5 s. */
export function estimateSpeechSeconds(text: string): number {
  const letters = text.replace(/[^\p{L}\p{N}]/gu, "").length;
  const pauses = (text.trim().replace(/[.!?…]+$/u, "").match(/[,;:.!?…—]/gu) ?? []).length;
  return letters / LETTERS_PER_SECOND + pauses * PAUSE_SECONDS;
}

/** Overused openings (matched without accents). The audit found 2 of 4 hooks on the first two. */
export const HOOK_CLICHES: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /\b(e|sao|foi|era|eram|foram|seja|sendo)\s+vist[oa]s?\s+como\b/, label: '"é visto como..."' },
  { pattern: /\bmas a realidade\b|\ba realidade (e|foi|era) (bem |muito )?(outra|diferente)\b/, label: '"mas a realidade..."' },
  { pattern: /\bvoce sabia\b/, label: '"Você sabia"' },
  { pattern: /\b(ninguem|poucos?|quase ninguem) (te )?(conta|contou|sabe|sabem|conhece|conhecem)\b/, label: '"o que ninguém te conta"' },
  { pattern: /\bvoce nao vai acreditar\b|\bacredite se quiser\b|\bprepare-se\b/, label: '"você não vai acreditar"' },
  { pattern: /\b(muita gente|muitos|a maioria( das pessoas)?|todo mundo) (acha|pensa|acredita|imagina)m? que\b/, label: '"muita gente acha que..."' },
  { pattern: /\bnem tudo e o que parece\b|\bnao e bem assim\b/, label: '"nem tudo é o que parece"' },
];

export function findCliches(text: string): string[] {
  const plain = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  return HOOK_CLICHES.filter((c) => c.pattern.test(plain)).map((c) => c.label);
}

function quoteKeys(keys: readonly string[]): string {
  return keys.map((k) => `"${k}"`).join(", ");
}

const LATE_SUBJECT = "aparece tarde";

/**
 * Title <-> hook <-> narration consistency: the hook names a title key term early, every title key term is
 * actually said, and the scenes (not only the hook) come back to it. Shared with 02b-factCheck.
 */
export function keyTermProblems(script: Pick<Script, "title" | "hook" | "scenes">): string[] {
  const keys = titleKeyTokens(script.title);
  if (keys.length === 0) return [];
  const problems: string[] = [];
  const hook = textTokens(script.hook);
  const scenes = textTokens(script.scenes.map((s) => s.narration).join(" "));
  const inHook = keys.filter((k) => containsWord(hook, k));
  if (inHook.length === 0) {
    problems.push(`O gancho não cita nenhuma palavra-chave do título (${quoteKeys(keys)}): nomeie o assunto do título já no gancho.`);
  } else if (!keys.some((k) => containsWord(hook.slice(0, HOOK_LEAD_WORDS), k))) {
    problems.push(`O assunto do título (${quoteKeys(inHook)}) ${LATE_SUBJECT} no gancho: coloque-o nas ${HOOK_LEAD_WORDS - 1} primeiras palavras.`);
  }
  const unsaid = keys.filter((k) => !containsWord([...hook, ...scenes], k));
  if (unsaid.length > 0) {
    problems.push(`O título promete ${quoteKeys(unsaid)}, mas a narração nunca diz isso: diga na narração ou ajuste o título.`);
  }
  if (!keys.some((k) => containsWord(scenes, k))) {
    problems.push(`As cenas nunca retomam o termo-chave do título (${quoteKeys(keys)}).`);
  }
  return problems;
}

/** Only the problems that make title and narration disagree (a late subject is a style issue). */
export function keyTermMismatches(script: Pick<Script, "title" | "hook" | "scenes">): string[] {
  return keyTermProblems(script).filter((p) => !p.includes(LATE_SUBJECT));
}

/** Overlay/cover text: 3-5 short words that echo the title or narration (numbers may be digits). */
export function overlayProblems(script: Pick<Script, "title" | "hook" | "scenes"> & { overlayText?: string }): string[] {
  const overlay = script.overlayText?.trim() ?? "";
  if (!overlay) return [`Falta o "overlayText" (3 a 5 palavras para a tela/capa).`];
  const problems: string[] = [];
  const n = countWords(overlay);
  if (n < OVERLAY_WORDS.min || n > OVERLAY_WORDS.max || overlay.length > OVERLAY_MAX_CHARS) {
    problems.push(
      `"overlayText" "${overlay}" tem ${n} palavras e ${overlay.length} caracteres; use ${OVERLAY_WORDS.min} a ${OVERLAY_WORDS.max} palavras curtas (até ${OVERLAY_MAX_CHARS} caracteres).`,
    );
  }
  if (/[#@]|\p{Extended_Pictographic}/u.test(overlay)) problems.push(`"overlayText" não pode ter hashtag, @ ou emoji.`);
  const spoken = textTokens([script.title, script.hook, ...script.scenes.map((s) => s.narration)].join(" "));
  const keys = overlay
    .split(/\s+/)
    .filter(isEmphasisWord)
    .map((w) => spellNumber(normalizeToken(w)))
    .filter((w) => w.length >= 3);
  if (keys.length > 0 && !keys.some((k) => containsWord(spoken, k))) {
    problems.push(`"overlayText" "${overlay}" não repete nenhuma palavra do título ou da narração; ele precisa resumir o mesmo fato.`);
  }
  return problems;
}

/** CTA rules for ctaStyle "curto" (a fixed config CTA and "nenhum" are never checked). */
export function ctaProblems(cta: string, s: Pick<ResolvedScriptSettings, "cta" | "ctaStyle">): string[] {
  if (!modelWritesCta(s)) return [];
  const text = cta.trim();
  if (!text) return [`Falta o "cta".`];
  const problems: string[] = [];
  const n = countWords(text);
  if (n > CTA_MAX_WORDS) problems.push(`O "cta" "${text}" tem ${n} palavras; use no máximo ${CTA_MAX_WORDS}.`);
  if (/\bcana(l|is)\b/i.test(text)) problems.push(`O "cta" não pode usar a palavra "canal" (o vídeo também vai para TikTok e Instagram).`);
  return problems;
}

const CLICHE_MARK = "clichê proibido";

export function hookProblems(hook: string): string[] {
  const problems: string[] = [];
  const n = countWords(hook);
  const seconds = estimateSpeechSeconds(hook);
  if (n > HOOK_MAX_WORDS || seconds > HOOK_MAX_SECONDS) {
    problems.push(
      `O gancho tem ${n} palavras (~${seconds.toFixed(1)} s falado); use no máximo ${HOOK_MAX_WORDS} palavras e ~${HOOK_MAX_SECONDS} s.`,
    );
  }
  const cliches = findCliches(hook);
  if (cliches.length > 0) problems.push(`O gancho usa ${CLICHE_MARK} (${cliches.join(", ")}): afirme o fato surpreendente direto.`);
  return problems;
}

/** A validation finding; `hard` ones reject the run if the corrective retry does not fix them. */
export interface ScriptIssue {
  message: string;
  hard: boolean;
}

export function findScriptIssues(script: LlmScript, s: ResolvedScriptSettings = resolveScript()): ScriptIssue[] {
  const issues: ScriptIssue[] = [];
  const add = (hard: boolean) => (message: string) => void issues.push({ message, hard });
  const range = wordRange(s);
  const words = countSpokenWords(script);
  if (words < range.min || words > range.max) {
    add(false)(
      `O texto falado (hook + cenas + cta) tem ${words} palavras; precisa ter entre ${range.min} e ${range.max}.` +
        (words < range.min ? " Desenvolva mais as cenas." : " Corte frases e enxugue as cenas."),
    );
  }
  ctaProblems(fixedCta(s) ?? script.cta ?? "", s).forEach(add(false));
  footageQueryProblems(script, s).forEach(add(false));
  sceneBeatProblems(script).forEach(add(false));
  for (const p of hookProblems(script.hook)) add(p.includes(CLICHE_MARK))(p);
  const titleCliches = findCliches(script.title);
  if (titleCliches.length > 0) add(true)(`O título usa ${CLICHE_MARK} (${titleCliches.join(", ")}).`);
  for (const p of keyTermProblems(script)) add(!p.includes(LATE_SUBJECT))(p);
  overlayProblems(script).forEach(add(false));
  endingProblems(script, s).forEach(add(false));
  return issues;
}

function footageQueryProblems(script: LlmScript, s: ResolvedScriptSettings): string[] {
  const q = queryWordRange(s);
  const queries = [
    ...script.scenes.map((scene, i) => ({ label: `scenes[${i}].footageQuery`, query: scene.footageQuery })),
    ...script.scenes.flatMap((scene, i) => (scene.beats ?? []).map((b, j) => ({ label: `scenes[${i}].beats[${j}].footageQuery`, query: b.footageQuery }))),
    ...(script.hookFootageQuery !== undefined ? [{ label: "hookFootageQuery", query: script.hookFootageQuery }] : []),
  ];
  return queries.flatMap(({ label, query }) => {
    const n = countWords(query);
    return n < q.min || n > q.max ? [`${label} "${query}" tem ${n} palavras; use de ${q.min} a ${q.max} palavras em inglês.`] : [];
  });
}

/** Beats are validated only when the model wrote any (older fixtures/tests have none): literal phrases, in order. */
export function sceneBeatProblems(script: Pick<LlmScript, "scenes">): string[] {
  if (!script.scenes.some((s) => s.beats)) return [];
  return script.scenes.flatMap((scene, i) => beatProblems(`scenes[${i}]`, scene.narration, scene.beats));
}

/** Problems the JSON schema cannot express, checked on the spoken script (fixed CTA included). */
export function findScriptProblems(script: LlmScript, s: ResolvedScriptSettings = resolveScript()): string[] {
  return findScriptIssues(script, s).map((i) => i.message);
}

export function isWithinTolerance(script: LlmScript, s: ResolvedScriptSettings = resolveScript()): boolean {
  const words = countSpokenWords(script);
  const tolerance = wordTolerance(s);
  return words >= tolerance.min && words <= tolerance.max;
}

/** Short CTAs used when the model's CTA still breaks the rules after the retry (never "canal"). */
export const FALLBACK_CTAS = [
  "Segue pra mais curiosidades.",
  "Comenta: você já sabia?",
  "Qual fato te surpreendeu mais?",
  "Manda pra quem precisa saber.",
  "Segue pra descobrir mais.",
] as const;

/** Deterministic, varied replacement for an invalid model CTA (keyed by the title, skipping recent CTAs). */
export function fallbackCta(title: string, avoid: readonly string[] = []): string {
  const recent = new Set(avoid.map((a) => a.trim().toLowerCase()));
  const pool = FALLBACK_CTAS.filter((c) => !recent.has(c.toLowerCase()));
  const options = pool.length > 0 ? pool : [...FALLBACK_CTAS];
  const hash = [...title].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
  return options[hash % options.length] ?? FALLBACK_CTAS[0];
}

// ---------------------------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------------------------

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

/** Structure per narrative format (rotated by 01-pickTopic so consecutive videos don't share a template). */
export const FORMAT_INSTRUCTIONS: Record<ScriptFormat, string> = {
  "mito-verdade":
    'MITO x VERDADE. O gancho já AFIRMA a verdade surpreendente sobre o assunto (ex.: "A Bastilha tinha só sete presos quando caiu."); as cenas mostram de onde veio a versão popular e as provas da verdade. Não descreva o mito com "é visto como" nem com "mas a realidade".',
  lista:
    'LISTA "3 coisas". O gancho anuncia a lista já com o assunto (ex.: "Três coisas que a Bastilha escondia em 1789."); uma cena por item, numerada na fala ("Primeira:", "Segunda:", "Terceira:"), com a mais surpreendente por último.',
  "e-se":
    'E SE? O gancho é uma pergunta hipotética concreta que começa com "E se" e já nomeia o assunto (ex.: "E se a Lua sumisse hoje à noite?"); as cenas mostram, em ordem, as consequências segundo a ciência ou a história consolidada, deixando claro o que é hipótese e o que é fato.',
  comparacao:
    'COMPARAÇÃO "X vs Y". O gancho põe dois assuntos concretos lado a lado com o contraste mais chocante (ex.: "Um dia em Vênus dura mais que um ano inteiro."); as cenas alternam X e Y com números comparáveis e a última revela a diferença mais surpreendente.',
  "linha-do-tempo":
    'LINHA DO TEMPO. O gancho começa pelo momento mais surpreendente (com data ou época); as cenas seguem em ordem cronológica, cada uma com um marco de tempo falado ("Em 1789...", "Dez anos depois...").',
  "pergunta-resposta":
    'PERGUNTA E RESPOSTA. O gancho é uma pergunta direta e curta sobre o assunto concreto (ex.: "Por que Urano gira deitado?") e a resposta curta vem logo no início da primeira cena; as demais cenas explicam o porquê com provas.',
};

function formatRule(format: string | undefined): string {
  const instruction = format ? FORMAT_INSTRUCTIONS[format as ScriptFormat] : undefined;
  return instruction ? `\nFormato narrativo deste vídeo: ${instruction}\n` : "";
}

/** Target for the model: middle of the configured range. */
function targetWords(range: WordRange): number {
  return Math.round((range.min + range.max) / 2);
}

function lengthRule(s: ResolvedScriptSettings): string {
  const range = wordRange(s);
  const cta = fixedCta(s);
  if (!cta) {
    const parts = modelWritesCta(s) ? "hook + todas as narrações das cenas + cta" : "hook + todas as narrações das cenas";
    return `- Texto falado TOTAL (${parts}) entre ${range.min} e ${range.max} palavras. Mire em ~${targetWords(range)}.`;
  }
  const ctaWords = countWords(cta);
  const min = Math.max(1, range.min - ctaWords);
  const max = Math.max(min, range.max - ctaWords);
  return `- Hook + todas as narrações das cenas devem somar entre ${min} e ${max} palavras (o CTA fixo acrescenta mais ${ctaWords}). Mire em ~${targetWords({ min, max })}.`;
}

function ctaRule(s: ResolvedScriptSettings, recentCtas: readonly string[]): string {
  const cta = fixedCta(s);
  if (cta) {
    return `- NÃO escreva CTA: o vídeo sempre termina com a frase fixa "${cta}", narrada logo após a última cena. Faça a última cena conduzir naturalmente até ela.`;
  }
  if (s.ctaStyle === "nenhum") return "- NÃO escreva CTA: o vídeo termina na última frase da última cena.";
  const recent = recentCtas.length > 0 ? ` Não repita estes CTAs recentes: ${recentCtas.map((c) => `"${c}"`).join(", ")}.` : "";
  return (
    `- "cta": curtíssimo (até ${CTA_MAX_WORDS} palavras), dito depois da última frase; varie a cada vídeo e NUNCA use a palavra "canal" ` +
    `(o vídeo também vai para TikTok e Instagram). Pode ser um convite para seguir ou uma pergunta que puxe comentários. ` +
    `Exemplos: "Segue pra mais curiosidades.", "Comenta: você já sabia?", "Qual te surpreendeu mais?".${recent}`
  );
}

function endingRule(s: ResolvedScriptSettings): string {
  if (!s.loopEnding) return "a última cena fecha com um desfecho satisfatório.";
  const complete = hasSpokenCta(s) ? " Termine com uma frase COMPLETA (nada de reticências ou frase cortada: a chamada final vem logo depois)." : "";
  return (
    "a última frase da última cena traz uma virada NOVA (um último fato surpreendente) que se reconecta ao gancho, " +
    `para que, quando o vídeo recomeçar, o gancho soe como continuação natural (loop). Não termine com resumo, moral ou despedida.${complete}`
  );
}

/** A CTA is spoken after the last scene (fixed one, or the model's "curto" one). */
function hasSpokenCta(s: Pick<ResolvedScriptSettings, "cta" | "ctaStyle">): boolean {
  return !!fixedCta(s) || s.ctaStyle !== "nenhum";
}

/** The last scene must not trail off ("esquecer que...") when a CTA is spoken right after it. */
export function endingProblems(script: Pick<LlmScript, "scenes">, s: Pick<ResolvedScriptSettings, "cta" | "ctaStyle">): string[] {
  const last = script.scenes.at(-1)?.narration.trim() ?? "";
  if (!hasSpokenCta(s) || !/(\.\.\.|…|[,;:—-])$/u.test(last)) return [];
  return ["A última cena termina com frase cortada ou reticências, mas a chamada final vem logo depois: termine com uma frase completa."];
}

function footageRules(s: ResolvedScriptSettings, libraries: string): string {
  const q = queryWordRange(s);
  const common = `Regras para as buscas de imagem (em INGLÊS): "hookFootageQuery" (uma), "footageQuery" (uma por cena) e "beats" (1 a ${MAX_BEATS} por cena)
- O vídeo de fundo vem automaticamente de ${libraries}. Um revisor automático descarta imagens que não mostrem o que está sendo dito naquele instante.
- ${q.min} a ${q.max} palavras por busca, nomeando COISAS CONCRETAS E VISÍVEIS, nunca conceitos abstratos (nada de "slow rotation", "time paradox", "mystery").
- "hookFootageQuery": a imagem MAIS ICÔNICA do assunto do gancho (a primeira coisa que o espectador vê).
- "beats": a imagem troca a cada coisa concreta citada. Um beat por objeto, lugar ou coisa concreta CITADA na narração da cena, na ordem em que aparece (1 a ${MAX_BEATS}).
  "phrase" = trecho LITERAL da narração (copie as palavras exatamente, sem reescrever nem resumir), começando onde a coisa é citada.
  "footageQuery" do beat nomeia EXATAMENTE a coisa citada nesse trecho: narração "vendido em sachês" -> "ketchup sachet packets", NUNCA "hamburger with ketchup".
  A "footageQuery" da cena é igual à do primeiro beat.
- Nada de texto na tela.`;
  if (!s.specificFootage) {
    return `${common}
- Bons exemplos: "venus planet nasa", "volcano lava flow", "ancient pyramids aerial", "spiral galaxy", "old parchment map", "ocean waves storm".
- Para espaço, prefira termos que a NASA usa (nome do planeta/objeto + "nasa", "planet", "telescope", "rocket launch").
- NUNCA use nomes de pessoas, marcas, logotipos, filmes, livros ou outras obras protegidas.
- Cada consulta deve ilustrar o que a narração da cena descreve, mas de forma genérica o bastante para ter resultados.`;
  }
  return `${common}
- Cada busca precisa combinar com a ÉPOCA e o LUGAR da cena: o revisor rejeita anacronismos (Guerra Civil americana numa cena da Paris de 1789, templo grego numa cena da biblioteca de Alexandria, nebulosa numa cena sobre o núcleo de um planeta).
- PODE e DEVE usar nomes concretos que acervos de domínio público e Creative Commons realmente têm: lugares e construções históricas ("Bastille fortress engraving", "Pompeii ruins"), eventos com pinturas famosas ("storming of the Bastille painting"), missões e sondas espaciais ("Voyager 2 Uranus", "Apollo 11 lunar surface"), planetas e objetos pelo nome ("Uranus planet nasa"), obras de museu antigas (pinturas, gravuras, mapas antigos) e figuras históricas JÁ FALECIDAS ("Louis XVI portrait painting").
- Para pinturas e gravuras, acrescente "painting", "engraving" ou "illustration"; para espaço, o nome do objeto ou missão + "nasa".
- Se não existe foto real do que a cena descreve (o interior de um planeta, um evento antigo), peça a ilustração específica ("Uranus interior illustration"), nunca uma imagem genérica de outra coisa.
- NUNCA: pessoas vivas, marcas, logotipos, filmes, séries, jogos, livros ou outras obras protegidas recentes.`;
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
  recentCtas: readonly string[] = [],
): string {
  const spoken = modelWritesCta(settings) ? "hook, cenas e cta" : "hook e cenas";
  return `Você é roteirista de um canal brasileiro de vídeos curtos de curiosidades (história, ciência, espaço), publicado no
YouTube Shorts, TikTok e Instagram Reels. Escreva o roteiro de um vídeo vertical narrado em português do Brasil.

Categoria: ${topic.categoryLabel}
Tema/ângulo: ${topic.seedPrompt}
Escolha você um fato específico dentro desse ângulo.
${avoidanceInstructions(avoidTitles)}${recentSubjectsInstructions(recentTitles)}${formatRule(topic.format)}
Tom de voz do roteiro: ${TONE_INSTRUCTIONS[settings.tone]}

Regras do gancho ("hook"), que decide se a pessoa fica nos 3 primeiros segundos:
- No máximo ${HOOK_MAX_WORDS} palavras (~${HOOK_MAX_SECONDS} s falado).
- Nas 5 primeiras palavras: o ASSUNTO CONCRETO pelo nome (ex.: "A Bastilha", "Urano", "A Lua") E a palavra do fato mais forte (o número, a surpresa, o payoff).
- Pode entregar a resposta surpreendente logo de cara; a curiosidade continua no "como" e no "por quê".
- Exemplos do nível esperado: "A Bastilha tinha só sete presos quando caiu." / "Em Urano pode chover diamante." / "A Lua tem cheiro: de pólvora queimada."
- Proibido: "Você sabia", "X é visto como..., mas a realidade...", "muita gente acha que...", "o que ninguém te conta", "você não vai acreditar", "prepare-se", "nem tudo é o que parece".

Regras de conteúdo:
- Todo o texto narrado (${spoken}) em pt-BR natural, falado, frases curtas e diretas.
${lengthRule(settings)}
- ${settings.minScenes} a ${settings.maxScenes} cenas, cada uma com 1 a 3 frases que avançam a história; ${endingRule(settings)}
- Use apenas fatos bem estabelecidos e amplamente documentados. Evite números exatos, a menos que sejam consenso de livro didático; prefira aproximações ("cerca de", "mais de").
- Nada de alegações de saúde, finanças ou política. Nada de teorias da conspiração ou especulação apresentada como fato.
- Escreva números por extenso quando curtos e evite siglas difíceis de pronunciar.
${ctaRule(settings, recentCtas)}
- "title": título em pt-BR, até 70 caracteres, curioso e honesto (palavras de curiosidade como "bizarro" ou "estranho" são bem-vindas quando o fato sustenta). Toda palavra importante do título precisa ser DITA no gancho e na narração das cenas: se o título promete "chuva de diamantes", o gancho e as cenas dizem "chuva" e "diamantes".
- "overlayText": ${OVERLAY_WORDS.min} a ${OVERLAY_WORDS.max} palavras que aparecem escritas na tela nos primeiros segundos e na capa; frase de impacto coerente com o título, pode usar algarismos e "?" ou "!" (ex.: "A LUA TEM CHEIRO?", "SÓ 7 PRESOS?", "CHOVE DIAMANTE EM URANO"). Sem emoji nem hashtag.

${footageRules(settings, libraries)}

Responda somente com o JSON no formato pedido.`;
}

// ---------------------------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------------------------

async function requestScript(prompt: string, s: ResolvedScriptSettings): Promise<LlmScript & { cta: string }> {
  return withEffectiveCta(await generateJson(prompt, buildLlmScriptSchema(s)), s);
}

export function toScript(raw: LlmScript, s: ResolvedScriptSettings, language: string): Script {
  const spoken = withEffectiveCta(raw, s);
  const overlayText = spoken.overlayText?.trim();
  const hookFootageQuery = spoken.hookFootageQuery?.trim();
  return {
    title: spoken.title.trim(),
    hook: spoken.hook.trim(),
    scenes: spoken.scenes.map((sc) => {
      const narration = sc.narration.trim();
      // Beats the model got wrong are dropped (none left = the whole scene is one beat, as before beats existed).
      const beats = sanitizeBeats(narration, sc.beats);
      return { narration, footageQuery: beats?.[0]?.footageQuery ?? sc.footageQuery.trim(), ...(beats ? { beats } : {}) };
    }),
    cta: spoken.cta,
    language,
    ...(overlayText ? { overlayText } : {}),
    ...(hookFootageQuery ? { hookFootageQuery } : {}),
  };
}

/** CTAs of the latest runs (render_output/<runId>/context.json), newest first, so the model varies them. */
export async function loadRecentCtas(excludeRunId: string, limit = 6): Promise<string[]> {
  if (!existsSync(paths.renderOutput)) return [];
  const dirs = (await readdir(paths.renderOutput)).filter((d) => RUN_ID_PATTERN.test(d) && d !== excludeRunId).sort().reverse();
  const ctas: string[] = [];
  for (const dir of dirs.slice(0, limit * 2)) {
    try {
      const ctx = JSON.parse(await readFile(join(paths.renderOutput, dir, "context.json"), "utf8")) as RunContext;
      const cta = ctx.script?.cta?.trim();
      if (cta && !ctas.includes(cta)) ctas.push(cta);
    } catch {
      // unreadable/partial run
    }
  }
  return ctas.slice(0, limit);
}

/**
 * After the corrective retry: an invalid model CTA is replaced by a safe one; hard issues (cliché, title
 * promise the narration never says) reject the run so runPipeline retries with a new topic; soft issues
 * are accepted with a warning when the length is within tolerance.
 */
export function settleScript(
  raw: LlmScript & { cta: string },
  s: ResolvedScriptSettings,
  recentCtas: readonly string[] = [],
): { script: LlmScript & { cta: string }; hard: string[]; soft: string[]; ctaReplaced: boolean } {
  let script = raw;
  const ctaReplaced = ctaProblems(script.cta, s).length > 0;
  if (ctaReplaced) script = { ...script, cta: fallbackCta(script.title, recentCtas) };
  const issues = findScriptIssues(script, s);
  return {
    script,
    hard: issues.filter((i) => i.hard).map((i) => i.message),
    soft: issues.filter((i) => !i.hard).map((i) => i.message),
    ctaReplaced,
  };
}

export async function run(ctx: RunContext): Promise<RunContext> {
  if (!ctx.topic) throw new Error("02-generateScript requires ctx.topic (run 01-pickTopic first)");
  const log = getLogger(ctx.runId);
  const config = loadConfig();
  const settings = resolveScript(config.script);
  const recent = await loadRecentSubjects(ctx.runId);
  const recentCtas = modelWritesCta(settings) ? await loadRecentCtas(ctx.runId) : [];
  const prompt = buildScriptPrompt(ctx.topic, ctx.avoid?.titles ?? [], settings, footageLibraries(), recent.map((r) => r.title), recentCtas);
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
  const problems = findScriptProblems(raw, settings);
  if (problems.length > 0) {
    log.warn(`Script needs a corrective retry:\n- ${problems.join("\n- ")}`);
    raw = await requestScript(withCorrection(prompt, JSON.stringify(raw, null, 2), problems.join("\n")), settings);
  }
  const settled = settleScript(raw, settings, recentCtas);
  if (settled.ctaReplaced) log.warn(`Model CTA "${raw.cta}" broke the CTA rules; using "${settled.script.cta}"`);
  if (settled.hard.length > 0) {
    throw new RunRejectedError(`Script still breaks the hook/title rules after a retry: ${settled.hard.join(" | ")}`, ctx);
  }
  if (settled.soft.length > 0) {
    if (!isWithinTolerance(settled.script, settings)) throw new Error(`Script still invalid after retry:\n- ${settled.soft.join("\n- ")}`);
    log.warn(`Accepting script with minor issues:\n- ${settled.soft.join("\n- ")}`);
  }
  const script = toScript(settled.script, settings, config.voice.language);
  const ctaNote = fixedCta(settings) ? ", fixed CTA" : `, CTA ${settings.ctaStyle}`;
  log.info(
    `Script "${script.title}" [${ctx.topic.format ?? "livre"}]: ${script.scenes.length} scenes, ${countSpokenWords(script)} spoken words ` +
      `(range ${settings.minWords}-${settings.maxWords}, tone ${settings.tone}${ctaNote}); overlay "${script.overlayText ?? ""}", ` +
      `hook "${script.hook}" (~${estimateSpeechSeconds(script.hook).toFixed(1)} s)`,
  );
  return { ...ctx, script };
}
