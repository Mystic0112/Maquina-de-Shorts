// Configurações > Plataforma: state of every ENGINE of the machine (AI providers, keys, voice, images) and the
// "Testar conexão" button. Nothing here returns a key: only booleans, labels and short redacted texts.
// The test runs scripts/probe_provider.ts in a child process (fresh env and keys, killable), one fixed call through
// getProviderByName(name).completeJson, the same path the pipeline uses.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { z } from "zod";
import { MAX_PROBE_MESSAGE, safeProbeMessage, type ProbeOutcome } from "../../src/orchestrator/lib/providerProbe.js";
import { isLlmProviderName, isPaidLlmProvider, LLM_PROVIDER_NAMES, LLM_PROVIDERS, LlmSettingsSchema, VOICE_ENGINES, type LlmProviderName, type LlmSettings } from "../../src/shared/settings.js";
import { VOICE_ENGINE_INFO } from "../../src/shared/voiceEngines.js";
import type { KeyStatus, PlatformProvider, PlatformReadiness, PlatformService, PlatformStatus, PlatformTest, PlatformTestResponse } from "../shared/api.js";
import { envValue, paths, projectRoot } from "./config.js";
import { storableKeyStatus } from "./keys.js";
import { commandExists, llmProviderStatus } from "./llmProviders.js";

const TSX_CLI = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
const PROBE_SCRIPT = join(projectRoot, "scripts", "probe_provider.ts");
export const TESTS_FILE = join(projectRoot, "data", "platform-tests.json");
export const TEST_INTERVAL_MS = 8_000;
const API_TIMEOUT_MS = 30_000;
const CLI_TIMEOUT_MS = 60_000;

/* ---------- texts (pt-BR). Registry notes (LLM_PROVIDERS[...].note) are reused, not rewritten. ---------- */
export const NOTES = {
  agy: "Usa os créditos do seu plano Antigravity, sem chave de API. O plano tem cota por janela de horas; confira nos termos do plano se o uso automatizado é permitido.",
  paidApi: "API paga: cobra por chamada na sua chave. Nunca entra como alternativa sem a sua permissão (allowPaid) e o teste abaixo também gasta uma chamada.",
  gemini: "A mesma chave serve para a voz Gemini TTS, que também é paga.",
  openaiRemote: "Servidor na internet (OpenAI, OpenRouter...) cobra por chamada. Servidor local (Ollama, LM Studio, rede local) é grátis. Não tem busca na web.",
  elevenlabs:
    "Plano gratuito: 10 mil créditos por mês e SÓ USO NÃO COMERCIAL (Termos de Uso, §1(c)); um canal monetizado precisa do plano Starter (US$ 6/mês) ou superior, que traz licença comercial. Use a sua própria chave e não crie várias contas grátis para esticar a cota.",
  chatterbox:
    "Só use uma voz que seja sua ou de quem autorizou por escrito: clonar a voz de outra pessoa sem consentimento pode violar direitos dela e as regras do YouTube. O Chatterbox grava uma marca d'água inaudível em todo áudio; não tente removê-la.",
  tavily: "Busca na web da checagem de fatos para IAs que não buscam sozinhas. Cada checagem gasta de 10 a 40 buscas do plano; o plano grátis é limitado por mês.",
  pexels: "Imagens e vídeos de acervo (opcional). Cada arquivo só entra se a licença permitir, com o crédito na descrição.",
  pixabay: "Imagens e sons de acervo (opcional), com o filtro de licença de sempre.",
  youtube: "Só estatísticas públicas do painel (somente leitura); não publica nada.",
} as const;

/** Agent CLIs the machine does not use yet: shown as "detectado, ainda sem suporte". */
const FUTURE_CLIS = [
  { id: "codex", label: "Codex CLI (OpenAI)", command: "codex" },
  { id: "opencode", label: "opencode", command: "opencode" },
  { id: "cursor-agent", label: "Cursor CLI", command: "cursor-agent" },
] as const;

