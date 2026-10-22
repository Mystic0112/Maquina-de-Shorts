import { describe, expect, it } from "vitest";
import { estimateLlmCost } from "../../dashboard/shared/llmCost.js";
import type { LlmUsage } from "../../src/orchestrator/types.js";

const pricing = { inputUsdPerMTok: 0.3, outputUsdPerMTok: 2.5 };
const usage = (byModel: LlmUsage["byModel"]): LlmUsage => ({
  calls: byModel.reduce((n, m) => n + m.calls, 0),
  inputTokens: byModel.reduce((n, m) => n + m.inputTokens, 0),
  outputTokens: byModel.reduce((n, m) => n + m.outputTokens, 0),
  byModel,
  byStage: {},
});

describe("estimateLlmCost", () => {
  it("antigravity-cli calls cost nothing (plan credits)", () => {
    const u = usage([{ provider: "antigravity-cli", model: "gemini-3.8-flash-medium", calls: 4, inputTokens: 2_000_000, outputTokens: 1_000_000 }]);
    expect(estimateLlmCost(u, pricing)).toEqual({ usd: 0, planCalls: 4, paidCalls: 0 });
  });

  it("prices gemini/anthropic calls and leaves the plan calls out of a mixed run", () => {
    const u = usage([
      { provider: "antigravity-cli", model: "gemini-3.8-flash-medium", calls: 3, inputTokens: 5_000_000, outputTokens: 5_000_000 },
      { provider: "gemini", model: "gemini-flash-latest", calls: 2, inputTokens: 1_000_000, outputTokens: 1_000_000 },
      { provider: "anthropic", model: "claude-sonnet-5-5", calls: 1, inputTokens: 1_000_000, outputTokens: 0 },
    ]);
    const e = estimateLlmCost(u, pricing);
    expect(e.usd).toBeCloseTo(0.3 + 2.5 + 0.3);
    expect(e).toMatchObject({ planCalls: 3, paidCalls: 3 });
  });

  it("old runs without byModel are priced on their totals", () => {
    const u: LlmUsage = { calls: 2, inputTokens: 1_000_000, outputTokens: 1_000_000, byModel: [], byStage: {} };
    expect(estimateLlmCost(u, pricing)).toEqual({ usd: 2.8, planCalls: 0, paidCalls: 2 });
  });
});
