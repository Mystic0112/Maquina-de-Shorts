import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { channelIdFromPage, feedTitle, parseChannelInput, resolveChannel, validateCuts } from "../../dashboard/server/cuts.js";

const ID = "UCvgSmIdI92W4KnP15fJwfwA";

describe("Configurações > Canais de corte: link -> channel", () => {
  it("accepts the links people paste and nothing outside youtube.com", () => {
    expect(parseChannelInput("https://www.youtube.com/@RedCastOficial/featured")).toEqual({ kind: "handle", handle: "RedCastOficial" });
    expect(parseChannelInput("youtube.com/@acfperformance")).toEqual({ kind: "handle", handle: "acfperformance" });
    expect(parseChannelInput("@etnrlz")).toEqual({ kind: "handle", handle: "etnrlz" });
    expect(parseChannelInput(`https://m.youtube.com/channel/${ID}/videos`)).toEqual({ kind: "id", id: ID });
    expect(parseChannelInput(` ${ID} `)).toEqual({ kind: "id", id: ID });
    expect(parseChannelInput("https://www.youtube.com/results?search_query=growth")).toBeUndefined();
    expect(parseChannelInput("https://evil.example/@acfperformance")).toBeUndefined();
    expect(parseChannelInput("https://youtube.com.evil.example/@x")).toBeUndefined();
  });

  it("reads the page's own id and the feed title", () => {
    const html = `<a href="/channel/UCaaaaaaaaaaaaaaaaaaaaaa">outro</a><link rel="canonical" href="https://www.youtube.com/channel/${ID}">`;
    expect(channelIdFromPage(html)).toBe(ID);
    expect(channelIdFromPage(`{"externalId":"${ID}"}`)).toBe(ID);
    expect(channelIdFromPage("<html></html>")).toBeUndefined();
    expect(feedTitle(`<feed xmlns="x"><id>y</id><title>Flow &amp; Cia</title><entry><title>vídeo</title></entry></feed>`)).toBe("Flow & Cia");
  });

  it("resolves a handle through the channel page + RSS, and explains failures", async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith("/@acfperformance")) return new Response(`<meta itemprop="identifier" content="${ID}">`);
      if (url.includes(`channel_id=${ID}`)) return new Response("<feed><title>ACF</title></feed>");
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    await expect(resolveChannel("youtube.com/@acfperformance", fetchFn)).resolves.toMatchObject({ ok: true, id: ID, name: "ACF" });
    await expect(resolveChannel("@naoexiste", fetchFn)).resolves.toMatchObject({ ok: false, message: expect.stringMatching(/404/) });
    await expect(resolveChannel("growth", fetchFn)).resolves.toMatchObject({ ok: false });
  });
});

describe("Configurações > Canais de corte: validation", () => {
  const example = JSON.parse(readFileSync(join(import.meta.dirname, "../../config/cuts.example.json"), "utf8")) as { channels: Record<string, unknown>[] };
  it("the example is valid; duplicates and bad ranges are flagged on the right field", () => {
    expect(validateCuts(example)).toEqual([]);
    const acf = example.channels[0] as Record<string, unknown>;
    const errors = validateCuts({ ...example, channels: [acf, { ...acf, minSeconds: 90, maxSeconds: 80 }] });
    expect(errors).toEqual(expect.arrayContaining([
      { path: "channels.1.id", message: "Este canal já está na lista." },
      { path: "channels.1.maxSeconds", message: "O máximo deve ser maior que o mínimo." },
    ]));
    expect(validateCuts({ ...example, channels: [{ ...acf, maxSeconds: 400 }] })[0]?.path).toBe("channels.0.maxSeconds");
  });
});
