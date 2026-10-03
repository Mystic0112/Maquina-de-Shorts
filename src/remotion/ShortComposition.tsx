import type React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import { Captions } from "./components/Captions.js";
import { SceneBackground } from "./components/SceneBackground.js";
import type { ShortProps } from "./shared.js";

/** Soft darkening behind the caption band so white text stays readable on bright footage. */
const LegibilityScrim: React.FC = () => (
  <AbsoluteFill
    style={{
      background: "linear-gradient(to bottom, rgba(0,0,0,0) 40%, rgba(0,0,0,0.35) 58%, rgba(0,0,0,0.35) 68%, rgba(0,0,0,0) 85%)",
    }}
  />
);

const FallbackBackground: React.FC = () => (
  <AbsoluteFill style={{ background: "linear-gradient(160deg, #1b1f3b 0%, #0b0d1a 100%)" }} />
);

export const ShortComposition: React.FC<ShortProps> = ({ scenes, captions, audioSrc }) => (
  <AbsoluteFill style={{ backgroundColor: "#000" }}>
    {scenes.length === 0 ? <FallbackBackground /> : null}
    {scenes.map((scene) => (
      <Sequence
        key={`scene-${scene.sceneIndex}-${scene.startFrame}`}
        from={scene.startFrame - scene.leadInFrames}
        durationInFrames={scene.leadInFrames + scene.durationInFrames}
      >
        <SceneBackground scene={scene} />
      </Sequence>
    ))}
    <LegibilityScrim />
    <Captions chunks={captions} />
    {audioSrc ? <Audio src={staticFile(audioSrc)} /> : null}
  </AbsoluteFill>
);