/** Keys that are not an AI provider's own, grouped by service. Every STORABLE_KEY must appear exactly once (tested). */
const SERVICES: readonly PlatformService[] = [
  { id: "elevenlabs", label: "ElevenLabs (voz)", keyNames: ["ELEVENLABS_API_KEY"], notes: [NOTES.elevenlabs] },
  { id: "tavily", label: "Tavily (busca na web)", keyNames: ["TAVILY_API_KEY"], notes: [NOTES.tavily] },
  { id: "pexels", label: "Pexels (imagens)", keyNames: ["PEXELS_API_KEY"], notes: [NOTES.pexels] },
  { id: "pixabay", label: "Pixabay (imagens e sons)", keyNames: ["PIXABAY_API_KEY"], notes: [NOTES.pixabay] },
  { id: "youtube", label: "YouTube Data API (estatísticas)", keyNames: ["YOUTUBE_API_KEY"], notes: [NOTES.youtube] },
];

/* ---------- last results (data/platform-tests.json, outside git) ---------- */
const StoredTestsSchema = z.record(z.string(), z.object({ ok: z.boolean(), at: z.string().max(40), message: z.string().max(MAX_PROBE_MESSAGE + 10), ms: z.number().optional() }));

export function readTests(file: string = TESTS_FILE): Record<string, PlatformTest> {
  try {
    const parsed = StoredTestsSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success) return {};
    return Object.fromEntries(Object.entries(parsed.data).filter(([name]) => isLlmProviderName(name)));
  } catch {
    return {};
  }
}

