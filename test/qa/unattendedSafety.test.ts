// QA (Quinn): regression tests for unattended-publishing hazards found in review.
//
// Tests named "FIXED: ..." were `it.fails` bug demonstrations; the bugs are fixed and they now run as
// normal regression tests. Everything runs on fakes: no YouTube, no LLM, no network, no writes outside
// the OS temp dir.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { UploadRecord } from "../../src/shared/history.js";
import { resolveScript } from "../../src/shared/settings.js";
import type { Logger } from "../../src/orchestrator/lib/logger.js";
import { appendUploadRecord, readHistoryRecords } from "../../src/orchestrator/lib/uploadHistory.js";
import { resumableUpload, type FetchLike } from "../../src/orchestrator/lib/youtubeUpload.js";
import { annotateClip, assessQuality, selectSceneClips, type ScoredClip } from "../../src/orchestrator/lib/relevance.js";
import { STAGES } from "../../src/orchestrator/runPipeline.js";
import { factCheckScript, type FactCheckDeps, type FactCheckResult } from "../../src/orchestrator/stages/02b-factCheck.js";
import { formatAdapterError } from "../../src/orchestrator/stages/03-fetchFootage.js";
import { assembleMetadata } from "../../src/orchestrator/stages/07-generateMetadata.js";
import { uploadRun, type UploadDeps, type UploadSettings, type YouTubeUploader } from "../../src/orchestrator/stages/08-uploadYouTube.js";
import type { FootageClip, RunContext, Script } from "../../src/orchestrator/types.js";

const NOW = new Date("2026-10-03T12:00:00Z");
const SETTINGS: UploadSettings = { enabled: true, privacyStatus: "public", categoryId: "27", maxUploadsPerDay: 1, containsSyntheticMedia: false };

