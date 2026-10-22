// Configurações > Canais de corte: the channels the cuts pipeline may cut (config/cuts.json). The owner pastes
// a channel link, the server resolves its UC id and name; each channel can be switched on/off, styled
// (vlog = long story clips, podcast = short ones) or blocked for good when its owner complains.
import { ExternalLink, LoaderCircle, Plus, Scissors, ShieldAlert, Trash2 } from "lucide-react";
import { useState, type CSSProperties } from "react";
import type { CutChannelDraft, ResolveChannelResponse } from "../shared/api";
import { NumberInput, Section, Segmented, Switch, TextInput } from "./settingsUi";

const STYLE_OPTIONS = [
  { value: "vlog" as const, label: "Vlog (história de 45 a 90 s)" },
  { value: "podcast" as const, label: "Podcast (30 a 60 s)" },
];

const statusColor = (c: CutChannelDraft): string => (c.blocked ? "var(--critical)" : c.enabled ? "var(--good)" : "var(--muted)");

export function CutsChannelsSection(props: {
  channels: CutChannelDraft[];
  fileExists: boolean;
  onChange: (c: CutChannelDraft[]) => void;
  errorAt: (path: string) => string | undefined;
}) {
  const { channels, fileExists, onChange, errorAt } = props;
  const [link, setLink] = useState("");
  const [adding, setAdding] = useState<{ busy: boolean; msg?: string; bad?: boolean }>({ busy: false });
  const update = (i: number, patch: Partial<CutChannelDraft>) => onChange(channels.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const err = (i: number, field: string) => errorAt(`cuts.channels.${i}.${field}`);

  const add = async () => {
    setAdding({ busy: true });
    try {
      const res = await fetch("/api/cuts/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: link }) });
      const found = (await res.json()) as ResolveChannelResponse;
      if (!found.ok || !found.id) return setAdding({ busy: false, msg: found.message, bad: true });
      if (channels.some((c) => c.id === found.id)) return setAdding({ busy: false, msg: `${found.name} já está na lista.`, bad: true });
      const name = found.name ?? found.id;
      onChange([...channels, { id: found.id, name, enabled: false, style: "vlog", credit: `Cortes do canal ${name}`, maxVideosPerDay: 1 }]);
      setLink("");
      setAdding({ busy: false, msg: `${found.message} Ele entra desligado: confira e ligue.` });
    } catch (e) {
      setAdding({ busy: false, msg: e instanceof Error ? e.message : String(e), bad: true });
    }
  };

  return (
    <Section
      id="cfg-cortes"
      icon={Scissors}
      title="Canais de corte"
      description="Canais de onde a máquina tira cortes. Cortar vídeo público pode; mudar o sentido da fala ou desmoralizar alguém, nunca."
    >
      {!fileExists && <p className="hint">O arquivo config/cuts.json ainda não existe: a lista abaixo vem do exemplo e é criada ao salvar.</p>}
      <div className="topics">
        {channels.map((c, i) => (
          <div key={c.id || i} className="topic-card" style={{ "--chip": statusColor(c) } as CSSProperties}>
            <div className="topic-head">
              <span className="topic-dot" title={c.blocked ? "Bloqueado" : c.enabled ? "Ligado" : "Desligado"} />
              <TextInput label="Nome" value={c.name} onChange={(v) => update(i, { name: v })} error={err(i, "name")} />
              <TextInput
                label="Código do canal"
                value={c.id}
                readOnly
                onChange={() => undefined}
                help={
                  <a href={`https://www.youtube.com/channel/${c.id}`} target="_blank" rel="noreferrer">
                    abrir no YouTube <ExternalLink size={11} />
                  </a>
                }
                error={err(i, "id")}
              />
              <button
                type="button"
                className="ghost icon-btn"
                aria-label={`Remover ${c.name || "canal"}`}
                onClick={() => {
                  if (window.confirm(`Remover o canal "${c.name}" da lista?`)) onChange(channels.filter((_, j) => j !== i));
                }}
              >
                <Trash2 size={15} />
              </button>
            </div>
            <div className="cfg-grid">
              <Switch label="Ligado" checked={c.enabled && !c.blocked} onChange={(v) => update(i, { enabled: v })} help={c.blocked ? "Bloqueado: não é cortado mesmo ligado." : "Desligado = a máquina ignora este canal."} />
              <Segmented label="Tipo" value={c.style ?? "podcast"} options={STYLE_OPTIONS} onChange={(v) => update(i, { style: v })} error={err(i, "style")} />
              <TextInput label="Crédito do canal" value={c.credit} onChange={(v) => update(i, { credit: v })} help="Vai para a descrição do corte, junto com o link do vídeo original." error={err(i, "credit")} />
              <NumberInput label="Vídeos por dia" value={c.maxVideosPerDay} min={1} max={10} onChange={(v) => update(i, { maxVideosPerDay: v })} error={err(i, "maxVideosPerDay")} />
              <NumberInput label="Duração mínima" suffix="s" value={c.minSeconds} min={10} max={180} onChange={(v) => update(i, { minSeconds: v })} help="Vazio = padrão do tipo (vlog 45 s, podcast 30 s)." error={err(i, "minSeconds")} />
              <NumberInput label="Duração máxima" suffix="s" value={c.maxSeconds} min={15} max={180} onChange={(v) => update(i, { maxSeconds: v })} help="Vazio = padrão do tipo (vlog 90 s, podcast 60 s). Máximo 180 s, o limite do Shorts." error={err(i, "maxSeconds")} />
              <TextInput
                label="Link da liberação (opcional)"
                value={c.authorization?.url ?? ""}
                placeholder="post ou vídeo onde o dono libera cortes"
                onChange={(v) => update(i, { authorization: { ...(c.authorization ?? { conditions: [] }), url: v } })}
                help="Serve de prova se o YouTube reclamar de um corte."
                error={err(i, "authorization.url")}
              />
              <Switch
                label="Bloqueado"
                checked={!!c.blocked}
                onChange={(v) => update(i, { blocked: v ? "dono do canal pediu para parar" : undefined })}
                help="Use se o dono reclamar ou houver aviso de direitos: o canal nunca mais é cortado."
              />
              {c.blocked !== undefined && <TextInput label="Motivo do bloqueio" value={c.blocked} onChange={(v) => update(i, { blocked: v })} error={err(i, "blocked")} />}
            </div>
          </div>
        ))}
      </div>
      <div className="cfg-grid">
        <TextInput label="Adicionar canal" value={link} placeholder="youtube.com/@acfperformance" onChange={setLink} help="Cole o link do canal; o painel descobre o código e o nome." />
        <div>
          <button type="button" className="ghost add-btn" disabled={adding.busy || !link.trim()} onClick={() => void add()}>
            {adding.busy ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />} Adicionar
          </button>
          {adding.msg && <p className={adding.bad ? "bad-text" : "ok-text"}>{adding.msg}</p>}
        </div>
      </div>
      <p className="hint">
        <ShieldAlert size={12} /> Os cortes nunca são publicados por aqui. Antes de renderizar, a máquina confere se cada trecho mantém o sentido e se o título não mente nem desmoraliza ninguém.
      </p>
    </Section>
  );
}
