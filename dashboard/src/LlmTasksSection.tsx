// Configurações > IA por tarefa: provider and model per task (config `llm.tasks`), with an optional alternative when the
// provider fails or its quota ends. Only providers that are usable on this computer are offered. An alternative that
// bills per call (API key) is ignored by the pipeline unless the owner turns on "allowPaid" for that very task.
import { Cpu, TriangleAlert } from "lucide-react";
import type { LlmCatalog, LlmProviderStatus } from "../shared/api";
import { getPath, type Json } from "./settingsModel";
import { Field, Section, Switch } from "./settingsUi";

interface TaskDraft {
  provider?: string;
  model?: string;
  fallback?: { provider?: string; model?: string; allowPaid?: boolean };
}

/** Usable providers, plus the one already saved in the file even when it is not usable here (so it is never hidden). */
function offered(providers: readonly LlmProviderStatus[], current: string | undefined, only?: (p: LlmProviderStatus) => boolean): LlmProviderStatus[] {
  return providers.filter((p) => (p.available || p.name === current) && (!only || only(p)));
}

const optionLabel = (p: LlmProviderStatus): string => `${p.label}${p.available ? "" : " (indisponível aqui)"}`;

export function LlmTasksSection(props: {
  draft: Json;
  catalog: LlmCatalog;
  set: (path: string, value: unknown) => void;
  errorAt: (path: string) => string | undefined;
}) {
  const { draft, catalog, set, errorAt } = props;
  const byName = new Map(catalog.providers.map((p) => [p.name, p]));
  const unusable = catalog.providers.filter((p) => !p.available);

  return (
    <Section
      id="cfg-ia"
      icon={Cpu}
      title="IA por tarefa"
      description="Escolha qual IA faz cada tarefa e com qual modelo; várias podem ficar ativas ao mesmo tempo (ex.: roteiro no agy e outra tarefa no Claude). Em branco = o padrão da máquina (LLM_PROVIDER no .env) e os modelos de llm.models."
      onReset={() => set("llm.tasks", undefined)}
      resetLabel="Voltar ao padrão"
    >
      {unusable.length > 0 && (
        <p className="hint">
          Não aparecem para escolher: {unusable.map((p) => `${p.label} (${p.reason ?? "indisponível"})`).join("; ")}.
        </p>
      )}
      <div className="llm-tasks">
        {catalog.tasks.map((t) => {
          const base = `llm.tasks.${t.id}`;
          const task = (getPath(draft, base) ?? {}) as TaskDraft;
          const fb = task.fallback;
          const fbInfo = fb?.provider ? byName.get(fb.provider) : undefined;
          const fbPaid = !!fbInfo?.paid;
          return (
            <div key={t.id} className="llm-task">
              <div className="llm-task-head">
                <b>{t.label}</b>
                <span className="muted">{t.hint}</span>
              </div>
              <div className="cfg-grid">
                <Field label="Provedor" error={errorAt(`${base}.provider`)}>
                  <select className="input" value={task.provider ?? ""} onChange={(e) => set(`${base}.provider`, e.target.value || undefined)}>
                    <option value="">Padrão da máquina</option>
                    {offered(catalog.providers, task.provider).map((p) => (
                      <option key={p.name} value={p.name}>
                        {optionLabel(p)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Modelo" error={errorAt(`${base}.model`)} help="Nome do modelo desse provedor. Vazio = padrão do provedor.">
                  <input className="input" value={task.model ?? ""} placeholder="padrão" onChange={(e) => set(`${base}.model`, e.target.value || undefined)} />
                </Field>
                <Field label="Se falhar ou a cota acabar" error={errorAt(`${base}.fallback.provider`)}>
                  <select
                    className="input"
                    value={fb?.provider ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (!v) return set(`${base}.fallback`, undefined);
                      set(`${base}.fallback.provider`, v);
                      if (!byName.get(v)?.paid) set(`${base}.fallback.allowPaid`, undefined);
                    }}
                  >
                    <option value="">Sem alternativa</option>
                    {offered(catalog.providers, fb?.provider).map((p) => (
                      <option key={p.name} value={p.name}>
                        {optionLabel(p)}
                        {p.paid ? " - gasta dinheiro" : ""}
                      </option>
                    ))}
                  </select>
                </Field>
                {fb?.provider && (
                  <Field label="Modelo da alternativa" error={errorAt(`${base}.fallback.model`)} help="Vazio = padrão da alternativa.">
                    <input className="input" value={fb.model ?? ""} placeholder="padrão" onChange={(e) => set(`${base}.fallback.model`, e.target.value || undefined)} />
                  </Field>
                )}
              </div>
              {fbPaid && (
                <div className="banner">
                  <TriangleAlert size={16} color="var(--critical)" />
                  <div>
                    <b>{fbInfo?.label} cobra por chamada.</b> Só é usado se você permitir abaixo; sem a permissão, a alternativa é ignorada e a tarefa falha normalmente.
                    <Switch label="Permitir gastar com a API paga nesta tarefa" checked={fb?.allowPaid === true} onChange={(v) => set(`${base}.fallback.allowPaid`, v ? true : undefined)} />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}
