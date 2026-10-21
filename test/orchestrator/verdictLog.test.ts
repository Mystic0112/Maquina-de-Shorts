import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { collectRuns, datasetInfo, exportDataset, isValidationRun } from "../../scripts/export_verdicts_dataset.js";
import type { Logger } from "../../src/orchestrator/lib/logger.js";
import { buildRelevancePrompt, penalizeLowResolution, type ScoredClip } from "../../src/orchestrator/lib/relevance.js";
import { pruneRuns } from "../../src/orchestrator/lib/retention.js";
import {
  buildVerdictRecord,
  saveVerdictFrames,
  VERDICTS_FILE,
  writeVerdictLog,
  type VerdictInput,
  type VerdictRecord,
} from "../../src/orchestrator/lib/verdictLog.js";
import { saveVerdicts } from "../../src/orchestrator/stages/03-fetchFootage.js";
import type { FootageClip } from "../../src/orchestrator/types.js";

const RUN_ID = "20261020-090000-abcd";
const verdict = { score: 8, matches: true, reason: "a fortress", hasTextOrLogo: false, hasIdentifiablePeople: false, wrongEraOrPlace: false, showsFace: false };
const scene = { narration: "A multidão invadiu a fortaleza.", footageQuery: "Bastille" };

function clip(runDir: string, over: Partial<FootageClip> = {}): FootageClip {
  return {
    sceneIndex: 1, path: join(runDir, "footage", "norm", "1_0.jpg"), kind: "image", durationSeconds: 0, width: 1080, height: 1920,
    source: "wikimedia", sourceUrl: "https://c/x", creator: "c", license: "CC0", ...over,
  };
}

function input(runDir: string, reviewed: ScoredClip, over: Partial<VerdictInput> = {}): VerdictInput {
  return {
    runId: RUN_ID, runDir, reviewed, final: reviewed, scene, title: "T", hook: "H", isHook: false, isRetry: false,
    thinking: "low", batchSize: 1, provider: "antigravity-cli", model: "gemini-3-flash", ...over,
  };
}

const silentLog = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as unknown as Logger;

