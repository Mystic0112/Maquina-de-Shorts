/**
 * Used by the dashboard (Configurações > Plataforma > "Testar conexão"): one minimal call to an LLM provider.
 *
 *   tsx scripts/probe_provider.ts <provider> [timeoutMs]
 *
 * Prints exactly one JSON line {ok, message, ms}. Never prints a key (messages go through redactSecrets).
 */
import { getProviderByName } from "../src/orchestrator/lib/llmClient.js";
import { probeProvider, safeProbeMessage } from "../src/orchestrator/lib/providerProbe.js";
import { isLlmProviderName } from "../src/shared/settings.js";

const [name = "", timeoutArg] = process.argv.slice(2);
const timeoutMs = Math.min(Math.max(Number(timeoutArg) || 30_000, 1000), 120_000);

const outcome = isLlmProviderName(name)
  ? await probeProvider(() => getProviderByName(name), timeoutMs)
  : { ok: false, message: safeProbeMessage("Provedor desconhecido.") };
console.log(JSON.stringify(outcome));
// CLI providers may leave handles open; the answer is already printed.
process.exit(0);
