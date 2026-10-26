/**
 * "Terminal" format (script.imageSource "terminal"): no footage at all. After the fact-check, one LLM call turns
 * each scene's narration into an animated card (big phrase, number, checklist or comparison) shown inside a
 * terminal window. Cards only re-show what the narration says: every number must already be in the fact-checked
 * script (as digits or spelled out, in any scene), so the cards never add a claim the fact-check did not see.
 */
import { z } from "zod";
import { generateJson, withCorrection } from "./llmClient.js";
import type { Script, TerminalCard, TerminalScene } from "../types.js";

export const CARD_KINDS = ["headline", "number", "list", "compare"] as const;
const LIMITS = { headline: 60, label: 40, value: 12, item: 40, side: 28, command: 36, comment: 70 } as const;

/** Flat on purpose: the agy/Gemini JSON schema handles one object better than a union. */
const DraftCardSchema = z.object({
  sceneIndex: z.number().int().min(0),
  command: z.string().min(2).describe('comando fictício curto em minúsculas, ex.: "som --na-agua"'),
  kind: z.enum(CARD_KINDS),
  text: z.string().optional().describe("headline: frase curta tirada da narração"),
  highlight: z.string().optional().describe("headline: UMA palavra do text que fica em destaque"),
  value: z.string().optional().describe('number: o número citado na narração, ex.: "4x", "1.500", "80%"'),
  label: z.string().optional().describe("number: o que o número significa"),
  items: z.array(z.string()).optional().describe("list: 2 a 4 itens curtos citados na narração"),
  left: z.string().optional(),
  right: z.string().optional(),
  leftValue: z.string().optional(),
  rightValue: z.string().optional(),
  comment: z.string().optional().describe("comentário curto que resume a cena, sem fato novo"),
});
export const TerminalDraftSchema = z.object({ scenes: z.array(DraftCardSchema).min(1) });
export type TerminalDraft = z.infer<typeof TerminalDraftSchema>;

