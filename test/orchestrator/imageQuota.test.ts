import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import * as childProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { paths } from "../../src/orchestrator/lib/config.js";
import { generateIllustration, generateIllustrations } from "../../src/orchestrator/lib/illustrate.js";
import { generateImages, getImageProvider, type ImageProvider } from "../../src/orchestrator/lib/imageProvider.js";
import type { Logger } from "../../src/orchestrator/lib/logger.js";
import { looksLikeQuotaError, parseWaitMinutes, QuotaExhaustedError, quotaErrorFrom } from "../../src/orchestrator/lib/quota.js";
import { EXIT_QUOTA, runPipeline, STAGES } from "../../src/orchestrator/runPipeline.js";
import { RunRejectedError } from "../../src/orchestrator/lib/rejection.js";
import type { FootageClip, RunContext, Script } from "../../src/orchestrator/types.js";
import { resolveScript, ScriptSettingsSchema } from "../../src/shared/settings.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
// runPipeline prunes old runs of render_output at start: never let a test touch real ones.
vi.mock("../../src/orchestrator/lib/retention.js", async (original) => ({
  ...(await original<typeof import("../../src/orchestrator/lib/retention.js")>()),
  pruneRuns: async () => ({ deletedRuns: [], trimmedRuns: [], errors: [] }),
}));

