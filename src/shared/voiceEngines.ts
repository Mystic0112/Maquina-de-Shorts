// Per-engine facts shared by the pipeline (and tests). The runtime factories live in
// src/orchestrator/stages/04-synthesizeVoice.ts (ENGINE_FACTORIES); adding an engine means one entry here
// (TypeScript fails to compile until every VoiceEngine has one) plus one factory there.
import type { VoiceEngine } from "./settings.js";

export interface VoiceEngineInfo {
  /** Short pt-BR name for the panel and logs. */
  label: string;
  /**
   * Speech rate used by stage 02 to estimate how long the hook takes to say (letters only, no spaces, pauses
   * counted apart; see estimateSpeechSeconds). Remeasure with `npm run voice-speed -- <runId...>`.
   */
  lettersPerSecond: number;
  /** false = still an estimate ("a medir em casa"): run `npm run voice-speed` after real runs and copy the median here. */
  measured: boolean;
}

export const VOICE_ENGINE_INFO: Record<VoiceEngine, VoiceEngineInfo> = {
  // Median of 13 real runs (pm_alex, narrations 58-71 s): 13.8, range 13.7-14.2.
  kokoro: { label: "Kokoro (local, grátis)", lettersPerSecond: 14, measured: true },
  // 1 run (Fenrir): 15.2.
  gemini: { label: "Gemini (API paga)", lettersPerSecond: 15.2, measured: true },
  // Rough figure from early runs (~15-16); the engine has been offline since Oct 2026.
  "edge-tts": { label: "edge-tts (legado)", lettersPerSecond: 15.5, measured: false },
  // A MEDIR EM CASA. Starting guess from the owner's 590-character test passage (~40 s of audio): a bit slower than Kokoro.
  chatterbox: { label: "Chatterbox (local, voz própria)", lettersPerSecond: 12.5, measured: false },
  // A MEDIR EM CASA. Starting guess: same as Kokoro.
  elevenlabs: { label: "ElevenLabs (sua chave de API)", lettersPerSecond: 14, measured: false },
};

export const lettersPerSecondFor = (engine: VoiceEngine): number => VOICE_ENGINE_INFO[engine].lettersPerSecond;
