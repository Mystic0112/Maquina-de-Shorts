// Configurações > Marca d'água: the owner's brand on every Short and cut (text and/or PNG logo).
import { BadgeCheck, ImageUp, LoaderCircle } from "lucide-react";
import { useRef, useState, type CSSProperties } from "react";
import type { WatermarkSettings } from "../shared/api";
import { Section, Segmented, Slider, Switch, TextInput } from "./settingsUi";

const POSITIONS: { value: Required<WatermarkSettings>["position"]; label: string }[] = [
  { value: "top-left", label: "Topo esq." },
  { value: "top", label: "Topo" },
  { value: "top-right", label: "Topo dir." },
  { value: "bottom-left", label: "Baixo esq." },
  { value: "bottom", label: "Baixo" },
  { value: "bottom-right", label: "Baixo dir." },
];

/** Same anchors as src/shared/settings.ts WATERMARK_LAYOUT (1080×1920), in % of the frame. */
function mockStyle(wm: Required<WatermarkSettings>): CSSProperties {
  const p = wm.position;
  return {
    width: `${wm.size}%`,
    opacity: wm.opacity,
    ...(p.startsWith("top") ? { top: `${(150 / 1920) * 100}%` } : { bottom: `${(420 / 1920) * 100}%` }),
    ...(p.endsWith("left") ? { left: `${(48 / 1080) * 100}%` } : p.endsWith("right") ? { right: `${(48 / 1080) * 100}%` } : { left: `${(100 - wm.size) / 2}%` }),
  };
}

export function WatermarkSection(props: { wm: Required<WatermarkSettings>; set: (path: string, value: unknown) => void; errorAt: (path: string) => string | undefined }) {
  const { wm, set, errorAt } = props;
  const fileRef = useRef<HTMLInputElement>(null);
  const [upload, setUpload] = useState<{ busy: boolean; msg?: string; bad?: boolean; v: number }>({ busy: false, v: Date.now() });

  const send = async (file: File) => {
    setUpload((u) => ({ ...u, busy: true, msg: undefined }));
    try {
      const res = await fetch("/api/branding/logo", { method: "PUT", headers: { "Content-Type": "image/png" }, body: file });
      const out = (await res.json().catch(() => ({ ok: false, message: `HTTP ${res.status} (máximo 2 MB)` }))) as { ok: boolean; message: string; path?: string };
      if (!out.ok || !out.path) return setUpload((u) => ({ ...u, busy: false, msg: out.message, bad: true }));
      set("watermark.image", out.path);
      setUpload({ busy: false, msg: "Logo enviado. Salve para valer nos próximos vídeos.", v: Date.now() });
    } catch (e) {
      setUpload((u) => ({ ...u, busy: false, msg: e instanceof Error ? e.message : String(e), bad: true }));
    }
  };

  return (
    <Section id="cfg-marca" icon={BadgeCheck} title="Marca d'água" description="Sua marca em todos os Shorts e cortes: um texto (ex.: @seucanal), um logo PNG ou os dois." onReset={() => set("watermark", undefined)}>
      <div className="cfg-grid">
        <Switch label="Mostrar marca d'água" checked={wm.enabled} onChange={(v) => set("watermark.enabled", v)} help="Desligado = nenhum vídeo leva marca." />
        <TextInput label="Texto" value={wm.text} maxLength={40} placeholder="@seucanal" onChange={(v) => set("watermark.text", v)} help="Vazio = só o logo." error={errorAt("watermark.text")} />
        <div className="field">
          <span className="field-label">Logo (PNG)</span>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            {wm.image ? <img src={`/api/branding/logo?v=${upload.v}`} alt="Logo atual" style={{ height: 40, maxWidth: 120, objectFit: "contain", background: "#0008", borderRadius: 6, padding: 4 }} /> : null}
            <button type="button" className="ghost" disabled={upload.busy} onClick={() => fileRef.current?.click()}>
              {upload.busy ? <LoaderCircle size={14} className="spin" /> : <ImageUp size={14} />} {wm.image ? "Trocar logo" : "Enviar logo"}
            </button>
            {wm.image ? (
              <button type="button" className="ghost" onClick={() => set("watermark.image", "")}>
                Sem logo
              </button>
            ) : null}
            <input ref={fileRef} type="file" accept="image/png" hidden onChange={(e) => e.target.files?.[0] && void send(e.target.files[0])} />
          </div>
          <span className="field-help">PNG com fundo transparente, até 2 MB. Fica só neste PC (data/branding/), fora do GitHub.</span>
          {upload.msg && <span className={upload.bad ? "bad-text" : "ok-text"}>{upload.msg}</span>}
        </div>
        <Segmented label="Posição" value={wm.position} options={POSITIONS} onChange={(v) => set("watermark.position", v)} help="Topo e baixo respeitam as áreas do título e dos botões do YouTube." />
        <Slider label="Opacidade" value={wm.opacity} min={0.1} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set("watermark.opacity", v)} />
        <Slider label="Tamanho" value={wm.size} min={5} max={40} format={(v) => `${v}% da largura`} onChange={(v) => set("watermark.size", v)} />
        <div className="field">
          <span className="field-label">Onde fica</span>
          <div style={{ position: "relative", width: 108, aspectRatio: "9 / 16", borderRadius: 10, background: "linear-gradient(160deg,#3b4370,#141726)", overflow: "hidden" }}>
            <div style={{ position: "absolute", display: "flex", flexDirection: "column", alignItems: "center", gap: 2, ...mockStyle(wm) }}>
              {wm.image ? <img src={`/api/branding/logo?v=${upload.v}`} alt="" style={{ width: "100%" }} /> : null}
              {wm.text ? <span style={{ fontSize: 7, fontWeight: 900, color: "#fff", whiteSpace: "nowrap" }}>{wm.text}</span> : null}
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}
