import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { UploadRecord } from "../../src/shared/history.js";
import { minimalChildEnv } from "../../src/orchestrator/lib/childEnv.js";
import { withFileLock } from "../../src/orchestrator/lib/fileLock.js";
import type { Logger } from "../../src/orchestrator/lib/logger.js";
import { contentTokens, findSimilarSubject, titleSimilarity } from "../../src/orchestrator/lib/recentTopics.js";
import { redactDeep, redactSecrets } from "../../src/orchestrator/lib/redact.js";
import { pruneRuns, retentionAction, type RetentionSettings } from "../../src/orchestrator/lib/retention.js";
import { readHistoryRecords, updateUploadRecord, appendUploadRecord } from "../../src/orchestrator/lib/uploadHistory.js";
import { assertNotRejected, STAGES } from "../../src/orchestrator/runPipeline.js";
import { buildScriptPrompt, recentSubjectsInstructions } from "../../src/orchestrator/stages/02-generateScript.js";
import {
  buildCredits,
  DESCRIPTION_MAX,
  fitDescription,
  verbatimContext,
} from "../../src/orchestrator/stages/07-generateMetadata.js";
import { JOURNAL_FILE, publishBlockers, uploadRun, type UploadDeps, type YouTubeUploader } from "../../src/orchestrator/stages/08-uploadYouTube.js";
import type { FootageClip, RunContext, Script } from "../../src/orchestrator/types.js";

