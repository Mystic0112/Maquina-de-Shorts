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
  type CaptionWordProps,
  type ClipSegment,
  type RenderStyle,
  type SegmentMotion,
} from "./props.js";
import {
  backdropGradient,
  captionBox,
  captionContainerStyle,
  captionText,
  captionWordStyle,
  highlightedWordIndex,
  visibleWordGapPx,
} from "./components/captionStyle.js";
import { cameraAt } from "./components/motion.js";
import { GRID_SAFE_TOP, overlayLayout, overlayOpacity } from "./components/overlayStyle.js";
import { renderStyleFrom } from "./node/renderKit.js";
import { OPENING_PUNCH_SECONDS, OPENING_PUNCH_ZOOM, planSceneShots, SAFE_MAX_ZOOM } from "./shots.js";

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

const style = (captions: Partial<RenderStyle["captions"]> = {}, visual: Partial<RenderStyle["visual"]> = {}): RenderStyle => ({
  captions: { ...CAPTION_DEFAULTS, ...captions },
  visual: { ...VISUAL_DEFAULTS, ...visual },
});

/** Narration 10 s + 0.15 s tail = 305 frames: scene 0 = [0, 120), scene 1 = 8 lead-in + 185 = 193 visual frames. */
function ctx(footage: FootageClip[], overlayText?: string): RunContext {
  const w = words(10);
  return {
    runId: "t",
    runDir: "C:\\runs\\t",
    createdAt: "",
    footage,
    script: overlayText === undefined ? undefined : { title: "t", hook: "h", scenes: [], cta: "", language: "pt-BR", overlayText },
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
  it("sizes the composition from narration plus the configured tail (0.15 s by default)", () => {
    const footage = [clip(0, "C:\\a.mp4", 20), clip(1, "C:\\b.mp4", 20)];
    const { props } = buildRenderPlan(ctx(footage), VIDEO);
    expect(props.durationInFrames).toBe(305);
    expect(props).toMatchObject({ width: 1080, height: 1920, fps: 30 });
    expect(buildRenderPlan(ctx(footage), VIDEO, style({}, { tailSeconds: 0 })).props.durationInFrames).toBe(300);
    expect(buildRenderPlan(ctx(footage), VIDEO, style({}, { tailSeconds: 0.5 })).props.durationInFrames).toBe(315);
  });

  it("makes scenes contiguous over the whole video, the last one absorbing the tail", () => {
    const { props } = buildRenderPlan(ctx([clip(0, "C:\\a.mp4", 20), clip(1, "C:\\b.mp4", 20)]), VIDEO);
    const [first, second] = props.scenes;
    expect(first).toMatchObject({ startFrame: 0, durationInFrames: 120, leadInFrames: 0 });
    expect(second).toMatchObject({ startFrame: 120, durationInFrames: 185, leadInFrames: CROSSFADE_FRAMES });
  });

  it("ends on the last scene's own shot, which runs to the final frame (no closing sliver)", () => {
    const { props } = buildRenderPlan(ctx([image(0, "C:/a.jpg"), image(1, "C:/b.jpg")]), VIDEO);
    const last = props.scenes[props.scenes.length - 1]!;
    const lastShot = last.segments[last.segments.length - 1]!;
    expect(last.startFrame - last.leadInFrames + lastShot.fromFrame + lastShot.durationInFrames).toBe(props.durationInFrames);
    expect(lastShot.src).toMatch(/b\.jpg$/);
    expect(lastShot.durationInFrames).toBeGreaterThanOrEqual(45);
  });

  it("chains and loops short clips until the scene (plus lead-in) is filled, never ending on a sliver", () => {
    const footage = [clip(0, "C:\\a.mp4", 20), clip(1, "C:\\b.mp4", 2), clip(1, "C:\\c.mp4", 3)];
    const scene = buildRenderPlan(ctx(footage), VIDEO).props.scenes[1]!;
    const covered = scene.segments.reduce((sum, s) => sum + s.durationInFrames, 0);
    expect(covered).toBe(scene.leadInFrames + scene.durationInFrames);
    // 193 frames; playable b = 60 - 2 safety - 8 crossfade = 50, c = 80: b c b + a 13-frame c, grown to 45.
    expect(scene.segments.map((s) => [s.src.slice(-5), s.durationInFrames])).toEqual([
      ["b.mp4", 50],
      ["c.mp4", 53],
      ["b.mp4", 45],
      ["c.mp4", 45],
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

  it("carries the emphasis flag, treating an absent flag as emphasized", () => {
    const w: WordTiming[] = [
      { word: "interior", startMs: 0, endMs: 300, emphasis: true },
      { word: "de", startMs: 300, endMs: 400, emphasis: false },
      { word: "um", startMs: 400, endMs: 500 },
    ];
    const [chunk] = buildCaptionChunks([{ text: "", startMs: 0, endMs: 500, words: w }], 30);
    expect(chunk!.words.map((x) => x.emphasis)).toEqual([true, false, true]);
  });
});

// Regression: run 20261003-003038-449c rendered "PLANETAÉ" — the highlighted word was scaled up and its
// outline swallowed the inter-word gap. Highlighting must never change a word's box or outline.
describe("caption word spacing", () => {
  const FONT_SIZES = [40, 72, 96];

  it("styles highlighted and plain words identically except for color", () => {
    for (const captions of [style().captions, style({ highlight: "color" }).captions]) {
      for (const fontSize of FONT_SIZES) {
        const { color: activeColor, ...active } = captionWordStyle(true, fontSize, captions);
        const { color: plainColor, ...plain } = captionWordStyle(false, fontSize, captions);
        expect(active).toEqual(plain);
        expect(activeColor).not.toBe(plainColor);
      }
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

describe("keyword highlight", () => {
  // "o INTERIOR de um PLANETA": frames 0, 10, 20, 30, 40.
  const chunk: CaptionWordProps[] = [
    { text: "o", startFrame: 0, endFrame: 8, emphasis: false },
    { text: "interior", startFrame: 10, endFrame: 18, emphasis: true },
    { text: "de", startFrame: 20, endFrame: 28, emphasis: false },
    { text: "um", startFrame: 30, endFrame: 38, emphasis: false },
    { text: "planeta", startFrame: 40, endFrame: 48, emphasis: true },
  ];
  const lit = (mode: RenderStyle["captions"]["highlight"]) => [0, 10, 20, 30, 40, 47].map((f) => highlightedWordIndex(chunk, f, mode));

  it("'keywords' lights only content words, keeping the last keyword lit over the small words after it", () => {
    expect(lit("keywords")).toEqual([-1, 1, 1, 1, 4, 4]);
  });

  it("'color' lights the spoken word, whatever it is (old behaviour)", () => {
    expect(lit("color")).toEqual([0, 1, 2, 3, 4, 4]);
  });

  it("'none' lights nothing", () => {
    expect(lit("none")).toEqual([-1, -1, -1, -1, -1, -1]);
  });

  it("is the default and treats words without the flag as keywords", () => {
    expect(DEFAULT_RENDER_STYLE.captions.highlight).toBe("keywords");
    const legacy = buildCaptionChunks([{ text: "", startMs: 0, endMs: 1000, words: words(3) }], 30)[0]!.words;
    expect(highlightedWordIndex(legacy, legacy[2]!.startFrame, "keywords")).toBe(2);
  });
});

// Scene 1 in ctx() spans 8 lead-in frames + 185 frames = 193 frames (max shot 4.5 s = 135 frames).
describe("scenes with still images", () => {
  const scene1 = (footage: FootageClip[], visual: Partial<RenderStyle["visual"]> = {}) =>
    buildRenderPlan(ctx(footage), VIDEO, style({}, visual)).props.scenes[1]!;

  it("splits a single image that outlasts the max shot into reframed shots", () => {
    const segments = scene1([image(0, "C:/a.jpg"), image(1, "C:/b.jpg")]).segments;
    expect(layout(segments)).toEqual([["image", "b.jpg", 97], ["image", "b.jpg", 96]]);
    expect(segments[1]!.motion).not.toEqual(segments[0]!.motion);
    expect(layout(scene1([image(0, "C:/a.jpg"), image(1, "C:/b.jpg")], { maxShotSeconds: 12 }).segments)).toEqual([["image", "b.jpg", 193]]);
  });

  it("splits a scene evenly between two images", () => {
    const segments = scene1([image(0, "C:/a.jpg"), image(1, "C:/b.jpg"), image(1, "C:/c.jpg")]).segments;
    expect(layout(segments)).toEqual([["image", "b.jpg", 97], ["image", "c.jpg", 96]]);
    expect(segments[1]!.fromFrame).toBe(97);
  });

  it("splits image + video evenly when the video is long enough", () => {
    expect(layout(scene1([image(0, "C:/a.jpg"), image(1, "C:/b.jpg"), clip(1, "C:/v.mp4", 20)]).segments)).toEqual([
      ["image", "b.jpg", 97],
      ["video", "v.mp4", 96],
    ]);
  });

  it("plays a short video once and gives the leftover to the image instead of looping", () => {
    // playable v = 60 - 2 safety - 8 crossfade = 50; the image's 143 frames become two shots.
    expect(layout(scene1([image(0, "C:/a.jpg"), clip(1, "C:/v.mp4", 2), image(1, "C:/b.jpg")]).segments)).toEqual([
      ["video", "v.mp4", 50],
      ["image", "b.jpg", 72],
      ["image", "b.jpg", 71],
    ]);
  });

  it("gives stills a Ken Burns zoom to 1.12 with a sideways pan", () => {
    for (const { motion } of scene1([image(0, "C:/a.jpg"), image(1, "C:/b.jpg"), image(1, "C:/c.jpg")]).segments) {
      expect(motion.scaleFrom).toBe(1);
      expect(motion.scaleTo).toBeCloseTo(1.12);
      expect(Math.abs(motion.panXToPct)).toBe(IMAGE_PAN_PCT);
    }
  });

  it("alternates pan direction between consecutive scenes and between stills in a scene", () => {
    const footage = [image(0, "C:/a.jpg"), image(1, "C:/b.jpg"), image(1, "C:/c.jpg")];
    const { scenes } = buildRenderPlan(ctx(footage), VIDEO, style({}, { openingPunchIn: false })).props;
    const pans = scenes.map((s) => s.segments.map((seg) => Math.sign(seg.motion.panXToPct)));
    expect(pans[0]![0]).toBe(-pans[1]![0]!);
    expect(pans[1]![0]).toBe(-pans[1]![1]!);
  });

  it("keeps videos on a plain eased push-in without pan", () => {
    const [segment] = scene1([clip(0, "C:/a.mp4", 20), clip(1, "C:/b.mp4", 20)]).segments;
    expect(segment!.motion).toEqual({ scaleFrom: 1, scaleTo: 1.08, panXFromPct: 0, panXToPct: 0, panYFromPct: 0, panYToPct: 0, easing: "inOut" });
  });
});

describe("shot planning", () => {
  const FPS = 30;
  const plan = (sceneFrames: number, clips: FootageClip[], visual: Partial<RenderStyle["visual"]> = {}, sceneOrdinal = 3) =>
    planSceneShots({ sceneFrames, clips, srcOf: (c) => c.path, fps: FPS, visual: { ...VISUAL_DEFAULTS, ...visual }, sceneOrdinal });
  const CLIP_SETS: Record<string, FootageClip[]> = {
    oneImage: [image(0, "a.jpg")],
    threeImages: [image(0, "a.jpg"), image(0, "b.jpg"), image(0, "c.jpg")],
    longVideo: [clip(0, "v.mp4", 20)],
    shortVideos: [clip(0, "v.mp4", 2), clip(0, "w.mp4", 3.5)],
    mixed: [image(0, "a.jpg"), clip(0, "v.mp4", 3), clip(0, "w.mp4", 20)],
    tinyVideoAndImage: [clip(0, "t.mp4", 0.3), image(0, "a.jpg")],
  };

  /** Edges stay hidden at every frame: scale in [1, SAFE_MAX_ZOOM] and each pan within the zoom's slack. */
  function expectEdgesHidden(segment: ClipSegment, label: string): void {
    for (let f = 0; f < segment.durationInFrames; f++) {
      const cam = cameraAt(segment.motion, f, segment.durationInFrames);
      expect(cam.scale, label).toBeGreaterThanOrEqual(1);
      expect(cam.scale, label).toBeLessThanOrEqual(SAFE_MAX_ZOOM + 1e-9);
      expect(Math.abs(cam.panXPct), label).toBeLessThanOrEqual(maxSafePanPct(cam.scale) + 1e-9);
      expect(Math.abs(cam.panYPct), label).toBeLessThanOrEqual(maxSafePanPct(cam.scale) + 1e-9);
    }
  }

  it("never holds one framing longer than maxShotSeconds, for any scene length, and tiles the scene", () => {
    for (const maxShotSeconds of [2, 4.5, 12]) {
      const maxFrames = Math.round(maxShotSeconds * FPS);
      for (const [name, clips] of Object.entries(CLIP_SETS)) {
        for (let sceneFrames = 1; sceneFrames <= 1200; sceneFrames += 7) {
          for (const ordinal of [0, 1]) {
            const segments = plan(sceneFrames, clips, { maxShotSeconds }, ordinal);
            const label = `${name} ${sceneFrames}f max ${maxShotSeconds}s ord ${ordinal}`;
            let cursor = 0;
            for (const s of segments) {
              expect(s.fromFrame, label).toBe(cursor);
              expect(s.durationInFrames, label).toBeGreaterThan(0);
              expect(s.durationInFrames, label).toBeLessThanOrEqual(maxFrames);
              cursor += s.durationInFrames;
            }
            expect(cursor, label).toBe(sceneFrames);
          }
        }
      }
    }
  });

  it("splits an 18 s single-image scene into >= 4 shots, each visibly reframed from the previous one", () => {
    for (const visual of [{}, { imagePan: false }, { imageZoom: 1.2 }, { imageZoom: 1.25 }, { motionEasing: "linear" as const }]) {
      const segments = plan(540, CLIP_SETS.oneImage!, visual);
      expect(segments.length).toBeGreaterThanOrEqual(4);
      segments.slice(1).forEach((next, i) => {
        const prev = segments[i]!;
        const end = cameraAt(prev.motion, prev.durationInFrames - 1, prev.durationInFrames);
        const start = cameraAt(next.motion, 0, next.durationInFrames);
        const zoomJump = Math.abs(end.scale - start.scale);
        const panJump = Math.max(Math.abs(end.panXPct - start.panXPct), Math.abs(end.panYPct - start.panYPct));
        expect(zoomJump >= 0.05 || panJump >= 2.5, `${JSON.stringify(visual)} cut ${i + 1}`).toBe(true);
        expect(next.fadeInFrames).toBe(0); // same picture: punch-in jump cut, no ghosting dissolve
      });
      segments.forEach((s, i) => expectEdgesHidden(s, `${JSON.stringify(visual)} shot ${i}`));
    }
  });

  it("cycles the scene's clips (A B C A ...) and dissolves between different media", () => {
    const segments = plan(600, CLIP_SETS.threeImages!);
    expect(segments.map((s) => s.src)).toEqual(["a.jpg", "b.jpg", "c.jpg", "a.jpg", "b.jpg", "c.jpg"]);
    expect(segments.slice(1).every((s) => s.fadeInFrames === CROSSFADE_FRAMES)).toBe(true);
    expect(plan(600, CLIP_SETS.threeImages!, { crossfadeFrames: 0 }).every((s) => s.fadeInFrames === 0)).toBe(true);
  });

  it("cuts to other parts of a long video instead of playing it straight", () => {
    const segments = plan(400, CLIP_SETS.longVideo!);
    const playable = 20 * FPS - 2 - CROSSFADE_FRAMES;
    expect(segments.length).toBe(3);
    expect(segments[0]!.trimBeforeFrames).toBe(0);
    segments.slice(1).forEach((s, i) => {
      const prev = segments[i]!;
      expect(s.trimBeforeFrames).toBeGreaterThan(prev.trimBeforeFrames + prev.durationInFrames); // skips ahead
    });
    for (const s of segments) expect(s.trimBeforeFrames + s.durationInFrames).toBeLessThanOrEqual(playable);
    expect(segments.map((s) => s.motion.scaleFrom < s.motion.scaleTo)).toEqual([true, false, true]); // push / pull / push
  });

  it("skips a video too short to read as a shot when the scene has other footage", () => {
    expect(plan(300, CLIP_SETS.tinyVideoAndImage!).every((s) => s.src === "a.jpg")).toBe(true);
  });

  it("keeps every framing of every clip set inside the safe zoom and slack", () => {
    for (const [name, clips] of Object.entries(CLIP_SETS)) {
      for (const imageZoom of [1, 1.05, 1.12, 1.25]) {
        plan(700, clips, { imageZoom, videoZoom: 1.2 }, 0).forEach((s, i) => expectEdgesHidden(s, `${name} z${imageZoom} shot ${i}`));
      }
    }
  });
});

describe("opening and easing", () => {
  const openingShot = (visual: Partial<RenderStyle["visual"]> = {}, footage = [image(0, "C:/a.jpg"), image(1, "C:/b.jpg")]) =>
    buildRenderPlan(ctx(footage), VIDEO, style({}, visual)).props.scenes[0]!.segments[0]!;

  it("punches in 1.0 -> 1.2 on the opening shot, cut within ~3 s, fast from the first frames", () => {
    for (const footage of [[image(0, "C:/a.jpg")], [clip(0, "C:/a.mp4", 20)]]) {
      const shot = openingShot({}, footage);
      expect(shot.motion).toMatchObject({ scaleFrom: 1, scaleTo: OPENING_PUNCH_ZOOM, easing: "out" });
      expect(shot.durationInFrames).toBeLessThanOrEqual(OPENING_PUNCH_SECONDS * 30);
      const third = cameraAt(shot.motion, Math.round(shot.durationInFrames / 3), shot.durationInFrames);
      expect(third.scale - 1).toBeGreaterThan(0.5 * (OPENING_PUNCH_ZOOM - 1));
    }
  });

  it("only the opening shot punches in; openingPunchIn=false falls back to the regular move", () => {
    const { scenes } = buildRenderPlan(ctx([image(0, "C:/a.jpg"), image(1, "C:/b.jpg")]), VIDEO).props;
    const punches = scenes.flatMap((s) => s.segments).filter((s) => s.motion.scaleTo === OPENING_PUNCH_ZOOM && s.motion.easing === "out");
    expect(punches).toHaveLength(1);
    const regular = openingShot({ openingPunchIn: false });
    expect(regular.motion).toMatchObject({ scaleFrom: 1, scaleTo: 1.12, easing: "inOut" });
    expect(regular.durationInFrames).toBe(120); // a 4 s scene fits one shot
  });

  it("eases moves when motionEasing='ease' and keeps them linear otherwise", () => {
    const motion: SegmentMotion = { scaleFrom: 1, scaleTo: 1.12, panXFromPct: 0, panXToPct: 4, panYFromPct: 0, panYToPct: 0, easing: "inOut" };
    const early = (m: SegmentMotion) => cameraAt(m, 10, 101).scale - 1;
    expect(early(motion)).toBeLessThan(0.12 * 0.1 * 0.5); // slow start
    expect(cameraAt(motion, 50, 101).scale).toBeCloseTo(1.06, 3); // symmetric
    expect(early({ ...motion, easing: "linear" })).toBeCloseTo(0.012, 6);
    const linear = buildRenderPlan(ctx([image(0, "C:/a.jpg"), image(1, "C:/b.jpg")]), VIDEO, style({}, { motionEasing: "linear" })).props;
    expect(linear.scenes.flatMap((s) => s.segments).every((s) => s.motion.easing === "linear")).toBe(true);
  });
});

describe("overlay hook (cover text)", () => {
  const footage = [image(0, "C:/a.jpg"), image(1, "C:/b.jpg")];

  it("is uppercased, fully visible at frame 0 and gone at overlayHookSeconds", () => {
    const { overlay } = buildRenderPlan(ctx(footage, "  Chove diamante?  "), VIDEO).props;
    expect(overlay).toEqual({ text: "CHOVE DIAMANTE?", endFrame: 75, fadeFrames: 9 });
    expect(overlayOpacity(0, overlay!)).toBe(1);
    expect(overlayOpacity(65, overlay!)).toBe(1);
    expect(overlayOpacity(70, overlay!)).toBeLessThan(1);
    expect(overlayOpacity(75, overlay!)).toBe(0);
    expect(overlayOpacity(200, overlay!)).toBe(0);
    const longer = buildRenderPlan(ctx(footage, "x"), VIDEO, style({}, { overlayHookSeconds: 4 })).props.overlay!;
    expect(longer.endFrame).toBe(120);
  });

  it("is absent without overlayText or with overlayHook=false", () => {
    expect(buildRenderPlan(ctx(footage), VIDEO).props.overlay).toBeNull();
    expect(buildRenderPlan(ctx(footage, "   "), VIDEO).props.overlay).toBeNull();
    expect(buildRenderPlan(ctx(footage, "CHOVE DIAMANTE?"), VIDEO, style({}, { overlayHook: false })).props.overlay).toBeNull();
  });

  it("sits in the top of the IG 3:4 grid crop, big, and never reaches the captions", () => {
    for (const text of ["CHOVE DIAMANTE?", "O PLANETA QUE CHOVE DIAMANTES", "UAU", "INACREDITAVELMENTE DESCONHECIDO AINDA HOJE"]) {
      for (const captions of [style().captions, style({ font: "impact", maxFontPx: 140 }).captions]) {
        const o = overlayLayout(text, 1080, 1920, captions);
        const top = o.centerY - o.height / 2;
        const bottom = o.centerY + o.height / 2;
        expect(top, text).toBeGreaterThanOrEqual(1920 * GRID_SAFE_TOP);
        expect(o.centerY / 1920, text).toBeGreaterThanOrEqual(0.18);
        expect(o.centerY / 1920, text).toBeLessThanOrEqual(0.24);
        if (text.length <= 30) expect(o.lines, text).toBeLessThanOrEqual(2);
        const captionTop = captionBox(1080, 1920, captions).top - captions.maxFontPx * 1.1; // two caption lines, centered
        expect(bottom, text).toBeLessThan(captionTop);
        expect(o.left + o.width, text).toBeLessThanOrEqual(1080 * 0.92 + 1e-9);
      }
    }
    expect(overlayLayout("CHOVE DIAMANTE?", 1080, 1920).fontSize).toBeGreaterThan(CAPTION_DEFAULTS.maxFontPx);
  });
});

describe("render style (Configurações)", () => {
  const twoScenes = [clip(0, "C:/a.mp4", 20), image(1, "C:/b.jpg")];

  it("defaults reproduce the configured look", () => {
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
    expect(merged.captions).toMatchObject({ font: "impact", maxFontPx: 120, highlight: "keywords" });
    expect(renderStyleFrom({ visual: { maxShotSeconds: 3 } }, { visual: { tailSeconds: 0.3 } }).visual).toMatchObject({
      maxShotSeconds: 3,
      tailSeconds: 0.3,
      overlayHook: true,
      motionEasing: "ease",
    });
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

  it("crossfadeFrames=0 gives hard cuts between scenes and shots", () => {
    const { scenes } = buildRenderPlan(ctx(twoScenes), VIDEO, style({}, { crossfadeFrames: 0 })).props;
    expect(scenes.map((s) => s.leadInFrames)).toEqual([0, 0]);
    expect(scenes.flatMap((s) => s.segments).every((s) => s.fadeInFrames === 0)).toBe(true);
  });

  it("zoom 1.0 disables the camera moves; imagePan=false keeps the zoom without pan", () => {
    const motions = (visual: Partial<RenderStyle["visual"]>) =>
      buildRenderPlan(ctx(twoScenes), VIDEO, style({}, { openingPunchIn: false, motionEasing: "linear", ...visual })).props.scenes.flatMap((s) =>
        s.segments.map((seg) => seg.motion),
      );
    const still: SegmentMotion = { scaleFrom: 1, scaleTo: 1, panXFromPct: 0, panXToPct: 0, panYFromPct: 0, panYToPct: 0, easing: "linear" };
    expect(motions({ imageZoom: 1, videoZoom: 1 })).toEqual([still, still, still]);
    const noPan = motions({ imagePan: false });
    expect(noPan[1]).toEqual({ ...still, scaleTo: 1.12 });
    for (const m of noPan) expect([m.panXFromPct, m.panXToPct, m.panYFromPct, m.panYToPct]).toEqual([0, 0, 0, 0]);
  });

  it("never pans beyond the edge slack of the configured zoom", () => {
    for (const imageZoom of [1, 1.01, 1.05, 1.12, 1.2, 1.25]) {
      const m = buildRenderPlan(ctx(twoScenes), VIDEO, style({}, { imageZoom })).props.scenes[1]!.segments[0]!.motion;
      expect(Math.abs(m.panXToPct)).toBeLessThanOrEqual(maxSafePanPct(imageZoom));
      expect(Math.abs(m.panXToPct)).toBeLessThanOrEqual(IMAGE_PAN_PCT);
    }
  });
});
