import { describe, expect, it } from "vitest";
import type { FootageClip, RunContext, WordTiming } from "../orchestrator/types.js";
import { CAPTION_DEFAULTS, VISUAL_DEFAULTS } from "../shared/settings.js";
import {
  buildCaptionChunks,
  buildRenderPlan,
  CROSSFADE_FRAMES,
  DEFAULT_RENDER_STYLE,
  IMAGE_PAN_PCT,
  maxSafePanPct,
  type ClipSegment,
  type RenderStyle,
} from "./props.js";
import {
  backdropGradient,
  captionBox,
  captionContainerStyle,
  captionText,
  captionWordStyle,
  visibleWordGapPx,
} from "./components/captionStyle.js";
import { renderStyleFrom } from "./node/renderKit.js";

const VIDEO = { width: 1080, height: 1920, fps: 30 };

function words(count: number, stepMs = 300): WordTiming[] {
  return Array.from({ length: count }, (_, i) => ({ word: `w${i}`, startMs: i * stepMs, endMs: i * stepMs + 250 }));
}

function clip(sceneIndex: number, path: string, durationSeconds: number): FootageClip {
  return { sceneIndex, path, kind: "video", durationSeconds, width: 1920, height: 1080, source: "t", sourceUrl: "", creator: "", license: "" };
}

function image(sceneIndex: number, path: string): FootageClip {
  return { ...clip(sceneIndex, path, 0), kind: "image", width: 1080, height: 1920 };
}

const layout = (segments: ClipSegment[]): Array<[string, string, number]> =>
  segments.map((s) => [s.kind, s.src.slice(-5), s.durationInFrames]);

function ctx(footage: FootageClip[]): RunContext {
  const w = words(10);
  return {
    runId: "t",
    runDir: "C:\\runs\\t",
    createdAt: "",
    footage,
    narration: { audioPath: "C:\\runs\\t\\narração final.mp3", durationMs: 10_000, words: w },
    captions: {
      cues: [{ text: "", startMs: 0, endMs: 3000, words: w }],
      scenes: [
        { sceneIndex: 0, startMs: 0, endMs: 4000 },
        { sceneIndex: 1, startMs: 4000, endMs: 10_000 },
      ],
    },
  };
}

describe("buildRenderPlan", () => {
  it("sizes the composition from narration plus a 0.5 s tail", () => {
    const { props } = buildRenderPlan(ctx([clip(0, "C:\\a.mp4", 20), clip(1, "C:\\b.mp4", 20)]), VIDEO);
    expect(props.durationInFrames).toBe(315);
    expect(props).toMatchObject({ width: 1080, height: 1920, fps: 30 });
  });

  it("makes scenes contiguous over the whole video, the last one absorbing the tail", () => {
    const { props } = buildRenderPlan(ctx([clip(0, "C:\\a.mp4", 20), clip(1, "C:\\b.mp4", 20)]), VIDEO);
    const [first, second] = props.scenes;
    expect(first).toMatchObject({ startFrame: 0, durationInFrames: 120, leadInFrames: 0 });
    expect(second).toMatchObject({ startFrame: 120, durationInFrames: 195, leadInFrames: CROSSFADE_FRAMES });
  });

  it("chains and loops short clips until the scene (plus lead-in) is filled", () => {
    const footage = [clip(0, "C:\\a.mp4", 20), clip(1, "C:\\b.mp4", 2), clip(1, "C:\\c.mp4", 3)];
    const scene = buildRenderPlan(ctx(footage), VIDEO).props.scenes[1]!;
    const covered = scene.segments.reduce((sum, s) => sum + s.durationInFrames, 0);
    expect(covered).toBe(scene.leadInFrames + scene.durationInFrames);
    // 203 frames = b (58) + c (88) + b again (57, truncated)
    expect(scene.segments.map((s) => [s.src.slice(-5), s.durationInFrames])).toEqual([
      ["b.mp4", 58],
      ["c.mp4", 88],
      ["b.mp4", 57],
    ]);
  });

  it("falls back to the nearest earlier scene's footage when a scene has none", () => {
    const scene = buildRenderPlan(ctx([clip(0, "C:\\a.mp4", 20)]), VIDEO).props.scenes[1]!;
    expect(scene.segments[0]!.src).toMatch(/a\.mp4$/);
  });

  it("stages every input under URL-safe public names", () => {
    const { assets } = buildRenderPlan(ctx([clip(0, "C:\\dir com espaço\\Clip Ção (1).MP4", 20)]), VIDEO);
    for (const asset of assets) expect(asset.publicPath).toMatch(/^[a-z]+\/[A-Za-z0-9_.-]+$/);
    expect(assets.map((a) => a.publicPath)).toEqual(["audio/narration.mp3", "footage/00_Clip_o_1_.mp4"]);
  });

  it("throws without narration", () => {
    expect(() => buildRenderPlan({ runId: "t", runDir: "x", createdAt: "" }, VIDEO)).toThrow(/narration/);
  });
});

