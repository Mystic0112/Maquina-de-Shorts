import { describe, expect, it, vi } from "vitest";
import { PipelineConfigSchema } from "../../src/orchestrator/lib/config.js";
import {
  buildElevenLabsRequest,
  describeElevenLabsFailure,
  ELEVENLABS_ENDPOINT,
  synthesizeElevenLabsSpeech,
} from "../../src/orchestrator/lib/elevenLabsTts.js";
import { redactSecrets } from "../../src/orchestrator/lib/redact.js";
import { isStorableKey, STORABLE_KEYS } from "../../src/orchestrator/lib/secretStore.js";
import { estimateSpeechSeconds, measureLettersPerSecond, setSpeechEngine } from "../../src/orchestrator/stages/02-generateScript.js";
import { resolveVoiceExtras, VOICE_EXTRAS_DEFAULTS } from "../../src/shared/settings.js";
import { lettersPerSecondFor } from "../../src/shared/voiceEngines.js";

// Fake on purpose; the project's secret scan must not flag it.
const KEY = "FAKE-elevenlabs-key-0123456789";
const VOICE = "21m00Tcm4TlvDq8ikWAM";
const request = { text: "Olá,\n  mundo.", voiceId: VOICE, model: "eleven_multilingual_v2", stability: 0.4 };

const baseConfig = {
  video: { width: 1080, height: 1920, fps: 30, minSeconds: 45, maxSeconds: 90 },
  upload: { privacyStatus: "private", categoryId: "27", maxUploadsPerDay: 1 },
};
const parseVoice = (voice: Record<string, unknown>) =>
  PipelineConfigSchema.safeParse({ ...baseConfig, voice: { name: "pt-BR-AntonioNeural", language: "pt-BR", ...voice } });

describe("voice settings schema", () => {
  it("accepts an old config (no engine, none of the new keys) and keeps Kokoro as the default", () => {
    const parsed = parseVoice({});
    expect(parsed.success).toBe(true);
    const voice = resolveVoiceExtras(parsed.data?.voice);
    expect(voice.engine).toBe("kokoro");
    expect(voice).toMatchObject({ chatterboxRefAudio: "", elevenlabsVoiceId: "", elevenlabsModel: "eleven_multilingual_v2" });
    expect(VOICE_EXTRAS_DEFAULTS.engine).toBe("kokoro");
  });

  it("chooses the engine by config", () => {
    expect(resolveVoiceExtras(parseVoice({ engine: "chatterbox" }).data?.voice).engine).toBe("chatterbox");
    expect(resolveVoiceExtras(parseVoice({ engine: "elevenlabs" }).data?.voice).engine).toBe("elevenlabs");
  });

  it("validates the new fields", () => {
    expect(parseVoice({ engine: "chatterbox", chatterboxRefAudio: "data/voice_ref/reference.wav", chatterboxExaggeration: 0.7, chatterboxCfgWeight: 0.3 }).success).toBe(true);
    expect(parseVoice({ engine: "elevenlabs", elevenlabsVoiceId: VOICE, elevenlabsModel: "eleven_flash_v2_5", elevenlabsStability: 0.4 }).success).toBe(true);
    expect(parseVoice({ elevenlabsVoiceId: "../../v1/user" }).success).toBe(false); // it goes into the URL path
    expect(parseVoice({ elevenlabsStability: 1.5 }).success).toBe(false);
    expect(parseVoice({ chatterboxExaggeration: 5 }).success).toBe(false);
    expect(parseVoice({ engine: "outro" }).success).toBe(false);
  });
});

