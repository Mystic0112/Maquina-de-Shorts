import type React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { CaptionSettings } from "../../shared/settings.js";
import type { CaptionChunkProps } from "../shared.js";
import { activeWordIndex, captionBox, captionContainerStyle, captionFontSize, captionText, captionWordStyle } from "./captionStyle.js";

// Layout tuned for YouTube Shorts: the bottom ~20% and right ~15% are covered by the player UI.

const activeChunkAt = (chunks: CaptionChunkProps[], frame: number): CaptionChunkProps | undefined =>
  chunks.find((c) => frame >= c.startFrame && frame < c.endFrame);

export const Captions: React.FC<{ chunks: CaptionChunkProps[]; settings: Required<CaptionSettings> }> = ({ chunks, settings }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const chunk = settings.enabled ? activeChunkAt(chunks, frame) : undefined;
  if (!chunk) return null;

  const box = captionBox(width, height, settings);
  const fontSize = captionFontSize(chunk.words, box.width, settings);
  const pop = spring({ frame: frame - chunk.startFrame, fps, config: { damping: 12, stiffness: 220, mass: 0.6 } });
  const popScale = interpolate(pop, [0, 1], [0.8, 1]);
  const active = activeWordIndex(chunk.words, frame);

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={captionContainerStyle(fontSize, box, popScale, settings)}>
        {chunk.words.map((w, i) => (
          <span key={`${w.startFrame}-${i}`} style={captionWordStyle(i === active, fontSize, settings)}>
            {captionText(w.text, settings)}
          </span>
        ))}
      </div>
    </AbsoluteFill>
  );
};
