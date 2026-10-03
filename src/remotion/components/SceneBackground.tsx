import type React from "react";
import { AbsoluteFill, Img, interpolate, OffthreadVideo, Sequence, staticFile, useCurrentFrame } from "remotion";
import type { ClipSegment, SceneProps } from "../shared.js";

const coverStyle: React.CSSProperties = { width: "100%", height: "100%", objectFit: "cover", objectPosition: "center" };
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/**
 * Linear camera move over the segment's lifetime. translateX is applied before scale (CSS composes
 * right-to-left), so the pan is in pre-scale % of the frame and stays inside the zoom's slack.
 */
const MovingSegment: React.FC<{ segment: ClipSegment }> = ({ segment }) => {
  const frame = useCurrentFrame(); // relative to the segment start
  const { motion } = segment;
  const progress = interpolate(frame, [0, Math.max(1, segment.durationInFrames - 1)], [0, 1], clamp);
  const scale = motion.scaleFrom + (motion.scaleTo - motion.scaleFrom) * progress;
  const panX = motion.panXFromPct + (motion.panXToPct - motion.panXFromPct) * progress;
  const src = staticFile(segment.src);

  return (
    <AbsoluteFill style={{ transform: `scale(${scale}) translateX(${panX}%)`, willChange: "transform" }}>
      {segment.kind === "image" ? <Img src={src} style={coverStyle} /> : <OffthreadVideo src={src} muted style={coverStyle} />}
    </AbsoluteFill>
  );
};

export const SceneBackground: React.FC<{ scene: SceneProps }> = ({ scene }) => {
  const frame = useCurrentFrame(); // relative to the scene's visual start (including lead-in)
  const opacity = scene.leadInFrames > 0 ? interpolate(frame, [0, scene.leadInFrames], [0, 1], clamp) : 1;

  return (
    <AbsoluteFill style={{ opacity, backgroundColor: "#000", overflow: "hidden" }}>
      {scene.segments.map((segment, i) => (
        <Sequence key={`${segment.src}-${i}`} from={segment.fromFrame} durationInFrames={segment.durationInFrames}>
          <MovingSegment segment={segment} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
