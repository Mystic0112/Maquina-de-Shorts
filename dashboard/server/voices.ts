// edge-tts voice list + short voice samples, via the project's Python venv.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { VoiceInfo, VoiceSampleResponse } from "../shared/api.js";
import { projectRoot } from "./config.js";

const PYTHON = join(projectRoot, ".venv", "Scripts", "python.exe");
const LIST_SCRIPT = join(projectRoot, "python", "tts", "list_voices.py");
const SYNTH_SCRIPT = join(projectRoot, "python", "tts", "synthesize.py");
export const SAMPLES_DIR = join(projectRoot, "data", "voice_samples");

const RATE = /^[+-]\d{1,3}%$/;
const PITCH = /^[+-]\d{1,3}Hz$/;
const VOICE_NAME = /^[a-z]{2,3}-[A-Za-z]{2,4}(-[A-Za-z]+)?-[A-Za-z]+Neural$/;
const MAX_TEXT = 300;
export const SAMPLE_HASH = /^[0-9a-f]{16}$/;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/* ---------- voice list (cached for the server's lifetime once it succeeds) ---------- */
let voices: VoiceInfo[] | null = null;
let loading: Promise<VoiceInfo[]> | null = null;

export function listVoices(): Promise<VoiceInfo[]> {
  if (voices) return Promise.resolve(voices);
  loading ??= (async () => {
    try {
      if (!existsSync(PYTHON)) throw new Error("Ambiente Python (.venv) não encontrado.");
      const result = await run(PYTHON, [LIST_SCRIPT], 30_000);
      if (result.code !== 0) throw new Error("Não foi possível listar as vozes (verifique a conexão com a internet).");
      voices = JSON.parse(result.stdout) as VoiceInfo[];
      return voices;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/* ---------- samples ---------- */
let synthFlags: Promise<{ pitch: boolean; volume: boolean }> | null = null;

/** The synthesizer is being extended concurrently: only pass --pitch/--volume once its --help lists them. */
function supportedFlags(): Promise<{ pitch: boolean; volume: boolean }> {
  synthFlags ??= run(PYTHON, [SYNTH_SCRIPT, "--help"], 15_000).then((r) => {
    const flags = { pitch: r.stdout.includes("--pitch"), volume: r.stdout.includes("--volume") };
    if (!flags.pitch || !flags.volume) setTimeout(() => (synthFlags = null), 60_000); // re-check later
    return flags;
  });
  return synthFlags;
}

let queue: Promise<unknown> = Promise.resolve();
/** One synthesis at a time: edge-tts is a network service, no need to hammer it. */
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

export interface SampleRequest {
  voice?: unknown;
  rate?: unknown;
  pitch?: unknown;
  volume?: unknown;
  text?: unknown;
}

export async function voiceSample(req: SampleRequest): Promise<{ status: number; body: VoiceSampleResponse }> {
  const voice = typeof req.voice === "string" ? req.voice : "";
  const rate = typeof req.rate === "string" ? req.rate : "+0%";
  const pitch = typeof req.pitch === "string" ? req.pitch : "+0Hz";
  const volume = typeof req.volume === "string" ? req.volume : "+0%";
  const text = (typeof req.text === "string" ? req.text : "").trim();
  if (!VOICE_NAME.test(voice)) return { status: 400, body: { ok: false, message: "Escolha uma voz válida." } };
  if (!RATE.test(rate) || !RATE.test(volume) || !PITCH.test(pitch)) {
    return { status: 400, body: { ok: false, message: "Velocidade, tom ou volume em formato inválido." } };
  }
  if (!text || text.length > MAX_TEXT) {
    return { status: 400, body: { ok: false, message: `Escreva uma frase de 1 a ${MAX_TEXT} caracteres.` } };
  }
  if (!existsSync(PYTHON)) return { status: 503, body: { ok: false, message: "Ambiente Python (.venv) não encontrado." } };

  const flags = await supportedFlags();
  const ignored: string[] = [];
  const args = ["--voice", voice, `--rate=${rate}`];
  if (flags.pitch) args.push(`--pitch=${pitch}`);
  else if (pitch !== "+0Hz") ignored.push("tom");
  if (flags.volume) args.push(`--volume=${volume}`);
  else if (volume !== "+0%") ignored.push("volume");

  // Cache key = what was actually synthesized (ignored params don't fragment the cache).
  const hash = createHash("sha1").update(JSON.stringify([voice, ...args, text])).digest("hex").slice(0, 16);
  const dir = join(SAMPLES_DIR, hash);
  const url = `/api/voices/sample/${hash}.mp3`;
  const note = ignored.length ? ` (${ignored.join(" e ")} ainda não suportado(s) pelo sintetizador; amostra gerada sem isso)` : "";
  if (existsSync(join(dir, "narration.mp3"))) {
    return { status: 200, body: { ok: true, cached: true, url, ignored, message: `Amostra pronta${note}.` } };
  }
  return serialized(async () => {
    await mkdir(dir, { recursive: true });
    const textFile = join(dir, "text.txt");
    await writeFile(textFile, text, "utf8");
    const result = await run(PYTHON, [SYNTH_SCRIPT, "--text-file", textFile, "--out-dir", dir, ...args], 60_000);
    if (result.code !== 0 || !existsSync(join(dir, "narration.mp3"))) {
      await rm(dir, { recursive: true, force: true });
      return { status: 502, body: { ok: false, message: "Falha ao gerar a amostra (edge-tts). Tente de novo em instantes." } };
    }
    return { status: 200, body: { ok: true, cached: false, url, ignored, message: `Amostra gerada${note}.` } };
  });
}