describe("buildCaptionChunks", () => {
  it("re-chunks long cues to at most 3 words, balanced to avoid orphan words", () => {
    const sizesFor = (n: number): number[] =>
      buildCaptionChunks([{ text: "", startMs: 0, endMs: 3000, words: words(n) }], 30).map((c) => c.words.length);
    expect(sizesFor(10)).toEqual([3, 3, 2, 2]);
    expect(sizesFor(4)).toEqual([2, 2]);
    expect(sizesFor(3)).toEqual([3]);
  });

  it("bridges small gaps and never overlaps the next chunk", () => {
    const chunks = buildCaptionChunks([{ text: "", startMs: 0, endMs: 3000, words: words(6) }], 30);
    expect(chunks[0]!.endFrame).toBe(chunks[1]!.startFrame);
  });
});

// Regression: run 20261003-003038-449c rendered "PLANETAÉ" — the highlighted word was scaled up and its
// outline swallowed the inter-word gap. Highlighting must never change a word's box or outline.
describe("caption word spacing", () => {
  const FONT_SIZES = [40, 72, 96];

  it("styles highlighted and plain words identically except for color", () => {
    for (const fontSize of FONT_SIZES) {
      const { color: activeColor, ...active } = captionWordStyle(true, fontSize);
      const { color: plainColor, ...plain } = captionWordStyle(false, fontSize);
      expect(active).toEqual(plain);
      expect(activeColor).not.toBe(plainColor);
    }
  });

  it("never spaces words with per-word margins, padding or transforms", () => {
    const style = captionWordStyle(true, 96);
    for (const key of ["margin", "marginLeft", "marginRight", "padding", "paddingLeft", "paddingRight", "transform", "scale"]) {
      expect(style).not.toHaveProperty(key);
    }
  });

  it("leaves a clear gap of at least a quarter em between adjacent outlines", () => {
    for (const fontSize of FONT_SIZES) {
      expect(visibleWordGapPx(fontSize)).toBeGreaterThanOrEqual(0.25 * fontSize);
      expect(captionContainerStyle(fontSize, { left: 0, top: 0, width: 800 }, 1).columnGap).toBeGreaterThan(0);
    }
  });
});

