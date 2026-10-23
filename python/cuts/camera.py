"""Zooming camera for the "face" framing (pure): pushes in on the speaker, pulls back when nobody speaks.

With a speaker, the 9:16 crop is sized so the face box is FACE_FRACTION of the crop width (between
1/2.2 and the full source height) with the face at FACE_TOP of the crop height. Without one, the crop is
the full-height 9:16 window at the last speaker's x. Each axis follows its target through a dead zone
(relative to the current crop, so a tight shot stays tight) and an EMA; the zoom eases slower so it reads
as a deliberate push-in, and a change of speaker pans over about SWITCH_SECONDS instead of cutting.
When two or more people talk over each other (ASD scores only, `group_frames`), the camera eases out to a
group shot holding every active face.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from speaker import ASD_THRESHOLD, Face

ASPECT = 9 / 16  # crop width / height
FACE_FRACTION = 0.38  # face box width / crop width
MIN_HEIGHT_FRACTION = 1 / 1.25  # tightest crop height, of the source height (1/2.2 blurred 1080p sources: ~3.9x upscale)
FACE_TOP = 0.40  # face centre, from the top of the crop
DEAD_ZONE = 0.08  # of the current crop width (x) or height (y, zoom)
PAN_ALPHA = 0.08
ZOOM_ALPHA = 0.05
SWITCH_SECONDS = 0.3
OVERLAP_MIN_SECONDS = 0.5  # two or more speaking this long before the group shot
GROUP_HOLD_SECONDS = 1.0  # the group shot stays this long after the overlap ends
GROUP_PAD = 0.6  # each face box is padded by this fraction of its width on every side


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


def group_shot(faces: Sequence[Face], src_w: float, src_h: float) -> Shot:
    """9:16 shot holding every padded face box, at least as wide as the widest single-speaker shot; when it
    cannot fit, the full-height window centred between the outermost faces."""
    widest = max_height(src_w, src_h)
    pads = [f.width * GROUP_PAD for f in faces]
    x0 = min(f.cx - f.width / 2 - pad for f, pad in zip(faces, pads, strict=True))
    x1 = max(f.cx + f.width / 2 + pad for f, pad in zip(faces, pads, strict=True))
    y0 = min(
        f.cy - (f.height or f.width) / 2 - pad
        for f, pad in zip(faces, pads, strict=True)
    )
    y1 = max(
        f.cy + (f.height or f.width) / 2 + pad
        for f, pad in zip(faces, pads, strict=True)
    )
    single = max(target_shot(f, [], None, src_w, src_h).height for f in faces)
    height = max((x1 - x0) / ASPECT, y1 - y0, single)
    if height > widest:
        xs = [f.cx for f in faces]
        return Shot((min(xs) + max(xs)) / 2, src_h / 2, widest)
    return Shot((x0 + x1) / 2, (y0 + y1) / 2, height)


def group_frames(
    scored: Sequence[Sequence[Face]],
    fps: float,
    min_seconds: float = OVERLAP_MIN_SECONDS,
    hold_seconds: float = GROUP_HOLD_SECONDS,
    threshold: float = ASD_THRESHOLD,
) -> list[list[Face]]:
    """Per frame, the faces a group shot must hold ([] = no group shot), from per-frame ASD scores.

    The group shot starts once 2+ faces have scored above `threshold` for `min_seconds` in a row, follows the
    faces speaking during any later overlap, and ends `hold_seconds` after the last overlapping frame.
    """
    min_frames = max(1, round(min_seconds * fps))
    hold_frames = round(hold_seconds * fps)
    groups: list[list[Face]] = []
    run = quiet = 0
    ids: set[int] = set()
    for faces in scored:
        speaking = [f for f in faces if f.activity > threshold]
        if len(speaking) >= 2:
            run += 1
            if ids or run >= min_frames:
                ids, quiet = {f.track_id for f in speaking}, 0
        else:
            run = 0
            quiet += 1
            if quiet > hold_frames:
                ids = set()
        groups.append([f for f in faces if f.track_id in ids])
    return groups


def _follow(goal: float, target: float, dead_zone: float) -> float:
    return target if abs(target - goal) > dead_zone else goal


def camera_path(
    speakers: Sequence[Face | None],
    frames: Sequence[Sequence[Face]],
    src_w: float,
    src_h: float,
    fps: float,
    zoom: bool = True,
    groups: Sequence[Sequence[Face]] | None = None,
) -> list[Shot]:
    """Smoothed per-frame shots for the chosen speakers (`frames` = visible faces, for the no-speaker x;
    `groups` = group_frames output: a non-empty entry overrides the speaker with a slowly eased group shot)."""
    switch_frames = max(1, round(SWITCH_SECONDS * fps))
    switch_alpha = 1 - 0.05 ** (1 / switch_frames)  # 95% of the way in SWITCH_SECONDS
    path: list[Shot] = []
    position = goal = None
    last_x: float | None = None
    last_id: int | None = None
    switching = 0
    for index, (speaker, faces) in enumerate(zip(speakers, frames, strict=True)):
        group = groups[index] if groups else []
        if speaker is not None:
            if last_id is not None and speaker.track_id != last_id:
                switching = switch_frames
            last_x, last_id = speaker.cx, speaker.track_id
        if group:
            target, switching = group_shot(group, src_w, src_h), 0
        else:
            target = target_shot(speaker, faces, last_x, src_w, src_h, zoom)
        if position is None or goal is None:
            position = goal = target
        else:
            goal = Shot(
                _follow(goal.cx, target.cx, DEAD_ZONE * position.height * ASPECT),
                _follow(goal.cy, target.cy, DEAD_ZONE * position.height),
                _follow(goal.height, target.height, DEAD_ZONE * position.height),
            )
            alpha = ZOOM_ALPHA if group else switch_alpha if switching else PAN_ALPHA
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
