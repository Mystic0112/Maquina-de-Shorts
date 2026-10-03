import { Clock, CircleX, Gauge, History, Hourglass, Layers, Timer, Workflow } from "lucide-react";
import type { CSSProperties } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { STAGE_NAMES, stageCode, type CategoryInfo, type Overview, type RunSummary } from "../../shared/api";
import { sourceColor, stageColor } from "../colors";
import { axisProps, CategoryChip, Card, ChartCard, Empty, HBars, Kpi, Legend, StatusBadge, tooltipProps } from "../components";
import { chronological, runLabel, stageDurations } from "../derive";
import { FactCheckPanel, MetadataPreview, RejectionBox, UploadBadge, UploadDetail } from "../runDetails";
import { fmtAgo, fmtBytes, fmtDateTime, fmtDuration, fmtInt, fmtPercent, STAGE_LABEL, STAGE_STATUS_LABEL } from "../format";

const STAGE_LEGEND = STAGE_NAMES.map((s) => ({ label: `${stageCode(s)} ${STAGE_LABEL[s]}`, color: stageColor(s) }));
const fmtMin = (minutes: number): string => fmtDuration(minutes * 60_000);
const fmtSec = (seconds: number): string => fmtDuration(seconds * 1000);

/**
 * Gantt-like view of one run: stages laid back-to-back on a shared time axis (latest attempt of each
 * stage). Packing by duration keeps resumed runs readable even when attempts were hours apart.
 */
