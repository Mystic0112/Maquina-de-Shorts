// Live 9:16 preview: asks the server for a Remotion still (debounced, stale requests dropped) and, while
// the still generator is unavailable, shows a clearly labelled CSS approximation of the captions.
// Runs rendered before the hook text existed carry no script.overlayText, so the Remotion still cannot
// draw it: the panel then lays a labelled sample hook over the frame (same placement as overlayStyle.ts).
import { Captions, Eye, EyeOff, Image as ImageIcon, LoaderCircle, MonitorPlay, Timer } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { CaptionSettings, PreviewResponse, RunSummary, VisualSettings } from "../shared/api";
import { fmtDuration } from "./format";

const DEBOUNCE_MS = 700;
const RETRY_UNAVAILABLE_MS = 20_000;
/** Sample cue; `key` marks content words (what "keywords" highlight lights up). */
const SAMPLE_WORDS = [
  { text: "VOCÊ", key: false },
  { text: "SABIA", key: true },
  { text: "QUE", key: false },
  { text: "VÊNUS", key: true },
];
const SAMPLE_ACTIVE = 2; // the narrator is on "QUE": "color" lights it, "keywords" keeps "SABIA" lit
const SAMPLE_HOOK = "VÊNUS GIRA AO CONTRÁRIO?";
const CAPTION_TIME = 3;
/** Mirrors src/remotion/components/overlayStyle.ts / captionStyle.ts (approximate glyph widths). */
const HOOK_FONT_SCALE = 1.25;
const HOOK_MIN_FONT = 56;
const HOOK_MAX_LINES = 2;
const HOOK_WIDTH = 1080 * (1 - 2 * 0.08);
const HOOK_FADE_SECONDS = 0.3;
const GLYPH_EM: Record<string, number> = { "arial-black": 0.8, impact: 0.56, "segoe-black": 0.74, verdana: 0.72 };

/** Same rule as highlightedWordIndex() in captionStyle.ts. */
function litIndex(mode: CaptionSettings["highlight"], words: { key: boolean }[], active: number): number {
  if (mode === "none" || !words.length) return -1;
  if (mode === "color") return active;
  for (let i = active; i >= 0; i--) if (words[i]!.key) return i;
  return -1;
}

function hookOpacity(time: number, visual: Required<VisualSettings>): number {
  if (!visual.overlayHook || time >= visual.overlayHookSeconds) return 0;
  const fadeStart = visual.overlayHookSeconds - HOOK_FADE_SECONDS;
  return time <= fadeStart ? 1 : Math.max(0, (visual.overlayHookSeconds - time) / HOOK_FADE_SECONDS);
}

function estimateLines(words: string[], fontSize: number, glyphEm: number): number {
  let lines = 1;
  let used = 0;
  for (const word of words) {
    const w = word.length * glyphEm * fontSize;
    const next = used === 0 ? w : used + 0.3 * fontSize + w;
    if (next > HOOK_WIDTH && used > 0) {
      lines += 1;
      used = w;
    } else used = next;
  }
  return lines;
}

/** Same sizing as overlayLayout(): start big, shrink until the hook fits in two lines. */
function hookFontPx(text: string, captions: Required<CaptionSettings>): number {
  const words = text.split(" ").filter(Boolean);
  const glyphEm = GLYPH_EM[captions.font] ?? 0.75;
  const longest = Math.max(1, ...words.map((w) => w.length));
  let fs = Math.min(Math.round(captions.maxFontPx * HOOK_FONT_SCALE), HOOK_WIDTH / (longest * glyphEm));
  while (fs > HOOK_MIN_FONT && estimateLines(words, fs, glyphEm) > HOOK_MAX_LINES) fs *= 0.92;
  return Math.max(HOOK_MIN_FONT, Math.floor(fs));
}

function HookLayer(props: { text: string; sample: boolean; opacity: number; captions: Required<CaptionSettings>; fonts: Record<string, string> }) {
  const { text, captions } = props;
  const fs = hookFontPx(text, captions);
  return (
    <div className="pv-hook" style={{ opacity: props.opacity, background: "linear-gradient(to bottom, rgba(0,0,0,.45) 0%, rgba(0,0,0,.3) 30%, transparent 42%)" }}>
      {props.sample && <span className="pv-hook-tag">texto de capa de exemplo</span>}
      <div
        className="pv-hook-text"
        style={
          {
            "--fs": fs,
            fontFamily: props.fonts[captions.font],
            color: captions.highlightColor,
            WebkitTextStroke: `calc(var(--u) * 10) ${captions.strokeColor}`,
          } as CSSProperties
        }
      >
        {text}
      </div>
    </div>
  );
}

interface Props {
  runs: RunSummary[];
  captions: Required<CaptionSettings>;
  visual: Required<VisualSettings>;
  fonts: Record<string, string>;
  invalid: boolean;
}

function Approximation({ captions, visual, fonts, thumb }: Omit<Props, "runs" | "invalid"> & { thumb: string | null }) {
  const words = SAMPLE_WORDS.slice(0, Math.max(captions.maxWordsPerCue, 1));
  const highlightIndex = litIndex(captions.highlight, words, Math.min(SAMPLE_ACTIVE, words.length - 1));
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
            <span key={i} style={i === highlightIndex ? { color: captions.highlightColor } : undefined}>
              {captions.uppercase ? w.text : w.text.charAt(0) + w.text.slice(1).toLowerCase()}{" "}
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
  const [time, setTime] = useState(CAPTION_TIME);
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
  // Remotion draws the run's own hook text; only runs without one (or the CSS approximation) need ours.
  const hookText = run?.overlayText ?? SAMPLE_HOOK;
  const hookIsSample = !run?.overlayText;
  const opacity = hookOpacity(real ? Math.min(time, duration) : time, visual);
  const showHook = opacity > 0 && (!real || hookIsSample);
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
        {showHook && <HookLayer text={hookText} sample={hookIsSample} opacity={opacity} captions={captions} fonts={fonts} />}
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

      <div className="preview-jump" role="group" aria-label="Ir para um instante">
        <button type="button" className={`ghost pill ${time === 0 ? "on" : ""}`} onClick={() => setTime(0)} title="Primeiro quadro: capa com o texto de abertura">
          <ImageIcon size={12} /> Capa · 0 s
        </button>
        <button type="button" className={`ghost pill ${time === CAPTION_TIME ? "on" : ""}`} onClick={() => setTime(CAPTION_TIME)} title="Um instante com legenda na tela">
          <Captions size={12} /> Legenda · {CAPTION_TIME} s
        </button>
      </div>
      {visual.overlayHook && hookIsSample && time < visual.overlayHookSeconds && (
        <p className="hint">
          {run ? "Este vídeo é anterior ao texto de capa; " : ""}a frase no topo é um exemplo. Nos próximos vídeos ela vem do roteiro.
        </p>
      )}
      {captions.highlight === "keywords" && real && run && !run.captionKeywords && (
        <p className="hint">Este vídeo é anterior às palavras-chave: nele o destaque aparece em todas as palavras. Nos vídeos novos só as importantes acendem.</p>
      )}

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
