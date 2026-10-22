import type React from "react";
import { AbsoluteFill, Img, staticFile, useVideoConfig } from "remotion";
import { WATERMARK_LAYOUT } from "../../shared/settings.js";
import type { WatermarkProps } from "../shared.js";

/** The owner's brand mark: logo above the text, both centred on the anchor, kept clear of the Shorts UI. */
export const Watermark: React.FC<{ watermark: WatermarkProps }> = ({ watermark }) => {
  const { width, height } = useVideoConfig();
  const scale = width / 1080; // WATERMARK_LAYOUT is in 1080×1920 pixels
  const boxWidth = (width * watermark.size) / 100;
  const { position } = watermark;
  const anchor: React.CSSProperties = {
    position: "absolute",
    width: boxWidth,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 8 * scale,
    opacity: watermark.opacity,
    ...(position.startsWith("top") ? { top: WATERMARK_LAYOUT.topMin * scale } : { bottom: height - WATERMARK_LAYOUT.bottomMax * scale }),
    ...(position.endsWith("left") ? { left: WATERMARK_LAYOUT.margin * scale } : position.endsWith("right") ? { right: WATERMARK_LAYOUT.margin * scale } : { left: (width - boxWidth) / 2 }),
  };
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={anchor}>
        {watermark.imageSrc ? <Img src={staticFile(watermark.imageSrc)} style={{ width: "100%", height: "auto" }} /> : null}
        {watermark.text ? (
          <span
            style={{
              fontFamily: '"Arial Black", Impact, Arial, sans-serif',
              fontSize: Math.max(22 * scale, boxWidth * 0.2),
              color: "#fff",
              whiteSpace: "nowrap",
              WebkitTextStroke: `${3 * scale}px #000`,
              paintOrder: "stroke fill",
            }}
          >
            {watermark.text}
          </span>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};
