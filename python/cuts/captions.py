"""Caption cues for a cut: N words per cue, upper-case, timed from the word timestamps (pure, no OpenCV)."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass

MIN_CUE_SECONDS = 0.35
MAX_HOLD_GAP_SECONDS = 1.0  # a cue stays on screen through a pause up to this long


@dataclass(frozen=True)
class Cue:
    start: float  # seconds relative to the clip start
    end: float
    text: str


def build_cues(
    words: Iterable[Mapping[str, object]],
    clip_start: float,
    clip_end: float,
    words_per_cue: int = 3,
) -> list[Cue]:
    """Groups the words spoken inside [clip_start, clip_end] into cues of `words_per_cue` words.

    A cue stays on screen until the next cue starts when the pause between them is short (<= 1 s), otherwise it
    ends with its last word; cues never overlap. Times are relative to the clip start.
    """
    if words_per_cue < 1:
        raise ValueError("words_per_cue must be >= 1")
    inside = [
        w
        for w in words
        if float(w["start"]) >= clip_start - 0.05
        and float(w["end"]) <= clip_end + 0.05
        and str(w["word"]).strip()
    ]
    groups = [
        inside[i : i + words_per_cue] for i in range(0, len(inside), words_per_cue)
    ]
    cues: list[Cue] = []
    for index, group in enumerate(groups):
        start = max(0.0, float(group[0]["start"]) - clip_start)
        end = max(float(group[-1]["end"]) - clip_start, start + MIN_CUE_SECONDS)
        if index + 1 < len(groups):
            next_start = float(groups[index + 1][0]["start"]) - clip_start
            if next_start - end <= MAX_HOLD_GAP_SECONDS:
                end = next_start
            end = min(end, max(start + MIN_CUE_SECONDS, next_start))
        end = min(end, clip_end - clip_start)
        text = " ".join(str(w["word"]).strip() for w in group).upper()
        cues.append(Cue(round(start, 3), round(end, 3), text))
    return cues


def cue_at(cues: list[Cue], t: float) -> Cue | None:
    """Cue visible at time t (cues are sorted and non-overlapping)."""
    for cue in cues:
        if cue.start <= t < cue.end:
            return cue
        if cue.start > t:
            break
    return None


def hex_to_bgr(color: str) -> tuple[int, int, int]:
    value = color.lstrip("#")
    if len(value) != 6:
        raise ValueError(f"expected #RRGGBB, got {color!r}")
    r, g, b = (int(value[i : i + 2], 16) for i in (0, 2, 4))
    return (b, g, r)
