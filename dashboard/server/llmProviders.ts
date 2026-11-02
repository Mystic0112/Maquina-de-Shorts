// "IA por tarefa": which LLM providers can be chosen right now. Built from the registry in
// src/shared/settings.ts (LLM_PROVIDERS, LLM_TASKS); never reveals a key, only whether it is set.
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { LLM_PROVIDERS, LLM_TASKS, type LlmProviderName } from "../../src/shared/settings.js";
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

export function llmProviderStatus(keys: readonly KeyStatus[] = storableKeyStatus(), exists: (cmd: string) => boolean = commandExists): LlmProviderStatus[] {
  return (Object.keys(LLM_PROVIDERS) as LlmProviderName[]).map((name) => {
    const p = LLM_PROVIDERS[name];
    const base = { name, label: p.label, paid: p.paid };
    if (p.keyEnv) {
      const available = keys.some((k) => k.name === p.keyEnv && k.configured);
      return { ...base, available, ...(available ? {} : { reason: `falta a chave ${p.keyEnv} (em Chaves e acessos)` }) };
    }
    const command = envValue("ANTIGRAVITY_CLI_PATH") ?? p.command;
    const available = exists(command);
    return { ...base, available, ...(available ? {} : { reason: `comando "${command}" não encontrado neste computador` }) };
  });
}

export function llmCatalog(): LlmCatalog {
  return {
    providers: llmProviderStatus(),
    tasks: Object.entries(LLM_TASKS).map(([id, t]) => ({ id, label: t.label, hint: t.hint })),
  };
}
