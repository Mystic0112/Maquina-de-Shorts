import { describe, expect, it } from "vitest";
import { resolveScript } from "../../src/shared/settings.js";
import {
  buildLlmScriptSchema,
  buildScriptPrompt,
  countSpokenWords,
  ctaProblems,
  endingProblems,
  estimateSpeechSeconds,
  fallbackCta,
  findCliches,
  findScriptIssues,
  findScriptProblems,
  FORMAT_INSTRUCTIONS,
  hookProblems,
  isWithinTolerance,
  keyTermProblems,
  overlayProblems,
  settleScript,
  TONE_INSTRUCTIONS,
  toScript,
  withEffectiveCta,
  wordTolerance,
  type LlmScript,
} from "../../src/orchestrator/stages/02-generateScript.js";
import type { TopicPick } from "../../src/orchestrator/types.js";

const topic: TopicPick = { categoryId: "espaco", categoryLabel: "Espaço", seedPrompt: "uma curiosidade sobre planetas" };
const LIBS = "NASA, Wikimedia Commons";

const words = (n: number, word = "palavra"): string => Array.from({ length: n }, () => word).join(" ");

/** A script that follows every content rule; only the word count varies. */
function scriptWith(sceneCount: number, wordsPerScene: number, extra: Partial<LlmScript> = {}): LlmScript {
  return {
    title: "O planeta estranho",
    overlayText: "UM PLANETA ESTRANHO?",
    hook: "Existe um planeta estranho.",
    hookFootageQuery: "venus planet nasa",
    scenes: Array.from({ length: sceneCount }, () => ({ narration: `planeta ${words(wordsPerScene - 1)}`, footageQuery: "venus planet nasa" })),
    ...extra,
  };
}

