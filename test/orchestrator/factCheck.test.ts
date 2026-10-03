import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveScript } from "../../src/shared/settings.js";
import {
  applyFactCheckRound,
  factCheckScript,
  MAX_FACT_CHECK_ROUNDS,
  type FactCheckDeps,
  type FactCheckResult,
} from "../../src/orchestrator/stages/02b-factCheck.js";
import type { RunContext, Script } from "../../src/orchestrator/types.js";

const venus = (JSON.parse(readFileSync("test/fixtures/context.venus-reveillon.json", "utf8")) as RunContext).script as Script;
const settings = resolveScript();
const REVEILLON = "e, como o dia é mais longo que o ano, você comemoraria o Réveillon antes de ver o pôr do sol.";

function result(over: Partial<FactCheckResult> = {}): FactCheckResult {
  return {
    claims: [{ claim: "Vênus leva cerca de 225 dias para orbitar o Sol.", verdict: "supported" }],
    publishable: true,
    reason: "ok",
    title: venus.title,
    hook: venus.hook,
    scenes: venus.scenes,
    changes: [],
    ...over,
  };
}

/** Venus script with the Réveillon sentence replaced by an accurate one (same length). */
const fixedScenes = venus.scenes.map((s) =>
  s.narration.includes("Réveillon")
    ? { ...s, narration: s.narration.replace(REVEILLON, "e o ciclo de dia e noite dura cerca de cento e dezessete dias terrestres.") }
    : s,
);

const reveillonFlagged = result({
  claims: [
    { claim: REVEILLON, verdict: "unsupported", correction: "O dia solar dura ~117 dias terrestres; o Sol se põe ~58 dias depois de nascer." },
    { claim: "Vênus leva cerca de 225 dias para orbitar o Sol.", verdict: "supported" },
  ],
  scenes: fixedScenes,
  changes: ["Cena 3: frase do Réveillon substituída pela duração do dia solar."],
});

/** Fake LLM: one scripted structured result per round; grounded pass returns fixed sources. */
function fakeDeps(rounds: FactCheckResult[]): FactCheckDeps & { groundedCalls: number; structuredCalls: number } {
  const deps = {
    groundedCalls: 0,
    structuredCalls: 0,
    async grounded() {
      deps.groundedCalls++;
      return { text: "[1] ... VEREDITO: ...", sources: [{ uri: "https://nasa.gov/venus", title: "nasa.gov" }], queries: ["venus solar day"] };
    },
    async structured() {
      deps.structuredCalls++;
      const next = rounds.shift();
      if (!next) throw new Error("no more fake results");
      return next;
    },
  };
  return deps;
}

describe("applyFactCheckRound", () => {
  it("keeps the script verbatim when every claim is supported", () => {
    const out = applyFactCheckRound(venus, result({ hook: "model rewrote this anyway" }), 1, settings);
    expect(out.kind).toBe("clean");
    if (out.kind === "clean") expect(out.script).toEqual(venus);
  });

  it("accepts a toned-down title even when all claims are supported", () => {
    const out = applyFactCheckRound(venus, result({ title: "O planeta cuja rotação dura mais que o ano" }), 1, settings);
    expect(out).toMatchObject({ kind: "clean", titleChanged: true });
  });

  it("applies rewrites for unsupported claims but never touches the CTA", () => {
    const out = applyFactCheckRound(venus, reveillonFlagged, 1, settings);
    expect(out.kind).toBe("revised");
    if (out.kind !== "revised") return;
    expect(out.script.cta).toBe(venus.cta);
    expect(out.script.scenes.map((s) => s.narration).join(" ")).not.toContain("Réveillon");
    expect(out.claims[0]).toMatchObject({ verdict: "unsupported", round: 1, correction: expect.stringContaining("117") });
  });

  it("rejects when the model says the premise is not salvageable", () => {
    expect(applyFactCheckRound(venus, result({ publishable: false, reason: "premissa falsa" }), 1, settings)).toMatchObject({
      kind: "reject",
      reason: "premissa falsa",
    });
  });

  it("rejects rewrites that break the word limits beyond tolerance", () => {
    const tiny = result({
      claims: reveillonFlagged.claims,
      hook: "Vênus é estranho.",
      scenes: venus.scenes.slice(0, 4).map((s) => ({ ...s, narration: "Frase curta aqui." })),
    });
    const out = applyFactCheckRound(venus, tiny, 1, settings);
    expect(out.kind).toBe("reject");
  });
});

