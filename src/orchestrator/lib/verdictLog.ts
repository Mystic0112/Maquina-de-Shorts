import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import type { FootageClip, SceneBeat, ScriptScene } from "../types.js";
import { paths } from "./config.js";
import type { LlmProviderName, ThinkingSetting } from "./llmClient.js";
import type { RelevanceVerdict, ScoredClip, SourceSize } from "./relevance.js";

/**
 * Every relevance verdict of a run (kept or not), one JSON line per reviewed clip: the raw material of the
 * local vision-judge dataset (scripts/export_verdicts_dataset.ts).
 */
export const VERDICTS_FILE = "footage_verdicts.jsonl";
/** Frames sent to the reviewer, under the run dir (outside footage/, so retention trimming keeps them). */
export const VERDICT_FRAMES_DIR = "verdict_frames";
/** Where retention moves the verdicts of runs it deletes. Not versioned (.gitignore). */
export const VERDICTS_ARCHIVE_DIR = join(paths.data, "verdicts");

/** What the reviewer was told about the clip (effective values: hook prefix, hook/retry query, beat). */
export interface VerdictContext {
  title?: string;
  hook?: string;
  narration: string;
  footageQuery: string;
  beat?: SceneBeat;
}

export interface VerdictRecord {
  runId: string;
  sceneIndex: number;
  beatIndex?: number;
  isHook: boolean;
  isRetry: boolean;
  /** Relative to the run dir, forward slashes. */
  clipPath: string;
  /** Relative to the run dir, forward slashes, in the order they were attached. */
  framePaths: string[];
  kind: FootageClip["kind"];
  source: string;
  sourceUrl: string;
  creator: string;
  license: string;
  /** Size as downloaded (before normalization), when known. */
  width?: number;
  height?: number;
  context: VerdictContext;
  /** Exact prompt sent (the multi-candidate prompt when the clip was reviewed in a batch). */
  prompt?: string;
  /** The reviewer's own verdict, before the low-resolution penalty (see `penalized`). */
  verdict?: RelevanceVerdict;
  error?: string;
  provider?: LlmProviderName;
  model?: string;
  thinking: ThinkingSetting;
  /** Clips reviewed in the same call. */
  batchSize: number;
  penalized: false | { scoreBefore: number; scoreAfter: number; reason: string };
  selected: boolean;
  ts: string;
}

export interface VerdictInput {
  runId: string;
  runDir: string;
  /** As returned by the reviewer (with frames/prompt). */
  reviewed: ScoredClip;
  /** After penalizeLowResolution. */
  final: ScoredClip;
  scene: ScriptScene;
  beat?: SceneBeat;
  title?: string;
  hook?: string;
  isHook: boolean;
  isRetry: boolean;
  sourceSize?: SourceSize;
  provider?: LlmProviderName;
  model?: string;
  thinking: ThinkingSetting;
  batchSize: number;
}

const toPosix = (p: string): string => p.split(sep).join("/");

/** Writes the frames as verdict_frames/<clip base name>_<i>.jpg; returns their run-relative paths. */
export async function saveVerdictFrames(runDir: string, clipPath: string, frames: readonly Buffer[]): Promise<string[]> {
  if (frames.length === 0) return [];
  const dir = join(runDir, VERDICT_FRAMES_DIR);
  await mkdir(dir, { recursive: true });
  const base = basename(clipPath, extname(clipPath));
  return Promise.all(
    frames.map(async (data, i) => {
      const file = join(dir, `${base}_${i}.jpg`);
      await writeFile(file, data);
      return toPosix(relative(runDir, file));
    }),
  );
}

export function buildVerdictRecord(input: VerdictInput, framePaths: string[], now = new Date()): VerdictRecord {
  const { reviewed, final, scene, beat, sourceSize } = input;
  const clip = reviewed.clip;
  const before = reviewed.verdict?.score;
  const after = final.verdict?.score;
  return {
    runId: input.runId,
    sceneIndex: clip.sceneIndex,
    ...(clip.beatIndex !== undefined ? { beatIndex: clip.beatIndex } : {}),
    isHook: input.isHook,
    isRetry: input.isRetry,
    clipPath: toPosix(relative(input.runDir, clip.path)),
    framePaths,
    kind: clip.kind,
    source: clip.source,
    sourceUrl: clip.sourceUrl,
    creator: clip.creator,
    license: clip.license,
    ...(sourceSize ? { width: sourceSize.width, height: sourceSize.height } : {}),
    context: {
      ...(input.title ? { title: input.title } : {}),
      ...(input.hook ? { hook: input.hook } : {}),
      narration: scene.narration,
      footageQuery: scene.footageQuery,
      ...(beat ? { beat: { phrase: beat.phrase, footageQuery: beat.footageQuery } } : {}),
    },
    ...(reviewed.prompt ? { prompt: reviewed.prompt } : {}),
    ...(reviewed.verdict ? { verdict: reviewed.verdict } : { error: reviewed.error ?? "unknown error" }),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    thinking: input.thinking,
    batchSize: input.batchSize,
    penalized:
      before !== undefined && after !== undefined && before !== after
        ? { scoreBefore: before, scoreAfter: after, reason: final.verdict!.reason }
        : false,
    selected: false,
    ts: now.toISOString(),
  };
}

/** Atomic (tmp + rename): a crash never leaves a truncated log behind. */
export async function writeVerdictLog(runDir: string, records: readonly VerdictRecord[]): Promise<string> {
  const file = join(runDir, VERDICTS_FILE);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, records.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");
  await rename(tmp, file);
  return file;
}
