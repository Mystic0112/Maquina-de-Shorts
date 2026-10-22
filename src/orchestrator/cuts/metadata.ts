/**
 * Title, description and tags of a cut (stage 07 for cut runs). The credit block is deterministic and never
 * dropped: source channel, link to the full original video and the channel's own credit line (owner's cuts
 * rule, 2026-10-22). The LLM only writes a one-line summary, specific hashtags and search tags; the title is
 * the one that already passed the meaning/title review (verifyPicks).
 */
import { z } from "zod";
import { loadConfig } from "../lib/config.js";
import { generateJson } from "../lib/llmClient.js";
import { getLogger } from "../lib/logger.js";
import { buildTags, buildTitle, canonicalHashtag, DESCRIPTION_MAX, stripAngleBrackets, validateMetadata } from "../stages/07-generateMetadata.js";
import type { VideoMetadata } from "../types.js";
import type { CutInfo, CutRunContext } from "./types.js";

/** YouTube category "Entertainment" (the Shorts use the configured one, usually Education). */
export const CUTS_CATEGORY_ID = "24";
const BASE_HASHTAGS = ["#shorts", "#cortes"];
const MAX_TOPIC_HASHTAGS = 3;
const SUMMARY_MAX = 300;

export const CutMetadataDraftSchema = z.object({
  summary: z.string().min(10).max(SUMMARY_MAX).describe("1 frase fiel ao que acontece no trecho"),
  hashtags: z.array(z.string()).max(5),
  tags: z.array(z.string()).min(3).max(20),
});
export type CutMetadataDraft = z.infer<typeof CutMetadataDraftSchema>;

export function buildCutMetadataPrompt(ctx: CutRunContext): string {
  return [
    "Crie metadados de busca para um corte vertical (YouTube Shorts) em português do Brasil.",
    `Título do corte (já aprovado, não mude): ${ctx.script?.title ?? ""}`,
    `Canal de origem: ${ctx.cut.channelName}. Vídeo original: "${ctx.cut.videoTitle}".`,
    `O que é dito no trecho: ${ctx.script?.scenes.map((s) => s.narration).join(" ") ?? ""}`,
    "",
    "Regras:",
    '- "summary": UMA frase que diz o que acontece no trecho, fiel à fala: sem exagerar, sem inventar e sem desmoralizar ninguém.',
    '- "hashtags": 1 a 3 hashtags específicas (pessoas, carro, assunto), minúsculas, sem espaços; não repita #shorts nem #cortes.',
    '- "tags": 5 a 15 palavras-chave de busca, sem "#".',
  ].join("\n");
}

/** The credit lines every cut carries (never trimmed). */
export function cutCreditBlock(cut: Pick<CutInfo, "channelName" | "sourceUrl" | "credit" | "sources">): string {
  const links =
    cut.sources && cut.sources.length > 1
      ? [`Compilação de vídeos do canal ${cut.channelName}. Originais:`, ...cut.sources.map((s) => s.url)]
      : [`Corte do canal ${cut.channelName}.`, `Vídeo completo: ${cut.sourceUrl}`];
  return [...links, cut.credit, "(trecho recortado e editado)"]
    .map((line) => stripAngleBrackets(line).trim())
    .filter(Boolean)
    .join("\n");
}

export function cutHashtags(draft: readonly string[]): string[] {
  const out = [...BASE_HASHTAGS];
  for (const raw of draft) {
    const tag = canonicalHashtag(raw);
    if (!tag || tag.length > 31 || out.includes(tag)) continue;
    out.push(tag);
    if (out.length === BASE_HASHTAGS.length + MAX_TOPIC_HASHTAGS) break;
  }
  return out;
}

export function assembleCutMetadata(ctx: CutRunContext, draft: CutMetadataDraft | null, language: string): VideoMetadata {
  const title = buildTitle(ctx.script?.title ?? ctx.cut.videoTitle);
  const credits = cutCreditBlock(ctx.cut);
  const summary = stripAngleBrackets(draft?.summary ?? ctx.script?.hook ?? "").trim();
  const hashtags = cutHashtags(draft?.hashtags ?? []).join(" ");
  // Credits last and never cut: the summary gives way first if the description ever got too long.
  const room = DESCRIPTION_MAX - credits.length - hashtags.length - 4;
  const description = [summary.slice(0, Math.max(0, room)), hashtags, credits].filter(Boolean).join("\n\n");
  const metadata: VideoMetadata = {
    title,
    description,
    tags: buildTags([...(draft?.tags ?? []), "cortes", ctx.cut.channelName]),
    categoryId: CUTS_CATEGORY_ID,
    defaultLanguage: language,
    defaultAudioLanguage: language,
  };
  const problems = validateMetadata(metadata);
  if (problems.length > 0) throw new Error(`Invalid YouTube metadata for cut ${ctx.runId}: ${problems.join("; ")}`);
  return metadata;
}

export async function runCutMetadata(ctx: CutRunContext): Promise<CutRunContext> {
  const log = getLogger(ctx.runId);
  const config = loadConfig();
  let draft: CutMetadataDraft | null = null;
  try {
    draft = await generateJson(buildCutMetadataPrompt(ctx), CutMetadataDraftSchema, { thinking: "low", temperature: 0.3, model: config.llm?.models?.metadata });
  } catch (error) {
    log.warn(`Cut metadata LLM call failed, using the hook as summary: ${error instanceof Error ? error.message : String(error)}`);
  }
  const metadata = assembleCutMetadata(ctx, draft, config.voice.language);
  log.info(`Cut metadata: "${metadata.title}", description ${metadata.description.length} chars, ${metadata.tags.length} tags, credit to ${ctx.cut.channelName}`);
  return { ...ctx, metadata };
}
