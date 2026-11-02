import { describe, expect, it } from "vitest";
import { isLocalBaseUrl, openAiBaseUrlIsPaid } from "../../dashboard/shared/baseUrl.js";
import { isLocalBaseUrl as serverIsLocal, isPaidLlmProvider } from "../../src/shared/settings.js";

const URLS = [
  "http://localhost:11434/v1",
  "http://127.0.0.1:1234/v1",
  "http://[::1]:8080/v1",
  "http://minha-maquina.local/v1",
  "http://10.0.0.5/v1",
  "http://172.16.3.4/v1",
  "http://172.32.3.4/v1",
  "http://192.168.0.5:1234/v1",
  "https://openrouter.ai/api/v1",
  "https://api.openai.com/v1",
  "http://user:pass@localhost/v1",
  "http://localhost/v1?key=abc",
  "http://localhost/v1#x",
  "ftp://localhost/v1",
  "nao é url",
  "",
  undefined,
];

describe("browser twin of the base URL cost rule", () => {
  it("agrees with the server rule on every case", () => {
    for (const u of URLS) {
      expect(openAiBaseUrlIsPaid(u), String(u)).toBe(isPaidLlmProvider("openai-compatible", { openaiCompatible: { baseUrl: u } }));
      if (u) expect(isLocalBaseUrl(u), u).toBe(serverIsLocal(u));
    }
  });
});
