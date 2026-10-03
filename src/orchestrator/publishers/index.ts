import type { PipelineConfig } from "../lib/config.js";
import { createInstagramPublisher, resolveInstagramSettings } from "./instagram.js";
import { createYouTubePublisher, resolveUploadSettings } from "./youtube.js";
import type { SharedGateSettings } from "./gates.js";
import type { Publisher } from "./types.js";

/**
 * Registry of publishers, in publishing order. To add a platform: implement `Publisher` in
 * publishers/<platform>.ts and add one line here (its own config section and daily cap included).
 */
export function createPublishers(config: PipelineConfig): Publisher[] {
  return [
    createYouTubePublisher(resolveUploadSettings(config.upload)),
    createInstagramPublisher(resolveInstagramSettings(config.instagram)),
  ];
}

/** Settings of the gates shared by every platform (kept under `upload` for backward compatibility). */
export function sharedGateSettings(config: PipelineConfig): SharedGateSettings {
  return { allowWithoutFactCheck: config.upload.allowWithoutFactCheck ?? false };
}
