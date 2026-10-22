import { Film, LayoutDashboard, Moon, RefreshCw, Settings as SettingsIcon, Sparkles, Sun, TriangleAlert, Workflow, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { requestYoutubeRefresh, useDashboardData } from "./api";
import { useTheme } from "./colors";
import { Card, Empty } from "./components";
import { fmtAgo, fmtDateTime } from "./format";
import { Content } from "./pages/Content";
import { Overview } from "./pages/Overview";
import { Runs } from "./pages/Runs";
import { Settings } from "./pages/Settings";
import { Videos } from "./pages/Videos";

const PAGES: { id: string; label: string; icon: LucideIcon; title: string; sub: string }[] = [
  { id: "visao-geral", label: "Visão geral", icon: LayoutDashboard, title: "Visão geral", sub: "A máquina está produzindo e rendendo?" },
  { id: "videos", label: "Vídeos", icon: Film, title: "Vídeos", sub: "Tudo o que foi renderizado e publicado" },
  { id: "execucoes", label: "Execuções", icon: Workflow, title: "Execuções", sub: "Saúde do pipeline, etapa por etapa" },
  { id: "conteudo", label: "Conteúdo", icon: Sparkles, title: "Conteúdo e qualidade", sub: "Narração, footage, relevância e custo" },
  { id: "configuracoes", label: "Configurações", icon: SettingsIcon, title: "Configurações", sub: "Voz, legendas, visual, roteiro e temas da máquina" },
];

function currentPage(): string {
  const hash = window.location.hash.slice(1);
  return PAGES.find((p) => p.id === hash)?.id ?? "visao-geral";
}

export function App() {
  const { data, error, loadedAt, reload } = useDashboardData();
  const [theme, toggleTheme] = useTheme();
  const [pageId, setPageId] = useState(currentPage);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [, setTick] = useState(0);
  // Once opened, the settings page stays mounted (hidden) so unsaved edits survive tab switches.
  const [settingsOpened, setSettingsOpened] = useState(pageId === "configuracoes");
  useEffect(() => {
    if (pageId === "configuracoes") setSettingsOpened(true);
  }, [pageId]);

  useEffect(() => {
    const onHash = () => {
      setPageId(currentPage());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onHash);
    const timer = setInterval(() => setTick((t) => t + 1), 5_000); // keeps "há X min" and the cooldown fresh
    return () => {
      window.removeEventListener("hashchange", onHash);
      clearInterval(timer);
    };
  }, []);

  const page = PAGES.find((p) => p.id === pageId) ?? PAGES[0]!;
  const youtube = data?.overview.youtube;
  const cooldownLeft = youtube?.manualAvailableAt ? Date.parse(youtube.manualAvailableAt) - Date.now() : 0;

  const refreshYoutube = async () => {
    setRefreshing(true);
    try {
      const result = await requestYoutubeRefresh();
      setRefreshMsg(result.message);
      await reload();
    } catch (e) {
      setRefreshMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <img className="logo-on-dark" src="/logo-white.png" alt="" />
            <img className="logo-on-light" src="/logo-black.png" alt="" />
          </div>
          <div>
            <b>Máquina de Shorts</b>
            <span>canal de curiosidades</span>
          </div>
        </div>
        <nav className="nav">
          {PAGES.map((p) => (
            <a key={p.id} href={`#${p.id}`} className={p.id === page.id ? "active" : ""}>
              <p.icon size={17} />
              <span className="nav-label">{p.label}</span>
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="foot-text">Dados locais {loadedAt ? fmtAgo(loadedAt) : "…"} · atualiza a cada 60 s</span>
          <button type="button" className="ghost" onClick={toggleTheme} aria-label="Alternar tema claro/escuro">
            {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
            <span className="foot-text">{theme === "dark" ? "Tema claro" : "Tema escuro"}</span>
          </button>
        </div>
      </aside>

      <main className="main">
        <div className="page-head">
          <div>
            <h1>{page.title}</h1>
            <p>{page.sub}</p>
          </div>
          <div className="head-actions">
            <span>YouTube {youtube?.lastFetchAt ? `coletado ${fmtAgo(youtube.lastFetchAt)}` : "sem coleta ainda"}</span>
            <button
              type="button"
              className="primary"
              onClick={() => void refreshYoutube()}
              disabled={!youtube?.apiKeyConfigured || refreshing || cooldownLeft > 0}
              title={
                youtube?.apiKeyConfigured
                  ? `Coleta automática a cada ${youtube.refreshIntervalMinutes} min. Próxima: ${fmtDateTime(youtube.nextAutoRefreshAt)}`
                  : "YOUTUBE_API_KEY não configurada"
              }
            >
              <RefreshCw size={14} className={refreshing ? "spin" : undefined} />
              {refreshing ? "Atualizando…" : cooldownLeft > 0 ? `Atualizar (${Math.ceil(cooldownLeft / 1000)} s)` : "Atualizar"}
            </button>
          </div>
        </div>

        {refreshMsg && <div className="notice">{refreshMsg}</div>}
        {error && (
          <div className="banner">
            <TriangleAlert size={16} color="var(--critical)" /> Não foi possível carregar os dados locais: {error}
          </div>
        )}
        {data?.overview.history.errors.length ? (
          <div className="banner">
            <TriangleAlert size={16} color="var(--critical)" /> data/history.json tem problemas: {data.overview.history.errors.join("; ")}
          </div>
        ) : null}

        {settingsOpened && (
          <div hidden={page.id !== "configuracoes"}>
            <Settings runs={data?.runs ?? []} />
          </div>
        )}
        {page.id === "configuracoes" ? null : !data ? (
          <Card>
            <Empty icon={error ? TriangleAlert : RefreshCw} title={error ? "Servidor indisponível" : "Carregando…"} />
          </Card>
        ) : page.id === "videos" ? (
          <Videos rows={data.videos} historyExists={data.overview.history.exists} categories={data.overview.categories} />
        ) : page.id === "execucoes" ? (
          <Runs runs={data.runs} overview={data.overview} />
        ) : page.id === "conteudo" ? (
          <Content runs={data.runs} overview={data.overview} />
        ) : (
          <Overview data={data.overview} runs={data.runs} videos={data.videos} />
        )}
      </main>
    </div>
  );
}
