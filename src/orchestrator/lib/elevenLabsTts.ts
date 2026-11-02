// ElevenLabs text-to-speech over plain HTTP (no SDK). Docs: https://elevenlabs.io/docs/api-reference/text-to-speech/convert
// The API key is the person's own (ELEVENLABS_API_KEY, from .env or Configurações > Chaves). It travels only in the
// "xi-api-key" header: never in the URL, the body, a log line or an error message.
//
// Licence and usage rules the owner must respect (also shown in the panel and in the README): the Free plan
// (10,000 credits/month, about 11 Shorts) is NON-COMMERCIAL use only (Terms of Service, section 1(c)); the Starter plan
// (US$ 6/month) has a commercial licence. Never ship a key of ours and never spread usage over several free accounts
// (Prohibited Use Policy, sections 8 and 12).
import { env } from "./config.js";
import { pcmFromWav, TtsOutputError, type SpeechAudio } from "./geminiTts.js";
import { redactSecrets } from "./redact.js";

export const ELEVENLABS_ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech";
/** Raw 16-bit little-endian mono PCM; available on every plan (44.1 kHz needs a higher one). */
export const ELEVENLABS_OUTPUT_FORMAT = "pcm_24000";
export const ELEVENLABS_SAMPLE_RATE = 24_000;
/** A Short narration is ~1,200 characters; this is only a guard against a runaway text burning credits. */
export const ELEVENLABS_MAX_CHARS = 5000;
const REQUEST_TIMEOUT_MS = 180_000;
const VOICE_ID = /^[A-Za-z0-9]{10,40}$/;
const MODEL_ID = /^[a-z0-9_]{3,60}$/;

export interface ElevenLabsSpeechRequest {
  text: string;
  voiceId: string;
  model: string;
  /** 0 = more expressive, 1 = more monotone. */
  stability: number;
}

export interface ElevenLabsHttpRequest {
  url: string;
  init: { method: "POST"; headers: Record<string, string>; body: string };
}

/** Whitespace collapsed: the narration file keeps line breaks the API would read as pauses. */
export const sanitizeElevenLabsText = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The exact HTTP request for one narration. The key is added to the headers here and nowhere else. */
export function buildElevenLabsRequest(request: ElevenLabsSpeechRequest, apiKey: string): ElevenLabsHttpRequest {
  const text = sanitizeElevenLabsText(request.text);
  if (!text) throw new TtsOutputError("nothing to synthesize: empty text");
  if (text.length > ELEVENLABS_MAX_CHARS) throw new TtsOutputError(`narration has ${text.length} characters; the ElevenLabs engine accepts up to ${ELEVENLABS_MAX_CHARS}`);
  if (!VOICE_ID.test(request.voiceId)) {
    throw new TtsOutputError("voice.elevenlabsVoiceId is empty or invalid: pick a voice id in Configurações > Voz (ElevenLabs)");
  }
  if (!MODEL_ID.test(request.model)) throw new TtsOutputError("voice.elevenlabsModel is not a valid model id");
  // The voice id is validated above and encoded anyway: it is part of the URL path.
  const url = `${ELEVENLABS_ENDPOINT}/${encodeURIComponent(request.voiceId)}?output_format=${ELEVENLABS_OUTPUT_FORMAT}`;
  return {
    url,
    init: {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "application/octet-stream" },
      body: JSON.stringify({ text, model_id: request.model, voice_settings: { stability: request.stability } }),
    },
  };
}

/** Message for a failed response; built from the status and the (redacted) body, never from the request. */
export function describeElevenLabsFailure(status: number, body: string): string {
  const detail = redactSecrets(body).slice(0, 300).trim();
  const tail = detail ? ` (${detail})` : "";
  if (status === 401) return `ElevenLabs recusou a chave (ELEVENLABS_API_KEY inválida ou revogada)${tail}`;
  if (status === 402 || status === 429 || /quota/i.test(body)) {
    return `ElevenLabs: créditos do plano esgotados ou limite de requisições atingido; espere a renovação ou troque de plano${tail}`;
  }
  if (status === 404 || status === 422) return `ElevenLabs recusou o pedido: confira o id da voz e o modelo em Configurações > Voz${tail}`;
  return `ElevenLabs respondeu HTTP ${status}${tail}`;
}

export interface ElevenLabsCallOptions {
  apiKey?: string;
  /** Tests pass a fake; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function synthesizeElevenLabsSpeech(request: ElevenLabsSpeechRequest, options: ElevenLabsCallOptions = {}): Promise<SpeechAudio> {
  const apiKey = options.apiKey ?? env("ELEVENLABS_API_KEY");
  if (!apiKey) {
    throw new TtsOutputError('ELEVENLABS_API_KEY is not set (.env or Configurações > Chaves); voice.engine "elevenlabs" needs your own ElevenLabs key');
  }
  const { url, init } = buildElevenLabsRequest(request, apiKey);
  const response = await (options.fetchImpl ?? fetch)(url, { ...init, signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS) }).catch((error: unknown) => {
    // Network errors carry no headers, but redact anyway before they reach a log.
    throw new TtsOutputError(redactSecrets(`ElevenLabs request failed: ${error instanceof Error ? error.message : String(error)}`));
  });
  if (!response.ok) throw new TtsOutputError(describeElevenLabsFailure(response.status, await response.text().catch(() => "")));
  const bytes = Buffer.from(await response.arrayBuffer());
  // pcm_24000 is raw PCM; a RIFF header is tolerated in case the API ever wraps it as WAV.
  const audio = bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" ? pcmFromWav(bytes) : { pcm: bytes.subarray(0, bytes.length - (bytes.length % 2)), sampleRate: ELEVENLABS_SAMPLE_RATE };
  if (audio.pcm.length < 2) throw new TtsOutputError("ElevenLabs returned empty audio");
  return audio;
}
