import { z } from "zod";
import { env, loadConfig } from "../lib/config.js";
import { generateJson, withCorrection } from "../lib/llmClient.js";
import { getLogger } from "../lib/logger.js";
import type { RunContext, Script, TopicPick } from "../types.js";

export const WORD_RANGE = { min: 130, max: 190 } as const;
/** After the corrective retry, accept slightly-off scripts (with a warning) instead of failing the run. */
export const WORD_TOLERANCE = { min: 115, max: 215 } as const;
const SCENE_RANGE = { min: 4, max: 7 } as const;
const QUERY_WORDS = { min: 2, max: 4 } as const;

export const LlmScriptSchema = z.object({
  title: z.string().min(5).max(95).describe("Título do Short em pt-BR, chamativo, sem clickbait enganoso"),
  hook: z.string().min(10).describe("Primeira frase: gancho de curiosidade forte, em pt-BR"),
  scenes: z
    .array(
      z.object({
        narration: z.string().min(10).describe("Narração da cena em pt-BR (1-3 frases curtas)"),
        footageQuery: z.string().min(3).describe("2-4 English words describing generic, filmable footage"),
      }),
    )
    .min(SCENE_RANGE.min)
    .max(SCENE_RANGE.max),
  cta: z.string().min(3).describe("CTA curto em pt-BR pedindo para seguir o canal"),
});

export type LlmScript = z.infer<typeof LlmScriptSchema>;

export function countWords(text: string): number {
  return text.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
}

export function countSpokenWords(script: Pick<Script, "hook" | "scenes" | "cta">): number {
  return countWords([script.hook, ...script.scenes.map((s) => s.narration), script.cta].join(" "));
}

/** Problems the JSON schema cannot express. Empty array = script is acceptable. */
export function findScriptProblems(script: LlmScript): string[] {
  const problems: string[] = [];
  const words = countSpokenWords(script);
  if (words < WORD_RANGE.min || words > WORD_RANGE.max) {
    problems.push(
      `O texto falado (hook + cenas + cta) tem ${words} palavras; precisa ter entre ${WORD_RANGE.min} e ${WORD_RANGE.max}.` +
        (words < WORD_RANGE.min ? " Desenvolva mais as cenas." : " Corte frases e enxugue as cenas."),
    );
  }
  script.scenes.forEach((scene, i) => {
    const n = countWords(scene.footageQuery);
    if (n < QUERY_WORDS.min || n > QUERY_WORDS.max) {
      problems.push(`scenes[${i}].footageQuery "${scene.footageQuery}" tem ${n} palavras; use de 2 a 4 palavras em inglês.`);
    }
  });
  return problems;
}

export function isWithinTolerance(script: LlmScript): boolean {
  const words = countSpokenWords(script);
  return words >= WORD_TOLERANCE.min && words <= WORD_TOLERANCE.max;
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

export function buildScriptPrompt(topic: TopicPick, avoidTitles: readonly string[] = []): string {
  return `Você é roteirista de um canal brasileiro de YouTube Shorts de curiosidades (história, ciência, espaço).
Escreva o roteiro de um Short narrado em português do Brasil.

Categoria: ${topic.categoryLabel}
Tema/ângulo: ${topic.seedPrompt}
Escolha você um fato específico dentro desse ângulo.
${avoidanceInstructions(avoidTitles)}
Regras de conteúdo:
- Todo o texto narrado (hook, cenas e cta) em pt-BR natural, falado, frases curtas e diretas.
- Texto falado TOTAL (hook + todas as narrações das cenas + cta) entre ${WORD_RANGE.min} e ${WORD_RANGE.max} palavras (narração de 45 a 90 segundos). Mire em ~160.
- "hook": a primeira frase é um gancho de curiosidade forte que prende nos 2 primeiros segundos (pergunta intrigante ou afirmação surpreendente). Não comece com "Você sabia".
- ${SCENE_RANGE.min} a ${SCENE_RANGE.max} cenas, cada uma com 1 a 3 frases que avançam a história; a última cena fecha com um desfecho satisfatório.
- Use apenas fatos bem estabelecidos e amplamente documentados. Evite números exatos, a menos que sejam consenso de livro didático; prefira aproximações ("cerca de", "mais de").
- Nada de alegações de saúde, finanças ou política. Nada de teorias da conspiração ou especulação apresentada como fato.
- Escreva números por extenso quando curtos e evite siglas difíceis de pronunciar.
- "cta": curtíssimo (até 8 palavras), pedindo para seguir o canal para mais curiosidades.
- "title": título do Short em pt-BR, até 70 caracteres, instigante mas honesto.

Regras para "footageQuery" (uma por cena, em INGLÊS):
- O vídeo de fundo vem automaticamente de ${footageLibraries()}. Um revisor automático descarta vídeos que não mostrem o que a cena narra.
- 2 a 4 palavras nomeando COISAS CONCRETAS E VISÍVEIS que esses acervos têm, nunca conceitos abstratos (nada de "slow rotation", "time paradox", "mystery").
- Bons exemplos: "venus planet nasa", "volcano lava flow", "ancient pyramids aerial", "spiral galaxy", "old parchment map", "ocean waves storm", "lightning storm night".
- Para espaço, prefira termos que a NASA usa (nome do planeta/objeto + "nasa", "planet", "telescope", "rocket launch").
- NUNCA use nomes de pessoas, marcas, logotipos, filmes, livros ou outras obras protegidas; nada de texto na tela.
- Cada consulta deve ilustrar o que a narração da cena descreve, mas de forma genérica o bastante para ter resultados.

Responda somente com o JSON no formato pedido.`;
}

async function requestScript(prompt: string): Promise<LlmScript> {
  return generateJson(prompt, LlmScriptSchema);
}

function toScript(raw: LlmScript, language: string): Script {
  return {
    title: raw.title.trim(),
    hook: raw.hook.trim(),
    scenes: raw.scenes.map((s) => ({ narration: s.narration.trim(), footageQuery: s.footageQuery.trim() })),
    cta: raw.cta.trim(),
    language,
  };
}

export async function run(ctx: RunContext): Promise<RunContext> {
  if (!ctx.topic) throw new Error("02-generateScript requires ctx.topic (run 01-pickTopic first)");
  const log = getLogger(ctx.runId);
  const prompt = buildScriptPrompt(ctx.topic, ctx.avoid?.titles ?? []);
  let raw = await requestScript(prompt);
  let problems = findScriptProblems(raw);
  if (problems.length > 0) {
    log.warn(`Script needs a corrective retry:\n- ${problems.join("\n- ")}`);
    raw = await requestScript(withCorrection(prompt, JSON.stringify(raw, null, 2), problems.join("\n")));
    problems = findScriptProblems(raw);
  }
  if (problems.length > 0) {
    if (!isWithinTolerance(raw)) throw new Error(`Script still invalid after retry:\n- ${problems.join("\n- ")}`);
    log.warn(`Accepting script with minor issues:\n- ${problems.join("\n- ")}`);
  }
  const script = toScript(raw, loadConfig().voice.language);
  log.info(`Script "${script.title}": ${script.scenes.length} scenes, ${countSpokenWords(script)} spoken words`);
  return { ...ctx, script };
}
