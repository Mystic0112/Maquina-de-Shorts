"""Cuts a vertical clip out of a landscape source, following the face that is talking.

Reads one JSON job list on stdin (see JobSpec below), renders every clip (one process per clip via
multiprocessing) and prints one JSON object on stdout: {"clips": [{"out", "frames", "seconds", ...}]}.

Per clip: pass 1 (detect.py) tracks the faces with YuNet and picks the speaker per frame with Light-ASD
(asd.py, when "asdModel" is given and loads) or the mouth-movement heuristic (speaker.py);
pass 2 decodes again, crops along the camera path (camera.py), draws the captions (captions.py + Pillow)
and the owner's watermark (watermark.py), and pipes JPEG frames into ffmpeg, which muxes the original audio (libx264 + aac).

Jump cuts: a job may carry "keep" (absolute source seconds, sorted, non-overlapping, inside [start, end]).
They are snapped to the frame grid; pass 2 still reads every source frame but only encodes the kept ones,
and ffmpeg cuts the same frame ranges out of the audio (atrim + concat), so picture and sound stay in sync.
Captions keep the source-relative clock (frame index / fps), so they need no retiming.

Humor (humor.py): a job may carry "humor" (jokes, reaction emoji, punch/spotlight/flash effects, absolute
source seconds like "keep"); it is drawn on the same clock and the result counts what showed.

Placement (placement.py): captions, jokes and emoji avoid the speaker's face and the text already burned into
the source (textdetect.py, when the top-level "textModel" path is given); a caption cue keeps one position for
its whole life and is skipped when the video already shows its own caption there. The result's "placement"
counts it.

Framing "face": a 9:16 crop that pushes in on the speaker and pulls back to full height when nobody speaks.
Framing "open": a full-height 4:5 window on a blurred, darkened background made from the same frame.
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

import camera as cam
import captions as caps
import compose as cmp
import detect
import humor as hum
import placement as pl
import speaker as spk
import watermark as wm

OUT_W, OUT_H = cmp.OUT_W, cmp.OUT_H
CAPTION_FONT_SIZE = 60
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
    words_per_cue: int
    color: str
    font: str | None
    hold_seconds: float
    start: float
    end: float
    out: str
    words: list[dict[str, Any]]
    keep: list[tuple[float, float]]
    asd_model: str | None = None
    text_model: str | None = None
    watermark: wm.Watermark | None = None
    humor: hum.Humor | None = None


def resolve_font(explicit: str | None) -> str | None:
    if explicit and Path(explicit).is_file():
        return explicit
    fallback = next((c for c in FONT_CANDIDATES if Path(c).is_file()), None)
    if explicit:
        log.warning(
            "font not found: %s; using %s", explicit, fallback or "Pillow's default"
        )
    return fallback


# ---------------------------------------------------------------------------------------------
# Pass 2: crop, captions, encode
# ---------------------------------------------------------------------------------------------


def keep_frames(
    keep: list[tuple[float, float]], start: float, fps: float
) -> list[tuple[int, int]]:
    """Kept source intervals as frame ranges [f0, f1) counted from `start`; empty ones dropped, touching merged."""
    ranges: list[tuple[int, int]] = []
    for k0, k1 in keep:
        f0, f1 = round((k0 - start) * fps), round((k1 - start) * fps)
        if f1 <= f0:
            continue
        if ranges and f0 <= ranges[-1][1]:
            ranges[-1] = (ranges[-1][0], max(ranges[-1][1], f1))
        else:
            ranges.append((f0, f1))
    return ranges


def audio_filter(frame_ranges: list[tuple[int, int]], fps: float) -> str:
    """filter_complex cutting the same frame ranges out of input 1's audio (input starts at the clip start)."""
    trims = [
        f"[1:a]atrim=start={f0 / fps:.6f}:end={f1 / fps:.6f},asetpts=PTS-STARTPTS[a{n}]"
        for n, (f0, f1) in enumerate(frame_ranges)
    ]
    labels = "".join(f"[a{n}]" for n in range(len(frame_ranges)))
    return ";".join(trims + [f"{labels}concat=n={len(frame_ranges)}:v=0:a=1[aout]"])


def ffmpeg_command(
    job: JobSpec, fps: float, frame_ranges: list[tuple[int, int]]
) -> list[str]:
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
        "-filter_complex",
        audio_filter(frame_ranges, fps),
        "-map",
        "0:v:0",
        "-map",
        "[aout]",
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


