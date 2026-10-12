// Gemini text-to-speech (Interactions API, gemini-3.8-*-tts). Docs:
// https://ai.google.dev/gemini-api/docs/speech-generation (request shape, speech_metadata.style,
// audio/l16 24 kHz mono output). Usage goes through llmClient's accounting so TTS tokens show up in
// RunContext.llmUsage; 429s get the same jittered backoff as text calls.
import { GoogleGenAI } from "@google/genai";
import { env } from "./config.js";
import { recordLlmUsage, withRateLimitRetry } from "./llmClient.js";

export const GEMINI_TTS_SAMPLE_RATE = 24_000;
const REQUEST_TIMEOUT_MS = 180_000;

export interface GeminiSpeechRequest {
  /** Verbatim transcript (Gemini 3.8 TTS reads it literally; <...> would be taken as vocal tags). */
  text: string;
  model: string;
  /** Prebuilt voice ("Fenrir"), library voice ("pt-br-podcaster-12") or a designed "voice_..." id. */
  voice: string;
  /** Turn-level delivery instruction (speech_metadata.style), e.g. pace and tone. */
  style: string;
}

/** 16-bit signed little-endian mono PCM. */
export interface SpeechAudio {
  pcm: Buffer;
  sampleRate: number;
}

export class TtsOutputError extends Error {}

/** Minimal slice of the SDK used here, so tests can pass a fake. */
export interface InteractionsClient {
  interactions: {
    create(params: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  };
}

interface AudioBlock {
  data?: string;
  mime_type?: string;
  sample_rate?: number;
}

interface InteractionLike {
  status?: string;
  model?: string;
  output_audio?: AudioBlock;
  usage?: { total_input_tokens?: number; total_output_tokens?: number };
}

let defaultClient: InteractionsClient | undefined;

function getClient(): InteractionsClient {
  if (!defaultClient) {
    const apiKey = env("GEMINI_API_KEY");
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set (.env); voice.engine \"gemini\" needs it");
    defaultClient = new GoogleGenAI({ apiKey }) as unknown as InteractionsClient;
  }
  return defaultClient;
}

/** Strips "<" and ">" so script text can never be read as an inline vocal tag. */
export function sanitizeTranscript(text: string): string {
  return text.replace(/[<>]/g, " ").replace(/\s+/g, " ").trim();
}

export function buildSpeechParams(request: GeminiSpeechRequest): Record<string, unknown> {
  const style = request.style.trim();
  return {
    model: request.model,
    input: [
      {
        type: "user_input",
        content: [
          {
            type: "text",
            text: sanitizeTranscript(request.text),
            ...(style ? { annotations: [{ type: "speech_metadata", style }] } : {}),
          },
        ],
      },
    ],
    response_format: { type: "audio", mime_type: "audio/l16", sample_rate: GEMINI_TTS_SAMPLE_RATE },
    generation_config: { speech_config: [{ voice: request.voice }] },
  };
}

export interface SpeechCallOptions {
  client?: InteractionsClient;
  /** Extra attempts after 429/RESOURCE_EXHAUSTED, with jittered backoff. Default 4. */
  rateLimitRetries?: number;
  /** Backoff before retry n (tests pass a zero delay). */
  delay?: (retry: number) => number;
}

export async function synthesizeGeminiSpeech(request: GeminiSpeechRequest, options: SpeechCallOptions = {}): Promise<SpeechAudio> {
  if (!sanitizeTranscript(request.text)) throw new TtsOutputError("nothing to synthesize: empty text");
  const client = options.client ?? getClient();
  const params = buildSpeechParams(request);
  const interaction = (await withRateLimitRetry(
    () => client.interactions.create(params, { timeout: REQUEST_TIMEOUT_MS, maxRetries: 2 }),
    options.rateLimitRetries ?? 4,
    options.delay,
  )) as InteractionLike;
  recordLlmUsage({
    provider: "gemini",
    model: interaction.model ?? request.model,
    inputTokens: interaction.usage?.total_input_tokens ?? 0,
    outputTokens: interaction.usage?.total_output_tokens ?? 0,
  });
  return decodeAudio(interaction);
}

/** Audio of a finished interaction as PCM; throws TtsOutputError for blocked/failed/empty results. */
export function decodeAudio(interaction: InteractionLike): SpeechAudio {
  const status = interaction.status ?? "unknown";
  const block = interaction.output_audio;
  if (status !== "completed" || !block?.data) {
    throw new TtsOutputError(`Gemini TTS returned no audio (status: ${status}; blocked by safety filters or failed)`);
  }
  const bytes = Buffer.from(block.data, "base64");
  const mime = (block.mime_type ?? "").toLowerCase();
  const audio = mime.startsWith("audio/wav") || isRiff(bytes) ? pcmFromWav(bytes) : { pcm: bytes, sampleRate: rateOf(block) };
  if (audio.pcm.length < 2) throw new TtsOutputError("Gemini TTS returned empty audio");
  return audio;
}

function rateOf(block: AudioBlock): number {
  const fromMime = /rate=(\d+)/.exec(block.mime_type ?? "")?.[1];
  return block.sample_rate ?? (fromMime ? Number(fromMime) : GEMINI_TTS_SAMPLE_RATE);
}

function isRiff(bytes: Buffer): boolean {
  return bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WAVE";
}

/** PCM payload of a 16-bit mono RIFF/WAVE buffer. */
export function pcmFromWav(bytes: Buffer): SpeechAudio {
  let offset = 12;
  let sampleRate = GEMINI_TTS_SAMPLE_RATE;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("latin1", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      const channels = bytes.readUInt16LE(offset + 10);
      const bits = bytes.readUInt16LE(offset + 22);
      if (channels !== 1 || bits !== 16) throw new TtsOutputError(`unexpected WAV format: ${channels} ch, ${bits}-bit`);
      sampleRate = bytes.readUInt32LE(offset + 12);
    } else if (id === "data") {
      const end = Math.min(bytes.length, offset + 8 + size);
      return { pcm: bytes.subarray(offset + 8, end - ((end - offset - 8) % 2)), sampleRate };
    }
    offset += 8 + size + (size % 2);
  }
  throw new TtsOutputError("WAV audio without a data chunk");
}

/** 16-bit mono PCM wrapped in a 44-byte RIFF/WAVE header. */
export function pcmToWav(audio: SpeechAudio): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + audio.pcm.length, 4);
  header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(audio.sampleRate, 24);
  header.writeUInt32LE(audio.sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(audio.pcm.length, 40);
  return Buffer.concat([header, audio.pcm]);
}
