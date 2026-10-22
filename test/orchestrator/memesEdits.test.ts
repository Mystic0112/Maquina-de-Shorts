// Onda 2: meme library (license gate, credits), edit plan validation, stage 05b, render plan cues and 07 credits.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../src/orchestrator/lib/logger.js", () => {
  const noop = () => undefined;
  return { getLogger: () => ({ info: noop, warn: noop, error: noop, debug: noop }), describeError: String };
});

import { buildEditPrompt, EDIT_RULES, PLACEMENTS, validateEditPlan, type EditCueDraft } from "../../src/orchestrator/lib/editPlan.js";
import { DEMO_ASSETS, popWav, writeDemoAssets } from "../../src/orchestrator/lib/memeDemo.js";
import {
  creditsFor,
  EDIT_CREDITS_HEADER,
  findByTags,
  inventoryProblems,
  isLicenseAllowed,
  loadInventory,
  parseInventory,
  toEditAsset,
  type MemeAsset,
} from "../../src/orchestrator/lib/memeLibrary.js";
import { run as planEdits, type PlanEditsDeps } from "../../src/orchestrator/stages/05b-planEdits.js";
import { assembleMetadata } from "../../src/orchestrator/stages/07-generateMetadata.js";
import type { EditAsset, EditPlan, RunContext, WordTiming } from "../../src/orchestrator/types.js";
import { CAPTION_DEFAULTS, EDITING_DEFAULTS } from "../../src/shared/settings.js";
import { CAPTION_MARGIN, EDIT_SAFE_TOP, editBox } from "../../src/remotion/components/editStyle.js";
import { buildRenderPlan } from "../../src/remotion/props.js";

let libDir: string;
let assets: EditAsset[];

beforeAll(async () => {
  libDir = await mkdtemp(path.join(tmpdir(), "memes-"));
  await writeDemoAssets(libDir);
  assets = DEMO_ASSETS.map((a) => toEditAsset(a, libDir));
});
afterAll(() => rm(libDir, { recursive: true, force: true }));

const DURATION_MS = 30_000;
const words: WordTiming[] = Array.from({ length: 60 }, (_, i) => ({ word: `p${i}`, startMs: i * 500, endMs: i * 500 + 400 }));

function ctx(over: Partial<RunContext> = {}): RunContext {
  return {
    runId: "r1", runDir: "/tmp/r1", createdAt: "",
    script: { title: "Título", hook: "Gancho", scenes: [{ narration: "x", footageQuery: "q" }], cta: "fim", language: "pt-BR" },
    narration: { audioPath: "/tmp/r1/narration.wav", durationMs: DURATION_MS, words },
    captions: { cues: [], scenes: [{ sceneIndex: 0, startMs: 0, endMs: DURATION_MS }] },
    footage: [{ sceneIndex: 0, path: "/tmp/r1/a.jpg", kind: "image", durationSeconds: 0, width: 1080, height: 1920, source: "nasa", sourceUrl: "u", creator: "", license: "PD" }],
    ...over,
  };
}

const cue = (over: Partial<EditCueDraft>): EditCueDraft => ({ atMs: 5000, assetId: "demo-surpresa", kind: "sticker", placement: "top", durationMs: 2000, intensity: "normal", why: "x", ...over });