const UNITS = ["zero", "um", "dois", "tres", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze", "treze", "catorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove", "vinte"];
const TENS: Record<number, string> = { 30: "trinta", 40: "quarenta", 50: "cinquenta", 60: "sessenta", 70: "setenta", 80: "oitenta", 90: "noventa", 100: "cem", 1000: "mil" };

const fold = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Spoken forms of a number, as far as the narration usually spells them ("4" -> "quatro", "uma"). */
function spokenForms(n: number): string[] {
  const forms: string[] = [];
  if (n >= 0 && n <= 20) forms.push(UNITS[n]!);
  if (n === 1) forms.push("uma");
  if (n === 2) forms.push("duas");
  if (TENS[n]) forms.push(TENS[n]!);
  if (n === 14) forms.push("quatorze");
  return forms;
}

/** Numbers written in a card that are NOT in the source text (digits or spelled out): each is a possible new claim. */
export function unknownNumbers(cardText: string, source: string): string[] {
  const src = fold(source);
  const srcDigits = src.replace(/(\d)[.\s](?=\d{3}\b)/g, "$1"); // "1.500" / "1 500" -> "1500"
  const words = new Set(src.split(/[^a-z0-9]+/));
  const out: string[] = [];
  for (const raw of cardText.match(/\d+(?:[.,]\d+)*/g) ?? []) {
    const plain = raw.replace(/\.(?=\d{3}\b)/g, ""); // thousands separator
    const n = Number(plain.replace(",", "."));
    const known = new RegExp(`(^|[^\\d])${plain.replace(/[.,]/g, "[.,]")}([^\\d]|$)`).test(srcDigits) || spokenForms(n).some((w) => words.has(w));
    if (!known) out.push(raw);
  }
  return out;
}

function cardOf(d: TerminalDraft["scenes"][number]): TerminalCard | string {
  switch (d.kind) {
    case "headline": {
      const text = d.text?.trim();
      if (!text) return 'headline sem "text"';
      if (text.length > LIMITS.headline) return `headline com ${text.length} caracteres (máximo ${LIMITS.headline})`;
      const highlight = d.highlight?.trim();
      if (highlight && !fold(text).includes(fold(highlight))) return `highlight "${highlight}" não está no text`;
      return { kind: "headline", text, ...(highlight ? { highlight } : {}) };
    }
    case "number": {
      const value = d.value?.trim();
      const label = d.label?.trim();
      if (!value || !label) return 'number precisa de "value" e "label"';
      if (value.length > LIMITS.value || label.length > LIMITS.label) return `number longo demais (value até ${LIMITS.value}, label até ${LIMITS.label})`;
      return { kind: "number", value, label };
    }
    case "list": {
      const items = (d.items ?? []).map((i) => i.trim()).filter(Boolean);
      if (items.length < 2 || items.length > 4) return `list precisa de 2 a 4 itens (veio ${items.length})`;
      if (items.some((i) => i.length > LIMITS.item)) return `item de list com mais de ${LIMITS.item} caracteres`;
      return { kind: "list", items };
    }
    case "compare": {
      const left = d.left?.trim();
      const right = d.right?.trim();
      if (!left || !right) return 'compare precisa de "left" e "right"';
      if (left.length > LIMITS.side || right.length > LIMITS.side) return `lado de compare com mais de ${LIMITS.side} caracteres`;
      const leftValue = d.leftValue?.trim();
      const rightValue = d.rightValue?.trim();
      return { kind: "compare", left, right, ...(leftValue ? { leftValue } : {}), ...(rightValue ? { rightValue } : {}) };
    }
  }
}

const cardText = (c: TerminalCard): string =>
  c.kind === "headline" ? c.text : c.kind === "number" ? `${c.value} ${c.label}` : c.kind === "list" ? c.items.join(" ") : `${c.left} ${c.right} ${c.leftValue ?? ""} ${c.rightValue ?? ""}`;

/** Draft -> scenes, or the problems to send back to the model. */
export function validateTerminalDraft(draft: TerminalDraft, script: Pick<Script, "title" | "hook" | "scenes">): { scenes: TerminalScene[]; problems: string[] } {
  const problems: string[] = [];
  const scenes: TerminalScene[] = [];
  const bySceneIndex = new Map(draft.scenes.map((s) => [s.sceneIndex, s]));
  // Numbers may come from anywhere in the fact-checked script (a comparison often reuses an earlier scene's value).
  const source = [script.title, script.hook, ...script.scenes.map((s) => s.narration)].join(" ");
  script.scenes.forEach((_scene, i) => {
    const d = bySceneIndex.get(i);
    if (!d) return problems.push(`falta o cartão da cena ${i}`);
    const card = cardOf(d);
    if (typeof card === "string") return problems.push(`cena ${i}: ${card}`);
    const command = d.command.trim().toLowerCase();
    if (command.length > LIMITS.command || !/^[a-z0-9][a-z0-9 ._-]*$/.test(command)) problems.push(`cena ${i}: command "${d.command}" deve ter até ${LIMITS.command} caracteres, só letras minúsculas sem acento, números, espaço, "-" e "."`);
    const comment = d.comment?.trim();
    if (comment && comment.length > LIMITS.comment) problems.push(`cena ${i}: comment com mais de ${LIMITS.comment} caracteres`);
    const unknown = unknownNumbers(`${cardText(card)} ${comment ?? ""}`, source);
    if (unknown.length) problems.push(`cena ${i}: número(s) ${unknown.join(", ")} não aparecem no roteiro; use só números ditos na narração`);
    scenes.push({ sceneIndex: i, command, card, ...(comment ? { comment } : {}) });
  });
  return { scenes, problems };
}

export function buildTerminalPrompt(script: Pick<Script, "title" | "hook" | "scenes">): string {
  return [
    "Você cria a parte visual de um vídeo curto de curiosidades no estilo TERMINAL DE PROGRAMADOR: não há imagens, cada cena",
    "mostra UM cartão animado dentro de uma janela de terminal, enquanto a narração toca.",
    `Título: ${script.title}`,
    `Gancho: ${script.hook}`,
    "",
    "CENAS (índice: narração):",
    ...script.scenes.map((s, i) => `${i}: ${s.narration}`),
    "",
    "Para CADA cena, escolha o tipo de cartão que melhor mostra o que é dito:",
    `- "headline": a frase-chave da cena em até ${LIMITS.headline} caracteres ("text"), com UMA palavra de destaque ("highlight") que esteja no text.`,
    '- "number": quando a cena cita um número marcante: "value" (ex.: "4x", "1.500 m/s", "80%") e "label" (o que ele significa).',
    '- "list": quando a cena enumera 2 a 4 coisas: "items" curtos.',
    '- "compare": quando a cena compara duas coisas: "left" e "right" (e "leftValue"/"rightValue" se a narração der os valores).',
    'Também: "command" = comando fictício curto em minúsculas sem acento que "executa" a cena (ex.: "som --na-agua", "garfo --historia 1004");',
    'e "comment" opcional = comentário curto de programador que resume a cena ("// a água empurra o som mais rápido").',
    "",
    "REGRAS: varie os tipos (não use headline em todas); use SÓ o que a narração diz: nenhum número, nome ou fato que não esteja",
    "nela (os números serão conferidos); textos em pt-BR curtos e diretos; nada de emoji.",
    "",
    'Responda só com JSON: {"scenes":[{"sceneIndex":0,"command":"...","kind":"headline","text":"...","highlight":"...","comment":"..."}, ...]}',
  ].join("\n");
}

/** One LLM call (plus corrections) -> a validated card per scene. */
export async function planTerminal(script: Script, options: { model?: string; attempts?: number } = {}): Promise<TerminalScene[]> {
  const prompt = buildTerminalPrompt(script);
  let current = prompt;
  let last = "";
  for (let attempt = 1; attempt <= (options.attempts ?? 3); attempt++) {
    const draft = await generateJson(current, TerminalDraftSchema, { model: options.model, thinking: "low", temperature: 0.6 });
    const { scenes, problems } = validateTerminalDraft(draft, script);
    if (problems.length === 0) return scenes;
    last = problems.join("\n");
    current = withCorrection(prompt, JSON.stringify(draft), last);
  }
  throw new Error(`Terminal cards still invalid:\n${last}`);
}
