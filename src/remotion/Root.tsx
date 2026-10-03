import type React from "react";
import { Composition, type CalculateMetadataFunction } from "remotion";
import { ShortComposition } from "./ShortComposition.js";
import { COMPOSITION_ID, EMPTY_SHORT_PROPS, type ShortProps } from "./shared.js";

/** Size, fps and length all come from inputProps, so the render stage is the single source of truth. */
const calculateMetadata: CalculateMetadataFunction<ShortProps> = ({ props }) => ({
  durationInFrames: props.durationInFrames,
  fps: props.fps,
  width: props.width,
  height: props.height,
});

export const RemotionRoot: React.FC = () => (
  <Composition
    id={COMPOSITION_ID}
    component={ShortComposition}
    defaultProps={EMPTY_SHORT_PROPS}
    calculateMetadata={calculateMetadata}
    durationInFrames={EMPTY_SHORT_PROPS.durationInFrames}
    fps={EMPTY_SHORT_PROPS.fps}
    width={EMPTY_SHORT_PROPS.width}
    height={EMPTY_SHORT_PROPS.height}
  />
);
