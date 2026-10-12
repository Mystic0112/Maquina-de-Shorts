import { createHash } from "node:crypto";
import type { FootageClip, RunContext, Script } from "../types.js";

/**
 * Binds quality verdicts to the exact content they judged. A verdict stored in context.json is only
 * valid for the script (fact-check) or script + footage (footage quality gate) it was computed on; if a
 * stage is re-run afterwards (e.g. `npm run stage -- 02-generateScript`), the hashes stop matching and
 * render/upload refuse to use the stale verdict.
 */

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Covers every published/checked field. overlayText (on-screen text, fact-checked) and hookFootageQuery are
 * omitted from the JSON when absent, so hashes of scripts written before those fields existed are unchanged.
 */
export function scriptHash(script: Script): string {
  return sha256({
    title: script.title,
    hook: script.hook,
    scenes: script.scenes.map((s) => [s.narration, s.footageQuery]),
    cta: script.cta,
    language: script.language,
    overlayText: script.overlayText,
    hookFootageQuery: script.hookFootageQuery,
  });
}

export function footageHash(script: Script, footage: readonly FootageClip[]): string {
  const clips = [...footage]
    .map((c) => [c.sceneIndex, c.path, c.sourceUrl, c.kind, c.borrowedFromScene ?? null] as const)
    .sort((a, b) => a[0] - b[0] || String(a[1]).localeCompare(String(b[1])));
  return sha256({ script: scriptHash(script), clips });
}

export interface BindingOptions {
  /** true: a verdict without a stored hash is a problem (upload). false: legacy verdicts are tolerated (render). */
  requireHashes: boolean;
}

/** Problems binding ctx.factCheck / ctx.quality to the current script and footage; empty = consistent. */
export function contentBindingProblems(ctx: RunContext, options: BindingOptions): string[] {
  const problems: string[] = [];
  const { script, factCheck, quality } = ctx;
  if (factCheck && factCheck.verdict !== "fail") {
    if (!script) problems.push("fact-check verdict present but the context has no script");
    else if (factCheck.scriptHash) {
      if (factCheck.scriptHash !== scriptHash(script)) problems.push("fact-check verdict was computed for a different script (re-run 02b-factCheck)");
    } else if (options.requireHashes) problems.push("fact-check verdict is not bound to a script hash (legacy run: re-run 02b-factCheck)");
  }
  if (quality && quality.verdict !== "fail") {
    if (!script || !ctx.footage) problems.push("footage quality verdict present but the context has no script/footage");
    else if (quality.contentHash) {
      if (quality.contentHash !== footageHash(script, ctx.footage)) {
        problems.push("footage quality verdict was computed for a different script/footage (re-run 03-fetchFootage)");
      }
    } else if (options.requireHashes) problems.push("footage quality verdict is not bound to a content hash (legacy run: re-run 03-fetchFootage)");
  }
  return problems;
}
