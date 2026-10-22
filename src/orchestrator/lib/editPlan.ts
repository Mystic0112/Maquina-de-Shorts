// Pure rules of the edit plan (stage 05b-planEdits): what the model may propose and what survives validation.
import { z } from "zod";
import type { EditAsset, EditCue, EditPlacement, Narration, SceneTiming, Script } from "../types.js";
import type { MemeAsset } from "./memeLibrary.js";

export const EDIT_RULES = {
  /** Nothing over the hook (cover text + punch-in). */
  hookMs: 2500,
  /** Nothing over the loop/CTA tail. */
  tailMs: 2000,
  minGapMs: 4000,
  sfxMaxMs: 1500,
  stickerMinMs: 1000,
  stickerMaxMs: 3000,
} as const;

export const PLACEMENTS = ["top", "side-left", "side-right", "corner"] as const satisfies readonly EditPlacement[];
export const INTENSITIES = ["sutil", "normal", "forte"] as const;

export const EditCueDraftSchema = z.object({
  atMs: z.number().int().nonnegative().describe("instante em ms em que a figurinha/som entra"),
  assetId: z.string().min(1),
  kind: z.enum(["sticker", "lottie", "sfx", "image"]),
  placement: z.enum(PLACEMENTS),
  durationMs: z.number().int().positive(),
  intensity: z.enum(INTENSITIES),
  why: z.string().max(200),
});
export const EditPlanDraftSchema = z.object({ cues: z.array(EditCueDraftSchema).max(20) });
export type EditCueDraft = z.infer<typeof EditCueDraftSchema>;

export type ValidatedPlan = { cues: EditCue[]; dropped: string[] };

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** One cue against the library and the time windows; a reason string when it must be dropped. */
function checkCue(cue: EditCueDraft, asset: EditAsset | undefined, durationMs: number): string | undefined {
  if (!asset) return `asset "${cue.assetId}" não existe na biblioteca`;
  if (asset.kind !== cue.kind) return `${cue.assetId} é ${asset.kind}, não ${cue.kind}`;
  if (cue.atMs < EDIT_RULES.hookMs) return `${cue.assetId} em ${cue.atMs} ms cai no gancho (< ${EDIT_RULES.hookMs} ms)`;
  if (cue.atMs > durationMs - EDIT_RULES.tailMs) return `${cue.assetId} em ${cue.atMs} ms cai no final (últimos ${EDIT_RULES.tailMs} ms)`;
  if (asset.kind === "sfx" && (asset.durationMs ?? Number.POSITIVE_INFINITY) > EDIT_RULES.sfxMaxMs) return `${cue.assetId}: som com mais de ${EDIT_RULES.sfxMaxMs} ms`;
  return undefined;
}

/** Sounds take the file's length; stickers are clamped to 1-3 s and never run past the tail. */
function effectiveDuration(cue: EditCueDraft, asset: EditAsset, durationMs: number): number {
  const wanted = asset.kind === "sfx" ? (asset.durationMs ?? cue.durationMs) : clamp(cue.durationMs, EDIT_RULES.stickerMinMs, EDIT_RULES.stickerMaxMs);
  return Math.max(1, Math.min(wanted, durationMs - EDIT_RULES.tailMs - cue.atMs));
}

/**
 * Drops cues that reference unknown assets / wrong kinds / forbidden windows, clamps durations, enforces the
 * minimum spacing (earlier cue wins) and the per-video cap. Deterministic and pure.
 */
export function validateEditPlan(draft: readonly EditCueDraft[], assets: readonly EditAsset[], durationMs: number, maxCues: number): ValidatedPlan {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const dropped: string[] = [];
  const kept: EditCue[] = [];
  for (const cue of [...draft].sort((a, b) => a.atMs - b.atMs)) {
    const asset = byId.get(cue.assetId);
    const problem = checkCue(cue, asset, durationMs);
    if (problem || !asset) {
      dropped.push(problem ?? cue.assetId);
      continue;
    }
    const previous = kept[kept.length - 1];
    if (previous && cue.atMs - previous.atMs < EDIT_RULES.minGapMs) {
      dropped.push(`${cue.assetId} em ${cue.atMs} ms: menos de ${EDIT_RULES.minGapMs} ms depois do cue anterior`);
      continue;
    }
    if (kept.length >= maxCues) {
      dropped.push(`${cue.assetId} em ${cue.atMs} ms: acima do máximo de ${maxCues} cues`);
      continue;
    }
    kept.push({ ...cue, why: cue.why.trim(), durationMs: effectiveDuration(cue, asset, durationMs) });
  }
  return { cues: kept, dropped };
}

/** Compact library listing for the prompt: one line per asset. */
export function libraryDigest(assets: readonly MemeAsset[]): string {
  return assets
    .map((a) => `- ${a.id} | ${a.kind}${a.durationMs ? ` ${a.durationMs} ms` : ""} | ${a.tags.join(", ")}`)
    .join("\n");
}

/** Narration with the start time of each word, grouped by scene, so the model can pick exact instants. */
export function timedNarration(narration: Pick<Narration, "words">, scenes: readonly SceneTiming[]): string {
  return scenes
    .map((scene) => {
      const words = narration.words.filter((w) => w.startMs >= scene.startMs && w.startMs < scene.endMs);
      return `Cena ${scene.sceneIndex + 1} (${scene.startMs}-${scene.endMs} ms): ${words.map((w) => `${w.word}@${w.startMs}`).join(" ")}`;
    })
    .join("\n");
}

export function buildEditPrompt(input: {
  script: Pick<Script, "title" | "hook">;
  narration: Pick<Narration, "words" | "durationMs">;
  scenes: readonly SceneTiming[];
  library: readonly MemeAsset[];
  maxCues: number;
}): string {
  const { durationMs } = input.narration;
  return `Você é o editor de um YouTube Short de curiosidades em português do Brasil. Escolha figurinhas e efeitos sonoros
curtos da biblioteca abaixo para reforçar momentos da narração (surpresa, erro, vitória, pergunta, suspense...).

Título: ${input.script.title}
Gancho: ${input.script.hook}
Duração total: ${durationMs} ms

Narração com o instante (ms) em que cada palavra começa:
${timedNarration(input.narration, input.scenes)}

Biblioteca (id | tipo | tags):
${libraryDigest(input.library)}

Regras:
- No máximo ${input.maxCues} cues; menos é melhor que exagero. Vídeo curto (< 40 s): no máximo 3.
- Pelo menos 4000 ms entre um cue e o próximo.
- Nunca antes de ${EDIT_RULES.hookMs} ms (gancho) nem depois de ${durationMs - EDIT_RULES.tailMs} ms (final).
- Use só ids da biblioteca, com o "kind" exatamente igual ao da biblioteca.
- "atMs" é o instante da palavra que o cue reforça (use os tempos acima).
- Figurinhas/imagens: "durationMs" entre ${EDIT_RULES.stickerMinMs} e ${EDIT_RULES.stickerMaxMs}; sons (sfx): "durationMs" = duração do arquivo.
- "placement": "top" (acima da legenda, para a figurinha principal), "side-left"/"side-right" (ao lado, sem cobrir o centro),
  "corner" (canto superior direito, pequeno). Nada pode cobrir a legenda nem rostos no centro da imagem.
- "intensity": "sutil" (pequeno), "normal", "forte" (maior, só em momentos de pico).
- "why": uma frase curta explicando a escolha.
Devolva só o JSON { "cues": [...] }. Sem nenhum cue adequado, devolva { "cues": [] }.`;
}
