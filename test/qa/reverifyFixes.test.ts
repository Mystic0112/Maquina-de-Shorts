// QA (Quinn), second pass: independent re-verification of commit a299188 ("Corrige falhas ... QA").
//
// `it.fails` = a residual bug or a new hole found while re-verifying the fixes. The assertion states the
// correct behaviour and currently fails, so vitest reports it as an expected failure. Once the bug is fixed,
// vitest reports it as a failure: remove `.fails` then. Fakes only; writes go to the OS temp dir; Python
// tests only call pure functions/imports through the project venv (no network).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { minimalChildEnv } from "../../src/orchestrator/lib/childEnv.js";
import { paths } from "../../src/orchestrator/lib/config.js";
import { resolveFfmpegBinaries } from "../../src/orchestrator/lib/ffmpeg.js";
import { withFileLock } from "../../src/orchestrator/lib/fileLock.js";
import { scriptSupportsFlag } from "../../src/orchestrator/lib/python.js";
import { findSimilarSubject } from "../../src/orchestrator/lib/recentTopics.js";
import { redactSecrets } from "../../src/orchestrator/lib/redact.js";
import { buildCredits, verbatimContext } from "../../src/orchestrator/stages/07-generateMetadata.js";
import { publishBlockers } from "../../src/orchestrator/stages/08-uploadYouTube.js";
import type { FootageClip, RunContext, Script } from "../../src/orchestrator/types.js";

const isWindows = process.platform === "win32";
const PYTHON = isWindows ? paths.fromRoot(".venv", "Scripts", "python.exe") : paths.fromRoot(".venv", "bin", "python");
const hasVenv = existsSync(PYTHON);

// ---------------------------------------------------------------------------------------------
// fileLock (upload lock + history lock)
// ---------------------------------------------------------------------------------------------

/** Runs `contenders` concurrent holders `trials` times; returns errors seen and the max simultaneous holders. */
async function contend(trials: number, contenders: number, staleLockAtStart: boolean, holdMs = 5) {
  const errors: string[] = [];
  let maxHolders = 0;
  for (let n = 0; n < trials; n++) {
    const lock = join(mkdtempSync(join(tmpdir(), "qa-lock-")), "upload.lock");
    if (staleLockAtStart) {
      writeFileSync(lock, "{}"); // left behind by a crashed process 4 h ago
      const old = new Date(Date.now() - 4 * 3600_000);
      utimesSync(lock, old, old);
    }
    let active = 0;
    const holder = () =>
      withFileLock(lock, { staleMs: 3 * 3600_000, waitMs: 10_000, pollMs: 5 }, async () => {
        active++;
        maxHolders = Math.max(maxHolders, active);
        await new Promise((r) => setTimeout(r, holdMs));
        active--;
      });
    const results = await Promise.allSettled(Array.from({ length: contenders }, holder));
    for (const r of results) if (r.status === "rejected") errors.push(String((r.reason as NodeJS.ErrnoException).code ?? r.reason));
  }
  return { errors, maxHolders };
}

