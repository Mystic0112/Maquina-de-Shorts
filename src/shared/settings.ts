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

export const VoiceExtrasSchema = z.object({
  rate: z.string().regex(/^[+-]\d+%$/).optional(), // e.g. "+5%"
  pitch: z.string().regex(/^[+-]\d+Hz$/).optional(), // e.g. "-2Hz"
  volume: z.string().regex(/^[+-]\d+%$/).optional(), // e.g. "+0%"
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
  highlight: z.enum(["color", "none"]).optional(),
  /** Vertical center of the caption block as a fraction of frame height (Shorts UI covers the bottom ~20%). */
  verticalPosition: z.number().min(0.3).max(0.75).optional(),
});

export const VisualSettingsSchema = z.object({
  imageZoom: z.number().min(1).max(1.25).optional(),
  videoZoom: z.number().min(1).max(1.2).optional(),
  imagePan: z.boolean().optional(),
  crossfadeFrames: z.number().int().min(0).max(20).optional(),
  /** Dark gradient behind the caption area for legibility. */
  captionBackdrop: z.boolean().optional(),
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
});

/** Instagram Reels publisher (config section `instagram`). Off by default; needs `npm run auth:instagram`. */
export const InstagramSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  /** Rolling-24h cap counted over Instagram's own history records (Meta's own limit is checked too). */
  maxPostsPerDay: z.number().int().min(0).max(50).optional(),
});

export type CaptionSettings = z.infer<typeof CaptionSettingsSchema>;
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
  highlight: "color",
  verticalPosition: 0.62,
};

export const VISUAL_DEFAULTS: Required<VisualSettings> = {
  imageZoom: 1.12,
  videoZoom: 1.08,
  imagePan: true,
  crossfadeFrames: 8,
  captionBackdrop: true,
};

export const SCRIPT_DEFAULTS: Required<Omit<ScriptSettings, "cta">> & Pick<ScriptSettings, "cta"> = {
  minWords: 130,
  maxWords: 190,
  minScenes: 4,
  maxScenes: 7,
  tone: "curioso",
  cta: undefined,
  factCheck: true,
};

export const VOICE_EXTRAS_DEFAULTS: Required<VoiceExtras> = { rate: "+0%", pitch: "+0Hz", volume: "+0%" };

export const INSTAGRAM_DEFAULTS: Required<InstagramSettings> = { enabled: false, maxPostsPerDay: 3 };

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

/** Everything the Remotion composition needs to style a render (passed inside inputProps). */
export interface RenderStyle {
  captions: Required<CaptionSettings>;
  visual: Required<VisualSettings>;
}

function stripUndefined<T extends object>(o: T | undefined): Partial<T> {
  if (!o) return {};
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
