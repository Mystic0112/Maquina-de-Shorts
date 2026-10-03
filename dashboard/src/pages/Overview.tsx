import {
  Activity,
  Clapperboard,
  Eye,
  Film,
  Gauge,
  Layers,
  TrendingUp,
  TriangleAlert,
  Upload,
  Users,
  Wallet,
  ChartColumn,
  Target,
} from "lucide-react";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { stageCode, type Overview as OverviewData, type RunSummary, type VideoRow } from "../../shared/api";
import { categoryColor } from "../colors";
import {
  axisProps,
  Card,
  ChartCard,
  Delta,
  Donut,
  Empty,
  Kpi,
  Legend,
  PlayerModal,
  StatusBadge,
  tooltipProps,
  VideoCard,
  toPlayable,
  type PlayableVideo,
} from "../components";
import { countBy, failuresByStage, weekOverWeek } from "../derive";
import { fmtAgo, fmtCompact, fmtDateTime, fmtDay, fmtDuration, fmtInt, fmtPercent, STAGE_LABEL } from "../format";

function RevenueCard({ data }: { data: OverviewData }) {
  const revenue = data.revenue;
  if (revenue.status === "ok") {
    const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: revenue.currency });
    return (
      <Card title="Receita" icon={Wallet} sub={`${fmtDateTime(revenue.periodStart)} a ${fmtDateTime(revenue.periodEnd)} · YouTube Analytics`}>
        <div className="kpi">
          <div className="value">{money.format(revenue.estimatedRevenue)}</div>
        </div>
      </Card>
    );
  }
  return (
    <Card title="Receita" icon={Wallet}>
      <Empty icon={Wallet} title={revenue.status === "not_connected" ? "Receita ainda não conectada" : "Canal ainda não monetizado"}>
        {revenue.message} Nenhum valor estimado é mostrado aqui: só números reais da API de Analytics.
      </Empty>
    </Card>
  );
}

function MonetizationCard({ data }: { data: OverviewData }) {
  const { subscribers, shortsViews } = data.monetization;
  const subRatio = subscribers.current == null ? null : Math.min(1, subscribers.current / subscribers.target);
  const viewsRatio = shortsViews.trackedViews == null ? null : Math.min(1, shortsViews.trackedViews / shortsViews.target);
  return (
    <Card title="Requisitos de monetização" icon={Target} sub="Programa de Parcerias do YouTube (via Shorts)">
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.88rem" }}>
        <span>Inscritos</span>
        <b>
          {fmtInt(subscribers.current)} / {fmtInt(subscribers.target)}
        </b>
      </div>
      <div className="meter" style={{ "--tone": "var(--brand-1)" } as React.CSSProperties}>
        <div style={{ width: `${(subRatio ?? 0) * 100}%` }} />
      </div>
      {subRatio == null && <p className="hint">Defina YOUTUBE_CHANNEL_ID no .env para acompanhar os inscritos.</p>}
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.88rem", marginTop: 14 }}>
        <span>Views de Shorts ({shortsViews.windowDays} dias)</span>
        <b>
          {fmtCompact(shortsViews.trackedViews)} / {fmtCompact(shortsViews.target)}
        </b>
      </div>
      <div className="meter" style={{ "--tone": "var(--brand-2)" } as React.CSSProperties}>
        <div style={{ width: `${(viewsRatio ?? 0) * 100}%` }} />
      </div>
      <p className="hint">{shortsViews.note}</p>
    </Card>
  );
}

