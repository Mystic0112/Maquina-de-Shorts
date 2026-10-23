/**
 * Humor layer of a cut, in the style of the owner's reference channel (@oguxtamedia): jokes between asterisks
 * ("*risos stage 3*"), small reaction emoji and quick effects (punch-in, black-and-white spotlight, red flash),
 * placed mostly on laughs and reactions. The agy writes the plan; this module validates it (times inside the
 * kept footage, no overlaps, caps, respectful text) and turns it into the absolute-time job items
 * python/cuts/humor.py draws. Emoji are Noto Emoji 3D PNGs (Apache-2.0), downloaded once at home when used.
 * Never on political channels: the channel setting `humor` defaults to on only for vlogs.
 */
import { join } from "node:path";
import { z } from "zod";
import { paths } from "../lib/config.js";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { buildFrameExtractArgs, resolveFfmpegBinaries, runBinary } from "../lib/ffmpeg.js";
import { generateJsonWithImages, type LlmImage, type LlmProvider } from "../lib/llmClient.js";
import type { CutChannel } from "./config.js";
import type { Interval } from "./jumpcut.js";
import { ensureModelFile, type ModelFile } from "./render.js";
import type { TranscriptWord } from "./transcribe.js";

const NOTO_COMMIT = "e20cbc2bbec1926686be9f9bee7d1d2cfa1fea0e";

/** The reactions the agy may use (emoji -> Noto code point). */
export const EMOJIS: Readonly<Record<string, string>> = {
  "😂": "1f602", "🤣": "1f923", "😱": "1f631", "🤯": "1f92f", "🔥": "1f525", "💀": "1f480", "👀": "1f440", "🤔": "1f914",
  "😳": "1f633", "🥵": "1f975", "😎": "1f60e", "😭": "1f62d", "👏": "1f44f", "💥": "1f4a5", "🚨": "1f6a8", "🧠": "1f9e0",
  "😏": "1f60f", "🥲": "1f972", "😬": "1f62c", "🤡": "1f921", "💯": "1f4af", "😮": "1f62e",
};

export const emojiModel = (emoji: string): ModelFile => {
  const cp = EMOJIS[emoji] as string;
  return {
    label: `emoji ${emoji} (Noto, ~300 KB)`,
    url: `https://github.com/googlefonts/noto-emoji/raw/${NOTO_COMMIT}/3D/png/512/emoji_u${cp}.png`,
    file: join(paths.root, "models", "emoji", `emoji_u${cp}.png`),
    minBytes: 50_000,
    maxBytes: 600_000,
  };
};

/** How long each item stays on screen (s). */
export const DURATION = { joke: 1.6, emoji: 1.0, punch: 0.6, spotlight: 1.2, flash: 0.5 } as const;
/** At most one joke every this many seconds, one emoji every …, and a hard cap on effects. */
const JOKE_EVERY = 12;
const EMOJI_EVERY = 6;
const MAX_EFFECTS = 3;
const JOKE_MAX_CHARS = 34;
const FLASH_MAX_CHARS = 12;

/** Default: humor on vlogs and compilations, off on podcasts (political talk shows) unless the owner turns it on. */
export const humorEnabled = (channel: Pick<CutChannel, "humor" | "style">): boolean => channel.humor ?? channel.style !== "podcast";

export const HumorDraftSchema = z.object({
  jokes: z.array(z.object({ at: z.number(), text: z.string() })).max(12),
  emojis: z.array(z.object({ at: z.number(), emoji: z.string() })).max(20),
  effects: z.array(z.object({ at: z.number(), type: z.enum(["punch", "spotlight", "flash"]), text: z.string().nullable().optional() })).max(6),
});
export type HumorDraft = z.infer<typeof HumorDraftSchema>;

export interface HumorJob {
  jokes: { start: number; end: number; text: string }[];
  emojis: { start: number; end: number; image: string }[];
  effects: { start: number; end: number; type: "punch" | "spotlight" | "flash"; text: string | null }[];
}

export interface HumorInput {
  title: string;
  channelName: string;
  start: number;
  end: number;
  words: readonly TranscriptWord[];
  /** Laughs/reactions (absolute seconds), from jumpcut.livelyMoments. */
  lively: readonly Interval[];
  /** Source video: frames of the clip go to the agy so jokes match what is on screen (absent = text only). */
  sourcePath?: string;
}

