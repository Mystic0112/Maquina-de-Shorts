// Client-side twin of isLocalBaseUrl / isPaidLlmProvider("openai-compatible") in src/shared/settings.ts (the browser bundle
// cannot import runtime code from src/). It lets the page judge the base URL being TYPED (the draft) instead of the saved
// one. test/dashboard/baseUrl.test.ts keeps both in step.

/** localhost, loopback (127.x, ::1), *.localhost, *.local and private ranges (10.x, 172.16-31.x, 192.168.x). */
export function isLocalBaseUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host === "[::1]" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** True unless the typed base URL is valid AND points to this computer or the local network (a missing/invalid URL is paid: the safe answer). */
export function openAiBaseUrlIsPaid(raw: string | undefined): boolean {
  const text = (raw ?? "").trim();
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return true;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return true;
  if (u.username || u.password || u.hash || text.includes("#") || u.search || text.includes("?")) return true;
  return !isLocalBaseUrl(u.href);
}
