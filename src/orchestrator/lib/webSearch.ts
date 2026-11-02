/**
 * The machine's own web search, used by the fact-check when the LLM provider has no search of its own
 * (see src/orchestrator/lib/factCheckSearch.ts). Plain HTTP, no SDK. To add a provider: an entry in
 * WEB_SEARCH_PROVIDERS (src/shared/settings.ts) and its factory in FACTORIES below (the compiler demands both).
 *
 * - searxng: the person's own SearXNG instance (free, local). Its settings.yml must list `json` under `search.formats`
 *   (it ships with html only) or the instance answers 403.
 * - tavily: search API, the person's own key in TAVILY_API_KEY (docs: https://docs.tavily.com). The key goes in the
 *   Authorization header only, never in a URL, a log or an error message.
 */
import type { WebSearchProviderName } from "../../shared/settings.js";
import { env } from "./config.js";
import { redactSecrets, registerSecret } from "./redact.js";

export interface SearchResult {
  title: string;
  url: string;
  /** Short excerpt of the page, as the search engine returns it. */
  snippet: string;
}

export interface WebSearchProvider {
  readonly name: WebSearchProviderName;
  search(query: string): Promise<SearchResult[]>;
}

/** A search that cannot run (not configured, network, 429, bad answer): the fact-check rejects the run with this reason. */
export class WebSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebSearchError";
  }
}

const TIMEOUT_MS = 20_000;
const MAX_RESULTS = 5;
const MAX_SNIPPET = 400;

const clip = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Keeps only http(s) results with a URL and some text; anything else is noise. */
function normalize(rows: unknown): SearchResult[] {
  if (!Array.isArray(rows)) return [];
  const out: SearchResult[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    const url = typeof row?.["url"] === "string" ? row["url"].trim() : "";
    if (!/^https?:\/\/\S+$/.test(url)) continue;
    const snippet = clip(row["content"], MAX_SNIPPET);
    const title = clip(row["title"], 200);
    if (!snippet && !title) continue;
    out.push({ title: title || url, url, snippet });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

async function fetchJson(provider: string, url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new WebSearchError(`a busca (${provider}) não respondeu: ${redactSecrets(why).slice(0, 160)}`);
  }
  if (!response.ok) {
    const hint =
      response.status === 429
        ? " (limite de uso da busca)"
        : response.status === 403 && provider === "searxng"
          ? ' (a instância precisa ter "json" em search.formats)'
          : "";
    throw new WebSearchError(`a busca (${provider}) respondeu HTTP ${response.status}${hint}`);
  }
  try {
    return await response.json();
  } catch {
    throw new WebSearchError(`a busca (${provider}) devolveu uma resposta que não é JSON`);
  }
}

export class SearxngSearch implements WebSearchProvider {
  readonly name = "searxng" as const;
  constructor(private readonly baseUrl: string) {}

  async search(query: string): Promise<SearchResult[]> {
    const url = new URL("search", this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`);
    url.search = new URLSearchParams({ q: query, format: "json", safesearch: "0" }).toString();
    const body = (await fetchJson(this.name, url.toString(), { headers: { Accept: "application/json" } })) as { results?: unknown };
    return normalize(body?.results);
  }
}

export const TAVILY_ENDPOINT = "https://api.tavily.com/search";

export class TavilySearch implements WebSearchProvider {
  readonly name = "tavily" as const;
  constructor(
    private readonly apiKey: string,
    private readonly endpoint: string = TAVILY_ENDPOINT,
  ) {
    registerSecret(apiKey);
  }

  async search(query: string): Promise<SearchResult[]> {
    const body = (await fetchJson(this.name, this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ query, max_results: MAX_RESULTS, search_depth: "basic", include_answer: false }),
    })) as { results?: unknown };
    return normalize(body?.results);
  }
}

export interface WebSearchConfig {
  provider?: WebSearchProviderName;
  baseUrl?: string;
}

const FACTORIES: Record<WebSearchProviderName, (cfg: WebSearchConfig) => WebSearchProvider> = {
  searxng: (cfg) => {
    const baseUrl = cfg.baseUrl?.trim();
    if (!baseUrl) throw new WebSearchError('a busca "SearXNG" precisa do endereço da sua instância (ex.: http://localhost:8888) em Configurações > Roteiro');
    return new SearxngSearch(baseUrl);
  },
  tavily: () => {
    const key = env("TAVILY_API_KEY");
    if (!key) throw new WebSearchError('a busca "Tavily" precisa da chave TAVILY_API_KEY (Configurações > Chaves e acessos, ou o .env)');
    return new TavilySearch(key);
  },
};

/** The configured search, or undefined when none is configured; throws WebSearchError when configured but incomplete. */
export function createWebSearch(cfg: WebSearchConfig | undefined): WebSearchProvider | undefined {
  if (!cfg?.provider) return undefined;
  return FACTORIES[cfg.provider](cfg);
}
