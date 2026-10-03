import { describe, expect, it } from "vitest";
import {
  assembleMetadata,
  buildCredits,
  buildDescription,
  buildTags,
  buildTitle,
  DESCRIPTION_MAX,
  licenseKind,
  tagsLength,
  TITLE_MAX,
  validateMetadata,
} from "../../src/orchestrator/stages/07-generateMetadata.js";
import type { FootageClip, Script } from "../../src/orchestrator/types.js";

function clip(over: Partial<FootageClip>): FootageClip {
  return {
    sceneIndex: 0, path: "C:/x.jpg", kind: "image", durationSeconds: 0, width: 1080, height: 1920,
    source: "wikimedia", sourceUrl: "https://commons.wikimedia.org/wiki/File:X.jpg", creator: "", license: "Public domain",
    ...over,
  };
}

const script: Script = {
  title: "A chave esquecida do armário de binóculos do Titanic",
  hook: "Uma chave esquecida virou lenda no Titanic.",
  scenes: [{ narration: "O segundo oficial levou a chave.", footageQuery: "antique metal key" }],
  cta: "Siga o canal!",
  language: "pt-BR",
};

describe("licenseKind", () => {
  it.each([
    ["CC BY 2.0", "wikimedia", "attribution"],
    ["CC BY-SA 4.0", "wikimedia", "attribution"],
    ["Creative Commons Attribution 3.0", "wikimedia", "attribution"],
    ["CC0", "wikimedia", "public"],
    ["Public domain", "wikimedia", "public"],
    ["NASA Media Usage Guidelines (public domain with caveats)", "nasa", "public"],
    ["Pexels License", "pexels", "stock"],
  ] as const)("%s from %s -> %s", (license, source, kind) => {
    expect(licenseKind({ license, source })).toBe(kind);
  });
});

describe("buildCredits", () => {
  const footage = [
    clip({ sourceUrl: "https://c/A.jpg", creator: "Ana Silva", license: "CC BY 2.0" }),
    clip({ sceneIndex: 1, sourceUrl: "https://c/A.jpg", creator: "Ana Silva", license: "CC BY 2.0" }), // borrowed duplicate
    clip({ sourceUrl: "https://c/B.jpg", creator: "", license: "CC BY 4.0" }),
    clip({ sourceUrl: "https://c/C.jpg", license: "CC0" }),
    clip({ sourceUrl: "https://c/D.jpg", license: "Public domain" }),
    clip({ source: "nasa", sourceUrl: "https://images.nasa.gov/E", license: "NASA Media Usage Guidelines" }),
    clip({ source: "pexels", sourceUrl: "https://pexels.com/F", creator: "João", license: "Pexels License" }),
  ];
  const credits = buildCredits(footage);

  it("lists every CC BY file once with creator, license and link", () => {
    expect(credits).toContain("• Ana Silva — CC BY 2.0 — https://c/A.jpg (recortado e editado)");
    expect(credits).toContain("• Autor desconhecido — CC BY 4.0 — https://c/B.jpg (recortado e editado)");
    expect(credits.match(/https:\/\/c\/A\.jpg/g)).toHaveLength(1);
  });

  it("summarises public-domain material per source and adds the NASA note", () => {
    expect(credits).toContain("Domínio público / CC0: Wikimedia Commons (2), NASA (1)");
    expect(credits).toContain("não implicam endosso");
    expect(credits).not.toContain("https://c/C.jpg");
  });

  it("credits stock clips briefly", () => {
    expect(credits).toContain("• João via Pexels (Pexels License)");
  });

  it("is empty without footage", () => {
    expect(buildCredits([])).toBe("");
  });
});

describe("buildTitle", () => {
  it("appends #Shorts once", () => {
    expect(buildTitle("Vênus gira ao contrário #shorts")).toBe("Vênus gira ao contrário #Shorts");
  });

  it("cuts long titles at a word boundary to fit 100 chars", () => {
    const title = buildTitle(`${"palavra ".repeat(30)}fim`);
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(title.endsWith(" #Shorts")).toBe(true);
    expect(title).not.toMatch(/palavr #Shorts$/);
  });

  it("removes angle brackets", () => {
    expect(buildTitle("2 < 3 > 1")).toBe("2 3 1 #Shorts");
  });
});

describe("tags", () => {
  it("counts like YouTube: quotes for tags with spaces plus commas", () => {
    expect(tagsLength(["a", "b c"])).toBe(1 + 5 + 1);
  });

  it("dedupes, strips # and < >, and fits the 500-char budget", () => {
    const raw = ["#Titanic", "titanic", "a<b>", ...Array.from({ length: 60 }, (_, i) => `palavra chave ${i}`)];
    const tags = buildTags(raw);
    expect(tags.slice(0, 2)).toEqual(["Titanic", "ab"]);
    expect(tagsLength(tags)).toBeLessThanOrEqual(500);
  });
});

describe("description and validation", () => {
  it("has hook, context, hashtags (with #Shorts), credits and the synthetic voice line", () => {
    const d = buildDescription({ hook: script.hook, context: "Contexto.", hashtags: ["titanic", "#História"], credits: "Créditos das imagens:\n• x" });
    expect(d.split("\n\n")).toEqual([
      script.hook,
      "Contexto.",
      "#Shorts #titanic #História",
      "Créditos das imagens:\n• x",
      "Narração: voz sintética.",
    ]);
  });

  it("flags every YouTube limit", () => {
    const problems = validateMetadata({
      title: "x".repeat(101),
      description: "<".padEnd(DESCRIPTION_MAX + 1, "y"),
      tags: ["a>", ...Array.from({ length: 50 }, () => "dez letras")],
    });
    expect(problems).toEqual([
      "title has 101 chars (max 100)",
      `description has ${DESCRIPTION_MAX + 1} chars (max ${DESCRIPTION_MAX})`,
      "description contains < or >",
      "tags contains < or >",
      expect.stringMatching(/^tags use \d+ chars \(max 500\)$/),
    ]);
  });

  it("assembles valid metadata", () => {
    const meta = assembleMetadata({
      script,
      footage: [clip({ license: "CC BY 2.0", creator: "Ana" })],
      draft: { title: script.title, context: "A chave foi leiloada em 2007.", hashtags: ["titanic"], tags: ["titanic", "curiosidades"] },
      categoryId: "27",
      language: "pt-BR",
    });
    expect(validateMetadata(meta)).toEqual([]);
    expect(meta.title).toBe(`${script.title} #Shorts`);
    expect(meta.description).toContain("Créditos das imagens:");
    expect(meta).toMatchObject({ categoryId: "27", defaultLanguage: "pt-BR", defaultAudioLanguage: "pt-BR" });
  });
});
