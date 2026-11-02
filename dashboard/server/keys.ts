// Configurações > Chaves: write-only API keys. The routes below never return a key: they report only whether each one
// is set and where it comes from. Storage and validation live in src/orchestrator/lib/secretStore.ts.
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { isStorableKey, readStore, removeStoredKey, secretsDir, SecretStoreError, setStoredKey, STORABLE_KEYS } from "../../src/orchestrator/lib/secretStore.js";
import type { KeyStatus, KeyWriteResponse } from "../shared/api.js";
import { envIsSet, projectRoot } from "./config.js";

const dir = (): string => secretsDir(projectRoot);

/** Status of every storable key: "painel" = secrets/api-keys.json, ".env" = environment or .env file. */
export function storableKeyStatus(): KeyStatus[] {
  const stored = readStore(dir());
  return STORABLE_KEYS.map((k) => {
    const fromStore = k.name in stored;
    // The pipeline's config module copies stored keys into process.env: an equal value there is the store's own.
    const fromEnv = envIsSet(k.name) && !(fromStore && process.env[k.name]?.trim() === stored[k.name]);
    return { name: k.name, label: k.label, configured: fromStore || fromEnv, storable: true, ...(fromEnv ? { source: ".env" as const } : fromStore ? { source: "painel" as const } : {}) };
  });
}

const noStore = (_req: Request, res: Response, next: NextFunction): void => {
  res.set("Cache-Control", "no-store");
  next();
};
const jsonOnly = (req: Request, res: Response, next: NextFunction): void => {
  if (req.is("application/json")) return next();
  res.status(415).json({ ok: false, message: "Use Content-Type: application/json" } satisfies KeyWriteResponse);
};

/** Mounted at /api/keys. Bodies are tiny on purpose: a key is at most 512 characters. */
export function keysRouter(): Router {
  const router = express.Router();
  router.use(noStore);

  router.get("/", (_req, res) => {
    res.json({ keys: storableKeyStatus() });
  });

  router.put("/:name", jsonOnly, express.json({ limit: "4kb" }), (req, res) => {
    const name = String(req.params["name"] ?? "");
    if (!isStorableKey(name)) {
      res.status(404).json({ ok: false, message: "Chave desconhecida." } satisfies KeyWriteResponse);
      return;
    }
    try {
      setStoredKey(dir(), name, (req.body as { value?: unknown } | undefined)?.value);
    } catch (error) {
      if (error instanceof SecretStoreError) {
        res.status(422).json({ ok: false, message: error.message } satisfies KeyWriteResponse);
        return;
      }
      throw error;
    }
    res.json({ ok: true, message: "Chave guardada. Ela vale a partir da próxima execução.", keys: storableKeyStatus() } satisfies KeyWriteResponse);
  });

  router.delete("/:name", (req, res) => {
    const name = String(req.params["name"] ?? "");
    const removed = isStorableKey(name) && removeStoredKey(dir(), name);
    res.status(removed ? 200 : 404).json({ ok: removed, message: removed ? "Chave removida do painel." : "Não há chave guardada pelo painel com esse nome.", keys: storableKeyStatus() } satisfies KeyWriteResponse);
  });

  // Oversized bodies are the caller's mistake, not a server error.
  router.use((error: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if ((error as { type?: string } | null)?.type === "entity.too.large") {
      res.status(413).json({ ok: false, message: "A chave é grande demais (o máximo são 512 caracteres)." } satisfies KeyWriteResponse);
      return;
    }
    next(error);
  });

  return router;
}

/** The keys API alone, mounted where index.ts mounts it (so tests can drive the real routes without the whole panel). */
export function keysApp(): express.Express {
  const app = express();
  app.use("/api/keys", keysRouter());
  return app;
}
