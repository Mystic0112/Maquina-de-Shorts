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
  /** Anton (SIL OFL, same file as the cuts' "Impacto" captions): staged into the render bundle by stage 06. */
  anton: 'Anton, Impact, "Arial Narrow", sans-serif',
} as const;
export type CaptionFont = keyof typeof CAPTION_FONTS;

/**
 * TTS engines: Kokoro (default; local model, free; needs its own venv, see KOKORO_PYTHON), Chatterbox (local, MIT,
 * own venv CHATTERBOX_PYTHON; can speak with the owner's own voice from a reference recording), ElevenLabs (the
 * person's own API key; the free plan is non-commercial only), Gemini TTS (paid API) or edge-tts (Microsoft's
 * unofficial endpoint; 403 since Oct 2026). Per-engine metadata (labels, speech rate): src/shared/voiceEngines.ts.
 */
export const VOICE_ENGINES = ["gemini", "kokoro", "chatterbox", "elevenlabs", "edge-tts"] as const;
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
  /** Chatterbox: project-relative (or absolute) 10-15 s recording of a voice the owner has consent to clone; "" = the model's own voice. */
  chatterboxRefAudio: z.string().max(300).optional(),
  /** Chatterbox emotion/intensity (0.5 = neutral). */
  chatterboxExaggeration: z.number().min(0.25).max(2).optional(),
  /** Chatterbox pacing/guidance (0.5 default; lower = slower, more deliberate). */
  chatterboxCfgWeight: z.number().min(0).max(1).optional(),
  /** ElevenLabs model id (eleven_multilingual_v2, eleven_flash_v2_5, ...). */
  elevenlabsModel: z.string().regex(/^[a-z0-9_]{3,60}$/, "id do modelo, ex.: eleven_multilingual_v2").optional(),
  /** ElevenLabs voice id (letters and digits; goes into the request URL, so it is validated). "" = not chosen yet. */
  elevenlabsVoiceId: z.union([z.literal(""), z.string().regex(/^[A-Za-z0-9]{10,40}$/, "id da voz: só letras e números")]).optional(),
  /** ElevenLabs voice stability (0 = more expressive, 1 = more monotone). */
  elevenlabsStability: z.number().min(0).max(1).optional(),
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
  /** Free-text rules from the channel owner, added to the script prompt (stage 02) and the fact-check rewrite (02b). */
  instructions: z.string().max(1000).optional(),
  /**
   * acervo = stock footage search (NASA, Commons, Pexels...); ilustrado = one image generated per beat by agy
   * (lib/illustrate.ts); terminal = no images, one animated terminal card per scene (lib/terminalCards.ts).
   */
  imageSource: z.enum(["acervo", "ilustrado", "terminal"]).optional(),
  /**
   * Who generates the images when imageSource is "ilustrado" (lib/imageProvider.ts). Only "agy" exists today; a new
   * provider (image API, local ComfyUI) is added here and in the registry there. Absent = "agy" (old configs).
   */
  imageProvider: z.enum(["agy"]).optional(),
  /**
   * What to do when the provider fails or its quota runs out: nenhum = stop cleanly (default); acervo = look the
   * missing images up in the stock libraries (same license filters and quality gate). Never a paid API.
   */
  imageFallback: z.enum(["nenhum", "acervo"]).optional(),
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
  instructions: "",
  imageSource: "acervo",
  imageProvider: "agy",
  imageFallback: "nenhum",
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
  chatterboxRefAudio: "",
  chatterboxExaggeration: 0.5,
  chatterboxCfgWeight: 0.5,
  elevenlabsModel: "eleven_multilingual_v2",
  elevenlabsVoiceId: "",
  elevenlabsStability: 0.5,
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

// ---------------------------------------------------------------------------------------------
// LLM: provider and model per task (config section `llm`)
// ---------------------------------------------------------------------------------------------

/**
 * Registry of LLM providers (metadata shared with the dashboard). To add one (Claude Code, OpenAI-compatible...):
 * add an entry here and its factory in PROVIDER_FACTORIES (src/orchestrator/lib/llmClient.ts), which the compiler
 * demands. `paid` = billed per call by API key: it is NEVER used as a fallback unless the owner turns that on
 * for that task (`allowPaid`). `keyEnv` = the key that makes it usable ("" = no key; `command` must exist).
 */
