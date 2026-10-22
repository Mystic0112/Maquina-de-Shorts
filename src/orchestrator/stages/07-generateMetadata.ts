import { z } from "zod";
import { loadConfig } from "../lib/config.js";
import { generateJson } from "../lib/llmClient.js";
import { getLogger } from "../lib/logger.js";
import { creditsFor } from "../lib/memeLibrary.js";
import { runCutMetadata } from "../cuts/metadata.js";
import type { CutRunContext } from "../cuts/types.js";
import type { EditPlan, FootageClip, RunContext, Script, TopicPick, VideoMetadata } from "../types.js";

// YouTube Data API limits (videos.insert snippet).
export const TITLE_MAX = 100;
export const DESCRIPTION_MAX = 5000;
export const TAGS_MAX = 500;
const SHORTS_TAG = "#Shorts";

// ---------------------------------------------------------------------------------------------
// Image credits
// ---------------------------------------------------------------------------------------------

export type LicenseKind = "attribution" | "stock" | "public";

/** CC BY (any version, no SA/NC/ND reach this point: the adapter's license gate drops them) needs credit. */
export function licenseKind(clip: Pick<FootageClip, "license" | "source">): LicenseKind {
  const license = clip.license.toLowerCase();
  if (/\bcc[\s-]*by\b/.test(license) || license.includes("creative commons attribution")) return "attribution";
  if (/pexels|pixabay/.test(`${clip.source} ${license}`.toLowerCase())) return "stock";
  return "public";
}

function sourceLabel(source: string): string {
  const s = source.toLowerCase();
  if (s.includes("wikimedia")) return "Wikimedia Commons";
  if (s.includes("nasa")) return "NASA";
  if (s.includes("pexels")) return "Pexels";
  if (s.includes("pixabay")) return "Pixabay";
  return source || "fonte desconhecida";
}