function Gantt({ run }: { run: RunSummary }) {
  const spans = run.stages.map((s) => ({ ...s, ms: s.durationMs ?? 0 }));
  const total = spans.reduce((a, s) => a + s.ms, 0);
  let offset = 0;
  return (
    <div className="gantt" role="img" aria-label={`Linha do tempo das etapas de ${run.runId}`}>
      {spans.map((s) => {
        const open = s.status === "running" || s.status === "interrupted"; // no duration yet: a 3% stub
        const width = open ? 3 : total ? (s.ms / total) * 100 : 0;
        const left = Math.min(total ? (offset / total) * 100 : 0, 100 - width);
        offset += s.ms;
        const hasBar = s.status === "done" || s.status === "failed" || s.status === "bypassed" || open;
        const label =
          s.status === "bypassed"
            ? `${s.note ?? "pulado"}${s.durationMs != null ? ` · ${fmtDuration(s.durationMs)}` : ""}`
            : s.durationMs != null
              ? fmtDuration(s.durationMs)
              : STAGE_STATUS_LABEL[s.status];
        // Label placement: inside a wide bar, else after it, else (near the right edge) before it.
        const placement = !hasBar ? "after" : width > 22 && s.status !== "bypassed" ? "inside" : left + width < 80 ? "after" : "before";
        return (
          <div className="gantt-row" key={s.name}>
            <span className="gl" title={s.name}>
              <b>{stageCode(s.name)}</b>
              {STAGE_LABEL[s.name]}
            </span>
            <div className="gantt-track">
              {hasBar && (
                <div
                  className={`gantt-bar ${s.status}`}
                  style={{ left: `${left}%`, width: `${width}%`, "--bar": stageColor(s.name) } as CSSProperties}
                />
              )}
              <span
                className={`gantt-tag ${placement}`}
                style={
                  {
                    left: `${!hasBar ? 0 : placement === "before" ? left : left + width}%`,
                    "--ink": s.status === "failed" ? "#fff" : `var(--stage-ink-${STAGE_NAMES.indexOf(s.name) + 1})`,
                  } as CSSProperties
                }
              >
                {label}
                {s.status === "failed" && " · falhou"}
              </span>
            </div>
          </div>
        );
      })}
      {total > 0 && (
        <div className="gantt-axis">
          <span />
          <div>
            <span>0</span>
            <span>{fmtDuration(total / 2)}</span>
            <span>{fmtDuration(total)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function RunCard({ run, categories }: { run: RunSummary; categories: CategoryInfo[] }) {
  const [firstLine, ...rest] = (run.failure?.message ?? "").split("\n");
  const totalMs = run.stages.reduce((a, s) => a + (s.durationMs ?? 0), 0);
  return (
    <section className="card run">
      <div className="run-head">
        <StatusBadge status={run.status} />
        <span className="title">{run.title ?? (run.hasContext ? "(sem roteiro)" : "(pasta removida, só o log)")}</span>
        <CategoryChip id={run.topic?.categoryId} label={run.topic?.categoryLabel} categories={categories} />
        <span className="id mono">{run.runId}</span>
        <span className="id">{fmtDateTime(run.createdAt)}</span>
        <span className="total">
          <Clock size={13} style={{ verticalAlign: -2 }} /> {totalMs ? `${fmtDuration(totalMs)} em etapas` : "sem etapas concluídas"}
        </span>
      </div>

      <Gantt run={run} />

      {run.failure && (
        <div className="failure">
          <b>
            <CircleX size={14} color="var(--critical)" /> Falha em {run.failure.stage} ({STAGE_LABEL[run.failure.stage]})
          </b>{" "}
          · {fmtDateTime(run.failure.at)}
          <pre className="mono">{firstLine}</pre>
          {rest.length > 0 && (
            <details>
              <summary>detalhes do erro</summary>
              <pre className="mono">{rest.join("\n")}</pre>
            </details>
          )}
        </div>
      )}

      {run.rejection && <RejectionBox rejection={run.rejection} />}

      <div className="facts">
        <UploadBadge upload={run.upload} />
        <span className="fact">
          Cenas <b>{fmtInt(run.sceneCount)}</b>
        </span>
        <span className="fact">
          Narração <b>{fmtDuration(run.narrationMs)}</b>
        </span>
        <span className="fact">
          Vídeo <b>{run.video ? fmtDuration(run.video.durationSeconds * 1000) : "—"}</b>
          {run.video?.exists && <span className="muted">{fmtBytes(run.video.sizeBytes)}</span>}
          {run.video && !run.video.exists && <span className="muted">arquivo removido</span>}
        </span>
        <span className="fact">
          Render <b>{fmtDuration(run.renderTimeMs)}</b>
        </span>
        {run.avgRelevance != null && (
          <span className="fact">
            Relevância <b>{run.avgRelevance.toFixed(1).replace(".", ",")}/10</b>
          </span>
        )}
        {run.quality && (
          <span className="fact">
            Qualidade <b>{run.quality.verdict === "pass" ? "aprovada" : run.quality.verdict === "fail" ? "reprovada" : "sem gate"}</b>
            <span className="muted">
              {run.quality.passingScenes}/{run.quality.totalScenes} cenas
            </span>
          </span>
        )}
        {run.llmUsage && (
          <span className="fact">
            LLM <b>{fmtInt(run.llmUsage.calls)} chamada(s)</b>
            <span className="muted">{fmtInt(run.llmUsage.inputTokens + run.llmUsage.outputTokens)} tokens</span>
          </span>
        )}
        {!run.hasContext && <span className="fact">pasta render_output removida (dados do log)</span>}
      </div>

      {run.factCheck && <FactCheckPanel factCheck={run.factCheck} />}
      {run.metadata && <MetadataPreview metadata={run.metadata} />}
      {run.upload && (run.upload.status === "uploaded" || run.upload.reason) && <UploadDetail upload={run.upload} />}

      {run.clips.length > 0 && (
        <details>
          <summary>
            Footage: {run.clips.length} clipes · {Object.keys(run.sources).join(", ")}
          </summary>
          <div className="grid cols-2" style={{ marginTop: 10 }}>
            <HBars
              data={Object.entries(run.sources)
                .sort((a, b) => b[1] - a[1])
                .map(([name, value]) => ({ name, value, color: sourceColor(name) }))}
            />
            <HBars
              color="var(--cat-7)"
              data={Object.entries(run.licenses)
                .sort((a, b) => b[1] - a[1])
                .map(([name, value]) => ({ name, value }))}
            />
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="num">Cena</th>
                  <th>Fonte</th>
                  <th>Licença</th>
                  <th>Autor</th>
                  <th className="num">Relevância</th>
                </tr>
              </thead>
              <tbody>
                {run.clips.map((clip, i) => (
                  <tr key={i}>
                    <td className="num">{clip.sceneIndex + 1}</td>
                    <td>
                      <a href={clip.sourceUrl} target="_blank" rel="noreferrer">
                        {clip.source}
                      </a>
                    </td>
                    <td>{clip.license}</td>
                    <td>{clip.creator}</td>
                    <td className="num" title={clip.relevanceReason ?? undefined}>
                      {clip.relevanceScore ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}

export function Runs({ runs, overview }: { runs: RunSummary[]; overview: Overview }) {
  const { health, kpis } = overview;
  const stageRows = stageDurations(runs);
  const renderTrend = chronological(runs)
    .filter((r) => r.renderTimeMs != null)
    .map((r) => ({ run: runLabel(r), render: Math.round(r.renderTimeMs! / 1000) }));
  const completeTotals = runs
    .filter((r) => r.status === "complete")
    .map((r) => r.stages.reduce((a, s) => a + (s.durationMs ?? 0), 0))
    .filter((ms) => ms > 0);
  const avgTotal = completeTotals.length ? completeTotals.reduce((a, b) => a + b, 0) / completeTotals.length : null;

  return (
    <>
      <div className="grid kpis five">
        <Kpi label="Última execução" icon={History} tone="var(--cat-1)" value={fmtAgo(health.lastRun?.at)} small sub={health.lastRun?.runId} />
        <Kpi label="Último sucesso" icon={Clock} tone="var(--good)" value={fmtAgo(health.lastSuccessAt)} small sub={fmtDateTime(health.lastSuccessAt)} />
        <Kpi label="Render médio" icon={Timer} tone="var(--cat-7)" value={fmtDuration(health.avgRenderMs)} small sub="etapa 06" spark={renderTrend.map((r) => r.render)} />
        <Kpi label="Tempo médio por vídeo" icon={Hourglass} tone="var(--cat-3)" value={fmtDuration(avgTotal)} small sub="soma das etapas" />
        <Kpi
          label="Taxa de sucesso"
          icon={Gauge}
          tone={kpis.successRate == null || kpis.successRate >= 0.8 ? "var(--good)" : kpis.successRate >= 0.5 ? "var(--warning)" : "var(--critical)"}
          value={fmtPercent(kpis.successRate)}
          small
          meter={kpis.successRate}
          sub={`${kpis.failuresLast7d} falha(s) em 7 dias`}
        />
      </div>

      <div className="grid cols-2">
        <ChartCard
          title="Onde vai o tempo"
          icon={Layers}
          sub="Duração de cada etapa por execução (minutos)"
          table={{
            head: ["Execução", ...STAGE_NAMES.map((s) => STAGE_LABEL[s])],
            rows: stageRows.map((r) => [r.run, ...STAGE_NAMES.map((s) => (r[s] == null ? "—" : fmtMin(r[s]!)))]),
          }}
        >
          {stageRows.length ? (
            <>
              <div className="chart">
                <ResponsiveContainer>
                  <BarChart data={stageRows} margin={{ top: 8, right: 4, left: -8, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke="var(--grid)" />
                    <XAxis dataKey="run" {...axisProps} interval="preserveStartEnd" minTickGap={8} />
                    <YAxis allowDecimals={false} tickFormatter={(v: number) => `${v} min`} {...axisProps} />
                    <Tooltip formatter={(v, name) => [fmtMin(Number(v)), STAGE_LABEL[name as keyof typeof STAGE_LABEL] ?? name]} {...tooltipProps} />
                    {STAGE_NAMES.map((s, i) => (
                      <Bar
                        key={s}
                        dataKey={s}
                        stackId="t"
                        fill={stageColor(s)}
                        stroke="var(--surface)"
                        strokeWidth={1}
                        maxBarSize={24}
                        radius={i === STAGE_NAMES.length - 1 ? [4, 4, 0, 0] : 0}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <Legend items={STAGE_LEGEND} />
            </>
          ) : (
            <Empty icon={Layers} title="Sem durações registradas">
              As durações aparecem quando o pipeline registra as etapas no log.
            </Empty>
          )}
        </ChartCard>

        <ChartCard
          title="Tempo de render"
          icon={Timer}
          sub="Etapa 06 por execução (segundos)"
          table={{ head: ["Execução", "Render"], rows: renderTrend.map((r) => [r.run, fmtSec(r.render)]) }}
        >
          {renderTrend.length ? (
            <div className="chart">
              <ResponsiveContainer>
                <LineChart data={renderTrend} margin={{ top: 12, right: 12, left: -8, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--grid)" />
                  <XAxis dataKey="run" {...axisProps} interval="preserveStartEnd" minTickGap={8} />
                  <YAxis unit=" s" allowDecimals={false} domain={[0, "auto"]} {...axisProps} />
                  <Tooltip formatter={(v) => [fmtSec(Number(v)), "Render"]} {...tooltipProps} />
                  <Line
                    dataKey="render"
                    stroke="var(--cat-7)"
                    strokeWidth={2}
                    dot={{ r: 4, fill: "var(--cat-7)", stroke: "var(--surface)", strokeWidth: 2 }}
                    activeDot={{ r: 6, stroke: "var(--surface)", strokeWidth: 2 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <Empty icon={Timer} title="Nenhum render concluído ainda" />
          )}
        </ChartCard>
      </div>

      <div className="section-title">
        <Workflow size={14} /> Linha do tempo por execução
      </div>
      {runs.length === 0 ? (
        <Card>
          <Empty icon={Workflow} title="Nenhuma execução encontrada">
            Rode `npm run pipeline` na raiz do projeto.
          </Empty>
        </Card>
      ) : (
        runs.map((run) => <RunCard key={run.runId} run={run} categories={overview.categories} />)
      )}
    </>
  );
}
