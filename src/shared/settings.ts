// User-editable pipeline settings (edited from the dashboard "Configurações" page, stored in
// config/pipeline.config.json). Every new section is optional so older config files stay valid;
// resolve*() fills defaults that match the pipeline's behaviour before settings existed.
import { z } from "zod";

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "cor no formato #RRGGBB");

export const CAPTION_FONTS = {
  "arial-black": '"Arial Black", "Segoe UI Black", Impact, Arial, sans-serif',
  impact: 'Impact, "Arial Black", "Segoe UI Black", Arial, sans-serif',
  "segoe-black": '"Segoe UI Black", "Arial Black", Impact, Arial, sans-serif',
  verdana: 'Verdana, "Segoe UI", Arial, sans-serif',
} as const;
export type CaptionFont = keyof typeof CAPTION_FONTS;

/**
 * TTS engines: Kokoro (default; local model, free; needs its own venv, see KOKORO_PYTHON), Gemini TTS (paid API)
 * or edge-tts (Microsoft's unofficial endpoint; 403 since Oct 2026).
 */
export const VOICE_ENGINES = ["gemini", "kokoro", "edge-tts"] as const;
export type VoiceEngine = (typeof VOICE_ENGINES)[number];

export const VoiceExtrasSchema = z.object({
  engine: z.enum(VOICE_ENGINES).optional(),
  /** edge-tts only (Gemini paces itself; steer it with `style`). */
  rate: z.string().regex(/^[+-]\d+%$/).optional(), // e.g. "+5%"
  /** edge-tts only. */
  pitch: z.string().regex(/^[+-]\d+Hz$/).optional(), // e.g. "-2Hz"
  /** edge-tts only. */
  volume: z.string().regex(/^[+-]\d+%$/).optional(), // e.g. "+0%"
  /** Longest silence kept between sentences/words in the narration, in ms (longer pauses are trimmed). Both engines. */
  maxPauseMs: z.number().int().min(0).max(1500).optional(),
  /** Gemini TTS model id (e.g. gemini-3.8-flash-tts, gemini-3.8-flash-lite-tts). */
  geminiModel: z.string().min(1).optional(),
  /** Gemini voice: prebuilt ("Fenrir", "Puck"), voice library ("pt-br-podcaster-12") or designed ("voice_..."). */
  geminiVoice: z.string().min(1).optional(),
  /** Gemini delivery instruction (speech_metadata.style), in pt-BR. */
  style: z.string().max(500).optional(),
  /** Kokoro voice id: pt-BR voices are pm_alex, pf_dora and pm_santa. */
  kokoroVoice: z.string().min(1).optional(),
  /** Kokoro speaking speed multiplier. */
  kokoroSpeed: z.number().min(0.5).max(2).optional(),
});

export const CaptionSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  uppercase: z.boolean().optional(),
  maxWordsPerCue: z.number().int().min(1).max(4).optional(),
  font: z.enum(Object.keys(CAPTION_FONTS) as [CaptionFont, ...CaptionFont[]]).optional(),
  maxFontPx: z.number().int().min(48).max(140).optional(),
  textColor: hexColor.optional(),
  highlightColor: hexColor.optional(),
  strokeColor: hexColor.optional(),
  /** color = every spoken word lights up; keywords = only content words (emphasis); none = no highlight. */
  highlight: z.enum(["color", "keywords", "none"]).optional(),
  /** Never end a caption group on an article/preposition ("O CHEIRO DA" / "LUA"). */
  avoidDanglingWords: z.boolean().optional(),
  /** Vertical center of the caption block as a fraction of frame height (Shorts UI covers the bottom ~20%). */
  verticalPosition: z.number().min(0.3).max(0.75).optional(),
});

export const VisualSettingsSchema = z.object({
  imageZoom: z.number().min(1).max(1.25).optional(),
  videoZoom: z.number().min(1).max(1.2).optional(),
  imagePan: z.boolean().optional(),
  /** Zoom (scale change) only on clips whose main subject is a face; objects and places get a pan or stay still. */
  zoomOnlyOnFaces: z.boolean().optional(),
  crossfadeFrames: z.number().int().min(0).max(20).optional(),
  /** Dark gradient behind the caption area for legibility. */
  captionBackdrop: z.boolean().optional(),
  /** Longest a video plays before cutting to another part of it. Stills are never cut: each shows once, for its whole share of the scene. */
  maxShotSeconds: z.number().min(2).max(12).optional(),
  /** On-screen hook/cover text (Script.overlayText) at the top in the first seconds. */
  overlayHook: z.boolean().optional(),
  overlayHookSeconds: z.number().min(1).max(5).optional(),
  /** Faster zoom-in on the opening shot to stop the scroll. */
  openingPunchIn: z.boolean().optional(),
  motionEasing: z.enum(["linear", "ease"]).optional(),
  /** Silent tail after the narration ends, in seconds (0.5 before; a short tail loops better). */
  tailSeconds: z.number().min(0).max(1.5).optional(),
});

