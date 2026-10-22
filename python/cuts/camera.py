"""Zooming camera for the "face" framing (pure): pushes in on the speaker, pulls back when nobody speaks.

With a speaker, the 9:16 crop is sized so the face box is FACE_FRACTION of the crop width (between
1/2.2 and the full source height) with the face at FACE_TOP of the crop height. Without one, the crop is
the full-height 9:16 window at the last speaker's x. Each axis follows its target through a dead zone
(relative to the current crop, so a tight shot stays tight) and an EMA; the zoom eases slower so it reads
as a deliberate push-in, and a change of speaker pans over about SWITCH_SECONDS instead of cutting.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from speaker import Face

ASPECT = 9 / 16  # crop width / height
FACE_FRACTION = 0.38  # face box width / crop width
MIN_HEIGHT_FRACTION = 1 / 2.2  # tightest crop height, of the source height
FACE_TOP = 0.40  # face centre, from the top of the crop
DEAD_ZONE = 0.08  # of the current crop width (x) or height (y, zoom)
PAN_ALPHA = 0.08
ZOOM_ALPHA = 0.05
SWITCH_SECONDS = 0.3


@dataclass(frozen=True)
class Shot:
    cx: float  # crop centre, source pixels
    cy: float
    height: float  # crop height; width = height * ASPECT


def max_height(src_w: float, src_h: float) -> float:
    return min(src_h, src_w / ASPECT)


def target_shot(
    speaker: Face | None,
    faces: Sequence[Face],
    last_x: float | None,
    src_w: float,
    src_h: float,
    zoom: bool = True,
) -> Shot:
    """Where the camera wants to be for one frame (zoom=False: always the full-height window)."""
    widest = max_height(src_w, src_h)
    if speaker is not None and not zoom:
        return Shot(speaker.cx, src_h / 2, widest)
    if speaker is None:
        if last_x is None:
            last_x = sum(f.cx for f in faces) / len(faces) if faces else src_w / 2
        return Shot(last_x, src_h / 2, widest)
    height = speaker.width / FACE_FRACTION / ASPECT
    height = min(max(height, src_h * MIN_HEIGHT_FRACTION), widest)
    return Shot(speaker.cx, speaker.cy + (0.5 - FACE_TOP) * height, height)


def _follow(goal: float, target: float, dead_zone: float) -> float:
    return target if abs(target - goal) > dead_zone else goal


def camera_path(
    speakers: Sequence[Face | None],
    frames: Sequence[Sequence[Face]],
    src_w: float,
    src_h: float,
    fps: float,
    zoom: bool = True,
) -> list[Shot]:
    """Smoothed per-frame shots for the chosen speakers (`frames` = visible faces, for the no-speaker x)."""
    switch_frames = max(1, round(SWITCH_SECONDS * fps))
    switch_alpha = 1 - 0.05 ** (1 / switch_frames)  # 95% of the way in SWITCH_SECONDS
    path: list[Shot] = []
    position = goal = None
    last_x: float | None = None
    last_id: int | None = None
    switching = 0
    for speaker, faces in zip(speakers, frames, strict=True):
        if speaker is not None:
            if last_id is not None and speaker.track_id != last_id:
                switching = switch_frames
            last_x, last_id = speaker.cx, speaker.track_id
        target = target_shot(speaker, faces, last_x, src_w, src_h, zoom)
        if position is None or goal is None:
            position = goal = target
        else:
            goal = Shot(
                _follow(goal.cx, target.cx, DEAD_ZONE * position.height * ASPECT),
                _follow(goal.cy, target.cy, DEAD_ZONE * position.height),
                _follow(goal.height, target.height, DEAD_ZONE * position.height),
            )
            alpha = switch_alpha if switching else PAN_ALPHA
            switching = max(0, switching - 1)
            position = Shot(
                position.cx + (goal.cx - position.cx) * alpha,
                position.cy + (goal.cy - position.cy) * alpha,
                position.height + (goal.height - position.height) * ZOOM_ALPHA,
            )
        path.append(position)
    return path


def crop_rect(shot: Shot, src_w: int, src_h: int) -> tuple[int, int, int, int]:
    """(left, top, width, height) of the shot in whole pixels, kept inside the frame."""
    height = round(min(shot.height, max_height(src_w, src_h)))
    width = min(round(height * ASPECT), src_w)
    left = min(max(shot.cx - width / 2, 0.0), src_w - width)
    top = min(max(shot.cy - height / 2, 0.0), src_h - height)
    return round(left), round(top), width, height