const silentLog: Logger = { filePath: "", debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

function record(runId: string, hoursAgo: number): UploadRecord {
  return {
    runId, videoId: `v-${runId}`, title: "t", publishedAt: new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString(),
    privacyStatus: "public", requestedPrivacyStatus: "public", categoryId: "27", topicCategoryId: "espaco",
  };
}

function renderedRun(over: Partial<RunContext> = {}): RunContext {
  const dir = mkdtempSync(join(tmpdir(), "qa-run-"));
  const videoPath = join(dir, "final.mp4");
  writeFileSync(videoPath, "mp4");
  return {
    runId: "20261003-120000-qa01", runDir: dir, createdAt: NOW.toISOString(),
    topic: { categoryId: "espaco", categoryLabel: "Espaço", seedPrompt: "p" },
    render: { videoPath, durationSeconds: 50, width: 1080, height: 1920 },
    metadata: { title: "Vênus #Shorts", description: "d", tags: ["venus"], categoryId: "27", defaultLanguage: "pt-BR", defaultAudioLanguage: "pt-BR" },
    factCheck: { verdict: "pass", rounds: 1, claimsChecked: 3, claims: [], corrections: [], sources: [], searchQueries: [] },
    quality: { passingScenes: 5, totalScenes: 5, passingRatio: 1, minPassingSceneRatio: 0.6, minScore: 6, verdict: "pass" },
    ...over,
  };
}

/** In-memory YouTube + history. `history` is shared across calls like data/history.json would be. */
function fakeWorld(opts: { privacyFails?: boolean; appendFails?: boolean; history?: UploadRecord[] } = {}) {
  const history = opts.history ?? [];
  const uploads: string[] = [];
  const uploader: YouTubeUploader = {
    upload: async () => {
      const id = `yt${uploads.length + 1}`;
      uploads.push(id);
      return { id };
    },
    getPrivacyStatus: async () => {
      if (opts.privacyFails) throw new Error("videos.list: socket hang up");
      return "public";
    },
    close: async () => undefined,
  };
  const deps: UploadDeps = {
    createUploader: async () => uploader,
    readHistory: async () => [...history],
    appendHistory: async (r) => {
      if (opts.appendFails) throw new Error("EPERM: operation not permitted, rename 'history.json.tmp'");
      history.push(r);
      return {};
    },
    now: () => NOW,
  };
  return { deps, uploads, history };
}

// ---------------------------------------------------------------------------------------------
// 08-uploadYouTube
// ---------------------------------------------------------------------------------------------

describe("08-uploadYouTube: a video that reached YouTube must always be recorded", () => {
  it("FIXED: privacy lookup failing after a successful upload leads to a duplicate upload on retry", async () => {
    const world = fakeWorld({ privacyFails: true });
    const ctx = renderedRun();
    await uploadRun(ctx, SETTINGS, world.deps, silentLog).catch(() => undefined); // video yt1 is live now
    await uploadRun(ctx, SETTINGS, world.deps, silentLog).catch(() => undefined); // resume / npm run stage 08
    expect(world.uploads).toEqual(["yt1"]);
  });

  it("FIXED: history write failing after a successful upload leads to a duplicate upload on retry", async () => {
    const world = fakeWorld({ appendFails: true });
    const ctx = renderedRun();
    await uploadRun(ctx, SETTINGS, world.deps, silentLog).catch(() => undefined);
    await uploadRun(ctx, SETTINGS, { ...world.deps, appendHistory: async (r) => (world.history.push(r), {}) }, silentLog);
    expect(world.uploads).toHaveLength(1);
  });
});

describe("08-uploadYouTube: the upload stage must enforce the run's own quality verdicts", () => {
  it("control: a clean run is uploaded", async () => {
    const world = fakeWorld();
    const out = await uploadRun(renderedRun(), SETTINGS, world.deps, silentLog);
    expect(out.upload?.status).toBe("uploaded");
  });

  it("FIXED: uploads a run whose fact-check FAILED (reachable via --resume, see STAGES test below)", async () => {
    const world = fakeWorld();
    const ctx = renderedRun({
      factCheck: { verdict: "fail", rounds: 3, claimsChecked: 4, claims: [], corrections: [], sources: [], searchQueries: [], reason: "premissa falsa" },
      rejection: { stage: "02b-factCheck", reason: "Fact-check rejected the script" },
    });
    await uploadRun(ctx, SETTINGS, world.deps, silentLog).catch(() => undefined);
    expect(world.uploads).toHaveLength(0);
  });

  it("FIXED: uploads a run whose footage quality gate FAILED (reachable via npm run stage 06 + 08)", async () => {
    const world = fakeWorld();
    const ctx = renderedRun({
      quality: { passingScenes: 1, totalScenes: 6, passingRatio: 0.167, minPassingSceneRatio: 0.6, minScore: 6, verdict: "fail" },
    });
    await uploadRun(ctx, SETTINGS, world.deps, silentLog).catch(() => undefined);
    expect(world.uploads).toHaveLength(0);
  });

  it("FIXED: uploads a run whose footage was never vision-checked (relevance gate disabled -> verdict skipped)", async () => {
    const world = fakeWorld();
    const ctx = renderedRun({
      quality: { passingScenes: 0, totalScenes: 6, passingRatio: 0, minPassingSceneRatio: 0.6, minScore: 6, verdict: "skipped" },
    });
    await uploadRun(ctx, SETTINGS, world.deps, silentLog).catch(() => undefined);
    expect(world.uploads).toHaveLength(0);
  });
});

describe("daily cap and upload history", () => {
  it("FIXED: an unreadable data/history.json disables the daily cap and the duplicate check (fail-open)", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "qa-hist-")), "history.json");
    const full = JSON.stringify([record("a", 1), record("b", 2), record("c", 3)], null, 2);
    writeFileSync(file, full.slice(0, full.length - 40)); // truncated (crash mid-write, AV/OneDrive, manual edit)
    const world = fakeWorld();
    const deps: UploadDeps = { ...world.deps, readHistory: () => readHistoryRecords(file) };
    await uploadRun(renderedRun(), SETTINGS, deps, silentLog).catch(() => undefined);
    expect(world.uploads).toHaveLength(0); // 3 uploads in the last 24 h, cap is 1
  });

  it("FIXED: two concurrent appendUploadRecord calls lose a record (read-modify-write race, shared .tmp name)", async () => {
    for (let n = 0; n < 5; n++) {
      const file = join(mkdtempSync(join(tmpdir(), "qa-hist-")), "history.json");
      await Promise.allSettled([appendUploadRecord(record(`a${n}`, 1), file), appendUploadRecord(record(`b${n}`, 1), file)]);
      expect((JSON.parse(readFileSync(file, "utf8")) as unknown[]).length).toBe(2);
    }
  });
});

