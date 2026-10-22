"""Word-timestamped transcript of a video for the cuts pipeline.

Usage:
    python python/cuts/transcribe.py --video <source.mp4> --out <transcript.json>
        [--ffmpeg ffmpeg] [--model base] [--device cpu] [--models-dir <repo>/models/whisper]

ffmpeg decodes the audio to 16 kHz mono PCM on a pipe -> faster-whisper (word_timestamps) -> JSON with
"segments" [{start, end, text}] and "words" [{word, start, end}] in seconds. The same object is printed on
stdout. Model cache and offline behaviour follow python/tts/align.py.
Exit codes: 0 ok, 1 failed, 2 bad arguments.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python" / "tts"))

import align  # shared faster-whisper cache helpers

DEFAULT_MODELS_DIR = ROOT / "models" / "whisper"
WHISPER_RATE = 16_000
log = logging.getLogger("cuts.transcribe")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="word-timestamped transcript (faster-whisper)"
    )
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument(
        "--model",
        default=os.environ.get("CUTS_WHISPER_MODEL") or align.DEFAULT_WHISPER_MODEL,
    )
    parser.add_argument(
        "--device", default=os.environ.get("CUTS_WHISPER_DEVICE") or "cpu"
    )
    parser.add_argument("--models-dir", type=Path, default=DEFAULT_MODELS_DIR)
    return parser.parse_args(argv)


def decode_audio(ffmpeg: str, video: Path):  # -> np.ndarray float32 mono 16 kHz
    import numpy as np

    cmd = [
        ffmpeg,
        "-v",
        "error",
        "-i",
        str(video),
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(WHISPER_RATE),
        "-f",
        "s16le",
        "-",
    ]
    proc = subprocess.run(cmd, capture_output=True, check=False)
    if proc.returncode != 0:
        raise RuntimeError(
            f"ffmpeg failed decoding audio: {proc.stderr.decode('utf-8', 'replace')[-2000:]}"
        )
    return np.frombuffer(proc.stdout, dtype=np.int16).astype(np.float32) / 32768.0


def transcribe(audio, model: str, device: str, models_dir: Path) -> dict[str, object]:
    from faster_whisper import WhisperModel

    if not align.model_is_cached(model, models_dir):
        log.warning(
            "downloading faster-whisper model %r to %s (one-time)", model, models_dir
        )
    compute = "int8" if device == "cpu" else "float16"
    whisper = WhisperModel(
        model, device=device, compute_type=compute, download_root=str(models_dir)
    )
    segments_iter, info = whisper.transcribe(
        audio,
        language="pt",
        word_timestamps=True,
        beam_size=5,
        condition_on_previous_text=False,
        vad_filter=True,
    )
    segments: list[dict[str, object]] = []
    words: list[dict[str, object]] = []
    for seg in segments_iter:
        text = seg.text.strip()
        if not text:
            continue
        segments.append(
            {"start": round(seg.start, 3), "end": round(seg.end, 3), "text": text}
        )
        for w in seg.words or []:
            if w.word.strip():
                words.append(
                    {
                        "word": w.word.strip(),
                        "start": round(w.start, 3),
                        "end": round(w.end, 3),
                    }
                )
    return {
        "model": model,
        "device": device,
        "language": info.language,
        "duration": round(info.duration, 3),
        "segments": segments,
        "words": words,
    }


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        stream=sys.stderr,
        format="[transcribe] %(levelname)s %(message)s",
    )
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    args = parse_args(argv)
    if not args.video.is_file():
        log.error("video not found: %s", args.video)
        return 2
    if align.model_is_cached(args.model, args.models_dir):
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
    try:
        started = time.perf_counter()
        audio = decode_audio(args.ffmpeg, args.video)
        log.info(
            "decoded %.1f s of audio in %.1f s",
            audio.size / WHISPER_RATE,
            time.perf_counter() - started,
        )
        started = time.perf_counter()
        result = transcribe(audio, args.model, args.device, args.models_dir)
        log.info(
            "transcribed %d segments / %d words in %.1f s (%s/%s)",
            len(result["segments"]),
            len(result["words"]),
            time.perf_counter() - started,
            args.model,
            args.device,
        )
    except ImportError as exc:
        log.error("faster-whisper/numpy missing in this interpreter: %s", exc)
        return 1
    except (RuntimeError, OSError, ValueError) as exc:
        log.error("%s", exc)
        return 1
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    sys.stdout.write(
        json.dumps(
            {
                "path": str(args.out),
                "segments": len(result["segments"]),
                "words": len(result["words"]),
                "duration": result["duration"],
            }
        )
        + "\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
