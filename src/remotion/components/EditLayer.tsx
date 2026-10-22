import type React from "react";
import { AbsoluteFill, Audio, Img, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import type { CaptionSettings } from "../../shared/settings.js";
import type { EditCueProps } from "../shared.js";
import { cueOpacity, cueRotationDeg, cueScale, editBox } from "./editStyle.js";

/** One sticker: pops in with a spring, wobbles gently, leaves fast. Positioned by editStyle (never over captions). */
const Sticker: React.FC<{ cue: EditCueProps; captions: Required<CaptionSettings> }> = ({ cue, captions }) => {
  const frame = useCurrentFrame(); // local to the Sequence
  const { fps, width, height } = useVideoConfig();
  const box = editBox(cue.placement, cue.intensity, width, height, captions);
  const transform = `scale(${cueScale(frame, cue.durationInFrames, fps).toFixed(3)}) rotate(${cueRotationDeg(frame, cue.intensity).toFixed(2)}deg)`;
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{ position: "absolute", ...box, opacity: cueOpacity(frame, cue.durationInFrames), transform, transformOrigin: "center" }}>
        <Img src={staticFile(cue.src)} style={{ width: "100%", height: "100%", objectFit: "contain", filter: "drop-shadow(0 6px 12px rgba(0,0,0,0.45))" }} />
      </div>
    </AbsoluteFill>
  );
};

export const EditLayer: React.FC<{ cues: EditCueProps[]; captions: Required<CaptionSettings> }> = ({ cues, captions }) => (
  <>
    {cues.map((cue) => (
      <Sequence key={`${cue.id}-${cue.fromFrame}`} from={cue.fromFrame} durationInFrames={cue.durationInFrames} layout="none">
        {cue.kind === "sfx" ? <Audio src={staticFile(cue.src)} volume={cue.volume} /> : <Sticker cue={cue} captions={captions} />}
      </Sequence>
    ))}
  </>
);
