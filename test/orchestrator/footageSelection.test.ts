import { describe, expect, it } from "vitest";
import { encodeBeatSlot } from "../../src/orchestrator/lib/beats.js";
import {
  annotateClip,
  buildAlternativeQueriesPrompt,
  buildRelevancePrompt,
  classifyClip,
  penalizeLowResolution,
  resolutionPenalty,
  resolveRelevanceSettings,
  selectSceneClips,
  type ScoredClip,
} from "../../src/orchestrator/lib/relevance.js";
import { fillMissingScenes, firstRoundQueries, isHookClip, sceneForClip } from "../../src/orchestrator/stages/03-fetchFootage.js";
import type { FootageClip, Script } from "../../src/orchestrator/types.js";

const script: Script = {
  title: "A Bastilha tinha só sete presos",
  overlayText: "SÓ 7 PRESOS?",
  hook: "A Bastilha tinha só sete presos quando caiu.",
  hookFootageQuery: "storming of the Bastille painting",
  scenes: [
    { narration: "Em julho de 1789, a multidão de Paris invadiu a fortaleza.", footageQuery: "Bastille fortress engraving" },
    { narration: "Lá dentro, só sete prisioneiros esperavam.", footageQuery: "Bastille prison cell illustration" },
  ],
  cta: "",
  language: "pt-BR",
};

function clip(over: Partial<FootageClip> = {}): FootageClip {
  return {
    sceneIndex: 0, path: "C:/run/footage/norm/0_0.mp4", kind: "video", durationSeconds: 8, width: 1080, height: 1920,
    source: "wikimedia", sourceUrl: `https://c/${Math.random()}`, creator: "c", license: "Public domain", ...over,
  };
}

function scored(score: number, over: Partial<FootageClip> = {}, verdict: Partial<NonNullable<ScoredClip["verdict"]>> = {}): ScoredClip {
  return {
    clip: clip(over),
    verdict: { score, matches: true, reason: "fits", hasTextOrLogo: false, hasIdentifiablePeople: false, ...verdict },
  };
}

describe("hook footage query (scene 0)", () => {
  it("is requested first, as a pseudo scene after the real ones, then scene 0's own query as fallback", () => {
    expect(firstRoundQueries(script)).toEqual([
      { sceneIndex: 2, query: "storming of the Bastille painting" },
      { sceneIndex: 0, query: "Bastille fortress engraving" },
      { sceneIndex: 1, query: "Bastille prison cell illustration" },
    ]);
  });

  it("is skipped when absent or identical to scene 0's query", () => {
    expect(firstRoundQueries({ ...script, hookFootageQuery: undefined })).toHaveLength(2);
    expect(firstRoundQueries({ ...script, hookFootageQuery: " bastille FORTRESS engraving " })).toHaveLength(2);
  });

  it("hook clips are recognized by name and reviewed against the hook query and the hook line", () => {
    const hookClip = clip({ path: "C:/run/footage/norm/0_h0.jpg" });
    expect(isHookClip(hookClip)).toBe(true);
    expect(isHookClip(clip())).toBe(false);
    expect(sceneForClip(script, hookClip)).toEqual({
      narration: `${script.hook} ${script.scenes[0]?.narration}`,
      footageQuery: "storming of the Bastille painting",
    });
    expect(sceneForClip(script, clip()).footageQuery).toBe("Bastille fortress engraving");
    expect(sceneForClip(script, clip({ sceneIndex: 1, path: "1_0.mp4" })).narration).toBe(script.scenes[1]?.narration);
  });

  it("the highest score opens the scene; on a tie the hook query's clip wins", () => {
    const settings = resolveRelevanceSettings(undefined);
    const plain = scored(8, { path: "0_0.mp4" });
    const hook = scored(8, { path: "0_h0.jpg" });
    const best = scored(9, { path: "0_1.mp4" });
    const sel = selectSceneClips(0, [plain, hook, best], settings, false, (s) => isHookClip(s.clip));
    expect(sel.kept.map((s) => s.clip.path)).toEqual(["0_1.mp4", "0_h0.jpg", "0_0.mp4"]);
  });
});

