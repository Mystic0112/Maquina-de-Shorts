import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createWebSearch, SearxngSearch, TavilySearch, WebSearchError } from "../../src/orchestrator/lib/webSearch.js";
import { redactSecrets } from "../../src/orchestrator/lib/redact.js";

const CANARY = "tvly-CANARY0000000000000000000000000000"; // not a real key

interface Seen {
  method?: string;
  url?: string;
  auth?: string;
  body: string;
}
let seen: Seen[] = [];
let handler: (req: IncomingMessage, res: ServerResponse, body: string) => void = () => undefined;
let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
afterEach(() => {
  seen = [];
  delete process.env["TAVILY_API_KEY"];
});

const json = (res: ServerResponse, status: number, data: unknown): void => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};

describe("SearXNG client", () => {
  it("asks for json, normalizes the results and keeps at most 5 http(s) ones", async () => {
    handler = (_req, res) =>
      json(res, 200, {
        results: [
          { title: "Vênus", url: "https://nasa.gov/venus", content: "O dia de Vênus   dura\n243 dias." },
          { title: "sem url", content: "x" },
          { title: "ftp", url: "ftp://x.org/a", content: "x" },
          { title: "", url: "https://a.org/1", content: "" },
          ...Array.from({ length: 8 }, (_, i) => ({ title: `r${i}`, url: `https://s.org/${i}`, content: `c${i}` })),
        ],
      });
    const out = await new SearxngSearch(`${base}/`).search("dia de vênus");
    expect(seen).toHaveLength(1);
    const url = new URL(seen[0]!.url!, base);
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("q")).toBe("dia de vênus");
    expect(url.searchParams.get("format")).toBe("json");
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual({ title: "Vênus", url: "https://nasa.gov/venus", snippet: "O dia de Vênus dura 243 dias." });
  });

  it("403 (json not enabled) says what to configure; 500 and non-JSON are errors, not empty results", async () => {
    handler = (_req, res) => json(res, 403, {});
    await expect(new SearxngSearch(base).search("q")).rejects.toThrow(/search\.formats/);
    handler = (_req, res) => json(res, 500, {});
    await expect(new SearxngSearch(base).search("q")).rejects.toThrow(/HTTP 500/);
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>");
    };
    await expect(new SearxngSearch(base).search("q")).rejects.toThrow(/não é JSON/);
  });

  it("an instance that is down is a WebSearchError", async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    await expect(new SearxngSearch(`http://127.0.0.1:${port}`).search("q")).rejects.toBeInstanceOf(WebSearchError);
  });
});

describe("Tavily client", () => {
  it("POSTs the query with the key in the Authorization header only", async () => {
    handler = (_req, res) => json(res, 200, { results: [{ title: "T", url: "https://who.int/x", content: "texto", score: 0.9 }] });
    const out = await new TavilySearch(CANARY, `${base}/search`).search("sarampo");
    expect(seen[0]).toMatchObject({ method: "POST", url: "/search", auth: `Bearer ${CANARY}` });
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ query: "sarampo", max_results: 5 });
    expect(seen[0]!.url).not.toContain(CANARY);
    expect(seen[0]!.body).not.toContain(CANARY);
    expect(out).toEqual([{ title: "T", url: "https://who.int/x", snippet: "texto" }]);
  });

  it("429 and 401 are errors that never carry the key", async () => {
    for (const status of [429, 401]) {
      handler = (_req, res) => json(res, status, { detail: `bad key ${CANARY}` });
      const error = await new TavilySearch(CANARY, `${base}/search`).search("q").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(WebSearchError);
      const message = (error as Error).message;
      expect(message).toContain(`HTTP ${status}`);
      expect(message).not.toContain(CANARY);
      expect(redactSecrets(message)).not.toContain(CANARY);
    }
  });
});

describe("createWebSearch", () => {
  it("nothing configured = undefined (the old behaviour)", () => {
    expect(createWebSearch(undefined)).toBeUndefined();
    expect(createWebSearch({})).toBeUndefined();
    expect(createWebSearch({ baseUrl: "http://localhost:8888" })).toBeUndefined();
  });

  it("a configured but incomplete search is an error that says what is missing", () => {
    expect(() => createWebSearch({ provider: "searxng" })).toThrow(/endereço da sua instância/);
    expect(() => createWebSearch({ provider: "searxng", baseUrl: "  " })).toThrow(WebSearchError);
    expect(() => createWebSearch({ provider: "tavily" })).toThrow(/TAVILY_API_KEY/);
  });

  it("builds the configured one", () => {
    expect(createWebSearch({ provider: "searxng", baseUrl: base })?.name).toBe("searxng");
    process.env["TAVILY_API_KEY"] = CANARY;
    expect(createWebSearch({ provider: "tavily" })?.name).toBe("tavily");
  });
});