describe("resumableUpload retry budget", () => {
  it("FIXED: a session that keeps answering 308 without progress is re-uploaded forever (retries reset on every 308)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-up-"));
    const file = join(dir, "final.mp4");
    writeFileSync(file, Buffer.alloc(1000, 1));
    let puts = 0;
    const fetch: FetchLike = async (_url, init) => {
      if (init.method === "POST") return { status: 200, headers: { get: (n) => (n === "location" ? "https://upload/s" : null) }, text: async () => "" };
      puts++;
      if (puts > 200) throw new Error("test guard: still uploading after 200 PUTs");
      return { status: 308, headers: { get: () => null }, text: async () => "" }; // no Range: nothing persisted
    };
    await resumableUpload({ filePath: file, resource: {}, parts: ["snippet"], getAccessToken: async () => "t", fetch, chunkBytes: 1000, sleep: async () => undefined }).catch(
      () => undefined,
    );
    expect(puts).toBeLessThan(30);
  });
});

// ---------------------------------------------------------------------------------------------
// Fact-check bypasses
// ---------------------------------------------------------------------------------------------

const script: Script = {
  title: "O dia em Vênus é mais longo que o ano",
  hook: "Em Vênus, um único dia dura mais do que um ano inteiro.",
  scenes: Array.from({ length: 4 }, (_, i) => ({
    narration: `Cena ${i + 1}: Vênus gira tão devagar em torno do próprio eixo que o Sol demora meses para cruzar o céu de ponta a ponta, um fato curioso e verdadeiro.`,
    footageQuery: "venus planet nasa",
  })),
  cta: "Siga para mais curiosidades.",
  language: "pt-BR",
};

describe("02b-factCheck bypasses", () => {
  it("FIXED: --resume of a run REJECTED by the fact-check skips 02b (isDone only checks presence of ctx.factCheck)", () => {
    const stage = STAGES.find((s) => s.name === "02b-factCheck");
    const rejected = renderedRun({
      render: undefined, metadata: undefined, quality: undefined, script,
      factCheck: { verdict: "fail", rounds: 3, claimsChecked: 4, claims: [], corrections: [], sources: [], searchQueries: [], reason: "x" },
    });
    expect(stage?.isDone(rejected)).toBe(false);
  });

  it("FIXED: a structured result with ZERO claims is accepted as a verified 'pass'", async () => {
    const deps: FactCheckDeps = {
      grounded: async () => ({ text: "(busca falhou / resposta vazia de conteúdo)", sources: [], queries: [] }),
      structured: async () =>
        ({ claims: [], publishable: true, reason: "ok", title: script.title, hook: script.hook, scenes: script.scenes, changes: [] }) as FactCheckResult,
    };
    const { summary } = await factCheckScript(script, resolveScript(), deps);
    expect(summary.verdict).not.toBe("pass");
  });

  /** Every round flags one claim as "misleading" and rewrites the hook; records what the grounded check saw. */
  function rewritingDeps() {
    const reviewed: string[] = [];
    let round = 0;
    const deps: FactCheckDeps = {
      grounded: async (prompt) => (reviewed.push(prompt), { text: "[1] enganoso", sources: [{ uri: "https://nasa.gov" }], queries: ["q"] }),
      structured: async () => {
        round++;
        return {
          claims: [{ claim: "um dia dura mais que um ano", verdict: "misleading", correction: "o dia sideral" }],
          publishable: true, reason: "ajuste", title: script.title,
          hook: `${script.hook} Reescrita ${round} com um dado novo nunca checado.`, scenes: script.scenes, changes: [`rodada ${round}`],
        } as FactCheckResult;
      },
    };
    return { deps, reviewed };
  }

  it("control: three rounds of 'misleading' end as 'corrected' (accepted for publishing)", async () => {
    const { deps } = rewritingDeps();
    const { summary } = await factCheckScript(script, resolveScript(), deps);
    expect(summary).toMatchObject({ verdict: "corrected", rounds: 3 });
  });

  it("FIXED: the round-3 rewrite is published without ever going through the grounded (web) check", async () => {
    const { deps, reviewed } = rewritingDeps();
    const { script: published } = await factCheckScript(script, resolveScript(), deps);
    expect(reviewed.some((prompt) => prompt.includes(published.hook))).toBe(true);
  });
});