/** At most this many frames per clip (one call; each frame is a 512 px JPEG). */
export const MAX_FRAMES = 10;
const MIN_FRAME_GAP = 2;

/**
 * When to grab frames (absolute seconds, sorted): the middle of each laugh first (that is where the jokes and
 * effects go), then evenly spaced fill, never two frames closer than 2 s and only on kept footage.
 */
export function frameTimes(start: number, end: number, lively: readonly Interval[], keep: readonly Interval[], max = MAX_FRAMES): number[] {
  const kept = (t: number) => keep.some(([a, b]) => t >= a && t <= b);
  const out: number[] = [];
  const add = (t: number) => {
    if (out.length < max && t > start && t < end && kept(t) && out.every((x) => Math.abs(x - t) >= MIN_FRAME_GAP)) out.push(Math.round(t * 10) / 10);
  };
  for (const [a, b] of lively) add((a + b) / 2);
  const step = (end - start) / (max + 1);
  for (let i = 1; i <= max; i++) add(start + i * step);
  return out.sort((a, b) => a - b);
}

const rel = (t: number, start: number): string => (t - start).toFixed(1);

export function buildHumorPrompt(input: HumorInput, frameAt: readonly number[] = []): string {
  const lines: string[] = [];
  let line: string[] = [];
  let lineStart = 0;
  for (const w of input.words) {
    if (line.length === 0) lineStart = w.start;
    line.push(w.word);
    if (line.length >= 10 || /[.!?]$/.test(w.word)) {
      lines.push(`[${rel(lineStart, input.start)}] ${line.join(" ")}`);
      line = [];
    }
  }
  if (line.length) lines.push(`[${rel(lineStart, input.start)}] ${line.join(" ")}`);
  const duration = input.end - input.start;
  return [
    "Você é o editor de um canal de cortes engraçados (estilo @oguxtamedia): coloca piadas curtas, emojis de reação e efeitos rápidos por cima do vídeo.",
    `Corte: "${input.title}" (canal ${input.channelName}), ${duration.toFixed(0)} s. Tempos em segundos desde o início do corte.`,
    "",
    "FALA (com o tempo de início de cada trecho):",
    ...lines,
    "",
    `MOMENTOS DE RISADA/REAÇÃO (sem fala): ${input.lively.map(([a, b]) => `${rel(a, input.start)}-${rel(b, input.start)}`).join(", ") || "nenhum detectado"}`,
    "",
    ...(frameAt.length
      ? [
          `IMAGENS: você recebe ${frameAt.length} quadros do corte, nesta ordem: ${frameAt.map((t, i) => `quadro ${i + 1} = ${rel(t, input.start)} s`).join(", ")}. Use o que aparece (caras, reações, o carro, o que deu errado) nas piadas, e ponha "spotlight"/"punch" onde a imagem justifica.`,
          "",
        ]
      : []),
    "Monte o plano:",
    `- "jokes": piadas do editor ENTRE ASTERISCOS, curtas (até ${JOKE_MAX_CHARS} letras), com termos do assunto (ex. em carros: "*risos stage 3*", "*gargalhadas repletas de remap*", "*APERTANDO*"). No máximo uma a cada ${JOKE_EVERY} s. Prefira os momentos de risada e as pausas.`,
    `- "emojis": reações (use só estes: ${Object.keys(EMOJIS).join(" ")}), no máximo um a cada ${EMOJI_EVERY} s, no instante da reação.`,
    `- "effects": no máximo ${MAX_EFFECTS}: "punch" (zoom rápido numa risada ou susto), "spotlight" (preto e branco com mira, quando alguém faz algo errado ou suspeito), "flash" (tela vermelha com uma palavra curta em CAIXA ALTA, até ${FLASH_MAX_CHARS} letras, ex.: "ERRADO").`,
    "",
    "REGRAS: ria da situação, nunca da pessoa: nada que humilhe, xingue ou ridicularize alguém; sem palavrão; não invente fatos que mudem o sentido do que foi dito. Menos é mais: se não tiver graça, deixe a lista vazia.",
    "",
    'Responda só com JSON: {"jokes":[{"at":12.5,"text":"*risos stage 3*"}],"emojis":[{"at":8.0,"emoji":"😂"}],"effects":[{"at":20.1,"type":"punch","text":null}]}',
  ].join("\n");
}

const insideKept = (t: number, keep: readonly Interval[]): boolean => keep.some(([a, b]) => t >= a && t <= b);

