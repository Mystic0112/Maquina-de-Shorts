import { z } from "zod";
import { resolveScript } from "../../shared/settings.js";
import { loadConfig } from "../lib/config.js";
import { generateGroundedText, generateJson, withCorrection, type GroundedText } from "../lib/llmClient.js";
import { getLogger } from "../lib/logger.js";
import { RunRejectedError } from "../lib/rejection.js";
import type { FactCheckClaim, FactCheckSummary, RunContext, Script } from "../types.js";
import {
  countSpokenWords,
  findScriptProblems,
  isWithinTolerance,
  type ResolvedScriptSettings,
} from "./02-generateScript.js";

/** Rounds of check(+rewrite). A rewrite is always re-checked, so 3 rounds allow two rewrites. */
export const MAX_FACT_CHECK_ROUNDS = 3;

// ---------------------------------------------------------------------------------------------
// Structured result of one round (pass 2)
// ---------------------------------------------------------------------------------------------

const VerdictSchema = z.enum(["supported", "unsupported", "misleading"]);

export function buildFactCheckResultSchema(s: ResolvedScriptSettings) {
  return z.object({
    claims: z.array(
      z.object({
        claim: z.string().describe("A afirmação factual como aparece no roteiro"),
        verdict: VerdictSchema,
        correction: z.string().optional().describe("Versão correta, em pt-BR, quando não for 'supported'"),
      }),
    ),
    publishable: z.boolean().describe("false só se a premissa central for falsa e não houver como salvar o roteiro"),
    reason: z.string().describe("Resumo curto do resultado, em pt-BR"),
    title: z.string().min(5).max(95),
    hook: z.string().min(10),
    scenes: z
      .array(z.object({ narration: z.string().min(10), footageQuery: z.string().min(3) }))
      .min(s.minScenes)
      .max(s.maxScenes),
    changes: z.array(z.string()).describe("Cada edição feita no roteiro, em pt-BR (vazio se nada mudou)"),
  });
}

export type FactCheckResult = z.infer<ReturnType<typeof buildFactCheckResultSchema>>;

export type RoundOutcome =
  | { kind: "clean"; script: Script; claims: FactCheckClaim[]; titleChanged: boolean }
  | { kind: "revised"; script: Script; claims: FactCheckClaim[]; changes: string[] }
  | { kind: "reject"; reason: string; claims: FactCheckClaim[] };

export function toClaims(result: Pick<FactCheckResult, "claims">, round: number): FactCheckClaim[] {
  return result.claims.map((c) => ({
    claim: c.claim.trim(),
    verdict: c.verdict,
    ...(c.verdict !== "supported" && c.correction?.trim() ? { correction: c.correction.trim() } : {}),
    round,
  }));
}

/**
 * Pure: turns one round's structured result into the next script.
 * - all claims supported: keep the script verbatim (the model may only retitle a sensational title);
 * - some unsupported/misleading: take the rewritten hook/scenes (CTA and language never change);
 * - not publishable, or a rewrite that breaks the length limits beyond tolerance: reject.
 */
export function applyFactCheckRound(
  script: Script,
  result: FactCheckResult,
  round: number,
  settings: ResolvedScriptSettings,
): RoundOutcome {
  const claims = toClaims(result, round);
  if (!result.publishable) return { kind: "reject", reason: result.reason || "premissa central incorreta", claims };
  const title = result.title.trim() || script.title;
  const failing = claims.filter((c) => c.verdict !== "supported");
  if (failing.length === 0) {
    return { kind: "clean", script: { ...script, title }, claims, titleChanged: title !== script.title };
  }
  const revised: Script = {
    ...script,
    title,
    hook: result.hook.trim(),
    scenes: result.scenes.map((scene, i) => ({
      narration: scene.narration.trim(),
      footageQuery: scene.footageQuery.trim() || script.scenes[i]?.footageQuery || script.scenes[0]?.footageQuery || "",
    })),
  };
  const problems = findScriptProblems(revised, settings);
  if (problems.length > 0 && !isWithinTolerance(revised, settings)) {
    return { kind: "reject", reason: `roteiro corrigido fora dos limites: ${problems.join("; ")}`, claims };
  }
  return { kind: "revised", script: revised, claims, changes: result.changes.map((c) => c.trim()).filter(Boolean) };
}

