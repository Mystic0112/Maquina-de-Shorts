import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveScript } from "../../src/shared/settings.js";
import {
  applyFactCheckRound,
  buildGroundedReviewPrompt,
  buildRevisionPrompt,
  factCheckScript,
  MAX_FACT_CHECK_ROUNDS,
  type FactCheckDeps,
  type FactCheckResult,
} from "../../src/orchestrator/stages/02b-factCheck.js";
import { scriptHash } from "../../src/orchestrator/lib/contentHash.js";
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

  it("a rewrite keeps only the beats whose phrase is still said", () => {
    const beats = [
      { phrase: "Vênus gira no sentido contrário", footageQuery: "venus planet nasa" },
      { phrase: "comemoraria o Réveillon", footageQuery: "fireworks night sky" },
    ];
    const withBeats: Script = { ...venus, scenes: venus.scenes.map((s) => (s.narration.includes("Réveillon") ? { ...s, beats } : s)) };
    const out = applyFactCheckRound(withBeats, reveillonFlagged, 1, settings);
    expect(out.kind).toBe("revised");
    if (out.kind !== "revised") return;
    expect(out.script.scenes.find((s) => s.narration.includes("sentido contrário"))?.beats).toEqual([beats[0]]);
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

  const nuance = result({
    claims: [{ claim: "O planeta onde o dia dura mais que o ano", verdict: "misleading", correction: "a rotação, não o dia solar" }],
    title: "O planeta cuja rotação dura mais que o ano",
    scenes: fixedScenes,
  });

  it("last round with only 'misleading' nuance: the rewrite is verified by a 4th grounded pass, then published", async () => {
    const deps = fakeDeps([reveillonFlagged, reveillonFlagged, nuance, result({ scenes: fixedScenes, title: nuance.title })]);
    const { script, summary } = await factCheckScript(venus, settings, deps);
    expect(summary.verdict).toBe("corrected");
    expect(summary.rounds).toBe(MAX_FACT_CHECK_ROUNDS);
    expect(script.title).toBe("O planeta cuja rotação dura mais que o ano");
    expect(summary.corrections.at(-1)).toMatch(/verificadas com nova busca/);
    expect(deps.groundedCalls).toBe(MAX_FACT_CHECK_ROUNDS + 1);
  });

  it("last round rewrite whose verification finds a false claim fails", async () => {
    const deps = fakeDeps([reveillonFlagged, reveillonFlagged, nuance, reveillonFlagged]);
    const { summary } = await factCheckScript(venus, settings, deps);
    expect(summary.verdict).toBe("fail");
    expect(summary.reason).toMatch(/sem respaldo/);
  });

  it("no web sources: retries the grounded pass once, then rejects", async () => {
    const deps = fakeDeps([result()]);
    deps.grounded = async () => (deps.groundedCalls++, { text: "sem busca", sources: [], queries: [] });
    const { summary } = await factCheckScript(venus, settings, deps);
    expect(summary.verdict).toBe("fail");
    expect(deps.groundedCalls).toBe(2);
    expect(deps.structuredCalls).toBe(0);
  });

  it("zero claims: retries the structured pass once, then rejects", async () => {
    const deps = fakeDeps([result({ claims: [] }), result({ claims: [] })]);
    const { summary } = await factCheckScript(venus, settings, deps);
    expect(summary).toMatchObject({ verdict: "fail", reason: expect.stringMatching(/nenhuma afirmação/) });
    expect(deps.structuredCalls).toBe(2);
  });

  it("zero claims on the first try but claims on the retry: proceeds", async () => {
    const deps = fakeDeps([result({ claims: [] }), result()]);
    const { summary } = await factCheckScript(venus, settings, deps);
    expect(summary.verdict).toBe("pass");
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

describe("overlay text, curiosity and key-term consistency", () => {
  const moon: Script = {
    title: "O cheiro bizarro da Lua",
    overlayText: "A LUA TEM CHEIRO?",
    hook: "A Lua tem cheiro: de pólvora queimada.",
    hookFootageQuery: "Apollo 11 lunar surface",
    scenes: [
      { narration: "Os astronautas da Apollo sentiram esse cheiro bizarro ao tirar os capacetes na nave.", footageQuery: "Apollo lunar module" },
      { narration: "A poeira lunar grudava nos trajes e, dentro da cabine, liberava um cheiro de pólvora.", footageQuery: "Apollo astronaut suit dust" },
      { narration: "Os cientistas ainda discutem a causa, mas o cheiro foi descrito por vários astronautas.", footageQuery: "lunar soil sample nasa" },
      { narration: "Na Terra, as mesmas amostras de poeira lunar não tinham cheiro nenhum. A Lua só cheira de perto.", footageQuery: "moon surface nasa" },
    ],
    cta: "Segue pra mais curiosidades.",
    language: "pt-BR",
  };
  const ok = (over: Partial<FactCheckResult> = {}): FactCheckResult => ({
    claims: [{ claim: "Astronautas relataram cheiro de pólvora.", verdict: "supported" }],
    publishable: true,
    reason: "ok",
    title: moon.title,
    overlayText: moon.overlayText,
    hook: moon.hook,
    scenes: moon.scenes,
    changes: [],
    ...over,
  });

  it("prompts check the overlay text and protect accurate curiosity words", () => {
    const review = buildGroundedReviewPrompt(moon);
    expect(review).toContain("Texto na tela/capa: A LUA TEM CHEIRO?");
    expect(review).toContain('não as troque por versões mornas ("misterioso"');
    const revision = buildRevisionPrompt(moon, { text: "ok", sources: [], queries: [] }, settings);
    expect(revision).toContain('"overlayText": "A LUA TEM CHEIRO?"');
    expect(revision).toContain("as palavras importantes do título");
  });

  it("keeps hookFootageQuery and an untouched overlay on a clean round", () => {
    const out = applyFactCheckRound(moon, ok({ overlayText: undefined }), 1, settings);
    expect(out.kind).toBe("clean");
    if (out.kind === "clean") {
      expect(out.script).toEqual(moon);
      expect(out.overlayChanged).toBe(false);
    }
  });

  it("an inaccurate overlay text is corrected and recorded", async () => {
    const corrected = ok({ overlayText: "A LUA CHEIRA A PÓLVORA?" });
    const { script, summary } = await factCheckScript(moon, settings, fakeDeps([corrected]));
    expect(script.overlayText).toBe("A LUA CHEIRA A PÓLVORA?");
    expect(summary.verdict).toBe("corrected");
    expect(summary.corrections).toContain('Texto da tela: "A LUA TEM CHEIRO?" -> "A LUA CHEIRA A PÓLVORA?"');
  });

  it("a new title whose key word the narration never says is sent back, then accepted when fixed", async () => {
    const broken = ok({ title: "O perfume de enxofre da Lua" }); // "perfume", "enxofre" are never narrated
    const deps = fakeDeps([broken, ok({ title: "O cheiro de pólvora da Lua" })]);
    const { script, summary } = await factCheckScript(moon, settings, deps);
    expect(deps.structuredCalls).toBe(2);
    expect(script.title).toBe("O cheiro de pólvora da Lua");
    expect(summary.verdict).toBe("corrected");
  });

  it("rejects the run when the inconsistency survives the retry", async () => {
    const broken = ok({ title: "O perfume de enxofre da Lua" });
    const { summary } = await factCheckScript(moon, settings, fakeDeps([broken, broken]));
    expect(summary.verdict).toBe("fail");
    expect(summary.reason).toMatch(/inconsistentes/);
  });

  it("a rewrite that drops the title's key word from the narration is sent back", () => {
    const rewrite = ok({
      claims: [{ claim: "cheiro de pólvora", verdict: "misleading", correction: "cheiro parecido com pólvora" }],
      hook: "A Lua tem um aroma curioso, parecido com pólvora.",
      scenes: moon.scenes.map((s) => ({ ...s, narration: s.narration.replace(/cheiro|cheira/g, "aroma") })),
    });
    const shortVideo = resolveScript({ minWords: 60, maxWords: 120 }); // the moon script is ~90 words
    expect(applyFactCheckRound(moon, ok({ claims: rewrite.claims }), 1, shortVideo).kind).toBe("revised");
    const out = applyFactCheckRound(moon, rewrite, 1, shortVideo);
    expect(out.kind).toBe("reject");
    if (out.kind === "reject") {
      expect(out.reason).toMatch(/^título, texto da tela, gancho e narração ficaram inconsistentes/);
      expect(out.reason).toContain('"cheiro"');
    }
  });

  it("scriptHash covers overlayText and hookFootageQuery, and is unchanged for scripts without them", () => {
    expect(scriptHash({ ...moon, overlayText: "OUTRO TEXTO AQUI" })).not.toBe(scriptHash(moon));
    expect(scriptHash({ ...moon, hookFootageQuery: "moon nasa" })).not.toBe(scriptHash(moon));
    const legacy: Script = { ...venus };
    expect(scriptHash(legacy)).toBe(scriptHash({ ...venus, overlayText: undefined, hookFootageQuery: undefined }));
  });
});
