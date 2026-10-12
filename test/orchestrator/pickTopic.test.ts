import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveScript } from "../../src/shared/settings.js";
import { latestFormat, pickFormat, readPreviousFormat } from "../../src/orchestrator/stages/01-pickTopic.js";

/** Deterministic PRNG (mulberry32) so the rotation statistics are stable. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("narrative format rotation", () => {
  const formats = resolveScript().formats;

  it("never repeats the previous run's format", () => {
    const random = seeded(1);
    let previous: string | undefined;
    for (let i = 0; i < 500; i++) {
      const format = pickFormat(formats, previous, random);
      expect(format).not.toBe(previous);
      previous = format;
    }
  });

  it("keeps mito-verdade at or below ~20% of runs and uses every format", () => {
    const random = seeded(42);
    const counts = new Map<string, number>();
    let previous: string | undefined;
    const runs = 6000;
    for (let i = 0; i < runs; i++) {
      previous = pickFormat(formats, previous, random);
      if (previous) counts.set(previous, (counts.get(previous) ?? 0) + 1);
    }
    expect((counts.get("mito-verdade") ?? 0) / runs).toBeLessThanOrEqual(0.2);
    expect([...counts.keys()].sort()).toEqual([...formats].sort());
  });

  it("a single configured format is always used; no formats = none", () => {
    expect(pickFormat(["lista"], "lista")).toBe("lista");
    expect(pickFormat([], undefined)).toBeUndefined();
  });

  it("previous format = newest run that recorded one", () => {
    const runs = [
      { createdAt: "2026-10-01T10:00:00Z", topic: { categoryId: "a", categoryLabel: "A", seedPrompt: "p", format: "lista" } },
      { createdAt: "2026-10-02T10:00:00Z", topic: { categoryId: "a", categoryLabel: "A", seedPrompt: "p", format: "e-se" } },
      { createdAt: "2026-10-03T10:00:00Z", topic: { categoryId: "a", categoryLabel: "A", seedPrompt: "p" } }, // legacy run
    ];
    expect(latestFormat(runs)).toBe("e-se");
    expect(latestFormat([])).toBeUndefined();
  });

  it("reads the previous format from render_output, skipping the current run", async () => {
    const root = mkdtempSync(join(tmpdir(), "formats-"));
    const write = (runId: string, createdAt: string, format?: string): void => {
      mkdirSync(join(root, runId));
      const topic = { categoryId: "a", categoryLabel: "A", seedPrompt: "p", ...(format ? { format } : {}) };
      writeFileSync(join(root, runId, "context.json"), JSON.stringify({ runId, createdAt, topic }));
    };
    write("20261010-090000-aaaa", "2026-10-10T09:00:00Z", "comparacao");
    write("20261011-090000-bbbb", "2026-10-11T09:00:00Z", "linha-do-tempo");
    write("20261012-090000-cccc", "2026-10-12T09:00:00Z", "lista");
    expect(await readPreviousFormat("20261012-090000-cccc", root)).toBe("linha-do-tempo");
    expect(await readPreviousFormat("x", join(root, "missing"))).toBeUndefined();
  });
});
