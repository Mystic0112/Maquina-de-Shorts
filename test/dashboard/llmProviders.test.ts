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

  it("lists every registered provider and task, and never carries a key value", () => {
    const catalog = llmCatalog();
    expect(catalog.providers.map((p) => p.name)).toEqual([...LLM_PROVIDER_NAMES]);
    expect(catalog.tasks.map((t) => t.id)).toEqual([...LLM_TASK_NAMES]);
    expect(JSON.stringify(catalog)).not.toMatch(/AIza|sk-ant/);
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
