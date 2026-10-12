import type React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { CaptionSettings } from "../../shared/settings.js";
import type { OverlayHookProps } from "../shared.js";
import { overlayLayout, overlayOpacity, overlayScrim, overlayTextStyle } from "./overlayStyle.js";

/** Hook/cover text at the top: no entry animation, so frame 0 (the platform's default cover) shows it whole. */
export const OverlayHook: React.FC<{ overlay: OverlayHookProps; captions: Required<CaptionSettings> }> = ({ overlay, captions }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const opacity = overlayOpacity(frame, overlay);
  if (opacity <= 0) return null;
  const layout = overlayLayout(overlay.text, width, height, captions);

  return (
    <AbsoluteFill style={{ opacity, pointerEvents: "none" }}>
      <AbsoluteFill style={{ background: overlayScrim(layout, height) }} />
      <div style={overlayTextStyle(layout, captions)}>{overlay.text}</div>
    </AbsoluteFill>
  );
};
