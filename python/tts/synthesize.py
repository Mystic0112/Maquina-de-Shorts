"""Synthesize pt-BR narration with edge-tts and emit word timings.

Usage:
    python python/tts/synthesize.py --text-file <path> --out-dir <dir>
        [--voice pt-BR-AntonioNeural] [--rate=+5%] [--pitch=-2Hz] [--volume=+10%]
        [--deadline-seconds=280]
        (use the = form for negative values, e.g. --rate=-10%)

--deadline-seconds bounds the WHOLE run: every attempt's timeout and the backoff between the
(up to 3) attempts are fitted inside it, so the caller's own timeout never has to kill us.

Writes <out-dir>/narration.mp3 and <out-dir>/timings.json, then prints exactly one JSON object
to stdout matching `Narration` in src/orchestrator/types.ts:
    {"audioPath": str, "durationMs": int, "words": [{"word": str, "startMs": int, "endMs": int}]}
All logging goes to stderr. Exit codes: 0 ok, 1 synthesis failed, 2 invalid arguments/input.

Duration: edge-tts 7.x always requests "audio-24khz-48kbitrate-mono-mp3" (constant 48 kbps;
see edge_tts.constants.MP3_BITRATE_BPS), so duration = bytes * 8 / 48000 exactly, the same
arithmetic edge-tts itself uses to stitch word offsets across text chunks.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import sys
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import aiohttp
import edge_tts
from edge_tts.constants import MP3_BITRATE_BPS, TICKS_PER_SECOND
from edge_tts.exceptions import EdgeTTSException

DEFAULT_VOICE = "pt-BR-AntonioNeural"
AUDIO_FILENAME = "narration.mp3"
TIMINGS_FILENAME = "timings.json"
TICKS_PER_MS = TICKS_PER_SECOND // 1000
MAX_ATTEMPTS = 3
SYNTH_TIMEOUT_SECONDS = 120
DEFAULT_DEADLINE_SECONDS = 280.0
MIN_ATTEMPT_SECONDS = 5.0  # not worth starting an attempt with less time than this
RATE_PATTERN = re.compile(r"^[+-]\d+%$")
PITCH_PATTERN = re.compile(r"^[+-]\d+Hz$")
VOLUME_PATTERN = re.compile(r"^[+-]\d+%$")

EXIT_OK, EXIT_SYNTH_FAILED, EXIT_BAD_INPUT = 0, 1, 2

log = logging.getLogger("synthesize")


class InputError(ValueError):
    """Invalid CLI arguments or text file."""


class SynthesisError(RuntimeError):
    """edge-tts did not produce usable audio."""


@dataclass(frozen=True)
class WordTiming:
    word: str
    startMs: int  # noqa: N815 — mirrors the TypeScript contract
    endMs: int  # noqa: N815


@dataclass(frozen=True)
class Prosody:
    """edge-tts SSML prosody deltas."""

    rate: str = "+0%"
    pitch: str = "+0Hz"
    volume: str = "+0%"


@dataclass(frozen=True)
class Narration:
    audioPath: str  # noqa: N815
    durationMs: int  # noqa: N815
    words: list[WordTiming]


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="edge-tts narration + word timings (JSON on stdout)")
    parser.add_argument("--text-file", required=True, type=Path, help="UTF-8 text to narrate")
    parser.add_argument("--voice", default=DEFAULT_VOICE, help=f"edge-tts voice (default {DEFAULT_VOICE})")
    parser.add_argument("--out-dir", required=True, type=Path, help="directory for narration.mp3 + timings.json")
    parser.add_argument("--rate", default="+0%", help="speaking rate delta, e.g. +5%% (use --rate=-10%% for negatives)")
    parser.add_argument("--pitch", default="+0Hz", help="pitch delta in Hz, e.g. +2Hz (use --pitch=-2Hz for negatives)")
    parser.add_argument("--volume", default="+0%", help="volume delta, e.g. +10%% (use --volume=-10%% for negatives)")
    parser.add_argument(
        "--deadline-seconds",
        type=float,
        default=DEFAULT_DEADLINE_SECONDS,
        help=f"wall-clock budget for all attempts incl. backoff (default {DEFAULT_DEADLINE_SECONDS:g})",
    )
    return parser.parse_args(argv)


def read_text(path: Path) -> str:
    if not path.is_file():
        raise InputError(f"text file not found: {path}")
    try:
        text = path.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError as exc:
        raise InputError(f"text file is not valid UTF-8: {path} ({exc})") from exc
    text = " ".join(text.split())
    if not text:
        raise InputError(f"text file is empty: {path}")
    return text


def validate_rate(rate: str) -> str:
    if not RATE_PATTERN.match(rate):
        raise InputError(f"--rate must look like +5% or -10%, got {rate!r}")
    return rate


def validate_prosody(rate: str, pitch: str, volume: str) -> Prosody:
    if not PITCH_PATTERN.match(pitch):
        raise InputError(f"--pitch must look like +2Hz or -2Hz, got {pitch!r}")
    if not VOLUME_PATTERN.match(volume):
        raise InputError(f"--volume must look like +10% or -10%, got {volume!r}")
    return Prosody(rate=validate_rate(rate), pitch=pitch, volume=volume)


async def stream_speech(text: str, voice: str, prosody: Prosody) -> tuple[bytes, list[WordTiming]]:
    # edge-tts 7.x defaults to SentenceBoundary; word-level captions need WordBoundary.
    communicate = edge_tts.Communicate(
        text,
        voice,
        rate=prosody.rate,
        pitch=prosody.pitch,
        volume=prosody.volume,
        boundary="WordBoundary",
    )
    audio = bytearray()
    words: list[WordTiming] = []
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio.extend(chunk["data"])
        elif chunk["type"] == "WordBoundary":
            words.append(to_word_timing(chunk["text"], chunk["offset"], chunk["duration"]))
    return bytes(audio), words


def to_word_timing(text: str, offset_ticks: float, duration_ticks: float) -> WordTiming:
    start_ms = round(offset_ticks / TICKS_PER_MS)
    end_ms = round((offset_ticks + duration_ticks) / TICKS_PER_MS)
    return WordTiming(word=text, startMs=start_ms, endMs=max(end_ms, start_ms))


def synthesize_with_retries(text: str, voice: str, prosody: Prosody, deadline: float) -> tuple[bytes, list[WordTiming]]:
    """Up to MAX_ATTEMPTS tries; each attempt's timeout and every backoff fit before `deadline` (monotonic)."""
    last_error: Exception | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        remaining = deadline - time.monotonic()
        if remaining < MIN_ATTEMPT_SECONDS:
            raise SynthesisError(f"deadline reached before attempt {attempt}; last error: {last_error}") from last_error
        try:
            timeout = min(SYNTH_TIMEOUT_SECONDS, remaining)
            audio, words = asyncio.run(asyncio.wait_for(stream_speech(text, voice, prosody), timeout))
            if not audio:
                raise SynthesisError("edge-tts returned no audio")
            if not words:
                raise SynthesisError("edge-tts returned audio but no WordBoundary events")
            return audio, words
        except (EdgeTTSException, SynthesisError, aiohttp.ClientError, OSError, TimeoutError) as exc:
            # asyncio.wait_for raises a message-less TimeoutError; give it one.
            timed_out = isinstance(exc, TimeoutError)
            last_error = SynthesisError(f"attempt timed out after {timeout:.0f}s") if timed_out else exc
            log.warning("attempt %d/%d failed: %s: %s", attempt, MAX_ATTEMPTS, type(exc).__name__, last_error)
            _backoff_within(attempt, deadline)
    raise SynthesisError(f"edge-tts failed after {MAX_ATTEMPTS} attempts: {last_error}") from last_error


