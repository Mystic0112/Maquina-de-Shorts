import type { RunStatus, StageName, StageStatus } from "../shared/api";

const intFmt = new Intl.NumberFormat("pt-BR");
const dateTimeFmt = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });

export const fmtInt = (n: number | null | undefined): string => (n == null ? "—" : intFmt.format(n));

const compactFmt = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 2 });

/** Short form for big numbers ("1,82 bi", "4,55 mi"); small numbers stay exact. */
export const fmtCompact = (n: number | null | undefined): string =>
  n == null ? "—" : Math.abs(n) >= 10_000 ? compactFmt.format(n) : intFmt.format(n);

const decFmt = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
export const fmtDecimal = (n: number): string => decFmt.format(n);

export const fmtPercent = (ratio: number | null): string =>
  ratio == null ? "—" : `${Math.round(ratio * 100)}%`;

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : dateTimeFmt.format(d);
}

/** "2026-10-03" -> "03/10" */
export const fmtDay = (day: string): string => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1).replace(".", ",")} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${String(Math.round(s % 60)).padStart(2, "0")} s`;
}

export function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (min < 1) return "agora há pouco";
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `há ${h} h` : `há ${Math.round(h / 24)} dias`;
}

const usdFmt = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD", maximumFractionDigits: 4 });
export const fmtUsd = (n: number): string => usdFmt.format(n);

export const fmtBytes = (n: number | null): string => (n == null ? "—" : `${(n / 1_048_576).toFixed(1).replace(".", ",")} MB`);

export const STATUS_LABEL: Record<RunStatus | "published_only", string> = {
  complete: "Concluído",
  failed: "Falhou",
  running: "Em execução",
  interrupted: "Interrompido",
  partial: "Parcial",
  rejected: "Reprovado",
  published_only: "Publicado",
};

export const STAGE_LABEL: Record<StageName, string> = {
  "01-pickTopic": "Tema",
  "02-generateScript": "Roteiro",
  "02b-factCheck": "Checagem de fatos",
  "03-fetchFootage": "Footage",
  "04-synthesizeVoice": "Narração",
  "05-buildCaptions": "Legendas",
  "06-renderVideo": "Render",
  "07-generateMetadata": "Metadados",
  "08-uploadYouTube": "Upload",
};

export const STAGE_STATUS_LABEL: Record<StageStatus, string> = {
  done: "ok",
  failed: "falhou",
  running: "rodando…",
  interrupted: "interrompida",
  skipped: "pré-existente",
  pending: "não executada",
  bypassed: "pulado",
};
