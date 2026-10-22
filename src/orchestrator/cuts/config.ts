/**
 * Cuts (Onda 4) configuration: config/cuts.json validated with zod. The channel gate lives here: a channel is
 * only processed when the owner enabled it and it is not on the block list (owner decision, 2026-10-22: cutting
 * public videos is allowed as long as the cut never changes the meaning or demoralizes anyone; a channel that
 * complains or files a claim goes to `blocked` for good). `authorization` stays as optional proof.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { paths } from "../lib/config.js";

/** YouTube Shorts accept up to 3 minutes. */
export const MAX_SHORT_SECONDS = 180;
/** Default clip length of a vlog channel (the reference channel's hits run 95-179 s). */
export const VLOG_SECONDS = { min: 60, max: MAX_SHORT_SECONDS } as const;

export const ChannelSchema = z.object({
  /** YouTube channel id (UC...). */
  id: z.string().regex(/^UC[\w-]{22}$/, "channel id must look like UCxxxxxxxxxxxxxxxxxxxxxx"),
  name: z.string().min(1),
  enabled: z.boolean(),
  /** Why this channel must never be cut again (owner asked to stop, copyright claim). Set = refused for good. */
  blocked: z.string().optional(),
  /** "vlog": handheld shop/street footage, long story-like clips; "podcast": seated conversation, short clips. */
  style: z.enum(["vlog", "podcast"]).default("podcast"),
  /** Overrides the clip length of the channel's style. */
  minSeconds: z.number().positive().optional(),
  maxSeconds: z.number().positive().max(MAX_SHORT_SECONDS).optional(),
  /** Optional proof: link to a public statement where the channel allows cuts. */
  authorization: z
    .object({
      url: z.string(),
      date: z.string().optional(),
      note: z.string().optional(),
      conditions: z.array(z.string()).default([]),
    })
    .optional(),
  /** Text burned on top of every clip and later used in the description. */
  credit: z.string().min(1),
  maxVideosPerDay: z.number().int().positive().optional(),
});

export const CutsConfigSchema = z.object({
  channels: z.array(ChannelSchema),
  clip: z.object({
    /** Clip length of podcast-style channels. */
    minSeconds: z.number().positive(),
    maxSeconds: z.number().positive().max(MAX_SHORT_SECONDS),
    perVideo: z.number().int().positive(),
    /** "face": full 9:16 crop following the speaker; "open": 4:5 window on a blurred background. */
    framing: z.enum(["face", "open"]),
    captions: z.object({
      wordsPerCue: z.number().int().positive(),
      color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    }),
  }),
  download: z.object({
    maxHeight: z.number().int().positive(),
    /** yt-dlp binary (name on PATH or full path). */
    ytDlp: z.string().min(1),
  }),
});

export type CutsConfig = z.infer<typeof CutsConfigSchema>;
export type CutChannel = z.infer<typeof ChannelSchema>;
export type Framing = CutsConfig["clip"]["framing"];

export const CUTS_CONFIG_FILE = "cuts.json";

export function parseCutsConfig(raw: unknown, source = CUTS_CONFIG_FILE): CutsConfig {
  const result = CutsConfigSchema.safeParse(raw);
  if (!result.success) throw new Error(`Invalid ${source}:\n${z.prettifyError(result.error)}`);
  if (result.data.clip.minSeconds >= result.data.clip.maxSeconds) {
    throw new Error(`Invalid ${source}: clip.minSeconds must be smaller than clip.maxSeconds`);
  }
  for (const channel of result.data.channels) {
    const range = clipRangeFor(channel, result.data);
    if (range.minSeconds >= range.maxSeconds) throw new Error(`Invalid ${source}: ${channel.name} minSeconds must be smaller than maxSeconds`);
  }
  return result.data;
}

export function loadCutsConfig(file = join(paths.config, CUTS_CONFIG_FILE)): CutsConfig {
  // ponytail: config/cuts.json is the owner's copy (git-ignored); the versioned template is cuts.example.json.
  if (!existsSync(file)) throw new Error(`${file} not found: copy config/cuts.example.json to config/cuts.json and fill it in`);
  return parseCutsConfig(JSON.parse(readFileSync(file, "utf8")), file);
}

export class ChannelNotAuthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelNotAuthorizedError";
  }
}

/** Why the channel cannot be cut right now, or undefined when it can. */
export function channelRefusal(channel: CutChannel): string | undefined {
  if (channel.blocked) return `is blocked in config/cuts.json (${channel.blocked})`;
  if (!channel.enabled) return "is disabled in config/cuts.json (enabled: false)";
  return undefined;
}

/** The gate: throws unless the owner enabled the channel and it is not blocked. */
export function assertChannelAuthorized(channel: CutChannel): void {
  const refusal = channelRefusal(channel);
  if (refusal) throw new ChannelNotAuthorizedError(`Channel ${channel.name} (${channel.id}) ${refusal}`);
}

/** Clip length for a channel: its own override, else its style's default (podcast = clip.minSeconds/maxSeconds). */
export function clipRangeFor(channel: CutChannel, config: Pick<CutsConfig, "clip">): { minSeconds: number; maxSeconds: number } {
  const base = channel.style === "vlog" ? { minSeconds: VLOG_SECONDS.min, maxSeconds: VLOG_SECONDS.max } : { minSeconds: config.clip.minSeconds, maxSeconds: config.clip.maxSeconds };
  return { minSeconds: channel.minSeconds ?? base.minSeconds, maxSeconds: channel.maxSeconds ?? base.maxSeconds };
}

export function findChannel(config: CutsConfig, channelId: string): CutChannel | undefined {
  return config.channels.find((c) => c.id === channelId);
}
