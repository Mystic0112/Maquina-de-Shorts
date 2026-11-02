/**
 * "Testar conexão" of Configurações > Plataforma: ONE minimal, fixed call to an LLM provider, through the same path the
 * pipeline uses (getProviderByName(name).completeJson). The prompt is fixed on purpose (nothing typed by the user goes
 * into it) and the outcome is a short, already redacted text: never a key, a header or a raw response body.
 * Runs inside scripts/probe_provider.ts (a child process of the dashboard), so keys saved a minute ago are read fresh.
 */
import { z } from "zod";
import { redactSecrets } from "./redact.js";
import { validateJsonText, type LlmProvider } from "./llmClient.js";

export const PROBE_PROMPT = 'Responda somente com o JSON {"ok": true}.';
export const PROBE_SCHEMA = z.object({ ok: z.literal(true) });
export const MAX_PROBE_MESSAGE = 200;

export interface ProbeOutcome {
  ok: boolean;
  /** Short pt-BR text, redacted and clipped. */
  message: string;
  ms?: number;
}

/** One line, secrets masked, at most MAX_PROBE_MESSAGE characters. */
export function safeProbeMessage(text: string): string {
  const oneLine = redactSecrets(text).replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_PROBE_MESSAGE ? `${oneLine.slice(0, MAX_PROBE_MESSAGE - 1)}…` : oneLine;
}

export async function probeProvider(make: () => LlmProvider, timeoutMs: number, now: () => number = Date.now): Promise<ProbeOutcome> {
  const started = now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const provider = make();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Sem resposta em ${Math.round(timeoutMs / 1000)} s (tempo esgotado). Se o modelo é local e ainda estava carregando na memória, tente de novo.`)), timeoutMs);
    });
    const text = await Promise.race([provider.completeJson(PROBE_PROMPT, PROBE_SCHEMA), timeout]);
    const ms = now() - started;
    const checked = validateJsonText(text, PROBE_SCHEMA);
    if (!checked.ok) return { ok: false, message: "A IA respondeu, mas não no formato JSON pedido.", ms };
    return { ok: true, message: safeProbeMessage(`Respondeu em ${(ms / 1000).toFixed(1)} s (modelo ${provider.model}).`), ms };
  } catch (error) {
    return { ok: false, message: safeProbeMessage(error instanceof Error ? error.message : String(error)) || "Falhou sem mensagem.", ms: now() - started };
  } finally {
    clearTimeout(timer);
  }
}
