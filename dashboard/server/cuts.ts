// Configurações > Canais de corte: read/write config/cuts.json (validated with the cuts pipeline's own zod
// schema) and turn a pasted channel link into its UC id + name. config/cuts.json is git-ignored; until the
// owner saves once, the page starts from config/cuts.example.json.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { clipRangeFor, CutsConfigSchema } from "../../src/orchestrator/cuts/config.js";
import { FEED_URL } from "../../src/orchestrator/cuts/feed.js";
import type { CutsPayload, FieldError, ResolveChannelResponse } from "../shared/api.js";
import { projectRoot } from "./config.js";
import { atomicWrite, fieldErrors, SettingsError, versionOf } from "./settings.js";

const CUTS_FILE = join(projectRoot, "config", "cuts.json");
const EXAMPLE_FILE = join(projectRoot, "config", "cuts.example.json");
const CHANNEL_ID = /^UC[\w-]{22}$/;
const FETCH_TIMEOUT_MS = 10_000;

export function validateCuts(body: unknown): FieldError[] {
  const parsed = CutsConfigSchema.safeParse(body);
  if (!parsed.success) return fieldErrors(parsed.error.issues);
  const errors: FieldError[] = [];
  const seen = new Set<string>();
  parsed.data.channels.forEach((channel, i) => {
    if (seen.has(channel.id)) errors.push({ path: `channels.${i}.id`, message: "Este canal já está na lista." });
    seen.add(channel.id);
    const range = clipRangeFor(channel, parsed.data);
    if (range.minSeconds >= range.maxSeconds) errors.push({ path: `channels.${i}.maxSeconds`, message: "O máximo deve ser maior que o mínimo." });
  });
  return errors;
}

export async function getCuts(): Promise<CutsPayload> {
  const exists = existsSync(CUTS_FILE);
  const text = await readFile(exists ? CUTS_FILE : EXAMPLE_FILE, "utf8");
  let data: CutsPayload["data"];
  try {
    data = JSON.parse(text) as CutsPayload["data"];
  } catch {
    throw new SettingsError(500, `${basename(exists ? CUTS_FILE : EXAMPLE_FILE)} não é um JSON válido.`);
  }
  return { version: exists ? versionOf(text) : "", exists, data, errors: validateCuts(data) };
}

export async function putCuts(body: unknown, expectedVersion: string | undefined): Promise<{ version: string; backup: string }> {
  if (existsSync(CUTS_FILE)) {
    const current = await readFile(CUTS_FILE, "utf8");
    if (expectedVersion !== versionOf(current)) {
      throw new SettingsError(409, "Os canais foram alterados por outro processo. Recarregue para ver a versão atual.");
    }
  }
  const errors = validateCuts(body);
  if (errors.length) throw new SettingsError(422, "Corrija os campos destacados.", errors);
  const backup = await atomicWrite(CUTS_FILE, body); // body, not the parsed copy: unknown keys survive
  return { version: versionOf(`${JSON.stringify(body, null, 2)}\n`), backup: basename(backup) };
}

/* ---------- link -> channel ---------- */
export type ChannelInput = { kind: "id"; id: string } | { kind: "handle"; handle: string } | { kind: "tiktok"; handle: string };

/**
 * Accepts what people paste: "@handle", "youtube.com/@handle/featured", "https://www.youtube.com/channel/UC…",
 * or a bare UC id. Only youtube.com addresses are accepted (the server fetches them).
 */
export function parseChannelInput(raw: string): ChannelInput | undefined {
  const input = raw.trim();
  if (CHANNEL_ID.test(input)) return { kind: "id", id: input };
  const bare = /^@([\w.-]{3,30})$/.exec(input);
  if (bare) return { kind: "handle", handle: bare[1] as string };
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return undefined;
  }
  if (/^(www\.|m\.)?tiktok\.com$/i.test(url.hostname)) {
    const tiktok = /^\/@([\w.]{2,24})(\/|$)/.exec(url.pathname);
    return tiktok ? { kind: "tiktok", handle: tiktok[1] as string } : undefined;
  }
  if (!/^(www\.|m\.)?youtube\.com$/i.test(url.hostname)) return undefined;
  const [first, second] = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (first === "channel" && second && CHANNEL_ID.test(second)) return { kind: "id", id: second };
  const handle = first?.startsWith("@") ? /^@([\w.-]{3,30})$/.exec(first) : null;
  return handle ? { kind: "handle", handle: handle[1] as string } : undefined;
}

/** The channel id a channel page declares about itself (not ids of channels it links to). */
export function channelIdFromPage(html: string): string | undefined {
  const patterns = [
    /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/,
    /<meta itemprop="identifier" content="(UC[\w-]{22})"/,
    /"externalId":"(UC[\w-]{22})"/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match) return match[1];
  }
  return undefined;
}

/** Channel name from its RSS feed (<feed><title>). */
export function feedTitle(xml: string): string | undefined {
  const match = /<feed[^>]*>[\s\S]*?<title>([\s\S]*?)<\/title>/.exec(xml);
  return match?.[1]
    ?.replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

export async function resolveChannel(raw: unknown, fetchFn: typeof fetch = fetch): Promise<ResolveChannelResponse> {
  const input = typeof raw === "string" ? parseChannelInput(raw) : undefined;
  if (!input) return { ok: false, message: "Cole o link do canal no YouTube (ex.: youtube.com/@acfperformance) ou do perfil no TikTok (ex.: tiktok.com/@perfil)." };
  // TikTok needs no lookup: the @handle is the id the cuts pipeline lists with yt-dlp (at home).
  if (input.kind === "tiktok") return { ok: true, message: `Perfil do TikTok: @${input.handle}.`, id: `@${input.handle}`, name: input.handle, url: `https://www.tiktok.com/@${input.handle}`, platform: "tiktok" };
  const get = (url: string) => fetchFn(url, { headers: { "accept-language": "pt-BR" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  try {
    let id = input.kind === "id" ? input.id : undefined;
    if (input.kind === "handle") {
      const page = await get(`https://www.youtube.com/@${encodeURIComponent(input.handle)}`);
      if (!page.ok) return { ok: false, message: `O YouTube respondeu ${page.status} para @${input.handle}. Confira o link.` };
      id = channelIdFromPage(await page.text());
      if (!id) return { ok: false, message: `Não achei o código do canal @${input.handle} na página do YouTube.` };
    }
    const feed = await get(FEED_URL(id as string));
    if (!feed.ok) return { ok: false, message: `O canal ${id} não respondeu pelo RSS (HTTP ${feed.status}).` };
    const name = feedTitle(await feed.text()) ?? (input.kind === "handle" ? input.handle : (id as string));
    return { ok: true, message: `Canal encontrado: ${name}.`, id, name, url: `https://www.youtube.com/channel/${id}`, platform: "youtube" };
  } catch (error) {
    return { ok: false, message: `Não consegui falar com o YouTube: ${error instanceof Error ? error.message : String(error)}` };
  }
}