describe("07-generateMetadata: published text is not fact-checked", () => {
  it("FIXED: the published title comes from a fresh LLM draft (temperature 0.7), not the fact-checked title", () => {
    const meta = assembleMetadata({
      script,
      footage: [],
      draft: { title: "Cientistas CHOCADOS: Vênus vai explodir", context: "Contexto qualquer do vídeo.", hashtags: ["#a", "#b"], tags: ["a", "b", "c", "d", "e"] },
      categoryId: "27",
      language: "pt-BR",
    });
    expect(meta.title.startsWith(script.title)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Footage quality gate
// ---------------------------------------------------------------------------------------------

describe("03 quality gate: run-level pass count", () => {
  const clip = (sceneIndex: number): FootageClip => ({
    sceneIndex, path: `C:\\x\\${sceneIndex}_0.mp4`, kind: "video", durationSeconds: 8, width: 1080, height: 1920,
    source: "pexels", sourceUrl: `https://p/${sceneIndex}`, creator: "c", license: "Pexels License",
  });

  const relevance = { minScore: 6, keepPerScene: 2, fallbackMinScore: 4 };
  const selections = [0, 1, 2, 3, 4].map((sceneIndex) => {
    const scored: ScoredClip = {
      clip: clip(sceneIndex),
      verdict: { score: 8, matches: false, reason: "pretty galaxy, but the line is about Roman aqueducts", hasTextOrLogo: false, hasIdentifiablePeople: false },
    };
    return selectSceneClips(sceneIndex, [scored], relevance, true);
  });

  it("control: the scene-level selector classifies a non-matching clip as a weak fallback, not a pass", () => {
    expect(selections.map((s) => s.mode)).toEqual(["weak", "weak", "weak", "weak", "weak"]);
  });

  it("FIXED: a fallback clip the reviewer said does NOT match (matches=false, score 8) counts as a passing scene", () => {
    const footage = selections.map((s) => annotateClip(s.kept[0] as ScoredClip));
    const quality = assessQuality(footage, 5, { enabled: true, minScore: 6 }, 0.6);
    expect(quality.verdict).toBe("fail"); // currently "pass": 5/5 "passing" scenes, none of which match
  });
});

// ---------------------------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------------------------

describe("secrets never reach logs", () => {
  it("FIXED: footage adapter errors are logged verbatim, including the Pixabay API key from the request URL", () => {
    // Shape produced by OpenMontage DirectClipSearch for a Pixabay HTTP error (pixabay_video.py puts
    // the key in the query string; requests' HTTPError message embeds the full URL).
    const line = formatAdapterError({
      sceneIndex: 2, query: "volcano lava", source: "pixabay_video", phase: "search",
      message: "HTTPError: 429 Client Error: Too Many Requests for url: https://pixabay.com/api/videos/?key=FAKE-PIXABAY-KEY-123&q=volcano+lava&per_page=3",
    });
    expect(line).not.toContain("FAKE-PIXABAY-KEY-123");
  });
});
