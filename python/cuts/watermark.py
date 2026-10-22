"""The owner's watermark on a cut: an optional PNG above an optional text line, faded by `opacity`.

Job JSON (top level, optional): "watermark": null | {"text": str | null, "image": absolute PNG path | null,
"position": one of POSITIONS, "opacity": 0.1-1.0, "size": 5-40 (% of the output width: the image width;
for text, about 6x the cap height)}. The overlay is built once per clip and blended on every frame,
48 px from the edges and never above SAFE_TOP or below SAFE_BOTTOM (YouTube Shorts UI).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import compose as cmp

POSITIONS = ("top-left", "top-right", "bottom-left", "bottom-right", "top", "bottom")
MARGIN = 48
SAFE_TOP = 150
SAFE_BOTTOM = cmp.OUT_H - 420
CAP_HEIGHT_EM = 0.7  # cap height / font size, roughly, for bold sans fonts
TEXT_GAP = 12  # px between the image and the text
log = logging.getLogger("cuts.watermark")


@dataclass(frozen=True)
class Watermark:
    text: str | None
    image: str | None
    position: str
    opacity: float
    size: float


def parse_watermark(raw: Any) -> Watermark | None:
    """Validated watermark spec, or None when absent or with neither text nor image."""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError(f"watermark must be an object or null, got {raw!r}")  # noqa: TRY004 - main() maps ValueError to exit 2
    text = str(raw.get("text") or "").strip() or None
    image = raw.get("image") or None
    if text is None and image is None:
        return None
    position = raw.get("position", "bottom-right")
    opacity = float(raw.get("opacity", 0.8))
    size = float(raw.get("size", 15))
    if position not in POSITIONS:
        raise ValueError(f"watermark position must be one of {POSITIONS}: {position!r}")
    if not 0.1 <= opacity <= 1.0 or not 5 <= size <= 40:
        raise ValueError(f"watermark opacity 0.1-1.0 and size 5-40: {opacity}, {size}")
    return Watermark(text, image, position, opacity, size)


def origin(
    position: str, width: int, height: int, out_w: int = cmp.OUT_W
) -> tuple[int, int]:
    """Top-left corner of a width x height overlay at `position`, inside the margins and safe zones."""
    if position.endswith("left"):
        x = MARGIN
    elif position.endswith("right"):
        x = out_w - MARGIN - width
    else:
        x = (out_w - width) // 2
    y = max(MARGIN, SAFE_TOP) if position.startswith("top") else SAFE_BOTTOM - height
    return x, max(SAFE_TOP, y)


def trim(overlay):
    """Crops a BGRA overlay to its non-transparent pixels."""
    import numpy as np

    ys, xs = np.nonzero(overlay[:, :, 3])
    if ys.size == 0:
        return overlay
    return overlay[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1]


def load_image(path: str, width: int, label: str = "watermark image"):
    """BGRA numpy image of the PNG scaled to `width`, or None (with a warning) when it cannot be read."""
    import numpy as np
    from PIL import Image

    try:
        with Image.open(path) as image:
            rgba = image.convert("RGBA")
    except (OSError, ValueError) as exc:
        log.warning("%s %s unreadable, skipping it: %s", label, path, exc)
        return None
    height = max(1, round(rgba.height * width / rgba.width))
    scaled = rgba.resize((width, height), Image.Resampling.LANCZOS)
    return np.array(scaled)[:, :, [2, 1, 0, 3]]


def build_overlay(spec: Watermark, font_path: str | None):
    """BGRA overlay (image above text, centred), alpha scaled by the opacity; None if nothing is drawable."""
    import numpy as np

    width = round(spec.size / 100 * cmp.OUT_W)
    parts = []
    if spec.image:
        image = load_image(spec.image, width)
        if image is not None:
            parts.append(image)
    if spec.text:
        font_size = max(8, round(width / 6 / CAP_HEIGHT_EM))
        text = cmp.text_overlay(
            spec.text, font_path, font_size, (255, 255, 255), cmp.OUT_W - 2 * MARGIN
        )
        parts.append(trim(text))
    if not parts:
        return None
    out_w = max(p.shape[1] for p in parts)
    out_h = sum(p.shape[0] for p in parts) + TEXT_GAP * (len(parts) - 1)
    overlay = np.zeros((out_h, out_w, 4), np.uint8)
    y = 0
    for part in parts:
        x = (out_w - part.shape[1]) // 2
        overlay[y : y + part.shape[0], x : x + part.shape[1]] = part
        y += part.shape[0] + TEXT_GAP
    overlay[:, :, 3] = (overlay[:, :, 3] * spec.opacity).astype(np.uint8)
    return overlay
