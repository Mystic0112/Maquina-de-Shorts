// Configurações > Chaves e acessos: API keys the panel can store (secrets/api-keys.json, outside git). Write-only: the
// server only says whether each key is set and where it comes from; the typed value is cleared right after sending.
import { CircleCheck, CircleX, LoaderCircle, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { KeyStatus, KeyWriteResponse } from "../shared/api";

const send = async (name: string, method: "PUT" | "DELETE", value?: string): Promise<KeyWriteResponse> => {
  const res = await fetch(`/api/keys/${encodeURIComponent(name)}`, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    ...(method === "PUT" ? { body: JSON.stringify({ value }) } : {}),
  });
  return (await res.json().catch(() => ({ ok: false, message: `HTTP ${res.status}` }))) as KeyWriteResponse;
};

export function KeysEditor() {
  const [keys, setKeys] = useState<KeyStatus[] | null>(null);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      setKeys(((await (await fetch("/api/keys", { headers: { Accept: "application/json" } })).json()) as { keys: KeyStatus[] }).keys);
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), bad: true });
    }
  }, []);
  useEffect(() => void load(), [load]);

  const run = async (name: string, method: "PUT" | "DELETE") => {
    const value = typed[name] ?? "";
    setBusy(name);
    setMsg(null);
    // Never keep the secret in page state after sending it.
    setTyped((t) => ({ ...t, [name]: "" }));
    try {
      const out = await send(name, method, value);
      setMsg({ text: out.message, bad: !out.ok });
      if (out.keys) setKeys(out.keys);
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), bad: true });
    } finally {
      setBusy(null);
    }
  };

  if (!keys) return <p className="hint">{msg ? msg.text : "Carregando chaves…"}</p>;
  return (
    <div className="key-list">
      {keys.map((k) => (
        <div key={k.name} className="key-row key-edit">
          <div>
            <b>{k.label}</b>
            <span className="mono muted">{k.name}</span>
          </div>
          <div className="key-actions">
            {k.configured ? (
              <span className="badge good">
                <CircleCheck size={13} /> configurada{k.source ? ` (${k.source})` : ""}
              </span>
            ) : (
              <span className="badge warn">
                <CircleX size={13} /> não configurada
              </span>
            )}
            <input
              type="password"
              className="input"
              autoComplete="off"
              spellCheck={false}
              placeholder={k.configured ? "colar para trocar" : "colar a chave"}
              aria-label={`Chave ${k.label}`}
              value={typed[k.name] ?? ""}
              onChange={(e) => setTyped((t) => ({ ...t, [k.name]: e.target.value }))}
            />
            <button type="button" className="ghost icon-btn" disabled={busy !== null || !(typed[k.name] ?? "").trim()} onClick={() => void run(k.name, "PUT")} aria-label={`Guardar ${k.name}`}>
              {busy === k.name ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}
            </button>
            {k.source === "painel" && (
              <button type="button" className="ghost icon-btn" disabled={busy !== null} onClick={() => void run(k.name, "DELETE")} aria-label={`Remover ${k.name}`}>
                <Trash2 size={15} />
              </button>
            )}
          </div>
        </div>
      ))}
      {msg && <p className={msg.bad ? "bad-text" : "ok-text"}>{msg.text}</p>}
    </div>
  );
}