export const LLM_PROVIDERS = {
  "antigravity-cli": { label: "Antigravity CLI (agy)", paid: false, keyEnv: "", command: "agy" },
  gemini: { label: "Gemini (API paga)", paid: true, keyEnv: "GEMINI_API_KEY", command: "" },
  anthropic: { label: "Claude (API paga)", paid: true, keyEnv: "ANTHROPIC_API_KEY", command: "" },
  "claude-code": {
    label: "Claude Code (plano, sem chave)",
    paid: false,
    keyEnv: "",
    command: "claude",
    commandEnv: "CLAUDE_CLI_PATH",
    note:
      "Usa a cota do SEU plano Claude (limite por janela de horas; quando acaba, a tarefa para ou cai na alternativa). " +
      "Nenhuma chave de API é usada. Confira nos termos do seu plano se uso automatizado é permitido: rodar dezenas de vídeos por dia " +
      "pode passar do \"uso comum e individual\". Nunca é ligado por padrão.",
  },
  // `paid` here is the conservative default (a remote service with a key bills per call); a base URL on this computer
  // or local network is free: see isPaidLlmProvider(name, llm). The key is optional for local servers (Ollama).
  "openai-compatible": { label: "OpenAI-compatível (OpenAI, OpenRouter, Ollama, LM Studio...)", paid: true, keyEnv: "OPENAI_COMPAT_API_KEY", command: "" },
} as const satisfies Record<string, LlmProviderMeta>;
/** Shape of a registry entry (optional fields: `commandEnv` = env var that overrides `command`; `note` = help text for the dashboard). */
export interface LlmProviderMeta {
  label: string;
  paid: boolean;
  keyEnv: string;
  command: string;
  commandEnv?: string;
  note?: string;
}
export type LlmProviderName = keyof typeof LLM_PROVIDERS;
export const LLM_PROVIDER_NAMES = Object.keys(LLM_PROVIDERS) as [LlmProviderName, ...LlmProviderName[]];
export const isLlmProviderName = (name: string): name is LlmProviderName => Object.hasOwn(LLM_PROVIDERS, name);
/**
 * True when calls to this provider cost money, so it is never a silent fallback (llmTasks.ts, `allowPaid`).
 * "openai-compatible" is paid unless its base URL (`llm.openaiCompatible.baseUrl`) points to this computer or the local
 * network (isLocalBaseUrl): a missing or invalid URL counts as paid (the safe answer).
 */
export function isPaidLlmProvider(name: LlmProviderName, llm?: Pick<LlmSettings, "openaiCompatible">): boolean {
  if (name !== "openai-compatible") return LLM_PROVIDERS[name].paid;
  const url = parseOpenAiBaseUrl(llm?.openaiCompatible?.baseUrl ?? "");
  return !(url.ok && isLocalBaseUrl(url.url));
}

export type BaseUrlResult = { ok: true; url: string } | { ok: false; error: string };

/**
 * Validates the base URL of an OpenAI-compatible server ("http://localhost:11434/v1"): http/https only, no credentials
 * in the URL, no query and no fragment (the key goes in the Authorization header only). Returns it without trailing "/".
 */
export function parseOpenAiBaseUrl(raw: string): BaseUrlResult {
  const text = raw.trim();
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, error: 'URL base inválida. Use algo como "http://localhost:11434/v1".' };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "A URL base deve começar com http:// ou https://." };
  if (u.username || u.password) return { ok: false, error: "Não coloque usuário nem senha na URL; a chave vai em Chaves e acessos." };
  if (u.hash || text.includes("#")) return { ok: false, error: "A URL base não pode ter fragmento (#...)." };
  if (u.search || text.includes("?")) return { ok: false, error: "A URL base não pode ter parâmetros (?...); a chave vai em Chaves e acessos." };
  return { ok: true, url: `${u.origin}${u.pathname}`.replace(/\/+$/, "") };
}

/** localhost, loopback (127.x, ::1), *.localhost, *.local and private ranges (10.x, 172.16-31.x, 192.168.x). */
export function isLocalBaseUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host === "[::1]" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Key of `llm.models` that was this task's model before `llm.tasks` existed (still honoured when the task has no provider). */
type LegacyModelKey = "script" | "factCheck" | "metadata" | "relevance";

/**
 * Every task that calls an LLM. Image generation and voice have their own cards: they plug in here later
 * (a new entry is enough for the schema, the resolver and the dashboard).
 */
