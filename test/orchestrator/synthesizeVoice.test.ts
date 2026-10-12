import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveVoiceExtras, VOICE_EXTRAS_DEFAULTS } from "../../src/shared/settings.js";

const voiceConfig = vi.hoisted(() => ({
  current: { engine: "edge-tts", name: "pt-BR-AntonioNeural", language: "pt-BR" } as Record<string, unknown>,
}));
const runPythonJson = vi.hoisted(() => vi.fn());

vi.mock("../../src/orchestrator/lib/config.js", () => ({
  loadConfig: () => ({ voice: voiceConfig.current, video: { minSeconds: 1, maxSeconds: 90 } }),
  paths: { fromRoot: (p: string) => p },
  env: () => undefined,
}));
vi.mock("../../src/orchestrator/lib/python.js", () => ({
  runPythonJson,
  scriptSupportsFlag: async () => true,
}));
vi.mock("../../src/orchestrator/lib/logger.js", () => ({
  getLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

const { buildAlignArgs, buildTtsArgs, createGeminiEngine, GEMINI_SOURCE_AUDIO, run, selectTtsEngine } = await import(
  "../../src/orchestrator/stages/04-synthesizeVoice.js"
);

describe("buildTtsArgs (edge-tts)", () => {
  it("passes the default max pause (250 ms) next to the prosody flags", () => {
    const args = buildTtsArgs("C:/run/narration.txt", "pt-BR-AntonioNeural", "C:/run", resolveVoiceExtras(undefined));
    expect(VOICE_EXTRAS_DEFAULTS.maxPauseMs).toBe(250);
    expect(args).toEqual([
      "--text-file", "C:/run/narration.txt",
      "--voice", "pt-BR-AntonioNeural",
      "--out-dir", "C:/run",
      "--rate=+10%",
      "--pitch=+0Hz",
      "--volume=+0%",
      "--max-pause-ms=250",
    ]);
  });

  it("passes 0 through so trimming can be disabled", () => {
    const args = buildTtsArgs("t.txt", "v", "o", resolveVoiceExtras({ maxPauseMs: 0, rate: "-5%" }));
    expect(args).toContain("--max-pause-ms=0");
    expect(args).toContain("--rate=-5%");
  });
});

describe("buildAlignArgs (Gemini)", () => {
  it("hands the source audio, text and max pause to align_narration.py", () => {
    expect(buildAlignArgs("C:/run/narration.source.wav", "C:/run/narration.txt", "C:/run", 0)).toEqual([
      "--audio-in", "C:/run/narration.source.wav",
      "--text-file", "C:/run/narration.txt",
      "--out-dir", "C:/run",
      "--max-pause-ms=0",
    ]);
  });
});

describe("voice defaults", () => {
  it("default to Gemini TTS with a pt-BR style", () => {
    const voice = resolveVoiceExtras(undefined);
    expect(voice.engine).toBe("gemini");
    expect(voice.geminiModel).toBe("gemini-3.8-flash-tts");
    expect(voice.geminiVoice).toBeTruthy();
    expect(voice.style).toMatch(/português do Brasil/);
    expect(selectTtsEngine("gemini").name).toBe("gemini");
    expect(selectTtsEngine("edge-tts").name).toBe("edge-tts");
  });
});

describe("04-synthesizeVoice run", () => {
  let runDir: string;
  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), "tts-stage-"));
    runPythonJson.mockReset();
    runPythonJson.mockResolvedValue({
      audioPath: join(runDir, "narration.wav"),
      durationMs: 50_000,
      words: [{ word: "Olá", startMs: 50, endMs: 400 }],
      alignment: { matchedRatio: 0.95, model: "base" },
    });
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  const ctx = () => ({
    runId: "test",
    runDir,
    createdAt: "2026-10-12T00:00:00Z",
    script: { title: "t", hook: "Olá.", scenes: [{ narration: "Mundo.", footageQuery: "x" }], cta: "", language: "pt-BR" },
  });
  const edge = { engine: "edge-tts", name: "pt-BR-AntonioNeural", language: "pt-BR" };

  it.each([
    [{}, "--max-pause-ms=250", "--rate=+10%"],
    [{ maxPauseMs: 120, rate: "+15%" }, "--max-pause-ms=120", "--rate=+15%"],
    [{ maxPauseMs: 0 }, "--max-pause-ms=0", "--rate=+10%"],
  ])("edge-tts: forwards config.voice %j to synthesize.py", async (extras, pauseFlag, rateFlag) => {
    voiceConfig.current = { ...edge, ...extras };
    await run(ctx());
    const { script, args } = runPythonJson.mock.calls[0]![0] as { script: string; args: string[] };
    expect(script).toBe("python/tts/synthesize.py");
    expect(args).toContain(pauseFlag);
    expect(args).toContain(rateFlag);
    expect(args).toContain("--deadline-seconds=280");
  });

  it("gemini: sends text/model/voice/style, saves the source WAV and aligns it", async () => {
    voiceConfig.current = { name: "pt-BR-AntonioNeural", language: "pt-BR", geminiVoice: "Puck", maxPauseMs: 180 };
    const speak = vi.fn().mockResolvedValue({ pcm: Buffer.alloc(48_000), sampleRate: 24_000 });
    const next = await run(ctx(), () => createGeminiEngine(speak));
    expect(speak).toHaveBeenCalledWith({
      text: "Olá. Mundo.",
      model: "gemini-3.8-flash-tts",
      voice: "Puck",
      style: VOICE_EXTRAS_DEFAULTS.style,
    });
    const source = await readFile(join(runDir, GEMINI_SOURCE_AUDIO));
    expect(source.toString("latin1", 0, 4)).toBe("RIFF");
    expect(source.length).toBe(44 + 48_000);
    const { script, args } = runPythonJson.mock.calls[0]![0] as { script: string; args: string[] };
    expect(script).toBe("python/tts/align_narration.py");
    expect(args).toEqual(buildAlignArgs(join(runDir, GEMINI_SOURCE_AUDIO), join(runDir, "narration.txt"), runDir, 180));
    expect(next.narration).toEqual({
      audioPath: join(runDir, "narration.wav"),
      durationMs: 50_000,
      words: [{ word: "Olá", startMs: 50, endMs: 400 }],
    });
  });

  it("gemini: a TTS failure fails the stage before any alignment", async () => {
    voiceConfig.current = { name: "x", language: "pt-BR", engine: "gemini" };
    const speak = vi.fn().mockRejectedValue(new Error("Gemini TTS returned no audio (status: failed)"));
    await expect(run(ctx(), () => createGeminiEngine(speak))).rejects.toThrow(/no audio/);
    expect(runPythonJson).not.toHaveBeenCalled();
  });

  it("rejects narrations outside the configured length", async () => {
    voiceConfig.current = { ...edge };
    runPythonJson.mockResolvedValue({ audioPath: join(runDir, "n.mp3"), durationMs: 120_000, words: [{ word: "a", startMs: 0, endMs: 1 }] });
    await expect(run(ctx())).rejects.toThrow(/outside the 1-90 s target/);
  });
});
