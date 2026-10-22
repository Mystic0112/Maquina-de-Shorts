import type React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import { Captions } from "./components/Captions.js";
import { EditLayer } from "./components/EditLayer.js";
import { backdropGradient } from "./components/captionStyle.js";
import { OverlayHook } from "./components/OverlayHook.js";
import { SceneBackground } from "./components/SceneBackground.js";
import { Watermark } from "./components/Watermark.js";
import type { ShortProps } from "./shared.js";

/** Soft darkening behind the caption band so white text stays readable on bright footage. */
const LegibilityScrim: React.FC<{ verticalPosition: number }> = ({ verticalPosition }) => (
  <AbsoluteFill style={{ background: backdropGradient(verticalPosition) }} />
);

const FallbackBackground: React.FC = () => (
  <AbsoluteFill style={{ background: "linear-gradient(160deg, #1b1f3b 0%, #0b0d1a 100%)" }} />
);

export const ShortComposition: React.FC<ShortProps> = ({ scenes, captions, overlay, audioSrc, style, edits, watermark }) => {
  const showCaptions = style.captions.enabled && captions.length > 0;
  return (
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
      {showCaptions && style.visual.captionBackdrop ? <LegibilityScrim verticalPosition={style.captions.verticalPosition} /> : null}
      {showCaptions ? <Captions chunks={captions} settings={style.captions} /> : null}
      {overlay ? <OverlayHook overlay={overlay} captions={style.captions} /> : null}
      {edits?.length ? <EditLayer cues={edits} captions={style.captions} /> : null}
      {watermark ? <Watermark watermark={watermark} /> : null}
      {audioSrc ? <Audio src={staticFile(audioSrc)} /> : null}
    </AbsoluteFill>
  );
};
