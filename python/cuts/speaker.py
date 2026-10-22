"""Who is talking and where to point the camera: pure functions over per-frame face observations.

A frame observation is a list of faces; each face has a center x (in source pixels), a mouth-activity score
(mean absolute pixel difference of the mouth patch versus the previous frame of the same tracked face) and a
box width. `choose_speaker` applies hysteresis: the active speaker only changes when another face has been
the most active one for `hold_frames` consecutive frames (1.2 s by default at the source fps). `smooth_path`
turns the chosen centers into a calm pan: a dead zone absorbs jitter, an EMA eases real moves.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

DEFAULT_HOLD_SECONDS = 1.2
DEAD_ZONE_FRACTION = 0.06  # of the source width: smaller moves are ignored
EASE_ALPHA = 0.08


@dataclass(frozen=True)
class Face:
    track_id: int
    cx: float
    cy: float
    width: float
    activity: float


def _most_active(faces: Sequence[Face]) -> Face | None:
    if not faces:
        return None
    return max(faces, key=lambda f: (f.activity, f.width))


def choose_speaker(
    frames: Sequence[Sequence[Face]], hold_frames: int
) -> list[Face | None]:
    """Per-frame active speaker with hysteresis; None when the frame has no face.

    The current speaker is kept while it is still visible; a challenger must out-talk it for `hold_frames`
    frames in a row before the camera follows (this is what stops the burst switching the owner saw).
    When the current speaker leaves the frame, the most active remaining face takes over immediately.
    """
    hold_frames = max(1, hold_frames)
    current_id: int | None = None
    challenger_id: int | None = None
    challenger_frames = 0
    chosen: list[Face | None] = []
    for faces in frames:
        by_id = {f.track_id: f for f in faces}
        best = _most_active(faces)
        if current_id not in by_id:
            current_id = best.track_id if best else None
            challenger_id, challenger_frames = None, 0
        elif (
            best is not None
            and best.track_id != current_id
            and best.activity > by_id[current_id].activity
        ):
            if best.track_id == challenger_id:
                challenger_frames += 1
            else:
                challenger_id, challenger_frames = best.track_id, 1
            if challenger_frames >= hold_frames:
                current_id, challenger_id, challenger_frames = best.track_id, None, 0
        else:
            challenger_id, challenger_frames = None, 0
        chosen.append(by_id.get(current_id) if current_id is not None else None)
    return chosen


def smooth_path(
    targets: Sequence[float | None],
    source_width: float,
    initial: float | None = None,
    dead_zone: float = DEAD_ZONE_FRACTION,
    alpha: float = EASE_ALPHA,
) -> list[float]:
    """Eases a per-frame target x into a camera path; None targets hold the last position."""
    if not targets:
        return []
    first = next((t for t in targets if t is not None), None)
    position = (
        initial
        if initial is not None
        else (first if first is not None else source_width / 2)
    )
    goal = position
    path: list[float] = []
    threshold = dead_zone * source_width
    for target in targets:
        if target is not None and abs(target - goal) > threshold:
            goal = target
        position += (goal - position) * alpha
        path.append(position)
    return path


def clamp_window(center: float, window: float, total: float) -> int:
    """Left edge of a `window`-wide crop centred on `center`, kept inside [0, total]."""
    left = center - window / 2
    return round(min(max(left, 0.0), max(total - window, 0.0)))


def assign_tracks(
    previous: Sequence[Face],
    detections: Sequence[tuple[float, float, float]],
    next_id: int,
    max_distance_fraction: float = 0.6,
) -> tuple[list[tuple[int, int]], int]:
    """Greedy nearest-centre matching of new detections (cx, cy, width) to previous faces.

    Returns [(detection index, track id)] and the next free id. A detection farther than
    `max_distance_fraction * width` from every previous face starts a new track.
    """
    pairs: list[tuple[int, int]] = []
    used: set[int] = set()
    for index, (cx, cy, width) in enumerate(detections):
        best_id, best_distance = None, max_distance_fraction * width
        for face in previous:
            if face.track_id in used:
                continue
            distance = ((face.cx - cx) ** 2 + (face.cy - cy) ** 2) ** 0.5
            if distance < best_distance:
                best_id, best_distance = face.track_id, distance
        if best_id is None:
            best_id, next_id = next_id, next_id + 1
        used.add(best_id)
        pairs.append((index, best_id))
    return pairs, next_id
