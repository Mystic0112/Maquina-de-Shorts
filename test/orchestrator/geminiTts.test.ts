import { describe, expect, it, vi } from "vitest";
import {
  buildSpeechParams,
  decodeAudio,
  pcmFromWav,
  pcmToWav,
  sanitizeTranscript,
  synthesizeGeminiSpeech,
  TtsOutputError,
  type InteractionsClient,
} from "../../src/orchestrator/lib/geminiTts.js";
import { drainLlmUsage } from "../../src/orchestrator/lib/llmClient.js";

const request = { text: "Olá <laugh> mundo", model: "gemini-3.8-flash-tts", voice: "Fenrir", style: "ritmo ágil" };
const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);

function completed(data: Buffer = pcm, mime = "audio/l16; rate=24000; channels=1") {
  return {
    status: "completed",
    model: "gemini-3.8-flash-tts",
    output_audio: { data: data.toString("base64"), mime_type: mime, sample_rate: 24_000 },
    usage: { total_input_tokens: 245, total_output_tokens: 1470 },
  };
}

function fakeClient(...results: Array<unknown | Error>): InteractionsClient & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    calls,
    interactions: {
      create: async (params) => {
        calls.push(params);
        const next = results.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
}

const rateLimited = () => Object.assign(new Error("429 RESOURCE_EXHAUSTED: quota exceeded"), { status: 429 });

describe("buildSpeechParams", () => {
  it("builds a single-speaker Interactions request with style metadata and raw 24 kHz PCM", () => {
    expect(buildSpeechParams(request)).toEqual({
      model: "gemini-3.8-flash-tts",
      input: [
        {
          type: "user_input",
          content: [{ type: "text", text: "Olá laugh mundo", annotations: [{ type: "speech_metadata", style: "ritmo ágil" }] }],
        },
      ],
      response_format: { type: "audio", mime_type: "audio/l16", sample_rate: 24_000 },
      generation_config: { speech_config: [{ voice: "Fenrir" }] },
    });
  });

  it("omits the annotation when there is no style", () => {
    const params = buildSpeechParams({ ...request, style: "  " }) as { input: Array<{ content: Array<Record<string, unknown>> }> };
    expect(params.input[0]!.content[0]).not.toHaveProperty("annotations");
  });

  it("never lets script text become an inline vocal tag", () => {
    expect(sanitizeTranscript("Espere... <short pause> viu?")).toBe("Espere... short pause viu?");
  });
});

describe("synthesizeGeminiSpeech", () => {
  it("returns the PCM and records token usage for llmUsage", async () => {
    drainLlmUsage();
    const client = fakeClient(completed());
    const audio = await synthesizeGeminiSpeech(request, { client });
    expect(audio).toEqual({ pcm, sampleRate: 24_000 });
    expect(drainLlmUsage()).toEqual([{ provider: "gemini", model: "gemini-3.8-flash-tts", inputTokens: 245, outputTokens: 1470 }]);
  });

  it("backs off and retries on 429 / quota errors", async () => {
    const client = fakeClient(rateLimited(), rateLimited(), completed());
    const delay = vi.fn(() => 0);
    await expect(synthesizeGeminiSpeech(request, { client, delay })).resolves.toEqual({ pcm, sampleRate: 24_000 });
    expect(client.calls).toHaveLength(3);
    expect(delay).toHaveBeenCalledTimes(2);
  });

  it("gives up after the rate-limit retries", async () => {
    const client = fakeClient(rateLimited(), rateLimited());
    await expect(synthesizeGeminiSpeech(request, { client, rateLimitRetries: 1, delay: () => 0 })).rejects.toThrow(/429/);
  });

  it("does not retry other errors", async () => {
    const client = fakeClient(Object.assign(new Error("400 INVALID_ARGUMENT: unknown voice"), { status: 400 }), completed());
    await expect(synthesizeGeminiSpeech(request, { client, delay: () => 0 })).rejects.toThrow(/unknown voice/);
    expect(client.calls).toHaveLength(1);
  });

  it("rejects empty text without calling the API", async () => {
    const client = fakeClient(completed());
    await expect(synthesizeGeminiSpeech({ ...request, text: " <> " }, { client })).rejects.toBeInstanceOf(TtsOutputError);
    expect(client.calls).toHaveLength(0);
  });
});

describe("decodeAudio", () => {
  it.each([
    ["safety block / failed", { status: "failed" }],
    ["incomplete", { ...completed(), status: "incomplete" }],
    ["no audio block", { status: "completed" }],
    ["empty audio", completed(Buffer.alloc(0))],
  ])("throws TtsOutputError on %s", (_label, interaction) => {
    expect(() => decodeAudio(interaction)).toThrow(TtsOutputError);
  });

  it("strips a RIFF header when the API returns WAV (the unary default)", () => {
    const wav = pcmToWav({ pcm, sampleRate: 16_000 });
    expect(decodeAudio(completed(wav, "audio/wav"))).toEqual({ pcm, sampleRate: 16_000 });
  });

  it("reads the rate from the mime type when sample_rate is absent", () => {
    const interaction = { status: "completed", output_audio: { data: pcm.toString("base64"), mime_type: "audio/l16; rate=22050" } };
    expect(decodeAudio(interaction).sampleRate).toBe(22_050);
  });
});

describe("WAV helpers", () => {
  it("round-trip PCM through a 44-byte header", () => {
    const wav = pcmToWav({ pcm, sampleRate: 24_000 });
    expect(wav.length).toBe(44 + pcm.length);
    expect(pcmFromWav(wav)).toEqual({ pcm, sampleRate: 24_000 });
  });

  it("refuses stereo or non-16-bit WAV", () => {
    const wav = pcmToWav({ pcm, sampleRate: 24_000 });
    wav.writeUInt16LE(2, 22);
    expect(() => pcmFromWav(wav)).toThrow(/2 ch/);
  });
});
