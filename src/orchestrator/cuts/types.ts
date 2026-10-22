import type { RunContext } from "../types.js";

/** Provenance of a cut; stage 07 will later turn `credit` + `sourceUrl` into the description. */
export interface CutInfo {
  channelId: string;
  channelName: string;
  videoId: string;
  sourceUrl: string;
  videoTitle: string;
  start: number;
  end: number;
  credit: string;
  /** Optional proof of the channel's public permission; empty when none was recorded. */
  authorizationUrl: string;
  framing: "face" | "open";
  reason: string;
}

/** RunContext written by the cuts pipeline: the same shape stages 07/08 and the dashboard read, plus `cut`. */
export interface CutRunContext extends RunContext {
  cut: CutInfo;
}
