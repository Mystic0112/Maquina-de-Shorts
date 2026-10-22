import { Bot, Coins, FileText, FileVideo, Images, Mic, Scale, Shapes, ShieldCheck, Sparkles, Type } from "lucide-react";
import type { CSSProperties } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Overview, RunSummary } from "../../shared/api";
import { estimateLlmCost } from "../../shared/llmCost";
import { scoreColor, sourceColor } from "../colors";
import { axisProps, CategoryChip, Card, ChartCard, Donut, Empty, FormatBadge, formatIcon, HBars, Kpi, Legend, OverlayTextTag, tooltipProps } from "../components";
import { chronological, relevanceHistogram, runLabel, sceneScores, sumCounts } from "../derive";
import { fmtCompact, fmtDateTime, fmtDecimal, fmtInt, fmtUsd, SCRIPT_FORMATS } from "../format";

function NarrationChart({ runs, target }: { runs: RunSummary[]; target: Overview["targetSeconds"] }) {
  const rows = chronological(runs)
    .filter((r) => r.narrationMs != null)
    .map((r) => {
      const seconds = Math.round(r.narrationMs! / 100) / 10;
      const inBand = !target || (seconds >= target.min && seconds <= target.max);
      return { run: runLabel(r), seconds, inBand, title: r.title ?? r.runId };
    });
  const outside = rows.filter((r) => !r.inBand).length;
  return (
    <ChartCard
      title="Narração vs alvo"
      icon={Mic}
      sub={target ? `Faixa alvo ${target.min}–${target.max} s · ${outside ? `${outside} fora da faixa` : "todas dentro da faixa"}` : "Duração da narração"}
      table={{ head: ["Execução", "Narração (s)", "Na faixa"], rows: rows.map((r) => [r.run, String(r.seconds).replace(".", ","), r.inBand ? "sim" : "não"]) }}
    >
      {rows.length ? (
        <>
          <div className="chart">
            <ResponsiveContainer>
              <BarChart data={rows} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--grid)" />
                {target && <ReferenceArea y1={target.min} y2={target.max} fill="var(--good)" fillOpacity={0.1} stroke="none" />}
                {target && <ReferenceLine y={target.min} stroke="var(--good)" strokeOpacity={0.6} />}
                {target && <ReferenceLine y={target.max} stroke="var(--good)" strokeOpacity={0.6} />}
                <XAxis dataKey="run" {...axisProps} interval="preserveStartEnd" minTickGap={8} />
                <YAxis unit=" s" domain={[0, (max: number) => Math.max(max, (target?.max ?? 0) + 10)]} {...axisProps} />
                <Tooltip formatter={(v) => [`${String(v).replace(".", ",")} s`, "Narração"]} {...tooltipProps} />
                <Bar dataKey="seconds" radius={[4, 4, 0, 0]} maxBarSize={24}>
                  {rows.map((r) => (
                    <Cell key={r.run} fill={r.inBand ? "var(--cat-1)" : "var(--serious)"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <Legend
            items={[
              { label: "Dentro da faixa", color: "var(--cat-1)" },
              { label: "Fora da faixa", color: "var(--serious)" },
              { label: "Faixa alvo", color: "color-mix(in srgb, var(--good) 35%, transparent)" },
            ]}
          />
        </>
      ) : (
        <Empty icon={Mic} title="Nenhuma narração gerada ainda" />
      )}
    </ChartCard>
  );
}

function FileSizeChart({ runs }: { runs: RunSummary[] }) {
  const rows = chronological(runs)
    .filter((r) => r.video?.sizeBytes != null)
    .map((r) => ({ run: runLabel(r), mb: Math.round((r.video!.sizeBytes! / 1_048_576) * 10) / 10 }));
  return (
    <ChartCard
      title="Tamanho do arquivo"
      icon={FileVideo}
      sub="final.mp4 por vídeo (MB)"
      table={{ head: ["Execução", "MB"], rows: rows.map((r) => [r.run, String(r.mb).replace(".", ",")]) }}
    >
      {rows.length ? (
        <div className="chart">
          <ResponsiveContainer>
            <BarChart data={rows} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="run" {...axisProps} interval="preserveStartEnd" minTickGap={8} />
              <YAxis unit=" MB" {...axisProps} />
              <Tooltip formatter={(v) => [`${String(v).replace(".", ",")} MB`, "Tamanho"]} {...tooltipProps} />
              <Bar dataKey="mb" fill="var(--cat-3)" radius={[4, 4, 0, 0]} maxBarSize={24} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <Empty icon={FileVideo} title="Nenhum final.mp4 no disco" />
      )}
    </ChartCard>
  );
}

function FootageCards({ runs }: { runs: RunSummary[] }) {
  const sources = [...sumCounts(runs, (r) => r.sources)].sort((a, b) => b[1] - a[1]);
  const licenses = [...sumCounts(runs, (r) => r.licenses)].sort((a, b) => b[1] - a[1]);
  // <= 4 named slices; the tail folds into "Outras" so the donut stays readable.
  const named = sources.slice(0, 4).map(([name, value]) => ({ name, value, color: sourceColor(name) }));
  const tail = sources.slice(4).reduce((a, [, n]) => a + n, 0);
  const slices = tail ? [...named, { name: "Outras", value: tail, color: "var(--other)" }] : named;
  return (
    <>
      <Card title="Fontes de footage" icon={Images} sub="Clipes usados, somando todas as execuções">
        {slices.length ? (
          <Donut data={slices} centerLabel="clipes" />
        ) : (
          <Empty icon={Images} title="Nenhum clipe baixado ainda" />
        )}
      </Card>
      <Card title="Licenças" icon={Scale} sub="Todas as licenças passaram pelo filtro PD/CC0/CC BY">
        {licenses.length ? (
          <HBars color="var(--cat-7)" data={licenses.map(([name, value]) => ({ name, value }))} />
        ) : (
          <Empty icon={Scale} title="Sem licenças para mostrar" />
        )}
      </Card>
    </>
  );
}

function RelevanceCards({ runs }: { runs: RunSummary[] }) {
  const histogram = relevanceHistogram(runs);
  const scored = histogram.reduce((a, b) => a + b.clipes, 0);
  const minScore = runs.find((r) => r.quality)?.quality?.minScore;
  const strips = runs.filter((r) => r.clips.some((c) => c.relevanceScore != null)).slice(0, 12);
  return (
    <>
      <ChartCard
        title="Distribuição de relevância"
        icon={Sparkles}
        sub={
          scored
            ? `${scored} clipes avaliados pelo filtro visual (0–10)${minScore != null ? ` · nota mínima ${fmtDecimal(minScore)}` : ""}`
            : "Notas do filtro visual de relevância"
        }
        table={{ head: ["Nota", "Clipes"], rows: histogram.map((h) => [h.score, h.clipes]) }}
      >
        {scored ? (
          <div className="chart short">
            <ResponsiveContainer>
              <BarChart data={histogram} margin={{ top: 8, right: 8, left: -18, bottom: 0 }} barCategoryGap={2}>
                <CartesianGrid vertical={false} stroke="var(--grid)" />
                <XAxis dataKey="score" {...axisProps} />
                <YAxis allowDecimals={false} {...axisProps} />
                {minScore != null && <ReferenceLine x={String(Math.round(minScore))} stroke="var(--warning)" strokeWidth={2} />}
                <Tooltip labelFormatter={(s) => `Nota ${s}`} {...tooltipProps} />
                <Bar dataKey="clipes" name="Clipes" fill="var(--cat-1)" radius={[4, 4, 0, 0]} maxBarSize={24} />
              </BarChart>
            </ResponsiveContainer>
            {minScore != null && <Legend items={[{ label: "Clipes por nota", color: "var(--cat-1)" }, { label: "Nota mínima do portão", color: "var(--warning)" }]} />}
          </div>
        ) : (
          <Empty icon={Sparkles} title="Nenhuma nota de relevância ainda">
            Aparece quando o filtro visual da etapa 03 estiver ativo.
          </Empty>
        )}
      </ChartCard>
      <Card title="Relevância por cena" icon={Sparkles} sub="Melhor nota de cada cena, por vídeo">
        {strips.length ? (
          <>
            <div className="heat">
              {strips.map((run) => (
                <div className="heat-row" key={run.runId}>
                  <span className="hl" title={run.title ?? run.runId}>
                    {run.title ?? run.runId}
                  </span>
                  <div className="heat-cells">
                    {sceneScores(run).map((score, i) => {
                      const c = score == null ? null : scoreColor(score);
                      return (
                        <div
                          key={i}
                          title={`Cena ${i + 1}: ${score ?? "sem nota"}`}
                          style={c ? { background: c.bg, color: c.ink } : ({ background: "var(--surface-2)", color: "var(--muted)" } as CSSProperties)}
                        >
                          {score == null ? "–" : fmtDecimal(score)}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            <div className="heat-scale">
              0 <div /> 10
            </div>
          </>
        ) : (
          <Empty icon={Sparkles} title="Sem notas por cena ainda" />
        )}
      </Card>
    </>
  );
}

function LlmCards({ runs, pricing }: { runs: RunSummary[]; pricing: Overview["llmPricing"] }) {
  const withUsage = chronological(runs).filter((r) => r.llmUsage);
  if (!withUsage.length) {
    return (
      <Card title="Uso de LLM (Gemini)" icon={Bot} className="span-2">
        <Empty icon={Bot} title="Ainda sem dados de uso de LLM">
          Os tokens e chamadas aparecem quando o pipeline gravar <code>llmUsage</code> no context.json.
        </Empty>
      </Card>
    );
  }
  const totals = withUsage.reduce(
    (acc, r) => ({
      calls: acc.calls + r.llmUsage!.calls,
      grounded: acc.grounded + (r.llmUsage!.groundedCalls ?? 0),
      input: acc.input + r.llmUsage!.inputTokens,
      output: acc.output + r.llmUsage!.outputTokens,
    }),
    { calls: 0, grounded: 0, input: 0, output: 0 },
  );
  const estimate = withUsage.reduce(
    (acc, r) => {
      const e = estimateLlmCost(r.llmUsage!, pricing);
      return { usd: acc.usd + e.usd, planCalls: acc.planCalls + e.planCalls, paidCalls: acc.paidCalls + e.paidCalls };
    },
    { usd: 0, planCalls: 0, paidCalls: 0 },
  );
  const total = estimate.usd;
  const planOnly = estimate.paidCalls === 0;
  const rows = withUsage.map((r) => ({ run: runLabel(r), entrada: r.llmUsage!.inputTokens, saida: r.llmUsage!.outputTokens }));
  const models = [...new Set(withUsage.flatMap((r) => r.llmUsage!.byModel.map((m) => m.model)))];
  return (
    <>
      <ChartCard
        title="Tokens de LLM por execução"
        icon={Bot}
        sub={`${fmtInt(totals.calls)} chamada(s) · ${models.join(", ") || "modelo não informado"}`}
        table={{ head: ["Execução", "Entrada", "Saída"], rows: rows.map((r) => [r.run, r.entrada, r.saida]) }}
      >
        <div className="chart short">
          <ResponsiveContainer>
            <BarChart data={rows} margin={{ top: 8, right: 8, left: -6, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="run" {...axisProps} interval="preserveStartEnd" minTickGap={8} />
              <YAxis tickFormatter={(v: number) => fmtCompact(v)} {...axisProps} />
              <Tooltip formatter={(v) => fmtInt(Number(v))} {...tooltipProps} />
              <Bar dataKey="entrada" name="Entrada" stackId="t" fill="var(--cat-1)" stroke="var(--surface)" strokeWidth={1} maxBarSize={24} />
              <Bar dataKey="saida" name="Saída (inclui raciocínio)" stackId="t" fill="var(--cat-2)" stroke="var(--surface)" strokeWidth={1} radius={[4, 4, 0, 0]} maxBarSize={24} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <Legend items={[{ label: "Entrada", color: "var(--cat-1)" }, { label: "Saída (inclui raciocínio)", color: "var(--cat-2)" }]} />
      </ChartCard>
      <Kpi
        label="Custo de LLM (estimativa)"
        icon={Coins}
        tone="var(--cat-4)"
        value={planOnly ? "plano (sem custo de API)" : fmtUsd(total)}
        sub={
          <>
            {planOnly
              ? `Todas as ${fmtInt(estimate.planCalls)} chamada(s) foram pelo Antigravity CLI, que gasta os créditos do plano, não a API`
              : `${fmtUsd(total / withUsage.length)} por execução`}
            {estimate.planCalls > 0 && !planOnly && ` · ${fmtInt(estimate.planCalls)} chamada(s) pelo Antigravity CLI: plano (sem custo de API), fora da conta`}
            {" "}· {fmtCompact(totals.input)} tokens de entrada e {fmtCompact(totals.output)} de saída.
            {!planOnly && (
              <>
                {totals.grounded > 0 && ` ${fmtInt(totals.grounded)} chamada(s) com busca do Google (checagem de fatos) são cobradas por requisição e não entram nesta conta.`}
                <br />
                ESTIMATIVA com preço de referência de {fmtUsd(pricing.inputUsdPerMTok)}/M tokens de entrada e {fmtUsd(pricing.outputUsdPerMTok)}/M de saída
                {pricing.configured ? " (configurado no .env)" : " (padrão; ajuste DASHBOARD_LLM_PRICE_* no .env)"}. Não é a fatura do Google.
              </>
            )}
          </>
        }
      />
    </>
  );
}


const FACT_SLICES = [
  { key: "pass", name: "Aprovados sem mudança", color: "var(--good)" },
  { key: "corrected", name: "Corrigidos", color: "var(--cat-1)" },
  { key: "fail", name: "Reprovados", color: "var(--critical)" },
  { key: "skipped", name: "Checagem desligada", color: "var(--other)" },
] as const;

function FactCheckCard({ runs }: { runs: RunSummary[] }) {
  const checked = runs.filter((r) => r.factCheck);
  if (!checked.length) {
    return (
      <Card title="Checagem de fatos" icon={ShieldCheck}>
        <Empty icon={ShieldCheck} title="Nenhum roteiro checado ainda">
          A etapa 02b confere cada afirmação do roteiro com busca no Google antes de gastar com footage e voz.
        </Empty>
      </Card>
    );
  }
  const slices = FACT_SLICES.map((f) => ({ name: f.name, color: f.color, value: checked.filter((r) => r.factCheck!.verdict === f.key).length })).filter(
    (x) => x.value > 0,
  );
  const claims = checked.reduce((a, r) => a + r.factCheck!.claimsChecked, 0);
  const corrections = checked.reduce((a, r) => a + r.factCheck!.corrections.length, 0);
  const rejections = runs.filter((r) => r.rejection?.stage === "02b-factCheck" || r.factCheck?.verdict === "fail").length;
  return (
    <Card title="Checagem de fatos" icon={ShieldCheck} sub="Veredito da etapa 02b por roteiro">
      <Donut data={slices} centerLabel="roteiros" />
      <div className="facts" style={{ marginTop: 12 }}>
        <span className="fact">
          Afirmações checadas <b>{fmtInt(claims)}</b>
        </span>
        <span className="fact">
          Correções aplicadas <b>{fmtInt(corrections)}</b>
        </span>
        <span className="fact">
          Rejeições (novo tema) <b>{fmtInt(rejections)}</b>
        </span>
      </div>
    </Card>
  );
}

function QualityCard({ runs }: { runs: RunSummary[] }) {
  const gated = runs.filter((r) => r.quality);
  if (!gated.length) {
    return (
      <Card title="Portão de qualidade" icon={ShieldCheck} className="span-2">
        <Empty icon={ShieldCheck} title="Nenhuma execução avaliada ainda">
          O painel aparece quando a etapa 03 gravar <code>quality</code> (cenas aprovadas, tentativas, veredito).
        </Empty>
      </Card>
    );
  }
  const verdicts = [
    { name: "Aprovadas", value: gated.filter((r) => r.quality!.verdict === "pass").length, color: "var(--good)" },
    { name: "Reprovadas", value: gated.filter((r) => r.quality!.verdict === "fail").length, color: "var(--critical)" },
    { name: "Sem gate", value: gated.filter((r) => r.quality!.verdict === "skipped").length, color: "var(--other)" },
  ].filter((v) => v.value > 0);
  const attempts = [...new Set(gated.map((r) => r.quality!.attempt ?? 1))].sort((a, b) => a - b);
  const ratios = chronological(gated).map((r) => ({
    run: runLabel(r),
    pct: Math.round(r.quality!.passingRatio * 100),
    min: Math.round(r.quality!.minPassingSceneRatio * 100),
    pass: r.quality!.verdict !== "fail",
  }));
  const threshold = ratios[ratios.length - 1]?.min;
  return (
    <>
      <Card title="Portão de qualidade" icon={ShieldCheck} sub="Veredito do filtro de footage por execução">
        <Donut data={verdicts} centerLabel="avaliadas" />
        <div style={{ marginTop: 12 }}>
          <HBars
            color="var(--cat-7)"
            data={attempts.map((a) => ({ name: `${a}ª tentativa`, value: gated.filter((r) => (r.quality!.attempt ?? 1) === a).length }))}
          />
        </div>
      </Card>
      <ChartCard
        title="Cenas aprovadas"
        icon={ShieldCheck}
        sub={threshold != null ? `% de cenas com clipe relevante · mínimo ${threshold}%` : "% de cenas com clipe relevante"}
        table={{ head: ["Execução", "% aprovadas", "Mínimo"], rows: ratios.map((r) => [r.run, `${r.pct}%`, `${r.min}%`]) }}
      >
        <div className="chart short">
          <ResponsiveContainer>
            <BarChart data={ratios} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="run" {...axisProps} interval="preserveStartEnd" minTickGap={8} />
              <YAxis unit="%" domain={[0, 100]} {...axisProps} />
              {threshold != null && <ReferenceLine y={threshold} stroke="var(--warning)" />}
              <Tooltip formatter={(v) => [`${v}%`, "Cenas aprovadas"]} {...tooltipProps} />
              <Bar dataKey="pct" radius={[4, 4, 0, 0]} maxBarSize={24}>
                {ratios.map((r) => (
                  <Cell key={r.run} fill={r.pass ? "var(--good)" : "var(--critical)"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <Legend
          items={[
            { label: "Aprovada", color: "var(--good)" },
            { label: "Reprovada", color: "var(--critical)" },
            { label: "Mínimo exigido", color: "var(--warning)" },
          ]}
        />
      </ChartCard>
    </>
  );
}

/** Scripts that got past 02-generateScript (rejected ones included: the format was still drawn). */
const scripted = (runs: RunSummary[]): RunSummary[] => runs.filter((r) => r.title || r.topic?.format);

function FormatsCard({ runs }: { runs: RunSummary[] }) {
  const withFormat = scripted(runs).filter((r) => r.topic?.format);
  const legacy = scripted(runs).length - withFormat.length;
  const known = new Set<string>(SCRIPT_FORMATS.map((f) => f.id));
  const extra = [...new Set(withFormat.map((r) => r.topic!.format!).filter((f) => !known.has(f)))];
  const rows = [...SCRIPT_FORMATS.map((f) => ({ id: f.id as string, name: f.label })), ...extra.map((id) => ({ id, name: id }))].map((f) => ({
    name: f.name,
    value: withFormat.filter((r) => r.topic!.format === f.id).length,
  }));
  const unused = rows.filter((r) => r.value === 0).length;
  return (
    <Card
      title="Formatos usados"
      icon={Shapes}
      sub={
        withFormat.length
          ? `${fmtInt(withFormat.length)} roteiro(s) · ${unused ? `${unused} formato(s) ainda não sorteado(s)` : "todos os formatos já apareceram"}`
          : "Formato narrativo sorteado na etapa 01"
      }
    >
      {withFormat.length ? (
        <>
          <HBars color="var(--brand-1)" data={rows} />
          {legacy > 0 && <p className="hint">{fmtInt(legacy)} roteiro(s) anteriores aos formatos não entram na conta.</p>}
        </>
      ) : (
        <Empty icon={Shapes} title="Nenhum roteiro com formato ainda">
          Os próximos vídeos alternam entre Mito × verdade, Lista, E se…, Comparação, Linha do tempo e Pergunta e resposta.
        </Empty>
      )}
    </Card>
  );
}

function HooksCard({ runs, categories }: { runs: RunSummary[]; categories: Overview["categories"] }) {
  const recent = scripted(runs).slice(0, 6);
  return (
    <Card title="Roteiros recentes" icon={FileText} sub="Título, formato e texto de capa de cada roteiro">
      {recent.length ? (
        <div className="script-list">
          {recent.map((r) => {
            const Icon = r.topic?.format ? formatIcon(r.topic.format) : FileText;
            return (
              <div className="script-row" key={r.runId}>
                <span className="script-icon">
                  <Icon size={15} />
                </span>
                <div className="script-body">
                  <b title={r.title ?? undefined}>{r.title ?? "(sem título)"}</b>
                  <div className="script-tags">
                    <CategoryChip id={r.topic?.categoryId} label={r.topic?.categoryLabel} categories={categories} />
                    <FormatBadge format={r.topic?.format} />
                    {r.overlayText ? (
                      <OverlayTextTag text={r.overlayText} />
                    ) : (
                      <span className="muted script-none">
                        <Type size={12} /> sem texto de capa
                      </span>
                    )}
                    <span className="muted script-date">{fmtDateTime(r.createdAt)}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <Empty icon={FileText} title="Nenhum roteiro gerado ainda" />
      )}
    </Card>
  );
}

export function Content({ runs, overview }: { runs: RunSummary[]; overview: Overview }) {
  return (
    <>
      <div className="grid cols-2">
        <NarrationChart runs={runs} target={overview.targetSeconds} />
        <FileSizeChart runs={runs} />
      </div>
      <div className="section-title">
        <Shapes size={14} /> Roteiros e formatos
      </div>
      <div className="grid cols-2">
        <FormatsCard runs={runs} />
        <HooksCard runs={runs} categories={overview.categories} />
      </div>
      <div className="section-title">
        <Images size={14} /> Footage e relevância
      </div>
      <div className="grid cols-2">
        <FootageCards runs={runs} />
        <RelevanceCards runs={runs} />
      </div>
      <div className="section-title">
        <ShieldCheck size={14} /> Qualidade e custo
      </div>
      <div className="grid cols-2">
        <QualityCard runs={runs} />
        <FactCheckCard runs={runs} />
        <LlmCards runs={runs} pricing={overview.llmPricing} />
      </div>
    </>
  );
}
