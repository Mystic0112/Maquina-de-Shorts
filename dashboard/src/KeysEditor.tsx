// Configurações > Plataforma: API keys the panel can store (secrets/api-keys.json, outside git). Write-only: the
// server only says whether each key is set and where it comes from; the typed value is cleared right after sending.
import { CircleCheck, CircleX, LoaderCircle, Save, Trash2 } from "lucide-react";
import { useState } from "react";
import type { KeyStatus, KeyWriteResponse } from "../shared/api";

const send = async (name: string, method: "PUT" | "DELETE", value?: string): Promise<KeyWriteResponse> => {
  const res = await fetch(`/api/keys/${encodeURIComponent(name)}`, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    ...(method === "PUT" ? { body: JSON.stringify({ value }) } : {}),
  });
  return (await res.json().catch(() => ({ ok: false, message: `HTTP ${res.status}` }))) as KeyWriteResponse;
};

/**
 * Rows for the given storable keys (`names`; all when omitted). The statuses come from the parent (Plataforma loads them
 * once), and `onKeys` hands back the new statuses after a save/remove so every card stays in step.
 */
export function KeysEditor(props: { keys: readonly KeyStatus[]; names?: readonly string[]; onKeys: (keys: KeyStatus[]) => void }) {
  const { names, onKeys } = props;
  const keys = names ? props.keys.filter((k) => names.includes(k.name)) : props.keys;
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);

  const run = async (name: string, method: "PUT" | "DELETE") => {
    const value = typed[name] ?? "";
    setBusy(name);
    setMsg(null);
    // Never keep the secret in page state after sending it.
    setTyped((t) => ({ ...t, [name]: "" }));
    try {
      const out = await send(name, method, value);
      setMsg({ text: out.message, bad: !out.ok });
      if (out.keys) onKeys(out.keys);
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), bad: true });
    } finally {
      setBusy(null);
    }
  };

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
