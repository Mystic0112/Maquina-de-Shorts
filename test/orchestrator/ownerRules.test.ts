import { describe, expect, it } from "vitest";
import { buildRevisionPrompt } from "../../src/orchestrator/stages/02b-factCheck.js";
import { buildScriptPrompt } from "../../src/orchestrator/stages/02-generateScript.js";
import { cleanOwnerRules, OWNER_RULES_MAX_CHARS, ownerRulesBlock } from "../../src/orchestrator/lib/ownerRules.js";
import { resolveScript, ScriptSettingsSchema } from "../../src/shared/settings.js";
import type { Script, TopicPick } from "../../src/orchestrator/types.js";

const topic: TopicPick = { categoryId: "espaco", categoryLabel: "Espaço", seedPrompt: "uma curiosidade sobre planetas" };
const LIBS = "NASA, Wikimedia Commons";
const RULES = "Sempre termine com uma pergunta para o público.\nNunca fale de política.";

const script: Script = {
  title: "A Lua tem cheiro",
  overlayText: "A LUA TEM CHEIRO?",
  hook: "A Lua tem cheiro de pólvora.",
  scenes: [{ narration: "Os astronautas sentiram isso.", footageQuery: "moon surface nasa" }],
  cta: "",
  language: "pt-BR",
};

describe("Configurações > Roteiro: instruções livres do dono", () => {
  it("is optional, bounded to 1000 characters and empty by default", () => {
    expect(resolveScript().instructions).toBe("");
    expect(ScriptSettingsSchema.safeParse({ instructions: RULES }).success).toBe(true);
    expect(ScriptSettingsSchema.safeParse({}).success).toBe(true);
    expect(ScriptSettingsSchema.safeParse({ instructions: "x".repeat(OWNER_RULES_MAX_CHARS + 1) }).success).toBe(false);
  });

  it("cleans control characters, long runs of blank lines and the length", () => {
    expect(cleanOwnerRules("  a\u0000b\r\n\r\n\r\n\r\nc  ")).toBe("a b\n\nc");
    expect(cleanOwnerRules(undefined)).toBe("");
    expect(cleanOwnerRules("y".repeat(5000))).toHaveLength(OWNER_RULES_MAX_CHARS);
  });

  it("puts the rules in the script prompt below the machine's rules and says the fixed rules win", () => {
    const prompt = buildScriptPrompt(topic, [], resolveScript({ instructions: RULES }), LIBS);
    expect(prompt).toContain("Regras do dono do canal");
    expect(prompt).toContain("Sempre termine com uma pergunta para o público.");
    expect(prompt).toContain("sempre vencem");
    // after the fixed content rules, before the footage rules and the closing line
    expect(prompt.indexOf("Regras do dono do canal")).toBeGreaterThan(prompt.indexOf("Regras de conteúdo:"));
    expect(prompt.indexOf("Regras do dono do canal")).toBeLessThan(prompt.lastIndexOf("Responda somente com o JSON"));
  });

  it("leaves the script prompt exactly as before when the owner wrote nothing", () => {
    const plain = buildScriptPrompt(topic, [], resolveScript(), LIBS);
    expect(plain).not.toContain("Regras do dono do canal");
    expect(buildScriptPrompt(topic, [], resolveScript({ instructions: "   \n " }), LIBS)).toBe(plain);
  });

  it("gives the same rules to the fact-check rewrite so it does not undo the style", () => {
    const review = { text: "ok", sources: [], queries: [] };
    const withRules = buildRevisionPrompt(script, review, resolveScript({ instructions: RULES }));
    expect(withRules).toContain("Regras de estilo do dono do canal");
    expect(withRules).toContain("Nunca fale de política.");
    expect(buildRevisionPrompt(script, review, resolveScript())).not.toContain("Regras de estilo do dono do canal");
  });

  it("returns an empty block (no stray blank lines) for empty rules", () => {
    expect(ownerRulesBlock("", "script")).toBe("");
    expect(ownerRulesBlock(RULES, "script").endsWith("\n\n")).toBe(true);
  });
});
