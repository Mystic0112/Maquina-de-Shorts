// Stage 05b — asks the LLM where stickers/SFX from assets/memes/ fit the narration (config `editing`, off by
// default). Writes ctx.edits; disabled or empty library leaves the context untouched.
import { existsSync } from "node:fs";
import { resolveEditing, type EditingSettings } from "../../shared/settings.js";
import { loadConfig } from "../lib/config.js";
import { buildEditPrompt, EditPlanDraftSchema, validateEditPlan } from "../lib/editPlan.js";
import { generateJson } from "../lib/llmClient.js";
import { getLogger } from "../lib/logger.js";
import { assetPath, loadInventory, MEME_LIBRARY_DIR, toEditAsset, type MemeAsset } from "../lib/memeLibrary.js";
import type { EditPlan, RunContext, SceneTiming } from "../types.js";

export interface PlanEditsDeps {
  settings: () => EditingSettings | undefined;
  inventory: () => Promise<MemeAsset[]>;
  generate: typeof generateJson;
  libraryDir: string;
}

export const defaultPlanEditsDeps: PlanEditsDeps = {
  settings: () => loadConfig().editing,
  inventory: () => loadInventory(),
  generate: generateJson,
  libraryDir: MEME_LIBRARY_DIR,
};

export async function run(ctx: RunContext, deps: PlanEditsDeps = defaultPlanEditsDeps): Promise<RunContext> {
  const log = getLogger(ctx.runId);
  const settings = resolveEditing(deps.settings());
  if (!settings.enabled) {
    log.info("Edits: editing.enabled=false, stage skipped");
    return ctx;
  }
  if (!ctx.script || !ctx.narration) throw new Error("05b-planEdits requires ctx.script and ctx.narration");
  const assets: MemeAsset[] = [];
  for (const a of await deps.inventory()) {
    if (existsSync(assetPath(a, deps.libraryDir))) assets.push(a);
    else log.warn(`Edits: ${a.id} ignorado, arquivo ausente (${a.file})`);
  }
  if (assets.length === 0) {
    log.info("Edits: meme library is empty, stage skipped (npm run memes -- add-... to fill assets/memes/)");
    return ctx;
  }
  const scenes: SceneTiming[] = ctx.captions?.scenes.length ? ctx.captions.scenes : [{ sceneIndex: 0, startMs: 0, endMs: ctx.narration.durationMs }];
  const prompt = buildEditPrompt({ script: ctx.script, narration: ctx.narration, scenes, library: assets, maxCues: settings.maxCuesPerVideo });
  const draft = await deps.generate(prompt, EditPlanDraftSchema, { thinking: "low", temperature: 0.6 });
  const editAssets = assets.map((a) => toEditAsset(a, deps.libraryDir));
  const { cues, dropped } = validateEditPlan(draft.cues, editAssets, ctx.narration.durationMs, settings.maxCuesPerVideo);
  for (const reason of dropped) log.warn(`Edits: cue descartado: ${reason}`);
  const used = new Set(cues.map((c) => c.assetId));
  const edits: EditPlan = { cues, assets: editAssets.filter((a) => used.has(a.id)), sfxVolume: settings.sfxVolume };
  log.info(`Edits: ${cues.length} cue(s) kept of ${draft.cues.length} proposed: ${cues.map((c) => `${c.assetId}@${c.atMs}ms/${c.placement}`).join(", ") || "none"}`);
  return { ...ctx, edits };
}
