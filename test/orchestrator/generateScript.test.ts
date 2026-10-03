import { describe, expect, it } from "vitest";
import { resolveScript } from "../../src/shared/settings.js";
import {
  buildLlmScriptSchema,
  buildScriptPrompt,
  countSpokenWords,
  findScriptProblems,
  isWithinTolerance,
  TONE_INSTRUCTIONS,
  toScript,
  wordTolerance,
  type LlmScript,
} from "../../src/orchestrator/stages/02-generateScript.js";
import type { TopicPick } from "../../src/orchestrator/types.js";

const topic: TopicPick = { categoryId: "espaco", categoryLabel: "Espaço", seedPrompt: "uma curiosidade sobre planetas" };
const LIBS = "NASA, Wikimedia Commons";

const words = (n: number, word = "palavra"): string => Array.from({ length: n }, () => word).join(" ");

function scriptWith(sceneCount: number, wordsPerScene: number, extra: Partial<LlmScript> = {}): LlmScript {
  return {
    title: "Um título de teste",
    hook: "Existe um planeta estranho.",
    scenes: Array.from({ length: sceneCount }, () => ({ narration: words(wordsPerScene), footageQuery: "venus planet nasa" })),
    ...extra,
  };
}

describe("buildScriptPrompt with default settings", () => {
  const prompt = buildScriptPrompt(topic, [], resolveScript(), LIBS);

  it("keeps the historical ranges and asks the model for a CTA", () => {
    expect(prompt).toContain("entre 130 e 190 palavras");
    expect(prompt).toContain("4 a 7 cenas");
    expect(prompt).toContain('"cta": curtíssimo');
    expect(prompt).toContain(TONE_INSTRUCTIONS.curioso);
    expect(prompt).toContain(LIBS);
  });
});

describe("buildScriptPrompt with non-default settings", () => {
  const settings = resolveScript({
    minWords: 90,
    maxWords: 120,
    minScenes: 3,
    maxScenes: 5,
    tone: "misterioso",
    cta: "  Inscreva-se para mais mistérios!  ",
  });
  const prompt = buildScriptPrompt(topic, ["Título antigo"], settings, LIBS);

  it("describes the configured tone instead of the default one", () => {
    expect(prompt).toContain(TONE_INSTRUCTIONS.misterioso);
    expect(prompt).not.toContain(TONE_INSTRUCTIONS.curioso);
  });

  it("uses the configured scene range", () => {
    expect(prompt).toContain("3 a 5 cenas");
  });

  it("subtracts the fixed CTA's words from the range the model must write", () => {
    // "Inscreva-se para mais mistérios!" = 4 words -> hook + scenes must total 86-116.
    expect(prompt).toContain("entre 86 e 116 palavras");
    expect(prompt).toContain("acrescenta mais 4");
  });

  it("forbids the model from writing a CTA and quotes the fixed one verbatim (trimmed)", () => {
    expect(prompt).toContain("NÃO escreva CTA");
    expect(prompt).toContain('"Inscreva-se para mais mistérios!"');
    expect(prompt).not.toContain('"cta": curtíssimo');
  });

  it("still includes the quality-gate avoidance list", () => {
    expect(prompt).toContain('- "Título antigo"');
  });

  it("builds a schema without a cta field that enforces the scene range", () => {
    const schema = buildLlmScriptSchema(settings);
    expect(schema.safeParse(scriptWith(2, 30)).success).toBe(false);
    expect(schema.safeParse(scriptWith(6, 15)).success).toBe(false);
    const parsed = schema.parse({ ...scriptWith(3, 30), cta: "Siga o canal!" });
    expect(parsed).not.toHaveProperty("cta");
  });

  it("uses the fixed CTA verbatim in the final script, ignoring any model CTA", () => {
    const script = toScript({ ...scriptWith(3, 30), cta: "Siga o canal!" }, settings, "pt-BR");
    expect(script.cta).toBe("Inscreva-se para mais mistérios!");
  });

  it("validates the spoken length (fixed CTA included) against the configured range", () => {
    const fits = toScript(scriptWith(3, 30), settings, "pt-BR"); // 4 hook + 90 + 4 CTA = 98
    expect(countSpokenWords(fits)).toBe(98);
    expect(findScriptProblems(fits, settings)).toEqual([]);
    const tooLong = toScript(scriptWith(5, 30), settings, "pt-BR"); // 158 words
    expect(findScriptProblems(tooLong, settings).join()).toContain("entre 90 e 120");
  });

  it("scales the tolerance band proportionally", () => {
    expect(wordTolerance(resolveScript())).toEqual({ min: 115, max: 215 });
    expect(wordTolerance(settings)).toEqual({ min: 80, max: 136 });
    expect(isWithinTolerance(toScript(scriptWith(4, 30), settings, "pt-BR"), settings)).toBe(true); // 128
    expect(isWithinTolerance(toScript(scriptWith(5, 30), settings, "pt-BR"), settings)).toBe(false); // 158
  });
});

describe("model-written CTA", () => {
  it("is required when no fixed CTA is configured", () => {
    const settings = resolveScript({ cta: "   " });
    const schema = buildLlmScriptSchema(settings);
    expect(schema.safeParse(scriptWith(4, 35)).success).toBe(false);
    const script = toScript({ ...scriptWith(4, 35), cta: " Siga o canal! " }, settings, "pt-BR");
    expect(script.cta).toBe("Siga o canal!");
  });
});