const log: Logger = { filePath: "", debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

// Shaped like what agy printed on 2026-10-26 (JSON wrapper on stdout, or its answer text).
const AGY_QUOTA_JSON = JSON.stringify({
  status: "ERROR",
  error: "429 RESOURCE_EXHAUSTED: image generation quota exceeded for this plan. Quota will reset after 3h25m0s. key=AIzaFAKEfakefakefakefakefakefakefake0",
});
const AGY_QUOTA_ANSWER = JSON.stringify({
  status: "SUCCESS",
  response: "Não consegui gerar a imagem: a ferramenta respondeu 429 RESOURCE_EXHAUSTED. A cota de imagem foi esgotada e será redefinida em ~3h25.",
});

describe("quota detection in agy output", () => {
  it("recognizes the 2026-10-26 outputs and keeps the original text without secrets", () => {
    for (const text of [AGY_QUOTA_JSON, AGY_QUOTA_ANSWER, "Error: status 429 Too Many Requests", "HTTP/1.1 429 Too Many Requests", 'agy: {"code":429,"message":"x"}']) {
      expect(looksLikeQuotaError(text), text).toBe(true);
    }
    const err = quotaErrorFrom("agy", AGY_QUOTA_JSON)!;
    expect(err).toBeInstanceOf(QuotaExhaustedError);
    expect(err.message).toMatch(/RESOURCE_EXHAUSTED/);
    expect(err.message).not.toMatch(/AIzaFAKE/);
    expect(err.retryAfterMinutes).toBe(3 * 60 + 25);
    expect(Date.parse(err.resetAt!) - Date.now()).toBeGreaterThan(3 * 3600_000);
  });

  it("keeps the message to the quota sentence, without the rest of agy's JSON", () => {
    const raw =
      '{"status":"SUCCESS","response":"Erro 429 RESOURCE_EXHAUSTED: a cota de imagem esgotou. A cota tem previsão de reinício em aproximadamente 4 horas e 37 minutos.\\n","duration_seconds":25.43,"num_turns":1,"usage":{"input_tokens":32165}}';
    const err = quotaErrorFrom("agy", raw)!;
    expect(err.original).toMatch(/37 minutos\.$/);
    expect(err.original).not.toMatch(/duration_seconds|num_turns|usage/);
    expect(err.retryAfterMinutes).toBe(277);
    // plain text (stderr) keeps working
    expect(quotaErrorFrom("agy", "429 RESOURCE_EXHAUSTED: quota exceeded. Quota will reset after 3h25m0s.")!.original).toMatch(/3h25m0s\.$/);
  });

  it("does not take aspect ratios, timestamps, sizes or ordinary words for a quota", () => {
    for (const text of [
      "Imagem 9:16 gerada em /home/u/.gemini/antigravity-cli/brain/x/car.png",
      "2026-10-26T17:13:59.429Z agy iniciou",
      '{"at":"2026-10-26T17:13:59.429Z","status":"SUCCESS"}',
      "A imagem tem 1429 pixels de largura",
      "pedido 14290 concluído; código 4290",
      "Gere uma cota de pizza com 429 fatias",
      "the quota table of a medieval tax system",
      "",
    ]) {
      expect(looksLikeQuotaError(text), text).toBe(false);
      expect(quotaErrorFrom("agy", text)).toBeUndefined();
    }
  });

  it("reads the announced wait in several shapes, ignores the rest", () => {
    expect(parseWaitMinutes("cota de imagem redefinida em ~3h25")).toBe(205);
    expect(parseWaitMinutes("Quota will reset after 3h25m0s.")).toBe(205);
    expect(parseWaitMinutes("tente novamente em 40 minutos")).toBe(40);
    expect(parseWaitMinutes("resets in 2 hours")).toBe(120);
    // the two phrasings agy used (2026-10-26 and 2026-11-02)
    expect(parseWaitMinutes("A cota de imagem foi redefinida em aproximadamente 3 horas e 25 minutos.")).toBe(205);
    expect(parseWaitMinutes("A cota tem previsão de reinício em aproximadamente 4 horas e 37 minutos.")).toBe(277);
    expect(parseWaitMinutes("quota exceeded")).toBeUndefined();
    expect(parseWaitMinutes("redefinida em 99999 min")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// generateIllustration with a fake agy process
// ---------------------------------------------------------------------------------------------

function fakeAgy(stdout: string, stderr = "", exitCode = 0): void {
  vi.mocked(childProcess.spawn).mockImplementation(() => {
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = vi.fn();
    child.stdin.on("finish", () =>
      setTimeout(() => {
        child.stderr.write(stderr);
        child.stdout.write(stdout);
        child.emit("close", exitCode);
      }, 0),
    );
    return child;
  });
}

describe("generateIllustration (fake agy)", () => {
  const base = join(mkdtempSync(join(tmpdir(), "quota-test-")), "ia_00");

  it("throws QuotaExhaustedError for a quota in the answer (exit 0) and in stderr (exit 1)", async () => {
    fakeAgy(AGY_QUOTA_ANSWER);
    await expect(generateIllustration("a red car", base)).rejects.toBeInstanceOf(QuotaExhaustedError);
    fakeAgy("", "rpc error: code = ResourceExhausted desc = 429 RESOURCE_EXHAUSTED", 1);
    await expect(generateIllustration("a red car", base)).rejects.toBeInstanceOf(QuotaExhaustedError);
  });

  it("keeps ordinary failures as ordinary errors", async () => {
    fakeAgy(JSON.stringify({ status: "SUCCESS", response: "Pronto, imagem 9:16 criada, mas não sei onde salvei." }));
    const e1 = await generateIllustration("a red car", base).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(Error);
    expect(e1).not.toBeInstanceOf(QuotaExhaustedError);
    fakeAgy("", "panic: segmentation fault at 2026-10-26T17:13:59.429Z", 1);
    const e2 = await generateIllustration("a red car", base).catch((e: unknown) => e);
    expect(e2).not.toBeInstanceOf(QuotaExhaustedError);
    expect((e2 as Error).message).toMatch(/código 1/);
  });
});

// ---------------------------------------------------------------------------------------------
// Stage stop: no more images are asked for
// ---------------------------------------------------------------------------------------------

const queries = Array.from({ length: 8 }, (_, i) => ({ sceneIndex: i, query: `scene ${i}` }));
const probe = async () => ({ width: 768, height: 1376 });

describe("generateIllustrations stops at the quota", () => {
  it("asks for nothing after the quota, cancels the one in flight and returns the finished ones as partial", async () => {
    const asked: string[] = [];
    let cancelled = false;
    let quotaThrown!: () => void;
    const thrown = new Promise<void>((resolve) => (quotaThrown = resolve));
    const generate = async (scene: string, outBase: string, signal?: AbortSignal): Promise<string> => {
      asked.push(scene);
      if (scene === "scene 0") {
        await thrown; // finishes only after the quota was hit: still counted as partial
        return `${outBase}.jpg`;
      }
      if (scene === "scene 1") {
        quotaThrown();
        throw quotaErrorFrom("agy", AGY_QUOTA_ANSWER)!;
      }
      return new Promise((_, reject) => signal?.addEventListener("abort", () => ((cancelled = true), reject(new Error("cancelado")))));
    };
    const error = await generateIllustrations(queries, tmpdir(), log, { generate, probe }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QuotaExhaustedError);
    expect(asked).toEqual(["scene 0", "scene 1"]); // concurrency 2: the other 6 were never requested
    expect(cancelled).toBe(false); // nothing else was in flight here
    expect((error as QuotaExhaustedError).partial.map((c) => c.sceneIndex)).toEqual([0]);
  });

  it("kills a request in flight when another one reports the quota", async () => {
    let cancelled = false;
    const generate = async (scene: string, _outBase: string, signal?: AbortSignal): Promise<string> => {
      if (scene === "scene 1") throw quotaErrorFrom("agy", AGY_QUOTA_JSON)!;
      return new Promise((_, reject) => signal?.addEventListener("abort", () => ((cancelled = true), reject(new Error("cancelado")))));
    };
    const warnings: string[] = [];
    const logger: Logger = { ...log, warn: (m: string) => void warnings.push(m) };
    await expect(generateIllustrations(queries, tmpdir(), logger, { generate, probe })).rejects.toBeInstanceOf(QuotaExhaustedError);
    expect(cancelled).toBe(true);
    expect(warnings.join("\n")).not.toMatch(/quota|resource_exhausted|429/i); // loop.ps1 stops on these words
  });

  it("still skips an ordinary failed image and goes on", async () => {
    const generate = async (scene: string, outBase: string): Promise<string> => {
      if (scene === "scene 2") throw new Error("agy sem imagem");
      return `${outBase}.jpg`;
    };
    const clips = await generateIllustrations(queries, tmpdir(), log, { generate, probe });
    expect(clips.map((c) => c.sceneIndex)).toEqual([0, 1, 3, 4, 5, 6, 7]);
  });
});

// ---------------------------------------------------------------------------------------------
// Pluggable provider and configurable fallback
// ---------------------------------------------------------------------------------------------

const clip = (sceneIndex: number, over: Partial<FootageClip> = {}): FootageClip => ({
  sceneIndex, path: `/r/ia_${sceneIndex}.jpg`, kind: "image", durationSeconds: 5, width: 768, height: 1376,
  source: "ia-agy", sourceUrl: "", creator: "", license: "gerada por IA", ...over,
});
const stockClip = (sceneIndex: number): FootageClip => clip(sceneIndex, { source: "wikimedia", sourceUrl: `https://example.org/${sceneIndex}`, license: "CC0" });

function provider(generate: ImageProvider["generate"]): ImageProvider {
  return { name: "agy", generate };
}
const three = [0, 1, 2].map((i) => ({ sceneIndex: i, query: `scene ${i}` }));
const quotaWith = (partial: FootageClip[]): QuotaExhaustedError => Object.assign(quotaErrorFrom("agy", AGY_QUOTA_JSON)!, { partial });

describe("image provider and fallback", () => {
  it("fallback nenhum: the quota goes up and stock is never searched", async () => {
    const stock = vi.fn(async () => [stockClip(1)]);
    const p = provider(async () => { throw quotaWith([clip(0)]); });
    await expect(generateImages(p, three, "/out", log, "nenhum", stock)).rejects.toBeInstanceOf(QuotaExhaustedError);
    expect(stock).not.toHaveBeenCalled();
  });

  it("fallback acervo: keeps what was generated and searches stock only for the missing images", async () => {
    const stock = vi.fn(async (q: { sceneIndex: number }[]) => q.map((x) => stockClip(x.sceneIndex)));
    const p = provider(async () => { throw quotaWith([clip(0)]); });
    const warnings: string[] = [];
    const out = await generateImages(p, three, "/out", { ...log, warn: (m: string) => void warnings.push(m) }, "acervo", stock);
    expect(stock.mock.calls[0]![0]).toEqual([three[1], three[2]]);
    expect(out.usedStock).toBe(true);
    expect(out.clips.map((c) => `${c.sceneIndex}:${c.source}`)).toEqual(["0:ia-agy", "1:wikimedia", "2:wikimedia"]);
    expect(warnings.join("\n")).not.toMatch(/quota|resource_exhausted|429|credits/i); // the run did not fail: loop.ps1 must not stop
  });

  it("fallback acervo also covers a provider that fails outright, and does nothing when nothing is missing", async () => {
    const stock = vi.fn(async (q: { sceneIndex: number }[]) => q.map((x) => stockClip(x.sceneIndex)));
    const broken = provider(async () => { throw new Error("agy não encontrado"); });
    expect((await generateImages(broken, three, "/out", log, "acervo", stock)).clips).toHaveLength(3);
    expect(stock.mock.calls[0]![0]).toHaveLength(3);
    stock.mockClear();
    const complete = provider(async (q) => q.map((x) => clip(x.sceneIndex)));
    expect(await generateImages(complete, three, "/out", log, "acervo", stock)).toMatchObject({ usedStock: false });
    expect(stock).not.toHaveBeenCalled();
  });

  it("fallback nenhum with a few failed images just returns the rest (the quality gate decides)", async () => {
    const stock = vi.fn(async () => []);
    const p = provider(async () => [clip(0), clip(2)]);
    expect((await generateImages(p, three, "/out", log, "nenhum", stock)).clips).toHaveLength(2);
    expect(stock).not.toHaveBeenCalled();
  });

  it("old configs (no imageProvider/imageFallback) mean agy and stop; unknown values are refused", () => {
    expect(resolveScript({ imageSource: "ilustrado" })).toMatchObject({ imageProvider: "agy", imageFallback: "nenhum" });
    expect(resolveScript(undefined)).toMatchObject({ imageProvider: "agy", imageFallback: "nenhum" });
    expect(ScriptSettingsSchema.safeParse({ imageSource: "ilustrado" }).success).toBe(true);
    expect(ScriptSettingsSchema.safeParse({ imageProvider: "agy", imageFallback: "acervo" }).success).toBe(true);
    expect(ScriptSettingsSchema.safeParse({ imageFallback: "api" }).success).toBe(false); // never a paid API
    expect(ScriptSettingsSchema.safeParse({ imageProvider: "dalle" }).success).toBe(false);
    expect(getImageProvider(undefined).name).toBe("agy");
  });
});

// ---------------------------------------------------------------------------------------------
// runPipeline: a quota is not a reason to redo script and fact-check with a new topic
// ---------------------------------------------------------------------------------------------

const SCRIPT: Script = {
  title: "t", overlayText: "T", hook: "h", cta: "", language: "pt-BR",
  scenes: [{ narration: "n", footageQuery: "q" }],
};

describe("runPipeline and the quota", () => {
  const originalLoads = STAGES.map((s) => s.load);
  const originalPaths = { renderOutput: paths.renderOutput, logs: paths.logs };
  afterEach(() => {
    STAGES.forEach((s, i) => (s.load = originalLoads[i]!));
    Object.assign(paths, originalPaths);
  });

  function setup(footage: (ctx: RunContext) => Promise<RunContext>): { counts: Record<string, number>; renderOutput: string } {
    const tmp = mkdtempSync(join(tmpdir(), "pipeline-quota-"));
    Object.assign(paths, { renderOutput: join(tmp, "render_output"), logs: join(tmp, "logs") });
    const counts: Record<string, number> = { topic: 0, script: 0, factCheck: 0, footage: 0 };
    const fake = (key: string, fn: (ctx: RunContext) => Promise<RunContext>) => async () => async (ctx: RunContext) => ((counts[key]! += 1), fn(ctx));
    const byName = (name: string) => STAGES.find((s) => s.name === name)!;
    byName("01-pickTopic").load = fake("topic", async (ctx) => ({ ...ctx, topic: { categoryId: "c", categoryLabel: "C", seedPrompt: "s", format: "lista" } as RunContext["topic"] }));
    byName("02-generateScript").load = fake("script", async (ctx) => ({ ...ctx, script: SCRIPT }));
    byName("02b-factCheck").load = fake("factCheck", async (ctx) => ({ ...ctx, factCheck: { verdict: "pass", rounds: 1, claimsChecked: 0, claims: [], corrections: [], sources: [], searchQueries: [] } as unknown as RunContext["factCheck"] }));
    byName("03-fetchFootage").load = fake("footage", footage);
    return { counts, renderOutput: join(tmp, "render_output") };
  }

  it("stops at once: one attempt, script and fact-check made once, reason saved in context.json", async () => {
    const { counts, renderOutput } = setup(async () => { throw quotaWith([]); });
    const error = await runPipeline({ until: "03-fetchFootage" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QuotaExhaustedError);
    expect(counts).toEqual({ topic: 1, script: 1, factCheck: 1, footage: 1 });
    const runs = readdirSync(renderOutput);
    expect(runs).toHaveLength(1); // no new topic, no new run directory
    const saved = JSON.parse(readFileSync(join(renderOutput, runs[0]!, "context.json"), "utf8")) as RunContext;
    expect(saved.quota).toMatchObject({ stage: "03-fetchFootage", provider: "agy" });
    expect(saved.quota?.message).toMatch(/RESOURCE_EXHAUSTED/);
    expect(saved.quota?.message).not.toMatch(/AIzaFAKE/);
    expect(saved.quota?.resetAt).toBeTruthy();
    expect(saved.rejection).toBeUndefined();
    expect(saved.script).toBeTruthy(); // what the run already had is kept
    expect(EXIT_QUOTA).toBe(4);
    expect(existsSync(join(renderOutput, runs[0]!, "context.json"))).toBe(true);
  });

  it("a configuration rejection (no search for the fact-check) stops without another topic", async () => {
    const { counts, renderOutput } = setup(async (ctx) => ctx);
    STAGES.find((s) => s.name === "02b-factCheck")!.load = async () => async (ctx) => {
      counts.factCheck! += 1;
      throw new RunRejectedError("Fact-check rejected the script: sem busca configurada", ctx, false);
    };
    await expect(runPipeline({ until: "03-fetchFootage" })).rejects.toThrow(/fix the configuration/);
    expect(counts.script).toBe(1);
    expect(counts.factCheck).toBe(1);
    const runs = readdirSync(renderOutput);
    expect(runs).toHaveLength(1);
    const saved = JSON.parse(readFileSync(join(renderOutput, runs[0]!, "context.json"), "utf8")) as RunContext;
    expect(saved.rejection).toMatchObject({ stage: "02b-factCheck", retryable: false });
  });

  it("control: a footage rejection still retries with a new topic (script made again)", async () => {
    const { counts } = setup(async (ctx) => { throw new RunRejectedError("No usable footage", ctx); });
    await expect(runPipeline({ until: "03-fetchFootage" })).rejects.toThrow(/QUALITY GATE/);
    expect(counts.script).toBeGreaterThan(1);
  });

  it("a resumed run that gets past the stage clears the quota note", async () => {
    const { renderOutput } = setup(async () => { throw quotaWith([]); });
    await runPipeline({ until: "03-fetchFootage" }).catch(() => undefined);
    const runId = readdirSync(renderOutput)[0]!;
    STAGES.find((s) => s.name === "03-fetchFootage")!.load = async () => async (ctx) => ({ ...ctx, footage: [clip(0)] });
    await runPipeline({ until: "03-fetchFootage", resume: runId });
    const saved = JSON.parse(readFileSync(join(renderOutput, runId, "context.json"), "utf8")) as RunContext;
    expect(saved.quota).toBeUndefined();
    expect(saved.footage).toHaveLength(1);
  });
});
