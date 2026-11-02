// Stage 02b end to end (run()), with the LLM calls faked and a fake SearXNG on localhost. "Native search" is switched
// per test because no registered provider lacks it yet (the OpenAI-compatible one arrives separately).
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  native: false,
  config: {} as Record<string, unknown>,
  json: [] as unknown[],
  generateJson: vi.fn(),
  generateGroundedText: vi.fn(),
}));

vi.mock("../../src/shared/settings.js", async (orig) => ({ ...(await orig<typeof import("../../src/shared/settings.js")>()), hasNativeWebSearch: () => h.native }));
vi.mock("../../src/orchestrator/lib/config.js", async (orig) => ({ ...(await orig<typeof import("../../src/orchestrator/lib/config.js")>()), loadConfig: () => h.config }));
vi.mock("../../src/orchestrator/lib/llmClient.js", async (orig) => ({
  ...(await orig<typeof import("../../src/orchestrator/lib/llmClient.js")>()),
  generateJson: h.generateJson,
  generateGroundedText: h.generateGroundedText,
}));

import { run } from "../../src/orchestrator/stages/02b-factCheck.js";
import { scriptHash, contentBindingProblems } from "../../src/orchestrator/lib/contentHash.js";
import { RunRejectedError } from "../../src/orchestrator/lib/rejection.js";
import { SearchUnsupportedError } from "../../src/orchestrator/lib/searchSupport.js";
import type { RunContext, Script } from "../../src/orchestrator/types.js";

const venus = (JSON.parse(readFileSync("test/fixtures/context.venus-reveillon.json", "utf8")) as RunContext).script as Script;
const NASA = "https://nasa.gov/venus";
const revision = { claims: [{ claim: "Vênus leva 225 dias.", verdict: "supported" }], publishable: true, reason: "ok", title: venus.title, hook: venus.hook, scenes: venus.scenes, changes: [] };
const plan = { claims: [{ claim: "Vênus leva 225 dias.", queries: ["venus orbit"] }] };
const judged = { claims: [{ id: 1, verdict: "supported", sources: [NASA] }], titleNote: "ok", conclusion: "ok" };

let server: Server;
let base = "";
let searches = 0;
beforeAll(async () => {
  server = createServer((_req, res) => {
    searches++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ results: [{ title: "Venus", url: NASA, content: "Venus orbits the Sun in 225 days." }] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

let n = 0;
const ctx = (): RunContext => ({ runId: `test-fcsearch-${process.pid}-${++n}`, script: venus }) as unknown as RunContext;
const withScript = (script: Record<string, unknown>): void => {
  h.config = { voice: {}, script: { factCheck: true, ...script } };
};
const rejection = async (): Promise<RunRejectedError> => {
  const error = await run(ctx()).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(RunRejectedError);
  return error as RunRejectedError;
};

beforeEach(() => {
  h.native = false;
  h.json = [];
  searches = 0;
  h.generateJson.mockReset().mockImplementation(async () => {
    if (h.json.length === 0) throw new Error("unexpected extra LLM call");
    return h.json.shift();
  });
  h.generateGroundedText.mockReset();
});

describe("02b-factCheck: provider without native search", () => {
  it("no search configured: the run is REJECTED with what to configure, no model is called, nothing passes", async () => {
    withScript({});
    const error = await rejection();
    expect(error.message).toMatch(/Fact-check rejected/);
    expect(error.message).toMatch(/SearXNG/);
    expect(error.message).toMatch(/script\.factCheck=false/);
    expect(error.ctx.factCheck).toMatchObject({ verdict: "fail", rounds: 0 });
    expect(error.ctx.factCheck?.scriptHash).toBeUndefined();
    expect(h.generateJson).not.toHaveBeenCalled();
    expect(h.generateGroundedText).not.toHaveBeenCalled();
    expect(contentBindingProblems(error.ctx, { requireHashes: true })).toEqual([]); // a "fail" is not an approval
  });

  it("a search chosen but incomplete (no URL) is rejected too", async () => {
    withScript({ factCheckSearch: { provider: "searxng" } });
    expect((await rejection()).message).toMatch(/endereço da sua instância/);
  });

  it("search down: rejected with the reason, not approved", async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    withScript({ factCheckSearch: { provider: "searxng", baseUrl: `http://127.0.0.1:${port}` } });
    h.json = [plan];
    const error = await rejection();
    expect(error.ctx.factCheck?.verdict).toBe("fail");
    expect(error.message).toMatch(/busca/);
  });

  it("with a working search it passes, bound to the script hash like any other pass", async () => {
    withScript({ factCheckSearch: { provider: "searxng", baseUrl: base } });
    h.json = [plan, judged, revision];
    const out = await run(ctx());
    expect(out.factCheck).toMatchObject({ verdict: "pass", scriptHash: scriptHash(venus) });
    expect(out.factCheck?.sources.map((s) => s.uri)).toEqual([NASA]);
    expect(searches).toBe(1);
    expect(h.generateGroundedText).not.toHaveBeenCalled();
    expect(contentBindingProblems(out, { requireHashes: true })).toEqual([]);
  });

  it("a source invented by the model never makes a claim 'supported'", async () => {
    withScript({ factCheckSearch: { provider: "searxng", baseUrl: base } });
    const lying = { ...judged, claims: [{ id: 1, verdict: "supported", sources: ["https://inventado.example/a"] }] };
    h.json = [plan, lying, { ...revision, claims: [{ claim: "Vênus leva 225 dias.", verdict: "unsupported", correction: "x" }], changes: ["x"] }, plan, judged, revision];
    const out = await run(ctx());
    expect(out.factCheck?.claims[0]).toMatchObject({ round: 1, verdict: "unsupported" });
    expect(out.factCheck?.verdict).toBe("corrected");
  });
});

describe("02b-factCheck: provider with native search (unchanged)", () => {
  it("uses the grounded pass and never touches the machine's search, even if one is configured", async () => {
    h.native = true;
    withScript({ factCheckSearch: { provider: "searxng", baseUrl: base } });
    h.generateGroundedText.mockResolvedValue({ text: "[1] ... VEREDITO: correto", sources: [{ uri: NASA, title: "nasa.gov" }], queries: ["q"] });
    h.json = [revision];
    const out = await run(ctx());
    expect(out.factCheck).toMatchObject({ verdict: "pass", scriptHash: scriptHash(venus) });
    expect(h.generateGroundedText).toHaveBeenCalledTimes(1);
    expect(searches).toBe(0);
  });

  it("old config (no factCheckSearch) behaves as before", async () => {
    h.native = true;
    withScript({});
    h.generateGroundedText.mockResolvedValue({ text: "ok", sources: [{ uri: NASA }], queries: [] });
    h.json = [revision];
    expect((await run(ctx())).factCheck?.verdict).toBe("pass");
  });

  it("a provider that throws SearchUnsupportedError (e.g. the task's alternative) rejects the run clearly", async () => {
    h.native = true;
    withScript({});
    h.generateGroundedText.mockRejectedValue(new SearchUnsupportedError("openai-compatible"));
    const error = await rejection();
    expect(error.message).toMatch(/não tem busca na web/);
    expect(error.ctx.factCheck?.verdict).toBe("fail");
  });

  it("factCheck=false stays an explicit, marked skip", async () => {
    withScript({ factCheck: false });
    const out = await run(ctx());
    expect(out.factCheck?.verdict).toBe("skipped");
    expect(h.generateJson).not.toHaveBeenCalled();
  });
});
