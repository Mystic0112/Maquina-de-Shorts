"""Text already burned into the source video (creator captions, the TikTok watermark), found with OpenCV DNN.

Model: PP-OCRv3 DB text detection from the opencv_zoo (text_detection_en_ppocrv3_2023may.onnx, Apache-2.0),
set up like the zoo's ppocr_det.py: 736x736 input, binary threshold 0.3, polygon threshold 0.5, unclip ratio
2.0, 200 candidates, ImageNet mean and std. The frame is scaled so its long side is 736 and padded on the right
and bottom to the square (letterbox anchored top-left), so the boxes map back with one scale factor.
Pass 1 (detect.py) samples one frame every SAMPLE_SECONDS. Anything that goes wrong (no model, no
dnn_TextDetectionModel_DB, an inference error) is a WARNING and no boxes, never a crash.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any

INPUT_SIZE = 736
BINARY_THRESHOLD = 0.3
POLYGON_THRESHOLD = 0.5
UNCLIP_RATIO = 2.0
MAX_CANDIDATES = 200
MEAN = (123.675, 116.28, 103.53)
STD = (0.229, 0.224, 0.225)
MIN_HEIGHT_FRACTION = 0.01  # of the frame height: shorter boxes are ignored
SAMPLE_SECONDS = 1.0
log = logging.getLogger("cuts.textdetect")

Box = tuple[float, float, float, float]  # x0, y0, x1, y1, source pixels


def load_detector(model_path: str | None) -> Any | None:
    """The configured DB text detector, or None (feature off; a WARNING when a path was given but unusable)."""
    if not model_path:
        return None
    try:
        import cv2

        if not hasattr(cv2, "dnn_TextDetectionModel_DB"):
            raise RuntimeError("this OpenCV build has no dnn_TextDetectionModel_DB")
        if not Path(model_path).is_file():
            raise FileNotFoundError(model_path)
        model = cv2.dnn_TextDetectionModel_DB(cv2.dnn.readNet(model_path))
        model.setBinaryThreshold(BINARY_THRESHOLD)
        model.setPolygonThreshold(POLYGON_THRESHOLD)
        model.setUnclipRatio(UNCLIP_RATIO)
        model.setMaxCandidates(MAX_CANDIDATES)
        model.setInputParams(1.0, (INPUT_SIZE, INPUT_SIZE), MEAN)
        set_scale(model)
    except Exception as exc:  # noqa: BLE001 - optional model: any failure turns the feature off
        log.warning("burned-in text detection off (%s): %r", model_path, exc)
        return None
    return model


def set_scale(model: Any) -> None:
    """1/255/std per channel, as the zoo does; setInputParams only takes one double, setInputScale a Scalar
    (OpenCV >= 4.8). Older builds get the mean std."""
    try:
        model.setInputScale(tuple(1.0 / 255.0 / s for s in STD))
    except TypeError:
        model.setInputScale(1.0 / 255.0 / (sum(STD) / len(STD)))


def boxes_from_quads(
    quads: Iterable[Sequence[Sequence[float]]],
    scale: float,
    frame_w: int,
    frame_h: int,
) -> list[Box]:
    """Axis-aligned boxes in frame pixels from quadrangles found on the frame scaled by `scale` (top-left
    letterbox); clipped to the frame, the ones shorter than MIN_HEIGHT_FRACTION of its height dropped."""
    boxes: list[Box] = []
    for quad in quads:
        xs = [float(p[0]) / scale for p in quad]
        ys = [float(p[1]) / scale for p in quad]
        x0, y0 = max(0.0, min(xs)), max(0.0, min(ys))
        x1, y1 = min(float(frame_w), max(xs)), min(float(frame_h), max(ys))
        if x1 > x0 and y1 - y0 >= MIN_HEIGHT_FRACTION * frame_h:
            boxes.append((x0, y0, x1, y1))
    return boxes


def letterbox(frame: Any) -> tuple[Any, float]:
    """The frame scaled so its long side is INPUT_SIZE and padded black on the right/bottom to a square."""
    import cv2

    h, w = frame.shape[:2]
    scale = INPUT_SIZE / max(h, w)
    size = (min(INPUT_SIZE, round(w * scale)), min(INPUT_SIZE, round(h * scale)))
    small = cv2.resize(frame, size, interpolation=cv2.INTER_AREA)
    pad_b, pad_r = INPUT_SIZE - size[1], INPUT_SIZE - size[0]
    square = cv2.copyMakeBorder(small, 0, pad_b, 0, pad_r, cv2.BORDER_CONSTANT, value=0)
    return square, scale


def detect_text(model: Any, frame: Any) -> list[Box] | None:
    """Text boxes of one BGR frame in its pixels, or None (with a WARNING) when inference fails."""
    try:
        square, scale = letterbox(frame)
        quads, _ = model.detect(square)
    except Exception as exc:  # noqa: BLE001 - optional model: a failure stops the sampling, never the cut
        log.warning("burned-in text detection failed, no more text boxes: %r", exc)
        return None
    return boxes_from_quads(quads, scale, frame.shape[1], frame.shape[0])
