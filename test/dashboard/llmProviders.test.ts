import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { commandExists, llmCatalog, llmProviderStatus } from "../../dashboard/server/llmProviders.js";
import type { KeyStatus } from "../../dashboard/shared/api.js";
import { LLM_PROVIDER_NAMES, LLM_TASK_NAMES } from "../../src/shared/settings.js";

const key = (name: string, configured: boolean): KeyStatus => ({ name, label: name, configured });

describe("providers offered in 'IA por tarefa'", () => {
  it("API providers need their key; agy needs its command; paid is flagged", () => {
    const status = llmProviderStatus([key("GEMINI_API_KEY", true), key("ANTHROPIC_API_KEY", false)], () => false);
    const by = Object.fromEntries(status.map((s) => [s.name, s]));
    expect(by["gemini"]).toMatchObject({ available: true, paid: true });
    expect(by["anthropic"]).toMatchObject({ available: false, paid: true });
    expect(by["anthropic"]!.reason).toMatch(/ANTHROPIC_API_KEY/);
    expect(by["antigravity-cli"]).toMatchObject({ available: false, paid: false });
    expect(by["antigravity-cli"]!.reason).toMatch(/não encontrado/);
    expect(llmProviderStatus([], () => true).find((s) => s.name === "antigravity-cli")?.available).toBe(true);
  });

  it("openai-compatible: usable with a valid base URL (key only when the server is not local); paid unless local", () => {
    const by = (llm: unknown, keys: KeyStatus[] = []) =>
      llmProviderStatus(keys, () => false, llm as never).find((s) => s.name === "openai-compatible")!;
    const noUrl = by(undefined);
    expect(noUrl).toMatchObject({ available: false, paid: true });
    expect(noUrl.reason).toMatch(/URL base/);
    expect(by({ openaiCompatible: { baseUrl: "http://localhost:11434/v1" } })).toMatchObject({ available: true, paid: false });
    expect(by({ openaiCompatible: { baseUrl: "http://192.168.0.5:1234/v1" } })).toMatchObject({ available: true, paid: false });
    const remote = by({ openaiCompatible: { baseUrl: "https://openrouter.ai/api/v1" } });
    expect(remote).toMatchObject({ available: false, paid: true });
    expect(remote.reason).toMatch(/OPENAI_COMPAT_API_KEY/);
    expect(by({ openaiCompatible: { baseUrl: "https://openrouter.ai/api/v1" } }, [key("OPENAI_COMPAT_API_KEY", true)])).toMatchObject({ available: true, paid: true });
    expect(by({ openaiCompatible: { baseUrl: "ftp://x" } })).toMatchObject({ available: false });
  });

  it("lists every registered provider and task, and never carries a key value", () => {
    const catalog = llmCatalog();
    expect(catalog.providers.map((p) => p.name)).toEqual([...LLM_PROVIDER_NAMES]);
    expect(catalog.tasks.map((t) => t.id)).toEqual([...LLM_TASK_NAMES]);
    expect(JSON.stringify(catalog)).not.toMatch(/AIza|sk-ant/);
  });

  it("claude-code: free, usable when `claude` exists, and carries the plan/terms warning", () => {
    const cc = llmProviderStatus([], (cmd) => cmd === "claude").find((s) => s.name === "claude-code")!;
    expect(cc).toMatchObject({ available: true, paid: false });
    expect(cc.note).toMatch(/plano/);
    expect(cc.note).toMatch(/termos/);
    const missing = llmProviderStatus([], () => false).find((s) => s.name === "claude-code")!;
    expect(missing.available).toBe(false);
    expect(missing.reason).toMatch(/"claude"/);
  });

  it("commandExists finds a file on PATH and honours absolute paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "cmd-test-"));
    try {
      writeFileSync(join(dir, "fakeagy"), "");
      expect(commandExists("fakeagy", `/nonexistent${delimiter}${dir}`, "linux")).toBe(true);
      expect(commandExists("fakeagy", "/nonexistent", "linux")).toBe(false);
      expect(commandExists(join(dir, "fakeagy"), "", "linux")).toBe(true);
      expect(commandExists("", dir, "linux")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
