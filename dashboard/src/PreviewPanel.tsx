// Live 9:16 preview: asks the server for a Remotion still (debounced, stale requests dropped) and, while
// the still generator is unavailable, shows a clearly labelled CSS approximation of the captions.
import { Eye, EyeOff, LoaderCircle, MonitorPlay, Timer } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { CaptionSettings, PreviewResponse, RunSummary, VisualSettings } from "../shared/api";
import { fmtDuration } from "./format";

const DEBOUNCE_MS = 700;
const RETRY_UNAVAILABLE_MS = 20_000;
const SAMPLE_WORDS = ["VOCÊ", "SABIA", "QUE", "VÊNUS", "GIRA", "AO", "CONTRÁRIO?"];

interface Props {
  runs: RunSummary[];
  captions: Required<CaptionSettings>;
  visual: Required<VisualSettings>;
  fonts: Record<string, string>;
  invalid: boolean;
}

function Approximation({ captions, visual, fonts, thumb }: Omit<Props, "runs" | "invalid"> & { thumb: string | null }) {
  const words = SAMPLE_WORDS.slice(0, captions.maxWordsPerCue);
  const highlightIndex = Math.min(1, words.length - 1);
  return (
    <div className="approx">
      {thumb && <img src={thumb} alt="" style={{ transform: `scale(${visual.imageZoom})` }} />}
      {visual.captionBackdrop && captions.enabled && <div className="approx-backdrop" style={{ top: `${captions.verticalPosition * 100 - 22}%` }} />}
      {captions.enabled && (
        <div
          className="approx-caption"
          style={
            {
              top: `${captions.verticalPosition * 100}%`,
              fontFamily: fonts[captions.font],
              "--fs": captions.maxFontPx,
              color: captions.textColor,
              WebkitTextStroke: `calc(var(--u) * 10) ${captions.strokeColor}`,
            } as CSSProperties
          }
        >
          {words.map((w, i) => (
            <span key={i} style={i === highlightIndex && captions.highlight === "color" ? { color: captions.highlightColor } : undefined}>
              {captions.uppercase ? w : w.charAt(0) + w.slice(1).toLowerCase()}{" "}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function PreviewPanel({ runs, captions, visual, fonts, invalid }: Props) {
  const playable = runs.filter((r) => r.status === "complete" && r.video?.exists && r.hasContext);
  const [runId, setRunId] = useState<string>("");
  const run = playable.find((r) => r.runId === runId) ?? playable[0];
  const duration = run?.video?.durationSeconds ?? 0;
  const [time, setTime] = useState(3);
  const [safeZone, setSafeZone] = useState(true);
  const [result, setResult] = useState<PreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!loading) return setSlow(false);
    const t = setTimeout(() => setSlow(true), 4000); // cold bundle after code changes takes 5–40 s
    return () => clearTimeout(t);
  }, [loading]);
  const abortRef = useRef<AbortController | null>(null);

  const key = JSON.stringify([run?.runId, time, captions, visual]);
  useEffect(() => {
    if (!run || invalid) {
      abortRef.current?.abort();
      setLoading(false);
      return;
    }
    const timer = setTimeout(() => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      fetch("/api/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: run.runId, time, style: { captions, visual } }),
        signal: ctrl.signal,
      })
        .then((r) => r.json() as Promise<PreviewResponse>)
        .then((res) => {
          if (ctrl.signal.aborted || res.status === "superseded") return;
          setResult(res);
          setLoading(false);
        })
        .catch(() => {
          if (!ctrl.signal.aborted) {
            setResult({ status: "error", message: "Servidor indisponível." });
            setLoading(false);
          }
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, invalid, retryTick]);

  // The still generator is being built in parallel: keep retrying quietly while it is missing.
  useEffect(() => {
    if (result?.status !== "unavailable") return;
    const t = setTimeout(() => setRetryTick((n) => n + 1), RETRY_UNAVAILABLE_MS);
    return () => clearTimeout(t);
  }, [result]);

  const real = result?.status === "ok" && result.url;
  return (
    <aside className="card preview-panel">
      <div className="card-head">
        <div>
          <h2>
            <MonitorPlay size={16} /> Pré-visualização
          </h2>
          <div className="sub">{real ? "Quadro real renderizado pelo Remotion" : "Prévia aproximada das legendas"}</div>
        </div>
        <button type="button" className="ghost" onClick={() => setSafeZone((v) => !v)} title="Mostrar/ocultar a zona coberta pela interface do Shorts">
          {safeZone ? <EyeOff size={13} /> : <Eye size={13} />} Zona segura
        </button>
      </div>

      <div className={`phone ${loading ? "busy" : ""}`}>
        {real ? <img src={result.url} alt="Quadro de pré-visualização" /> : <Approximation captions={captions} visual={visual} fonts={fonts} thumb={run?.thumbUrl ?? null} />}
        {safeZone && (
          <div className="safe-zone" aria-hidden="true">
            <div className="sz-top">topo: título do Shorts</div>
            <div className="sz-right" />
            <div className="sz-bottom">interface do YouTube</div>
          </div>
        )}
        {loading && (
          <div className="phone-busy">
            <LoaderCircle size={22} className="spin" />
            {slow ? (
              <span>
                preparando pré-visualização…
                <small>a primeira vez pode levar até 40 s</small>
              </span>
            ) : (
              "renderizando…"
            )}
          </div>
        )}
      </div>

      <div className="preview-meta">
        {invalid ? (
          <span className="bad-text">Corrija os campos destacados para atualizar a prévia.</span>
        ) : real ? (
          <span>
            <Timer size={13} /> {result.cached ? "do cache" : result.ms != null ? `renderizado em ${fmtDuration(result.ms)}` : "renderizado"}
          </span>
        ) : (
          <span className="muted">{result?.message ?? "Gerando…"}</span>
        )}
      </div>

      {playable.length > 0 ? (
        <>
          <label className="field-label" htmlFor="pv-run">
            Vídeo de referência
          </label>
          <select id="pv-run" className="input" value={run?.runId ?? ""} onChange={(e) => setRunId(e.target.value)}>
            {playable.map((r) => (
              <option key={r.runId} value={r.runId}>
                {r.title ?? r.runId}
              </option>
            ))}
          </select>
          <div className="slider" style={{ marginTop: 10 }}>
            <input
              type="range"
              min={0}
              max={Math.max(1, Math.floor(duration * 10) / 10)}
              step={0.1}
              value={Math.min(time, duration)}
              onChange={(e) => setTime(Number(e.target.value))}
              aria-label="Instante do vídeo"
              style={{ "--pct": `${(Math.min(time, duration) / Math.max(1, duration)) * 100}%` } as CSSProperties}
            />
            <output>{fmtDuration(time * 1000)}</output>
          </div>
        </>
      ) : (
        <p className="hint">Renderize um vídeo para usar como fundo da pré-visualização.</p>
      )}
    </aside>
  );
}