export const LLM_TASKS = {
  script: { label: "Roteiro", hint: "Escreve o roteiro de cada Short.", legacyModel: "script" },
  factCheck: { label: "Checagem de fatos", hint: "Confere o roteiro com busca na web.", legacyModel: "factCheck" },
  metadata: { label: "Título e descrição", hint: "Metadados dos Shorts e dos cortes.", legacyModel: "metadata" },
  relevance: { label: "Relevância das imagens", hint: "Dá nota a cada imagem contra a fala (visão).", legacyModel: "relevance" },
  terminal: { label: "Cartões do formato terminal", hint: "Um cartão animado por cena.", legacyModel: "metadata" },
  cutsSelect: { label: "Cortes: seleção", hint: "Escolhe os trechos do vídeo original." },
  cutsVerify: { label: "Cortes: conferência de sentido", hint: "Confere que o corte não muda o sentido." },
  cutsHumor: { label: "Cortes: humor", hint: "Piadas, emojis e efeitos (vê quadros do vídeo)." },
  cutsCompilation: { label: "Cortes: compilação", hint: "Escolhe os vídeos curtos da compilação." },
} as const satisfies Record<string, { label: string; hint: string; legacyModel?: LegacyModelKey }>;
export type LlmTaskName = keyof typeof LLM_TASKS;
export const LLM_TASK_NAMES = Object.keys(LLM_TASKS) as [LlmTaskName, ...LlmTaskName[]];

const llmProviderEnum = z.enum(LLM_PROVIDER_NAMES);

/**
 * `llm.openaiCompatible`: where the "openai-compatible" provider talks to (OpenAI, OpenRouter, Ollama, LM Studio,
 * gateways). Neither value is a secret; the optional key is OPENAI_COMPAT_API_KEY (Chaves e acessos). The model of a
 * task (`llm.tasks.<t>.model`) wins over `model` here.
 */
export const OpenAiCompatibleSettingsSchema = z.object({
  baseUrl: z
    .string()
    .superRefine((value, ctx) => {
      const r = parseOpenAiBaseUrl(value);
      if (!r.ok) ctx.addIssue({ code: "custom", message: r.error });
    })
    .optional(),
  model: z.string().min(1).optional(),
});
export type OpenAiCompatibleSettings = z.infer<typeof OpenAiCompatibleSettingsSchema>;

export const LlmTaskSettingSchema = z.object({
  /** Absent = the machine's provider (LLM_PROVIDER in .env, default agy). */
  provider: llmProviderEnum.optional(),
  /** Model id of THAT provider (agy aliases for agy, API ids for the others). Absent = provider default. */
  model: z.string().min(1).optional(),
  thinking: z.enum(["default", "minimal", "low", "medium", "high"]).optional(),
  /** Tried once when the provider fails or its quota ends. Absent = no fallback. */
  fallback: z
    .object({
      provider: llmProviderEnum,
      model: z.string().min(1).optional(),
      /** Needed for a paid provider (gemini/anthropic): without it the fallback is ignored. Never on by default. */
      allowPaid: z.boolean().optional(),
    })
    .optional(),
});
export type LlmTaskSetting = z.infer<typeof LlmTaskSettingSchema>;

/** `llm` section of pipeline.config.json. Older files (only `models`) stay valid and behave as before. */
export const LlmSettingsSchema = z.object({
  /** Server of the "openai-compatible" provider. Absent = the provider is not usable. */
  openaiCompatible: OpenAiCompatibleSettingsSchema.optional(),
  /** Legacy, model only (same provider as the machine). Prefer `tasks`; it still applies to tasks without their own provider. */
  models: z
    .object({
      script: z.string().min(1).optional(),
      factCheck: z.string().min(1).optional(),
      metadata: z.string().min(1).optional(),
      relevance: z.string().min(1).optional(),
    })
    .optional(),
  /** Strict on purpose: a typo in a task name would silently drop its provider/fallback rules. */
  tasks: z
    .strictObject(Object.fromEntries(LLM_TASK_NAMES.map((t) => [t, LlmTaskSettingSchema.optional()])) as Record<LlmTaskName, z.ZodOptional<typeof LlmTaskSettingSchema>>)
    .optional(),
});
export type LlmSettings = z.infer<typeof LlmSettingsSchema>;
