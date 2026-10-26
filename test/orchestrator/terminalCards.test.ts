import { describe, expect, it } from "vitest";
import { buildTerminalPrompt, unknownNumbers, validateTerminalDraft, type TerminalDraft } from "../../src/orchestrator/lib/terminalCards.js";
import { buildTerminal } from "../../src/remotion/props.js";
import type { RunContext } from "../../src/orchestrator/types.js";

const script = {
  title: "Por Que o SOM Corre 4 VEZES Mais RÁPIDO na ÁGUA?",
  hook: "O som corre quatro vezes mais rápido na água.",
  scenes: [
    { narration: "No ar, o som anda cerca de 343 metros por segundo.", footageQuery: "x" },
    { narration: "Na água passa de 1.500 metros por segundo, porque a água é quase incompressível.", footageQuery: "y" },
    { narration: "Baleias, submarinos e golfinhos usam isso para se comunicar.", footageQuery: "z" },
  ],
};

describe("terminal format: cards only re-show what the narration says", () => {
  it("accepts numbers said as digits or words in the scene, hook or title, and flags new ones", () => {
    expect(unknownNumbers("343 m/s", script.scenes[0]!.narration)).toEqual([]);
    expect(unknownNumbers("1.500 m/s", script.scenes[1]!.narration)).toEqual([]);
    expect(unknownNumbers("4x mais rápido", `${script.hook}`)).toEqual([]); // "quatro"
    expect(unknownNumbers("80% da Terra", script.scenes[0]!.narration)).toEqual(["80"]);
    expect(unknownNumbers("1,5 km", "corre 1,5 quilômetro")).toEqual([]);
  });

  it("validates each card and reports what to fix", () => {
    const draft: TerminalDraft = {
      scenes: [
        { sceneIndex: 0, command: "som --no-ar", kind: "number", value: "343 m/s", label: "no ar" },
        { sceneIndex: 1, command: "som --na-agua", kind: "compare", left: "Ar", right: "Água", leftValue: "343 m/s", rightValue: "1.500 m/s" },
        { sceneIndex: 2, command: "quem usa", kind: "list", items: ["Baleias", "Submarinos", "Golfinhos"], comment: "o oceano é um telefone" },
      ],
    };
    const ok = validateTerminalDraft(draft, script);
    expect(ok.problems).toEqual([]);
    expect(ok.scenes[1]).toEqual({ sceneIndex: 1, command: "som --na-agua", card: { kind: "compare", left: "Ar", right: "Água", leftValue: "343 m/s", rightValue: "1.500 m/s" } });

    const bad = validateTerminalDraft(
      {
        scenes: [
          { sceneIndex: 0, command: "Som No Ar!", kind: "headline", text: "O som anda devagar", highlight: "rápido" },
          { sceneIndex: 1, command: "x", kind: "number", value: "3.000 m/s", label: "no aço" },
        ],
      },
      script,
    );
    expect(bad.problems.join("\n")).toMatch(/cena 0: highlight "rápido" não está no text/);
    expect(bad.problems.join("\n")).toMatch(/cena 1: número\(s\) 3\.000 não aparecem no roteiro/);
    expect(bad.problems.join("\n")).toMatch(/falta o cartão da cena 2/);
  });

  it("prompt lists every scene and forbids new facts", () => {
    const prompt = buildTerminalPrompt(script);
    expect(prompt).toContain("2: Baleias, submarinos e golfinhos");
    expect(prompt).toMatch(/nenhum número, nome ou fato que não esteja/);
  });

  it("times the title card over the hook and each card over its scene", () => {
    const words = "O som corre quatro vezes mais rápido na água. No ar".split(" ").map((w, i) => ({ word: w, startMs: i * 300, endMs: i * 300 + 250 }));
    const ctx = {
      script: { ...script, overlayText: "SOM 4X MAIS RÁPIDO?", cta: "", language: "pt-BR" },
      narration: { words, durationMs: 10_000 },
      terminal: { scenes: script.scenes.map((_, i) => ({ sceneIndex: i, command: `c${i}`, card: { kind: "headline" as const, text: `t${i}` } })) },
    } as unknown as RunContext;
    const timings = [
      { sceneIndex: 0, startMs: 0, endMs: 4000 },
      { sceneIndex: 1, startMs: 4000, endMs: 7000 },
      { sceneIndex: 2, startMs: 7000, endMs: 10_000 },
    ];
    const t = buildTerminal(ctx, timings, 30, 305);
    expect(t.title).toBe("SOM 4X MAIS RÁPIDO?");
    expect(t.titleEndFrame).toBe(80); // 9th word ("água.") ends at 2650 ms
    expect(t.scenes.map((s) => [s.startFrame, s.durationInFrames])).toEqual([
      [80, 40],
      [120, 90],
      [210, 95],
    ]);
  });
});
