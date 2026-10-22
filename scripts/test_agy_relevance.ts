import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { paths } from "../src/orchestrator/lib/config.js";
import { AntigravityCliProvider, getProviderByName, type LlmProvider } from "../src/orchestrator/lib/llmClient.js";
import { scoreClip, type ScoredClip } from "../src/orchestrator/lib/relevance.js";
import type { FootageClip, RunContext, ScriptScene } from "../src/orchestrator/types.js";

interface EvaluatedCandidate {
  runId: string;
  clip: FootageClip;
  scene: ScriptScene;
  title: string;
  hook?: string;
  historicalApiScore: number;
  historicalApiMatches: boolean;
  historicalApiReason: string;
  historicalApiPassed: boolean;
}

interface BenchmarkItemResult {
  index: number;
  file: string;
  benchmarkImagePath: string;
  runId: string;
  sceneIndex: number;
  historicalApi: {
    score: number;
    matches: boolean;
    reason: string;
    passed: boolean;
  };
  apiMedium: {
    score?: number;
    matches?: boolean;
    reason?: string;
    hasTextOrLogo?: boolean;
    hasIdentifiablePeople?: boolean;
    wrongEraOrPlace?: boolean;
    passed?: boolean;
    error?: string;
    durationSeconds?: number;
  };
  agyMedium: {
    score?: number;
    matches?: boolean;
    reason?: string;
    hasTextOrLogo?: boolean;
    hasIdentifiablePeople?: boolean;
    wrongEraOrPlace?: boolean;
    passed?: boolean;
    error?: string;
    durationSeconds?: number;
  };
  agreementWithApiMedium: boolean;
  scoreDiffWithApiMedium?: number;
}

