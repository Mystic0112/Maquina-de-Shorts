import { describe, expect, it } from "vitest";
import { labelChannel, MIN_LABELLED, parseShortsTab, SKIP_NEWEST, tallyCandidates } from "../../src/orchestrator/viral/shortsStats.js";

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

  it("labels against the channel's own median, skipping the newest Shorts", () => {
    // 10 newest (any views) + 20 settled: median 1000; one breakout at 2.7 M on a 1.8 k-sub channel
    const views = [...Array(SKIP_NEWEST).fill(50), ...Array(18).fill(1000), 2_700_000, 400];
    const rows = labelChannel(parseShortsTab(tab(views), "cortes"));
    expect(rows.slice(0, SKIP_NEWEST).every((r) => r.label === null)).toBe(true);
    expect(rows.find((r) => r.views === 2_700_000)).toMatchObject({ label: "viral", ratio: 2700 });
    expect(rows.find((r) => r.views === 400)?.label).toBe("fraco");
    expect(rows.find((r) => r.views === 1000)?.label).toBe("normal");
  });

  it("leaves a channel unlabelled when it has too few settled Shorts", () => {
    const rows = labelChannel(parseShortsTab(tab(Array(SKIP_NEWEST + MIN_LABELLED - 1).fill(100)), "cortes"));
    expect(rows.every((r) => r.label === null)).toBe(true);
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
