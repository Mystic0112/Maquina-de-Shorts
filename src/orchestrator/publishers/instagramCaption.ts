import { buildCredits, licenseKind, uniqueClips } from "../stages/07-generateMetadata.js";
import type { FootageClip, VideoMetadata } from "../types.js";

/**
 * Instagram Reels caption, derived from the YouTube metadata of stage 07 (fact-checked title, hook and
 * context sentences, hashtags, image credits). Nothing new is written here: blocks are reused and, when
 * the caption is too long, dropped in the same order as the YouTube description (context, then compact
 * credits, then hashtags). CC BY credits are never dropped; the compact form comes from the same
 * buildCredits() the description uses.
 *
 * Limits (IG User Media reference): 2200 characters, 30 hashtags, 20 @ mentions.
 * https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media
 */

export const CAPTION_MAX = 2200;
export const HASHTAGS_MAX = 30;
export const MENTIONS_MAX = 20;

const CREDITS_HEADER = "Créditos das imagens:";
const SHORTS = /#shorts\b/giu;
const HASHTAG = /(^|[^\p{L}\p{N}_&/])#[\p{L}\p{N}_]+/gu;
const MENTION = /(^|[^\p{L}\p{N}_.])@[A-Za-z0-9_.]+/gu;

export class InstagramCaptionError extends Error {}

interface DescriptionBlocks {
  hook: string;
  context: string[];
  hashtags: string[];
  credits: string;
  notes: string[];
}

function isHashtagBlock(block: string): boolean {
  const tokens = block.split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => t.startsWith("#"));
}

/** Splits the stage-07 description (blocks joined by blank lines) back into its parts. */
export function splitDescription(description: string): DescriptionBlocks {
  const blocks = description.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const out: DescriptionBlocks = { hook: "", context: [], hashtags: [], credits: "", notes: [] };
  for (const block of blocks) {
    if (block.startsWith(CREDITS_HEADER)) out.credits = block;
    else if (/^Narração:/i.test(block)) out.notes.push(block);
    else if (isHashtagBlock(block)) out.hashtags.push(...block.split(/\s+/).filter((t) => !/^#shorts$/i.test(t)));
    else if (!out.hook) out.hook = block;
    else out.context.push(block);
  }
  return out;
}

export function countHashtags(text: string): number {
  return [...text.matchAll(HASHTAG)].length;
}

export function countMentions(text: string): number {
  return [...text.matchAll(MENTION)].length;
}

/** CC BY clips whose credit (author + link) is missing from the text; empty = license satisfied. */
export function missingAttributions(text: string, footage: readonly FootageClip[]): FootageClip[] {
  return uniqueClips(footage)
    .filter((c) => licenseKind(c) === "attribution")
    .filter((c) => !text.includes(c.creator.trim()) || (c.sourceUrl ? !text.includes(c.sourceUrl) : false));
}

function cleanTitle(title: string): string {
  return title.replace(SHORTS, "").replace(/\s+/g, " ").trim();
}

function assemble(parts: { title: string; hook: string; context: string[]; hashtags: string[]; credits: string; notes: string[] }): string {
  return [parts.title, parts.hook, ...parts.context, parts.hashtags.join(" "), parts.credits, ...parts.notes]
    .map((b) => b.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Drops trailing hashtags until the caption has at most 30 (URLs in credits may also count). */
function withinHashtagLimit(parts: Parameters<typeof assemble>[0]): string | undefined {
  const hashtags = [...parts.hashtags];
  for (;;) {
    const caption = assemble({ ...parts, hashtags });
    if (countHashtags(caption) <= HASHTAGS_MAX) return caption;
    if (hashtags.length === 0) return undefined;
    hashtags.pop();
  }
}

export function buildInstagramCaption(metadata: Pick<VideoMetadata, "title" | "description">, footage: readonly FootageClip[]): string {
  const blocks = splitDescription(metadata.description);
  const title = cleanTitle(metadata.title);
  const hashtags = [...new Set(blocks.hashtags)];
  const fullCredits = blocks.credits || buildCredits(footage);
  const compactCredits = buildCredits(footage, true);
  const base = { title, hook: blocks.hook, context: blocks.context, hashtags, credits: fullCredits, notes: blocks.notes };
  const attempts = [
    base,
    { ...base, context: [] },
    { ...base, context: [], credits: compactCredits },
    { ...base, context: [], credits: compactCredits, hashtags: [] },
    { ...base, title: "", context: [], credits: compactCredits, hashtags: [] },
  ];
  for (const attempt of attempts) {
    const caption = withinHashtagLimit(attempt);
    if (!caption || caption.length > CAPTION_MAX || countMentions(caption) > MENTIONS_MAX) continue;
    if (missingAttributions(caption, footage).length > 0) continue;
    return caption;
  }
  throw new InstagramCaptionError(
    `Image credits do not fit Instagram's caption limits (${CAPTION_MAX} chars, ${HASHTAGS_MAX} hashtags, ${MENTIONS_MAX} mentions; ` +
      `compact credits alone use ${compactCredits.length} chars)`,
  );
}