export function recordTest(name: LlmProviderName, test: PlatformTest, file: string = TESTS_FILE): void {
  const all = { ...readTests(file), [name]: test };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

/* ---------- status ---------- */
export interface PlatformInputs {
  keys: readonly KeyStatus[];
  llm: LlmSettings | undefined;
  exists: (command: string) => boolean;
  env: (name: string) => string | undefined;
  fileExists: (path: string) => boolean;
  tests: Record<string, PlatformTest>;
}

const keyConfigured = (keys: readonly KeyStatus[], name: string): boolean => keys.some((k) => k.name === name && k.configured);

function voiceReadiness(i: PlatformInputs): Record<string, PlatformReadiness> {
  const python = (name: string): { ready: boolean; detail: string } => {
    const value = i.env(name);
    if (!value) return { ready: false, detail: `falta configurar ${name} no .env (veja o README)` };
    return i.fileExists(value) ? { ready: true, detail: "pronto (ambiente Python encontrado)" } : { ready: false, detail: `${name} aponta para um arquivo que não existe` };
  };
  const hasKey = (name: string, extra?: string): { ready: boolean; detail: string } =>
    keyConfigured(i.keys, name) ? { ready: true, detail: extra ?? "pronto (chave configurada)" } : { ready: false, detail: `falta a chave ${name}` };
  const by: Record<(typeof VOICE_ENGINES)[number], { ready: boolean; detail: string; note?: string }> = {
    kokoro: python("KOKORO_PYTHON"),
    chatterbox: { ...python("CHATTERBOX_PYTHON"), note: NOTES.chatterbox },
    elevenlabs: { ...hasKey("ELEVENLABS_API_KEY", "chave configurada (falta só o ID da voz, se ainda não escolheu)"), note: NOTES.elevenlabs },
    gemini: { ...hasKey("GEMINI_API_KEY"), note: NOTES.paidApi },
    "edge-tts": { ready: false, detail: "motor legado: o endpoint da Microsoft recusa (403) desde out/2026" },
  };
  return Object.fromEntries(VOICE_ENGINES.map((id) => [id, { label: VOICE_ENGINE_INFO[id].label, ...by[id] }]));
}

function imageReadiness(i: PlatformInputs): Record<string, PlatformReadiness> {
  const agy = i.env("ANTIGRAVITY_CLI_PATH") ?? LLM_PROVIDERS["antigravity-cli"].command;
  const agyOk = i.exists(agy);
  const stockKeys = ["PEXELS_API_KEY", "PIXABAY_API_KEY"].map((k) => `${k.split("_")[0]!.toLowerCase()}: ${keyConfigured(i.keys, k) ? "chave configurada" : "sem chave"}`).join(", ");
  return {
    acervo: { label: "Acervo", ready: true, detail: `pronto (NASA, Commons; ${stockKeys}; as chaves são opcionais)` },
    ilustrado: { label: "Ilustrado 3D (agy)", ready: agyOk, detail: agyOk ? "agy instalado (usa os créditos do plano)" : `comando "${agy}" não encontrado neste computador`, note: NOTES.agy },
    terminal: { label: "Terminal", ready: true, detail: "pronto (sem imagens; usa a IA da tarefa \"Cartões do formato terminal\")" },
  };
}

export function buildPlatformStatus(i: PlatformInputs): PlatformStatus {
  const statuses = llmProviderStatus(i.keys, i.exists, i.llm);
  const providers: PlatformProvider[] = LLM_PROVIDER_NAMES.map((name) => {
    const meta = LLM_PROVIDERS[name];
    const s = statuses.find((x) => x.name === name)!;
    const paid = isPaidLlmProvider(name, i.llm);
    const isCli = !meta.keyEnv && name !== "openai-compatible";
    const notes = [
      ...(name === "antigravity-cli" ? [NOTES.agy] : []),
      ...(s.note ? [s.note] : []),
      ...(name === "openai-compatible" ? [NOTES.openaiRemote] : paid ? [NOTES.paidApi] : []),
      ...(name === "gemini" ? [NOTES.gemini] : []),
    ];
    return {
      name,
      label: meta.label,
      paid,
      kind: isCli ? "cli" : "api",
      ...(isCli ? { command: meta.command, installed: s.available } : { configured: s.available }),
      available: s.available,
      ...(s.reason ? { reason: s.reason } : {}),
      keyNames: meta.keyEnv ? [meta.keyEnv] : [],
      notes,
      ...(i.tests[name] ? { lastTest: i.tests[name] } : {}),
    };
  });
  return {
    providers,
    services: [...SERVICES],
    detectedClis: FUTURE_CLIS.map((c) => ({ ...c, detected: i.exists(c.command) })),
    keys: [...i.keys],
    voice: voiceReadiness(i),
    images: imageReadiness(i),
    testIntervalSeconds: TEST_INTERVAL_MS / 1000,
  };
}

async function savedLlm(): Promise<LlmSettings | undefined> {
  try {
    const raw = JSON.parse(await readFile(paths.pipelineConfig, "utf8")) as { llm?: unknown };
    const parsed = LlmSettingsSchema.safeParse(raw.llm ?? {});
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/* ---------- the probe (child process) ---------- */
const ChildLineSchema = z.object({ ok: z.boolean(), message: z.string(), ms: z.number().optional() });

export function runProbeChild(name: LlmProviderName, timeoutMs: number): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSX_CLI, PROBE_SCRIPT, name, String(timeoutMs)], { cwd: projectRoot, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout = (stdout + d).slice(-16_000)));
    const killer = setTimeout(() => child.kill(), timeoutMs + 5_000);
    const finish = (outcome: ProbeOutcome): void => {
      clearTimeout(killer);
      resolve(outcome);
    };
    child.on("error", () => finish({ ok: false, message: "Não foi possível iniciar o teste." }));
    child.on("close", () => {
      const last = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
      try {
        const parsed = ChildLineSchema.parse(JSON.parse(last));
        finish({ ok: parsed.ok, message: safeProbeMessage(parsed.message), ...(parsed.ms !== undefined ? { ms: parsed.ms } : {}) });
      } catch {
        finish({ ok: false, message: `Sem resposta legível (tempo limite de ${Math.round(timeoutMs / 1000)} s ou erro ao iniciar).` });
      }
    });
  });
}

/* ---------- routes ---------- */
export interface PlatformDeps {
  exists?: (command: string) => boolean;
  env?: (name: string) => string | undefined;
  fileExists?: (path: string) => boolean;
  llm?: () => Promise<LlmSettings | undefined>;
  keys?: () => KeyStatus[];
  /** Runs the one fixed call; the default spawns scripts/probe_provider.ts. */
  probe?: (name: LlmProviderName, timeoutMs: number) => Promise<ProbeOutcome>;
  now?: () => number;
  testsFile?: string;
  minIntervalMs?: number;
}

