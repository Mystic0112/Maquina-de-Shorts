"""Synthesize pt-BR narration with Kokoro (local, Apache-2.0) into a 16-bit mono WAV.

Usage:
    <kokoro-venv>/python python/tts/synthesize_kokoro.py --text-file <path> --out <narration.source.wav>
        [--voice pm_alex] [--speed 1.0] [--lang p]

Kokoro does not split Brazilian Portuguese into sentences itself (it feeds the whole text to the
model, well past the recommended 100-200 tokens), so the text is split here sentence by sentence
and the pieces are joined with a short silence. Word timings come later from align_narration.py,
exactly as for Gemini audio. Prints one JSON object on stdout:
    {"audioPath": str, "durationMs": int, "sentences": int, "engine": "kokoro"}
All logging goes to stderr. Exit codes: 0 ok, 1 synthesis failed, 2 invalid arguments/input.

Runs inside a separate venv (torch is heavy); see README "Narração" and KOKORO_PYTHON in .env.
On Linux the bundled espeak-ng may miss its data files; ESPEAK_DATA_PATH / PHONEMIZER_ESPEAK_LIBRARY
are honoured when set, otherwise the distro's usual locations are tried.
"""

from __future__ import annotations

import argparse
import array
import io
import json
import logging
import os
import re
import sys
import wave
from collections.abc import Iterable
from pathlib import Path

SAMPLE_RATE = 24_000
GAP_MS = 120
MAX_SENTENCE_CHARS = 180
DEFAULT_VOICE = "pm_alex"
EXIT_OK, EXIT_FAILED, EXIT_BAD_INPUT = 0, 1, 2
ESPEAK_DATA_CANDIDATES = ("/usr/lib/x86_64-linux-gnu/espeak-ng-data", "/usr/share/espeak-ng-data")
ESPEAK_LIB_CANDIDATES = ("/usr/lib/x86_64-linux-gnu/libespeak-ng.so.1", "/usr/lib/libespeak-ng.so.1")

log = logging.getLogger("kokoro")


class InputError(ValueError):
    """Invalid CLI arguments or input files."""


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Kokoro TTS -> 16-bit mono WAV")
    parser.add_argument("--text-file", type=Path, required=True, help="UTF-8 text to speak")
    parser.add_argument("--out", type=Path, required=True, help="output WAV path")
    parser.add_argument("--voice", default=DEFAULT_VOICE, help="Kokoro voice id (pm_alex, pf_dora, pm_santa)")
    parser.add_argument("--speed", type=float, default=1.0, help="0.5-2.0")
    parser.add_argument("--lang", default="p", help="Kokoro lang_code (p = Brazilian Portuguese)")
    return parser.parse_args(argv)


# --- text --------------------------------------------------------------------------------------

_SENTENCE_END = re.compile(r"(?<=[.!?…])\s+")
_CLAUSE_END = re.compile(r"(?<=[;,])\s+")


def _split_long(sentence: str, limit: int) -> list[str]:
    """Break a long sentence at ; or , keeping each piece under `limit` chars when possible."""
    if len(sentence) <= limit:
        return [sentence]
    pieces, current = [], ""
    for clause in _CLAUSE_END.split(sentence):
        candidate = f"{current} {clause}".strip() if current else clause
        if current and len(candidate) > limit:
            pieces.append(current)
            current = clause
        else:
            current = candidate
    if current:
        pieces.append(current)
    return pieces


def split_sentences(text: str, limit: int = MAX_SENTENCE_CHARS) -> list[str]:
    """Sentences (on . ! ? …), long ones further split on ; and , past `limit` characters."""
    normalized = " ".join(text.split())
    if not normalized:
        return []
    return [piece for sentence in _SENTENCE_END.split(normalized) for piece in _split_long(sentence, limit) if piece]


# --- audio -------------------------------------------------------------------------------------


def float_to_pcm16(samples: Iterable[float]) -> array.array[int]:
    """float32 [-1, 1] -> clipped 16-bit signed samples."""
    return array.array("h", (int(max(-1.0, min(1.0, float(s))) * 32767) for s in samples))


