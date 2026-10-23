"""Humor layer of a cut, in the style of @oguxtamedia: jokes between asterisks, reaction emoji, quick effects.

Job JSON (per job, optional): "humor": null | {"jokes": [{"start", "end", "text"}],
"emojis": [{"start", "end", "image": absolute PNG path}],
"effects": [{"start", "end", "type": "punch" | "spotlight" | "flash", "text": str | null}]}.
Times are absolute source seconds, like "keep"; items inside cut-out stretches never show. A malformed or
overlapping item is skipped with a warning, never an error.

Per frame (render_clip.py): punch and spotlight shrink the camera crop around its centre before the resize
(so it stays sharp); spotlight then greys the frame and draws a crosshair on the speaker, flash tints it red
with a big word; after the captions come the joke (above the caption when one is visible) and the emoji
(above the highest text line). The "open" framing skips punch and spotlight. With obstacles (placement.py:
the speaker's face, burned-in text), a joke moves to the first clear band that keeps it above the caption and
an emoji to the first clear anchor (centre, left third, right third); the vertical rules stay the same.
Timing and geometry helpers are pure; HumorLayer holds the overlays built once per clip.
"""

from __future__ import annotations

import logging
import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

import compose as cmp
import placement as pl
import watermark as wm
from speaker import Face

KINDS = ("jokes", "emojis", "effects")
EFFECT_TYPES = ("punch", "spotlight", "flash")
WHITE = (255, 255, 255)
JOKE_SIZE = 52
FADE_SECONDS = 0.12
JOKE_RAISE = 150  # px between the caption centre and the joke centre when both show
TEXT_GAP = (
    20  # px kept between the joke and the caption when they wrap to several lines
)
EMOJI_WIDTH = 150
EMOJI_GAP = 40  # px between the emoji's bottom edge and the highest text line
POP_SECONDS = 0.15
POP_FROM = 0.6
PUNCH_ZOOM = 1.06
PUNCH_IN_SECONDS = 0.08
PUNCH_OUT_SECONDS = 0.15
SPOTLIGHT_ZOOM = 1.03
LINE_PX = 4
CROSS_GAP = 25  # px from the crosshair centre to where each arm starts
CROSS_ARM = 130  # px from the crosshair centre to where each arm ends
RING_RADIUS = 60
FLASH_ALPHA = 0.35
FLASH_RED = (0, 0, 255)  # BGR
FLASH_SIZE = 120
FLASH_OUTLINE = (0, 0, 139)  # BGR, dark red
FLASH_STROKE = FLASH_SIZE // 8
log = logging.getLogger("cuts.humor")

Rect = tuple[int, int, int, int]  # left, top, width, height (source pixels)


@dataclass(frozen=True)
class Item:
    start: float  # absolute source seconds
    end: float
    text: str | None = None  # the joke, or the flash word
    image: str | None = None  # emoji PNG
    kind: str | None = None  # effect type


@dataclass(frozen=True)
class Humor:
    jokes: tuple[Item, ...] = ()
    emojis: tuple[Item, ...] = ()
    effects: tuple[Item, ...] = ()


# ---------------------------------------------------------------------------------------------
# Parsing (defensive: a bad item is dropped with a warning)
# ---------------------------------------------------------------------------------------------


def _span(raw: dict[str, Any]) -> tuple[float, float]:
    start, end = float(raw["start"]), float(raw["end"])
    if not (math.isfinite(start) and math.isfinite(end)) or end <= start:
        raise ValueError(f"needs finite start < end, got {start}-{end}")
    return start, end


def _joke(raw: dict[str, Any]) -> Item:
    text = str(raw.get("text") or "").strip()
    if not text:
        raise ValueError("empty text")
    return Item(*_span(raw), text=text)


def _emoji(raw: dict[str, Any]) -> Item:
    image = raw.get("image")
    if not isinstance(image, str) or not image.strip():
        raise ValueError("needs an image path")
    return Item(*_span(raw), image=image)


