"""Where on-screen elements go so they never cover the speaker's face nor text burned into the video (pure).

Obstacles are boxes in output pixels (1080x1920): the current speaker's face, padded by FACE_PAD of its size,
and the burned-in text boxes found by textdetect.py, both mapped through the frame's crop (source rect
resized onto an output rect); boxes outside the crop are dropped. A caption cue gets ONE centre for its whole
life, so it never jumps mid-cue: the first candidate (the framing's default, then CANDIDATES of the height,
inside the safe zones) whose band clears every obstacle sampled across the cue. When none does, the default
stays and the cue is skipped if burned-in text already covers more than SKIP_COVER of that band (the video
carries its own caption there). Jokes run the same search while staying above the caption; emoji pick the
first clear horizontal anchor (centre, left third, right third). The watermark is never moved.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass

from compose import OPEN_H, OPEN_W, OUT_H, OUT_W
from speaker import Face

Box = tuple[float, float, float, float]  # x0, y0, x1, y1
Rect = tuple[int, int, int, int]  # left, top, width, height
# (clip-relative seconds, text boxes in source pixels), one per sampled frame
TextSample = tuple[float, Sequence[Box]]

FACE_PAD = 0.15  # of the face box size, on every side
BAND_MARGIN = 12  # px around a text block
SAFE_TOP = 150  # block top never above this (YouTube Shorts UI)
SAFE_BOTTOM = 1500  # block bottom never below this
DEFAULT_Y = {"face": 0.66, "open": 0.915}  # caption centre, of the output height
CANDIDATES = (0.78, 0.52, 0.36)  # tried in order after the default
SKIP_COVER = 0.5  # burned-in text covering more of the default band than this: the cue is not drawn
EMOJI_XS = (540, 300, 780)  # centre, left third, right third
EMOJI_EDGE = 40  # px kept between a sticker and the frame edges
TEXT_WINDOW = 1.0  # s: a text sample counts this long before and after its frame (one sample per second)
SAMPLE_STEP = 5  # frames between obstacle samples across a span
FULL_FRAME: Rect = (0, 0, OUT_W, OUT_H)
OPEN_WINDOW: Rect = (0, (OUT_H - OPEN_H) // 2, OPEN_W, OPEN_H)


@dataclass(frozen=True)
class Obstacles:
    faces: tuple[Box, ...] = ()
    texts: tuple[Box, ...] = ()

    @property
    def boxes(self) -> tuple[Box, ...]:
        return self.faces + self.texts


@dataclass(frozen=True)
class CaptionPlace:
    y: int  # centre, output pixels
    moved: bool  # off the framing's default
    skip: bool  # burned-in text already sits on the default band: do not draw


# ---------------------------------------------------------------------------------------------
# Obstacles in output coordinates
# ---------------------------------------------------------------------------------------------


def map_box(box: Box, crop: Rect, dest: Rect = FULL_FRAME) -> Box | None:
    """A source box in output pixels when `crop` (source rect) is resized onto `dest` (output rect); clipped
    to `dest`, None when it falls outside the crop."""
    left, top, width, height = crop
    dx, dy, dw, dh = dest
    sx, sy = dw / width, dh / height
    x0 = max(dx + (box[0] - left) * sx, dx)
    y0 = max(dy + (box[1] - top) * sy, dy)
    x1 = min(dx + (box[2] - left) * sx, dx + dw)
    y1 = min(dy + (box[3] - top) * sy, dy + dh)
    if x1 <= x0 or y1 <= y0:
        return None
    return x0, y0, x1, y1


def face_box(face: Face, pad: float = FACE_PAD) -> Box:
    """The face box in source pixels, padded by `pad` of its width and height on every side."""
    w, h = face.width, face.height or face.width
    half_w, half_h = w / 2 + pad * w, h / 2 + pad * h
    return face.cx - half_w, face.cy - half_h, face.cx + half_w, face.cy + half_h


def visible_text(
    samples: Sequence[TextSample], t: float, window: float = TEXT_WINDOW
) -> list[Box]:
    """Text boxes of every sample taken less than `window` seconds from t (the two neighbouring samples)."""
    return [box for ts, boxes in samples if abs(ts - t) < window for box in boxes]


def frame_obstacles(
    crop: Rect, dest: Rect, face: Face | None, texts: Iterable[Box]
) -> Obstacles:
    """The speaker's padded face and the text boxes of one frame, mapped to output pixels."""
    faces = [map_box(face_box(face), crop, dest)] if face is not None else []
    mapped = [map_box(box, crop, dest) for box in texts]
    return Obstacles(
        tuple(b for b in faces if b is not None),
        tuple(b for b in mapped if b is not None),
    )


def union(parts: Iterable[Obstacles]) -> Obstacles:
    faces: list[Box] = []
    texts: list[Box] = []
    for part in parts:
        faces.extend(part.faces)
        texts.extend(part.texts)
    return Obstacles(tuple(faces), tuple(texts))


def sample_frames(
    f0: int, f1: int, kept: Iterable[int] | None = None, step: int = SAMPLE_STEP
) -> list[int]:
    """Every `step`-th frame of [f0, f1) that is kept (cut-out frames never show, so they cannot collide)."""
    keep = set(kept) if kept is not None else None
    return [i for i in range(f0, f1) if keep is None or i in keep][::step]


