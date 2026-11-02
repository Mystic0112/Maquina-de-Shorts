// Configurações > Plataforma: the ENGINE of the machine in one place. One card per AI provider (installed / configured /
// tested, its keys, its warnings, "Testar conexão"), the other keyed services, and a summary of the voice and image
// engines that links to their own blocks. Reuses KeysEditor (write-only keys) and the OpenAI-compatible fields; the page's
// draft/save is the same as everywhere else. Nothing here ever shows a key.
import { CircleCheck, CircleX, LoaderCircle, Plug, PlugZap, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyStatus, PlatformProvider, PlatformReadiness, PlatformService, PlatformStatus, PlatformTest, PlatformTestResponse } from "../shared/api";
import { KeysEditor } from "./KeysEditor";
import { OpenAiCompatibleFields } from "./LlmTasksSection";
import { getPath, type Json } from "./settingsModel";
import { Section } from "./settingsUi";

const when = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
};

const goTo = (id: string): void => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

function Chip(props: { tone: "good" | "warn" | "bad" | "info"; children: React.ReactNode }) {
  return (
    <span className={`badge ${props.tone}`}>
      {props.tone === "good" ? <CircleCheck size={13} /> : props.tone === "info" ? null : <CircleX size={13} />}
      {props.children}
    </span>
  );
}

function TestedChip({ test }: { test: PlatformTest | undefined }) {
  if (!test) return <Chip tone="info">Nunca testado</Chip>;
  return test.ok ? <Chip tone="good">Testado: ok ({when(test.at)})</Chip> : <Chip tone="bad">Último teste falhou ({when(test.at)})</Chip>;
}

function Notes({ notes }: { notes: readonly string[] }) {
  return (
    <>
      {notes.map((n) => (
        <p key={n} className="plat-note">
          <TriangleAlert size={15} aria-hidden="true" /> <span>{n}</span>
        </p>
      ))}
    </>
  );
}

