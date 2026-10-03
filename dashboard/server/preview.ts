// Live 9:16 preview stills for the Configurações page. Delegates to scripts/preview_still.ts (Remotion,
// owned by the pipeline), one render at a time; a newer request replaces any queued one ("superseded").
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CaptionSettingsSchema, resolveCaptions, resolveVisual, VisualSettingsSchema } from "../../src/shared/settings.js";
import type { PreviewResponse } from "../shared/api.js";
import { projectRoot } from "./config.js";
import { listRuns, RUN_ID_PATTERN } from "./runs.js";

const SCRIPT = join(projectRoot, "scripts", "preview_still.ts");
const TSX_CLI = join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
export const PREVIEWS_DIR = join(projectRoot, "data", "previews");
export const PREVIEW_HASH = /^[0-9a-f]{20}$/;
const TIMEOUT_MS = 180_000; // the first still bundles the Remotion project

interface Job {
  key: string;
  runId: string;
  time: number;
  style: unknown;
  resolve: (r: PreviewResponse) => void;
}

let running = false;
let pending: Job | null = null;

function render(job: Job): Promise<PreviewResponse> {
  return new Promise((resolve) => {
    void (async () => {
      await mkdir(PREVIEWS_DIR, { recursive: true });
      const out = join(PREVIEWS_DIR, `${job.key}.jpg`);
      const styleFile = join(PREVIEWS_DIR, `${job.key}.style.json`);
      await writeFile(styleFile, JSON.stringify(job.style), "utf8");
      const args = [TSX_CLI, SCRIPT, "--run", job.runId, "--time", String(job.time), "--out", out, "--style", styleFile];
      const child = spawn(process.execPath, args, { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr = (stderr + d).slice(-4000)));
      const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
      child.on("error", () => {
        clearTimeout(timer);
        resolve({ status: "error", message: "Não foi possível iniciar a pré-visualização." });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        // Contract: exactly one JSON line on stdout, {"path","ms"} on success or {"error"} on failure.
        const last = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
        let parsed: { ms?: number; error?: string } = {};
        try {
          parsed = JSON.parse(last) as typeof parsed;
        } catch {
          // no JSON (crash before printing): fall back to exit code + file on disk
        }
        if (code === 0 && existsSync(out)) {
          resolve({ status: "ok", url: `/api/preview/${job.key}.jpg`, ms: parsed.ms, cached: false, runId: job.runId });
        } else {
          const reason = parsed.error ?? stderr.trim().split(/\r?\n/).at(-1) ?? "";
          console.warn(`[preview] falhou (código ${code}): ${reason.slice(0, 300)}`);
          resolve({
            status: "error",
            message: parsed.error
              ? `O gerador recusou o estilo: ${parsed.error.slice(0, 300)}`
              : "A pré-visualização falhou. Tente outro instante do vídeo ou outra execução.",
          });
        }
      });
    })();
  });
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (pending) {
      const job = pending;
      pending = null;
      job.resolve(await render(job));
    }
  } finally {
    running = false;
  }
}

export async function requestPreview(body: unknown): Promise<PreviewResponse> {
  if (!existsSync(SCRIPT)) {
    return { status: "unavailable", message: "Pré-visualização indisponível: o gerador de quadros (scripts/preview_still.ts) ainda não existe." };
  }
  const req = (body ?? {}) as { runId?: unknown; time?: unknown; style?: { captions?: unknown; visual?: unknown } };
  const captions = CaptionSettingsSchema.safeParse(req.style?.captions ?? {});
  const visual = VisualSettingsSchema.safeParse(req.style?.visual ?? {});
  if (!captions.success || !visual.success) return { status: "error", message: "Estilo inválido: corrija os campos destacados." };

  // Resolve "latest" here so the cache key names a concrete run.
  const runs = (await listRuns()).filter((r) => r.status === "complete" && r.video?.exists && r.hasContext);
  const wanted = typeof req.runId === "string" && RUN_ID_PATTERN.test(req.runId) ? req.runId : undefined;
  const run = wanted ? runs.find((r) => r.runId === wanted) : runs[0];
  if (!run) return { status: "unavailable", message: "Nenhum vídeo renderizado disponível para pré-visualizar ainda." };
  const duration = run.video?.durationSeconds ?? 0;
  const rawTime = typeof req.time === "number" && Number.isFinite(req.time) ? req.time : 2;
  const time = Math.round(Math.max(0, Math.min(rawTime, Math.max(0, duration - 0.1))) * 10) / 10;
  const style = { captions: resolveCaptions(captions.data), visual: resolveVisual(visual.data) };

  const key = createHash("sha1").update(JSON.stringify([run.runId, time, style])).digest("hex").slice(0, 20);
  if (existsSync(join(PREVIEWS_DIR, `${key}.jpg`))) {
    return { status: "ok", url: `/api/preview/${key}.jpg`, cached: true, runId: run.runId };
  }
  return new Promise((resolve) => {
    pending?.resolve({ status: "superseded" }); // a newer request wins; the older one never renders
    pending = { key, runId: run.runId, time, style, resolve };
    void drain();
  });
}
