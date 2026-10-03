import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { HttpFetch, HttpRequest } from "../../src/orchestrator/lib/instagramApi.js";
import {
  AuthCallbackError,
  buildAuthorizeUrl,
  completeLogin,
  createState,
  ensureFreshToken,
  INSTAGRAM_REDIRECT_URI,
  instagramTokenProblems,
  loadAppCredentials,
  needsRefresh,
  parseCallbackInput,
  parseCallbackParams,
  parseState,
  STATE_PATTERN,
  type InstagramToken,
} from "../../src/orchestrator/lib/instagramAuth.js";

const NOW = new Date("2026-10-03T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const NONCE = "0123456789abcdef0123456789abcdef";
const STATE = `49152.${NONCE}`;
const CODE = "AQBx-hBsH3_fakeCode.123";
const creds = { appId: "990602627938098", appSecret: "fake-app-secret-abcdef123456" };

interface Call {
  url: string;
  init: HttpRequest;
}

function json(status: number, body: unknown) {
  return { status, text: async () => JSON.stringify(body) };
}

function fakeHttp(route: (url: URL, init: HttpRequest) => { status: number; text(): Promise<string> }) {
  const calls: Call[] = [];
  const http: HttpFetch = async (url, init) => {
    calls.push({ url, init });
    return route(new URL(url), init);
  };
  return { http, calls };
}

function tokenFile(token: Partial<InstagramToken> = {}): string {
  const file = join(mkdtempSync(join(tmpdir(), "ig-token-")), "instagram.token.json");
  const full: InstagramToken = {
    accessToken: "IGAAlongLivedFAKEtoken1234567890",
    tokenType: "bearer",
    expiresAt: new Date(NOW.getTime() + 50 * DAY).toISOString(),
    issuedAt: new Date(NOW.getTime() - 10 * DAY).toISOString(),
    userId: "17841400000000001",
    username: "maquina.shorts",
    accountType: "MEDIA_CREATOR",
    ...token,
  };
  writeFileSync(file, JSON.stringify(full));
  return file;
}

// ---------------------------------------------------------------------------------------------
// state / authorize URL / callback parsing
// ---------------------------------------------------------------------------------------------

describe("OAuth state", () => {
  it("carries the loopback port and a 32-hex nonce", () => {
    const state = createState(49152);
    expect(state).toMatch(/^49152\.[0-9a-f]{32}$/);
    expect(parseState(state)).toEqual({ port: 49152, nonce: state.split(".")[1] });
  });

  it.each(["", "49152", `80.${NONCE}`, `70000.${NONCE}`, `49152.${NONCE.toUpperCase()}`, `49152.${NONCE}x`, `evil.com:80.${NONCE}`, `049152.${NONCE}`])(
    "rejects %j",
    (state) => {
      expect(parseState(state)).toBeUndefined();
    },
  );

  it("builds the Instagram authorize URL with the registered redirect URI and all three scopes", () => {
    const url = new URL(buildAuthorizeUrl(creds.appId, STATE));
    expect(`${url.origin}${url.pathname}`).toBe("https://www.instagram.com/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: creds.appId,
      redirect_uri: "https://mystic0112.github.io/Maquina-de-Shorts/oauth/callback.html",
      response_type: "code",
      scope: "instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights",
      state: STATE,
    });
    expect(url.toString()).not.toContain(creds.appSecret);
  });
});

describe("callback parsing", () => {
  it("accepts the loopback query with the expected state and strips Meta's #_", () => {
    expect(parseCallbackParams(new URLSearchParams({ code: `${CODE}#_`, state: STATE }), STATE)).toBe(CODE);
  });

  it("rejects a wrong state, a missing code and a denied authorization", () => {
    expect(() => parseCallbackParams(new URLSearchParams({ code: CODE, state: `49153.${NONCE}` }), STATE)).toThrow(AuthCallbackError);
    expect(() => parseCallbackParams(new URLSearchParams({ state: STATE }), STATE)).toThrow(/sem código/);
    expect(() => parseCallbackParams(new URLSearchParams({ error: "access_denied", error_reason: "user_denied" }), STATE)).toThrow(/user_denied/);
  });

  it("accepts a pasted bare code or a pasted callback URL (whose state is checked)", () => {
    expect(parseCallbackInput(`  ${CODE}  `, STATE)).toBe(CODE);
    expect(parseCallbackInput(`${INSTAGRAM_REDIRECT_URI}?code=${CODE}&state=${STATE}#_`, STATE)).toBe(CODE);
    expect(() => parseCallbackInput(`${INSTAGRAM_REDIRECT_URI}?code=${CODE}&state=49999.${NONCE}`, STATE)).toThrow(/state/);
    expect(() => parseCallbackInput("<script>alert(1)</script>", STATE)).toThrow(AuthCallbackError);
  });
});

// ---------------------------------------------------------------------------------------------
// docs/oauth/callback.html (runs the page's own script in a sandbox)
// ---------------------------------------------------------------------------------------------

const PAGE = readFileSync(join(__dirname, "../../docs/oauth/callback.html"), "utf8").replace(/\r\n/g, "\n");
const PAGE_SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(PAGE)?.[1] ?? "";