/** One entry per distinct source file (borrowed scenes reuse a clip; credit it once). */
export function uniqueClips(footage: readonly FootageClip[]): FootageClip[] {
  const seen = new Set<string>();
  return footage.filter((c) => {
    const key = c.sourceUrl || c.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * "Créditos das imagens" block. CC BY clips are listed one by one with creator, license and link
 * (required by the license); stock-site clips get a short creator line; public-domain/CC0 material is
 * summarised per source. NASA material carries the usual no-endorsement note.
 */
export function buildCredits(footage: readonly FootageClip[], compact = false): string {
  const clips = uniqueClips(footage);
  if (clips.length === 0) return "";
  const lines = ["Créditos das imagens:"];
  const attribution = clips.filter((x) => licenseKind(x) === "attribution");
  if (compact) lines.push(...compactAttributionLines(attribution));
  else for (const c of attribution) lines.push(attributionLine(c));
  const stock = clips.filter((x) => licenseKind(x) === "stock");
  if (compact && stock.length > 0) {
    const bySite = countBy(stock, (c) => sourceLabel(c.source));
    lines.push(`• ${[...bySite].map(([site, n]) => `${site} (${n})`).join(", ")}`);
  } else {
    for (const c of stock) {
      lines.push(`• ${c.creator.trim() || "Autor desconhecido"} via ${sourceLabel(c.source)} (${c.license.trim() || "licença do site"})`);
    }
  }
  const publicBySource = countBy(clips.filter((x) => licenseKind(x) === "public"), (c) => sourceLabel(c.source));
  if (publicBySource.size > 0) {
    const parts = [...publicBySource].map(([source, n]) => `${source} (${n})`);
    lines.push(`• Domínio público / CC0: ${parts.join(", ")}`);
  }
  if (clips.some((c) => sourceLabel(c.source) === "NASA")) {
    lines.push("Imagens da NASA usadas conforme as diretrizes de mídia da NASA; não implicam endosso.");
  }
  return lines.join("\n");
}

function licenseLabel(c: Pick<FootageClip, "license" | "licenseUrl">): string {
  return c.licenseUrl ? `${c.license.trim()} (${c.licenseUrl})` : c.license.trim();
}

const PLACEHOLDER_CREATORS = new Set(["", "unknown", "desconhecido", "autor desconhecido", "n/a", "none", "-", "null", "undefined"]);

function looksLikeUrl(text: string): boolean {
  return /^(https?:\/\/|www\.)\S+$/i.test(text.trim());
}

/** A real author name: not empty, not a placeholder, not just a URL. */
export function usableCreatorName(creator: string): boolean {
  const name = creator.trim();
  return !PLACEHOLDER_CREATORS.has(name.toLowerCase()) && !looksLikeUrl(name);
}

/** "Name (profile URL)"; a creator given only as a URL is shown as a profile link, never as a name. */
function creatorLabel(c: Pick<FootageClip, "creator" | "creatorUrl">): string {
  const raw = c.creator.trim();
  const url = c.creatorUrl ?? (looksLikeUrl(raw) ? raw : undefined);
  const name = usableCreatorName(raw) ? raw : url ? "Autor" : "Autor desconhecido";
  return url ? `${name} (${url})` : name;
}

/** CC BY credits must indicate changes: every clip is cropped to 9:16, trimmed and re-encoded. */
export const MODIFIED_NOTE = "(recortado e editado)";

function attributionLine(c: FootageClip): string {
  return `• ${creatorLabel(c)} — ${licenseLabel(c)} — ${c.sourceUrl || sourceLabel(c.source)} ${MODIFIED_NOTE}`;
}

/** Same creator + license on several files: one line listing every file link (no credit is dropped). */
function compactAttributionLines(clips: readonly FootageClip[]): string[] {
  const groups = new Map<string, FootageClip[]>();
  for (const c of clips) {
    const key = `${c.creator.trim()}|${c.creatorUrl ?? ""}|${c.license.trim()}|${c.licenseUrl ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0] as FootageClip;
    const links = group.map((c) => c.sourceUrl || sourceLabel(c.source)).join(" ");
    return `• ${creatorLabel(first)} — ${licenseLabel(first)} — ${links} ${MODIFIED_NOTE}`;
  });
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) map.set(key(item), (map.get(key(item)) ?? 0) + 1);
  return map;
}

// ---------------------------------------------------------------------------------------------
// Text rules
// ---------------------------------------------------------------------------------------------

/** YouTube rejects "<" and ">" in titles/descriptions/tags. */
export function stripAngleBrackets(text: string): string {
  return text.replace(/[<>]/g, "");
}

function collapseSpaces(text: string): string {
  return text.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();
}

/**
 * The fact-checked script title as published: no "#Shorts" (it lives in the description hashtags, which is
 * enough for YouTube and keeps the title clean on Instagram/TikTok), cut at a word boundary to 100 chars.
 */
export function buildTitle(raw: string): string {
  const base = collapseSpaces(stripAngleBrackets(raw)).replace(/\s*#shorts\b/gi, "").replace(/\n/g, " ").trim();
  if (base.length <= TITLE_MAX) return base;
  const cut = base.slice(0, TITLE_MAX);
  return (cut.lastIndexOf(" ") > TITLE_MAX * 0.6 ? cut.slice(0, cut.lastIndexOf(" ")) : cut).replace(/[\s,;:.-]+$/, "");
}

// ---------------------------------------------------------------------------------------------
// Hashtags
// ---------------------------------------------------------------------------------------------

/** Curated per-category hashtags (pt-BR, accented, lowercase); the LLM only adds 1-2 topic tags. */
export const CATEGORY_HASHTAGS: Readonly<Record<string, readonly string[]>> = {
  historia: ["#história", "#curiosidades", "#fatoshistóricos"],
  ciencia: ["#ciência", "#curiosidades", "#fatoscuriosos"],
  espaco: ["#espaço", "#astronomia", "#curiosidades"],
};
const DEFAULT_HASHTAGS = ["#curiosidades", "#fatoscuriosos"] as const;
export const MAX_TOPIC_HASHTAGS = 2;

/** Common unaccented spellings the model (or a keyboard) produces, fixed when they are the whole tag or its start/end. */
const ACCENT_FIXES: readonly [string, string][] = [
  ["historia", "história"], ["historicos", "históricos"], ["historico", "histórico"], ["ciencias", "ciências"], ["ciencia", "ciência"],
  ["espaco", "espaço"], ["fisica", "física"], ["quimica", "química"], ["misterios", "mistérios"], ["misterio", "mistério"],
  ["revolucao", "revolução"], ["exploracao", "exploração"], ["fenomeno", "fenômeno"], ["matematica", "matemática"],
  ["imperio", "império"], ["evolucao", "evolução"], ["invencao", "invenção"], ["civilizacao", "civilização"],
  ["egipcio", "egípcio"], ["grecia", "grécia"], ["planetario", "planetário"], ["vulcao", "vulcão"], ["oceanografia", "oceanografia"],
];

function fixAccents(word: string): string {
  for (const [plain, accented] of ACCENT_FIXES) {
    if (word === plain) return accented;
    const rest = word.slice(plain.length);
    if (word.startsWith(plain) && rest.length > 3 && !rest.startsWith("dor")) return accented + rest;
    if (word.endsWith(plain) && word.length > plain.length + 3) return word.slice(0, -plain.length) + accented;
  }
  return word;
}

const accentless = (tag: string): string => tag.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** "#Revolucao_Francesa" -> "#revoluçãofrancesa": lowercase, accents fixed, letters/digits only. */
export function canonicalHashtag(tag: string): string | undefined {
  const word = stripAngleBrackets(tag).normalize("NFC").replace(/^#+/, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return word ? `#${fixAccents(word)}` : undefined;
}

/**
 * 3-5 hashtags: the curated set of the category plus up to 2 topic tags from the draft (deduplicated
 * ignoring accents; generic ones like #shorts/#curiosidade/#historia are dropped). #Shorts is added by
 * buildDescription.
 */
export function curateHashtags(categoryId: string | undefined, draft: readonly string[]): string[] {
  const curated = [...(CATEGORY_HASHTAGS[categoryId ?? ""] ?? DEFAULT_HASHTAGS)];
  const generic = new Set(["#shorts", "#short", "#curiosidade", "#curiosidades", "#historia", "#ciencia", "#espaco", "#fatos", "#vocesabia", "#viral", "#fyp"]);
  const seen = new Set([...curated, ...generic].map(accentless));
  const topic: string[] = [];
  for (const raw of draft) {
    const tag = canonicalHashtag(raw);
    if (!tag || tag.length > 31 || seen.has(accentless(tag))) continue;
    seen.add(accentless(tag));
    topic.push(tag);
    if (topic.length === MAX_TOPIC_HASHTAGS) break;
  }
  return [...curated, ...topic];
}

export function normalizeHashtag(tag: string): string | undefined {
  const word = stripAngleBrackets(tag)
    .normalize("NFC")
    .replace(/^#+/, "")
    .replace(/[^\p{L}\p{N}_]/gu, "");
  return word ? `#${word}` : undefined;
}

/** How YouTube counts the tag budget: tags with spaces are quoted (+2) and tags are comma-separated. */
export function tagsLength(tags: readonly string[]): number {
  if (tags.length === 0) return 0;
  return tags.reduce((n, t) => n + t.length + (t.includes(" ") ? 2 : 0), 0) + (tags.length - 1);
}

/** Cleans, de-duplicates (case-insensitive) and drops trailing tags until the 500-char budget fits. */
export function buildTags(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const t of raw) {
    const tag = collapseSpaces(stripAngleBrackets(t).replace(/^#+/, "").replace(/,/g, " "));
    if (!tag || tag.length > 60 || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
  }
  while (tagsLength(tags) > TAGS_MAX) tags.pop();
  return tags;
}

export interface DescriptionParts {
  hook: string;
  context: string;
  hashtags: readonly string[];
  credits: string;
}

export class DescriptionTooLongError extends Error {}

/**
 * Description within YouTube's 5000 chars: drops the context lines first, then compacts the credits
 * (merged CC BY lines, stock/public summaries). CC BY credits are never dropped: if even the compact
 * form does not fit, it throws.
 */
export function fitDescription(parts: Omit<DescriptionParts, "credits">, footage: readonly FootageClip[], extraCredits = ""): string {
  // Sticker/SFX credits (05b) share the credits block so the Instagram caption keeps them with the image credits.
  const credits = (compact: boolean): string => [buildCredits(footage, compact), extraCredits].filter(Boolean).join("\n");
  const attempts: DescriptionParts[] = [
    { ...parts, credits: credits(false) },
    { ...parts, context: "", credits: credits(false) },
    { ...parts, context: "", credits: credits(true) },
    { ...parts, context: "", hashtags: [], credits: credits(true) },
  ];
  for (const attempt of attempts) {
    const description = buildDescription(attempt);
    if (description.length <= DESCRIPTION_MAX) return description;
  }
  throw new DescriptionTooLongError(
    `Image credits alone exceed YouTube's ${DESCRIPTION_MAX}-char description limit (${buildCredits(footage, true).length} chars)`,
  );
}

/** Pre-render check: can this footage be credited within the description limit? */
export function creditsFitDescription(script: Pick<Script, "hook">, footage: readonly FootageClip[]): boolean {
  try {
    // Worst case of curateHashtags: 3 curated + 2 topic tags.
    fitDescription({ hook: script.hook, context: "", hashtags: ["#fatoshistóricos", "#curiosidades", "#história", `#${"x".repeat(30)}`, `#${"y".repeat(30)}`] }, footage);
    return true;
  } catch (error) {
    if (error instanceof DescriptionTooLongError) return false;
    throw error;
  }
}

export function buildDescription(parts: DescriptionParts): string {
  const hashtags = [...new Set(parts.hashtags.map(normalizeHashtag).filter((h): h is string => !!h))];
  if (!hashtags.some((h) => h.toLowerCase() === "#shorts")) hashtags.unshift(SHORTS_TAG);
  const blocks = [parts.hook, parts.context, hashtags.join(" "), parts.credits, "Narração: voz sintética."]
    .map((b) => collapseSpaces(stripAngleBrackets(b)))
    .filter(Boolean);
  return blocks.join("\n\n");
}

/** Problems with metadata as YouTube would see them; empty = valid. */
export function validateMetadata(meta: Pick<VideoMetadata, "title" | "description" | "tags">): string[] {
  const problems: string[] = [];
  if (!meta.title.trim()) problems.push("title is empty");
  if (meta.title.length > TITLE_MAX) problems.push(`title has ${meta.title.length} chars (max ${TITLE_MAX})`);
  if (meta.description.length > DESCRIPTION_MAX) {
    problems.push(`description has ${meta.description.length} chars (max ${DESCRIPTION_MAX})`);
  }
  for (const [field, value] of [["title", meta.title], ["description", meta.description], ["tags", meta.tags.join(",")]] as const) {
    if (/[<>]/.test(value)) problems.push(`${field} contains < or >`);
  }
  if (tagsLength(meta.tags) > TAGS_MAX) problems.push(`tags use ${tagsLength(meta.tags)} chars (max ${TAGS_MAX})`);
  return problems;
}

// ---------------------------------------------------------------------------------------------
// LLM draft
// ---------------------------------------------------------------------------------------------

/**
 * What the LLM may contribute. The title is NOT among them: the published title is the fact-checked
 * script title. Context lines must be copied verbatim from the fact-checked narration (validated).
 */
export const MetadataDraftSchema = z.object({
  context: z.array(z.string()).max(2).describe("Até 2 frases COPIADAS exatamente da narração"),
  hashtags: z.array(z.string()).min(1).max(5).describe("1 a 2 hashtags específicas do assunto, pt-BR com acentos, minúsculas"),
  tags: z.array(z.string()).min(5).max(20),
});

export interface MetadataDraft {
  /** Ignored: kept only so older callers/tests that still pass a draft title type-check. */
  title?: string;
  context: string | readonly string[];
  hashtags: readonly string[];
  tags: readonly string[];
}

function normalizeSentence(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter(Boolean);
}

/** Sentence identity ignoring case, whitespace and surrounding punctuation (never inner words). */
function sentenceKey(text: string): string {
  return normalizeSentence(text).replace(/^[\s"'“”‘’«»(\[-]+|[\s"'“”‘’«»)\].,;:!?…-]+$/g, "");
}

/**
 * Keeps only context sentences that are WHOLE sentences of the fact-checked script (hook + narration).
 * A fragment cut out of a sentence can drop a negation ("Não é verdade que ..."), so substrings don't count.
 */
export function verbatimContext(context: string | readonly string[], script: Pick<Script, "hook" | "scenes">): string {
  const sentences = new Set([script.hook, ...script.scenes.map((s) => s.narration)].flatMap(splitSentences).map(sentenceKey));
  const candidates = (typeof context === "string" ? [context] : context).flatMap(splitSentences);
  return candidates.filter((sentence) => sentence.length >= 10 && sentences.has(sentenceKey(sentence))).slice(0, 2).join(" ");
}

export function buildMetadataPrompt(script: Script, categoryLabel: string): string {
  return `Crie metadados de busca para um YouTube Short em português do Brasil. O roteiro abaixo já passou por
checagem de fatos; o título publicado será o título do roteiro (não crie outro).

Título: ${script.title}
Gancho: ${script.hook}
Narração: ${script.scenes.map((s) => s.narration).join(" ")}
Categoria: ${categoryLabel}

Regras:
- "context": 1 a 2 frases COPIADAS EXATAMENTE da narração acima (palavra por palavra, sem editar), que contextualizem
  o fato sem repetir o gancho. Não escreva frases novas.
- "hashtags": 1 a 2 hashtags ESPECÍFICAS do assunto (ex.: "#bastilha", "#urano", "#revoluçãofrancesa"), em pt-BR com acentos
  corretos, minúsculas, sem espaços. Não repita as genéricas (#shorts, #curiosidades, #história, #ciência, #espaço):
  elas são adicionadas automaticamente.
- "tags": 8 a 15 palavras-chave de busca (pt-BR, algumas em inglês se fizer sentido), sem "#".`;
}

/** Deterministic fallback when the LLM is unavailable: the (fact-checked) script title and category. */
export function fallbackDraft(script: Script, categoryLabel: string): MetadataDraft {
  return {
    context: splitSentences(script.scenes[0]?.narration ?? "").slice(0, 1),
    hashtags: [],
    tags: ["curiosidades", categoryLabel, "shorts", "você sabia", "fatos curiosos"],
  };
}

export interface MetadataInput {
  script: Script;
  footage: readonly FootageClip[];
  draft: MetadataDraft;
  /** YouTube category id (e.g. "27"). */
  categoryId: string;
  language: string;
  /** Pipeline topic (picks the curated hashtag set); absent = generic set. */
  topic?: Pick<TopicPick, "categoryId">;
  /** Sticker/SFX plan (05b): CC BY assets are credited after the image credits. */
  edits?: Pick<EditPlan, "assets">;
}

export function assembleMetadata(input: MetadataInput): VideoMetadata {
  const { script, footage, draft } = input;
  const metadata: VideoMetadata = {
    // Published title = the fact-checked script title (never a fresh LLM draft).
    title: buildTitle(script.title),
    description: fitDescription(
      { hook: script.hook, context: verbatimContext(draft.context, script), hashtags: curateHashtags(input.topic?.categoryId, draft.hashtags) },
      footage,
      creditsFor(input.edits?.assets ?? []),
    ),
    tags: buildTags(draft.tags),
    categoryId: input.categoryId,
    defaultLanguage: input.language,
    defaultAudioLanguage: input.language,
  };
  const problems = validateMetadata(metadata);
  if (problems.length > 0) throw new Error(`Invalid YouTube metadata: ${problems.join("; ")}`);
  return metadata;
}

export async function run(ctx: RunContext): Promise<RunContext> {
  // Cut runs (npm run cuts) carry `cut`: their description credits the source channel instead of images.
  if ((ctx as Partial<CutRunContext>).cut) return runCutMetadata(ctx as CutRunContext);
  if (!ctx.script) throw new Error("07-generateMetadata requires ctx.script");
  const log = getLogger(ctx.runId);
  const config = loadConfig();
  const categoryLabel = ctx.topic?.categoryLabel ?? "curiosidades";
  let draft: MetadataDraft;
  try {
    draft = await generateJson(buildMetadataPrompt(ctx.script, categoryLabel), MetadataDraftSchema, {
      thinking: "low",
      temperature: 0.3,
      model: config.llm?.models?.metadata,
    });
  } catch (error) {
    log.warn(`Metadata LLM call failed, using the script title: ${error instanceof Error ? error.message : String(error)}`);
    draft = fallbackDraft(ctx.script, categoryLabel);
  }
  const metadata = assembleMetadata({
    script: ctx.script,
    footage: ctx.footage ?? [],
    draft,
    categoryId: String(config.upload.categoryId),
    language: config.voice.language,
    topic: ctx.topic,
    edits: ctx.edits,
  });
  const credited = uniqueClips(ctx.footage ?? []).filter((c) => licenseKind(c) === "attribution").length;
  log.info(
    `Metadata: "${metadata.title}" (${metadata.title.length} chars), description ${metadata.description.length} chars, ` +
      `${metadata.tags.length} tags (${tagsLength(metadata.tags)} chars), ${credited} CC BY credit(s)`,
  );
  return { ...ctx, metadata };
}
