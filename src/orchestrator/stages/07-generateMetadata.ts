import { z } from "zod";
import { loadConfig } from "../lib/config.js";
import { generateJson } from "../lib/llmClient.js";
import { getLogger } from "../lib/logger.js";
import type { FootageClip, RunContext, Script, VideoMetadata } from "../types.js";

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
export function buildCredits(footage: readonly FootageClip[]): string {
  const clips = uniqueClips(footage);
  if (clips.length === 0) return "";
  const lines = ["Créditos das imagens:"];
  for (const c of clips.filter((x) => licenseKind(x) === "attribution")) {
    lines.push(`• ${c.creator.trim() || "Autor desconhecido"} — ${c.license.trim()} — ${c.sourceUrl || sourceLabel(c.source)}`);
  }
  for (const c of clips.filter((x) => licenseKind(x) === "stock")) {
    lines.push(`• ${c.creator.trim() || "Autor desconhecido"} via ${sourceLabel(c.source)} (${c.license.trim() || "licença do site"})`);
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

/** Title with #Shorts, cut at a word boundary so the whole thing fits in 100 chars. */
export function buildTitle(raw: string): string {
  const base = collapseSpaces(stripAngleBrackets(raw)).replace(/\s*#shorts\b/gi, "").replace(/\n/g, " ").trim();
  const budget = TITLE_MAX - SHORTS_TAG.length - 1;
  let title = base;
  if (title.length > budget) {
    const cut = title.slice(0, budget);
    title = (cut.lastIndexOf(" ") > budget * 0.6 ? cut.slice(0, cut.lastIndexOf(" ")) : cut).replace(/[\s,;:.-]+$/, "");
  }
  return `${title} ${SHORTS_TAG}`;
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

export const MetadataDraftSchema = z.object({
  title: z.string().min(5).max(90).describe("Título pt-BR, curioso mas fiel ao roteiro, sem #Shorts"),
  context: z.string().min(10).max(400).describe("1-2 frases de contexto em pt-BR"),
  hashtags: z.array(z.string()).min(2).max(5),
  tags: z.array(z.string()).min(5).max(20),
});

export type MetadataDraft = z.infer<typeof MetadataDraftSchema>;

export function buildMetadataPrompt(script: Script, categoryLabel: string): string {
  return `Crie os metadados de um YouTube Short em português do Brasil para o roteiro abaixo, que já passou por
checagem de fatos. Não acrescente nenhum fato que não esteja no roteiro.

Título do roteiro: ${script.title}
Gancho: ${script.hook}
Narração: ${script.scenes.map((s) => s.narration).join(" ")}
Categoria: ${categoryLabel}

Regras:
- "title": até 90 caracteres, desperta curiosidade mas é PRECISO: sem exagero, sem causa/efeito falso, sem caixa alta
  excessiva, sem emojis em excesso. Não inclua #Shorts (será adicionado).
- "context": 1 a 2 frases que contextualizam o fato, sem repetir o gancho.
- "hashtags": 2 a 5 hashtags curtas em pt-BR relacionadas ao tema (sem #Shorts).
- "tags": 8 a 15 palavras-chave de busca (pt-BR, algumas em inglês se fizer sentido), sem "#".`;
}

/** Deterministic fallback when the LLM is unavailable: the (fact-checked) script title and category. */
export function fallbackDraft(script: Script, categoryLabel: string): MetadataDraft {
  return {
    title: script.title,
    context: script.scenes[0]?.narration ?? script.hook,
    hashtags: ["#curiosidades", `#${categoryLabel}`],
    tags: ["curiosidades", categoryLabel, "shorts", "você sabia", "fatos curiosos"],
  };
}

export interface MetadataInput {
  script: Script;
  footage: readonly FootageClip[];
  draft: MetadataDraft;
  categoryId: string;
  language: string;
}

export function assembleMetadata(input: MetadataInput): VideoMetadata {
  const { script, footage, draft } = input;
  const metadata: VideoMetadata = {
    title: buildTitle(draft.title),
    description: buildDescription({ hook: script.hook, context: draft.context, hashtags: draft.hashtags, credits: buildCredits(footage) }),
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
  if (!ctx.script) throw new Error("07-generateMetadata requires ctx.script");
  const log = getLogger(ctx.runId);
  const config = loadConfig();
  const categoryLabel = ctx.topic?.categoryLabel ?? "curiosidades";
  let draft: MetadataDraft;
  try {
    draft = await generateJson(buildMetadataPrompt(ctx.script, categoryLabel), MetadataDraftSchema, { thinking: "low", temperature: 0.7 });
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
  });
  const credited = uniqueClips(ctx.footage ?? []).filter((c) => licenseKind(c) === "attribution").length;
  log.info(
    `Metadata: "${metadata.title}" (${metadata.title.length} chars), description ${metadata.description.length} chars, ` +
      `${metadata.tags.length} tags (${tagsLength(metadata.tags)} chars), ${credited} CC BY credit(s)`,
  );
  return { ...ctx, metadata };
}
