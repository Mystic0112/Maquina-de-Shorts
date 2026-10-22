"""Light-ASD active speaker scores for the face tracks of a clip (torch part; pure helpers in asd_math.py).

Inference as upstream Columbia_test.py: per track, 112x112 grey face crops at 25 fps from the
full-resolution frames + 13-coefficient MFCC (python_speech_features) of the 16 kHz mono audio of the same
span; score = lossAV.FC(out)[:, 1] averaged over chunk durations, then over 5 samples. CUDA when available.
torch, av and python_speech_features are imported lazily: an ImportError reaches the caller, which falls back
to the mouth heuristic.
"""

from __future__ import annotations

import logging
from typing import Any

import numpy as np

import asd_math as am

AUDIO_RATE = 16_000
log = logging.getLogger("cuts.asd")


def load_model(path: str, device: str) -> Any:
    """LightASD (lightasd/net.py) with the released weights; raises RuntimeError on any missing/mismatched key."""
    import torch

    from lightasd.net import LightASD

    net = LightASD()
    try:
        loaded = torch.load(path, map_location="cpu")
    except (OSError, RuntimeError, ValueError) as exc:
        raise RuntimeError(f"cannot read Light-ASD weights {path}: {exc}") from exc
    if not isinstance(loaded, dict):
        raise TypeError(f"{path} is not a state dict ({type(loaded).__name__})")
    state = {key.replace("module.", ""): value for key, value in loaded.items()}
    expected = net.state_dict()
    missing = [
        key
        for key in expected
        if key not in state and not key.endswith("num_batches_tracked")
    ]
    mismatched = [
        f"{key} {tuple(state[key].shape)} != {tuple(expected[key].shape)}"
        for key in expected
        if key in state and tuple(state[key].shape) != tuple(expected[key].shape)
    ]
    if missing or mismatched:
        raise RuntimeError(
            f"Light-ASD weights {path} do not fit the model: missing {missing[:5]} "
            f"({len(missing)}), mismatched {mismatched[:5]} ({len(mismatched)})"
        )
    net.load_state_dict({k: v for k, v in state.items() if k in expected}, strict=False)
    return net.to(device).eval()


def decode_audio(source: str, start: float, end: float) -> np.ndarray:
    """int16 16 kHz mono samples of [start, end) seconds of the source (times as ffmpeg -ss counts them)."""
    import av

    chunks: list[np.ndarray] = []
    first: float | None = None
    with av.open(source) as container:
        stream = container.streams.audio[0]
        origin = (container.start_time or 0) / av.time_base
        resampler = av.AudioResampler(format="s16", layout="mono", rate=AUDIO_RATE)
        container.seek(int((origin + max(start - 1.0, 0.0)) * av.time_base))
        for frame in container.decode(stream):
            if frame.time is None:
                continue
            t = frame.time - origin
            if t + frame.samples / frame.sample_rate < start:
                continue
            if t > end:
                break
            first = t if first is None else first
            chunks.extend(f.to_ndarray().reshape(-1) for f in resampler.resample(frame))
        chunks.extend(f.to_ndarray().reshape(-1) for f in resampler.resample(None))
    if first is None or not chunks:
        raise RuntimeError(f"no audio between {start} and {end} s of {source}")
    audio = np.concatenate(chunks).astype(np.int16)
    offset = round((start - first) * AUDIO_RATE)
    audio = (
        audio[offset:]
        if offset >= 0
        else np.concatenate([np.zeros(-offset, np.int16), audio])
    )
    return audio[: round((end - start) * AUDIO_RATE)]


def face_clips(
    capture: Any, fps: float, tracks: dict[int, am.TrackSamples]
) -> dict[int, np.ndarray]:
    """(n, 112, 112) uint8 grey face crops per track, read in one sequential pass over the clip."""
    import cv2

    needed: dict[int, list[tuple[int, int, tuple[int, int, int, int]]]] = {}
    clips: dict[int, np.ndarray] = {}
    for track_id, track in tracks.items():
        clips[track_id] = np.full((len(track.boxes), 112, 112), am.CROP_FILL, np.uint8)
        for k, box in enumerate(am.crop_boxes(track.boxes)):
            i = am.source_index(track.j0 + k, fps)
            needed.setdefault(i, []).append((track_id, k, box))
    for i in range(max(needed, default=-1) + 1):
        if i not in needed:
            if not capture.grab():
                break
            continue
        ok, frame = capture.read()
        if not ok:
            break
        for track_id, k, box in needed[i]:
            face = cv2.resize(am.padded_region(frame, box), (224, 224))
            clips[track_id][k] = cv2.cvtColor(face, cv2.COLOR_BGR2GRAY)[56:168, 56:168]
    return clips


def track_scores(
    net: Any, device: str, mfcc: np.ndarray, faces: np.ndarray
) -> list[float]:
    """Smoothed ASD score per 25-fps sample (may be a sample or two shorter than the track)."""
    import torch

    _, n_video = am.aligned_lengths(
        len(mfcc), len(faces)
    )  # audio is 4x each video bound
    if n_video == 0:
        return []
    per_duration: list[list[float]] = []
    with torch.inference_mode():
        for duration in am.DURATIONS:
            scores: list[float] = []
            for v0, v1 in am.chunk_bounds(n_video, duration):
                a0, a1 = v0 * am.AUDIO_PER_VIDEO, v1 * am.AUDIO_PER_VIDEO
                audio = torch.from_numpy(np.ascontiguousarray(mfcc[a0:a1])).float()
                video = torch.from_numpy(np.ascontiguousarray(faces[v0:v1])).float()
                embed_a = net.model.forward_audio_frontend(
                    audio.unsqueeze(0).to(device)
                )
                embed_v = net.model.forward_visual_frontend(
                    video.unsqueeze(0).to(device)
                )
                out = net.model.forward_audio_visual_backend(embed_a, embed_v)
                scores.extend(net.lossAV.FC(out)[:, 1].cpu().tolist())
            per_duration.append(scores)
    return am.moving_average(am.average_durations(per_duration))


def score_tracks(
    capture: Any,
    source: str,
    start: float,
    end: float,
    fps: float,
    observations: dict[int, list[tuple[int, float, float, float, float]]],
    model_path: str,
) -> dict[int, am.TrackSamples]:
    """TrackSamples with scores for every track long enough to score (capture: opened at the clip start)."""
    import python_speech_features
    import torch

    device = "cuda" if torch.cuda.is_available() else "cpu"
    net = load_model(model_path, device)
    tracks = {
        track_id: samples
        for track_id, obs in observations.items()
        if (samples := am.track_samples(obs, fps)) is not None
        and len(samples.boxes) >= am.MIN_TRACK_SAMPLES
    }
    clips = face_clips(capture, fps, tracks)
    audio = decode_audio(source, start, end)
    for track_id, track in tracks.items():
        a0 = track.j0 * am.SAMPLES_PER_FRAME
        span = audio[a0 : a0 + len(track.boxes) * am.SAMPLES_PER_FRAME]
        mfcc = python_speech_features.mfcc(
            span, AUDIO_RATE, numcep=13, winlen=0.025, winstep=0.010
        )
        track.scores = track_scores(net, device, mfcc, clips[track_id])
    log.info(
        "Light-ASD (%s): scored %d of %d track(s)",
        device,
        len(tracks),
        len(observations),
    )
    return tracks