def _backoff_within(attempt: int, deadline: float) -> None:
    """Sleep 2*attempt seconds before the next try, but only if a useful attempt still fits afterwards."""
    backoff = 2 * attempt
    if attempt < MAX_ATTEMPTS and deadline - time.monotonic() - backoff >= MIN_ATTEMPT_SECONDS:
        time.sleep(backoff)


def mp3_duration_ms(byte_count: int) -> int:
    return round(byte_count * 8 * 1000 / MP3_BITRATE_BPS)


def write_atomic(path: Path, payload: bytes) -> None:
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
        os.replace(tmp_name, path)
    except BaseException:
        Path(tmp_name).unlink(missing_ok=True)
        raise


def build_narration(out_dir: Path, audio: bytes, words: list[WordTiming]) -> Narration:
    duration_ms = mp3_duration_ms(len(audio))
    clamped = [WordTiming(w.word, min(w.startMs, duration_ms), min(w.endMs, duration_ms)) for w in words]
    return Narration(audioPath=str((out_dir / AUDIO_FILENAME).resolve()), durationMs=duration_ms, words=clamped)


def run(args: argparse.Namespace, started: float) -> Narration:
    if not args.deadline_seconds > 0:
        raise InputError(f"--deadline-seconds must be > 0, got {args.deadline_seconds}")
    deadline = started + args.deadline_seconds
    text = read_text(args.text_file)
    prosody = validate_prosody(args.rate, args.pitch, args.volume)
    out_dir: Path = args.out_dir.expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    log.info(
        "synthesizing %d chars with %s (rate %s, pitch %s, volume %s)",
        len(text),
        args.voice,
        prosody.rate,
        prosody.pitch,
        prosody.volume,
    )
    audio, words = synthesize_with_retries(text, args.voice, prosody, deadline)
    narration = build_narration(out_dir, audio, words)
    write_atomic(out_dir / AUDIO_FILENAME, audio)
    timings_json = json.dumps(asdict(narration), ensure_ascii=False, indent=2).encode("utf-8")
    write_atomic(out_dir / TIMINGS_FILENAME, timings_json)
    log.info("wrote %s (%d ms, %d words)", narration.audioPath, narration.durationMs, len(narration.words))
    return narration


def main(argv: list[str] | None = None) -> int:
    started = time.monotonic()
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="[synthesize] %(levelname)s %(message)s")
    args = parse_args(argv)
    try:
        narration = run(args, started)
    except InputError as exc:
        log.error("%s", exc)
        return EXIT_BAD_INPUT
    except ValueError as exc:  # edge-tts validates voice/rate/pitch/volume format with ValueError
        log.error("invalid edge-tts parameter: %s", exc)
        return EXIT_BAD_INPUT
    except (SynthesisError, OSError) as exc:
        log.error("synthesis failed (the edge-tts endpoint is unofficial and may be down): %s", exc)
        return EXIT_SYNTH_FAILED
    sys.stdout.write(json.dumps(asdict(narration), ensure_ascii=True) + "\n")
    sys.stdout.flush()
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
