"""Synthesize pt-BR narration with edge-tts and emit word timings.

Usage:
    python python/tts/synthesize.py --text-file <path> --out-dir <dir>
        [--voice pt-BR-AntonioNeural] [--rate=+5%]   (use the = form for negative rates)

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
RATE_PATTERN = re.compile(r"^[+-]\d+%$")

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


async def stream_speech(text: str, voice: str, rate: str) -> tuple[bytes, list[WordTiming]]:
    # edge-tts 7.x defaults to SentenceBoundary; word-level captions need WordBoundary.
    communicate = edge_tts.Communicate(text, voice, rate=rate, boundary="WordBoundary")
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


def synthesize_with_retries(text: str, voice: str, rate: str) -> tuple[bytes, list[WordTiming]]:
    last_error: Exception | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            audio, words = asyncio.run(asyncio.wait_for(stream_speech(text, voice, rate), SYNTH_TIMEOUT_SECONDS))
            if not audio:
                raise SynthesisError("edge-tts returned no audio")
            if not words:
                raise SynthesisError("edge-tts returned audio but no WordBoundary events")
            return audio, words
        except (EdgeTTSException, SynthesisError, aiohttp.ClientError, OSError, TimeoutError) as exc:
            last_error = exc
            log.warning("attempt %d/%d failed: %s: %s", attempt, MAX_ATTEMPTS, type(exc).__name__, exc)
            if attempt < MAX_ATTEMPTS:
                time.sleep(2 * attempt)
    raise SynthesisError(f"edge-tts failed after {MAX_ATTEMPTS} attempts: {last_error}") from last_error


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


def run(args: argparse.Namespace) -> Narration:
    text = read_text(args.text_file)
    rate = validate_rate(args.rate)
    out_dir: Path = args.out_dir.expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    log.info("synthesizing %d chars with %s (rate %s)", len(text), args.voice, rate)
    audio, words = synthesize_with_retries(text, args.voice, rate)
    narration = build_narration(out_dir, audio, words)
    write_atomic(out_dir / AUDIO_FILENAME, audio)
    timings_json = json.dumps(asdict(narration), ensure_ascii=False, indent=2).encode("utf-8")
    write_atomic(out_dir / TIMINGS_FILENAME, timings_json)
    log.info("wrote %s (%d ms, %d words)", narration.audioPath, narration.durationMs, len(narration.words))
    return narration


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="[synthesize] %(levelname)s %(message)s")
    args = parse_args(argv)
    try:
        narration = run(args)
    except InputError as exc:
        log.error("%s", exc)
        return EXIT_BAD_INPUT
    except ValueError as exc:  # edge-tts validates voice/rate format with ValueError
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