def render(
    job: JobSpec, analysis: dict[str, Any], frame_ranges: list[tuple[int, int]]
) -> int:
    import cv2

    src_w, src_h, fps = analysis["width"], analysis["height"], analysis["fps"]
    speakers = analysis["speakers"]
    kept = {i for f0, f1 in frame_ranges for i in range(f0, f1)}
    if job.framing == "face":
        # The mouth heuristic guesses wrong on handheld footage: only the audio-visual model earns a push-in.
        zoom = analysis.get("speakerMethod") == "light-asd"
        scored = analysis.get("scored")
        groups = cam.group_frames(scored, fps) if zoom and scored else None
        # How many times the camera opened up for people talking at once (the log line and the result report it).
        analysis["groupShots"] = sum(
            1 for i, g in enumerate(groups or []) if g and (i == 0 or not groups[i - 1])
        )
        shots = cam.camera_path(
            speakers, analysis["faces"], src_w, src_h, fps, zoom, groups
        )
        crops = [cam.crop_rect(shot, src_w, src_h) for shot in shots]
        dest = pl.FULL_FRAME
    else:
        crop_w = min(src_w, round(src_h * 4 / 5))
        path = spk.smooth_path([s.cx if s else None for s in speakers], src_w)
        crops = [(spk.clamp_window(x, crop_w, src_w), 0, crop_w, src_h) for x in path]
        dest = pl.OPEN_WINDOW
    span = pl.span_obstacles(crops, dest, speakers, analysis["texts"], fps, kept)
    cues = caps.build_cues(job.words, job.start, job.end, job.words_per_cue)
    font = resolve_font(job.font)
    color = caps.hex_to_bgr(job.color)
    overlays = {
        cue.text: cmp.text_overlay(
            cue.text, font, CAPTION_FONT_SIZE, color, int(OUT_W * 0.9)
        )
        for cue in cues
    }
    places = {
        cue: pl.place_caption(
            job.framing,
            wm.trim(overlays[cue.text]).shape[1],
            overlays[cue.text].shape[0],
            span(cue.start, cue.end),
        )
        for cue in cues
    }
    analysis["placement"] = {
        "textBoxesSeen": sum(len(boxes) for _, boxes in analysis["texts"]),
        "captionsMoved": sum(1 for p in places.values() if p.moved),
        "captionsSkipped": sum(1 for p in places.values() if p.skip),
        "emojisMoved": 0,
    }
    layer = (
        hum.HumorLayer(
            job.humor,
            font,
            job.framing,
            lambda t0, t1: span(t0 - job.start, t1 - job.start),
        )
        if job.humor
        else None
    )
    mark = wm.build_overlay(job.watermark, font) if job.watermark else None
    if mark is not None:
        mark_x, mark_y = wm.origin(job.watermark.position, mark.shape[1], mark.shape[0])
        mark_center = (mark_x + mark.shape[1] // 2, mark_y + mark.shape[0] // 2)
    default_y = pl.default_caption_y(job.framing)
    cache: dict[str, Any] = {}
    Path(job.out).parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.Popen(
        ffmpeg_command(job, fps, frame_ranges),
        stdin=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert proc.stdin is not None
    cap = detect.open_capture(job.source, job.start)
    written = 0
    try:
        for index in range(frame_ranges[-1][1]):
            if index not in kept:
                if not cap.grab():  # skips the colour conversion of a cut frame
                    break
                continue
            ok, frame = cap.read()
            if not ok:
                break
            # absolute source seconds: the humor plan's clock
            t = job.start + index / fps
            rect = None
            if job.framing == "face":
                rect = layer.crop(crops[index], t) if layer else crops[index]
                left, top, width, height = rect
                out = cmp.compose_face(frame, left, width, top, height)
            else:
                out = cmp.compose_open(frame, crops[index][0], crop_w, cache)
            if layer:
                layer.draw_effects(out, t, rect, speakers[index])
            cue = caps.cue_at(cues, index / fps)
            place = places[cue] if cue else None
            caption = overlays[cue.text] if cue and place and not place.skip else None
            caption_y = place.y if place else default_y
            if caption is not None:
                cmp.blend(out, caption, OUT_W // 2, caption_y)
            if layer:
                layer.draw_text(
                    out, t, caption.shape[0] if caption is not None else None, caption_y
                )
            if mark is not None:
                cmp.blend(out, mark, *mark_center)
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
        analysis["humor"] = layer.counts() if layer else dict.fromkeys(hum.KINDS, 0)
        analysis["placement"]["emojisMoved"] = len(layer.emojis_moved) if layer else 0
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
    analysis = detect.analyze(job)
    if analysis["frames"] == 0:
        raise RuntimeError(
            f"no frames decoded between {job.start} and {job.end} s of {job.source}"
        )
    speakers, method, scored = detect.pick_speakers(job, analysis)
    analysis["speakers"] = speakers
    analysis["speakerMethod"] = method
    analysis["scored"] = scored
    switches = sum(
        1 for a, b in pairwise(speakers) if a and b and a.track_id != b.track_id
    )
    analysis_s = time.perf_counter() - started
    log.info(
        "%s: %d frames, %d face track(s), %d speaker switch(es) by %s, analysis %.1f s",
        Path(job.out).parent.name,
        analysis["frames"],
        analysis["faces_seen"],
        switches,
        method,
        analysis_s,
    )
    total_frames = analysis["frames"]
    frame_ranges = [
        (f0, min(f1, total_frames))
        for f0, f1 in keep_frames(job.keep, job.start, analysis["fps"])
        if f0 < total_frames
    ]
    if not frame_ranges:
        raise RuntimeError(f"nothing to keep in {job.out}: {job.keep}")
    frames = render(job, analysis, frame_ranges)
    total = time.perf_counter() - started
    log.info(
        "%s: rendered %d frames in %.1f s, %d group shot(s), placement %s",
        Path(job.out).parent.name,
        frames,
        total - analysis_s,
        analysis.get("groupShots", 0),
        analysis["placement"],
    )
    return {
        "out": job.out,
        "frames": frames,
        "fps": analysis["fps"],
        "keptSeconds": round(
            sum(f1 - f0 for f0, f1 in frame_ranges) / analysis["fps"], 2
        ),
        "seconds": round(total, 1),
        "analysisSeconds": round(analysis_s, 1),
        "facesSeen": analysis["faces_seen"],
        "speakerSwitches": switches,
        "speakerMethod": method,
        "groupShots": analysis.get("groupShots", 0),
        "humor": analysis.get("humor", dict.fromkeys(hum.KINDS, 0)),
        "placement": analysis["placement"],
        "faceCoverage": round(
            sum(1 for s in speakers if s) / max(analysis["frames"], 1), 3
        ),
    }


def read_jobs(raw: dict[str, Any]) -> tuple[list[JobSpec], int]:
    if raw.get("framing") not in ("face", "open"):
        raise ValueError("framing must be 'face' or 'open'")
    if not Path(raw["yunet"]).is_file():
        raise ValueError(f"YuNet model not found: {raw['yunet']}")
    captions_cfg = raw.get("captions", {})
    watermark = wm.parse_watermark(
        raw.get("watermark")
    )  # "credit" is ignored: it goes in the description
    jobs = [
        JobSpec(
            source=raw["source"],
            yunet=raw["yunet"],
            ffmpeg=raw.get("ffmpeg", "ffmpeg"),
            framing=raw["framing"],
            words_per_cue=int(captions_cfg.get("wordsPerCue", 3)),
            color=captions_cfg.get("color", "#FFE11A"),
            font=raw.get("font"),
            hold_seconds=float(raw.get("holdSeconds", spk.DEFAULT_HOLD_SECONDS)),
            asd_model=raw.get("asdModel") or None,
            text_model=raw.get("textModel") or None,
            watermark=watermark,
            humor=hum.parse_humor(j.get("humor")),
            start=float(j["start"]),
            end=float(j["end"]),
            out=j["out"],
            words=list(j["words"]),
            keep=[
                (float(a), float(b))
                for a, b in j.get("keep") or [[j["start"], j["end"]]]
            ],
        )
        for j in raw["jobs"]
    ]
    for job in jobs:
        if job.end <= job.start:
            raise ValueError(f"clip end must be after start: {job.start}-{job.end}")
        check_keep(job)
    return jobs, int(
        raw.get("workers", min(len(jobs), max(1, (os.cpu_count() or 2) // 2)))
    )


def check_keep(job: JobSpec) -> None:
    previous_end = job.start
    for k0, k1 in job.keep:
        if k0 < previous_end - 1e-6 or k1 < k0 or k1 > job.end + 1e-6:
            raise ValueError(
                f"keep must be sorted, non-overlapping and inside {job.start}-{job.end}: {job.keep}"
            )
        previous_end = k1


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
