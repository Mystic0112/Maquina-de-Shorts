/**
 * "This provider cannot search the web": the typed error for LlmProvider.completeGroundedText.
 *
 * A provider without a web search of its own (OpenAI-compatible endpoints, Ollama, LM Studio...) MUST throw this from
 * `completeGroundedText` instead of answering from memory: an answer without a search is not a fact-check. The
 * fact-check stage (02b) turns it into a clear rejection of the run, never into "no check". Such a provider is also
 * left OUT of NATIVE_WEB_SEARCH in src/shared/settings.ts (`hasNativeWebSearch`), so the stage uses the machine's own
 * search (lib/webSearch.ts) for it, or rejects the run when none is configured.
 */
export class SearchUnsupportedError extends Error {
  constructor(readonly provider: string) {
    super(
      `O provedor "${provider}" não tem busca na web, então não consegue checar fatos sozinho. ` +
        `Use um provedor com busca (agy, Gemini, Claude) na tarefa "Checagem de fatos" ou configure a busca própria da Máquina ` +
        `em Configurações > Roteiro > "Busca na web da checagem de fatos".`,
    );
    this.name = "SearchUnsupportedError";
  }
}

export const isSearchUnsupportedError = (error: unknown): error is SearchUnsupportedError =>
  error instanceof SearchUnsupportedError || (error instanceof Error && error.name === "SearchUnsupportedError");
