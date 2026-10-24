// Configurações > Músicas: the songs the owner pre-selects for beat-synced edits (stored in data/music/, outside git).
import { LoaderCircle, Music, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MusicTrack } from "../shared/api";
import { Section } from "./settingsUi";

const MAX_MB = 40;
const fmtSize = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export function MusicSection() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [tracks, setTracks] = useState<MusicTrack[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/music", { headers: { Accept: "application/json" } });
      setTracks(((await res.json()) as { tracks: MusicTrack[] }).tracks);
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), bad: true });
    }
  }, []);
  useEffect(() => void load(), [load]);

  const send = async (file: File) => {
    const label = name.trim() || file.name.replace(/\.[^.]+$/, "");
    if (file.size > MAX_MB * 1024 * 1024) return setMsg({ text: `A música passa de ${MAX_MB} MB.`, bad: true });
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/music", { method: "PUT", headers: { "Content-Type": file.type || "audio/mpeg", "X-Track-Name": encodeURIComponent(label) }, body: file });
      const out = (await res.json().catch(() => ({ ok: false, message: `HTTP ${res.status}` }))) as { ok: boolean; message: string };
      setMsg({ text: out.message, bad: !out.ok });
      if (out.ok) {
        setName("");
        await load();
      }
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), bad: true });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const remove = async (track: MusicTrack) => {
    if (!window.confirm(`Remover "${track.name}" da lista? O arquivo é apagado deste PC.`)) return;
    const res = await fetch(`/api/music/${encodeURIComponent(track.id)}`, { method: "DELETE" });
    const out = (await res.json().catch(() => ({ ok: false, message: `HTTP ${res.status}` }))) as { ok: boolean; message: string };
    setMsg({ text: out.message, bad: !out.ok });
    await load();
  };

  return (
    <Section id="cfg-musica" icon={Music} title="Músicas" description="As músicas pré-definidas dos edits (cortes encaixados nos graves). Só coloque música com licença para publicar: a do template do CapCut vale só dentro do app.">
      <div className="cfg-grid">
        <div className="field wide">
          <span className="field-label">Adicionar música</span>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <input type="text" value={name} maxLength={60} placeholder="Nome (opcional)" onChange={(e) => setName(e.target.value)} style={{ minWidth: 200 }} />
            <button type="button" className="ghost" disabled={busy} onClick={() => fileRef.current?.click()}>
              {busy ? <LoaderCircle size={14} className="spin" /> : <Upload size={14} />} Enviar música
            </button>
            <input ref={fileRef} type="file" accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac" hidden onChange={(e) => e.target.files?.[0] && void send(e.target.files[0])} />
          </div>
          <span className="field-help">MP3, WAV, M4A, OGG ou FLAC, até {MAX_MB} MB. Fica só neste PC (data/music/), fora do GitHub. A Máquina acha os graves sozinha na hora de montar o edit.</span>
          {msg && <span className={msg.bad ? "bad-text" : "ok-text"}>{msg.text}</span>}
        </div>
        <div className="field wide">
          <span className="field-label">Sua lista {tracks ? `(${tracks.length})` : ""}</span>
          {tracks === null ? (
            <LoaderCircle size={16} className="spin" />
          ) : tracks.length === 0 ? (
            <span className="field-help">Nenhuma música ainda.</span>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              {tracks.map((t) => (
                <div key={t.id} style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                  <b style={{ minWidth: 160 }}>{t.name}</b>
                  <audio controls preload="none" src={`/api/music/${encodeURIComponent(t.id)}/audio`} style={{ height: 32, maxWidth: 280 }} />
                  <span className="field-help">{fmtSize(t.bytes)}</span>
                  <button type="button" className="ghost" onClick={() => void remove(t)} title="Remover da lista">
                    <Trash2 size={14} /> Remover
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Section>
  );
}
