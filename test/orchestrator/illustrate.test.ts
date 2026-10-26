import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { illustrationPrompt, ILLUSTRATION_LICENSE, ILLUSTRATION_SOURCE, ILLUSTRATION_STYLE, imagePathsIn, isInside, sniffImage } from "../../src/orchestrator/lib/illustrate.js";
import { imageQueryRule, queryWordRange } from "../../src/orchestrator/stages/02-generateScript.js";
import { buildCredits, licenseKind } from "../../src/orchestrator/stages/07-generateMetadata.js";
import type { FootageClip } from "../../src/orchestrator/types.js";

describe("illustrated image source (agy image tool)", () => {
  it("finds the generated file in agy's answer, JSON-escaped, plain or as a file:// link", () => {
    const json = JSON.stringify({ response: "Pronto: C:\\Users\\u\\.gemini\\antigravity-cli\\brain\\abc\\car_1761.jpg" });
    expect(imagePathsIn(json)).toEqual(["C:\\Users\\u\\.gemini\\antigravity-cli\\brain\\abc\\car_1761.jpg"]);
    expect(imagePathsIn("salvo em [car](file:///home/u/.gemini/antigravity-cli/brain/x/car.png) ok")).toEqual(["/home/u/.gemini/antigravity-cli/brain/x/car.png"]);
    expect(imagePathsIn("proporção 9:16 / vertical, arquivo /home/u/b/x.webp")).toEqual(["/home/u/b/x.webp"]);
    expect(imagePathsIn("veja file:///C:/Users/u/.gemini/antigravity-cli/brain/x/car.jpg")).toEqual(["C:/Users/u/.gemini/antigravity-cli/brain/x/car.jpg"]);
    expect(imagePathsIn("nenhuma imagem")).toEqual([]);
  });

  it("only trusts files inside the brain folder and with image magic bytes", () => {
    const brain = join("/home", "u", ".gemini", "antigravity-cli", "brain");
    expect(isInside(brain, join(brain, "abc", "car.jpg"))).toBe(true);
    expect(isInside(brain, join(brain, "..", "..", ".ssh", "id_rsa.jpg"))).toBe(false);
    expect(isInside(brain, `${brain}-evil/car.jpg`)).toBe(false);
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpg");
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("png");
    expect(sniffImage(Buffer.from("RIFF0000WEBPVP8 ", "latin1"))).toBe("webp");
    expect(sniffImage(Buffer.from("#!/bin/sh\nrm -rf", "latin1"))).toBeUndefined();
  });

  it("asks for one 9:16 image with the fixed style and no commands", () => {
    const prompt = illustrationPrompt("a red hatchback rolling down a hill road ");
    expect(prompt).toContain(`"a red hatchback rolling down a hill road. ${ILLUSTRATION_STYLE}"`);
    expect(prompt).toMatch(/9:16/);
    expect(prompt).toMatch(/Não execute comandos/);
    expect(ILLUSTRATION_STYLE).toMatch(/no text.*no logos/);
  });

  it("scene descriptions replace short stock searches in the script and the fact-check rewrite", () => {
    expect(queryWordRange({ specificFootage: true, imageSource: "ilustrado" })).toEqual({ min: 5, max: 30 });
    expect(queryWordRange({ specificFootage: true, imageSource: "acervo" })).toEqual({ min: 2, max: 6 });
    expect(imageQueryRule({ specificFootage: false, imageSource: "ilustrado" })).toMatch(/ilustração 3D, 5 a 30 palavras/);
    expect(imageQueryRule({ specificFootage: false })).toBe("2-4 palavras em inglês, coisas concretas e visíveis");
  });

  it("credits generated images as AI illustrations, not as public domain", () => {
    const clip: FootageClip = { sceneIndex: 0, path: "/r/ia_00.jpg", kind: "image", durationSeconds: 5, width: 768, height: 1376, source: ILLUSTRATION_SOURCE, sourceUrl: "", creator: "", license: ILLUSTRATION_LICENSE };
    expect(licenseKind(clip)).toBe("generated");
    const credits = buildCredits([clip, { ...clip, path: "/r/ia_01.jpg" }]);
    expect(credits).toBe("Créditos das imagens:\n• Ilustrações geradas por IA para este vídeo.");
  });
});
