"""Cuts a vertical clip out of a landscape source, following the face that is talking.

Reads one JSON job list on stdin (see JobSpec below), renders every clip (one process per clip via
multiprocessing) and prints one JSON object on stdout: {"clips": [{"out", "frames", "seconds", ...}]}.

Per clip: pass 1 decodes the window once at reduced size, detects faces with YuNet (OpenCV, ONNX from the
opencv_zoo), tracks them, scores mouth movement and picks the speaker with hysteresis (speaker.py);
pass 2 decodes again, crops around the smoothed camera path, draws the captions (captions.py + Pillow)
and the channel credit, and pipes raw frames into ffmpeg, which muxes the original audio (libx264 + aac).

Framing "face": full 9:16 crop (the speaker fills the frame). Framing "open": a 4:5 window on a blurred,
darkened background made from the same frame (less zoomed in).
Exit codes: 0 ok, 1 a clip failed, 2 bad input.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from itertools import pairwise
from multiprocessing import Pool
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import captions as caps
import compose as cmp
import speaker as spk

OUT_W, OUT_H = cmp.OUT_W, cmp.OUT_H
DETECT_WIDTH = 640
ACTIVITY_EMA = 0.3
CAPTION_FONT_SIZE = 72
CREDIT_FONT_SIZE = 40
JPEG_QUALITY = (
    95  # pipe frames are re-encoded by libx264; 95 keeps the double encode invisible
)
FONT_CANDIDATES = (
    "C:/Windows/Fonts/impact.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
)
log = logging.getLogger("cuts.render")


@dataclass(frozen=True)
class JobSpec:
    source: str
    yunet: str
    ffmpeg: str
    framing: str
    credit: str
    words_per_cue: int
    color: str
    font: str | None
    hold_seconds: float
    start: float
    end: float
    out: str
    words: list[dict[str, Any]]


def resolve_font(explicit: str | None) -> str | None:
    for candidate in ([explicit] if explicit else []) + list(FONT_CANDIDATES):
        if candidate and Path(candidate).is_file():
            return candidate
    return None


# ---------------------------------------------------------------------------------------------
# Pass 1: faces, mouths, speaker
# ---------------------------------------------------------------------------------------------


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


def analyze(job: JobSpec) -> dict[str, Any]:
    """Per-frame speaker centres (source pixels) for the clip window."""
    import cv2
    import numpy as np

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
    frames: list[list[spk.Face]] = []
    previous: list[spk.Face] = []
    patches: dict[int, Any] = {}
    activity: dict[int, float] = {}
    next_id = 0
    while True:
        pos = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
        ok, frame = cap.read()
        if not ok or pos >= job.end - 1e-3:
            break
        small = cv2.resize(frame, det_size, interpolation=cv2.INTER_AREA)
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        _, found = detector.detect(small)
        rows = [] if found is None else [row for row in found if row[14] >= 0.7]
        detections = [
            ((r[0] + r[2] / 2) / scale, (r[1] + r[3] / 2) / scale, r[2] / scale)
            for r in rows
        ]
        pairs, next_id = spk.assign_tracks(previous, detections, next_id)
        faces: list[spk.Face] = []
        for index, track_id in pairs:
            row = rows[index]
            landmarks = [(row[4 + 2 * k], row[5 + 2 * k]) for k in range(5)]
            patch = mouth_patch(gray, landmarks, row[2])
            delta = 0.0
            if (
                patch is not None
                and track_id in patches
                and patches[track_id].shape == patch.shape
            ):
                delta = float(
                    np.mean(
                        np.abs(
                            patch.astype(np.int16) - patches[track_id].astype(np.int16)
                        )
                    )
                )
            if patch is not None:
                patches[track_id] = patch
            activity[track_id] = (
                activity.get(track_id, 0.0) * (1 - ACTIVITY_EMA) + delta * ACTIVITY_EMA
            )
            cx, cy, width = detections[index]
            faces.append(spk.Face(track_id, cx, cy, width, activity[track_id]))
        frames.append(faces)
        previous = faces
    cap.release()
    chosen = spk.choose_speaker(frames, round(job.hold_seconds * fps))
    switches = sum(
        1 for a, b in pairwise(chosen) if a and b and a.track_id != b.track_id
    )
    return {
        "fps": fps,
        "width": src_w,
        "height": src_h,
        "frames": len(frames),
        "targets": [f.cx if f else None for f in chosen],
        "faces_seen": next_id,
        "speaker_switches": switches,
        "frames_with_face": sum(1 for f in chosen if f),
    }


# ---------------------------------------------------------------------------------------------
# Pass 2: crop, captions, encode
# ---------------------------------------------------------------------------------------------


def ffmpeg_command(job: JobSpec, fps: float) -> list[str]:
    duration = job.end - job.start
    return [
        job.ffmpeg,
        "-y",
        "-v",
        "error",
        # JPEG frames on a pipe: Remotion's reduced ffmpeg has no rawvideo demuxer, only image2pipe + mjpeg/png.
        "-f",
        "image2pipe",
        "-c:v",
        "mjpeg",
        "-framerate",
        f"{fps:.5f}",
        "-i",
        "-",
        "-ss",
        f"{job.start:.3f}",
        "-t",
        f"{duration:.3f}",
        "-i",
        job.source,
        "-map",
        "0:v:0",
        "-map",
        "1:a:0?",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-movflags",
        "+faststart",
        "-shortest",
        job.out,
    ]


def render(job: JobSpec, analysis: dict[str, Any]) -> int:
    import cv2

    src_w, src_h, fps = analysis["width"], analysis["height"], analysis["fps"]
    crop_w = min(src_w, round(src_h * (9 / 16 if job.framing == "face" else 4 / 5)))
    path = spk.smooth_path(analysis["targets"], src_w)
    cues = caps.build_cues(job.words, job.start, job.end, job.words_per_cue)
    font = resolve_font(job.font)
    color = caps.hex_to_bgr(job.color)
    overlays = {
        cue.text: cmp.text_overlay(
            cue.text, font, CAPTION_FONT_SIZE, color, int(OUT_W * 0.9)
        )
        for cue in cues
    }
    credit = (
        cmp.text_overlay(
            job.credit, font, CREDIT_FONT_SIZE, (255, 255, 255), int(OUT_W * 0.9)
        )
        if job.credit
        else None
    )
    caption_y = int(OUT_H * 0.70) if job.framing == "face" else int(OUT_H * 0.915)
    credit_y = int(OUT_H * 0.075)
    cache: dict[str, Any] = {}
    Path(job.out).parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.Popen(
        ffmpeg_command(job, fps), stdin=subprocess.PIPE, stderr=subprocess.PIPE
    )
    assert proc.stdin is not None
    cap = open_capture(job.source, job.start)
    written = 0
    try:
        for index in range(len(path)):
            ok, frame = cap.read()
            if not ok:
                break
            left = spk.clamp_window(path[index], crop_w, src_w)
            out = (
                cmp.compose_face(frame, left, crop_w)
                if job.framing == "face"
                else cmp.compose_open(frame, left, crop_w, cache)
            )
            cue = caps.cue_at(cues, index / fps)
            if cue:
                cmp.blend(out, overlays[cue.text], OUT_W // 2, caption_y)
            if credit is not None:
                cmp.blend(out, credit, OUT_W // 2, credit_y)
            try:
                proc.stdin.write(
                    cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])[
                        1
                    ].tobytes()
                )
            except BrokenPipeError:
                break  # ffmpeg exited; its stderr below says why
            written += 1
    finally:
        cap.release()
        try:
            proc.stdin.close()
        except BrokenPipeError:
            pass
        stderr = proc.stderr.read().decode("utf-8", "replace") if proc.stderr else ""
        code = proc.wait()
    if code != 0:
        raise RuntimeError(f"ffmpeg failed ({code}) for {job.out}: {stderr[-2000:]}")
    return written


def process(job: JobSpec) -> dict[str, Any]:
    logging.basicConfig(
        level=logging.INFO,
        stream=sys.stderr,
        format="[render] %(levelname)s %(message)s",
    )
    started = time.perf_counter()
    analysis = analyze(job)
    analysis_s = time.perf_counter() - started
    log.info(
        "%s: %d frames, %d face track(s), %d speaker switch(es), analysis %.1f s",
        Path(job.out).parent.name,
        analysis["frames"],
        analysis["faces_seen"],
        analysis["speaker_switches"],
        analysis_s,
    )
    if analysis["frames"] == 0:
        raise RuntimeError(
            f"no frames decoded between {job.start} and {job.end} s of {job.source}"
        )
    frames = render(job, analysis)
    total = time.perf_counter() - started
    log.info(
        "%s: rendered %d frames in %.1f s",
        Path(job.out).parent.name,
        frames,
        total - analysis_s,
    )
    return {
        "out": job.out,
        "frames": frames,
        "fps": analysis["fps"],
        "seconds": round(total, 1),
        "analysisSeconds": round(analysis_s, 1),
        "facesSeen": analysis["faces_seen"],
        "speakerSwitches": analysis["speaker_switches"],
        "faceCoverage": round(
            analysis["frames_with_face"] / max(analysis["frames"], 1), 3
        ),
    }


def read_jobs(raw: dict[str, Any]) -> tuple[list[JobSpec], int]:
    if raw.get("framing") not in ("face", "open"):
        raise ValueError("framing must be 'face' or 'open'")
    if not Path(raw["yunet"]).is_file():
        raise ValueError(f"YuNet model not found: {raw['yunet']}")
    captions_cfg = raw.get("captions", {})
    jobs = [
        JobSpec(
            source=raw["source"],
            yunet=raw["yunet"],
            ffmpeg=raw.get("ffmpeg", "ffmpeg"),
            framing=raw["framing"],
            credit=raw.get("credit", ""),
            words_per_cue=int(captions_cfg.get("wordsPerCue", 3)),
            color=captions_cfg.get("color", "#FFE11A"),
            font=raw.get("font"),
            hold_seconds=float(raw.get("holdSeconds", spk.DEFAULT_HOLD_SECONDS)),
            start=float(j["start"]),
            end=float(j["end"]),
            out=j["out"],
            words=list(j["words"]),
        )
        for j in raw["jobs"]
    ]
    for job in jobs:
        if job.end <= job.start:
            raise ValueError(f"clip end must be after start: {job.start}-{job.end}")
    return jobs, int(
        raw.get("workers", min(len(jobs), max(1, (os.cpu_count() or 2) // 2)))
    )


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        stream=sys.stderr,
        format="[render] %(levelname)s %(message)s",
    )
    try:
        jobs, workers = read_jobs(json.loads(sys.stdin.read()))
    except (ValueError, KeyError, json.JSONDecodeError) as exc:
        log.error("bad input: %s", exc)
        return 2
    try:
        if workers <= 1 or len(jobs) == 1:
            results = [process(job) for job in jobs]
        else:
            with Pool(processes=min(workers, len(jobs)), maxtasksperchild=1) as pool:
                results = pool.map(process, jobs)
    except (RuntimeError, OSError, ImportError) as exc:
        log.error("%s", exc)
        return 1
    sys.stdout.write(json.dumps({"clips": results}) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
