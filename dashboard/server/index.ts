import { createServer } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import type { RefreshResponse } from "../shared/api.js";
import { buildOverview, buildVideoRows } from "./aggregate.js";
import { config, dashboardDir, paths } from "./config.js";
import { manualRefresh, startMetrics, youtubeStatus } from "./metrics.js";
import { getRevenue } from "./revenue.js";
import { isInsideRenderOutput, listRuns, RUN_ID_PATTERN } from "./runs.js";
import { thumbPathFor } from "./thumbnails.js";

const app = express();
app.disable("x-powered-by");
app.set("etag", false);

// Only answer requests addressed to this machine (blocks DNS-rebinding pages from reading the API).
const allowedHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);
app.use((req, res, next) => {
  if (allowedHosts.has(req.headers.host ?? "")) return next();
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
    server: { middlewareMode: true, ws: { server } },
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
