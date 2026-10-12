import type React from "react";
import { AbsoluteFill, Img, OffthreadVideo, Sequence, staticFile, useCurrentFrame } from "remotion";
import type { ClipSegment, SceneProps } from "../shared.js";
import { cameraAt, cameraTransform, fadeInOpacity } from "./motion.js";

const coverStyle: React.CSSProperties = { width: "100%", height: "100%", objectFit: "cover", objectPosition: "center" };

/** One shot: eased camera move over its own duration, optional dissolve-in over the previous shot. */
const Shot: React.FC<{ segment: ClipSegment }> = ({ segment }) => {
  const frame = useCurrentFrame(); // relative to the shot start
  const camera = cameraAt(segment.motion, frame, segment.durationInFrames);
  const src = staticFile(segment.src);

  return (
    <AbsoluteFill style={{ opacity: fadeInOpacity(frame, segment.fadeInFrames), overflow: "hidden" }}>
      <AbsoluteFill style={{ transform: cameraTransform(camera), willChange: "transform" }}>
        {segment.kind === "image" ? (
          <Img src={src} style={coverStyle} />
        ) : (
          <OffthreadVideo src={src} muted trimBefore={segment.trimBeforeFrames > 0 ? segment.trimBeforeFrames : undefined} style={coverStyle} />
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export const SceneBackground: React.FC<{ scene: SceneProps }> = ({ scene }) => {
  const frame = useCurrentFrame(); // relative to the scene's visual start (including lead-in)
  const opacity = fadeInOpacity(frame, scene.leadInFrames);

  return (
    <AbsoluteFill style={{ opacity, backgroundColor: "#000", overflow: "hidden" }}>
      {scene.segments.map((segment, i) => (
        // A shot stays mounted under the next one while that one dissolves in.
        <Sequence
          key={`${segment.src}-${i}`}
          from={segment.fromFrame}
          durationInFrames={segment.durationInFrames + (scene.segments[i + 1]?.fadeInFrames ?? 0)}
        >
          <Shot segment={segment} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