function ProductionChart({ data }: { data: OverviewData }) {
  const rows = data.generatedPerDay;
  if (!rows.some((d) => d.gerados + d.falhas > 0)) {
    return (
      <Card title="Produção diária" icon={ChartColumn}>
        <Empty icon={Clapperboard} title="Nenhuma execução nos últimos 14 dias">
          Rode o pipeline e os vídeos aparecem aqui por dia.
        </Empty>
      </Card>
    );
  }
  return (
    <ChartCard
      title="Produção diária"
      icon={ChartColumn}
      sub="Vídeos renderizados e execuções com falha, últimos 14 dias"
      table={{ head: ["Dia", "Gerados", "Falhas"], rows: rows.map((r) => [fmtDay(r.day), r.gerados, r.falhas]) }}
    >
      <div className="chart">
        <ResponsiveContainer>
          <BarChart data={rows} barGap={2} margin={{ top: 8, right: 4, left: -18, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis dataKey="day" tickFormatter={fmtDay} {...axisProps} interval="preserveStartEnd" minTickGap={16} />
            <YAxis allowDecimals={false} {...axisProps} />
            <Tooltip labelFormatter={(d) => fmtDay(String(d))} {...tooltipProps} />
            <Bar dataKey="gerados" name="Gerados" fill="var(--good)" radius={[4, 4, 0, 0]} maxBarSize={18} />
            <Bar dataKey="falhas" name="Falhas" fill="var(--critical)" radius={[4, 4, 0, 0]} maxBarSize={18} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <Legend items={[{ label: "Gerados", color: "var(--good)" }, { label: "Falhas", color: "var(--critical)" }]} />
    </ChartCard>
  );
}

function TopicsDonut({ runs, data }: { runs: RunSummary[]; data: OverviewData }) {
  const counts = countBy(runs, (r) => r.topic?.categoryId);
  const shares = data.categories
    .map((c) => ({ name: c.label, value: counts.get(c.id) ?? 0, color: categoryColor(c.id, data.categories) }))
    .filter((s) => s.value > 0);
  return (
    <Card title="Temas produzidos" icon={Layers} sub="Roteiros gerados por categoria">
      {shares.length ? (
        <Donut data={shares} centerLabel="roteiros" />
      ) : (
        <Empty icon={Layers} title="Nenhum roteiro ainda">
          As categorias aparecem quando o pipeline escolher o primeiro tema.
        </Empty>
      )}
    </Card>
  );
}

function BreakpointsChart({ runs }: { runs: RunSummary[] }) {
  const rows = failuresByStage(runs).map((r) => ({ ...r, label: `${stageCode(r.stage)} ${STAGE_LABEL[r.stage]}` }));
  const total = rows.reduce((a, b) => a + b.falhas, 0);
  return (
    <ChartCard
      title="Onde o pipeline quebra"
      icon={TriangleAlert}
      sub={total ? `${total} falha(s) por etapa` : "Falhas e interrupções por etapa"}
      table={{ head: ["Etapa", "Falhas"], rows: rows.map((r) => [r.label, r.falhas]) }}
    >
      {total === 0 ? (
        <Empty icon={Activity} title="Nenhuma falha registrada">
          Ótimo sinal: todas as execuções terminaram ou pararam de propósito.
        </Empty>
      ) : (
        <div className="chart">
          <ResponsiveContainer>
            <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 24, left: 8, bottom: 0 }}>
              <CartesianGrid horizontal={false} stroke="var(--grid)" />
              <XAxis type="number" allowDecimals={false} {...axisProps} />
              <YAxis type="category" dataKey="label" width={128} {...axisProps} />
              <Tooltip {...tooltipProps} />
              <Bar dataKey="falhas" name="Falhas" fill="var(--critical)" radius={[0, 4, 4, 0]} maxBarSize={16}>
                {rows.map((r) => (
                  <Cell key={r.stage} fill={r.falhas ? "var(--critical)" : "var(--surface-3)"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </ChartCard>
  );
}

function HealthCard({ data, runs }: { data: OverviewData; runs: RunSummary[] }) {
  const { health, youtube } = data;
  const recent = runs.slice(0, 12);
  return (
    <Card title="Saúde do pipeline" icon={Activity} sub="Últimas execuções, da mais recente para a mais antiga">
      <div className="run-strip">
        {recent.map((r) => (
          <a key={r.runId} href="#execucoes" title={`${r.runId} · ${r.title ?? ""}`}>
            <StatusBadge status={r.status} />
          </a>
        ))}
      </div>
      <div className="facts" style={{ marginTop: 12 }}>
        <span className="fact">
          Última execução: <b>{fmtAgo(health.lastRun?.at)}</b>
          {health.lastRun && <StatusBadge status={health.lastRun.status} />}
        </span>
        <span className="fact">
          Último sucesso: <b>{fmtDateTime(health.lastSuccessAt)}</b>
        </span>
        <span className="fact">
          Render médio: <b>{fmtDuration(health.avgRenderMs)}</b>
        </span>
        <span className="fact">
          YouTube: <b>{youtube.lastFetchAt ? `coletado ${fmtAgo(youtube.lastFetchAt)}` : "nunca coletado"}</b>
        </span>
        {youtube.lastError && <span className="fact" style={{ color: "var(--critical-text)" }}>Erro: {youtube.lastError}</span>}
      </div>
    </Card>
  );
}

export function Overview({ data, runs, videos }: { data: OverviewData; runs: RunSummary[]; videos: VideoRow[] }) {
  const { kpis, youtube } = data;
  const [playing, setPlaying] = useState<PlayableVideo | null>(null);
  const generated = data.generatedPerDay.map((d) => d.gerados);
  const failures = data.generatedPerDay.map((d) => d.falhas);
  const genWeek = weekOverWeek(generated);
  const failWeek = weekOverWeek(failures);
  const latest = videos.filter((v) => v.localUrl).slice(0, 10).map(toPlayable);
  const views7 = kpis.viewsLast7d;
  const revenueLabel = { ok: "Conectada", not_connected: "Não conectada", not_monetized: "Sem monetização" }[data.revenue.status];

  return (
    <>
      <div className="grid kpis">
        <Kpi
          label="Vídeos gerados"
          icon={Clapperboard}
          tone="var(--cat-1)"
          value={fmtInt(kpis.videosGenerated)}
          delta={<Delta current={genWeek.current} previous={genWeek.previous} />}
          sub="7 dias"
          spark={generated}
        />
        <Kpi
          label="Publicados"
          icon={Upload}
          tone="var(--cat-7)"
          value={fmtInt(kpis.videosPublished)}
          sub={data.history.exists ? "no YouTube" : "upload ainda não ativado"}
        />
        <Kpi
          label="Taxa de sucesso"
          icon={Gauge}
          tone={kpis.successRate == null || kpis.successRate >= 0.8 ? "var(--good)" : kpis.successRate >= 0.5 ? "var(--warning)" : "var(--critical)"}
          value={fmtPercent(kpis.successRate)}
          meter={kpis.successRate}
          sub={`${kpis.finishedRuns} execuções finalizadas`}
        />
        <Kpi
          label="Falhas (7 dias)"
          icon={TriangleAlert}
          tone="var(--critical)"
          value={fmtInt(kpis.failuresLast7d)}
          delta={<Delta current={failWeek.current} previous={failWeek.previous} upIsGood={false} />}
          spark={failures}
        />
        <Kpi
          label="Views totais"
          icon={Eye}
          tone="var(--cat-3)"
          value={<span title={fmtInt(kpis.totalViews)}>{fmtCompact(kpis.totalViews)}</span>}
          sub={kpis.totalViews == null ? "aguardando 1º upload" : "vídeos da máquina"}
          spark={data.viewsPerDay.map((d) => d.views)}
        />
        <Kpi
          label="Views (7 dias)"
          icon={TrendingUp}
          tone="var(--cat-2)"
          value={views7 ? <span title={fmtInt(views7.value)}>{fmtCompact(views7.value)}</span> : "—"}
          sub={views7 ? (views7.partial ? `parcial, desde ${fmtDateTime(views7.since)}` : "últimos 7 dias") : "precisa de 2+ coletas"}
        />
        <Kpi
          label="Inscritos"
          icon={Users}
          tone="var(--cat-5)"
          value={<span title={fmtInt(kpis.subscribers)}>{fmtCompact(kpis.subscribers)}</span>}
          sub={youtube.channelConfigured ? youtube.channel?.title ?? "canal" : "YOUTUBE_CHANNEL_ID vazio"}
          spark={data.subscribersOverTime.map((s) => s.subscribers)}
        />
        <Kpi
          label="Status da receita"
          icon={Wallet}
          tone="var(--warning)"
          small
          value={revenueLabel}
          sub={data.revenue.status === "not_connected" ? "OAuth pendente (Marco 2)" : "veja o card Receita"}
        />
      </div>

      <Card
        title="Últimos vídeos"
        icon={Film}
        sub={latest.length ? "Clique para assistir o final.mp4 local" : undefined}
        className="gallery-card"
      >
        {latest.length ? (
          <div className="gallery">
            {latest.map((v) => (
              <VideoCard key={v.key} video={v} categories={data.categories} onOpen={() => setPlaying(v)} />
            ))}
          </div>
        ) : (
          <Empty icon={Film} title="Nenhum vídeo renderizado ainda">
            Assim que o pipeline concluir o primeiro render, ele aparece aqui com miniatura.
          </Empty>
        )}
      </Card>
      <div style={{ height: 14 }} />

      <div className="grid cols-2">
        <ProductionChart data={data} />
        <TopicsDonut runs={runs} data={data} />
      </div>
      <div className="grid cols-2">
        <BreakpointsChart runs={runs} />
        <HealthCard data={data} runs={runs} />
      </div>

      <div className="section-title">
        <Eye size={14} /> Audiência no YouTube
      </div>
      <div className="grid cols-2">
        <ChartCard
          title="Views por dia"
          icon={TrendingUp}
          sub="Soma dos vídeos publicados pela máquina"
          table={data.viewsPerDay.length ? { head: ["Dia", "Views"], rows: data.viewsPerDay.map((d) => [fmtDay(d.day), d.views]) } : undefined}
        >
          {data.viewsPerDay.length > 0 ? (
            <div className="chart">
              <ResponsiveContainer>
                <BarChart data={data.viewsPerDay} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--grid)" />
                  <XAxis dataKey="day" tickFormatter={fmtDay} {...axisProps} />
                  <YAxis allowDecimals={false} tickFormatter={(v: number) => fmtCompact(v)} {...axisProps} />
                  <Tooltip labelFormatter={(d) => fmtDay(String(d))} formatter={(v) => fmtInt(Number(v))} {...tooltipProps} />
                  <Bar dataKey="views" name="Views" fill="var(--cat-1)" radius={[4, 4, 0, 0]} maxBarSize={24} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <Empty icon={Eye} title="Sem views para mostrar ainda">
              {kpis.videosPublished === 0
                ? "O gráfico aparece após o primeiro upload e duas coletas em dias diferentes."
                : "Aguardando coletas em pelo menos dois dias diferentes."}
            </Empty>
          )}
        </ChartCard>
        <ChartCard
          title="Inscritos ao longo do tempo"
          icon={Users}
          table={
            data.subscribersOverTime.length
              ? { head: ["Coleta", "Inscritos"], rows: data.subscribersOverTime.map((s) => [fmtDateTime(s.at), s.subscribers]) }
              : undefined
          }
        >
          {data.subscribersOverTime.length > 1 ? (
            <div className="chart">
              <ResponsiveContainer>
                <LineChart data={data.subscribersOverTime} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--grid)" />
                  <XAxis dataKey="at" tickFormatter={(v: string) => fmtDateTime(v).slice(0, 5)} {...axisProps} />
                  <YAxis allowDecimals={false} domain={["auto", "auto"]} width={72} tickFormatter={(v: number) => fmtInt(v)} {...axisProps} />
                  <Tooltip labelFormatter={(v) => fmtDateTime(String(v))} formatter={(v) => fmtInt(Number(v))} {...tooltipProps} />
                  <Line dataKey="subscribers" name="Inscritos" stroke="var(--cat-5)" strokeWidth={2} dot={false} activeDot={{ r: 5, stroke: "var(--surface)", strokeWidth: 2 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <Empty icon={Users} title="Ainda sem histórico de inscritos">
              {youtube.channelConfigured
                ? "Aguardando pelo menos duas coletas do canal (a cada 30 min)."
                : "Defina YOUTUBE_CHANNEL_ID no .env para acompanhar os inscritos."}
            </Empty>
          )}
        </ChartCard>
      </div>

      <div className="section-title">
        <Wallet size={14} /> Dinheiro
      </div>
      <div className="grid cols-2">
        <RevenueCard data={data} />
        <MonetizationCard data={data} />
      </div>

      {playing && <PlayerModal video={playing} categories={data.categories} onClose={() => setPlaying(null)} />}
    </>
  );
}