/** Keeps items in order, dropping any that start before the previous one ended plus `gap`. */
function spaced<T extends { start: number; end: number }>(items: T[], gap: number, max: number): T[] {
  const out: T[] = [];
  for (const item of [...items].sort((a, b) => a.start - b.start)) {
    const prev = out.at(-1);
    if (prev && item.start < prev.end + gap) continue;
    out.push(item);
    if (out.length === max) break;
  }
  return out;
}

const asterisked = (text: string): string => {
  const core = text.replace(/\*/g, "").replace(/\s+/g, " ").trim();
  return core ? `*${core.slice(0, JOKE_MAX_CHARS)}*` : "";
};

/** Draft (relative times) -> absolute, on-screen-safe items; emoji images are resolved by the caller. */
export function validateHumor(draft: HumorDraft, start: number, end: number, keep: readonly Interval[]): { jokes: HumorJob["jokes"]; emojis: { start: number; end: number; emoji: string }[]; effects: HumorJob["effects"] } {
  const span = (at: number, seconds: number) => ({ start: start + at, end: Math.min(end, start + at + seconds) });
  const ok = (at: number) => Number.isFinite(at) && at >= 0 && start + at < end && insideKept(start + at, keep);
  const duration = end - start;
  const jokes = spaced(
    draft.jokes.filter((j) => ok(j.at)).map((j) => ({ ...span(j.at, DURATION.joke), text: asterisked(j.text) })).filter((j) => j.text),
    JOKE_EVERY - DURATION.joke,
    Math.max(1, Math.floor(duration / JOKE_EVERY)),
  );
  const emojis = spaced(
    draft.emojis.filter((e) => ok(e.at) && EMOJIS[e.emoji]).map((e) => ({ ...span(e.at, DURATION.emoji), emoji: e.emoji })),
    EMOJI_EVERY - DURATION.emoji,
    Math.max(1, Math.floor(duration / EMOJI_EVERY)),
  );
  const effects = spaced(
    draft.effects
      .filter((f) => ok(f.at))
      .map((f) => ({ ...span(f.at, DURATION[f.type]), type: f.type, text: f.type === "flash" && f.text ? f.text.trim().toUpperCase().slice(0, FLASH_MAX_CHARS) : null })),
    2,
    MAX_EFFECTS,
  );
  return { jokes, emojis, effects };
}

export interface PlanHumorOptions {
  provider?: LlmProvider;
  model?: string;
  fetchFn?: typeof fetch;
  log?: (m: string) => void;
}

/** Asks the agy, validates, downloads the emoji it used. Any failure = no humor for this clip (never blocks it). */
/** JPEG frames of the source at the given seconds (missing ones are skipped). */
async function grabFrames(source: string, times: readonly number[]): Promise<{ at: number[]; images: LlmImage[] }> {
  const { ffmpeg } = resolveFfmpegBinaries();
  const dir = await mkdtemp(join(tmpdir(), "humor-frames-"));
  const at: number[] = [];
  const images: LlmImage[] = [];
  try {
    for (const [i, t] of times.entries()) {
      const out = join(dir, `f${i}.jpg`);
      await runBinary(ffmpeg, buildFrameExtractArgs(source, out, t), 60_000).catch(() => undefined);
      if (!existsSync(out)) continue;
      images.push({ mimeType: "image/jpeg", data: await readFile(out) });
      at.push(t);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return { at, images };
}

export async function planHumor(input: HumorInput, keep: readonly Interval[], options: PlanHumorOptions = {}): Promise<HumorJob | null> {
  try {
    const frames = input.sourcePath ? await grabFrames(input.sourcePath, frameTimes(input.start, input.end, input.lively, keep)) : { at: [], images: [] };
    const draft = await generateJsonWithImages(buildHumorPrompt(input, frames.at), frames.images, HumorDraftSchema, { provider: options.provider, model: options.model, thinking: "low", temperature: 0.7 });
    const plan = validateHumor(draft, input.start, input.end, keep);
    const emojis: HumorJob["emojis"] = [];
    for (const e of plan.emojis) {
      const image = await ensureModelFile(emojiModel(e.emoji), options.fetchFn ?? fetch, options.log).catch(() => null);
      if (image) emojis.push({ start: e.start, end: e.end, image });
    }
    return { jokes: plan.jokes, emojis, effects: plan.effects };
  } catch (error) {
    options.log?.(`WARN humor plan skipped: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