describe("ElevenLabs request", () => {
  it("builds the call with the key only in the xi-api-key header", () => {
    const { url, init } = buildElevenLabsRequest(request, KEY);
    expect(url).toBe(`${ELEVENLABS_ENDPOINT}/${VOICE}?output_format=pcm_24000`);
    expect(init.method).toBe("POST");
    expect(init.headers["xi-api-key"]).toBe(KEY);
    expect(JSON.parse(init.body)).toEqual({ text: "Olá, mundo.", model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.4 } });
    expect(url).not.toContain(KEY);
    expect(init.body).not.toContain(KEY);
    expect(Object.entries(init.headers).filter(([, v]) => v.includes(KEY)).map(([k]) => k)).toEqual(["xi-api-key"]);
  });

  it("refuses an empty text, a bad voice id and a runaway text before spending credits", () => {
    expect(() => buildElevenLabsRequest({ ...request, text: "  " }, KEY)).toThrow(/empty text/);
    expect(() => buildElevenLabsRequest({ ...request, voiceId: "" }, KEY)).toThrow(/elevenlabsVoiceId/);
    expect(() => buildElevenLabsRequest({ ...request, voiceId: "a/../b" }, KEY)).toThrow(/elevenlabsVoiceId/);
    expect(() => buildElevenLabsRequest({ ...request, text: "a".repeat(5001) }, KEY)).toThrow(/5000/);
  });

  it("returns the PCM and never echoes the key in a failure", async () => {
    const pcm = Buffer.alloc(4800);
    const ok = vi.fn().mockResolvedValue(new Response(pcm, { status: 200 }));
    const audio = await synthesizeElevenLabsSpeech(request, { apiKey: KEY, fetchImpl: ok });
    expect(audio).toEqual({ pcm, sampleRate: 24_000 });
    expect(ok).toHaveBeenCalledTimes(1);
    expect((ok.mock.calls[0]![1] as { headers: Record<string, string> }).headers["xi-api-key"]).toBe(KEY);

    // A server (or proxy) that reflects the key back must not get it into the error text.
    const bad = vi.fn().mockResolvedValue(new Response(`{"detail":{"message":"invalid key ${KEY}"}}`, { status: 401 }));
    process.env["ELEVENLABS_API_KEY"] = KEY;
    try {
      const error = await synthesizeElevenLabsSpeech(request, { apiKey: KEY, fetchImpl: bad }).catch((e: Error) => e);
      expect((error as Error).message).toMatch(/chave/);
      expect((error as Error).message).not.toContain(KEY);
    } finally {
      delete process.env["ELEVENLABS_API_KEY"];
    }
  });

  it("needs the person's own key: without one it fails without calling the network", async () => {
    const fetchImpl = vi.fn();
    delete process.env["ELEVENLABS_API_KEY"];
    await expect(synthesizeElevenLabsSpeech(request, { fetchImpl })).rejects.toThrow(/ELEVENLABS_API_KEY/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("explains quota and credential failures in pt-BR", () => {
    expect(describeElevenLabsFailure(401, "")).toMatch(/recusou a chave/);
    expect(describeElevenLabsFailure(429, "")).toMatch(/créditos/);
    expect(describeElevenLabsFailure(400, '{"detail":{"status":"quota_exceeded"}}')).toMatch(/créditos/);
    expect(describeElevenLabsFailure(422, "")).toMatch(/id da voz/);
    expect(describeElevenLabsFailure(500, "boom")).toBe("ElevenLabs respondeu HTTP 500 (boom)");
  });

  it("is storable from the panel and redacted from logs", () => {
    expect(isStorableKey("ELEVENLABS_API_KEY")).toBe(true);
    expect(STORABLE_KEYS.find((k) => k.name === "ELEVENLABS_API_KEY")?.label).toMatch(/não comercial/);
    expect(redactSecrets(`falhou com ${KEY}`, { ELEVENLABS_API_KEY: KEY })).not.toContain(KEY);
  });
});

describe("speech rate per engine (stage 02)", () => {
  const hook = "Existe um planeta onde um único dia dura mais do que o ano inteiro.";

  it("estimates with the configured engine's letters per second", () => {
    try {
      setSpeechEngine("kokoro");
      const kokoro = estimateSpeechSeconds(hook);
      setSpeechEngine("chatterbox");
      const chatterbox = estimateSpeechSeconds(hook);
      expect(chatterbox).toBeGreaterThan(kokoro); // starting guess: slower than Kokoro
      expect(estimateSpeechSeconds(hook, lettersPerSecondFor("kokoro"))).toBeCloseTo(kokoro, 10);
    } finally {
      setSpeechEngine("kokoro");
    }
  });

  it("remeasures a rate from a narration: the inverse of the estimate", () => {
    const text = "Existe um planeta onde um único dia dura mais do que o ano inteiro. Mundo estranho, não é?";
    const seconds = estimateSpeechSeconds(text, 12.5);
    expect(measureLettersPerSecond(text, seconds)).toBeCloseTo(12.5, 6);
    expect(() => measureLettersPerSecond("...", 5)).toThrow(/Cannot measure/);
  });
});