// ---------------------------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------------------------

function scriptForReview(script: Script): string {
  const scenes = script.scenes.map((s, i) => `Cena ${i + 1}: ${s.narration}`).join("\n");
  return `Título: ${script.title}\nGancho: ${script.hook}\n${scenes}`;
}

export function buildGroundedReviewPrompt(script: Script): string {
  return `Você é um checador de fatos rigoroso de um canal brasileiro de YouTube Shorts de curiosidades.
Nenhum humano revisa os vídeos antes da publicação: erros factuais vão ao ar. Use a busca do Google para
verificar CADA afirmação factual do roteiro abaixo (título, gancho e narração das cenas; ignore chamadas para
seguir o canal).

${scriptForReview(script)}

Para cada afirmação, escreva uma linha no formato:
[n] "<trecho do roteiro>" | VEREDITO: correto, sem respaldo ou enganoso | CORREÇÃO: <versão precisa em pt-BR, ou "-"> | FONTES: <sites consultados>

Critérios:
- "sem respaldo": falso, ou não encontrado em fontes confiáveis.
- "enganoso": tecnicamente verdadeiro mas induz a erro (ex.: confundir dia sideral com dia solar), números
  exagerados ou arredondados de forma errada, causalidade simplificada demais ("X causou Y" quando foi um entre
  vários fatores), lendas apresentadas como fato.
- Seja específico nas correções: diga o valor ou fato correto.
Depois, avalie o TÍTULO: é sensacionalista ou atribui causa/efeito de forma enganosa? Se for, proponha um título
preciso e ainda curioso (até 70 caracteres).
Termine com uma linha "CONCLUSÃO:" dizendo se a premissa central do vídeo se sustenta.`;
}

export function buildRevisionPrompt(
  script: Script,
  review: GroundedText,
  settings: ResolvedScriptSettings,
  previousCorrections: readonly string[] = [],
): string {
  const cta = script.cta.trim();
  const earlier = previousCorrections.length
    ? [
        "",
        "CORREÇÕES JÁ APLICADAS EM RODADAS ANTERIORES (não as desfaça nem reintroduza o erro original):",
        ...previousCorrections.map((c) => `- ${c}`),
        "",
      ].join("\n")
    : "";
  return `Você recebe um roteiro de YouTube Short (pt-BR) e a checagem de fatos feita com busca na web.
Transforme a checagem em JSON e, se necessário, corrija o roteiro.

ROTEIRO ATUAL (JSON):
${JSON.stringify({ title: script.title, hook: script.hook, scenes: script.scenes }, null, 2)}
Chamada final fixa, narrada depois da última cena (não a altere nem a repita): "${cta}"

CHECAGEM DE FATOS:
${review.text.trim()}
${earlier}
Regras:
- "claims": uma entrada por afirmação checada, com verdict "supported" (correto), "unsupported" (sem respaldo) ou
  "misleading" (enganoso), e "correction" quando não for "supported".
- Se TODAS forem "supported": devolva hook e scenes EXATAMENTE iguais ao roteiro atual. Só troque o título se a
  checagem o considerou sensacionalista ou enganoso.
- Se houver "unsupported" ou "misleading": reescreva SOMENTE as frases problemáticas usando as correções (ou remova
  a frase se não houver como corrigir). Mantenha as demais frases palavra por palavra, o tom e o estilo falado.
- Limites: texto falado total (gancho + cenas + chamada final) entre ${settings.minWords} e ${settings.maxWords} palavras;
  de ${settings.minScenes} a ${settings.maxScenes} cenas, cada uma com 1 a 3 frases. Atualmente: ${countSpokenWords(script)} palavras.
- "footageQuery": mantenha a da cena, a menos que o assunto visual da cena tenha mudado (2-4 palavras em inglês,
  coisas concretas e visíveis).
- "title": se a checagem NÃO apontou problema no título, devolva-o EXATAMENTE igual. Se apontou, use o título
  sugerido pela checagem (ou um equivalente) com até 70 caracteres, curioso mas preciso, e que não repita nenhuma
  afirmação marcada como "unsupported" ou "misleading".
- "publishable": false apenas se a premissa central do vídeo for falsa e não houver como salvá-lo dentro dos limites.
- "changes": cada edição feita, em pt-BR (lista vazia se nada mudou).
Responda somente com o JSON.`;
}

