import {
  ArrowDownRight,
  ArrowUpRight,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleX,
  Copy,
  ExternalLink,
  Film,
  LoaderCircle,
  Minus,
  Play,
  ShieldX,
  Table2,
  ChartColumn,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import type { CategoryInfo, RunStatus, UploadResult, VideoMetadata, VideoRow } from "../shared/api";
import { MetadataPreview, UploadBadge } from "./runDetails";
import { categoryColor } from "./colors";
import { fmtDateTime, fmtDuration, fmtInt, STATUS_LABEL } from "./format";

/* ---------- shared chart styling (Recharts) ---------- */
export const axisProps = {
  stroke: "var(--axis)",
  tick: { fill: "var(--muted)", fontSize: 12 },
  tickLine: false,
} as const;
export const tooltipProps = {
  contentStyle: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    fontSize: 13,
    boxShadow: "0 8px 24px rgba(0,0,0,.25)",
  },
  labelStyle: { color: "var(--text)", fontWeight: 600 },
  itemStyle: { color: "var(--text-2)" },
  cursor: { fill: "var(--surface-2)", opacity: 0.6 },
} as const;

/* ---------- containers ---------- */
interface CardProps {
  title?: ReactNode;
  icon?: LucideIcon;
  sub?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Card({ title, icon: Icon, sub, actions, children, className }: CardProps) {
  return (
    <section className={`card ${className ?? ""}`}>
      {(title || actions) && (
        <div className="card-head">
          <div>
            {title && (
              <h2>
                {Icon && <Icon size={16} />}
                {title}
              </h2>
            )}
            {sub && <div className="sub">{sub}</div>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export interface TableView {
  head: string[];
  rows: (string | number)[][];
}

/** A chart card with its accessible twin: a "Tabela" toggle that shows the same values as a table. */
export function ChartCard({ table, children, ...card }: Omit<CardProps, "actions"> & { table?: TableView }) {
  const [asTable, setAsTable] = useState(false);
  const toggle = table ? (
    <button type="button" className="ghost" onClick={() => setAsTable((v) => !v)} title="Alternar gráfico/tabela">
      {asTable ? <ChartColumn size={13} /> : <Table2 size={13} />}
      {asTable ? "Gráfico" : "Tabela"}
    </button>
  ) : undefined;
  return (
    <Card {...card} actions={toggle}>
      {asTable && table ? <DataTable {...table} /> : children}
    </Card>
  );
}

export function DataTable({ head, rows }: TableView) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={h} className={i > 0 ? "num" : undefined}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, i) => (
                <td key={i} className={i > 0 ? "num" : undefined}>
                  {typeof cell === "number" ? fmtInt(cell) : cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Empty({ icon: Icon = CircleDashed, title, children }: { icon?: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-art">
        <Icon size={26} />
      </div>
      <b>{title}</b>
      {children && <p>{children}</p>}
    </div>
  );
}

/* ---------- figures ---------- */
export function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2 || values.every((v) => v === 0)) return null;
  const w = 92;
  const h = 26;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const x = (i: number) => 4 + (i * (w - 8)) / (values.length - 1);
  const y = (v: number) => h - 4 - ((v - min) / (max - min || 1)) * (h - 8);
  const points = values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const last = values.length - 1;
  return (
    <svg width={w} height={h} aria-hidden="true">
      <polyline points={points} fill="none" stroke="var(--spark)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(last)} cy={y(values[last]!)} r={4} fill="var(--tone, var(--brand-2))" stroke="var(--surface)" strokeWidth={2} />
    </svg>
  );
}

/** Signed change vs a named period; color = direction x whether up is good. */
export function Delta({ current, previous, upIsGood = true, period = "vs 7 dias anteriores" }: {
  current: number;
  previous: number;
  upIsGood?: boolean;
  period?: string;
}) {
  const diff = current - previous;
  if (diff === 0) {
    return (
      <span className="delta flat" title={period}>
        <Minus size={12} /> 0
      </span>
    );
  }
  const up = diff > 0;
  const tone = up ? (upIsGood ? "up-good" : "up-bad") : upIsGood ? "down-bad" : "down-good";
  return (
    <span className={`delta ${tone}`} title={period}>
      {up ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
      {up ? "+" : "−"}
      {fmtInt(Math.abs(diff))}
    </span>
  );
}

export function Kpi(props: {
  label: string;
  icon: LucideIcon;
  tone?: string;
  value: ReactNode;
  small?: boolean;
  sub?: ReactNode;
  delta?: ReactNode;
  spark?: number[];
  meter?: number | null;
}) {
  const { label, icon: Icon, tone, value, small, sub, delta, spark, meter } = props;
  return (
    <section className="card kpi" style={tone ? ({ "--tone": tone } as CSSProperties) : undefined}>
      <div className="kpi-top">
        <span className="label">{label}</span>
        <span className="kpi-icon">
          <Icon size={17} />
        </span>
      </div>
      <div className={small ? "value small" : "value"}>{value}</div>
      {meter != null && (
        <div className="meter">
          <div style={{ width: `${Math.max(0, Math.min(1, meter)) * 100}%` }} />
        </div>
      )}
      <div className="kpi-foot">
        <span className="sub">
          {delta} {sub}
        </span>
        {spark && <Sparkline values={spark} />}
      </div>
    </section>
  );
}

/* ---------- identity ---------- */
const STATUS_META: Record<RunStatus | "published_only", { icon: LucideIcon; tone: string; spin?: boolean }> = {
  complete: { icon: CircleCheck, tone: "good" },
  published_only: { icon: CircleCheck, tone: "good" },
  failed: { icon: CircleX, tone: "bad" },
  running: { icon: LoaderCircle, tone: "info", spin: true },
  interrupted: { icon: CirclePause, tone: "serious" },
  partial: { icon: CircleDashed, tone: "warn" },
  rejected: { icon: ShieldX, tone: "warn" },
};

export function StatusBadge({ status }: { status: RunStatus | "published_only" }) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <span className={`badge ${meta.tone}`}>
      <Icon size={13} className={meta.spin ? "spin" : undefined} />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function CategoryChip({ id, label, categories }: { id: string | null | undefined; label?: string | null; categories: CategoryInfo[] }) {
  if (!id) return null;
  const name = label ?? categories.find((c) => c.id === id)?.label ?? id;
  return (
    <span className="chip" style={{ "--chip": categoryColor(id, categories) } as CSSProperties}>
      {name}
    </span>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="legend">
      {items.map((item) => (
        <span key={item.label}>
          <i style={{ "--sw": item.color } as CSSProperties} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

/* ---------- part-to-whole ---------- */
export interface Share {
  name: string;
  value: number;
  color: string;
}

/** Donut (<= 6 slices, 2px surface gaps) + a labelled share list, so identity never relies on color alone. */
export function Donut({ data, centerLabel }: { data: Share[]; centerLabel: string }) {
  const total = data.reduce((a, b) => a + b.value, 0);
  const slices = data.map((d) => ({ ...d, fill: d.color }));
  return (
    <div className="donut-row">
      <div className="donut">
        <ResponsiveContainer>
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="name"
              innerRadius={58}
              outerRadius={84}
              paddingAngle={data.length > 1 ? 2 : 0}
              cornerRadius={4}
              stroke="none"
              isAnimationActive={false}
            />
            <Tooltip {...tooltipProps} formatter={(v) => fmtInt(Number(v))} />
          </PieChart>
        </ResponsiveContainer>
        <div className="donut-center">
          <b>{fmtInt(total)}</b>
          <span>{centerLabel}</span>
        </div>
      </div>
      <div className="share-list">
        {data.map((d) => (
          <div className="share-row" key={d.name}>
            <i style={{ "--sw": d.color } as CSSProperties} />
            <span>{d.name}</span>
            <span className="n">{fmtInt(d.value)}</span>
            <span className="pct">{total ? `${Math.round((d.value / total) * 100)}%` : "—"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Horizontal bars for long category names (single series, value at the bar end). */
export function HBars({ data, color = "var(--cat-1)" }: { data: { name: string; value: number; color?: string }[]; color?: string }) {
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="hbars">
      {data.map((d) => (
        <div className="hbar" key={d.name} title={`${d.name}: ${d.value}`}>
          <span className="name">{d.name}</span>
          <div className="track">
            <div className="fill" style={{ width: `${(d.value / max) * 100}%`, "--sw": d.color ?? color } as CSSProperties} />
          </div>
          <span className="n">{fmtInt(d.value)}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------- videos ---------- */
export interface PlayableVideo {
  key: string;
  title: string;
  date: string;
  durationSeconds: number | null;
  categoryId: string | null;
  thumbUrl: string | null;
  localUrl: string | null;
  localPath: string | null;
  youtubeUrl: string | null;
  metadata: VideoMetadata | null;
  upload: UploadResult | null;
}

export function toPlayable(row: VideoRow): PlayableVideo {
  return {
    key: row.key,
    title: row.title,
    date: row.date,
    durationSeconds: row.videoDurationSeconds,
    categoryId: row.categoryId,
    thumbUrl: row.thumbUrl,
    localUrl: row.localUrl,
    localPath: row.localPath,
    youtubeUrl: row.youtube?.url ?? null,
    metadata: row.metadata,
    upload: row.upload,
  };
}

export function VideoCard({ video, categories, onOpen }: { video: PlayableVideo; categories: CategoryInfo[]; onOpen: () => void }) {
  return (
    <button type="button" className="vcard" onClick={onOpen} disabled={!video.localUrl} title={video.title}>
      <div className="vthumb">
        {video.thumbUrl ? <img src={video.thumbUrl} alt="" loading="lazy" /> : <Film size={30} />}
        <div className="top">
          <CategoryChip id={video.categoryId} categories={categories} />
        </div>
        {video.durationSeconds != null && <span className="dur">{fmtDuration(video.durationSeconds * 1000)}</span>}
        {video.localUrl && (
          <span className="play">
            <Play size={38} fill="currentColor" />
          </span>
        )}
      </div>
      <span className="vtitle">{video.title}</span>
      <span className="vmeta">{fmtDateTime(video.date)}</span>
    </button>
  );
}

export function PlayerModal({ video, categories, onClose }: { video: PlayableVideo; categories: CategoryInfo[]; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label={video.title}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {video.localUrl && <video src={video.localUrl} controls autoPlay playsInline poster={video.thumbUrl ?? undefined} />}
        <div className="modal-side">
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <CategoryChip id={video.categoryId} categories={categories} />
            <button type="button" className="ghost" onClick={onClose} aria-label="Fechar">
              <X size={16} />
            </button>
          </div>
          <h3>{video.title}</h3>
          <span className="muted">
            {fmtDateTime(video.date)}
            {video.durationSeconds != null && ` · ${fmtDuration(video.durationSeconds * 1000)}`}
          </span>
          <UploadBadge upload={video.upload} />
          {video.youtubeUrl ? (
            <a className="link-btn" href={video.youtubeUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={14} /> Abrir no YouTube
            </a>
          ) : (
            <span className="muted">Ainda não publicado no YouTube.</span>
          )}
          {video.localPath && <PathCopy path={video.localPath} />}
          {video.metadata && <MetadataPreview metadata={video.metadata} />}
        </div>
      </div>
    </div>
  );
}

export function PathCopy({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable: the path is still visible in the tooltip
    }
  };
  return (
    <span className="path" title={path}>
      <code>{path}</code>
      <button type="button" onClick={() => void copy()} aria-label="Copiar caminho">
        <Copy size={12} />
        {copied ? "copiado" : "copiar"}
      </button>
    </span>
  );
}
