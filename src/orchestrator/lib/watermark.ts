/** The owner's watermark from config/pipeline.config.json, with its PNG resolved (missing file = text only). */
import { existsSync } from "node:fs";
import { resolveWatermark, type WatermarkSettings } from "../../shared/settings.js";
import { paths } from "./config.js";

export interface ResolvedWatermark {
  settings: Required<WatermarkSettings>;
  imagePath: string | null;
}

export function resolveWatermarkFiles(raw: WatermarkSettings | undefined, warn: (m: string) => void = () => undefined): ResolvedWatermark {
  const settings = resolveWatermark(raw);
  if (!settings.enabled || !settings.image.trim()) return { settings, imagePath: null };
  const imagePath = paths.fromRoot(settings.image.trim());
  if (existsSync(imagePath)) return { settings, imagePath };
  warn(`watermark image ${settings.image} not found; using the text only`);
  return { settings, imagePath: null };
}