describe("factCheckScript with a fake LLM", () => {
  it("pass: one round, no changes", async () => {
    const deps = fakeDeps([result()]);
    const { script, summary } = await factCheckScript(venus, settings, deps);
    expect(script).toEqual(venus);
    expect(summary).toMatchObject({ verdict: "pass", rounds: 1, claimsChecked: 1, sources: [{ uri: "https://nasa.gov/venus" }] });
    expect(summary.originalScript).toBeUndefined();
    expect(deps.groundedCalls).toBe(1);
  });

  it("corrected: Réveillon claim rewritten, then re-verified clean", async () => {
    const deps = fakeDeps([reveillonFlagged, result({ scenes: fixedScenes, title: venus.title })]);
    const { script, summary } = await factCheckScript(venus, settings, deps);
    expect(summary.verdict).toBe("corrected");
    expect(summary.rounds).toBe(2);
    expect(summary.originalScript).toEqual(venus);
    expect(summary.corrections).toContain("Cena 3: frase do Réveillon substituída pela duração do dia solar.");
    expect(script.scenes.map((s) => s.narration).join(" ")).not.toContain("Réveillon");
    expect(deps.groundedCalls).toBe(2);
    expect(summary.sources).toHaveLength(1); // deduped across rounds
  });

  it("title-only change (sensational title) counts as corrected", async () => {
    const titanic: Script = { ...venus, title: "A chave esquecida que afundou o Titanic" };
    const { script, summary } = await factCheckScript(titanic, settings, fakeDeps([result({ title: "A chave esquecida que virou lenda no Titanic" })]));
    expect(script.title).toBe("A chave esquecida que virou lenda no Titanic");
    expect(summary).toMatchObject({ verdict: "corrected", titleBefore: titanic.title, titleAfter: script.title });
  });

  it("fail: still inaccurate after every round", async () => {
    const deps = fakeDeps(Array.from({ length: MAX_FACT_CHECK_ROUNDS }, () => reveillonFlagged));
    const { summary } = await factCheckScript(venus, settings, deps);
    expect(summary.verdict).toBe("fail");
    expect(summary.rounds).toBe(MAX_FACT_CHECK_ROUNDS);
    expect(summary.reason).toMatch(/ainda incorretas/);
  });

  it("last round with only 'misleading' nuance: applies the correction instead of failing", async () => {
    const nuance = result({
      claims: [{ claim: "O planeta onde o dia dura mais que o ano", verdict: "misleading", correction: "a rotação, não o dia solar" }],
      title: "O planeta cuja rotação dura mais que o ano",
      scenes: fixedScenes,
    });
    const deps = fakeDeps([reveillonFlagged, reveillonFlagged, nuance]);
    const { script, summary } = await factCheckScript(venus, settings, deps);
    expect(summary.verdict).toBe("corrected");
    expect(summary.rounds).toBe(MAX_FACT_CHECK_ROUNDS);
    expect(script.title).toBe("O planeta cuja rotação dura mais que o ano");
    expect(summary.corrections.at(-1)).toMatch(/sem nova verificação/);
  });

  it("fail: premise rejected in round 1", async () => {
    const { summary } = await factCheckScript(venus, settings, fakeDeps([result({ publishable: false, reason: "mito" })]));
    expect(summary).toMatchObject({ verdict: "fail", reason: "mito", rounds: 1 });
  });

  it("asks once more when a rewrite breaks the limits, then accepts the fixed rewrite", async () => {
    const broken = result({ claims: reveillonFlagged.claims, hook: "Curto.", scenes: venus.scenes.slice(0, 4).map((s) => ({ ...s, narration: "Frase curta aqui." })) });
    const deps = fakeDeps([broken, reveillonFlagged, result({ scenes: fixedScenes })]);
    const { summary } = await factCheckScript(venus, settings, deps);
    expect(summary.verdict).toBe("corrected");
    expect(deps.structuredCalls).toBe(3);
    expect(deps.groundedCalls).toBe(2);
  });
});
