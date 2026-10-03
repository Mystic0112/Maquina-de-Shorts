// QA (Quinn): invariants of the pure Remotion render plan (props.ts) over seeded random timelines.
// A violation here means black frames, overlapping captions or a Remotion Sequence error at render time.
import { describe, expect, it } from "vitest";
import { buildRenderPlan } from "../../src/remotion/props.js";
import { buildCaptions, cueOptionsFor } from "../../src/orchestrator/stages/05-buildCaptions.js";
import type { FootageClip, RunContext, Script, WordTiming } from "../../src/orchestrator/types.js";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomRun(seed: number): RunContext {
  const r = rng(seed);
  const sceneCount = 4 + Math.floor(r() * 4);
  const scenes = Array.from({ length: sceneCount }, (_, k) => ({
    narration: Array.from({ length: 6 + Math.floor(r() * 20) }, (_, i) => `palavra${k}x${i}`).join(" "),
    footageQuery: "a b",
  }));
  const script: Script = { title: "t", hook: "gancho forte aqui", scenes, cta: "siga o canal", language: "pt-BR" };
  const tokens = [script.hook, ...scenes.map((s) => s.narration), script.cta].join(" ").split(" ");
  let t = 0;
  const words: WordTiming[] = tokens.map((word) => {
    const startMs = t;
    const endMs = t + 120 + Math.floor(r() * 400);
    t = endMs + Math.floor(r() * (r() < 0.05 ? 1500 : 150));
    return { word, startMs, endMs };
  });
  const durationMs = t + 200;
  const footage: FootageClip[] = [];
  scenes.forEach((_, k) => {
    const n = r() < 0.15 ? 0 : 1 + Math.floor(r() * 2);
    for (let i = 0; i < n; i++) {
      const image = r() < 0.4;
      footage.push({
        sceneIndex: k, path: `C:\\Users\\Ação Teste\\run dir\\footage\\norm\\${k}_${i}.${image ? "jpg" : "mp4"}`,
        kind: image ? "image" : "video", durationSeconds: image ? 0 : 0.3 + r() * 12, width: 1080, height: 1920,
        source: "nasa", sourceUrl: `https://x/${k}/${i}`, creator: "c", license: "PD",
      });
    }
  });
  if (footage.length === 0) {
    footage.push({ sceneIndex: 0, path: "C:\\a.mp4", kind: "video", durationSeconds: 3, width: 1080, height: 1920, source: "nasa", sourceUrl: "u", creator: "", license: "PD" });
  }
  const { captions } = buildCaptions(script, words, durationMs, cueOptionsFor(3));
  return {
    runId: `r${seed}`, runDir: "C:\\x", createdAt: "", script, footage, captions,
    narration: { audioPath: "C:\\Users\\Ação Teste\\narration.mp3", durationMs, words },
  };
}

describe("buildRenderPlan invariants (seeded fuzz)", () => {
  const video = { width: 1080, height: 1920, fps: 30 };

  it("scene windows tile [0, durationInFrames) and every scene's segments fill it without gaps", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const { props, assets } = buildRenderPlan(randomRun(seed), video, undefined, { publicPrefix: "runs/x" });
      let expectedStart = 0;
      props.scenes.forEach((scene, k) => {
        expect(scene.startFrame, `seed ${seed} scene ${k}`).toBe(expectedStart);
        expect(scene.durationInFrames, `seed ${seed} scene ${k}`).toBeGreaterThan(0);
        expect(scene.startFrame - scene.leadInFrames, `seed ${seed} scene ${k}`).toBeGreaterThanOrEqual(0);
        let cursor = 0;
        for (const seg of scene.segments) {
          expect(seg.fromFrame, `seed ${seed} scene ${k}`).toBe(cursor);
          expect(seg.durationInFrames, `seed ${seed} scene ${k}`).toBeGreaterThan(0);
          cursor += seg.durationInFrames;
        }
        expect(cursor, `seed ${seed} scene ${k} segments`).toBe(scene.leadInFrames + scene.durationInFrames);
        expectedStart = scene.startFrame + scene.durationInFrames;
      });
      expect(expectedStart, `seed ${seed}`).toBe(props.durationInFrames);
      // staticFile() must only ever see ASCII, space-free names (Windows paths with accents/spaces).
      for (const a of assets) expect(a.publicPath, `seed ${seed}`).toMatch(/^[A-Za-z0-9_./-]+$/);
    }
  });

  it("caption chunks are ordered, non-empty and never overlap", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const { props } = buildRenderPlan(randomRun(seed), video);
      props.captions.forEach((c, k) => {
        expect(c.endFrame, `seed ${seed} chunk ${k}`).toBeGreaterThan(c.startFrame);
        expect(c.words.length, `seed ${seed} chunk ${k}`).toBeLessThanOrEqual(3);
        const next = props.captions[k + 1];
        if (next) expect(c.endFrame, `seed ${seed} chunk ${k}`).toBeLessThanOrEqual(next.startFrame);
      });
    }
  });
});