def _effect(raw: dict[str, Any]) -> Item:
    kind = raw.get("type")
    if kind not in EFFECT_TYPES:
        raise ValueError(f"type must be one of {EFFECT_TYPES}")
    text = str(raw.get("text") or "").strip() or None
    return Item(*_span(raw), text=text, kind=kind)


def _parse_items(
    raw_list: Any, label: str, build: Callable[[dict[str, Any]], Item]
) -> tuple[Item, ...]:
    """Valid items sorted by start; malformed ones and ones overlapping the previous kept one are dropped."""
    if raw_list is None:
        return ()
    if not isinstance(raw_list, list):
        log.warning("humor %s must be a list, ignoring it: %r", label, raw_list)
        return ()
    items: list[Item] = []
    for raw in raw_list:
        try:
            if not isinstance(raw, dict):
                raise ValueError("not an object")  # noqa: TRY004 - caught right below
            items.append(build(raw))
        except (KeyError, TypeError, ValueError) as exc:
            log.warning("humor %s item skipped (%s): %r", label, exc, raw)
    kept: list[Item] = []
    for item in sorted(items, key=lambda i: i.start):
        if kept and item.start < kept[-1].end:
            log.warning(
                "humor %s item overlaps the previous one, skipped: %r", label, item
            )
            continue
        kept.append(item)
    return tuple(kept)


def parse_humor(raw: Any) -> Humor | None:
    """The job's humor plan, or None when absent, not an object or with nothing valid in it."""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        log.warning("humor must be an object or null, ignoring it: %r", raw)
        return None
    humor = Humor(
        _parse_items(raw.get("jokes"), "jokes", _joke),
        _parse_items(raw.get("emojis"), "emojis", _emoji),
        _parse_items(raw.get("effects"), "effects", _effect),
    )
    return humor if humor.jokes or humor.emojis or humor.effects else None


# ---------------------------------------------------------------------------------------------
# Timing and geometry (pure)
# ---------------------------------------------------------------------------------------------


def active(items: Sequence[Item], t: float) -> int | None:
    """Index of the item showing at time t (items sorted and non-overlapping)."""
    for index, item in enumerate(items):
        if item.start <= t < item.end:
            return index
        if item.start > t:
            break
    return None


def _clamp01(x: float) -> float:
    return min(1.0, max(0.0, x))


def ease_out(x: float) -> float:
    """Cubic ease-out on [0, 1]: fast start, soft landing."""
    return 1 - (1 - _clamp01(x)) ** 3


def smoothstep(x: float) -> float:
    """Smooth ease-in-out on [0, 1]: soft start and soft landing."""
    x = _clamp01(x)
    return x * x * (3 - 2 * x)


def fade_alpha(item: Item, t: float, fade: float = FADE_SECONDS) -> float:
    """Opacity at time t: ramps up over `fade` after the start and down over `fade` before the end."""
    if not item.start <= t < item.end:
        return 0.0
    return _clamp01(min((t - item.start) / fade, (item.end - t) / fade))


def pop_scale(item: Item, t: float) -> float:
    """Emoji scale: POP_FROM to 1.0 over POP_SECONDS with an ease-out, then 1.0."""
    return POP_FROM + (1 - POP_FROM) * ease_out((t - item.start) / POP_SECONDS)


def punch_factor(item: Item, t: float) -> float:
    """Extra zoom of a punch: snaps to PUNCH_ZOOM in PUNCH_IN_SECONDS (ease-out), settles back to 1 over the last
    PUNCH_OUT_SECONDS (smoothstep, so it lands softly instead of jumping on the last frame)."""
    if not item.start <= t < item.end:
        return 1.0
    rise = (t - item.start) / PUNCH_IN_SECONDS
    fall = (item.end - t) / PUNCH_OUT_SECONDS
    return 1 + (PUNCH_ZOOM - 1) * min(ease_out(rise), smoothstep(fall))


def effect_zoom(item: Item | None, t: float) -> float:
    if item is None:
        return 1.0
    if item.kind == "punch":
        return punch_factor(item, t)
    return SPOTLIGHT_ZOOM if item.kind == "spotlight" else 1.0