describe("withFileLock under contention", () => {
  // On Windows, open(lock, "wx") racing a holder's rm(lock) fails with EPERM (file in delete-pending state),
  // which withFileLock rethrows instead of treating as "busy". Measured here: ~55% of 6-way contentions
  // (~5-10% of 3-way ones). For appendUploadRecord this means: video uploaded, history append throws.
  (isWindows ? it : it.skip)("FIXED (Windows): a waiting contender crashes with EPERM instead of waiting its turn", async () => {
    const { errors } = await contend(40, 6, false);
    expect(errors).toEqual([]);
  }, 60_000);

  // Stale takeover is check-then-act: two waiters both see the old lock as stale; the second one's
  // rm() deletes the FIRST waiter's fresh lock, and both enter the critical section (cap check + upload).
  // The release path has the same flaw: rm() in `finally` removes whoever's lock is there now.
  // Measured: two simultaneous holders in ~7% of 6-way contentions on a stale lock (EPERM errors ignored here).
  (isWindows ? it : it.skip)("FIXED: stale-lock takeover lets two holders into the critical section at once", async () => {
    const { maxHolders } = await contend(100, 6, true);
    expect(maxHolders).toBe(1);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
// Publishability: verdicts are trusted without being bound to the content they judged
// ---------------------------------------------------------------------------------------------

describe("publishBlockers binds verdicts to content", () => {
  const base: RunContext = {
    runId: "20261003-120000-qa02", runDir: "C:\\x", createdAt: "2026-10-03T12:00:00Z",
    script: { title: "Roteiro NOVO gerado depois da checagem", hook: "h", scenes: [], cta: "c", language: "pt-BR" },
    factCheck: {
      verdict: "corrected", rounds: 2, claimsChecked: 4, claims: [], corrections: ["x"], sources: [{ uri: "https://nasa.gov" }],
      searchQueries: ["q"], titleBefore: "Roteiro antigo", titleAfter: "Roteiro antigo (corrigido)",
    },
    quality: { passingScenes: 5, totalScenes: 5, passingRatio: 1, minPassingSceneRatio: 0.6, minScore: 6, verdict: "pass" },
  };

  // `npm run stage -- 02-generateScript --run X` rewrites ctx.script but keeps the old factCheck (02b is
  // "done"), footage and quality; resume then renders and uploads an UNCHECKED script.
  it("FIXED: a fact-check verdict for a different script still unlocks the upload", () => {
    expect(publishBlockers(base, { allowWithoutFactCheck: false })).not.toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 07 metadata: verbatim context and CC BY credits
// ---------------------------------------------------------------------------------------------

describe("verbatimContext", () => {
  const script: Pick<Script, "hook" | "scenes"> = {
    hook: "Você já ouviu que a Muralha da China aparece do espaço?",
    scenes: [{ narration: "Não é verdade que a Muralha da China é visível a olho nu da órbita da Terra. Ela é estreita demais.", footageQuery: "great wall" }],
  };

  it("control: a full sentence of the narration is kept, an invented one is dropped", () => {
    expect(verbatimContext(["Ela é estreita demais.", "A muralha brilha à noite."], script)).toBe("Ela é estreita demais.");
  });

  // Substring check, not sentence check: a fragment that drops the negation states the myth as fact.
  it("FIXED: a fragment cut out of a sentence (dropping 'Não é verdade que') passes as 'verbatim'", () => {
    expect(verbatimContext(["a Muralha da China é visível a olho nu da órbita da Terra."], script)).toBe("");
  });
});

describe("CC BY credits", () => {
  const ccby = (over: Partial<FootageClip>): FootageClip => ({
    sceneIndex: 0, path: "C:\\x\\0_0.mp4", kind: "video", durationSeconds: 5, width: 1080, height: 1920, source: "wikimedia",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Lava.webm", creator: "Ana Souza", license: "CC BY 3.0",
    licenseUrl: "https://creativecommons.org/licenses/by/3.0/", ...over,
  });

  it("control: author, license, license URL and source link are all present", () => {
    const credits = buildCredits([ccby({})]);
    expect(credits).toContain("Ana Souza");
    expect(credits).toContain("https://creativecommons.org/licenses/by/3.0/");
    expect(credits).toContain("https://commons.wikimedia.org/wiki/File:Lava.webm");
  });

  // CC BY 4.0 s.3(a)(1)(B) / CC BY 3.0 s.4(b): the clips are cropped to 9:16, trimmed and re-encoded,
  // so the credit must say the material was modified.
  it("FIXED: CC BY credits never indicate that the clip was modified (cropped/trimmed)", () => {
    expect(buildCredits([ccby({})])).toMatch(/modific|editad|recortad|adaptad/i);
  });

  // Seen in a real run: Commons "Artist" came back as the uploader's channel URL.
  it("FIXED: a creator given as a bare URL is printed as the author's name", () => {
    const credits = buildCredits([ccby({ creator: "https://www.youtube.com/user/Editor" })]);
    expect(credits).not.toMatch(/^• https?:\/\//m);
  });
});

// ---------------------------------------------------------------------------------------------
// 02 topic repetition guard
// ---------------------------------------------------------------------------------------------

describe("recentTopics", () => {
  it("control: a rephrased repeat is caught", () => {
    expect(findSimilarSubject("Por que o dia em Vênus dura mais que o ano?", [{ title: "Em Vênus, o dia dura mais do que o ano", at: "2026-10-01T00:00:00Z", source: "uploaded" }])).toBeDefined();
  });

  // Generic two-word phrases ("Sistema Solar", "Império Romano", "Grande Muralha") plus one adjective
  // make different subjects collide; two collisions reject the whole attempt (new topic, more LLM spend).
  it("FIXED: 'maior lua do Sistema Solar' (Ganimedes) is flagged as a repeat of 'maior planeta do Sistema Solar' (Júpiter)", () => {
    expect(findSimilarSubject("A maior lua do Sistema Solar", [{ title: "O maior planeta do Sistema Solar", at: "2026-10-01T00:00:00Z", source: "uploaded" }])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------------------------

describe("redactSecrets coverage", () => {
  it("control: query keys and Bearer tokens are masked", () => {
    const out = redactSecrets("GET https://x/api?q=1&key=AIzaFAKE123456 Authorization: Bearer ya29.FAKEaccess-token_123");
    expect(out).not.toMatch(/AIzaFAKE|ya29\.FAKE/);
  });

  // OAuth client secret / refresh token live in files, not env vars, so literal masking never covers them.
  // No current code path logs them; these document the gap for any future error that echoes a token body.
  it("FIXED: refresh_token/client_secret inside a JSON body are not masked", () => {
    const out = redactSecrets('{"client_secret":"GOCSPX-FAKEsecret123","refresh_token":"1//0gFAKErefresh"}', {});
    expect(out).not.toMatch(/GOCSPX-FAKE|1\/\/0gFAKE/);
  });

  it("FIXED: the first parameter of a form-encoded token request body is not masked", () => {
    expect(redactSecrets("client_secret=GOCSPX-FAKEsecret123&grant_type=refresh_token", {})).not.toContain("GOCSPX-FAKE");
  });
});

// ---------------------------------------------------------------------------------------------
// NASA provenance rule (Python adapter, pure functions)
// ---------------------------------------------------------------------------------------------

function nasaRejections(cases: { center: string; photographer?: string; secondary_creator?: string; description?: string }[]): (string | null)[] {
  const code = [
    "import json, sys",
    "sys.path.insert(0, 'vendor/openmontage_adapter')",
    "import fetch_footage as f",
    "class C: pass",
    "out = []",
    "for m in json.loads(sys.stdin.read()):",
    "    c = C(); c.source = 'nasa'; c.creator = ''; c.source_tags = ''",
    "    c.extra = {'nasa_meta': {'title': 't', **m}}",
    "    out.append(f.nasa_provenance_rejection(f._candidate_provenance(c)))",
    "print(json.dumps(out))",
  ].join("\n");
  const stdout = execFileSync(PYTHON, ["-X", "utf8", "-c", code], { cwd: paths.root, input: JSON.stringify(cases), encoding: "utf8", windowsHide: true });
  return JSON.parse(stdout) as (string | null)[];
}

describe.skipIf(!hasVenv)("NASA credit rule after the H4 fix", () => {
  it("control: NASA staff credits pass; SpaceX, ESA, Getty, Roscosmos are rejected", () => {
    const r = nasaRejections([
      { center: "HQ", photographer: "Joel Kowsky" },
      { center: "KSC", photographer: "SpaceX" },
      { center: "JSC", secondary_creator: "ESA/A. Gerst" },
      { center: "JPL", photographer: "Getty Images" },
      { center: "HQ", description: "Photo Credit: SpaceX" },
    ]);
    expect(r.map((x) => x === null)).toEqual([true, false, false, false, false]);
  });

  // Every NASA item has a centre, so "bare name after a NASA centre" accepts ANY 2-4 capitalised words in
  // photographer/secondary_creator: independent photographers (Ben Cooper), citizen processors whose work
  // is CC BY / CC BY-NC (Kevin M. Gill, Seán Doran) and companies missing from _ORG_WORDS.
  it("non-NASA people and companies in photographer/secondary_creator are rejected (N1)", () => {
    const r = nasaRejections([
      { center: "KSC", photographer: "Ben Cooper" },
      { center: "JPL", secondary_creator: "Kevin M. Gill" },
      { center: "JPL", secondary_creator: "Seán Doran" },
      { center: "HQ", photographer: "Maxar Technologies" },
      { center: "JSC", secondary_creator: "Intuitive Machines" },
      { center: "GSFC", secondary_creator: "Planet Labs" },
    ]);
    expect(r.every((x) => x !== null)).toBe(true);
  });

  it("credit lines without a 'credit/courtesy/by' marker are parsed too ('Image: SpaceX', '(Photo: Getty Images)') (N7)", () => {
    const r = nasaRejections([
      { center: "HQ", description: "Falcon 9 lifts off. Image: SpaceX" },
      { center: "HQ", description: "Launch day (Photo: Getty Images)" },
    ]);
    expect(r.every((x) => x !== null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// childEnv on Windows: the children still work with the minimal environment
// ---------------------------------------------------------------------------------------------

describe.skipIf(!hasVenv)("minimalChildEnv keeps the real children working", () => {
  it("python (venv) imports the TTS/footage deps, builds a TLS context and resolves temp/home dirs", () => {
    const code = [
      "import ssl, tempfile, pathlib, json, sys",
      "import aiohttp, edge_tts, requests, certifi",
      "sys.path.insert(0, 'vendor/openmontage_adapter')",
      "import fetch_footage",
      "ctx = ssl.create_default_context()",
      "print(json.dumps({'tmp': tempfile.gettempdir(), 'home': str(pathlib.Path.home()), 'certs': ctx.cert_store_stats()['x509_ca'] >= 0}))",
    ].join("\n");
    const out = JSON.parse(execFileSync(PYTHON, ["-X", "utf8", "-c", code], { cwd: paths.root, env: minimalChildEnv(), encoding: "utf8", windowsHide: true })) as {
      tmp: string;
      home: string;
      certs: boolean;
    };
    expect(out.certs).toBe(true);
    expect(out.tmp.toLowerCase()).not.toContain("windows\\temp"); // TEMP/TMP passed through, not the system fallback
    expect(out.home.length).toBeGreaterThan(3);
  });

  it("synthesize.py --help runs under the minimal env and advertises --deadline-seconds", async () => {
    expect(await scriptSupportsFlag("python/tts/synthesize.py", "--deadline-seconds")).toBe(true);
  });

  it("Remotion's ffprobe runs under the minimal env", () => {
    const { ffprobe, dir } = resolveFfmpegBinaries();
    const out = execFileSync(ffprobe, ["-version"], { cwd: dir, env: minimalChildEnv(), encoding: "utf8", windowsHide: true });
    expect(out).toMatch(/ffprobe version/);
  });
});
