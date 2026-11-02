import { statSync } from "node:fs";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { keysApp, storableKeyStatus } from "../../dashboard/server/keys.js";
import { getSettings } from "../../dashboard/server/settings.js";
import { redactSecrets, registerSecret } from "../../src/orchestrator/lib/redact.js";
import { applyStoredKeys, readStore, removeStoredKey, setStoredKey, STORE_FILE, validateKeyValue } from "../../src/orchestrator/lib/secretStore.js";

const CANARY = "AIzaCANARY0000000000000000000000000000xyz"; // not a real key
const dirs: string[] = [];
const previousDir = process.env["MAQUINA_SECRETS_DIR"];
const newDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "keys-test-"));
  dirs.push(dir);
  process.env["MAQUINA_SECRETS_DIR"] = dir;
  return dir;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
afterAll(() => {
  if (previousDir === undefined) delete process.env["MAQUINA_SECRETS_DIR"];
  else process.env["MAQUINA_SECRETS_DIR"] = previousDir;
});

describe("secret store (secrets/api-keys.json)", () => {
  it("round-trips a key with owner-only permissions and leaves no temp file behind", () => {
    const dir = newDir();
    setStoredKey(dir, "GEMINI_API_KEY", `  ${CANARY} `);
    expect(readStore(dir)).toEqual({ GEMINI_API_KEY: CANARY });
    if (process.platform !== "win32") expect(statSync(join(dir, STORE_FILE)).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual([STORE_FILE]);
    expect(removeStoredKey(dir, "GEMINI_API_KEY")).toBe(true);
    expect(removeStoredKey(dir, "GEMINI_API_KEY")).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("accepts only known names and key-looking values, and never repeats the value in an error", () => {
    const dir = newDir();
    expect(() => setStoredKey(dir, "PATH", CANARY)).toThrow(/não pode ser guardada/);
    for (const bad of ["", "curta", "tem espaço no meio 12345", "linha1\nlinha2-12345", 42, null, "x".repeat(600)]) {
      expect(() => validateKeyValue(bad)).toThrow(/8 a 512|texto/);
    }
    let message = "";
    try {
      setStoredKey(dir, "GEMINI_API_KEY", `${CANARY} com espaço`);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain(CANARY);
    expect(readStore(dir)).toEqual({});
  });

  it("ignores unknown names and corrupt content in the file", () => {
    const dir = newDir();
    writeFileSync(join(dir, STORE_FILE), JSON.stringify({ GEMINI_API_KEY: CANARY, PATH: "/evil", PEXELS_API_KEY: 5 }));
    expect(readStore(dir)).toEqual({ GEMINI_API_KEY: CANARY });
    writeFileSync(join(dir, STORE_FILE), "{nope");
    expect(readStore(dir)).toEqual({});
  });

  it("fills only what the environment left unset, and masks stored values in logs", () => {
    const dir = newDir();
    setStoredKey(dir, "GEMINI_API_KEY", CANARY);
    setStoredKey(dir, "PEXELS_API_KEY", "pexels-key-from-panel-1234");
    const env: NodeJS.ProcessEnv = { PEXELS_API_KEY: "from-dot-env-wins-1234" };
    expect(applyStoredKeys(dir, env)).toEqual(["GEMINI_API_KEY"]);
    expect(env["PEXELS_API_KEY"]).toBe("from-dot-env-wins-1234");
    expect(env["GEMINI_API_KEY"]).toBe(CANARY);
    registerSecret("pexels-key-from-panel-1234");
    expect(redactSecrets(`erro com ${CANARY} e pexels-key-from-panel-1234`, {})).toBe("erro com *** e ***");
  });
});

describe("/api/keys never returns a key", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    server = createServer(keysApp());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/keys`;
  });
  afterAll(() => void server.close());

  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${base}${path}`, init);
    return { status: res.status, cache: res.headers.get("cache-control"), text: await res.text() };
  };
  const put = (name: string, body: unknown, type = "application/json") => call(`/${name}`, { method: "PUT", headers: { "Content-Type": type }, body: typeof body === "string" ? body : JSON.stringify(body) });

  it("stores through PUT and answers every route without the value", async () => {
    const dir = newDir();
    const saved = await put("GEMINI_API_KEY", { value: CANARY });
    expect(saved.status).toBe(200);
    expect(readStore(dir)).toEqual({ GEMINI_API_KEY: CANARY });
    const everything = [saved, await call(""), await call("/GEMINI_API_KEY"), await call("/GEMINI_API_KEY", { method: "DELETE" }), await put("GEMINI_API_KEY", { value: "curta" })];
    for (const r of everything) {
      expect(r.text).not.toContain(CANARY);
      expect(r.cache).toBe("no-store");
    }
    // the status list says "painel" for a stored key and never a value field
    await put("PEXELS_API_KEY", { value: "pexels-key-for-the-test-9999" });
    const list = JSON.parse((await call("")).text) as { keys: Record<string, unknown>[] };
    const pexels = list.keys.find((k) => k["name"] === "PEXELS_API_KEY");
    expect(pexels).toMatchObject({ configured: true, storable: true });
    expect(Object.keys(pexels!).sort()).toEqual(["configured", "label", "name", "source", "storable"]);
  });

  it("refuses non-JSON bodies, unknown names and malformed values", async () => {
    const dir = newDir();
    expect((await put("GEMINI_API_KEY", `value=${CANARY}`, "application/x-www-form-urlencoded")).status).toBe(415);
    expect((await put("GEMINI_API_KEY", `{"value":"${CANARY}"}`, "text/plain")).status).toBe(415);
    expect((await put("PATH", { value: CANARY })).status).toBe(404);
    expect((await put("GEMINI_API_KEY", { value: "tem espaço no meio 12345" })).status).toBe(422);
    expect((await put("GEMINI_API_KEY", { value: 12345678 })).status).toBe(422);
    const huge = await put("GEMINI_API_KEY", { value: "k".repeat(6000) });
    expect(huge.status).toBe(413);
    expect(huge.text).not.toContain("kkkkkkkkkk");
    expect((await call("/GEMINI_API_KEY", { method: "DELETE" })).status).toBe(404);
    expect(readStore(dir)).toEqual({});
  });

  it("tells the panel's own key from one set in .env or the environment", () => {
    const dir = newDir();
    setStoredKey(dir, "PIXABAY_API_KEY", "pixabay-from-the-panel-1234");
    const source = (): unknown => storableKeyStatus().find((k) => k.name === "PIXABAY_API_KEY")?.source;
    expect(source()).toBe("painel");
    process.env["PIXABAY_API_KEY"] = "pixabay-from-the-panel-1234"; // what applyStoredKeys does at start
    expect(source()).toBe("painel");
    process.env["PIXABAY_API_KEY"] = "pixabay-from-dot-env-5678";
    expect(source()).toBe(".env");
    delete process.env["PIXABAY_API_KEY"];
  });

  it("keeps the key out of the general settings payload too", async () => {
    const dir = newDir();
    setStoredKey(dir, "GEMINI_API_KEY", CANARY);
    const payload = JSON.stringify(await getSettings());
    expect(payload).not.toContain(CANARY);
    expect(storableKeyStatus().find((k) => k.name === "GEMINI_API_KEY")?.configured).toBe(true);
    expect(JSON.parse(payload).keys.find((k: { name: string }) => k.name === "GEMINI_API_KEY")).toMatchObject({ configured: true, storable: true });
    // the file itself is the only place that holds it
    expect(readFileSync(join(dir, STORE_FILE), "utf8")).toContain(CANARY);
  });
});
