"""Pure parts of the Light-ASD inference (numpy only, no torch/OpenCV), following upstream Columbia_test.py:
https://github.com/Junhua-Liao/Light-ASD/blob/ed38c232de5efe0261dbd68627c0ade7cdfe14eb/Columbia_test.py

The model sees each face track at 25 fps: sample j is the source frame nearest to time j / 25 (counted from
the clip start). Boxes are interpolated over detection gaps, median-smoothed, and cropped like upstream
crop_video; scores per sample are averaged over several chunk durations, smoothed over 5 samples, and mapped
back to the source frames as Face observations whose `activity` is the ASD score (> 0 = speaking).
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, field

import numpy as np

from speaker import Face

SAMPLE_FPS = 25
AUDIO_PER_VIDEO = 4  # MFCC at 100 frames/s against video at 25 fps
SAMPLES_PER_FRAME = 16_000 // SAMPLE_FPS  # 640 audio samples at 16 kHz per 25-fps frame
CROP_SCALE = 0.40
CROP_FILL = 110
MEDIAN_KERNEL = 13
# Upstream writes {1,1,1,2,2,2,3,3,4,5,6}, which as a Python set is {1, 2, 3, 4, 5, 6}.
DURATIONS = (1, 2, 3, 4, 5, 6)
MIN_TRACK_SAMPLES = 10  # upstream minTrack
SMOOTH_RADIUS = 2  # 5-sample moving average


@dataclass
class TrackSamples:
    j0: int  # first 25-fps sample of the track
    boxes: (
        np.ndarray
    )  # (n, 4): cx, cy, w, h in full-resolution source pixels, one row per sample
    scores: list[float] = field(default_factory=list)


def source_index(j: int, fps: float) -> int:
    """Source frame shown at 25-fps sample j."""
    return round(j * fps / SAMPLE_FPS)


def sample_index(i: int, fps: float) -> int:
    """25-fps sample nearest to source frame i."""
    return round(i * SAMPLE_FPS / fps)


def track_samples(
    observations: Sequence[tuple[int, float, float, float, float]], fps: float
) -> TrackSamples | None:
    """25-fps samples of a track observed at (source frame, cx, cy, w, h); gaps are linearly interpolated."""
    if not observations:
        return None
    first, last = observations[0][0], observations[-1][0]
    j0, j1 = sample_index(first, fps), sample_index(last, fps)
    if source_index(j0, fps) < first:
        j0 += 1
    if source_index(j1, fps) > last:
        j1 -= 1
    if j1 < j0:
        return None
    src = [source_index(j, fps) for j in range(j0, j1 + 1)]
    obs = np.asarray(observations, dtype=np.float64)
    boxes = np.stack(
        [np.interp(src, obs[:, 0], obs[:, c]) for c in range(1, 5)], axis=1
    )
    return TrackSamples(j0, boxes)


def median_smooth(values: Sequence[float], kernel: int = MEDIAN_KERNEL) -> np.ndarray:
    """Running median; the window shrinks at the edges (upstream's scipy medfilt pads with zeros instead)."""
    data = np.asarray(values, dtype=np.float64)
    half = kernel // 2
    return np.array(
        [np.median(data[max(0, i - half) : i + half + 1]) for i in range(data.size)]
    )


def crop_box(
    cx: float, cy: float, half_size: float, scale: float = CROP_SCALE
) -> tuple[int, int, int, int]:
    """(x0, y0, x1, y1) of upstream's face crop: from half a box above the centre to 1.8 boxes below, 1.4 to
    each side (scale 0.4); may fall outside the frame (filled with grey 110 by `padded_region`)."""
    return (
        math.floor(cx - half_size * (1 + scale)),
        math.floor(cy - half_size),
        math.floor(cx + half_size * (1 + scale)),
        math.floor(cy + half_size * (1 + 2 * scale)),
    )


def crop_boxes(boxes: np.ndarray) -> list[tuple[int, int, int, int]]:
    """Crop boxes for every sample: half size max(w, h) / 2 and centres median-smoothed over the track."""
    s = median_smooth(np.maximum(boxes[:, 2], boxes[:, 3]) / 2)
    x, y = median_smooth(boxes[:, 0]), median_smooth(boxes[:, 1])
    return [crop_box(x[k], y[k], s[k]) for k in range(len(s))]


def padded_region(frame: np.ndarray, box: tuple[int, int, int, int]) -> np.ndarray:
    """frame[y0:y1, x0:x1] where the parts outside the frame are filled with CROP_FILL."""
    x0, y0, x1, y1 = box
    height, width = frame.shape[:2]
    out = np.full((y1 - y0, x1 - x0, *frame.shape[2:]), CROP_FILL, dtype=frame.dtype)
    sx0, sy0, sx1, sy1 = max(x0, 0), max(y0, 0), min(x1, width), min(y1, height)
    if sx1 > sx0 and sy1 > sy0:
        out[sy0 - y0 : sy1 - y0, sx0 - x0 : sx1 - x0] = frame[sy0:sy1, sx0:sx1]
    return out


def aligned_lengths(n_audio: int, n_video: int) -> tuple[int, int]:
    """(audio frames, video frames) both models see: upstream's min((A - A % 4) / 100, V / 25) seconds."""
    n = min((n_audio - n_audio % AUDIO_PER_VIDEO) // AUDIO_PER_VIDEO, n_video)
    return n * AUDIO_PER_VIDEO, n


def chunk_bounds(n_video: int, duration: int) -> list[tuple[int, int]]:
    """Video frame ranges of `duration`-second chunks (the audio range is 4x each bound)."""
    size = duration * SAMPLE_FPS
    return [(v0, min(v0 + size, n_video)) for v0 in range(0, n_video, size)]


def average_durations(per_duration: Sequence[Sequence[float]]) -> list[float]:
    """Per-sample mean of the scores obtained with each chunk duration (all lists have the same length)."""
    return np.mean(np.asarray(per_duration, dtype=np.float64), axis=0).tolist()


def moving_average(scores: Sequence[float], radius: int = SMOOTH_RADIUS) -> list[float]:
    """Centred moving average over 2 * radius + 1 samples; the window shrinks at the edges."""
    return [
        float(np.mean(scores[max(0, k - radius) : k + radius + 1]))
        for k in range(len(scores))
    ]


def dense_faces(
    tracks: dict[int, TrackSamples], fps: float, n_frames: int
) -> list[list[Face]]:
    """Per source frame, every scored track covering it as a Face with activity = ASD score."""
    frames: list[list[Face]] = [[] for _ in range(n_frames)]
    for track_id, track in tracks.items():
        if not track.scores:
            continue
        for i in range(n_frames):
            k = sample_index(i, fps) - track.j0
            if 0 <= k < len(track.boxes):
                cx, cy, w, h = (float(v) for v in track.boxes[k])
                score = track.scores[min(k, len(track.scores) - 1)]
                frames[i].append(Face(track_id, cx, cy, w, score, h))
    return frames
