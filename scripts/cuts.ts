/**
 * Cuts (Onda 4) CLI.
 *   npm run cuts -- --video <url|id> [--channel <UC...>] [--framing face|open] [--clips 3]
 *   npm run cuts -- --scan                       # read the RSS feeds of enabled channels, process new videos
 *   npm run cuts -- --video <id> --source <mp4> --transcript <json>   # dev mode: no download / Whisper
 * Exit codes: 0 ok, 1 error, 3 nothing to do (no authorized channel / no new video).
 */
import { parseArgs } from "node:util";
import { ChannelNotAuthorizedError, findChannel, loadCutsConfig, type CutChannel, type CutsConfig } from "../src/orchestrator/cuts/config.js";
import { LoginRequiredError, parseVideoId } from "../src/orchestrator/cuts/download.js";
import { fetchChannelFeed, listProcessed, markProcessed, pickNewVideos } from "../src/orchestrator/cuts/feed.js";
import { processVideo, type ProcessOptions, type StepTiming } from "../src/orchestrator/cuts/pipeline.js";
import { describeError, getLogger, type Logger } from "../src/orchestrator/lib/logger.js";

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_NOTHING = 3;

const USAGE = "Usage: npm run cuts -- (--video <url|id> [--channel <id>] | --scan) [--framing face|open] [--clips N] [--source <mp4> --transcript <json>]";

function parse(): { video?: string; channel?: string; scan: boolean; options: ProcessOptions } {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      video: { type: "string" },
      channel: { type: "string" },
      scan: { type: "boolean", default: false },
      framing: { type: "string" },
      clips: { type: "string" },
      source: { type: "string" },
      transcript: { type: "string" },
      title: { type: "string" },
    },
    strict: true,
  });
  if (values.framing && values.framing !== "face" && values.framing !== "open") throw new Error(USAGE);
  const clips = values.clips ? Number(values.clips) : undefined;
  if (clips !== undefined && (!Number.isInteger(clips) || clips < 1)) throw new Error(USAGE);
  if (!values.scan && !values.video) throw new Error(USAGE);
  return {
    video: values.video,
    channel: values.channel,
    scan: values.scan,
    options: { framing: values.framing as ProcessOptions["framing"], clips, source: values.source, transcript: values.transcript, videoTitle: values.title, noJournal: !!values.source },
  };
}

function authorizedChannels(config: CutsConfig, log: Logger): CutChannel[] {
  return config.channels.filter((c) => {
    const ok = c.enabled && c.authorization.url.trim() !== "";
    if (!ok) log.warn(`skipping channel ${c.name} (${c.id}): ${c.enabled ? "no authorization.url" : "enabled: false"}`);
    return ok;
  });
}

function reportTimings(log: Logger, timings: readonly StepTiming[]): void {
  log.info(`timings: ${timings.map((t) => `${t.step} ${t.seconds}s`).join(" | ")}`);
}

async function runSingle(config: CutsConfig, log: Logger, videoInput: string, channelId: string | undefined, options: ProcessOptions): Promise<number> {
  const videoId = parseVideoId(videoInput);
  const channel = channelId ? findChannel(config, channelId) : config.channels.length === 1 ? config.channels[0] : undefined;
  if (!channel) throw new Error(`--channel <id> is required when config/cuts.json has ${config.channels.length} channels`);
  const result = await processVideo(channel, videoId, config, log, options);
  reportTimings(log, result.timings);
  return result.runs.length > 0 ? EXIT_OK : EXIT_NOTHING;
}

async function runScan(config: CutsConfig, log: Logger, options: ProcessOptions): Promise<number> {
  const channels = authorizedChannels(config, log);
  if (channels.length === 0) {
    log.warn("no channel is enabled with an authorization.url in config/cuts.json; nothing to do");
    return EXIT_NOTHING;
  }
  let produced = 0;
  for (const channel of channels) {
    const fresh = pickNewVideos(await fetchChannelFeed(channel.id), await listProcessed());
    const limit = channel.maxVideosPerDay ?? 1;
    log.info(`${channel.name}: ${fresh.length} new video(s) in the feed; processing up to ${limit}`);
    for (const video of fresh.slice(0, limit)) {
      try {
        const result = await processVideo(channel, video.videoId, config, log, { ...options, videoTitle: video.title });
        reportTimings(log, result.timings);
        produced += result.runs.length;
      } catch (error) {
        if (!(error instanceof LoginRequiredError)) throw error;
        log.warn(`${video.videoId}: ${error.message}`);
        await markProcessed({ channelId: channel.id, videoId: video.videoId, status: "skipped", reason: error.message });
      }
    }
  }
  return produced > 0 ? EXIT_OK : EXIT_NOTHING;
}

async function main(): Promise<number> {
  const { video, channel, scan, options } = parse();
  const log = getLogger(`cuts-${new Date().toISOString().slice(0, 10)}`);
  const config = loadCutsConfig();
  try {
    return scan ? await runScan(config, log, options) : await runSingle(config, log, video as string, channel, options);
  } catch (error) {
    if (error instanceof ChannelNotAuthorizedError) {
      log.error(error.message);
      return EXIT_NOTHING;
    }
    log.error(describeError(error));
    return EXIT_ERROR;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = EXIT_ERROR;
  },
);