def join_with_silence(
    chunks: list[array.array[int]], gap_ms: int = GAP_MS, rate: int = SAMPLE_RATE
) -> array.array[int]:
    gap = array.array("h", bytes(2 * (rate * gap_ms // 1000)))
    out = array.array("h")
    for index, chunk in enumerate(chunks):
        if index:
            out.extend(gap)
        out.extend(chunk)
    return out


def to_wav(samples: array.array[int], rate: int = SAMPLE_RATE) -> bytes:
    data = array.array("h", samples)
    if sys.byteorder == "big":
        data.byteswap()
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(data.tobytes())
    return buffer.getvalue()


# --- espeak ------------------------------------------------------------------------------------


def configure_espeak(environ: dict[str, str] = os.environ, platform: str = sys.platform) -> None:
    """Point phonemizer at the distro's espeak-ng on Linux unless the caller already did."""
    if not platform.startswith("linux"):
        return
    if "ESPEAK_DATA_PATH" not in environ:
        data = next((p for p in ESPEAK_DATA_CANDIDATES if Path(p, "phontab").is_file()), None)
        if data:
            environ["ESPEAK_DATA_PATH"] = data
    if "PHONEMIZER_ESPEAK_LIBRARY" not in environ:
        lib = next((p for p in ESPEAK_LIB_CANDIDATES if Path(p).is_file()), None)
        if lib:
            environ["PHONEMIZER_ESPEAK_LIBRARY"] = lib


KOKORO_REPO = "hexgrad/Kokoro-82M"


def prefer_offline_hub(environ: dict[str, str] = os.environ) -> None:
    """Use the cached Kokoro weights without contacting the Hub once they are downloaded.

    Online, huggingface_hub logs "set a HF_TOKEN to enable higher rate limits" as a WARNING, which the
    pipeline's log watchers read as a quota error. The first run (nothing cached yet) stays online.
    """
    if "HF_HUB_OFFLINE" in environ:
        return
    hub = Path(environ.get("HF_HUB_CACHE") or Path(environ.get("HF_HOME") or Path.home() / ".cache" / "huggingface") / "hub")
    if (hub / f"models--{KOKORO_REPO.replace('/', '--')}" / "snapshots").is_dir():
        environ["HF_HUB_OFFLINE"] = "1"


# --- main --------------------------------------------------------------------------------------


def synthesize(sentences: list[str], voice: str, speed: float, lang: str) -> list[array.array[int]]:
    from kokoro import (
        KPipeline,  # heavy import (torch); only here so the helpers stay testable
    )

    pipeline = KPipeline(lang_code=lang)
    chunks: list[array.array[int]] = []
    for index, sentence in enumerate(sentences, 1):
        pieces = [float_to_pcm16(audio) for _, _, audio in pipeline(sentence, voice=voice, speed=speed)]
        if not pieces:
            log.warning("sentence %d produced no audio: %r", index, sentence[:60])
            continue
        chunks.append(join_with_silence(pieces, gap_ms=0))
        log.info("sentence %d/%d: %d ms", index, len(sentences), sum(len(p) for p in pieces) * 1000 // SAMPLE_RATE)
    return chunks


def run(args: argparse.Namespace) -> dict[str, object]:
    if not args.text_file.is_file():
        raise InputError(f"missing text file: {args.text_file}")
    if not 0.5 <= args.speed <= 2.0:
        raise InputError(f"--speed must be between 0.5 and 2.0, got {args.speed}")
    sentences = split_sentences(args.text_file.read_text(encoding="utf-8-sig"))
    if not sentences:
        raise InputError(f"text file has no words: {args.text_file}")
    configure_espeak()
    prefer_offline_hub()
    chunks = synthesize(sentences, args.voice, args.speed, args.lang)
    if not chunks:
        raise RuntimeError("Kokoro produced no audio")
    samples = join_with_silence(chunks)
    out: Path = args.out.expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(to_wav(samples))
    return {
        "audioPath": str(out),
        "durationMs": round(len(samples) * 1000 / SAMPLE_RATE),
        "sentences": len(sentences),
        "engine": "kokoro",
    }


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="[kokoro] %(levelname)s %(message)s")
    args = parse_args(argv)
    try:
        result = run(args)
    except InputError as exc:
        log.error("%s", exc)
        return EXIT_BAD_INPUT
    except ImportError as exc:
        log.error(
            "kokoro is missing in this interpreter (%s); see README 'Narração' and KOKORO_PYTHON: %s",
            sys.executable,
            exc,
        )
        return EXIT_FAILED
    except (RuntimeError, OSError) as exc:
        log.error("%s", exc)
        return EXIT_FAILED
    sys.stdout.write(json.dumps(result, ensure_ascii=True) + "\n")
    sys.stdout.flush()
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