// ---------------------------------------------------------------------------------------------
// Orchestration (LLM access injected for tests)
// ---------------------------------------------------------------------------------------------

export interface FactCheckDeps {
  grounded(prompt: string): Promise<GroundedText>;
  structured(prompt: string, schema: z.ZodType<FactCheckResult>): Promise<FactCheckResult>;
  log?(message: string): void;
}

export const defaultFactCheckDeps: FactCheckDeps = {
  grounded: (prompt) => generateGroundedText(prompt, { thinking: "low", temperature: 0.2 }),
  structured: (prompt, schema) => generateJson(prompt, schema, { thinking: "low", temperature: 0.2 }),
};

interface ReviewRound {
  outcome: RoundOutcome;
  review: GroundedText;
}

/** One round: grounded review (text + sources), then structured verdicts/rewrite; one retry on limit breaks. */
async function reviewRound(
  script: Script,
  round: number,
  settings: ResolvedScriptSettings,
  deps: FactCheckDeps,
  previousCorrections: readonly string[],
): Promise<ReviewRound> {
  const reviewPrompt = buildGroundedReviewPrompt(script);
  let review = await deps.grounded(reviewPrompt);
  if (review.sources.length === 0) {
    // A "review" with no web sources is the model answering from memory: not a fact-check.
    deps.log?.(`Fact-check round ${round}: grounded review returned no web sources; retrying once`);
    review = await deps.grounded(reviewPrompt);
    if (review.sources.length === 0) return { outcome: { kind: "reject", reason: "checagem sem fontes da web (busca indisponível)", claims: [] }, review };
  }
  const schema = buildFactCheckResultSchema(settings);
  const prompt = buildRevisionPrompt(script, review, settings, previousCorrections);
  let result = await deps.structured(prompt, schema);
  if (result.claims.length === 0) {
    deps.log?.(`Fact-check round ${round}: no claims extracted; retrying once`);
    result = await deps.structured(withCorrection(prompt, JSON.stringify(result, null, 2), "Nenhuma afirmação foi listada em \"claims\"; liste cada afirmação factual checada."), schema);
    if (result.claims.length === 0) return { outcome: { kind: "reject", reason: "nenhuma afirmação extraída da checagem", claims: [] }, review };
  }
  let outcome = applyFactCheckRound(script, result, round, settings);
  if (outcome.kind === "reject" && result.publishable) {
    deps.log?.(`Fact-check round ${round}: ${outcome.reason}; asking for a corrected rewrite`);
    result = await deps.structured(withCorrection(prompt, JSON.stringify(result, null, 2), outcome.reason), schema);
    outcome = applyFactCheckRound(script, result, round, settings);
  }
  return { outcome, review };
}

export interface FactCheckRun {
  script: Script;
  summary: FactCheckSummary;
}

