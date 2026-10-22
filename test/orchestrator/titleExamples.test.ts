import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSelectPrompt } from "../../src/orchestrator/cuts/select.js";
import type { ShortStat } from "../../src/orchestrator/viral/shortsStats.js";
import { cleanTitle, pickTitleExamples, titleExamples, titleExamplesBlock } from "../../src/orchestrator/viral/titleExamples.js";

const row = (channelId: string, title: string, ratio: number, label: ShortStat["label"] = "viral", group = "cortes"): ShortStat => ({ channelId, channelName: channelId, subscribers: 1, group, videoId: title, title, views: 1, position: 20, ratio, label });

describe("viral titles as style examples", () => {
  it("cleans hashtags/mentions and drops too short titles", () => {
    expect(cleanTitle("Alemão da caravan SE PERDEU MUITO NESSA KKKKK @ACF #fyp")).toBe("Alemão da caravan SE PERDEU MUITO NESSA KKKKK");
    expect(cleanTitle("#shorts oi")).toBeNull();
  });

  it("takes the most viral of the group, at most 2 per channel, no repeats", () => {
    const rows = [row("a", "Título A um bem viral", 50), row("a", "Título A dois bem viral", 40), row("a", "Título A três bem viral", 30), row("b", "Título B um bem viral", 20), row("b", "Título B um bem viral", 19), row("c", "Título C normal demais", 99, "normal"), row("d", "Título D curiosidade boa", 99, "viral", "curiosidades")];
    expect(pickTitleExamples(rows, "cortes", 10)).toEqual(["Título A um bem viral", "Título A dois bem viral", "Título B um bem viral"]);
    expect(pickTitleExamples(rows, "curiosidades", 10)).toEqual(["Título D curiosidade boa"]);
  });

  it("reads the collected file when present and goes into the cuts prompt as style only", () => {
    const file = join(mkdtempSync(join(tmpdir(), "viral-")), "shorts.jsonl");
    writeFileSync(file, `${JSON.stringify(row("a", "Tcar revelou os carro que são difícil vender🤯💰", 90))}\n`);
    expect(titleExamples("cortes", 5, file)).toEqual(["Tcar revelou os carro que são difícil vender🤯💰"]);
    expect(titleExamples("cortes", 5, join(tmpdir(), "nao-existe.jsonl"))).toEqual([]);
    const prompt = buildSelectPrompt({ channelName: "ACF", videoTitle: "T", transcript: { segments: [], words: [] }, clip: { minSeconds: 45, maxSeconds: 90, perVideo: 1 }, style: "vlog", titleExamples: ["Tcar revelou os carro que são difícil vender🤯💰"] });
    expect(prompt).toContain("VIRALIZARAM em outros canais");
    expect(prompt).toContain("- Tcar revelou os carro");
    expect(titleExamplesBlock([], "cortes")).toBe("");
  });
});
