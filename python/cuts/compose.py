"""Frame composition for cuts: outlined caption/credit overlays and the two framings (face, open)."""

from __future__ import annotations

from typing import Any

OUT_W, OUT_H = 1080, 1920
OPEN_W, OPEN_H = 1080, 1350


def text_overlay(
    text: str,
    font_path: str | None,
    size: int,
    color_bgr: tuple[int, int, int],
    max_width: int,
):
    """BGRA numpy image of `text` (outlined, wrapped to max_width)."""
    import numpy as np
    from PIL import Image, ImageDraw, ImageFont

    font = (
        ImageFont.truetype(font_path, size)
        if font_path
        else ImageFont.load_default(size)
    )
    words = text.split()
    lines: list[str] = []
    current = ""
    probe = ImageDraw.Draw(Image.new("RGBA", (4, 4)))
    for word in words:
        candidate = f"{current} {word}".strip()
        if current and probe.textlength(candidate, font=font) > max_width:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    stroke = max(2, size // 12)
    line_h = int(size * 1.25)
    image = Image.new(
        "RGBA", (max_width + 2 * stroke, line_h * len(lines) + 2 * stroke), (0, 0, 0, 0)
    )
    draw = ImageDraw.Draw(image)
    b, g, r = color_bgr
    for index, line in enumerate(lines):
        width = probe.textlength(line, font=font)
        x = (image.width - width) / 2
        draw.text(
            (x, stroke + index * line_h),
            line,
            font=font,
            fill=(r, g, b, 255),
            stroke_width=stroke,
            stroke_fill=(0, 0, 0, 255),
        )
    rgba = np.array(image)
    return rgba[:, :, [2, 1, 0, 3]]


def blend(frame, overlay, center_x: int, center_y: int) -> None:
    """Alpha-blends a BGRA overlay onto the BGR frame in place, centred at (center_x, center_y)."""
    import numpy as np

    h, w = overlay.shape[:2]
    x0, y0 = center_x - w // 2, center_y - h // 2
    x1, y1 = min(x0 + w, frame.shape[1]), min(y0 + h, frame.shape[0])
    ox, oy = max(0, -x0), max(0, -y0)
    x0, y0 = max(x0, 0), max(y0, 0)
    if x1 <= x0 or y1 <= y0:
        return
    patch = overlay[oy : oy + (y1 - y0), ox : ox + (x1 - x0)]
    alpha = patch[:, :, 3:4].astype(np.float32) / 255.0
    region = frame[y0:y1, x0:x1].astype(np.float32)
    frame[y0:y1, x0:x1] = (
        region * (1 - alpha) + patch[:, :, :3].astype(np.float32) * alpha
    ).astype(np.uint8)


def compose_face(
    frame, left: int, crop_w: int, top: int = 0, crop_h: int | None = None
):
    """The crop window (full height unless `crop_h`) scaled to the 1080x1920 output."""
    import cv2

    bottom = frame.shape[0] if crop_h is None else top + crop_h
    return cv2.resize(
        frame[top:bottom, left : left + crop_w],
        (OUT_W, OUT_H),
        interpolation=cv2.INTER_CUBIC,
    )


def compose_open(frame, left: int, crop_w: int, canvas_cache: dict[str, Any]):
    import cv2

    src_h, src_w = frame.shape[:2]
    bg_crop_w = round(src_h * OUT_W / OUT_H)
    bg_left = max(0, (src_w - bg_crop_w) // 2)
    small = cv2.resize(
        frame[:, bg_left : bg_left + bg_crop_w],
        (OUT_W // 6, OUT_H // 6),
        interpolation=cv2.INTER_AREA,
    )
    blurred = cv2.GaussianBlur(small, (0, 0), 6)
    canvas = cv2.resize(blurred, (OUT_W, OUT_H), interpolation=cv2.INTER_LINEAR)
    canvas = (canvas * 0.55).astype("uint8")
    window = cv2.resize(
        frame[:, left : left + crop_w], (OPEN_W, OPEN_H), interpolation=cv2.INTER_CUBIC
    )
    top = canvas_cache.setdefault("top", (OUT_H - OPEN_H) // 2)
    canvas[top : top + OPEN_H, :] = window
    return canvas