describe("buildScriptPrompt with default settings", () => {
  const prompt = buildScriptPrompt(topic, [], resolveScript(), LIBS);

  it("keeps the historical ranges and asks the model for a CTA", () => {
    expect(prompt).toContain("entre 160 e 195 palavras"); // Gemini TTS pace: see SCRIPT_DEFAULTS
    expect(prompt).toContain("4 a 7 cenas");
    expect(prompt).toContain('"cta": curtíssimo');
    expect(prompt).toContain(TONE_INSTRUCTIONS.curioso);
    expect(prompt).toContain(LIBS);
  });

  it("asks for a short, front-loaded hook and bans the audited clichés", () => {
    expect(prompt).toContain("No máximo 12 palavras");
    expect(prompt).toContain("Nas 5 primeiras palavras: o ASSUNTO CONCRETO");
    expect(prompt).toContain("Pode entregar a resposta surpreendente logo de cara");
    expect(prompt).toContain('"X é visto como..., mas a realidade..."');
  });

  it("requires title words to be said, an overlay text and a loop ending", () => {
    expect(prompt).toContain("Toda palavra importante do título precisa ser DITA no gancho e na narração");
    expect(prompt).toContain('"overlayText": 3 a 5 palavras');
    expect(prompt).toContain('"SÓ 7 PRESOS?"');
    expect(prompt).toContain("se reconecta ao gancho");
  });

  it("CTA: short, varied, never 'canal', avoiding recent ones", () => {
    const withRecent = buildScriptPrompt(topic, [], resolveScript(), LIBS, [], ["Segue pra mais curiosidades."]);
    expect(withRecent).toContain('NUNCA use a palavra "canal"');
    expect(withRecent).toContain('Não repita estes CTAs recentes: "Segue pra mais curiosidades."');
    expect(prompt).not.toMatch(/seguir o canal/);
  });

  it("allows specific, era-matched footage queries and a hook query", () => {
    expect(prompt).toContain('"hookFootageQuery"');
    expect(prompt).toContain("storming of the Bastille painting");
    expect(prompt).toContain("Voyager 2 Uranus");
    expect(prompt).toContain("JÁ FALECIDAS");
    expect(prompt).toContain("NUNCA: pessoas vivas, marcas");
    expect(prompt).toContain("ÉPOCA e o LUGAR");
  });

  it("generic footage rules when specificFootage is off", () => {
    const generic = buildScriptPrompt(topic, [], resolveScript({ specificFootage: false }), LIBS);
    expect(generic).toContain("NUNCA use nomes de pessoas");
    expect(generic).not.toContain("Voyager 2 Uranus");
  });

  it.each(Object.keys(FORMAT_INSTRUCTIONS))("includes the structure of format %s", (format) => {
    const p = buildScriptPrompt({ ...topic, format }, [], resolveScript(), LIBS);
    expect(p).toContain(FORMAT_INSTRUCTIONS[format as keyof typeof FORMAT_INSTRUCTIONS]);
  });

  it("no format line without topic.format (fixtures, legacy runs)", () => {
    expect(prompt).not.toContain("Formato narrativo deste vídeo");
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
    expect(wordTolerance(resolveScript())).toEqual({ min: 142, max: 221 });
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

describe("hook rules", () => {
  it("rejects long or slow hooks", () => {
    expect(hookProblems("A Bastilha tinha só sete presos quando caiu.")).toEqual([]);
    const long = "A tomada da Bastilha é lembrada como a libertação heroica de centenas de inocentes presos.";
    expect(hookProblems(long).join()).toMatch(/no máximo 12 palavras/);
  });

  it("estimates speech time from letters and pauses", () => {
    expect(estimateSpeechSeconds("Em Urano pode chover diamante.")).toBeLessThan(2.5);
    expect(estimateSpeechSeconds("Existe um planeta onde um único dia dura mais do que o ano inteiro.")).toBeGreaterThan(3.2);
  });

  it.each([
    "A Bastilha é vista como a libertação heroica de inocentes, mas a realidade foi outra.",
    "Você sabia que a Lua tem cheiro?",
    "Muita gente acha que Netuno é frio.",
    "O que ninguém te conta sobre Alexandria.",
  ])("flags the cliché in %s", (hook) => {
    expect(findCliches(hook).length).toBeGreaterThan(0);
    expect(hookProblems(hook).join()).toContain("clichê proibido");
  });

  it("does not flag direct statements", () => {
    expect(findCliches("A Lua tem cheiro: de pólvora queimada.")).toEqual([]);
    expect(findCliches("Por que Urano gira deitado?")).toEqual([]);
  });
});

describe("title <-> hook <-> narration key terms", () => {
  const base = {
    title: "Chuva de diamante em Urano e Netuno? A ciência explica!",
    hook: "Em Urano e Netuno pode chover diamante.",
    scenes: [{ narration: "No fundo desses planetas, a pressão transforma carbono em diamante, numa chuva lenta.", footageQuery: "Uranus planet nasa" }],
  };

  it("accepts a script that says every title key word", () => {
    expect(keyTermProblems(base)).toEqual([]);
  });

  it("flags a title promise the narration never says (the 'chuva' audit case)", () => {
    const noRain = {
      ...base,
      hook: "Urano e Netuno escondem diamantes.",
      scenes: [{ narration: "No fundo desses planetas, a pressão transforma carbono em diamante.", footageQuery: "x y" }],
    };
    expect(keyTermProblems(noRain).join()).toContain('O título promete "chuva"');
  });

  it("flags a hook that names the subject too late or not at all", () => {
    const late = { ...base, hook: "Existe um lugar no espaço onde, por incrível que pareça, Urano faz chover diamante." };
    expect(keyTermProblems(late).join()).toContain("aparece tarde");
    const absent = { ...base, hook: "Existe algo brilhante caindo do céu lá fora." };
    expect(keyTermProblems(absent).join()).toContain("O gancho não cita nenhuma palavra-chave");
  });

  it("tolerates plurals and verb forms", () => {
    const venus = {
      title: "O planeta onde o dia dura mais que o ano",
      hook: "Em Vênus, um dia dura mais que um ano.",
      scenes: [{ narration: "Esse planeta gira tão devagar que o dia durou mais que os anos.", footageQuery: "x y" }],
    };
    expect(keyTermProblems(venus)).toEqual([]);
  });

  it("is a hard issue in the validator (rejects the run if the retry does not fix it)", () => {
    const script = { ...scriptWith(4, 35), title: "A chuva de diamantes do planeta estranho" };
    const issue = findScriptIssues(script).find((i) => i.message.includes("promete"));
    expect(issue?.hard).toBe(true);
  });
});

describe("overlayText", () => {
  const scenes = [{ narration: "Quando a Bastilha caiu, havia só sete prisioneiros lá dentro.", footageQuery: "x y" }];
  const script = { title: "A Bastilha tinha só sete presos", hook: "A Bastilha tinha só sete presos.", scenes };

  it("accepts 3-5 punchy words consistent with the narration (digits match spelled numbers)", () => {
    expect(overlayProblems({ ...script, overlayText: "SÓ 7 PRESOS?" })).toEqual([]);
    expect(overlayProblems({ ...script, overlayText: "A BASTILHA ESTAVA VAZIA?" })).toEqual([]);
  });

  it("flags missing, too long or unrelated overlay text", () => {
    expect(overlayProblems(script).join()).toContain("Falta o");
    expect(overlayProblems({ ...script, overlayText: "A VERDADE CHOCANTE SOBRE A REVOLUÇÃO FRANCESA" }).join()).toContain("3 a 5 palavras");
    expect(overlayProblems({ ...script, overlayText: "CHOVE DIAMANTE EM URANO" }).join()).toContain("não repete nenhuma palavra");
    expect(overlayProblems({ ...script, overlayText: "SÓ 7 PRESOS? 🔥" }).join()).toContain("emoji");
  });
});

describe("CTA styles", () => {
  const curto = resolveScript();

  it("curto: at most 5 words and never 'canal'", () => {
    expect(ctaProblems("Segue pra mais curiosidades.", curto)).toEqual([]);
    expect(ctaProblems("Comenta: você já sabia?", curto)).toEqual([]);
    expect(ctaProblems("Siga o canal para mais curiosidades!", curto).join()).toMatch(/canal/);
    expect(ctaProblems("Siga para mais curiosidades históricas e fascinantes!", curto).join()).toMatch(/no máximo 5/);
  });

  it("nenhum: no CTA in the schema and an empty spoken CTA", () => {
    const none = resolveScript({ ctaStyle: "nenhum" });
    expect(buildLlmScriptSchema(none).parse({ ...scriptWith(4, 35), cta: "Siga!" })).not.toHaveProperty("cta");
    expect(withEffectiveCta({ ...scriptWith(4, 35), cta: "Siga!" }, none).cta).toBe("");
    expect(toScript(scriptWith(4, 35), none, "pt-BR").cta).toBe("");
    expect(buildScriptPrompt(topic, [], none, LIBS)).toContain("NÃO escreva CTA");
    expect(ctaProblems("", none)).toEqual([]);
  });

  it("a fixed config CTA still wins over ctaStyle", () => {
    const fixed = resolveScript({ ctaStyle: "nenhum", cta: "Siga o canal!" });
    expect(toScript(scriptWith(4, 35), fixed, "pt-BR").cta).toBe("Siga o canal!");
    expect(ctaProblems("Siga o canal!", fixed)).toEqual([]);
  });

  it("an invalid model CTA left after the retry is replaced by a varied fallback without 'canal'", () => {
    const raw = withEffectiveCta({ ...scriptWith(4, 34), cta: "Siga o canal para mais curiosidades!" }, curto);
    const settled = settleScript(raw, curto, ["Segue pra mais curiosidades."]);
    expect(settled.ctaReplaced).toBe(true);
    expect(settled.script.cta).not.toMatch(/canal/i);
    expect(settled.script.cta).not.toBe("Segue pra mais curiosidades.");
    expect(settled.hard).toEqual([]);
    expect(fallbackCta("x")).toBe(fallbackCta("x"));
  });

  it("settleScript reports clichés and unsaid title words as hard issues", () => {
    const raw = withEffectiveCta({ ...scriptWith(4, 34), hook: "O planeta estranho é visto como frio, mas a realidade é outra.", cta: "Segue pra mais." }, curto);
    expect(settleScript(raw, curto).hard.join()).toContain("clichê proibido");
  });
});

describe("hookFootageQuery and specific queries", () => {
  it("toScript keeps overlayText and hookFootageQuery", () => {
    const script = toScript({ ...scriptWith(4, 35), cta: "Segue pra mais." }, resolveScript(), "pt-BR");
    expect(script).toMatchObject({ overlayText: "UM PLANETA ESTRANHO?", hookFootageQuery: "venus planet nasa" });
  });

  it("allows up to 6 words with specificFootage, 4 without", () => {
    const query = "storming of the Bastille painting"; // 5 words
    const script = { ...scriptWith(4, 35), cta: "Segue pra mais.", hookFootageQuery: query };
    expect(findScriptProblems(script, resolveScript()).join()).not.toContain("hookFootageQuery");
    expect(findScriptProblems(script, resolveScript({ specificFootage: false })).join()).toContain("hookFootageQuery");
  });
});

describe("loop ending", () => {
  const trailing = { scenes: [{ narration: "E todo mundo esqueceu que...", footageQuery: "x y" }] };

  it("a trailing last line is flagged when a CTA follows it, not when there is no CTA", () => {
    expect(endingProblems(trailing, resolveScript()).join()).toContain("frase completa");
    expect(endingProblems(trailing, resolveScript({ ctaStyle: "nenhum" }))).toEqual([]);
    expect(endingProblems({ scenes: [{ narration: "Ela foi banida em 1898.", footageQuery: "x y" }] }, resolveScript())).toEqual([]);
  });

  it("the prompt asks for a complete final sentence only when a CTA is spoken", () => {
    expect(buildScriptPrompt(topic, [], resolveScript(), LIBS)).toContain("Termine com uma frase COMPLETA");
    expect(buildScriptPrompt(topic, [], resolveScript({ ctaStyle: "nenhum" }), LIBS)).not.toContain("Termine com uma frase COMPLETA");
    expect(buildScriptPrompt(topic, [], resolveScript({ loopEnding: false }), LIBS)).toContain("desfecho satisfatório");
  });
});
