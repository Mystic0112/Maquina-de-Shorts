import { describe, expect, it, vi } from "vitest";
import { buildHumorPrompt, DURATION, EMOJIS, emojiModel, humorEnabled, planHumor, validateHumor } from "../../src/orchestrator/cuts/humor.js";
import { livelyMoments } from "../../src/orchestrator/cuts/jumpcut.js";
import type { LlmProvider } from "../../src/orchestrator/lib/llmClient.js";

const w = (word: string, start: number, end: number) => ({ word, start, end });

describe("cuts humor layer: plan validation", () => {
  const start = 100;
  const end = 160; // 60 s clip
  const keep: [number, number][] = [[100, 130], [135, 160]];

  it("converts to absolute time, keeps only items on kept footage, spaces and caps them", () => {
    const plan = validateHumor(
      {
        jokes: [{ at: 5, text: "risos stage 3" }, { at: 8, text: "*cedo demais*" }, { at: 32, text: "*no corte*" }, { at: 40, text: "*  gargalhadas   repletas de remap *" }, { at: 70, text: "*fora*" }],
        emojis: [{ at: 1, emoji: "😂" }, { at: 3, emoji: "😂" }, { at: 20, emoji: "🦄" }, { at: 21, emoji: "🔥" }],
        effects: [{ at: 10, type: "flash", text: "errado demais da conta" }, { at: 10.5, type: "punch" }, { at: 50, type: "spotlight", text: "x" }],
      },
      start,
      end,
      keep,
    );
    expect(plan.jokes).toEqual([
      { start: 105, end: 105 + DURATION.joke, text: "*risos stage 3*" },
      { start: 140, end: 140 + DURATION.joke, text: "*gargalhadas repletas de remap*" },
    ]); // 8 s too soon after the first, 32 s is cut out, 70 s is past the end
    expect(plan.emojis.map((e) => [e.start, e.emoji])).toEqual([[101, "😂"], [121, "🔥"]]); // 3 s too soon, 🦄 not allowed
    expect(plan.effects).toEqual([
      { start: 110, end: 110 + DURATION.flash, type: "flash", text: "ERRADO DEMAI" },
      { start: 150, end: 150 + DURATION.spotlight, type: "spotlight", text: null },
    ]);
  });

  it("is on by default for vlogs only, and the channel setting wins", () => {
    expect(humorEnabled({ style: "vlog" })).toBe(true);
    expect(humorEnabled({ style: "podcast" })).toBe(false);
    expect(humorEnabled({ style: "vlog", humor: false })).toBe(false);
    expect(humorEnabled({ style: "podcast", humor: true })).toBe(true);
  });

  it("gives the agy the timed speech, the laughs and the rules", () => {
    const prompt = buildHumorPrompt({ title: "T", channelName: "ACF", start: 100, end: 160, words: [w("isso", 101, 101.3), w("explodiu!", 101.4, 102), w("calma", 110, 110.5)], lively: [[103, 105]] });
    expect(prompt).toContain("[1.0] isso explodiu!");
    expect(prompt).toContain("[10.0] calma");
    expect(prompt).toContain("3.0-5.0");
    expect(prompt).toMatch(/nunca da pessoa/);
    for (const emoji of Object.keys(EMOJIS)) expect(prompt).toContain(emoji);
  });

  it("pins the emoji images to a Noto commit and never blocks the clip when the agy fails", async () => {
    expect(emojiModel("😂").url).toMatch(/noto-emoji\/raw\/[0-9a-f]{40}\/3D\/png\/512\/emoji_u1f602\.png$/);
    const provider = { name: "f", model: "m", completeJson: vi.fn(async () => "not json"), completeGroundedText: vi.fn() } as unknown as LlmProvider;
    const log = vi.fn();
    await expect(planHumor({ title: "T", channelName: "C", start: 0, end: 10, words: [], lively: [] }, [[0, 10]], { provider, log })).resolves.toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/humor plan skipped/));
  });
});

describe("laugh moments", () => {
  it("finds loud word-free gaps, ignores quiet ones", () => {
    const db = Array.from({ length: 100 }, (_, i) => (i >= 20 && i < 40 ? -60 : -20)); // 2-4 s quiet
    const words = [w("a", 0, 1), w("b", 2, 3), w("c", 4, 5), w("d", 6.5, 7)];
    // gap 1-2 loud (laugh), 3-4 quiet, 5-6.5 loud
    expect(livelyMoments(words, { hop: 0.1, db }, 0, 8)).toEqual([[1, 2], [5, 6.5]]);
    expect(livelyMoments(words, undefined, 0, 8)).toEqual([]);
  });
});