export const ScriptSettingsSchema = z.object({
  minWords: z.number().int().min(60).max(300).optional(),
  maxWords: z.number().int().min(80).max(350).optional(),
  minScenes: z.number().int().min(2).max(10).optional(),
  maxScenes: z.number().int().min(3).max(12).optional(),
  tone: z.enum(["curioso", "empolgado", "misterioso", "didatico"]).optional(),
  /** Fixed closing line; empty/absent lets the model write a short CTA. */
  cta: z.string().max(120).optional(),
  /** Web-grounded fact-check of the script before footage/voice (stage 02b-factCheck). Default true. */
  factCheck: z.boolean().optional(),
  /** Last line pays off / reconnects to the hook so the Short loops (instead of a generic sign-off). */
  loopEnding: z.boolean().optional(),
  /** curto = short varied CTA without the word "canal"; nenhum = no CTA (ignored when a fixed `cta` is set). */
  ctaStyle: z.enum(["curto", "nenhum"]).optional(),
  /** Narrative formats rotated by 01-pickTopic. */
  formats: z.array(z.enum(["mito-verdade", "lista", "e-se", "comparacao", "linha-do-tempo", "pergunta-resposta"])).min(1).optional(),
  /** Allow specific footage queries (historical places, missions, artworks, deceased historical figures). */
  specificFootage: z.boolean().optional(),
});

/** Instagram Reels publisher (config section `instagram`). Off by default; needs `npm run auth:instagram`. */
export const InstagramSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  /** Rolling-24h cap counted over Instagram's own history records (Meta's own limit is checked too). */
  maxPostsPerDay: z.number().int().min(0).max(50).optional(),
});

/** Stage 05b-planEdits: stickers/SFX cues that match the narration (library in assets/memes/). Off by default. */
export const EditingSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  /** Hard cap on cues per video (the model is asked for fewer when the narration is short). */
  maxCuesPerVideo: z.number().int().min(1).max(12).optional(),
  /** Gain of sound effects relative to full scale (narration stays at 1). */
  sfxVolume: z.number().min(0).max(1).optional(),
});

/** Where the owner's watermark sits; vertical positions keep clear of the Shorts title and the bottom UI. */
export const WATERMARK_POSITIONS = ["top-left", "top-right", "top", "bottom-left", "bottom-right", "bottom"] as const;
export type WatermarkPosition = (typeof WATERMARK_POSITIONS)[number];
/** Placement on a 1080×1920 frame, shared by the Remotion Shorts and the cuts renderer (python/cuts). */
export const WATERMARK_LAYOUT = { margin: 48, topMin: 150, bottomMax: 1920 - 420 } as const;

export const WatermarkSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  /** e.g. "@meucanal"; empty = image only. */
  text: z.string().max(40).optional(),
  /** Project-relative PNG (the dashboard uploads it to data/branding/logo.png); empty = text only. */
  image: z.string().max(200).optional(),
  position: z.enum(WATERMARK_POSITIONS).optional(),
  opacity: z.number().min(0.1).max(1).optional(),
  /** Width of the mark, % of the video width. */
  size: z.number().min(5).max(40).optional(),
});
export type WatermarkSettings = z.infer<typeof WatermarkSettingsSchema>;

export type CaptionSettings = z.infer<typeof CaptionSettingsSchema>;
export type EditingSettings = z.infer<typeof EditingSettingsSchema>;
export type InstagramSettings = z.infer<typeof InstagramSettingsSchema>;
export type VisualSettings = z.infer<typeof VisualSettingsSchema>;
export type ScriptSettings = z.infer<typeof ScriptSettingsSchema>;
export type VoiceExtras = z.infer<typeof VoiceExtrasSchema>;