interface FakeElement {
  textContent: string;
  hidden: boolean;
  className: string;
  attributes: Record<string, string>;
  setAttribute(name: string, value: string): void;
  addEventListener(): void;
}

function runCallbackPage(search: string) {
  const elements = new Map<string, FakeElement>();
  const element = (id: string): FakeElement => {
    if (!elements.has(id)) {
      elements.set(id, {
        textContent: "",
        hidden: true,
        className: "",
        attributes: {},
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
        addEventListener: () => undefined,
      });
    }
    return elements.get(id) as FakeElement;
  };
  const navigations: string[] = [];
  const replacedUrls: string[] = [];
  const timers: (() => void)[] = [];
  const window = {
    location: { search, pathname: "/Maquina-de-Shorts/oauth/callback.html", replace: (url: string) => navigations.push(url) },
    history: { replaceState: (_s: unknown, _t: string, url: string) => replacedUrls.push(url) },
    setTimeout: (fn: () => void) => timers.push(fn),
    getSelection: () => ({ selectAllChildren: () => undefined }),
  };
  runInNewContext(PAGE_SCRIPT, { window, document: { getElementById: element }, navigator: {}, URLSearchParams });
  for (const fn of timers) fn();
  return { navigations, replacedUrls, element };
}

describe("GitHub Pages callback page", () => {
  it("validates state with the same pattern as the script", () => {
    expect(PAGE).toContain(`var STATE_PATTERN = ${STATE_PATTERN.toString()};`);
  });

  it("pins its only inline script with a CSP hash, blocks every network request and never sends a Referer", () => {
    const hash = createHash("sha256").update(PAGE_SCRIPT, "utf8").digest("base64");
    expect(PAGE).toContain(`script-src 'sha256-${hash}'`);
    expect(PAGE).toContain("default-src 'none'");
    expect(PAGE).toContain('<meta name="referrer" content="no-referrer">');
    expect(PAGE).not.toMatch(/<script[^>]+src=/);
    expect(PAGE_SCRIPT).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|WebSocket/);
  });

  it("forwards a valid callback only to 127.0.0.1:<port> and offers the code for pasting", () => {
    const page = runCallbackPage(`?code=${encodeURIComponent(CODE)}&state=${STATE}`);
    expect(page.navigations).toEqual([`http://127.0.0.1:49152/callback?code=${encodeURIComponent(CODE)}&state=${encodeURIComponent(STATE)}`]);
    expect(page.element("continue").attributes.href).toBe(page.navigations[0]);
    expect(page.element("code").textContent).toBe(CODE);
    expect(page.element("manual").hidden).toBe(false);
    expect(page.replacedUrls).toEqual(["/Maquina-de-Shorts/oauth/callback.html"]); // code removed from the address bar
  });

  it.each([
    ["an invalid state", `?code=${CODE}&state=49152.notanonce`],
    ["a state pointing to another host", `?code=${CODE}&state=${encodeURIComponent(`evil.example:443.${NONCE}`)}`],
    ["no state at all", `?code=${CODE}`],
    ["a denied authorization", "?error=access_denied&error_reason=user_denied&state=" + STATE],
    ["a code with markup", `?code=${encodeURIComponent('"><img src=x>')}&state=${STATE}`],
  ])("does nothing with %s", (_label, search) => {
    const page = runCallbackPage(search);
    expect(page.navigations).toEqual([]);
    expect(page.element("code").textContent).toBe("");
    expect(page.element("message").className).toBe("bad");
  });
});

// ---------------------------------------------------------------------------------------------
// Token exchange and persistence
// ---------------------------------------------------------------------------------------------