describe("verdict records", () => {
  const runDir = "/runs/x";

  it("a reviewed clip has every field", () => {
    const reviewed: ScoredClip = { clip: clip(runDir), verdict, prompt: "PROMPT" };
    const r = buildVerdictRecord(input(runDir, reviewed, { sourceSize: { width: 4000, height: 3000 } }), ["verdict_frames/1_0_0.jpg"], new Date(0));
    expect(r).toEqual({
      runId: RUN_ID, sceneIndex: 1, isHook: false, isRetry: false, clipPath: "footage/norm/1_0.jpg", framePaths: ["verdict_frames/1_0_0.jpg"],
      kind: "image", source: "wikimedia", sourceUrl: "https://c/x", creator: "c", license: "CC0", width: 4000, height: 3000,
      context: { title: "T", hook: "H", narration: scene.narration, footageQuery: "Bastille" }, prompt: "PROMPT", verdict,
      provider: "antigravity-cli", model: "gemini-3-flash", thinking: "low", batchSize: 1, penalized: false, selected: false,
      ts: "1970-01-01T00:00:00.000Z",
    });
  });

  it("an errored clip keeps the error and no verdict", () => {
    const r = buildVerdictRecord(input(runDir, { clip: clip(runDir), error: "boom" }), []);
    expect(r).toMatchObject({ error: "boom", framePaths: [], penalized: false });
    expect(r).not.toHaveProperty("verdict");
  });

  it("a beat clip records its beat; a low-res penalty records the score before and after, verdict stays raw", () => {
    const beat = { phrase: "invadiu a fortaleza", footageQuery: "Bastille engraving" };
    const reviewed: ScoredClip = { clip: clip(runDir, { beatIndex: 1 }), verdict };
    const final = penalizeLowResolution(reviewed, { width: 400, height: 300 });
    const r = buildVerdictRecord(input(runDir, reviewed, { final, beat }), []);
    expect(r.beatIndex).toBe(1);
    expect(r.context.beat).toEqual(beat);
    expect(r.verdict?.score).toBe(8);
    expect(r.penalized).toMatchObject({ scoreBefore: 8, scoreAfter: 6, reason: expect.stringContaining("upscaled") });
  });

  it("frames and the jsonl are written under the run dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vl-"));
    const frames = await saveVerdictFrames(dir, join(dir, "footage/norm/0_h1.mp4"), [Buffer.from("a"), Buffer.from("b")]);
    expect(frames).toEqual(["verdict_frames/0_h1_0.jpg", "verdict_frames/0_h1_1.jpg"]);
    expect(readFileSync(join(dir, frames[1]!), "utf8")).toBe("b");
    const rec = buildVerdictRecord(input(dir, { clip: clip(dir), verdict }), frames);
    await writeVerdictLog(dir, [rec, rec]);
    const lines = readFileSync(join(dir, VERDICTS_FILE), "utf8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l) as VerdictRecord)).toEqual([rec, rec]);
    expect(existsSync(join(dir, `${VERDICTS_FILE}.tmp`))).toBe(false);
  });

  it("saveVerdicts marks the selection and a write failure only logs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vl-"));
    const kept: ScoredClip = { clip: clip(dir), verdict };
    const other: ScoredClip = { clip: clip(dir, { path: join(dir, "footage/norm/1_1.jpg") }), verdict };
    const verdicts = new Map([kept, other].map((s) => [s, buildVerdictRecord(input(dir, s), [])] as const));
    await saveVerdicts({ run: { id: RUN_ID, dir }, verdicts, log: silentLog() }, [kept]);
    const lines = readFileSync(join(dir, VERDICTS_FILE), "utf8").trim().split("\n").map((l) => JSON.parse(l) as VerdictRecord);
    expect(lines.map((l) => l.selected)).toEqual([true, false]);

    const log = silentLog();
    await expect(saveVerdicts({ run: { id: RUN_ID, dir: join(dir, "missing", "dir") }, verdicts, log }, [])).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Could not save footage verdicts"));
  });
});

describe("retention keeps the verdicts", () => {
  it("a deleted run's jsonl and frames are copied to the archive first", async () => {
    const root = mkdtempSync(join(tmpdir(), "vl-ro-"));
    const archive = mkdtempSync(join(tmpdir(), "vl-ar-"));
    const dir = join(root, RUN_ID);
    mkdirSync(join(dir, "verdict_frames"), { recursive: true });
    writeFileSync(join(dir, "context.json"), JSON.stringify({ runId: RUN_ID, runDir: dir, createdAt: "2026-01-01T00:00:00Z", rejection: { stage: "03", reason: "x" } }));
    writeFileSync(join(dir, VERDICTS_FILE), "{}\n");
    writeFileSync(join(dir, "verdict_frames", "1_0_0.jpg"), "jpg");
    const old = new Date("2026-01-01T00:00:00Z");
    for (const p of [join(dir, "context.json"), join(dir, VERDICTS_FILE), join(dir, "verdict_frames"), dir]) utimesSync(p, old, old);
    const summary = await pruneRuns({ keepFailedRunsDays: 3, keepUploadedVideosDays: 14 }, { root, now: new Date("2026-02-01T00:00:00Z"), verdictsArchive: archive });
    expect(summary.deletedRuns).toEqual([RUN_ID]);
    expect(existsSync(dir)).toBe(false);
    expect(readFileSync(join(archive, RUN_ID, VERDICTS_FILE), "utf8")).toBe("{}\n");
    expect(readFileSync(join(archive, RUN_ID, "verdict_frames", "1_0_0.jpg"), "utf8")).toBe("jpg");
  });
});

