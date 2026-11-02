// "IA por tarefa": which LLM providers can be chosen right now. Built from the registry in
// src/shared/settings.ts (LLM_PROVIDERS, LLM_TASKS); never reveals a key, only whether it is set.
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { isLocalBaseUrl, isPaidLlmProvider, LLM_PROVIDERS, LLM_TASKS, parseOpenAiBaseUrl, type LlmProviderMeta, type LlmProviderName, type LlmSettings } from "../../src/shared/settings.js";
import type { KeyStatus, LlmCatalog, LlmProviderStatus } from "../shared/api.js";
import { envValue } from "./config.js";
import { storableKeyStatus } from "./keys.js";

/** True when `command` is a file on PATH (or an existing path); Windows also tries the PATHEXT extensions. */
export function commandExists(command: string, pathVar = process.env["PATH"] ?? "", platform: NodeJS.Platform = process.platform): boolean {
  if (!command) return false;
  const exts = platform === "win32" ? ["", ...(process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase())] : [""];
  const dirs = /[\\/]/.test(command) ? [""] : pathVar.split(delimiter).filter(Boolean);
  return dirs.some((dir) => exts.some((ext) => existsSync(dir ? join(dir, command + ext) : command + ext)));
}

/**
 * "openai-compatible" is usable once a valid base URL is saved (llm.openaiCompatible.baseUrl), plus the key when that
 * server is not on this computer / local network. It is "paid" unless the URL is local (isPaidLlmProvider).
 */
function openAiCompatibleStatus(keys: readonly KeyStatus[], llm: LlmSettings | undefined): LlmProviderStatus {
  const p = LLM_PROVIDERS["openai-compatible"];
  const base = { name: "openai-compatible", label: p.label, paid: isPaidLlmProvider("openai-compatible", llm) };
  const raw = llm?.openaiCompatible?.baseUrl?.trim();
  if (!raw) return { ...base, available: false, reason: "falta a URL base (preencha em \"Servidor OpenAI-compatível\", nesta seção)" };
  const url = parseOpenAiBaseUrl(raw);
  if (!url.ok) return { ...base, available: false, reason: url.error };
  const hasKey = keys.some((k) => k.name === p.keyEnv && k.configured);
  if (!isLocalBaseUrl(url.url) && !hasKey) return { ...base, available: false, reason: `falta a chave ${p.keyEnv} (em Chaves e acessos); só servidores locais dispensam a chave` };
  return { ...base, available: true };
}

export function llmProviderStatus(
  keys: readonly KeyStatus[] = storableKeyStatus(),
  exists: (cmd: string) => boolean = commandExists,
  llm?: LlmSettings,
): LlmProviderStatus[] {
  return (Object.keys(LLM_PROVIDERS) as LlmProviderName[]).map((name) => {
    if (name === "openai-compatible") return openAiCompatibleStatus(keys, llm);
    const p: LlmProviderMeta = LLM_PROVIDERS[name];
    const base = { name, label: p.label, paid: p.paid, ...(p.note ? { note: p.note } : {}) };
    if (p.keyEnv) {
      const available = keys.some((k) => k.name === p.keyEnv && k.configured);
      return { ...base, available, ...(available ? {} : { reason: `falta a chave ${p.keyEnv} (em Chaves e acessos)` }) };
    }
    const command = envValue(p.commandEnv ?? "ANTIGRAVITY_CLI_PATH") ?? p.command;
    const available = exists(command);
    return { ...base, available, ...(available ? {} : { reason: `comando "${command}" não encontrado neste computador` }) };
  });
}

export function llmCatalog(llm?: LlmSettings): LlmCatalog {
  return {
    providers: llmProviderStatus(storableKeyStatus(), commandExists, llm),
    tasks: Object.entries(LLM_TASKS).map(([id, t]) => ({ id, label: t.label, hint: t.hint })),
  };
}