describe("completeLogin", () => {
  function loginServer(shortShape: "flat" | "data" = "flat") {
    return fakeHttp((url, init) => {
      if (url.host === "api.instagram.com" && url.pathname === "/oauth/access_token") {
        const body = Object.fromEntries(new URLSearchParams(String(init.body)));
        expect(init.method).toBe("POST");
        expect(body).toEqual({ client_id: creds.appId, client_secret: creds.appSecret, grant_type: "authorization_code", redirect_uri: INSTAGRAM_REDIRECT_URI, code: CODE });
        const token = { access_token: "IGshortLivedFAKE1234567890", user_id: 1020, permissions: "instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights" };
        return json(200, shortShape === "flat" ? token : { data: [token] });
      }
      if (url.pathname === "/access_token") {
        expect(Object.fromEntries(url.searchParams)).toEqual({ grant_type: "ig_exchange_token", client_secret: creds.appSecret, access_token: "IGshortLivedFAKE1234567890" });
        return json(200, { access_token: "IGlongLivedFAKE1234567890", token_type: "bearer", expires_in: 5184000 });
      }
      if (url.pathname === "/v25.0/me") {
        expect(url.searchParams.get("access_token")).toBe("IGlongLivedFAKE1234567890");
        return json(200, { user_id: "17841400000000001", id: "1020", username: "maquina.shorts", account_type: "MEDIA_CREATOR" });
      }
      return json(404, { error: { message: "unexpected" } });
    });
  }

  it.each(["flat", "data"] as const)("code -> short token -> 60-day token -> profile, saved atomically (%s response)", async (shape) => {
    const { http, calls } = loginServer(shape);
    const file = join(mkdtempSync(join(tmpdir(), "ig-login-")), "secrets", "instagram.token.json");
    const token = await completeLogin(CODE, creds, { http, now: NOW, file });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/oauth/access_token", "/access_token", "/v25.0/me"]);
    const saved = JSON.parse(readFileSync(file, "utf8")) as InstagramToken;
    expect(saved).toEqual(token);
    expect(saved).toMatchObject({
      accessToken: "IGlongLivedFAKE1234567890",
      expiresAt: "2026-12-02T12:00:00.000Z",
      issuedAt: NOW.toISOString(),
      userId: "17841400000000001",
      username: "maquina.shorts",
      accountType: "MEDIA_CREATOR",
      permissions: ["instagram_business_basic", "instagram_business_content_publish", "instagram_business_manage_insights"],
    });
    expect(readdirSync(join(file, "..")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("a rejected code fails with Meta's message and no secret in it", async () => {
    const { http } = fakeHttp(() => json(400, { error_type: "OAuthException", code: 400, error_message: "Matching code was not found or was already used" }));
    const file = join(mkdtempSync(join(tmpdir(), "ig-login-")), "instagram.token.json");
    const error = (await completeLogin(CODE, creds, { http, now: NOW, file }).catch((e: unknown) => e)) as Error;
    expect(error.message).toContain("Matching code was not found");
    expect(error.message).not.toContain(creds.appSecret);
    expect(error.message).not.toContain(CODE);
    expect(existsSync(file)).toBe(false);
  });

  it("reads the app credentials from the environment and rejects a non-numeric app id", () => {
    expect(loadAppCredentials((n) => ({ INSTAGRAM_APP_ID: creds.appId, INSTAGRAM_APP_SECRET: creds.appSecret })[n])).toEqual(creds);
    expect(() => loadAppCredentials(() => undefined)).toThrow(/INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET/);
    expect(() => loadAppCredentials((n) => ({ INSTAGRAM_APP_ID: "abc", INSTAGRAM_APP_SECRET: "x" })[n])).toThrow(/número/);
  });
});

describe("token refresh", () => {
  const refreshServer = (status = 200) =>
    fakeHttp((url) => {
      expect(url.pathname).toBe("/refresh_access_token");
      expect(url.searchParams.get("grant_type")).toBe("ig_refresh_token");
      return status === 200 ? json(200, { access_token: "IGrotatedFAKE1234567890", token_type: "bearer", expires_in: 5184000 }) : json(status, { error: { message: "boom", code: 2 } });
    });

  it("refreshes when fewer than 10 days remain and persists the rotated token", async () => {
    const file = tokenFile({ expiresAt: new Date(NOW.getTime() + 5 * DAY).toISOString(), issuedAt: new Date(NOW.getTime() - 55 * DAY).toISOString() });
    const { http, calls } = refreshServer();
    const fresh = await ensureFreshToken({ file, http, now: NOW });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).searchParams.get("access_token")).toBe("IGAAlongLivedFAKEtoken1234567890");
    expect(fresh).toMatchObject({ accessToken: "IGrotatedFAKE1234567890", issuedAt: NOW.toISOString(), expiresAt: "2026-12-02T12:00:00.000Z", username: "maquina.shorts" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(fresh);
  });

  it("does not refresh with 10+ days left, nor a token younger than 24 h", async () => {
    const { http, calls } = refreshServer();
    await ensureFreshToken({ file: tokenFile(), http, now: NOW });
    expect(needsRefresh({ expiresAt: new Date(NOW.getTime() + 5 * DAY).toISOString(), issuedAt: new Date(NOW.getTime() - 3_600_000).toISOString() }, NOW)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("a failed refresh only warns while the token still works", async () => {
    const file = tokenFile({ expiresAt: new Date(NOW.getTime() + 2 * DAY).toISOString(), issuedAt: new Date(NOW.getTime() - 58 * DAY).toISOString() });
    const before = readFileSync(file, "utf8");
    const warnings: string[] = [];
    const token = await ensureFreshToken({ file, http: refreshServer(500).http, now: NOW, warn: (m) => warnings.push(m) });
    expect(token.accessToken).toBe("IGAAlongLivedFAKEtoken1234567890");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("boom");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("an expired or missing token is a blocker and cannot be refreshed", async () => {
    const expired = tokenFile({ expiresAt: new Date(NOW.getTime() - 1000).toISOString() });
    expect(instagramTokenProblems(expired, NOW)).toEqual([expect.stringMatching(/expired.*npm run auth:instagram/)]);
    expect(instagramTokenProblems(join(tmpdir(), "nope", "instagram.token.json"), NOW)).toEqual([expect.stringMatching(/not found.*npm run auth:instagram/)]);
    expect(instagramTokenProblems(tokenFile(), NOW)).toEqual([]);
    await expect(ensureFreshToken({ file: expired, http: refreshServer().http, now: NOW })).rejects.toThrow(/expired/);
  });
});