export const CAPTION_DEFAULTS: Required<CaptionSettings> = {
  enabled: true,
  uppercase: true,
  maxWordsPerCue: 3,
  font: "arial-black",
  maxFontPx: 96,
  textColor: "#FFFFFF",
  highlightColor: "#FFE11A",
  strokeColor: "#000000",
  highlight: "keywords",
  avoidDanglingWords: true,
  verticalPosition: 0.62,
};

export const VISUAL_DEFAULTS: Required<VisualSettings> = {
  imageZoom: 1.12,
  videoZoom: 1.08,
  imagePan: true,
  zoomOnlyOnFaces: true,
  crossfadeFrames: 8,
  captionBackdrop: true,
  maxShotSeconds: 4.5,
  overlayHook: true,
  overlayHookSeconds: 2.5,
  openingPunchIn: true,
  motionEasing: "ease",
  tailSeconds: 0.15,
};

export const SCRIPT_DEFAULTS: Required<Omit<ScriptSettings, "cta">> & Pick<ScriptSettings, "cta"> = {
  // Gemini TTS measured 2.7-3.4 words/s (17-18 chars/s) after pause trimming: 152 words -> 47 s, 172 -> 51 s,
  // 155 long-worded words -> 57 s. 160-195 keeps narrations ~47-71 s, clear of the 45 s gate (was 130-190).
  minWords: 160,
  maxWords: 195,
  minScenes: 4,
  maxScenes: 7,
  tone: "curioso",
  cta: undefined,
  factCheck: true,
  loopEnding: true,
  ctaStyle: "curto",
  formats: ["mito-verdade", "lista", "e-se", "comparacao", "linha-do-tempo", "pergunta-resposta"],
  specificFootage: true,
};

export const VOICE_EXTRAS_DEFAULTS: Required<VoiceExtras> = {
  engine: "kokoro",
  rate: "+10%",
  pitch: "+0Hz",
  volume: "+0%",
  maxPauseMs: 250,
  geminiModel: "gemini-3.8-flash-tts",
  geminiVoice: "Fenrir",
  style: "Narre em português do Brasil, tom curioso e envolvente, ritmo ágil de vídeo curto, sem pausas longas",
  kokoroVoice: "pm_alex",
  kokoroSpeed: 1,
};

export const INSTAGRAM_DEFAULTS: Required<InstagramSettings> = { enabled: false, maxPostsPerDay: 3 };
export const WATERMARK_DEFAULTS: Required<WatermarkSettings> = { enabled: false, text: "", image: "", position: "top-right", opacity: 0.85, size: 18 };
export const EDITING_DEFAULTS: Required<EditingSettings> = { enabled: false, maxCuesPerVideo: 6, sfxVolume: 0.35 };

export function resolveCaptions(s?: CaptionSettings): Required<CaptionSettings> {
  return { ...CAPTION_DEFAULTS, ...stripUndefined(s) };
}
export function resolveVisual(s?: VisualSettings): Required<VisualSettings> {
  return { ...VISUAL_DEFAULTS, ...stripUndefined(s) };
}
export function resolveScript(s?: ScriptSettings): typeof SCRIPT_DEFAULTS {
  const r = { ...SCRIPT_DEFAULTS, ...stripUndefined(s) };
  if (r.maxWords < r.minWords) r.maxWords = r.minWords;
  if (r.maxScenes < r.minScenes) r.maxScenes = r.minScenes;
  return r;
}
export function resolveVoiceExtras(s?: VoiceExtras): Required<VoiceExtras> {
  return { ...VOICE_EXTRAS_DEFAULTS, ...stripUndefined(s) };
}
export function resolveInstagram(s?: InstagramSettings): Required<InstagramSettings> {
  return { ...INSTAGRAM_DEFAULTS, ...stripUndefined(s) };
}
export function resolveWatermark(s?: WatermarkSettings): Required<WatermarkSettings> {
  return { ...WATERMARK_DEFAULTS, ...stripUndefined(s) };
}
export function resolveEditing(s?: EditingSettings): Required<EditingSettings> {
  return { ...EDITING_DEFAULTS, ...stripUndefined(s) };
}

/** Everything the Remotion composition needs to style a render (passed inside inputProps). */
export interface RenderStyle {
  captions: Required<CaptionSettings>;
  visual: Required<VisualSettings>;
}

function stripUndefined<T extends object>(o: T | undefined): Partial<T> {
  if (!o) return {};
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
