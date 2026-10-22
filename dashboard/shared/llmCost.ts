// LLM cost estimate shared by the dashboard pages (pure, unit-tested from the root test suite).
import type { LlmUsage } from "../../src/orchestrator/types.js";

/** Providers billed to the owner's plan credits, not per token (no API cost). */
const PLAN_PROVIDERS = new Set(["antigravity-cli"]);

export interface LlmCostEstimate {
  usd: number;
  /** Calls that ran on the plan (Antigravity CLI) and cost 0 here. */
  planCalls: number;
  /** Calls priced with the reference API price. */
  paidCalls: number;
}

/**
 * USD estimate of a run's LLM usage with a reference price; antigravity-cli calls cost 0. Runs recorded
 * before byModel existed are priced on their totals (they could only be API calls back then).
 */
export function estimateLlmCost(
  usage: LlmUsage,
  pricing: { inputUsdPerMTok: number; outputUsdPerMTok: number },
): LlmCostEstimate {
  const price = (input: number, output: number) => (input * pricing.inputUsdPerMTok + output * pricing.outputUsdPerMTok) / 1e6;
  if (usage.byModel.length === 0) return { usd: price(usage.inputTokens, usage.outputTokens), planCalls: 0, paidCalls: usage.calls };
  return usage.byModel.reduce<LlmCostEstimate>(
    (acc, m) =>
      PLAN_PROVIDERS.has(m.provider)
        ? { ...acc, planCalls: acc.planCalls + m.calls }
        : { ...acc, usd: acc.usd + price(m.inputTokens, m.outputTokens), paidCalls: acc.paidCalls + m.calls },
    { usd: 0, planCalls: 0, paidCalls: 0 },
  );
}