def flash_alpha(item: Item, t: float) -> float:
    """Red tint opacity: FLASH_ALPHA at the start, down to 0 at the end."""
    if not item.start <= t < item.end:
        return 0.0
    return FLASH_ALPHA * _clamp01((item.end - t) / (item.end - item.start))


def zoom_rect(rect: Rect, factor: float) -> Rect:
    """The crop rect shrunk by `factor` around its centre (stays inside the original rect)."""
    if factor <= 1.0:
        return rect
    left, top, width, height = rect
    w, h = max(2, round(width / factor)), max(2, round(height / factor))
    return left + (width - w) // 2, top + (height - h) // 2, w, h


def crosshair_center(
    rect: Rect, face: Face | None, out_w: int = cmp.OUT_W, out_h: int = cmp.OUT_H
) -> tuple[int, int]:
    """Speaker's face centre in output pixels for a frame cropped to `rect`; the frame centre without a
    speaker or when the face is outside the crop."""
    centre = (out_w // 2, out_h // 2)
    if face is None:
        return centre
    left, top, width, height = rect
    x = (face.cx - left) * out_w / width
    y = (face.cy - top) * out_h / height
    if not (0 <= x < out_w and 0 <= y < out_h):
        return centre
    return round(x), round(y)


def stack_layout(
    caption_y: int,
    caption_h: int | None,
    joke_h: int | None,
    emoji_h: int | None,
) -> tuple[int | None, int | None]:
    """Centre y of the joke and of the emoji (None when absent), given the caption centre and overlay heights.

    The joke sits on the caption line when no caption shows, otherwise JOKE_RAISE px above it (more if both
    wrap); the emoji's bottom edge sits EMOJI_GAP px above the highest text line (the caption line if none).
    """
    top = caption_y - caption_h // 2 if caption_h else caption_y
    joke_y = None
    if joke_h:
        joke_y = caption_y
        if caption_h:
            joke_y -= max(JOKE_RAISE, (caption_h + joke_h) // 2 + TEXT_GAP)
        top = joke_y - joke_h // 2
    emoji_y = top - EMOJI_GAP - emoji_h // 2 if emoji_h else None
    return joke_y, emoji_y


# ---------------------------------------------------------------------------------------------
# Drawing (OpenCV / Pillow)
# ---------------------------------------------------------------------------------------------


def _scaled(image, scale: float):
    import cv2

    if scale >= 0.999:
        return image
    size = (
        max(1, round(image.shape[1] * scale)),
        max(1, round(image.shape[0] * scale)),
    )
    return cv2.resize(image, size, interpolation=cv2.INTER_AREA)


def _spotlight(out, center: tuple[int, int]) -> None:
    """Greys the frame in place and draws the crosshair (gapped cross + ring) at `center`."""
    import cv2

    out[:] = cv2.cvtColor(cv2.cvtColor(out, cv2.COLOR_BGR2GRAY), cv2.COLOR_GRAY2BGR)
    x, y = center
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        start = (x + dx * CROSS_GAP, y + dy * CROSS_GAP)
        end = (x + dx * CROSS_ARM, y + dy * CROSS_ARM)
        cv2.line(out, start, end, WHITE, LINE_PX, cv2.LINE_AA)
    cv2.circle(out, center, RING_RADIUS, WHITE, LINE_PX, cv2.LINE_AA)


class HumorLayer:
    """One clip's humor overlays, built once; draws them per frame and records which items showed."""

    def __init__(
        self,
        humor: Humor,
        font_path: str | None,
        framing: str,
        obstacles_for: Callable[[float, float], pl.Obstacles] | None = None,
    ) -> None:
        """`obstacles_for(start, end)`: what jokes and emoji must avoid between two absolute source seconds."""
        import numpy as np

        self.humor = humor
        self.framing = framing
        self.camera_effects = framing == "face"
        width = int(cmp.OUT_W * 0.9)
        self.jokes = [
            cmp.text_overlay(j.text or "", font_path, JOKE_SIZE, WHITE, width)
            for j in humor.jokes
        ]
        self.words = [
            cmp.text_overlay(
                e.text, font_path, FLASH_SIZE, WHITE, width, FLASH_OUTLINE, FLASH_STROKE
            )
            if e.kind == "flash" and e.text
            else None
            for e in humor.effects
        ]
        paths = {e.image for e in humor.emojis if e.image}
        self.emojis = {p: wm.load_image(p, EMOJI_WIDTH, "emoji") for p in paths}
        self.joke_widths = [wm.trim(j).shape[1] for j in self.jokes]
        span = obstacles_for or (lambda _t0, _t1: pl.Obstacles())
        self.joke_obstacles = [span(j.start, j.end) for j in humor.jokes]
        self.emoji_obstacles = [span(e.start, e.end) for e in humor.emojis]
        self.emojis_moved: set[int] = set()
        self.red = np.full((cmp.OUT_H, cmp.OUT_W, 3), FLASH_RED, np.uint8)
        self.seen: set[tuple[str, int]] = set()

    def _effect(self, t: float) -> tuple[int, Item] | None:
        index = active(self.humor.effects, t)
        if index is None:
            return None
        item = self.humor.effects[index]
        if item.kind != "flash" and not self.camera_effects:
            return None
        self.seen.add(("effects", index))
        return index, item

    def crop(self, rect: Rect, t: float) -> Rect:
        """The camera crop shrunk for an active punch or spotlight (call it for the face framing only)."""
        found = self._effect(t)
        return zoom_rect(rect, effect_zoom(found[1] if found else None, t))

    def draw_effects(self, out, t: float, rect: Rect | None, face: Face | None) -> None:
        """Spotlight (grey + crosshair on `face`) or flash (red tint + word); `rect` is the final crop."""
        found = self._effect(t)
        if found is None:
            return
        index, item = found
        if item.kind == "spotlight" and rect is not None:
            _spotlight(out, crosshair_center(rect, face, out.shape[1], out.shape[0]))
        elif item.kind == "flash":
            import cv2

            alpha = flash_alpha(item, t)
            cv2.addWeighted(out, 1 - alpha, self.red, alpha, 0, dst=out)
            word = self.words[index]
            if word is not None:
                cmp.blend(
                    out, word, out.shape[1] // 2, out.shape[0] // 2, fade_alpha(item, t)
                )

    def draw_text(self, out, t: float, caption_h: int | None, caption_y: int) -> None:
        """Joke and emoji over the captions; `caption_h` is the visible caption overlay's height, or None."""
        j, e = active(self.humor.jokes, t), active(self.humor.emojis, t)
        joke = self.jokes[j] if j is not None else None
        emoji = (
            self.emojis.get(self.humor.emojis[e].image or "") if e is not None else None
        )
        joke_y, emoji_y = stack_layout(
            caption_y,
            caption_h,
            joke.shape[0] if joke is not None else None,
            emoji.shape[0] if emoji is not None else None,
        )
        if j is not None and joke is not None and joke_y is not None:
            limit = caption_y - caption_h // 2 - TEXT_GAP if caption_h else None
            joke_y = pl.place_joke(
                joke_y,
                self.joke_widths[j],
                joke.shape[0],
                limit,
                self.framing,
                self.joke_obstacles[j],
            )
            if emoji is not None:  # still above the highest text line
                emoji_y = joke_y - joke.shape[0] // 2 - EMOJI_GAP - emoji.shape[0] // 2
            cmp.blend(
                out, joke, cmp.OUT_W // 2, joke_y, fade_alpha(self.humor.jokes[j], t)
            )
            self.seen.add(("jokes", j))
        if e is not None and emoji is not None and emoji_y is not None:
            x = pl.emoji_x(
                emoji_y, emoji.shape[1], emoji.shape[0], self.emoji_obstacles[e]
            )
            if x != cmp.OUT_W // 2:
                self.emojis_moved.add(e)
            scale = pop_scale(self.humor.emojis[e], t)
            cmp.blend(out, _scaled(emoji, scale), x, emoji_y)
            self.seen.add(("emojis", e))

    def counts(self) -> dict[str, int]:
        """How many items of each kind showed in the rendered frames."""
        return {kind: sum(1 for k, _ in self.seen if k == kind) for kind in KINDS}
