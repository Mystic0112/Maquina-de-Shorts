"""Finish a narration whose audio came without word timings (Gemini TTS): trim pauses, time every word.

Usage:
    python python/tts/align_narration.py --audio-in <narration.source.wav> --text-file <path> --out-dir <dir>
        [--max-pause-ms=250] [--whisper-model=base] [--models-dir=<repo>/models/whisper]
    python python/tts/align_narration.py --download-only [--whisper-model=base]

Steps: read 16-bit mono WAV -> shorten pauses (pcm_pauses.py; 0 disables) -> write <out-dir>/narration.wav
-> transcribe it with faster-whisper (CPU, int8) -> align the script's words to the transcript (align.py)
-> snap word boundaries onto clear pauses -> write <out-dir>/timings.json. Prints one JSON object on
stdout matching `Narration` in src/orchestrator/types.ts, plus "alignment": {"matchedRatio", "model"}.
durationMs is exact: samples * 1000 / sample rate, rounded to the ms.

The Whisper model is downloaded on first use into --models-dir (a WARNING line is logged first);
run with --download-only once after installing to keep unattended runs offline.
Exit codes: 0 ok, 1 processing failed (unusable audio, alignment too poor), 2 invalid arguments/input.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import tempfile
import time
from pathlib import Path

import align
import pcm_pauses

AUDIO_FILENAME = "narration.wav"
TIMINGS_FILENAME = "timings.json"
DEFAULT_MAX_PAUSE_MS = 250
DEFAULT_MODELS_DIR = Path(__file__).resolve().parents[2] / "models" / "whisper"
MIN_AUDIO_MS = 500
MIN_MATCHED_RATIO = 0.5  # below this the audio does not say the script (skipped text, wrong language)
WARN_MATCHED_RATIO = 0.85
PAUSE_SNAP_MIN_MS = 120

EXIT_OK, EXIT_FAILED, EXIT_BAD_INPUT = 0, 1, 2

log = logging.getLogger("align_narration")


class InputError(ValueError):
    """Invalid CLI arguments or input files."""


class AlignmentError(RuntimeError):
    """The narration could not be timed reliably."""


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="trim pauses + word timings for TTS audio of a known text")
    parser.add_argument("--audio-in", type=Path, help="16-bit mono WAV from the TTS engine")
    parser.add_argument("--text-file", type=Path, help="UTF-8 text the audio speaks")
    parser.add_argument("--out-dir", type=Path, help="directory for narration.wav + timings.json")
    parser.add_argument("--max-pause-ms", type=int, default=DEFAULT_MAX_PAUSE_MS, help="longest pause kept; 0 = keep")
    parser.add_argument("--whisper-model", default=align.DEFAULT_WHISPER_MODEL, help="faster-whisper model size")
    parser.add_argument("--models-dir", type=Path, default=DEFAULT_MODELS_DIR, help="faster-whisper model cache")
    parser.add_argument("--download-only", action="store_true", help="fetch the Whisper model and exit")
    return parser.parse_args(argv)


def read_inputs(args: argparse.Namespace) -> tuple[pcm_pauses.Pcm, list[str]]:
    if args.audio_in is None or args.text_file is None or args.out_dir is None:
        raise InputError("--audio-in, --text-file and --out-dir are required")
    if args.max_pause_ms < 0:
        raise InputError(f"--max-pause-ms must be >= 0, got {args.max_pause_ms}")
    if not args.audio_in.is_file() or not args.text_file.is_file():
        raise InputError(f"missing input: {args.audio_in if not args.audio_in.is_file() else args.text_file}")
    words = align.script_words(args.text_file.read_text(encoding="utf-8-sig"))
    if not words:
        raise InputError(f"text file has no words: {args.text_file}")
    try:
        pcm = pcm_pauses.read_wav(args.audio_in.read_bytes())
    except pcm_pauses.PcmFormatError as exc:
        raise InputError(f"{args.audio_in}: {exc}") from exc
    if pcm.duration_ms < MIN_AUDIO_MS:
        raise AlignmentError(f"audio is {pcm.duration_ms} ms long; the TTS returned (almost) nothing")
    return pcm, words


def write_atomic(path: Path, payload: bytes) -> None:
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
        os.replace(tmp_name, path)
    except BaseException:
        Path(tmp_name).unlink(missing_ok=True)
        raise


def time_words(pcm: pcm_pauses.Pcm, words: list[str], args: argparse.Namespace) -> align.Alignment:
    started = time.perf_counter()
    asr = align.transcribe(pcm.samples, pcm.rate, args.whisper_model, args.models_dir)
    result = align.align_script(words, asr, pcm.duration_ms)
    snapped = align.snap_to_pauses(result.words, pcm_pauses.pauses_ms(pcm, PAUSE_SNAP_MIN_MS))
    log.info(
        "aligned %d/%d script words to %d recognized words in %.1f s (%s)",
        result.matched,
        len(words),
        len(asr),
        time.perf_counter() - started,
        args.whisper_model,
    )
    if result.matched_ratio < MIN_MATCHED_RATIO:
        raise AlignmentError(f"only {result.matched_ratio:.0%} of the script was recognized in the audio")
    if result.matched_ratio < WARN_MATCHED_RATIO:
        log.warning("only %.0f%% of words matched; caption timing may drift", result.matched_ratio * 100)
    return align.Alignment(words=snapped, matched=result.matched)


def run(args: argparse.Namespace) -> dict[str, object]:
    pcm, words = read_inputs(args)
    out_dir: Path = args.out_dir.expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    trimmed, cuts = pcm_pauses.trim_pauses(pcm, args.max_pause_ms)
    log.info(
        "pauses: %d cut(s), %d -> %d ms (longest pause %d -> %d ms)",
        len(cuts),
        pcm.duration_ms,
        trimmed.duration_ms,
        pcm_pauses.longest_quiet_ms(pcm),
        pcm_pauses.longest_quiet_ms(trimmed),
    )
    audio_path = out_dir / AUDIO_FILENAME
    write_atomic(audio_path, pcm_pauses.to_wav(trimmed))
    alignment = time_words(trimmed, words, args)
    narration = {
        "audioPath": str(audio_path),
        "durationMs": trimmed.duration_ms,
        "words": [{"word": w.word, "startMs": w.start_ms, "endMs": w.end_ms} for w in alignment.words],
        "alignment": {"matchedRatio": round(alignment.matched_ratio, 4), "model": args.whisper_model},
    }
    write_atomic(out_dir / TIMINGS_FILENAME, json.dumps(narration, ensure_ascii=False, indent=2).encode("utf-8"))
    return narration


def download_only(args: argparse.Namespace) -> None:
    from faster_whisper import WhisperModel

    log.info("fetching faster-whisper %r into %s", args.whisper_model, args.models_dir)
    WhisperModel(args.whisper_model, device="cpu", compute_type="int8", download_root=str(args.models_dir))


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="[align] %(levelname)s %(message)s")
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")  # Windows without Developer Mode
    args = parse_args(argv)
    if not args.download_only and align.model_is_cached(args.whisper_model, args.models_dir):
        os.environ.setdefault("HF_HUB_OFFLINE", "1")  # cached: never touch the network
    try:
        if args.download_only:
            download_only(args)
            return EXIT_OK
        narration = run(args)
    except InputError as exc:
        log.error("%s", exc)
        return EXIT_BAD_INPUT
    except ImportError as exc:
        log.error("faster-whisper is missing (pip install -r python/requirements.txt into .venv): %s", exc)
        return EXIT_FAILED
    except (AlignmentError, OSError) as exc:
        log.error("%s", exc)
        return EXIT_FAILED
    sys.stdout.write(json.dumps(narration, ensure_ascii=True) + "\n")
    sys.stdout.flush()
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
