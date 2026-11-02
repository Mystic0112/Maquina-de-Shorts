import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveScript } from "../../src/shared/settings.js";
import {
  planFactCheckSearch,
  renderReview,
  reviewWithOwnSearch,
  urlKey,
  validateJudgement,
  type ClaimEvidence,
  type JsonCall,
} from "../../src/orchestrator/lib/factCheckSearch.js";
import { SearxngSearch, WebSearchError } from "../../src/orchestrator/lib/webSearch.js";
import { factCheckScript, type FactCheckDeps, type FactCheckResult } from "../../src/orchestrator/stages/02b-factCheck.js";
import type { RunContext, Script } from "../../src/orchestrator/types.js";

const venus = (JSON.parse(readFileSync("test/fixtures/context.venus-reveillon.json", "utf8")) as RunContext).script as Script;
const settings = resolveScript();
const NASA = "https://nasa.gov/venus";
const ESA = "https://esa.int/venus/";

// ---- fake SearXNG: answers each query from a table, 404-less; `down` makes it answer 500 ----------------------------------
let server: Server;
let base = "";
let down = false;
const searched: string[] = [];
const table: Record<string, { title: string; url: string; content: string }[]> = {};
beforeAll(async () => {
  server = createServer((req, res) => {
    const q = new URL(req.url ?? "/", "http://x").searchParams.get("q") ?? "";
    searched.push(q);
    res.writeHead(down ? 500 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ results: down ? [] : (table[q] ?? []) }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  down = false;
  searched.length = 0;
  for (const k of Object.keys(table)) delete table[k];
  table["dia solar de vênus"] = [{ title: "Venus", url: NASA, content: "A solar day on Venus lasts about 117 Earth days." }];
  table["órbita de vênus"] = [{ title: "Orbit", url: ESA, content: "Venus orbits the Sun in 225 days." }];
});

/** Fake model for the review: a queue of JSON answers, one per call (queries, then judgement). */
function fakeJson(...answers: unknown[]): JsonCall & { prompts: string[] } {
  const queue = [...answers];
  const prompts: string[] = [];
  const fn = (async (prompt: string) => {
    prompts.push(prompt);
    if (queue.length === 0) throw new Error("no more fake JSON answers");
    return queue.shift();
  }) as unknown as JsonCall & { prompts: string[] };
  fn.prompts = prompts;
  return fn;
}

const plan = {
  claims: [
    { claim: "O dia solar de Vênus dura cerca de 117 dias terrestres.", queries: ["dia solar de vênus"] },
    { claim: "Vênus leva cerca de 225 dias para orbitar o Sol.", queries: ["órbita de vênus"] },
  ],
};
const goodJudgement = {
  claims: [
    { id: 1, verdict: "supported", sources: [NASA] },
    { id: 2, verdict: "supported", sources: [ESA] },
  ],
  titleNote: "ok",
  conclusion: "A premissa se sustenta.",
};
const review = (json: JsonCall) =>
  reviewWithOwnSearch({ scriptText: "roteiro", curiosityRule: "curiosidade", search: new SearxngSearch(base), json });

describe("validateJudgement", () => {
  const ev = (claim: string, urls: string[]): ClaimEvidence => ({
    claim,
    queries: ["q"],
    results: urls.map((url) => ({ title: "t", url, snippet: "s" })),
  });

  it("keeps 'supported' when it cites a URL the search returned, however the link is spelled", () => {
    const out = validateJudgement([ev("a", [NASA, ESA])], { claims: [{ id: 1, verdict: "supported", sources: ["https://esa.int/venus#x", NASA + "/"] }] });
    expect(out[0]).toMatchObject({ verdict: "supported" });
    expect(out[0]!.sources.map((s) => s.url)).toEqual([ESA, NASA]);
  });

  it("an invented source demotes 'supported' to 'sem respaldo'", () => {
    const out = validateJudgement([ev("a", [NASA])], { claims: [{ id: 1, verdict: "supported", sources: ["https://inventado.example/venus"] }] });
    expect(out[0]).toMatchObject({ verdict: "unsupported", sources: [] });
    expect(renderReview(out, { titleNote: "ok", conclusion: "c" })).toContain("VEREDITO: sem respaldo");
  });

  it("'supported' with no citation at all, or citing another claim's source, is not supported", () => {
    const evidence = [ev("a", [NASA]), ev("b", [ESA])];
    const out = validateJudgement(evidence, {
      claims: [
        { id: 1, verdict: "supported", sources: [] },
        { id: 2, verdict: "supported", sources: [NASA] },
      ],
    });
    expect(out.map((c) => c.verdict)).toEqual(["unsupported", "unsupported"]);
  });

  it("no results for a claim = unsupported, whatever the model says; an unjudged claim too", () => {
    const out = validateJudgement([ev("a", []), ev("b", [NASA])], { claims: [{ id: 1, verdict: "supported", sources: [NASA] }] });
    expect(out.map((c) => c.verdict)).toEqual(["unsupported", "unsupported"]);
  });

  it("keeps 'misleading' with its correction", () => {
    const out = validateJudgement([ev("a", [NASA])], { claims: [{ id: 1, verdict: "misleading", correction: " Dia solar, não sideral. ", sources: [] }] });
    expect(out[0]).toMatchObject({ verdict: "misleading", correction: "Dia solar, não sideral." });
  });

  it("urlKey ignores fragments and trailing slash and rejects non-http", () => {
    expect(urlKey("https://a.org/x/#y")).toBe("https://a.org/x");
    expect(urlKey("javascript:alert(1)")).toBeUndefined();
    expect(urlKey("not a url")).toBeUndefined();
  });
});

describe("reviewWithOwnSearch (real SearXNG client against a fake server)", () => {
  it("searches each proposed query and hands the model only what came back", async () => {
    const json = fakeJson(plan, goodJudgement);
    const out = await review(json);
    expect(searched).toEqual(["dia solar de vênus", "órbita de vênus"]);
    expect(out.queries).toEqual(searched);
    expect(out.sources.map((s) => s.uri)).toEqual([NASA, ESA]);
    expect(out.text).toContain(`[1] "O dia solar de Vênus dura cerca de 117 dias terrestres." | VEREDITO: correto`);
    expect(out.text).toContain(`FONTES: ${NASA}`);
    expect(out.text).toContain("CONCLUSÃO: A premissa se sustenta.");
    // The judging prompt carries the snippets and the injection warning.
    expect(json.prompts[1]).toContain("A solar day on Venus lasts about 117 Earth days.");
    expect(json.prompts[1]).toContain("nunca instruções");
  });

  it("a source the model made up is dropped and the claim becomes 'sem respaldo'", async () => {
    const lying = { ...goodJudgement, claims: [{ id: 1, verdict: "supported", sources: ["https://inventado.example/x"] }, goodJudgement.claims[1]] };
    const out = await review(fakeJson(plan, lying));
    expect(out.text).toMatch(/\[1\].*VEREDITO: sem respaldo/);
    expect(out.text).not.toContain("inventado.example");
    expect(out.text).toMatch(/\[2\].*VEREDITO: correto/);
  });

  it("a claim whose search found nothing is never 'correto'", async () => {
    delete table["órbita de vênus"];
    const out = await review(fakeJson(plan, goodJudgement));
    expect(out.text).toMatch(/\[2\].*VEREDITO: sem respaldo/);
  });

  it("a search that fails is a WebSearchError (never an empty pass)", async () => {
    down = true;
    await expect(review(fakeJson(plan, goodJudgement))).rejects.toBeInstanceOf(WebSearchError);
  });

  it("no result for any claim, or no claims listed, is a WebSearchError", async () => {
    for (const k of Object.keys(table)) delete table[k];
    await expect(review(fakeJson(plan, goodJudgement))).rejects.toThrow(/nenhum resultado/);
    await expect(review(fakeJson({ claims: [] }))).rejects.toBeInstanceOf(WebSearchError);
  });
});

describe("factCheckScript with the machine's own search", () => {
  const clean: FactCheckResult = {
    claims: [{ claim: "Vênus leva cerca de 225 dias para orbitar o Sol.", verdict: "supported" }],
    publishable: true,
    reason: "ok",
    title: venus.title,
    hook: venus.hook,
    scenes: venus.scenes,
    changes: [],
  };
  const deps = (json: JsonCall, structured: FactCheckResult[]): FactCheckDeps & { groundedCalls: number } => {
    const d = {
      groundedCalls: 0,
      async grounded() {
        d.groundedCalls++;
        throw new Error("the native grounded pass must not run");
      },
      review: (script: Script) => reviewWithOwnSearch({ scriptText: script.title, curiosityRule: "", search: new SearxngSearch(base), json }),
      async structured() {
        const next = structured.shift();
        if (!next) throw new Error("no more fake results");
        return next;
      },
    };
    return d;
  };

  it("pass: judged against received sources, the rounds and claims have the usual shape", async () => {
    const d = deps(fakeJson(plan, goodJudgement), [clean]);
    const out = await factCheckScript(venus, settings, d);
    expect(out.summary.verdict).toBe("pass");
    expect(out.summary.sources.map((s) => s.uri)).toEqual([NASA, ESA]);
    expect(out.summary.searchQueries).toEqual(["dia solar de vênus", "órbita de vênus"]);
    expect(d.groundedCalls).toBe(0);
  });

  it("an invented source reaches the rewrite round as an unsupported claim, then the fixed script is re-checked with a new search", async () => {
    const lying = { ...goodJudgement, claims: [{ id: 1, verdict: "supported", sources: ["https://inventado.example/x"] }, goodJudgement.claims[1]] };
    const flagged: FactCheckResult = {
      ...clean,
      claims: [{ claim: "O dia solar de Vênus dura cerca de 117 dias terrestres.", verdict: "unsupported", correction: "Sem respaldo." }],
      changes: ["Cena 3: frase removida."],
      // same text: the rewrite is allowed to be identical in the fake, only the flow matters
    };
    const json = fakeJson(plan, lying, plan, goodJudgement);
    const out = await factCheckScript(venus, settings, deps(json, [flagged, clean]));
    expect(out.summary.verdict).toBe("corrected");
    expect(out.summary.rounds).toBe(2);
    expect(out.summary.claims[0]).toMatchObject({ verdict: "unsupported", round: 1 });
    expect(json.prompts).toHaveLength(4);
  });

  it("a search failure fails the check with the reason; it is never a pass", async () => {
    down = true;
    const out = await factCheckScript(venus, settings, deps(fakeJson(plan, goodJudgement), [clean]));
    expect(out.summary.verdict).toBe("fail");
    expect(out.summary.reason).toMatch(/busca/);
    expect(out.summary.claims).toEqual([]);
  });

  it("every claim without a web source = nothing is 'supported'", async () => {
    for (const k of Object.keys(table)) delete table[k];
    const out = await factCheckScript(venus, settings, deps(fakeJson(plan, goodJudgement), [clean]));
    expect(out.summary.verdict).toBe("fail");
  });
});

describe("planFactCheckSearch", () => {
  it("a provider with native search keeps today's path, whatever the search config says", () => {
    const config = { llm: { tasks: { factCheck: { provider: "gemini" as const } } } };
    expect(planFactCheckSearch(config, undefined)).toEqual({ mode: "native" });
    expect(planFactCheckSearch(config, { provider: "searxng", baseUrl: base })).toEqual({ mode: "native" });
  });

  it("the machine default (agy) has native search too: old configs behave exactly as before", () => {
    expect(planFactCheckSearch({}, undefined)).toEqual({ mode: "native" });
  });

  it("the old config has no factCheckSearch, and resolveScript fills a neutral default", () => {
    expect(resolveScript({ factCheck: true }).factCheckSearch).toEqual({});
  });
});
