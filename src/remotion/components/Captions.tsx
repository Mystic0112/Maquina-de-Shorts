import type React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { CaptionChunkProps } from "../shared.js";
import {
  activeWordIndex,
  CAPTION_CENTER_Y,
  CAPTION_SAFE_LEFT,
  CAPTION_SAFE_RIGHT,
  captionContainerStyle,
  captionFontSize,
  captionWordStyle,
} from "./captionStyle.js";

// Layout tuned for YouTube Shorts: the bottom ~20% and right ~15% are covered by the player UI.

const activeChunkAt = (chunks: CaptionChunkProps[], frame: number): CaptionChunkProps | undefined =>
  chunks.find((c) => frame >= c.startFrame && frame < c.endFrame);

export const Captions: React.FC<{ chunks: CaptionChunkProps[] }> = ({ chunks }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const chunk = activeChunkAt(chunks, frame);
  if (!chunk) return null;

  const availableWidth = width * (1 - CAPTION_SAFE_LEFT - CAPTION_SAFE_RIGHT);
  const fontSize = captionFontSize(chunk.words, availableWidth);
  const pop = spring({ frame: frame - chunk.startFrame, fps, config: { damping: 12, stiffness: 220, mass: 0.6 } });
  const popScale = interpolate(pop, [0, 1], [0.8, 1]);
  const active = activeWordIndex(chunk.words, frame);
  const containerStyle = captionContainerStyle(fontSize, availableWidth, width * CAPTION_SAFE_LEFT, height * CAPTION_CENTER_Y, popScale);

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={containerStyle}>
        {chunk.words.map((w, i) => (
          <span key={`${w.startFrame}-${i}`} style={captionWordStyle(i === active, fontSize)}>
            {w.text.toLocaleUpperCase("pt-BR")}
          </span>
        ))}
      </div>
    </AbsoluteFill>
  );
};
