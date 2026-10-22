/**
 * Cuts (Onda 4) configuration: config/cuts.json validated with zod. The authorization gate lives here and
 * has no config switch: a channel is only processed when enabled AND it has a written authorization URL.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { paths } from "../lib/config.js";

export const ChannelSchema = z.object({
  /** YouTube channel id (UC...). */
  id: z.string().regex(/^UC[\w-]{22}$/, "channel id must look like UCxxxxxxxxxxxxxxxxxxxxxx"),
  name: z.string().min(1),
  enabled: z.boolean(),
  authorization: z.object({
    /** Link to the public statement/message where the channel allows cuts. Empty = not authorized. */
    url: z.string(),
    date: z.string().optional(),
    note: z.string().optional(),
    conditions: z.array(z.string()),
  }),
  /** Text burned on top of every clip and later used in the description. */
  credit: z.string().min(1),
  maxVideosPerDay: z.number().int().positive().optional(),
});

export const CutsConfigSchema = z.object({
  channels: z.array(ChannelSchema),
  clip: z.object({
    minSeconds: z.number().positive(),
    maxSeconds: z.number().positive(),
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

/**
 * The gate: throws unless the channel is enabled and has a non-empty authorization URL. Deliberately not
 * configurable; a channel without a written, linkable authorization is never cut.
 */
export function assertChannelAuthorized(channel: CutChannel): void {
  const who = `${channel.name} (${channel.id})`;
  if (!channel.enabled) {
    throw new ChannelNotAuthorizedError(`Channel ${who} is disabled in config/cuts.json (enabled: false)`);
  }
  if (!channel.authorization.url.trim()) {
    throw new ChannelNotAuthorizedError(
      `Channel ${who} has no authorization.url in config/cuts.json; without a link to the owner's written ` +
        `permission the machine refuses to cut its videos${channel.authorization.note ? ` (note: ${channel.authorization.note})` : ""}`,
    );
  }
}

export function findChannel(config: CutsConfig, channelId: string): CutChannel | undefined {
  return config.channels.find((c) => c.id === channelId);
}
