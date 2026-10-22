/** Builds the run folder + context.json of one cut so the dashboard and stages 07/08 can pick it up. */
import { generateRunId, runDirFor, saveRunContext } from "../lib/runContext.js";
import type { CutChannel, Framing } from "./config.js";
import type { ClipPick } from "./select.js";
import type { CutInfo, CutRunContext } from "./types.js";

export const FINAL_FILE = "final.mp4";

export interface CutContextInput {
  runId: string;
  channel: CutChannel;
  videoId: string;
  videoTitle: string;
  pick: ClipPick;
  narration: string;
  framing: Framing;
  videoPath: string;
  /** Length after jump cuts; defaults to the source window. */
  durationSeconds?: number;
}

export function buildCutRunContext(input: CutContextInput): CutRunContext {
  const { channel, pick } = input;
  const cut: CutInfo = {
    channelId: channel.id,
    channelName: channel.name,
    videoId: input.videoId,
    sourceUrl: `https://www.youtube.com/watch?v=${input.videoId}`,
    videoTitle: input.videoTitle,
    start: pick.start,
    end: pick.end,
    credit: channel.credit,
    authorizationUrl: channel.authorization?.url ?? "",
    framing: input.framing,
    reason: pick.reason,
  };
  return {
    runId: input.runId,
    runDir: runDirFor(input.runId),
    createdAt: new Date().toISOString(),
    script: {
      title: pick.title,
      hook: pick.hook,
      scenes: [{ narration: input.narration, footageQuery: "" }],
      cta: "",
      language: "pt-BR",
    },
    render: { videoPath: input.videoPath, durationSeconds: Number((input.durationSeconds ?? pick.end - pick.start).toFixed(3)), width: 1080, height: 1920 },
    cut,
  };
}

export function newCutRunId(index: number, now = new Date()): string {
  // One id per clip, generated a second apart so the ids stay sortable and distinct.
  return generateRunId(new Date(now.getTime() + index * 1000));
}

export async function saveCutContext(ctx: CutRunContext): Promise<void> {
  await saveRunContext(ctx);
}