// Scene 1 in ctx() spans 8 lead-in frames + 195 frames = 203 frames.
describe("scenes with still images", () => {
  const scene1 = (footage: FootageClip[]) => buildRenderPlan(ctx(footage), VIDEO).props.scenes[1]!;

  it("lets a single image hold the whole scene, however long", () => {
    expect(layout(scene1([image(0, "C:/a.jpg"), image(1, "C:/b.jpg")]).segments)).toEqual([["image", "b.jpg", 203]]);
  });

  it("splits a scene evenly between two images", () => {
    const segments = scene1([image(0, "C:/a.jpg"), image(1, "C:/b.jpg"), image(1, "C:/c.jpg")]).segments;
    expect(layout(segments)).toEqual([["image", "b.jpg", 102], ["image", "c.jpg", 101]]);
    expect(segments[1]!.fromFrame).toBe(102);
  });

  it("splits image + video evenly when the video is long enough", () => {
    expect(layout(scene1([image(0, "C:/a.jpg"), image(1, "C:/b.jpg"), clip(1, "C:/v.mp4", 20)]).segments)).toEqual([
      ["image", "b.jpg", 102],
      ["video", "v.mp4", 101],
    ]);
  });

  it("plays a short video once and gives the leftover to the image instead of looping", () => {
    expect(layout(scene1([image(0, "C:/a.jpg"), clip(1, "C:/v.mp4", 2), image(1, "C:/b.jpg")]).segments)).toEqual([
      ["video", "v.mp4", 58],
      ["image", "b.jpg", 145],
    ]);
  });

  it("gives stills a Ken Burns zoom to 1.12 with a pan that never reveals frame edges", () => {
    for (const { motion } of scene1([image(0, "C:/a.jpg"), image(1, "C:/b.jpg"), image(1, "C:/c.jpg")]).segments) {
      expect(motion.scaleFrom).toBe(1);
      expect(motion.scaleTo).toBeCloseTo(1.12);
      // At every point of a linear move, pan (pre-scale % of width) must fit the zoom slack (z-1)/(2z).
      for (let t = 0; t <= 1; t += 0.1) {
        const z = motion.scaleFrom + (motion.scaleTo - motion.scaleFrom) * t;
        const pan = Math.abs(motion.panXFromPct + (motion.panXToPct - motion.panXFromPct) * t);
        expect(pan).toBeLessThanOrEqual(((z - 1) / (2 * z)) * 100 + 1e-9);
      }
      expect(Math.abs(motion.panXToPct)).toBe(IMAGE_PAN_PCT);
    }
  });

  it("alternates pan direction between consecutive scenes and between stills in a scene", () => {
    const { scenes } = buildRenderPlan(ctx([image(0, "C:/a.jpg"), image(1, "C:/b.jpg"), image(1, "C:/c.jpg")]), VIDEO).props;
    const pans = scenes.map((s) => s.segments.map((seg) => Math.sign(seg.motion.panXToPct)));
    expect(pans[0]![0]).toBe(-pans[1]![0]!);
    expect(pans[1]![0]).toBe(-pans[1]![1]!);
  });

  it("keeps videos on a plain push-in without pan", () => {
    const [segment] = scene1([clip(0, "C:/a.mp4", 20), clip(1, "C:/b.mp4", 20)]).segments;
    expect(segment!.motion).toEqual({ scaleFrom: 1, scaleTo: 1.08, panXFromPct: 0, panXToPct: 0 });
  });
});

