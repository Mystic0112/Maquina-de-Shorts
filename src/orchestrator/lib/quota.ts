/**
 * Quota errors of the image tool (agy). On 2026-10-26 the plan's image quota ran out after ~18 requests
 * (`429 RESOURCE_EXHAUSTED`, "cota de imagem redefinida em ~3h25"). A quota is nobody's fault (not the topic's,
 * not the script's): the stage must stop at once and the pipeline must NOT redo script and fact-check with a
 * new topic (that only burns the script model). QuotaExhaustedError carries that decision through runPipeline.
 */
import { redactSecrets } from "./redact.js";
import type { FootageClip } from "../types.js";

/** Longest wait we believe; anything above is probably a misread number. */
const MAX_WAIT_MINUTES = 48 * 60;
const BEFORE_CHARS = 100;
const AFTER_CHARS = 250;

/**
 * Same care as scripts/loop.ps1: a bare "429" also matches timestamps (".429Z"), sizes ("1429 pixels") and ids,
 * so it only counts next to status/code/http/error (or an HTTP status line). Aspect ratios ("9:16") never match.
 */
const SIGNS: readonly RegExp[] = [
  /resource[_ ]exhausted/i,
  /(?:status|code|http|error|erro)[^0-9A-Za-z]{0,3}429(?![0-9])/i,
  /HTTP\/[\d.]+\s+429(?![0-9])/i,
  /too many requests|rate[ _-]?limit/i,
  // The word "quota"/"cota" only next to a word that says it ran out ("cota de imagem esgotada", "quota exceeded").
  /\b(?:quota|cota)\b[^.\n]{0,80}\b(?:esgotad\w*|exceed\w*|exhaust\w*|reached|atingid\w*|excedid\w*|redefin\w*|reset\w*)/i,
  /\b(?:esgotad\w*|exceed\w*|exhaust\w*|atingid\w*|excedid\w*)[^.\n]{0,40}\b(?:quota|cota)\b/i,
  // Claude Code plan limits (docs "errors", 2026-11-02): "You've hit your session limit", "...weekly limit", "...Opus limit";
  // "usage limit reached" is the older wording (to confirm at home); "Credit balance is too low" is on the same docs page.
  /\bhit your (?:session|weekly|monthly|usage|opus|sonnet|individual|org\S*|team\S*|channel\S*)\b[^.\n]{0,30}\blimit/i,
  /usage limit reached/i,
  /credit balance is too low/i,
];

/** Index of the first sign of an exhausted quota in `text`, or -1. */
function firstSign(text: string): number {
  const hits = SIGNS.map((re) => text.search(re)).filter((i) => i >= 0);
  return hits.length > 0 ? Math.min(...hits) : -1;
}

export function looksLikeQuotaError(text: string): boolean {
  return firstSign(text) >= 0;
}

/** Minutes until the quota is back, when the text says so ("redefinida em ~3h25", "resets in 3h25m0s", "em 40 minutos"). */
export function parseWaitMinutes(text: string): number | undefined {
  const at = text.search(/redefin\w*|reset\w*|renov\w*|volta\w*|retry|try again|tente|novamente|available again/i);
  if (at < 0) return undefined;
  const near = text.slice(at, at + 100);
  const hm = near.match(/(\d{1,2})\s*h(?:oras?|ours?)?\s*(?:e\s*)?(\d{1,2})?/i);
  const onlyMinutes = near.match(/(\d{1,4})\s*(?:min\w*|m)\b/i);
  const minutes = hm ? Number(hm[1]) * 60 + Number(hm[2] ?? 0) : onlyMinutes ? Number(onlyMinutes[1]) : undefined;
  return minutes !== undefined && minutes > 0 && minutes <= MAX_WAIT_MINUTES ? minutes : undefined;
}

export class QuotaExhaustedError extends Error {
  /** Clips generated before the quota ran out (the "acervo" fallback keeps them). */
  partial: FootageClip[] = [];
  /** When the quota is back (ISO), computed from the wait the tool announced; absent when it said nothing. */
  readonly resetAt?: string;

  constructor(
    readonly provider: string,
    /** Original text of the tool (secrets redacted, shortened). */
    readonly original: string,
    readonly retryAfterMinutes?: number,
  ) {
    const back = retryAfterMinutes ? `; back in about ${Math.floor(retryAfterMinutes / 60)}h${String(retryAfterMinutes % 60).padStart(2, "0")}` : "";
    super(`Quota exhausted at provider "${provider}" (RESOURCE_EXHAUSTED)${back}: ${original}`);
    this.name = "QuotaExhaustedError";
    if (retryAfterMinutes) this.resetAt = new Date(Date.now() + retryAfterMinutes * 60_000).toISOString();
  }
}

/** The typed error when `text` (agy's answer or stderr) says the quota is gone; undefined otherwise. */
export function quotaErrorFrom(provider: string, text: string): QuotaExhaustedError | undefined {
  const at = firstSign(text);
  if (at < 0) return undefined;
  const window = text.slice(Math.max(0, at - BEFORE_CHARS), at + AFTER_CHARS).replace(/\s+/g, " ").trim();
  return new QuotaExhaustedError(provider, redactSecrets(window), parseWaitMinutes(text));
}