async function main() {
  console.log("================================================================================");
  console.log("BENCHMARK: AGY (THINKING MEDIUM) VS API GEMINI (THINKING MEDIUM)");
  console.log("================================================================================\n");

  const baseDir = paths.renderOutput;
  const runs = readdirSync(baseDir).filter((f) => {
    try {
      return statSync(join(baseDir, f)).isDirectory();
    } catch {
      return false;
    }
  });

  const candidates: EvaluatedCandidate[] = [];
  const seenPaths = new Set<string>();

  for (const r of runs) {
    const ctxPath = join(baseDir, r, "context.json");
    if (!existsSync(ctxPath)) continue;
    try {
      const ctx = JSON.parse(readFileSync(ctxPath, "utf8")) as RunContext;
      if (!ctx.footage || !ctx.script) continue;

      for (const f of ctx.footage) {
        if (f.relevanceScore !== undefined && existsSync(f.path) && !seenPaths.has(f.path)) {
          seenPaths.add(f.path);
          const scene = ctx.script.scenes?.[f.sceneIndex];
          if (!scene) continue;

          const historicalApiScore = f.relevanceScore;
          const historicalApiMatches = f.relevanceMatches ?? (historicalApiScore >= 6);
          const historicalApiPassed = historicalApiMatches && historicalApiScore >= 6;

          candidates.push({
            runId: r,
            clip: f,
            scene,
            title: ctx.script.title,
            hook: ctx.script.hook,
            historicalApiScore,
            historicalApiMatches,
            historicalApiReason: f.relevanceReason ?? "",
            historicalApiPassed,
          });
        }
      }
    } catch {
      // Ignora contextos corrompidos
    }
  }

  console.log(`Total de clips candidatos encontrados com arquivos presentes: ${candidates.length}`);

  if (candidates.length < 20) {
    console.warn(`Aviso: Encontrados apenas ${candidates.length} clips disponíveis.`);
  }

  // Ordena por nota histórica para cobrir todo o espectro
  candidates.sort((a, b) => a.historicalApiScore - b.historicalApiScore);

  const sampleSize = Math.min(20, candidates.length);
  const selected: EvaluatedCandidate[] = [];

  const step = (candidates.length - 1) / (sampleSize - 1);
  for (let i = 0; i < sampleSize; i++) {
    const idx = Math.round(i * step);
    selected.push(candidates[idx]!);
  }

  console.log(`Selecionados ${selected.length} clips representativos para avaliação.\n`);

  // Diretório para cópias das imagens do benchmark
  const benchmarkDir = join(paths.data, "benchmark");
  if (!existsSync(benchmarkDir)) {
    mkdirSync(benchmarkDir, { recursive: true });
  }

  const apiProvider = getProviderByName("gemini");
  const agyProvider = new AntigravityCliProvider(undefined, undefined, null);
  const framesDir = join(paths.renderOutput, "_benchmark_frames");

  const results: BenchmarkItemResult[] = [];
  let passesMatchCount = 0;
  let totalScoreDiff = 0;
  let scoreDiffCount = 0;
  let agyFailuresCount = 0;
  let apiFailuresCount = 0;
  let totalAgyDuration = 0;
  let totalApiDuration = 0;

  for (let i = 0; i < selected.length; i++) {
    const item = selected[i]!;
    const fileName = basename(item.clip.path);
    const copyFileName = `${String(i + 1).padStart(2, "0")}_${item.runId}_${fileName}`;
    const destPath = join(benchmarkDir, copyFileName);
    copyFileSync(item.clip.path, destPath);

    console.log(`[${i + 1}/${selected.length}] Avaliando ${fileName} (${item.runId}, cena ${item.clip.sceneIndex})...`);
    console.log(`    Cópia salva em: data/benchmark/${copyFileName}`);
    console.log(`    Histórico API (low/orig): score=${item.historicalApiScore}, aprovado=${item.historicalApiPassed}`);
    console.log(`    Query: "${item.scene.footageQuery}"`);

    // 1. Avalia com API Gemini direta (thinking medium)
    const apiStart = performance.now();
    let apiScored: ScoredClip;
    try {
      apiScored = await scoreClip(
        item.clip,
        item.scene,
        framesDir,
        item.title,
        "medium",
        item.hook,
        apiProvider,
      );
    } catch (err) {
      apiScored = { clip: item.clip, error: err instanceof Error ? err.message : String(err) };
    }
    const apiDuration = (performance.now() - apiStart) / 1000;
    totalApiDuration += apiDuration;

    const apiV = apiScored.verdict;
    const apiPassed = apiV
      ? apiV.matches && apiV.score >= 6 && !apiV.hasTextOrLogo && !apiV.hasIdentifiablePeople && !apiV.wrongEraOrPlace
      : false;

    if (apiScored.error) {
      apiFailuresCount++;
      console.log(`    API (medium): FALHA -> ${apiScored.error} (${apiDuration.toFixed(1)}s)`);
    } else if (apiV) {
      console.log(
        `    API (medium): score=${apiV.score}, matches=${apiV.matches}, flags=[logo:${apiV.hasTextOrLogo},people:${apiV.hasIdentifiablePeople},era:${apiV.wrongEraOrPlace}], aprovado=${apiPassed} (${apiDuration.toFixed(1)}s)`
      );
      console.log(`    API Motivo: "${apiV.reason}"`);
    }

    // 2. Avalia com Antigravity CLI (thinking medium)
    const agyStart = performance.now();
    let agyScored: ScoredClip;
    try {
      agyScored = await scoreClip(
        item.clip,
        item.scene,
        framesDir,
        item.title,
        "medium",
        item.hook,
        agyProvider,
      );
    } catch (err) {
      agyScored = { clip: item.clip, error: err instanceof Error ? err.message : String(err) };
    }
    const agyDuration = (performance.now() - agyStart) / 1000;
    totalAgyDuration += agyDuration;

    const agyV = agyScored.verdict;
    const agyPassed = agyV
      ? agyV.matches && agyV.score >= 6 && !agyV.hasTextOrLogo && !agyV.hasIdentifiablePeople && !agyV.wrongEraOrPlace
      : false;

    if (agyScored.error) {
      agyFailuresCount++;
      console.log(`    AGY (medium): FALHA -> ${agyScored.error} (${agyDuration.toFixed(1)}s)`);
    } else if (agyV) {
      console.log(
        `    AGY (medium): score=${agyV.score}, matches=${agyV.matches}, flags=[logo:${agyV.hasTextOrLogo},people:${agyV.hasIdentifiablePeople},era:${agyV.wrongEraOrPlace}], aprovado=${agyPassed} (${agyDuration.toFixed(1)}s)`
      );
      console.log(`    AGY Motivo: "${agyV.reason}"`);
    }

    // Comparação entre API Medium e AGY Medium
    const agreement = !apiScored.error && !agyScored.error ? apiPassed === agyPassed : false;
    let scoreDiff: number | undefined;
    if (apiV && agyV) {
      scoreDiff = Math.abs(agyV.score - apiV.score);
      totalScoreDiff += scoreDiff;
      scoreDiffCount++;
      if (agreement) passesMatchCount++;
      console.log(`    >>> Concordância (API Medium vs AGY Medium): ${agreement ? "SIM" : "DIVERGÊNCIA"} | Dif. nota: ${scoreDiff.toFixed(1)}`);
    }

    console.log("");

    results.push({
      index: i + 1,
      file: fileName,
      // Relative to the project root: the results file is versioned and must not carry personal paths.
      benchmarkImagePath: relative(paths.root, destPath).replaceAll("\\", "/"),
      runId: item.runId,
      sceneIndex: item.clip.sceneIndex,
      historicalApi: {
        score: item.historicalApiScore,
        matches: item.historicalApiMatches,
        reason: item.historicalApiReason,
        passed: item.historicalApiPassed,
      },
      apiMedium: {
        score: apiV?.score,
        matches: apiV?.matches,
        reason: apiV?.reason,
        hasTextOrLogo: apiV?.hasTextOrLogo,
        hasIdentifiablePeople: apiV?.hasIdentifiablePeople,
        wrongEraOrPlace: apiV?.wrongEraOrPlace,
        passed: apiPassed,
        error: apiScored.error,
        durationSeconds: Math.round(apiDuration * 10) / 10,
      },
      agyMedium: {
        score: agyV?.score,
        matches: agyV?.matches,
        reason: agyV?.reason,
        hasTextOrLogo: agyV?.hasTextOrLogo,
        hasIdentifiablePeople: agyV?.hasIdentifiablePeople,
        wrongEraOrPlace: agyV?.wrongEraOrPlace,
        passed: agyPassed,
        error: agyScored.error,
        durationSeconds: Math.round(agyDuration * 10) / 10,
      },
      agreementWithApiMedium: agreement,
      scoreDiffWithApiMedium: scoreDiff,
    });
  }

  const validComparisons = scoreDiffCount;
  const agreementRate = validComparisons > 0 ? (passesMatchCount / validComparisons) * 100 : 0;
  const agyFailureRate = (agyFailuresCount / selected.length) * 100;
  const apiFailureRate = (apiFailuresCount / selected.length) * 100;
  const avgScoreDiff = validComparisons > 0 ? totalScoreDiff / validComparisons : 0;
  const avgAgyDuration = totalAgyDuration / selected.length;
  const avgApiDuration = totalApiDuration / selected.length;

  console.log("================================================================================");
  console.log("RELATÓRIO CONSOLIDADO: BENCHMARK JUSTO (AMBOS EM THINKING MEDIUM)");
  console.log("================================================================================");
  console.log(`Total avaliado:                      ${selected.length} imagens`);
  console.log(`Imagens arquivadas para inspeção:    data/benchmark/`);
  console.log(`Concordância Aprova/Reprova:         ${passesMatchCount}/${validComparisons} (${agreementRate.toFixed(1)}%)`);
  console.log(`Diferença média de nota:             ${avgScoreDiff.toFixed(2)} pontos (escala 0-10)`);
  console.log(`Taxa de falhas técnicas do AGY:     ${agyFailuresCount}/${selected.length} (${agyFailureRate.toFixed(1)}%)`);
  console.log(`Taxa de falhas técnicas da API:     ${apiFailuresCount}/${selected.length} (${apiFailureRate.toFixed(1)}%)`);
  console.log(`Tempo médio por chamada (AGY):       ${avgAgyDuration.toFixed(1)} s`);
  console.log(`Tempo médio por chamada (API):       ${avgApiDuration.toFixed(1)} s`);
  console.log(`Tempo total do benchmark:            ${(totalAgyDuration + totalApiDuration).toFixed(1)} s`);
  console.log("================================================================================\n");

  const summary = {
    timestamp: new Date().toISOString(),
    benchmarkConfiguration: {
      modelAgy: "gemini-3.8-flash-medium (via agy CLI sandbox)",
      modelApi: "gemini-flash-latest (thinking medium)",
      thinkingSetting: "medium",
      imagesCopiedTo: "data/benchmark",
    },
    totalEvaluated: selected.length,
    validComparisons,
    agreementRatePercent: Math.round(agreementRate * 10) / 10,
    averageScoreDifference: Math.round(avgScoreDiff * 100) / 100,
    agyFailureRatePercent: Math.round(agyFailureRate * 10) / 10,
    apiFailureRatePercent: Math.round(apiFailureRate * 10) / 10,
    averageAgyDurationSeconds: Math.round(avgAgyDuration * 10) / 10,
    averageApiDurationSeconds: Math.round(avgApiDuration * 10) / 10,
    totalDurationSeconds: Math.round((totalAgyDuration + totalApiDuration) * 10) / 10,
    results,
  };

  const outputPath = join(paths.data, "agy_benchmark_results.json");
  writeFileSync(outputPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(`Resultados salvos com sucesso em: ${outputPath}`);
}

main().catch((err) => {
  console.error("Erro fatal no benchmark:", err);
  process.exit(1);
});
