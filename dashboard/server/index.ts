import { createServer } from "node:http";
import { join } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import type { MusicPayload, RefreshResponse, SaveResponse } from "../shared/api.js";
import { buildOverview, buildVideoRows } from "./aggregate.js";
import { config, dashboardDir, paths } from "./config.js";
import { LOGO_FILE, logoExists, MAX_LOGO_BYTES, saveLogo } from "./branding.js";
import { getCuts, putCuts, resolveChannel } from "./cuts.js";
import { addTrack, listTracks, MAX_TRACK_BYTES, removeTrack, trackPath } from "./music.js";
import { manualRefresh, startMetrics, youtubeStatus } from "./metrics.js";
import { getRevenue } from "./revenue.js";
import { isInsideRenderOutput, listRuns, RUN_ID_PATTERN } from "./runs.js";
import { thumbPathFor } from "./thumbnails.js";
import { PREVIEW_HASH, PREVIEWS_DIR, requestPreview } from "./preview.js";
import { getSettings, getTopics, putSettings, putTopics, SettingsError } from "./settings.js";
import { listVoices, SAMPLE_HASH, SAMPLES_DIR, voiceSample, type SampleRequest } from "./voices.js";

const app = express();
app.disable("x-powered-by");
app.set("etag", false);

// Only answer requests addressed to this machine (blocks DNS-rebinding pages from reading the API).
// DASHBOARD_ALLOWED_HOSTS adds names used through a private tunnel (Tailscale); the dashboard has no login,
// so never put a public hostname here.
const allowedHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`, ...config.allowedHosts]);
app.use((req, res, next) => {
  if (allowedHosts.has((req.headers.host ?? "").toLowerCase())) return next();
  res.status(403).send("Forbidden host");
});

app.get("/api/overview", async (_req, res) => {
  res.json(await buildOverview());
});

app.get("/api/runs", async (_req, res) => {
  res.json(await listRuns());
});

app.get("/api/videos", async (_req, res) => {
  res.json(await buildVideoRows());
});

app.get("/api/youtube", (_req, res) => {
  res.json(youtubeStatus());
});

// Requiring a JSON content type makes cross-site form posts impossible (they cannot set it without CORS).
app.post("/api/youtube/refresh", async (req, res) => {
  if (!req.is("application/json")) {
    res.status(415).json({ ok: false, message: "Use Content-Type: application/json" });
    return;
  }
  const result = await manualRefresh();
  const body: RefreshResponse = { ok: result.ok, message: result.message, youtube: youtubeStatus() };
  if (result.retryAfterMs !== undefined) res.status(429).set("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));
  res.json(body);
});

app.get("/api/revenue", async (_req, res) => {
  res.json(await getRevenue());
});

// Streams render_output/<runId>/final.mp4 (Range requests supported) so the browser can play it.
app.get("/api/runs/:runId/video", async (req, res) => {
  const runId = req.params.runId;
  const run = RUN_ID_PATTERN.test(runId) ? (await listRuns()).find((r) => r.runId === runId) : undefined;
  const file = run?.video?.exists ? run.video.path : null;
  if (!file || !isInsideRenderOutput(file)) {
    res.status(404).json({ error: "vídeo não encontrado" });
    return;
  }
  res.sendFile(file);
});

app.get("/api/runs/:runId/thumb.jpg", async (req, res) => {
  const runId = req.params.runId;
  const run = RUN_ID_PATTERN.test(runId) ? (await listRuns()).find((r) => r.runId === runId) : undefined;
  const thumb = run?.thumbUrl && run.video ? thumbPathFor(run.video.path) : null;
  if (!thumb || !isInsideRenderOutput(thumb)) {
    res.status(404).json({ error: "miniatura não encontrada" });
    return;
  }
  res.sendFile(thumb, { maxAge: "1h" }); // URL carries ?v=<mtime>, so caching is safe
});

/* ---------- Configurações ---------- */
// Mutations require a JSON body: cross-site forms cannot send one without a CORS preflight we never allow.
const jsonOnly = (req: Request, res: Response, next: NextFunction): void => {
  if (req.is("application/json")) return next();
  res.status(415).json({ ok: false, message: "Use Content-Type: application/json" });
};
const jsonBody = express.json({ limit: "256kb" });

function sendSettingsError(res: Response, error: unknown): void {
  if (error instanceof SettingsError) {
    res.status(error.status).json({ ok: false, message: error.message, errors: error.errors } satisfies SaveResponse);
    return;
  }
  throw error;
}

app.get("/api/settings", async (_req, res) => {
  try {
    res.json(await getSettings());
  } catch (error) {
    sendSettingsError(res, error);
  }
});

app.put("/api/settings", jsonOnly, jsonBody, async (req, res) => {
  try {
    const saved = await putSettings(req.body, req.get("If-Match") ?? undefined);
    res.json({ ok: true, message: "Configurações salvas.", ...saved } satisfies SaveResponse);
  } catch (error) {
    sendSettingsError(res, error);
  }
});

app.get("/api/topics", async (_req, res) => {
  try {
    res.json(await getTopics());
  } catch (error) {
    sendSettingsError(res, error);
  }
});

app.put("/api/topics", jsonOnly, jsonBody, async (req, res) => {
  try {
    const saved = await putTopics(req.body, req.get("If-Match") ?? undefined);
    res.json({ ok: true, message: "Temas salvos.", ...saved } satisfies SaveResponse);
  } catch (error) {
    sendSettingsError(res, error);
  }
});

app.get("/api/cuts", async (_req, res) => {
  try {
    res.json(await getCuts());
  } catch (error) {
    sendSettingsError(res, error);
  }
});

app.put("/api/cuts", jsonOnly, jsonBody, async (req, res) => {
  try {
    const saved = await putCuts(req.body, req.get("If-Match") ?? undefined);
    res.json({ ok: true, message: "Canais de corte salvos.", ...saved } satisfies SaveResponse);
  } catch (error) {
    sendSettingsError(res, error);
  }
});

app.post("/api/cuts/resolve", jsonOnly, jsonBody, async (req, res) => {
  res.json(await resolveChannel((req.body as { url?: unknown } | undefined)?.url));
});

// The PNG body type forces a CORS preflight, so other sites cannot post a logo here.
app.put("/api/branding/logo", express.raw({ type: "image/png", limit: MAX_LOGO_BYTES }), async (req, res) => {
  try {
    if (!req.is("image/png")) {
      res.status(415).json({ ok: false, message: "Use Content-Type: image/png" });
      return;
    }
    const path = await saveLogo(req.body);
    res.json({ ok: true, message: "Logo salvo.", path });
  } catch (error) {
    sendSettingsError(res, error);
  }
});

app.get("/api/branding/logo", (_req, res) => {
  if (!logoExists()) {
    res.status(404).end();
    return;
  }
  res.sendFile(LOGO_FILE, { headers: { "Cache-Control": "no-store" } });
});

/* ---------- Músicas (edits) ---------- */
app.get("/api/music", async (_req, res) => {
  res.json({ tracks: await listTracks() } satisfies MusicPayload);
});

// An audio body type + a custom header force a CORS preflight, so other sites cannot upload here.
app.put("/api/music", express.raw({ type: (req) => /^audio\//i.test(req.headers["content-type"] ?? ""), limit: MAX_TRACK_BYTES }), async (req, res) => {
  try {
    if (!/^audio\//i.test(req.headers["content-type"] ?? "")) {
      res.status(415).json({ ok: false, message: "Envie o arquivo com Content-Type audio/*." });
      return;
    }
    const name = decodeURIComponent(String(req.get("X-Track-Name") ?? ""));
    const track = await addTrack(name, req.body);
    res.json({ ok: true, message: "Música adicionada.", track });
  } catch (error) {
    sendSettingsError(res, error);
  }
});

app.delete("/api/music/:id", async (req, res) => {
  const removed = await removeTrack(req.params.id);
  res.status(removed ? 200 : 404).json({ ok: removed, message: removed ? "Música removida da lista." : "Música não encontrada." });
});

app.get("/api/music/:id/audio", async (req, res) => {
  const file = await trackPath(req.params.id);
  if (!file) {
    res.status(404).end();
    return;
  }
  res.sendFile(file, { headers: { "Cache-Control": "no-store" } });
});

app.get("/api/voices", async (_req, res) => {
  try {
    res.json(await listVoices());
  } catch (error) {
    res.status(503).json({ ok: false, message: error instanceof Error ? error.message : "Vozes indisponíveis." });
  }
});

app.post("/api/voices/sample", jsonOnly, jsonBody, async (req, res) => {
  const result = await voiceSample((req.body ?? {}) as SampleRequest);
  res.status(result.status).json(result.body);
});

app.get("/api/voices/sample/:file", (req, res) => {
  const hash = req.params.file.replace(/\.mp3$/, "");
  if (!SAMPLE_HASH.test(hash)) {
    res.status(404).end();
    return;
  }
  res.sendFile(join(SAMPLES_DIR, hash, "narration.mp3"), { maxAge: "1d" }, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

app.post("/api/preview", jsonOnly, jsonBody, async (req, res) => {
  res.json(await requestPreview(req.body));
});

app.get("/api/preview/:file", (req, res) => {
  const key = req.params.file.replace(/\.jpg$/, "");
  if (!PREVIEW_HASH.test(key)) {
    res.status(404).end();
    return;
  }
  res.sendFile(join(PREVIEWS_DIR, `${key}.jpg`), { maxAge: "1d" }, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "rota não encontrada" });
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[api] erro:", error instanceof Error ? error.message : error);
  res.status(500).json({ error: "erro interno" });
});

const server = createServer(app);

if (config.production) {
  app.use(express.static(paths.clientDist));
  app.get("/{*path}", (_req, res) => res.sendFile("index.html", { root: paths.clientDist }));
} else {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    configFile: `${dashboardDir}/vite.config.ts`,
    appType: "spa",
    // HMR websocket shares the same HTTP server, so dev is one process on one port.
    // Vite has its own host check; mirror ours (hostnames only, Vite ignores the port).
    server: { middlewareMode: true, ws: { server }, allowedHosts: config.allowedHosts.map((h) => h.split(":")[0]!) },
  });
  app.use(vite.middlewares);
  const shutdown = (): void => {
    void vite.close();
    server.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

await startMetrics();
server.listen(config.port, config.host, () => {
  console.log(`Painel em http://${config.host}:${config.port} (${config.production ? "produção" : "dev"})`);
});
