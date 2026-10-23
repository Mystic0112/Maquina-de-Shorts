"""Pass 1 of a cut: face tracks over the clip window and who is speaking in each frame.

YuNet (OpenCV, ONNX from the opencv_zoo) detects faces on a 640-px copy of every frame; detections are
chained into tracks that survive short detection gaps (MAX_MISSED_SECONDS). The speaker per frame comes from
Light-ASD (asd.py) when the job has weights and torch/av/python_speech_features import, otherwise from the
mouth-movement heuristic (mouth-patch difference + hysteresis, speaker.choose_speaker).
When the job has a "textModel", one frame every textdetect.SAMPLE_SECONDS also goes through the burned-in text
detector (textdetect.py); the boxes feed placement.py in pass 2.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

import speaker as spk
import textdetect

if TYPE_CHECKING:
    from render_clip import JobSpec

DETECT_WIDTH = 640
ACTIVITY_EMA = 0.3
MAX_MISSED_SECONDS = 0.4  # a track survives this long without a detection (upstream numFailedDet: 10 at 25 fps)
log = logging.getLogger("cuts.detect")


def open_capture(source: str, start: float):
    import cv2

    cap = cv2.VideoCapture(source)
    if not cap.isOpened():
        raise RuntimeError(
            f"OpenCV cannot open {source} (AV1 source? re-encode to H.264)"
        )
    cap.set(cv2.CAP_PROP_POS_MSEC, start * 1000.0)
    return cap


def mouth_patch(gray, landmarks, box_w: float):
    import cv2

    (rx, ry), (lx, ly) = landmarks[3], landmarks[4]
    cx, cy = (rx + lx) / 2, (ry + ly) / 2
    half = max(abs(lx - rx), 0.3 * box_w) * 0.6
    x0, x1 = int(max(cx - half, 0)), int(min(cx + half, gray.shape[1]))
    y0, y1 = int(max(cy - half * 0.6, 0)), int(min(cy + half * 0.6, gray.shape[0]))
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None
    return cv2.resize(gray[y0:y1, x0:x1], (32, 16), interpolation=cv2.INTER_AREA)


def mouth_delta(patch, previous) -> float:
    import numpy as np

    if patch is None or previous is None or previous.shape != patch.shape:
        return 0.0
    return float(np.mean(np.abs(patch.astype(np.int16) - previous.astype(np.int16))))


def analyze(job: JobSpec) -> dict[str, Any]:
    """Per-frame faces (source pixels, mouth activity), per-track observations and burned-in text samples
    ((clip-relative seconds, boxes in source pixels), empty without a text model) for the clip window."""
    import cv2

    cap = open_capture(job.source, job.start)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    src_w, src_h = (
        int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
        int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
    )
    scale = DETECT_WIDTH / src_w
    det_size = (DETECT_WIDTH, round(src_h * scale))
    detector = cv2.FaceDetectorYN.create(
        job.yunet, "", det_size, score_threshold=0.7, nms_threshold=0.3, top_k=50
    )
    max_missed = max(1, round(MAX_MISSED_SECONDS * fps))
    text_model = textdetect.load_detector(job.text_model)
    text_every = max(1, round(textdetect.SAMPLE_SECONDS * fps))
    texts: list[tuple[float, list[textdetect.Box]]] = []
    frames: list[list[spk.Face]] = []
    observations: dict[int, list[tuple[int, float, float, float, float]]] = {}
    alive: dict[int, tuple[spk.Face, int]] = {}
    patches: dict[int, Any] = {}
    activity: dict[int, float] = {}
    next_id = 0
    while True:
        pos = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
        ok, frame = cap.read()
        if not ok or pos >= job.end - 1e-3:
            break
        index = len(frames)
        if text_model is not None and index % text_every == 0:
            boxes = textdetect.detect_text(text_model, frame)
            if boxes is None:
                text_model = None
            else:
                texts.append((index / fps, boxes))
        small = cv2.resize(frame, det_size, interpolation=cv2.INTER_AREA)
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        _, found = detector.detect(small)
        rows = [] if found is None else [row for row in found if row[14] >= 0.7]
        detections = [
            ((r[0] + r[2] / 2) / scale, (r[1] + r[3] / 2) / scale, r[2] / scale)
            for r in rows
        ]
        recent = [f for f, seen in alive.values() if index - seen <= max_missed]
        pairs, next_id = spk.assign_tracks(recent, detections, next_id)
        faces: list[spk.Face] = []
        for det_index, track_id in pairs:
            row = rows[det_index]
            landmarks = [(row[4 + 2 * k], row[5 + 2 * k]) for k in range(5)]
            patch = mouth_patch(gray, landmarks, row[2])
            delta = mouth_delta(patch, patches.get(track_id))
            if patch is not None:
                patches[track_id] = patch
            activity[track_id] = (
                activity.get(track_id, 0.0) * (1 - ACTIVITY_EMA) + delta * ACTIVITY_EMA
            )
            cx, cy, width = detections[det_index]
            height = float(row[3] / scale)
            face = spk.Face(track_id, cx, cy, width, activity[track_id], height)
            faces.append(face)
            alive[track_id] = (face, index)
            observations.setdefault(track_id, []).append((index, cx, cy, width, height))
        frames.append(faces)
    cap.release()
    return {
        "fps": fps,
        "width": src_w,
        "height": src_h,
        "frames": len(frames),
        "faces": frames,
        "observations": observations,
        "faces_seen": next_id,
        "texts": texts,
    }


def asd_speakers(
    job: JobSpec, analysis: dict[str, Any]
) -> tuple[list[spk.Face | None], list[list[spk.Face]]]:
    import asd
    import asd_math

    fps = analysis["fps"]
    capture = open_capture(job.source, job.start)
    try:
        tracks = asd.score_tracks(
            capture,
            job.source,
            job.start,
            job.end,
            fps,
            analysis["observations"],
            str(job.asd_model),
        )
    finally:
        capture.release()
    scored = asd_math.dense_faces(tracks, fps, analysis["frames"])
    speakers = spk.choose_speaker_by_score(
        scored,
        round(job.hold_seconds * fps),
        round(spk.SILENCE_HOLD_SECONDS * fps),
    )
    return speakers, scored


def pick_speakers(
    job: JobSpec, analysis: dict[str, Any]
) -> tuple[list[spk.Face | None], str, list[list[spk.Face]] | None]:
    """Speaker per frame, the method used ("light-asd" or "mouth") and the per-frame ASD-scored faces."""
    if job.asd_model:
        try:
            speakers, scored = asd_speakers(job, analysis)
            return speakers, "light-asd", scored
        except Exception as exc:  # noqa: BLE001 - optional model: any failure falls back, reported in the result
            log.warning("Light-ASD unavailable, using the mouth heuristic: %r", exc)
    hold = round(job.hold_seconds * analysis["fps"])
    return spk.choose_speaker(analysis["faces"], hold), "mouth", None
