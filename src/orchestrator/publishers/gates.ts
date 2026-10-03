import { contentBindingProblems } from "../lib/contentHash.js";
import { licenseKind, uniqueClips, usableCreatorName } from "../stages/07-generateMetadata.js";
import type { RunContext } from "../types.js";

export interface SharedGateSettings {
  /** Only with script.factCheck=false: allows publishing scripts that were never fact-checked. */
  allowWithoutFactCheck?: boolean;
}

/**
 * Reasons this run must not be published anywhere; empty = publishable. The publishing stage re-checks
 * the run's own verdicts; it never trusts stage order alone.
 */
export function publishBlockers(ctx: RunContext, settings: SharedGateSettings): string[] {
  const blockers: string[] = [];
  if (ctx.rejection) blockers.push(`run was rejected by ${ctx.rejection.stage}: ${ctx.rejection.reason}`);
  if (ctx.quality?.verdict !== "pass") blockers.push(`footage quality verdict is "${ctx.quality?.verdict ?? "missing"}" (needs "pass")`);
  const fc = ctx.factCheck?.verdict;
  if (fc === "skipped") {
    if (!settings.allowWithoutFactCheck) blockers.push('script was not fact-checked (set upload.allowWithoutFactCheck=true to allow)');
  } else if (fc !== "pass" && fc !== "corrected") {
    blockers.push(`fact-check verdict is "${fc ?? "missing"}" (needs "pass" or "corrected")`);
  }
  // Verdicts only count for the exact script/footage they judged.
  blockers.push(...contentBindingProblems(ctx, { requireHashes: true }));
  // CC BY requires attribution: every credited clip needs a real author name.
  const unattributed = uniqueClips(ctx.footage ?? []).filter((c) => licenseKind(c) === "attribution" && !usableCreatorName(c.creator));
  if (unattributed.length > 0) {
    blockers.push(`${unattributed.length} CC BY clip(s) without a usable author name (${unattributed.map((c) => c.sourceUrl || c.path).join(", ")})`);
  }
  return blockers;
}