const NOW = new Date("2026-10-03T12:00:00Z");
const silentLog: Logger = { filePath: "", debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

// ---------------------------------------------------------------------------------------------
// H5 redaction
// ---------------------------------------------------------------------------------------------

describe("redactSecrets", () => {
  const env = { GEMINI_API_KEY: "AIzaSyFAKE-gemini-key-1234567890", PEXELS_API_KEY: "short" } as NodeJS.ProcessEnv;

  it.each([
    ["https://pixabay.com/api/videos/?key=ABC123SECRET&q=lava", "https://pixabay.com/api/videos/?key=***&q=lava"],
    ["GET /x?q=1&api_key=zzz999 failed", "GET /x?q=1&api_key=*** failed"],
    ["?apikey=a1&token=t2&access_token=t3&client_secret=c4", "?apikey=***&token=***&access_token=***&client_secret=***"],
    ['"url": "https://h/?KEY=UPPER"', '"url": "https://h/?KEY=***"'],
    ["Authorization: Bearer ya29.a0AfH6SM-xyz_123", "Authorization: Bearer ***"],
  ])("masks %s", (input, expected) => {
    expect(redactSecrets(input, env)).toBe(expected);
  });

  it("masks literal values of known secret env vars, but not short values", () => {
    expect(redactSecrets("error with AIzaSyFAKE-gemini-key-1234567890 inside", env)).toBe("error with *** inside");
    expect(redactSecrets("a short word", env)).toBe("a short word");
  });

  it("leaves ordinary URLs and text alone", () => {
    expect(redactSecrets("https://commons.wikimedia.org/wiki/File:X.jpg?page=2", env)).toBe("https://commons.wikimedia.org/wiki/File:X.jpg?page=2");
  });

  it("redacts nested adapter payloads", () => {
    const out = redactDeep({ errors: [{ message: "for url: https://p/?key=SEKRET" }], n: 3 }, env);
    expect(out).toEqual({ errors: [{ message: "for url: https://p/?key=***" }], n: 3 });
  });
});

describe("minimalChildEnv", () => {
  const env = { PATH: "C:\\bin", SystemRoot: "C:\\Windows", GEMINI_API_KEY: "g", PEXELS_API_KEY: "p", TEMP: "C:\\t", EMPTY: "" } as NodeJS.ProcessEnv;

  it("keeps OS basics, forces UTF-8 and withholds secrets", () => {
    const out = minimalChildEnv([], env);
    expect(out).toMatchObject({ PATH: "C:\\bin", SystemRoot: "C:\\Windows", TEMP: "C:\\t", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" });
    expect(out.GEMINI_API_KEY).toBeUndefined();
    expect(out.PEXELS_API_KEY).toBeUndefined();
  });

  it("passes only the requested keys", () => {
    const out = minimalChildEnv(["PEXELS_API_KEY"], env);
    expect(out.PEXELS_API_KEY).toBe("p");
    expect(out.GEMINI_API_KEY).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// H1 / H2 upload hardening (beyond the QA regression tests)
// ---------------------------------------------------------------------------------------------

function publishable(over: Partial<RunContext> = {}): RunContext {
  const dir = mkdtempSync(join(tmpdir(), "h-run-"));
  writeFileSync(join(dir, "final.mp4"), "mp4");
  return {
    runId: "20261003-120000-hard", runDir: dir, createdAt: NOW.toISOString(),
    topic: { categoryId: "espaco", categoryLabel: "Espaço", seedPrompt: "p" },
    render: { videoPath: join(dir, "final.mp4"), durationSeconds: 50, width: 1080, height: 1920 },
    metadata: { title: "T #Shorts", description: "d", tags: [], categoryId: "27", defaultLanguage: "pt-BR", defaultAudioLanguage: "pt-BR" },
    factCheck: { verdict: "corrected", rounds: 2, claimsChecked: 3, claims: [], corrections: [], sources: [], searchQueries: [] },
    quality: { passingScenes: 4, totalScenes: 5, passingRatio: 0.8, minPassingSceneRatio: 0.6, minScore: 6, verdict: "pass" },
    ...over,
  };
}

describe("publishBlockers", () => {
  it("accepts pass/corrected fact-checks with a passing quality gate", () => {
    expect(publishBlockers(publishable(), {})).toEqual([]);
  });

  it("requires explicit allowWithoutFactCheck for skipped fact-checks", () => {
    const ctx = publishable({ factCheck: { verdict: "skipped", rounds: 0, claimsChecked: 0, claims: [], corrections: [], sources: [], searchQueries: [] } });
    expect(publishBlockers(ctx, {})).toHaveLength(1);
    expect(publishBlockers(ctx, { allowWithoutFactCheck: true })).toEqual([]);
  });

  it("blocks missing verdicts and rejections", () => {
    expect(publishBlockers(publishable({ factCheck: undefined, quality: undefined, rejection: { stage: "04-synthesizeVoice", reason: "x" } }), {})).toHaveLength(3);
  });
});

describe("uploadRun journal", () => {
  const settings = { enabled: true, privacyStatus: "unlisted" as const, categoryId: "27", maxUploadsPerDay: 5, containsSyntheticMedia: false };

  function world() {
    const history: UploadRecord[] = [];
    const sessions: (string | undefined)[] = [];
    const uploader: YouTubeUploader = {
      upload: async (_f, _r, _p, session) => {
        sessions.push(session?.sessionUri);
        await session?.onSession("https://upload/session-1");
        return { id: "vid1" };
      },
      getPrivacyStatus: async () => "unlisted",
      close: async () => undefined,
    };
    const deps: UploadDeps = {
      createUploader: async () => uploader,
      readHistory: async () => [...history],
      appendHistory: async (r) => (history.push(r), {}),
      now: () => NOW,
    };
    return { deps, history, sessions };
  }

  it("persists the session URI before uploading and the video id right after", async () => {
    const w = world();
    const ctx = publishable();
    await uploadRun(ctx, settings, w.deps, silentLog);
    const journal = JSON.parse(readFileSync(join(ctx.runDir, JOURNAL_FILE), "utf8")) as Record<string, unknown>;
    expect(journal).toMatchObject({ status: "uploaded", videoId: "vid1", sessionUri: "https://upload/session-1" });
  });

  it("a pending journal resumes its session instead of starting a new upload", async () => {
    const w = world();
    const ctx = publishable();
    writeFileSync(join(ctx.runDir, JOURNAL_FILE), JSON.stringify({ runId: ctx.runId, status: "pending", startedAt: NOW.toISOString(), requestedPrivacyStatus: "unlisted", sessionUri: "https://upload/old" }));
    await uploadRun(ctx, settings, w.deps, silentLog);
    expect(w.sessions).toEqual(["https://upload/old"]);
  });

  it("refuses to continue a rejected run", () => {
    expect(() => assertNotRejected(publishable({ rejection: { stage: "02b-factCheck", reason: "x" } }))).toThrow(/cannot be resumed/);
  });

  it("02b is not done for a failed check, done for pass, done for legacy runs with footage", () => {
    const stage = STAGES.find((s) => s.name === "02b-factCheck");
    const fc = (verdict: "pass" | "fail") => ({ verdict, rounds: 1, claimsChecked: 1, claims: [], corrections: [], sources: [], searchQueries: [] });
    expect(stage?.isDone(publishable({ factCheck: fc("fail") }))).toBe(false);
    expect(stage?.isDone(publishable({ factCheck: fc("pass") }))).toBe(true);
    expect(stage?.isDone(publishable({ factCheck: undefined, footage: [{} as FootageClip] }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// M1 history
// ---------------------------------------------------------------------------------------------

describe("history fail-closed and locking", () => {
  const rec = (runId: string): UploadRecord => ({
    runId, videoId: `v-${runId}`, title: "t", publishedAt: NOW.toISOString(), privacyStatus: "unknown",
    requestedPrivacyStatus: "public", categoryId: "27", topicCategoryId: "espaco",
  });

  it("missing history is empty; invalid entries throw", async () => {
    const dir = mkdtempSync(join(tmpdir(), "h-hist-"));
    expect(await readHistoryRecords(join(dir, "none.json"))).toEqual([]);
    const file = join(dir, "history.json");
    writeFileSync(file, JSON.stringify([rec("a"), { runId: "broken" }]));
    await expect(readHistoryRecords(file)).rejects.toThrow(/blocked/);
  });

  it("accepts privacy 'unknown' and updates a record in place", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "h-hist-")), "history.json");
    await appendUploadRecord(rec("a"), file);
    expect(await updateUploadRecord("a", { privacyStatus: "private" }, file)).toBe(true);
    expect((await readHistoryRecords(file))[0]?.privacyStatus).toBe("private");
  });

  it("serialises holders and takes over a stale lock", async () => {
    const lock = join(mkdtempSync(join(tmpdir(), "h-lock-")), "x.lock");
    const order: string[] = [];
    await Promise.all([
      withFileLock(lock, { staleMs: 60_000, waitMs: 5_000, pollMs: 5 }, async () => (order.push("a+"), await new Promise((r) => setTimeout(r, 30)), order.push("a-"))),
      withFileLock(lock, { staleMs: 60_000, waitMs: 5_000, pollMs: 5 }, async () => (order.push("b+"), order.push("b-"))),
    ]);
    expect([order.slice(0, 2), order.slice(2)].every(([s, e]) => s?.[0] === e?.[0])).toBe(true);
    writeFileSync(lock, "{}");
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    expect(await withFileLock(lock, { staleMs: 60_000, waitMs: 1_000 }, async () => "ran")).toBe("ran");
    expect(existsSync(lock)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// H3 + LOW metadata
// ---------------------------------------------------------------------------------------------

const script: Script = {
  title: "A chave do armário de binóculos do Titanic",
  hook: "Uma chave esquecida virou lenda no Titanic.",
  scenes: [
    { narration: "O segundo oficial foi dispensado às pressas. Ele levou a chave no bolso.", footageQuery: "antique key" },
    { narration: "Os vigias ficaram sem binóculos no ninho de corvo.", footageQuery: "old binoculars" },
  ],
  cta: "Siga o canal!",
  language: "pt-BR",
};

describe("verbatimContext", () => {
  it("keeps only sentences copied from the fact-checked narration", () => {
    expect(verbatimContext(["Ele levou a chave no bolso.", "A chave valia milhões."], script)).toBe("Ele levou a chave no bolso.");
  });

  it("tolerates spacing/case differences but not edits", () => {
    expect(verbatimContext("os  vigias ficaram sem binóculos no ninho de corvo.", script)).toBe("os  vigias ficaram sem binóculos no ninho de corvo.");
    expect(verbatimContext("Os vigias ficaram sem binóculo algum.", script)).toBe("");
  });
});

describe("credits and description fitting", () => {
  const ccby = (i: number, creator = `Autor ${i}`): FootageClip => ({
    sceneIndex: i, path: `C:/x/${i}.jpg`, kind: "image", durationSeconds: 0, width: 1, height: 1,
    source: "wikimedia", sourceUrl: `https://commons.wikimedia.org/wiki/File:${"x".repeat(60)}_${i}.jpg`, creator,
    license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  });

  it("includes the license URL in CC BY lines", () => {
    expect(buildCredits([ccby(1)])).toContain("CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)");
  });

  it("compacts same-creator credits but never drops a file", () => {
    const footage = Array.from({ length: 40 }, (_, i) => ccby(i, "Mesmo Autor"));
    const description = fitDescription({ hook: "h", context: "c".repeat(3000), hashtags: ["#a"] }, footage);
    expect(description.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    for (const c of footage) expect(description).toContain(c.sourceUrl);
  });

  it("throws when even compact credits cannot fit", () => {
    const footage = Array.from({ length: 80 }, (_, i) => ccby(i));
    expect(() => fitDescription({ hook: "h", context: "", hashtags: [] }, footage)).toThrow(/exceed/);
  });
});

// ---------------------------------------------------------------------------------------------
// EXTRA topic repetition
// ---------------------------------------------------------------------------------------------

describe("topic repetition guard", () => {
  const recent = [
    { title: "Por que os homens usavam salto alto na guerra?", at: NOW.toISOString(), source: "uploaded" as const },
    { title: "A tempestade de Júpiter onde caberia a Terra", at: NOW.toISOString(), source: "generated" as const },
  ];

  it("normalizes accents, stopwords and plurals", () => {
    expect([...contentTokens("Os Saltos Altos da Guerra #Shorts")].sort()).toEqual(["alto", "guerra", "salto"]);
  });

  it("flags a rephrased repeat", () => {
    expect(findSimilarSubject("O salto alto nasceu na guerra, não na moda", recent)?.title).toBe(recent[0]?.title);
    expect(titleSimilarity("Salto alto na guerra", "Saltos altos e guerras").score).toBe(1);
  });

  it("does not flag different subjects that share one word", () => {
    expect(findSimilarSubject("A guerra mais curta da história durou 38 minutos", recent)).toBeUndefined();
    expect(findSimilarSubject("Os anéis de Saturno estão desaparecendo", recent)).toBeUndefined();
  });

  it("lists recent subjects in the script prompt", () => {
    const prompt = buildScriptPrompt({ categoryId: "h", categoryLabel: "História", seedPrompt: "p" }, [], undefined, "NASA", recent.map((r) => r.title));
    expect(prompt).toContain(recentSubjectsInstructions([recent[0]?.title ?? ""]).trim().split("\n")[0]);
    expect(prompt).toContain("- Por que os homens usavam salto alto na guerra?");
  });
});

// ---------------------------------------------------------------------------------------------
// LOW retention
// ---------------------------------------------------------------------------------------------

describe("retention", () => {
  const settings: RetentionSettings = { keepFailedRunsDays: 3, keepUploadedVideosDays: 14 };
  const daysAgo = (d: number): Date => new Date(NOW.getTime() - d * 86_400_000);
  const base = (createdDaysAgo: number, over: Partial<RunContext> = {}): RunContext => ({
    runId: "x", runDir: "x", createdAt: daysAgo(createdDaysAgo).toISOString(), ...over,
  });
  const rendered = { render: { videoPath: "v", durationSeconds: 1, width: 1, height: 1 } };

  it.each([
    ["fresh failed run", base(1, { rejection: { stage: "02b-factCheck", reason: "x" } }), "keep"],
    ["old failed run", base(5, { rejection: { stage: "02b-factCheck", reason: "x" } }), "delete-run"],
    ["old crashed run (no render)", base(5), "delete-run"],
    ["old rendered, never uploaded", base(30, rendered), "keep"],
    ["recently uploaded", base(20, { ...rendered, upload: { status: "uploaded", requestedPrivacyStatus: "public", uploadedAt: daysAgo(2).toISOString() } }), "keep"],
    ["uploaded long ago", base(20, { ...rendered, upload: { status: "uploaded", requestedPrivacyStatus: "public", uploadedAt: daysAgo(15).toISOString() } }), "trim-uploaded"],
  ] as const)("%s -> %s", (_label, ctx, expected) => {
    expect(retentionAction(ctx, daysAgo(10), NOW, settings)).toBe(expected);
  });

  it("recent activity protects an old run", () => {
    expect(retentionAction(base(10), daysAgo(1), NOW, settings)).toBe("keep");
  });

  it("prunes a render_output folder: deletes old failures, trims old uploads, skips non-run dirs", async () => {
    const root = mkdtempSync(join(tmpdir(), "h-ro-"));
    const make = (id: string, ctx: RunContext, files: string[] = []) => {
      mkdirSync(join(root, id, "footage"), { recursive: true });
      writeFileSync(join(root, id, "context.json"), JSON.stringify(ctx));
      for (const f of files) writeFileSync(join(root, id, f), "x");
      const old = daysAgo(20);
      for (const p of [join(root, id, "context.json"), join(root, id, "footage"), ...files.map((f) => join(root, id, f)), join(root, id)]) utimesSync(p, old, old);
    };
    make("20260901-120000-aaaa", base(20, { rejection: { stage: "03-fetchFootage", reason: "x" } }));
    make("20260901-120000-bbbb", base(20, { ...rendered, upload: { status: "uploaded", requestedPrivacyStatus: "public", uploadedAt: daysAgo(20).toISOString() } }), ["final.mp4"]);
    make("20260901-120000-cccc", base(20, rendered), ["final.mp4"]);
    mkdirSync(join(root, "previews"));
    const summary = await pruneRuns(settings, { root, now: NOW });
    expect(summary).toEqual({ deletedRuns: ["20260901-120000-aaaa"], trimmedRuns: ["20260901-120000-bbbb"], errors: [] });
    expect(existsSync(join(root, "20260901-120000-bbbb", "context.json"))).toBe(true);
    expect(existsSync(join(root, "20260901-120000-bbbb", "final.mp4"))).toBe(false);
    expect(existsSync(join(root, "20260901-120000-cccc", "final.mp4"))).toBe(true);
    expect(existsSync(join(root, "previews"))).toBe(true);
  });
});