describe("memeLibrary", () => {
  it("accepts only the approved licenses", () => {
    for (const ok of ["CC0", "CC BY 4.0", "CC BY-SA 4.0", "Pixabay License", "Lottie Simple License", "Apache-2.0", "own"]) expect(isLicenseAllowed(ok)).toBe(true);
    for (const bad of ["CC BY-NC 4.0", "CC BY-ND 4.0", "All rights reserved", "GPL-3.0", "cc0", ""]) expect(isLicenseAllowed(bad)).toBe(false);
  });

  it("parseInventory refuses a disallowed license and duplicate ids", () => {
    const base = { ...DEMO_ASSETS[0]! };
    expect(() => parseInventory({ assets: [{ ...base, license: "CC BY-NC 4.0" }] })).toThrow(/Inventário de memes inválido/);
    expect(() => parseInventory({ assets: [base, base] })).toThrow(/id repetido/);
    expect(() => parseInventory({ assets: [{ ...base, file: "../secrets/x.png" }] })).toThrow();
  });

  it("loads the demo inventory from disk with every file present", async () => {
    const loaded = await loadInventory(libDir);
    expect(loaded.map((a) => a.id)).toEqual(DEMO_ASSETS.map((a) => a.id));
    expect(inventoryProblems(loaded, libDir)).toEqual([]);
    expect(inventoryProblems([{ ...loaded[0]!, file: "files/missing.svg" }], libDir)).toEqual(["demo-surpresa: arquivo ausente (files/missing.svg)"]);
    expect(await loadInventory(path.join(libDir, "nope"))).toEqual([]);
  });

  it("findByTags ignores accents/case and narrows by kind", () => {
    expect(findByTags(DEMO_ASSETS, ["VITORIA"]).map((a) => a.id)).toEqual(["demo-vitoria"]);
    expect(findByTags(DEMO_ASSETS, ["surpresa"]).map((a) => a.id)).toEqual(["demo-surpresa", "demo-pop"]);
    expect(findByTags(DEMO_ASSETS, ["surpresa"], "sfx").map((a) => a.id)).toEqual(["demo-pop"]);
  });

  it("creditsFor lists only attribution-required assets, once per source, in the project's bullet style", () => {
    const twemoji: EditAsset = { id: "twemoji-1f62e", kind: "sticker", path: "/x.svg", source: "twemoji", sourceUrl: "https://github.com/jdecked/twemoji", author: "Twemoji", license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", attributionRequired: true };
    expect(creditsFor(assets)).toBe("");
    const text = creditsFor([twemoji, { ...twemoji, id: "twemoji-1f4a5" }, ...assets]);
    expect(text).toBe(`${EDIT_CREDITS_HEADER}\n• Twemoji — CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/) — https://github.com/jdecked/twemoji (redimensionado e editado)`);
  });

  it("popWav is a valid 16-bit mono PCM header with the requested length", () => {
    const wav = popWav(150, 22_050);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(22_050);
    expect(wav.readUInt32LE(40)).toBe(Math.round(0.15 * 22_050) * 2);
  });
});

describe("validateEditPlan", () => {
  it("drops unknown assets, wrong kinds and cues in the hook/tail windows", () => {
    const { cues, dropped } = validateEditPlan(
      [cue({ assetId: "nope" }), cue({ assetId: "demo-pop", kind: "sticker" }), cue({ atMs: 2000 }), cue({ atMs: DURATION_MS - 1000 }), cue({ atMs: 10_000 })],
      assets, DURATION_MS, 6,
    );
    expect(cues.map((c) => c.atMs)).toEqual([10_000]);
    expect(dropped).toHaveLength(4);
    expect(dropped.join("\n")).toMatch(/não existe/);
    expect(dropped.join("\n")).toMatch(/gancho/);
    expect(dropped.join("\n")).toMatch(/final/);
  });

  it("enforces 4 s spacing (earlier wins), the cap, and clamps durations", () => {
    const { cues, dropped } = validateEditPlan(
      [cue({ atMs: 5000, durationMs: 9000 }), cue({ atMs: 7000 }), cue({ atMs: 9500, assetId: "demo-pop", kind: "sfx", durationMs: 5 }), cue({ atMs: 14_000, durationMs: 100 }), cue({ atMs: 20_000 })],
      assets, DURATION_MS, 3,
    );
    expect(cues.map((c) => c.atMs)).toEqual([5000, 9500, 14_000]);
    expect(cues[0]!.durationMs).toBe(EDIT_RULES.stickerMaxMs);
    expect(cues[1]!.durationMs).toBe(150); // sfx takes the file length
    expect(cues[2]!.durationMs).toBe(EDIT_RULES.stickerMinMs);
    expect(dropped.some((d) => /menos de 4000 ms/.test(d))).toBe(true);
    expect(dropped.some((d) => /acima do máximo de 3/.test(d))).toBe(true);
  });

  it("refuses long sound effects and never lets a sticker run into the tail", () => {
    const longSfx: EditAsset = { ...assets.find((a) => a.id === "demo-pop")!, id: "long", durationMs: 4000 };
    const { cues, dropped } = validateEditPlan([cue({ assetId: "long", kind: "sfx" }), cue({ atMs: DURATION_MS - 2500, durationMs: 3000 })], [...assets, longSfx], DURATION_MS, 6);
    expect(dropped[0]).toMatch(/mais de 1500 ms/);
    expect(cues[0]!.atMs + cues[0]!.durationMs).toBeLessThanOrEqual(DURATION_MS - EDIT_RULES.tailMs);
  });

  it("the prompt carries word timings, the library digest and the rules in pt-BR", () => {
    const prompt = buildEditPrompt({ script: ctx().script!, narration: ctx().narration!, scenes: ctx().captions!.scenes, library: DEMO_ASSETS, maxCues: 4 });
    expect(prompt).toContain("p10@5000");
    expect(prompt).toContain("- demo-pop | sfx 150 ms | pop, surpresa, explosão");
    expect(prompt).toContain("No máximo 4 cues");
    expect(prompt).toContain(`Nunca antes de ${EDIT_RULES.hookMs} ms`);
  });
});

describe("05b-planEdits stage", () => {
  const deps = (over: Partial<PlanEditsDeps>, generate = vi.fn()): PlanEditsDeps => ({
    settings: () => ({ enabled: true }),
    inventory: () => loadInventory(libDir),
    generate: generate as unknown as PlanEditsDeps["generate"],
    libraryDir: libDir,
    ...over,
  });

  it("is skipped (no LLM call, ctx untouched) when disabled or when the library is empty", async () => {
    const generate = vi.fn();
    const input = ctx();
    expect(await planEdits(input, deps({ settings: () => undefined }, generate))).toBe(input);
    expect(await planEdits(input, deps({ settings: () => ({ enabled: false }) }, generate))).toBe(input);
    expect(await planEdits(input, deps({ inventory: async () => [] }, generate))).toBe(input);
    const missing: MemeAsset = { ...DEMO_ASSETS[0]!, id: "ghost", file: "files/ghost.svg" };
    expect(await planEdits(input, deps({ inventory: async () => [missing] }, generate))).toBe(input);
    expect(generate).not.toHaveBeenCalled();
  });

  it("keeps the validated cues, only the assets they use, and the configured sfx volume", async () => {
    const generate = vi.fn(async () => ({ cues: [cue({ atMs: 6000 }), cue({ atMs: 12_000, assetId: "demo-pop", kind: "sfx", durationMs: 150 }), cue({ atMs: 1000 })] }));
    const out = await planEdits(ctx(), deps({ settings: () => ({ enabled: true, sfxVolume: 0.2 }) }, generate));
    expect(generate).toHaveBeenCalledTimes(1);
    expect(out.edits?.cues.map((c) => c.assetId)).toEqual(["demo-surpresa", "demo-pop"]);
    expect(out.edits?.assets.map((a) => a.id).sort()).toEqual(["demo-pop", "demo-surpresa"]);
    expect(out.edits?.assets[0]!.path.startsWith(libDir)).toBe(true);
    expect(out.edits?.sfxVolume).toBe(0.2);
    expect(EDITING_DEFAULTS).toEqual({ enabled: false, maxCuesPerVideo: 6, sfxVolume: 0.35 });
  });
});

describe("render plan with edits", () => {
  const video = { width: 1080, height: 1920, fps: 30 };
  const plan = (): EditPlan => ({
    cues: [
      { atMs: 6000, assetId: "demo-surpresa", kind: "sticker", placement: "top", durationMs: 2000, intensity: "forte", why: "" },
      { atMs: 12_000, assetId: "demo-pop", kind: "sfx", placement: "corner", durationMs: 150, intensity: "normal", why: "" },
      { atMs: 18_000, assetId: "lottie-x", kind: "lottie", placement: "side-left", durationMs: 1500, intensity: "sutil", why: "" },
    ],
    assets: [...assets, { id: "lottie-x", kind: "lottie", path: "/tmp/x.json", source: "lottiefiles", sourceUrl: "u", license: "Lottie Simple License", attributionRequired: false, durationMs: 1500 }],
    sfxVolume: 0.35,
  });

  it("places cues on the right frames, stages only the used files and skips lottie until @remotion/lottie exists", () => {
    const { props, assets: staged, skippedLottieCues } = buildRenderPlan(ctx({ edits: plan() }), video, undefined, { publicPrefix: "runs/t" });
    expect(props.edits.map((c) => [c.id, c.fromFrame, c.durationInFrames, c.kind, c.volume])).toEqual([
      ["demo-surpresa", 180, 60, "sticker", 0.35],
      ["demo-pop", 360, 5, "sfx", 0.35],
    ]);
    expect(props.edits[0]!.src).toBe("runs/t/edits/demo-surpresa.svg");
    expect(staged.filter((a) => a.publicPath.includes("/edits/")).map((a) => a.publicPath)).toEqual(["runs/t/edits/demo-surpresa.svg", "runs/t/edits/demo-pop.wav"]);
    expect(skippedLottieCues).toBe(1);
    expect(buildRenderPlan(ctx(), video).props.edits).toEqual([]);
  });

  it("no cue frame falls inside the hook window or after the narration", () => {
    const { props } = buildRenderPlan(ctx({ edits: plan() }), video);
    for (const c of props.edits) {
      expect(c.fromFrame).toBeGreaterThanOrEqual(Math.round((EDIT_RULES.hookMs / 1000) * video.fps));
      expect(c.fromFrame + c.durationInFrames).toBeLessThanOrEqual(props.durationInFrames);
    }
  });

  it("every placement/intensity box stays below the safe top and above the caption line", () => {
    for (const verticalPosition of [0.3, 0.45, 0.62, 0.75]) {
      const captions = { ...CAPTION_DEFAULTS, verticalPosition };
      for (const placement of PLACEMENTS) {
        for (const intensity of ["sutil", "normal", "forte"] as const) {
          const box = editBox(placement, intensity, video.width, video.height, captions);
          expect(box.top).toBeGreaterThanOrEqual(video.height * EDIT_SAFE_TOP - 0.01);
          expect(box.top + box.height).toBeLessThanOrEqual(video.height * (verticalPosition - CAPTION_MARGIN) + 0.01);
          expect(box.left).toBeGreaterThanOrEqual(0);
          expect(box.left + box.width).toBeLessThanOrEqual(video.width);
          expect(box.width).toBeGreaterThan(0);
        }
      }
      const side = editBox("side-left", "forte", video.width, video.height, captions);
      expect(side.left + side.width).toBeLessThan(video.width / 2); // never over the (face-prone) center
    }
  });
});

describe("07-generateMetadata credits for edit assets", () => {
  const input = () => ({
    script: ctx().script!, footage: ctx().footage!, categoryId: "27", language: "pt-BR",
    draft: { context: [], hashtags: [], tags: ["a", "b", "c", "d", "e"] },
  });
  it("adds CC BY sticker credits to the credits block and nothing for own/Pixabay assets", () => {
    const own = assembleMetadata({ ...input(), edits: { assets } });
    expect(own.description).not.toContain(EDIT_CREDITS_HEADER);
    const cc: EditAsset = { id: "openmoji-1f62e", kind: "sticker", path: "/x.svg", source: "openmoji", sourceUrl: "https://openmoji.org/library/emoji-1F62E/", author: "OpenMoji", license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/", attributionRequired: true };
    const { description } = assembleMetadata({ ...input(), edits: { assets: [cc, ...assets] } });
    const block = description.split("\n\n").find((b) => b.startsWith("Créditos das imagens:"))!;
    expect(block).toContain(`${EDIT_CREDITS_HEADER}\n• OpenMoji — CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/) — https://openmoji.org/library/emoji-1F62E/ (redimensionado e editado)`);
  });
});