/** Up to MAX_FACT_CHECK_ROUNDS rounds; every rewrite must pass a fresh grounded check. */
export async function factCheckScript(
  original: Script,
  settings: ResolvedScriptSettings,
  deps: FactCheckDeps = defaultFactCheckDeps,
): Promise<FactCheckRun> {
  let script = original;
  const claims: FactCheckClaim[] = [];
  const corrections: string[] = [];
  const sources: GroundedText["sources"] = [];
  const queries: string[] = [];
  let claimsChecked = 0;
  for (let round = 1; round <= MAX_FACT_CHECK_ROUNDS; round++) {
    const { outcome, review } = await reviewRound(script, round, settings, deps, corrections);
    claims.push(...outcome.claims);
    sources.push(...review.sources);
    queries.push(...review.queries);
    if (round === 1) claimsChecked = outcome.claims.length;
    const base = { rounds: round, claimsChecked, claims, sources: uniqueSources(sources), searchQueries: [...new Set(queries)] };
    if (outcome.kind === "reject") {
      return { script, summary: { ...base, verdict: "fail", corrections, reason: outcome.reason } };
    }
    if (outcome.kind === "clean") {
      if (outcome.titleChanged) corrections.push(`Título: "${script.title}" -> "${outcome.script.title}"`);
      const changed = outcome.script.title !== original.title || corrections.length > 0;
      const summary: FactCheckSummary = {
        ...base,
        verdict: changed ? "corrected" : "pass",
        corrections,
        ...(changed ? { titleBefore: original.title, titleAfter: outcome.script.title, originalScript: original } : {}),
      };
      return { script: outcome.script, summary };
    }
    corrections.push(...outcome.changes);
    if (outcome.script.title !== script.title) corrections.push(`Título: "${script.title}" -> "${outcome.script.title}"`);
    script = outcome.script;
    if (round === MAX_FACT_CHECK_ROUNDS && outcome.claims.every((c) => c.verdict !== "unsupported")) {
      // Last round only found nuance ("misleading"): its rewrite still gets a grounded verification pass.
      // Published text is always text the web-grounded check has seen; anything false there fails.
      const verification = await reviewRound(script, round, settings, deps, corrections);
      sources.push(...verification.review.sources);
      queries.push(...verification.review.queries);
      claims.push(...verification.outcome.claims);
      const verified = verification.outcome;
      const ok = verified.kind === "clean" || (verified.kind === "revised" && verified.claims.every((c) => c.verdict !== "unsupported"));
      const verifiedBase = { ...base, claims, sources: uniqueSources(sources), searchQueries: [...new Set(queries)] };
      if (!ok) {
        const reason = verified.kind === "reject" ? verified.reason : "a verificação final ainda encontrou afirmações sem respaldo";
        return { script, summary: { ...verifiedBase, verdict: "fail", corrections, reason } };
      }
      corrections.push("Última rodada: correções de precisão verificadas com nova busca (sem afirmações falsas).");
      const summary: FactCheckSummary = {
        ...verifiedBase,
        verdict: "corrected",
        corrections,
        titleBefore: original.title,
        titleAfter: script.title,
        originalScript: original,
      };
      return { script, summary };
    }
  }
  const reason = `afirmações ainda incorretas após ${MAX_FACT_CHECK_ROUNDS} rodadas de correção`;
  return {
    script,
    summary: {
      verdict: "fail",
      rounds: MAX_FACT_CHECK_ROUNDS,
      claimsChecked,
      claims,
      corrections,
      sources: uniqueSources(sources),
      searchQueries: [...new Set(queries)],
      reason,
    },
  };
}

function uniqueSources(sources: GroundedText["sources"]): GroundedText["sources"] {
  const seen = new Set<string>();
  return sources.filter((s) => (seen.has(s.uri) ? false : (seen.add(s.uri), true)));
}

// ---------------------------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------------------------

export async function run(ctx: RunContext): Promise<RunContext> {
  if (!ctx.script) throw new Error("02b-factCheck requires ctx.script (run 02-generateScript first)");
  const log = getLogger(ctx.runId);
  const settings = resolveScript(loadConfig().script);
  if (!settings.factCheck) {
    log.warn("Fact-check disabled (script.factCheck=false); the script is NOT verified");
    const skipped: FactCheckSummary = {
      verdict: "skipped", rounds: 0, claimsChecked: 0, claims: [], corrections: [], sources: [], searchQueries: [],
    };
    return { ...ctx, factCheck: skipped };
  }
  const { script, summary } = await factCheckScript(ctx.script, settings, { ...defaultFactCheckDeps, log: (m) => log.warn(m) });
  const failing = summary.claims.filter((c) => c.verdict !== "supported");
  for (const c of failing) log.info(`Fact-check r${c.round} ${c.verdict}: "${c.claim}"${c.correction ? ` -> ${c.correction}` : ""}`);
  for (const change of summary.corrections) log.info(`Fact-check change: ${change}`);
  log.info(
    `Fact-check: ${summary.verdict} - ${summary.claimsChecked} claims, ${failing.length} flagged, ` +
      `${summary.rounds} round(s), ${summary.sources.length} sources, ${countSpokenWords(script)} spoken words`,
  );
  if (summary.verdict === "fail") {
    // Keep the script as generated; the summary holds the flagged claims for the dashboard.
    const rejected: RunContext = { ...ctx, factCheck: summary };
    throw new RunRejectedError(`Fact-check rejected the script: ${summary.reason ?? "unknown reason"}`, rejected);
  }
  return { ...ctx, script, factCheck: summary };
}
