import { describe, expect, it } from "vitest";
import { buildLayaSets, isEvalChannel, labelChannel, withTitles, MIN_LABELLED, MIN_MEDIAN_VIEWS, parseShortsTab, SKIP_NEWEST, tallyCandidates, VIRAL_QUESTION } from "../../src/orchestrator/viral/shortsStats.js";

const tab = (views: (number | null)[]) => ({
  channel: "Cortes X",
  channel_id: "UCxxxxxxxxxxxxxxxxxxxxxx",
  channel_follower_count: 1790,
  entries: views.map((v, i) => ({ id: `v${i}`, title: `Título ${i}`, view_count: v })),
});

describe("viral training data from other channels' Shorts", () => {
  it("parses a flat Shorts tab and drops entries without views", () => {
    const rows = parseShortsTab(tab([10, null, 30]), "cortes");
    expect(rows.map((r) => [r.videoId, r.views, r.position])).toEqual([["v0", 10, 0], ["v2", 30, 2]]);
    expect(rows[0]).toMatchObject({ channelName: "Cortes X", subscribers: 1790, group: "cortes", label: null });
  });

  it("keeps the numbers of the default listing and the titles of the original-language one", () => {
    const rows = parseShortsTab(tab([22000, 1900]), "cortes");
    const pt = { entries: [{ id: "v0", title: "O que esperar do segundo turno?", view_count: 23 }] };
    expect(withTitles(rows, pt).map((r) => [r.title, r.views])).toEqual([["O que esperar do segundo turno?", 22000], ["Título 1", 1900]]);
  });

  it("labels against the channel's own median, skipping the newest Shorts", () => {
    // 10 newest (any views) + 20 settled: median 1000; one breakout at 2.7 M on a 1.8 k-sub channel
    const views = [...Array(SKIP_NEWEST).fill(50), ...Array(18).fill(1000), 2_700_000, 400];
    const rows = labelChannel(parseShortsTab(tab(views), "cortes"));
    expect(rows.slice(0, SKIP_NEWEST).every((r) => r.label === null)).toBe(true);
    expect(rows.find((r) => r.views === 2_700_000)).toMatchObject({ label: "viral", ratio: 2700 });
    expect(rows.find((r) => r.views === 400)?.label).toBe("fraco");
    expect(rows.find((r) => r.views === 1000)?.label).toBe("normal");
  });

  it("leaves a channel unlabelled when it has too few settled Shorts or too few views to compare", () => {
    const few = labelChannel(parseShortsTab(tab(Array(SKIP_NEWEST + MIN_LABELLED - 1).fill(5000)), "cortes"));
    expect(few.every((r) => r.label === null)).toBe(true);
    const tiny = labelChannel(parseShortsTab(tab([...Array(SKIP_NEWEST + 20).fill(10), 282]), "curiosidades"));
    expect(tiny.every((r) => r.label === null)).toBe(true);
    expect(MIN_MEDIAN_VIEWS).toBe(1000);
  });

  it("ranks channels by how often the theme searches return them", () => {
    const hit = (id: string) => ({ channel_id: id, channel: id.toUpperCase() });
    const out = tallyCandidates([
      { query: "a", json: { entries: [hit("c1"), hit("c2"), hit("c1")] } },
      { query: "b", json: { entries: [hit("c1"), { channel_id: null }] } },
    ]);
    expect(out.map((c) => [c.channelId, c.hits, c.queries])).toEqual([["c1", 3, ["a", "b"]], ["c2", 1, ["a"]]]);
  });
});

describe("Laya training sets", () => {
  const row = (channelId: string, i: number, label: "viral" | "normal" | "fraco" | null) =>
    ({ channelId, channelName: channelId, subscribers: null, group: "cortes", videoId: `${channelId}-${i}`, title: `T${i}`, views: 1, position: 20, ratio: 1, label }) as const;

  it("splits by whole channels, balances train negatives and keeps eval's real proportion", () => {
    const channels = Array.from({ length: 40 }, (_, c) => `UC${String(c).padStart(22, "0")}`);
    const rows = channels.flatMap((id) => [row(id, 0, "viral"), ...Array.from({ length: 9 }, (_, i) => row(id, i + 1, i % 2 ? "normal" : "fraco")), row(id, 99, null)]);
    const { train, eval: evalRows } = buildLayaSets(rows, 3);
    const evalIds = new Set(channels.filter((id) => isEvalChannel(id)));
    expect(evalIds.size).toBeGreaterThan(0);
    expect(evalRows).toHaveLength(evalIds.size * 10); // unlabelled rows never used
    expect(evalRows.filter((r) => r.expected.viral)).toHaveLength(evalIds.size);
    const pos = train.filter((r) => r.expected.viral).length;
    expect(pos).toBe(40 - evalIds.size);
    expect(train.length - pos).toBeLessThanOrEqual(pos * 3 + 3);
    expect(train[0]).toMatchObject({ state: "Tema: cortes. Título do Short: T0", questions: VIRAL_QUESTION, expected: { viral: true } });
  });
});
