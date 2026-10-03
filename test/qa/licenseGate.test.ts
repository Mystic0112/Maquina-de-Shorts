// QA (Quinn): the footage license gate (vendor/openmontage_adapter/fetch_footage.py) is the only thing
// standing between a non-commercial / share-alike file and a monetised upload. These tests call its
// pure functions through the project venv (no network: only stdlib + the module's top-level imports).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { paths } from "../../src/orchestrator/lib/config.js";
import { buildCredits, licenseKind } from "../../src/orchestrator/stages/07-generateMetadata.js";
import type { FootageClip } from "../../src/orchestrator/types.js";

const PYTHON = process.platform === "win32" ? paths.fromRoot(".venv", "Scripts", "python.exe") : paths.fromRoot(".venv", "bin", "python");
const hasVenv = existsSync(PYTHON);

/** Runs `expr(arg)` for each input inside fetch_footage.py and returns the JSON results. */
function py(expr: string, inputs: readonly unknown[]): unknown[] {
  const code = [
    "import json, sys",
    "sys.path.insert(0, 'vendor/openmontage_adapter')",
    "import fetch_footage as f",
    "inputs = json.loads(sys.stdin.read())",
    `print(json.dumps([(${expr}) for x in inputs]))`,
  ].join("\n");
  const out = execFileSync(PYTHON, ["-X", "utf8", "-c", code], { cwd: paths.root, input: JSON.stringify(inputs), encoding: "utf8", windowsHide: true });
  return JSON.parse(out) as unknown[];
}

describe.skipIf(!hasVenv)("Wikimedia license allowlist (is_wikimedia_license_allowed)", () => {
  const REJECT = [
    "CC BY-SA 4.0", "CC-BY-SA-3.0-migrated", "Creative Commons Attribution-Share Alike 4.0", "CC BY-NC 2.0", "cc-by-nc-sa-4.0",
    "CC BY-ND 3.0", "CC BY 4.0 NonCommercial", "CC BY 4.0 (non-commercial)", "CC BY 4.0 NoDerivatives", "CC BY-4.0-NC", "GFDL",
    "CC BY 4.0 or GFDL", "CC BY-SA 4.0, CC BY 4.0", "PD-art|CC BY-SA", "Attribution", "FAL", "No restrictions",
    "Wikimedia Commons (verify per-file license)", "",
  ];
  const ALLOW = ["CC BY 4.0", "CC-BY-4.0", "CC BY 2.0 fr", "CC BY 1.0", "CC0", "Public domain", "Public Domain Mark 1.0", "PD-USGov-NASA", "PD-old-70"];

  it("rejects share-alike, non-commercial, no-derivatives, GFDL, multi-licence and unknown strings", () => {
    const verdicts = py("f.is_wikimedia_license_allowed(x)", REJECT);
    expect(Object.fromEntries(REJECT.map((l, i) => [l, verdicts[i]]))).toEqual(Object.fromEntries(REJECT.map((l) => [l, false])));
  });

  it("accepts public domain, CC0 and plain CC BY", () => {
    const verdicts = py("f.is_wikimedia_license_allowed(x)", ALLOW);
    expect(Object.fromEntries(ALLOW.map((l, i) => [l, verdicts[i]]))).toEqual(Object.fromEntries(ALLOW.map((l) => [l, true])));
  });

  it("rejects any source that is not on the allowlist, keyed or not", () => {
    expect(py("f.license_rejection(x, 'CC0', '') is not None", ["archive_org", "pixabay", "unsplash", "esa", "coverr", ""])).toEqual([
      true, true, true, true, true, true,
    ]);
  });
});

describe.skipIf(!hasVenv)("NASA provenance gate (license_rejection('nasa', ...))", () => {
  it("drops items whose provenance carries a copyright marker", () => {
    expect(py("f.license_rejection('nasa', 'x', x) is not None", ["© 2019 Jane Doe", "Copyright ESA", "(c) SpaceX"])).toEqual([true, true, true]);
  });

  // images.nasa.gov hosts third-party material that is NOT public domain: SpaceX photos (CC BY-NC 2.0),
  // ESA/Hubble (CC BY 4.0, attribution required), agency/wire photos. Only ©/"copyright" text is caught.
  it("NASA-hosted third-party credits (SpaceX, ESA, Getty) are rejected (H4)", () => {
    const provenance = ["Falcon 9 launch. Photo Credit: SpaceX", "Credit: ESA/Hubble & NASA, J. Doe", "Photo Credit: Getty Images"];
    expect(py("f.license_rejection('nasa', 'NASA Media Usage Guidelines (public domain with caveats)', x) is not None", provenance)).toEqual([
      true, true, true,
    ]);
  });
});

describe("CC BY credits reach the description (07 buildCredits)", () => {
  const clip = (over: Partial<FootageClip>): FootageClip => ({
    sceneIndex: 0, path: "C:\\x\\0_0.mp4", kind: "video", durationSeconds: 5, width: 1080, height: 1920,
    source: "wikimedia", sourceUrl: "https://commons.wikimedia.org/wiki/File:A.webm", creator: "Ana Souza", license: "CC BY 4.0", ...over,
  });

  it("lists every distinct CC BY clip with creator, license and link, once even when a scene borrows it", () => {
    const a = clip({});
    const b = clip({ sceneIndex: 1, sourceUrl: "https://commons.wikimedia.org/wiki/File:B.jpg", creator: "  ", license: "CC-BY-2.0" });
    const credits = buildCredits([a, { ...a, sceneIndex: 2, borrowedFromScene: 0 }, b]);
    expect(credits.match(/^• /gm)).toHaveLength(2);
    expect(credits).toContain("• Ana Souza — CC BY 4.0 — https://commons.wikimedia.org/wiki/File:A.webm");
    expect(credits).toContain("• Autor desconhecido — CC-BY-2.0 — https://commons.wikimedia.org/wiki/File:B.jpg");
  });

  it("classifies the licence strings the gate lets through", () => {
    expect(licenseKind(clip({ license: "Creative Commons Attribution 4.0" }))).toBe("attribution");
    expect(licenseKind(clip({ source: "pexels", license: "Pexels License" }))).toBe("stock");
    expect(licenseKind(clip({ source: "nasa", license: "NASA Media Usage Guidelines (public domain with caveats)" }))).toBe("public");
  });
});