def span_obstacles(
    crops: Sequence[Rect],
    dest: Rect,
    speakers: Sequence[Face | None],
    texts: Sequence[TextSample],
    fps: float,
    kept: Iterable[int] | None = None,
) -> Callable[[float, float], Obstacles]:
    """span(t0, t1): union of the obstacles over the sampled kept frames between two clip-relative times."""
    keep = set(kept) if kept is not None else None

    def at(index: int) -> Obstacles:
        boxes = visible_text(texts, index / fps)
        return frame_obstacles(crops[index], dest, speakers[index], boxes)

    def span(t0: float, t1: float) -> Obstacles:
        f0, f1 = max(0, round(t0 * fps)), min(round(t1 * fps), len(crops))
        return union(at(i) for i in sample_frames(f0, f1, keep))

    return span


# ---------------------------------------------------------------------------------------------
# Bands and free-space search
# ---------------------------------------------------------------------------------------------


def band(cy: int, w: int, h: int, out_w: int = OUT_W) -> Box:
    """Horizontally centred block of w x h at centre y (blend's geometry), grown by BAND_MARGIN."""
    x0, y0 = out_w // 2 - w // 2, cy - h // 2
    return (
        x0 - BAND_MARGIN,
        y0 - BAND_MARGIN,
        x0 + w + BAND_MARGIN,
        y0 + h + BAND_MARGIN,
    )


def intersects(a: Box, b: Box) -> bool:
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def coverage(area: Box, boxes: Iterable[Box]) -> float:
    """Fraction of `area` covered by `boxes` (overlaps between boxes counted twice, capped at 1)."""
    total = (area[2] - area[0]) * (area[3] - area[1])
    covered = sum(
        max(0.0, min(area[2], b[2]) - max(area[0], b[0]))
        * max(0.0, min(area[3], b[3]) - max(area[1], b[1]))
        for b in boxes
    )
    return min(1.0, covered / total) if total > 0 else 0.0


def clamp_centre(cy: int, h: int) -> int:
    """Centre moved so the block (top = cy - h//2) stays between SAFE_TOP and SAFE_BOTTOM."""
    return min(max(cy, SAFE_TOP + h // 2), SAFE_BOTTOM + h // 2 - h)


def default_caption_y(framing: str, out_h: int = OUT_H) -> int:
    return int(out_h * DEFAULT_Y[framing])


def caption_candidates(framing: str, h: int, out_h: int = OUT_H) -> list[int]:
    """Caption centres to try in order: the framing's default, then CANDIDATES inside the safe zones; "open"
    only keeps positions inside its 4:5 window or below it (never on the blurred band above)."""
    centres = [default_caption_y(framing, out_h)]
    for fraction in CANDIDATES:
        cy = clamp_centre(round(out_h * fraction), h)
        if framing == "open" and cy - h // 2 < OPEN_WINDOW[1]:
            continue
        if cy not in centres:
            centres.append(cy)
    return centres


def free_y(
    centres: Iterable[int], w: int, h: int, obstacles: Sequence[Box]
) -> int | None:
    """First centre whose band clears every obstacle, or None."""
    for cy in centres:
        area = band(cy, w, h)
        if not any(intersects(area, box) for box in obstacles):
            return cy
    return None


def place_caption(framing: str, w: int, h: int, obstacles: Obstacles) -> CaptionPlace:
    """One centre for a whole cue of w x h (ink width, overlay height) given the obstacles across the cue."""
    centres = caption_candidates(framing, h)
    found = free_y(centres, w, h, obstacles.boxes)
    if found is not None:
        return CaptionPlace(found, found != centres[0], False)
    burned = coverage(band(centres[0], w, h), obstacles.texts) > SKIP_COVER
    return CaptionPlace(centres[0], False, burned)


def place_joke(
    default_y: int,
    w: int,
    h: int,
    bottom_limit: int | None,
    framing: str,
    obstacles: Obstacles,
) -> int:
    """Joke centre: its default (above the caption) if clear, else the first clear caption candidate whose
    block bottom stays at or above `bottom_limit` (None = no caption showing); the default when none is."""
    centres = [default_y] + [
        cy
        for cy in caption_candidates(framing, h)[1:]
        if bottom_limit is None or cy - h // 2 + h <= bottom_limit
    ]
    found = free_y(centres, w, h, obstacles.boxes)
    return default_y if found is None else found


def emoji_x(y: int, w: int, h: int, obstacles: Obstacles, out_w: int = OUT_W) -> int:
    """Horizontal centre of a w x h sticker at centre y: the first anchor (centre, left third, right third,
    EMOJI_EDGE px from the edges) clear of every obstacle, the centre when all collide."""
    lo, hi = EMOJI_EDGE + w // 2, out_w - EMOJI_EDGE - (w - w // 2)
    xs = [min(max(x, lo), hi) for x in EMOJI_XS]
    for x in xs:
        x0, y0 = x - w // 2, y - h // 2
        if not any(intersects((x0, y0, x0 + w, y0 + h), b) for b in obstacles.boxes):
            return x
    return xs[0]