function ConfirmPaidDialog(props: { provider: PlatformProvider | null; onCancel: () => void; onConfirm: (name: string) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { provider } = props;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (provider && !el.open) el.showModal();
    if (!provider && el.open) el.close();
  }, [provider]);
  return (
    <dialog ref={ref} className="plat-dialog" aria-labelledby="plat-confirm-title" onClose={props.onCancel}>
      {provider && (
        <form method="dialog" onSubmit={(e) => e.preventDefault()}>
          <h3 id="plat-confirm-title">Testar {provider.label}?</h3>
          <p>
            Este provedor é <b>pago</b>: o teste faz uma chamada real (bem pequena) na sua conta e isso é cobrado. Nada é publicado.
          </p>
          <div className="plat-dialog-actions">
            <button type="button" className="ghost" onClick={props.onCancel} autoFocus>
              Cancelar
            </button>
            <button type="button" className="primary" onClick={() => props.onConfirm(provider.name)}>
              Testar e gastar uma chamada
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}

export function PlatformSection(props: {
  draft: Json;
  /** The file as saved: the test runs against it, not against the draft. */
  saved: Json;
  voiceEngine: string;
  imageSource: string;
  set: (path: string, value: unknown) => void;
  errorAt: (path: string) => string | undefined;
}) {
  const { draft, saved, set, errorAt } = props;
  const [status, setStatus] = useState<PlatformStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keys, setKeys] = useState<KeyStatus[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { text: string; bad: boolean }>>({});
  const [confirming, setConfirming] = useState<PlatformProvider | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/platform", { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as PlatformStatus;
      setStatus(body);
      setKeys(body.keys);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => void load(), [load]);

  const runTest = async (name: string, confirmPaid: boolean) => {
    setConfirming(null);
    setBusy(name);
    setResults((r) => ({ ...r, [name]: { text: "Testando…", bad: false } }));
    try {
      const res = await fetch(`/api/platform/test/${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(confirmPaid ? { confirmPaid: true } : {}),
      });
      const out = (await res.json().catch(() => ({ ok: false, message: `HTTP ${res.status}` }))) as PlatformTestResponse;
      setResults((r) => ({ ...r, [name]: { text: out.message, bad: !out.ok } }));
    } catch (e) {
      setResults((r) => ({ ...r, [name]: { text: e instanceof Error ? e.message : String(e), bad: true } }));
    } finally {
      setBusy(null);
      void load();
    }
  };

  const onKeys = (next: KeyStatus[]) => {
    setKeys(next);
    void load(); // availability of the providers depends on the keys
  };

  const urlChanged = (getPath(draft, "llm.openaiCompatible.baseUrl") ?? "") !== (getPath(saved, "llm.openaiCompatible.baseUrl") ?? "");

  const card = (p: PlatformProvider) => {
    const isOpenAi = p.name === "openai-compatible";
    const blocked = isOpenAi && urlChanged;
    const result = results[p.name];
    return (
      <article key={p.name} className="plat-card" aria-labelledby={`plat-${p.name}`}>
        <header className="plat-card-head">
          <h3 id={`plat-${p.name}`}>{p.label}</h3>
          <span className={`badge ${p.paid ? "warn" : "good"}`}>{p.paid ? "paga por chamada" : "sem custo de API"}</span>
        </header>
        <div className="plat-chips">
          {p.kind === "cli" ? (
            p.installed ? <Chip tone="good">Instalado</Chip> : <Chip tone="warn">Não instalado</Chip>
          ) : p.configured ? (
            <Chip tone="good">Configurado</Chip>
          ) : (
            <Chip tone="warn">Falta configurar</Chip>
          )}
          <TestedChip test={p.lastTest} />
        </div>
        {!p.available && p.reason && <p className="hint">{p.reason}.</p>}
        {p.kind === "cli" && <p className="hint">Sem chave: usa o login do seu plano feito uma vez no comando <code>{p.command}</code>.</p>}
        {p.lastTest && !result && <p className="hint">Último teste: {p.lastTest.message}</p>}
        <Notes notes={p.notes} />
        {isOpenAi && <OpenAiCompatibleFields draft={draft} set={set} errorAt={errorAt} />}
        {p.keyNames.length > 0 && <KeysEditor keys={keys} names={p.keyNames} onKeys={onKeys} />}
        <div className="plat-actions">
          <button
            type="button"
            className="ghost plat-test"
            disabled={busy !== null || !p.available || blocked}
            onClick={() => (p.paid ? setConfirming(p) : void runTest(p.name, false))}
          >
            {busy === p.name ? <LoaderCircle size={15} className="spin" /> : <PlugZap size={15} />} {busy === p.name ? "Testando…" : "Testar conexão"}
          </button>
          <span className="muted plat-actions-hint">
            {blocked ? "Salve a configuração antes de testar: o teste usa a URL salva." : p.paid ? "Cobra uma chamada real; pede confirmação." : "Uma chamada mínima, sem custo de API."}
          </span>
        </div>
        {result && (
          <p role="status" className={result.bad ? "bad-text" : "ok-text"}>
            {result.text}
          </p>
        )}
      </article>
    );
  };

  const serviceCard = (s: PlatformService) => (
    <article key={s.id} className="plat-card" aria-labelledby={`plat-${s.id}`}>
      <header className="plat-card-head">
        <h3 id={`plat-${s.id}`}>{s.label}</h3>
      </header>
      <Notes notes={s.notes} />
      <KeysEditor keys={keys} names={s.keyNames} onKeys={onKeys} />
    </article>
  );

  const summary = (title: string, anchor: string, goLabel: string, r: PlatformReadiness | undefined, extra?: string) => (
    <div className="plat-summary">
      <div>
        <p className="plat-summary-title">
          <b>{title}:</b> {r?.label ?? "?"}
        </p>
        <div className="plat-chips">{r ? r.ready && !extra ? <Chip tone="good">Pronto</Chip> : <Chip tone="warn">{extra ?? "Falta configurar"}</Chip> : null}</div>
        {r && <p className="hint">{extra ? extra : r.detail}.</p>}
        {r?.note && <Notes notes={[r.note]} />}
      </div>
      <button type="button" className="ghost" onClick={() => goTo(anchor)}>
        {goLabel}
      </button>
    </div>
  );

  const voiceDraft = (getPath(draft, "voice.elevenlabsVoiceId") as string | undefined) ?? (getPath(saved, "voice.elevenlabsVoiceId") as string | undefined) ?? "";
  const voiceExtra = props.voiceEngine === "elevenlabs" && status?.voice["elevenlabs"]?.ready && !voiceDraft ? "falta o ID da voz" : undefined;

  return (
    <Section
      id="cfg-plataforma"
      icon={Plug}
      title="Plataforma"
      description="Os motores da Máquina: IA, chaves, voz e imagens. Veja o que está instalado, configurado e testado, cole chaves (só de escrita) e teste a conexão sem editar arquivo."
    >
      {error && (
        <div className="banner">
          <TriangleAlert size={16} color="var(--critical)" /> <div>Não foi possível ler o estado da plataforma ({error}).</div>
          <button type="button" className="ghost" onClick={() => void load()}>
            Tentar de novo
          </button>
        </div>
      )}
      {!status && !error && (
        <p className="muted">
          <LoaderCircle size={14} className="spin" /> Carregando…
        </p>
      )}
      {status && (
        <>
          <h3 className="plat-h">Provedores de IA</h3>
          <div className="plat-grid">{status.providers.map(card)}</div>
          <p className="hint">
            O teste faz uma única chamada fixa ({"{"}"ok": true{"}"}) pelo mesmo caminho que o pipeline usa e guarda só o resultado (sem segredos). No máximo uma por provedor a cada{" "}
            {status.testIntervalSeconds} s. Teste de imagem (visão) ainda não existe: é item futuro.
          </p>
          <h3 className="plat-h">Outros comandos de agente encontrados</h3>
          <ul className="plat-clis">
            {status.detectedClis.map((c) => (
              <li key={c.id}>
                <b>{c.label}</b> <code>{c.command}</code>{" "}
                {c.detected ? <Chip tone="info">detectado, ainda sem suporte</Chip> : <span className="muted">não encontrado</span>}
              </li>
            ))}
          </ul>

          <h3 className="plat-h">Voz e imagens</h3>
          <div className="plat-summaries">
            {summary("Voz", "cfg-voz", "Ir para Voz", status.voice[props.voiceEngine], voiceExtra)}
            {summary("Imagens do vídeo", "cfg-roteiro", "Ir para Roteiro", status.images[props.imageSource])}
          </div>

          <h3 className="plat-h">Chaves e acessos de outros serviços</h3>
          <div className="plat-grid">{status.services.map(serviceCard)}</div>
        </>
      )}
      <ConfirmPaidDialog provider={confirming} onCancel={() => setConfirming(null)} onConfirm={(name) => void runTest(name, true)} />
    </Section>
  );
}