describe("beats in the footage stage", () => {
  const beats = [
    { phrase: "a multidão de Paris", footageQuery: "Paris crowd 1789 engraving" },
    { phrase: "invadiu a fortaleza", footageQuery: "Bastille fortress engraving" },
  ];
  const beatScript: Script = { ...script, scenes: [{ ...script.scenes[0]!, footageQuery: beats[0]!.footageQuery, beats }, script.scenes[1]!] };

  it("adds one query per extra beat as a pseudo scene, sharing the scene's candidate budget", () => {
    expect(firstRoundQueries(beatScript)).toEqual([
      { sceneIndex: 2, query: "storming of the Bastille painting" },
      { sceneIndex: 0, query: "Paris crowd 1789 engraving" },
      { sceneIndex: encodeBeatSlot(0, 1, 2), query: "Bastille fortress engraving" },
      { sceneIndex: 1, query: "Bastille prison cell illustration" },
    ]);
    const budgeted = firstRoundQueries(beatScript, { clipsPerQuery: 3, kinds: 2 });
    expect(budgeted.map((q) => q.clipsPerQuery)).toEqual([undefined, 2, 2, undefined]);
    expect(firstRoundQueries(script, { clipsPerQuery: 3, kinds: 2 })).toEqual(firstRoundQueries(script));
  });

  it("the reviewer judges a beat clip against the phrase being said and demands the thing it names", () => {
    const prompt = buildRelevancePrompt(beatScript.scenes[0]!, 1, script.title, "image", script.hook, beats[1]);
    expect(prompt).toContain('WHAT IS BEING SAID while this footage is on screen (pt-BR): "invadiu a fortaleza"');
    expect(prompt).toContain('Search query that found the clip: "Bastille fortress engraving"');
    expect(prompt).toContain("context only");
    expect(prompt).toContain("not a burger with ketchup");
    expect(buildRelevancePrompt(script.scenes[0]!, 1)).not.toContain("WHAT IS BEING SAID");
  });

  it("records the reviewer's face verdict on the clip (only when given)", () => {
    expect(annotateClip(scored(8, {}, { showsFace: true })).hasFace).toBe(true);
    expect(annotateClip(scored(8, {}, { showsFace: false })).hasFace).toBe(false);
    expect(annotateClip(scored(8))).not.toHaveProperty("hasFace");
    expect(buildRelevancePrompt(script.scenes[0]!, 1)).toContain("showsFace");
  });

  it("a borrowed clip loses the donor's beat", () => {
    const { clips } = fillMissingScenes([clip({ sceneIndex: 0, beatIndex: 1 })], 2);
    expect(clips[1]).toMatchObject({ sceneIndex: 1, borrowedFromScene: 0 });
    expect(clips[1]).not.toHaveProperty("beatIndex");
  });
});

describe("relevance settings and selection", () => {
  it("keeps up to 3 passing clips per scene by default (renderer shot splitting)", () => {
    const settings = resolveRelevanceSettings(undefined);
    expect(settings.keepPerScene).toBe(3);
    expect(resolveRelevanceSettings({ relevance: { keepPerScene: 2 } }).keepPerScene).toBe(2);
    const sel = selectSceneClips(0, [scored(7), scored(8), scored(9), scored(6.5)], settings, false);
    expect(sel.kept.map((s) => s.verdict?.score)).toEqual([9, 8, 7]);
  });

  it("anachronistic footage (wrong era/place) is rejected, never a fallback", () => {
    const civilWar = scored(7, {}, { matches: false, wrongEraOrPlace: true, reason: "American Civil War reenactment" });
    expect(classifyClip(civilWar, 6)).toBe("reject");
    expect(selectSceneClips(0, [civilWar], resolveRelevanceSettings(undefined), true).mode).toBe("none");
  });
});

describe("low-resolution penalty", () => {
  it("videos under 720 px on the short side lose 2 points", () => {
    expect(resolutionPenalty({ width: 640, height: 360 }, "video").penalty).toBe(2);
    expect(resolutionPenalty({ width: 1280, height: 720 }, "video").penalty).toBe(0);
  });

  it("stills that must be upscaled to fill 1080x1920 are penalized by how blurry they get", () => {
    expect(resolutionPenalty({ width: 3840, height: 2160 }, "image").penalty).toBe(0); // 0.9x
    expect(resolutionPenalty({ width: 1920, height: 1080 }, "image").penalty).toBe(1); // 1.8x
    expect(resolutionPenalty({ width: 800, height: 600 }, "image").penalty).toBe(2); // 3.2x
    expect(resolutionPenalty(undefined, "image").penalty).toBe(0);
  });

  it("applies to the score (so a low-res 6 no longer passes) and notes it in the reason", () => {
    const low = penalizeLowResolution(scored(6, { kind: "video" }), { width: 480, height: 360 });
    expect(low.verdict?.score).toBe(4);
    expect(low.verdict?.reason).toContain("low-res video 480x360");
    expect(classifyClip(low, 6)).toBe("weak");
  });
});

describe("reviewer prompts", () => {
  it("vision reviewer checks era/place coherence and sharpness, with the hook as context", () => {
    const prompt = buildRelevancePrompt(script.scenes[0] as Script["scenes"][number], 3, script.title, "video", script.hook);
    expect(prompt).toContain("wrongEraOrPlace");
    expect(prompt).toContain("American Civil War reenactment for a line about Paris in 1789");
    expect(prompt).toContain("Ptolemaic Library of Alexandria");
    expect(prompt).toContain("blurry, pixelated");
    expect(prompt).toContain(`Opening line of the video (pt-BR): "${script.hook}"`);
  });

  it("alternative queries may name historical subjects only when specific footage is on", () => {
    const failed = [{ sceneIndex: 0, narration: "Paris, 1789.", footageQuery: "Bastille fortress engraving" }];
    expect(buildAlternativeQueriesPrompt(failed, true)).toContain("Keep the scene's era and place");
    expect(buildAlternativeQueriesPrompt(failed, false)).toContain("Never use people's names");
  });
});