const noStore = (_req: Request, res: Response, next: NextFunction): void => {
  res.set("Cache-Control", "no-store");
  next();
};
const jsonOnly = (req: Request, res: Response, next: NextFunction): void => {
  if (req.is("application/json")) return next();
  res.status(415).json({ ok: false, ran: false, message: "Use Content-Type: application/json" } satisfies PlatformTestResponse);
};

/** Mounted at /api/platform. */
export function platformRouter(deps: PlatformDeps = {}): Router {
  const exists = deps.exists ?? commandExists;
  const envOf = deps.env ?? envValue;
  const fileExists = deps.fileExists ?? existsSync;
  const llm = deps.llm ?? savedLlm;
  const keys = deps.keys ?? storableKeyStatus;
  const probe = deps.probe ?? runProbeChild;
  const now = deps.now ?? Date.now;
  const file = deps.testsFile ?? TESTS_FILE;
  const minInterval = deps.minIntervalMs ?? TEST_INTERVAL_MS;
  const lastStart = new Map<string, number>();
  const running = new Set<string>();
  const status = async (): Promise<PlatformStatus> => buildPlatformStatus({ keys: keys(), llm: await llm(), exists, env: envOf, fileExists, tests: readTests(file) });

  const router = express.Router();
  router.use(noStore);

  router.get("/", async (_req, res) => {
    res.json(await status());
  });

  router.post("/test/:name", jsonOnly, express.json({ limit: "1kb" }), async (req, res) => {
    const name = String(req.params["name"] ?? "");
    const reply = (code: number, body: PlatformTestResponse): void => void res.status(code).json(body);
    if (!isLlmProviderName(name)) return reply(404, { ok: false, ran: false, message: "Provedor desconhecido." });
    const saved = await llm();
    if (isPaidLlmProvider(name, saved) && (req.body as { confirmPaid?: unknown } | undefined)?.confirmPaid !== true) {
      return reply(400, { ok: false, ran: false, message: "Este provedor é pago: o teste cobra uma chamada real. Confirme o gasto para testar." });
    }
    const provider = (await status()).providers.find((p) => p.name === name)!;
    if (!provider.available) return reply(200, { ok: false, ran: false, message: safeProbeMessage(provider.reason ?? "Provedor indisponível neste computador.") });
    const wait = (lastStart.get(name) ?? -Infinity) + minInterval - now();
    if (running.has(name) || wait > 0) {
      const retryAfterSeconds = Math.max(1, Math.ceil(wait / 1000));
      res.set("Retry-After", String(retryAfterSeconds));
      return reply(429, { ok: false, ran: false, message: running.has(name) ? "Já há um teste deste provedor em andamento." : `Aguarde ${retryAfterSeconds} s antes de testar de novo.`, retryAfterSeconds });
    }
    running.add(name);
    lastStart.set(name, now());
    try {
      const outcome = await probe(name as LlmProviderName, provider.kind === "cli" ? CLI_TIMEOUT_MS : API_TIMEOUT_MS);
      const test: PlatformTest = { ok: outcome.ok === true, at: new Date(now()).toISOString(), message: safeProbeMessage(outcome.message), ...(typeof outcome.ms === "number" ? { ms: Math.round(outcome.ms) } : {}) };
      recordTest(name, test, file);
      reply(200, { ok: test.ok, ran: true, message: test.message, test });
    } finally {
      running.delete(name);
    }
  });

  return router;
}

/** The platform API alone (so tests can drive the real routes without the whole panel). */
export function platformApp(deps: PlatformDeps = {}): express.Express {
  const app = express();
  app.use("/api/platform", platformRouter(deps));
  return app;
}

/** All storable keys that belong to some card (providers + services): used by the tests to catch a key nobody shows. */
export const groupedKeyNames = (): string[] => [...Object.values(LLM_PROVIDERS).map((p) => p.keyEnv).filter(Boolean), ...SERVICES.flatMap((s) => s.keyNames)];