describe("render style (Configurações)", () => {
  const style = (captions: Partial<RenderStyle["captions"]> = {}, visual: Partial<RenderStyle["visual"]> = {}): RenderStyle => ({
    captions: { ...CAPTION_DEFAULTS, ...captions },
    visual: { ...VISUAL_DEFAULTS, ...visual },
  });
  const twoScenes = [clip(0, "C:/a.mp4", 20), image(1, "C:/b.jpg")];

  it("defaults reproduce the pre-settings look", () => {
    expect(DEFAULT_RENDER_STYLE).toEqual(style());
    expect(renderStyleFrom({})).toEqual(style());
    const { props } = buildRenderPlan(ctx(twoScenes), VIDEO);
    expect(props.style).toEqual(style());
    expect(props.scenes[1]!.leadInFrames).toBe(CROSSFADE_FRAMES);
    expect(props.captions.map((c) => c.words.length)).toEqual([3, 3, 2, 2]);
    expect(backdropGradient(0.62)).toBe(
      "linear-gradient(to bottom, rgba(0,0,0,0) 40.0%, rgba(0,0,0,0.35) 58.0%, rgba(0,0,0,0.35) 68.0%, rgba(0,0,0,0) 85.0%)",
    );
  });

  it("merges config and override over defaults, ignoring undefined values", () => {
    const merged = renderStyleFrom({ captions: { font: "impact", maxFontPx: 80 } }, { captions: { maxFontPx: 120, highlight: undefined } });
    expect(merged.captions).toMatchObject({ font: "impact", maxFontPx: 120, highlight: "color" });
  });

  it("maxWordsPerCue drives the balanced re-split", () => {
    const sizes = (n: number) =>
      buildRenderPlan(ctx(twoScenes), VIDEO, style({ maxWordsPerCue: n })).props.captions.map((c) => c.words.length);
    expect(sizes(1)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(sizes(2)).toEqual([2, 2, 2, 2, 2]);
    expect(sizes(4)).toEqual([4, 3, 3]);
  });

  it("captions.enabled=false renders no caption chunks", () => {
    expect(buildRenderPlan(ctx(twoScenes), VIDEO, style({ enabled: false })).props.captions).toEqual([]);
  });

  it("highlight 'none' makes the spoken word look exactly like the others", () => {
    const none = style({ highlight: "none" }).captions;
    expect(captionWordStyle(true, 96, none)).toEqual(captionWordStyle(false, 96, none));
  });

  it("applies colors, font, case and vertical position", () => {
    const custom = style({ textColor: "#00FF00", highlightColor: "#FF00FF", strokeColor: "#112233", font: "verdana", uppercase: false, verticalPosition: 0.45 }).captions;
    expect(captionWordStyle(false, 90, custom)).toMatchObject({ color: "#00FF00", WebkitTextStroke: "18px #112233" });
    expect(captionWordStyle(true, 90, custom).color).toBe("#FF00FF");
    expect(captionContainerStyle(90, captionBox(1080, 1920, custom), 1, custom).fontFamily).toMatch(/^Verdana/);
    expect(captionBox(1080, 1920, custom).top).toBeCloseTo(864);
    expect(captionText("água", custom)).toBe("água");
    expect(captionText("água")).toBe("ÁGUA");
  });

  it("crossfadeFrames=0 gives hard cuts", () => {
    const { scenes } = buildRenderPlan(ctx(twoScenes), VIDEO, style({}, { crossfadeFrames: 0 })).props;
    expect(scenes.map((s) => s.leadInFrames)).toEqual([0, 0]);
  });

  it("zoom 1.0 disables the pan; imagePan=false keeps the zoom without pan", () => {
    const motion = (visual: Partial<RenderStyle["visual"]>) =>
      buildRenderPlan(ctx(twoScenes), VIDEO, style({}, visual)).props.scenes.map((s) => s.segments[0]!.motion);
    expect(motion({ imageZoom: 1, videoZoom: 1 })).toEqual([
      { scaleFrom: 1, scaleTo: 1, panXFromPct: 0, panXToPct: 0 },
      { scaleFrom: 1, scaleTo: 1, panXFromPct: 0, panXToPct: 0 },
    ]);
    expect(motion({ imagePan: false })[1]).toEqual({ scaleFrom: 1, scaleTo: 1.12, panXFromPct: 0, panXToPct: 0 });
  });

  it("never pans beyond the edge slack of the configured zoom", () => {
    for (const imageZoom of [1, 1.01, 1.05, 1.12, 1.2, 1.25]) {
      const m = buildRenderPlan(ctx(twoScenes), VIDEO, style({}, { imageZoom })).props.scenes[1]!.segments[0]!.motion;
      expect(Math.abs(m.panXToPct)).toBeLessThanOrEqual(maxSafePanPct(imageZoom));
      expect(Math.abs(m.panXToPct)).toBeLessThanOrEqual(IMAGE_PAN_PCT);
    }
  });
});
