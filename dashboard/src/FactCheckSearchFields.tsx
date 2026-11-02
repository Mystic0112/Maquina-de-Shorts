// Configurações > Roteiro: "Busca na web da checagem de fatos" (config script.factCheckSearch). Só vale para um provedor de
// IA SEM busca própria na tarefa "Checagem de fatos"; agy, Gemini e Claude já buscam sozinhos e ignoram este campo.
import { TriangleAlert } from "lucide-react";
import type { WebSearchProviderName } from "../../src/shared/settings";
import { Field, TextInput } from "./settingsUi";

// Record over the provider names: adding a provider to the registry makes this fail to compile until it has a label.
const OPTIONS: Record<WebSearchProviderName, string> = {
  searxng: "SearXNG (instância própria, grátis)",
  tavily: "Tavily (API de busca, com a sua chave)",
};

export function FactCheckSearchFields(props: {
  search: { provider?: WebSearchProviderName; baseUrl?: string } | undefined;
  tavilyKeySet: boolean | undefined;
  set: (path: string, value: unknown) => void;
  errorAt: (path: string) => string | undefined;
}) {
  const { search, tavilyKeySet, set, errorAt } = props;
  const provider = search?.provider;
  return (
    <>
      <Field
        label="Busca na web da checagem de fatos"
        wide
        error={errorAt("script.factCheckSearch.provider")}
        help="Só é usada quando a IA da tarefa “Checagem de fatos” não busca na web sozinha (modelo local, Ollama, LM Studio...). Agy, Gemini e Claude já buscam e ignoram este campo. Sem busca nenhuma configurada, esses modelos NÃO conseguem checar fatos: a execução é recusada (o vídeo nunca sai sem checagem, a não ser que você desligue a checagem acima de propósito)."
      >
        <select className="input" value={provider ?? ""} onChange={(e) => set("script.factCheckSearch.provider", e.target.value || undefined)}>
          <option value="">Nenhuma</option>
          {(Object.keys(OPTIONS) as WebSearchProviderName[]).map((p) => (
            <option key={p} value={p}>
              {OPTIONS[p]}
            </option>
          ))}
        </select>
      </Field>
      {provider === "searxng" && (
        <TextInput
          label="Endereço do seu SearXNG"
          value={search?.baseUrl ?? ""}
          onChange={(v) => set("script.factCheckSearch.baseUrl", v || undefined)}
          placeholder="http://localhost:8888"
          help="Endereço da instância que roda no seu computador. No settings.yml dela, a lista search.formats precisa incluir json (por padrão só vem html)."
          error={errorAt("script.factCheckSearch.baseUrl")}
        />
      )}
      {provider === "tavily" && (
        <div className="banner" style={{ gridColumn: "1 / -1", marginBottom: 0 }}>
          <TriangleAlert size={16} color={tavilyKeySet ? "var(--muted)" : "var(--critical)"} style={{ flex: "none" }} />
          <div>
            {tavilyKeySet
              ? "Chave do Tavily configurada."
              : "Falta a chave do Tavily: cole-a no cartão do Tavily da seção Plataforma ou no .env como TAVILY_API_KEY."}{" "}
            Cada checagem gasta de 10 a 40 buscas do seu plano; o plano grátis é limitado por mês.
          </div>
        </div>
      )}
    </>
  );
}