describe("export_verdicts_dataset", () => {
  /** First run ids (same day) that hash to each side of the split. */
  const ids = Array.from({ length: 200 }, (_, i) => `20261020-0900${String(i % 60).padStart(2, "0")}-${(4096 + i).toString(16).slice(-4)}`);
  const valId = ids.find(isValidationRun)!;
  const trainId = ids.find((id) => !isValidationRun(id))!;

  function writeRun(root: string, runId: string, records: Partial<VerdictRecord>[]): void {
    const dir = join(root, runId);
    mkdirSync(join(dir, "verdict_frames"), { recursive: true });
    const full = records.map((r, i) => {
      const framePaths = r.framePaths ?? [`verdict_frames/1_${i}_0.jpg`, `verdict_frames/1_${i}_1.jpg`];
      for (const f of framePaths) writeFileSync(join(dir, f), "jpg");
      return { ...buildVerdictRecord(input(dir, { clip: clip(dir, { kind: "video", durationSeconds: 5 }), verdict }), framePaths), ...r, runId };
    });
    writeFileSync(join(dir, VERDICTS_FILE), `${full.map((r) => JSON.stringify(r)).join("\n")}\nnot json\n`);
  }

  it("writes LlamaFactory ShareGPT examples, split by run, skipping errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "vl-ds-"));
    const out = join(root, "out");
    const beat = { phrase: "invadiu a fortaleza", footageQuery: "Bastille engraving" };
    writeRun(join(root, "render_output"), trainId, [
      {},
      { verdict: { ...verdict, hasTextOrLogo: true, score: 2, matches: false }, source: "pexels", context: { title: "T", hook: "H", ...scene, beat } },
      { verdict: undefined, error: "boom" },
    ]);
    writeRun(join(root, "archive"), valId, [{}]);
    const stats = await exportDataset({ roots: [join(root, "render_output"), join(root, "archive")], out, minRuns: 1 });

    expect(stats).toMatchObject({
      runs: { total: 2, train: 1, val: 1 }, examples: { total: 3, train: 2, val: 1 }, approved: 2, rejected: 1,
      byReason: { textOrLogo: 1, people: 0, wrongEraOrPlace: 0, lowScoreOrNoMatch: 0 },
      bySource: { wikimedia: { total: 2, approved: 2 }, pexels: { total: 1, approved: 0 } },
      skipped: { error: 1, missingFrames: 0, malformed: 2 },
    });
    const train = JSON.parse(readFileSync(join(out, "train.json"), "utf8"));
    const val = JSON.parse(readFileSync(join(out, "val.json"), "utf8"));
    expect(val[0].images).toEqual([`images/${valId}/1_0_0.jpg`, `images/${valId}/1_0_1.jpg`]);
    expect(train.every((e: { images: string[] }) => e.images.every((p) => p.startsWith(`images/${trainId}/`)))).toBe(true);
    const [user, assistant] = train[1].messages;
    expect(user).toEqual({ role: "user", content: `<image><image>${buildRelevancePrompt(scene, 2, "T", "video", "H", beat)}` });
    expect(assistant.role).toBe("assistant");
    expect(JSON.parse(assistant.content)).toEqual({ ...verdict, hasTextOrLogo: true, score: 2, matches: false });
    expect(Object.keys(JSON.parse(assistant.content))[0]).toBe("score");
    expect(existsSync(join(out, train[0].images[0]))).toBe(true);
    expect(JSON.parse(readFileSync(join(out, "dataset_info.json"), "utf8"))).toEqual(datasetInfo());
    expect(datasetInfo()).toMatchObject({ vision_judge_train: { formatting: "sharegpt", columns: { messages: "messages", images: "images" } } });
  });

  it("no verdicts anywhere: 0 examples, nothing written, no error", async () => {
    const root = mkdtempSync(join(tmpdir(), "vl-ds-"));
    mkdirSync(join(root, RUN_ID), { recursive: true });
    expect((await collectRuns([root, join(root, "nope")])).runs).toEqual([]);
    const stats = await exportDataset({ roots: [root], out: join(root, "out"), minRuns: 1 });
    expect(stats.examples.total).toBe(0);
    expect(existsSync(join(root, "out"))).toBe(false);
  });
});
