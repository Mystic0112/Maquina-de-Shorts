"""Word timings for narration whose text is known (Gemini TTS returns audio without word boundaries).

faster-whisper transcribes the audio with word timestamps; the recognized words are then aligned to
the script's own words with a global (Needleman-Wunsch) alignment on accent-free tokens, so the
output keeps exactly the script's words, in order. Script words without a confident match (ASR
misspellings, "1818" for "mil oitocentos e dezoito", merged words) get the time span of the ASR
words between the neighbouring matches, split in proportion to their length.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass
from difflib import SequenceMatcher
from itertools import pairwise
from pathlib import Path

log = logging.getLogger("align")

DEFAULT_WHISPER_MODEL = "base"
WHISPER_RATE = 16_000
ANCHOR_SIMILARITY = 0.75  # a script/ASR pair this similar fixes the script word's timing
GAP_PENALTY = -0.6
EDGE_PUNCTUATION = re.compile(r"^[^\w]+|[^\w]+$", re.UNICODE)
MS_PER_CHAR_GUESS = 65
SNAP_RADIUS_MS = 250
MIN_WORD_MS = 40  # only for words before the first / after the last match with no ASR words around


@dataclass(frozen=True)
class AsrWord:
    text: str
    start_ms: int
    end_ms: int


@dataclass(frozen=True)
class AlignedWord:
    word: str
    start_ms: int
    end_ms: int


@dataclass(frozen=True)
class Alignment:
    words: list[AlignedWord]
    matched: int  # script words timed by their own ASR word

    @property
    def matched_ratio(self) -> float:
        return self.matched / len(self.words) if self.words else 0.0


# --- tokens ----------------------------------------------------------------------------------


def script_words(text: str) -> list[str]:
    """Display words of the script: whitespace split, edge punctuation removed, empty tokens dropped."""
    words = (EDGE_PUNCTUATION.sub("", raw) for raw in text.split())
    return [w for w in words if normalize(w)]


def normalize(word: str) -> str:
    """Same rule as normalizeToken in src/orchestrator/lib/ptBr.ts: no accents, lowercase, letters/digits."""
    stripped = "".join(c for c in unicodedata.normalize("NFD", word) if not unicodedata.combining(c))
    return re.sub(r"[^\w]|_", "", stripped.lower())


def similarity(a: str, b: str) -> float:
    if a == b:
        return 1.0
    return SequenceMatcher(None, a, b).ratio() if a and b else 0.0


# --- global alignment ------------------------------------------------------------------------


def _pair_score(a: str, b: str) -> float:
    sim = similarity(a, b)
    return 2 * sim - 1 if sim >= 0.5 else -1.0


def align_pairs(script: Sequence[str], asr: Sequence[str]) -> list[tuple[int, int]]:
    """(script index, asr index) pairs on the best global alignment's diagonal moves."""
    n, m = len(script), len(asr)
    score = [[0.0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        score[i][0] = i * GAP_PENALTY
    for j in range(1, m + 1):
        score[0][j] = j * GAP_PENALTY
    for i in range(1, n + 1):
        row, prev = score[i], score[i - 1]
        for j in range(1, m + 1):
            row[j] = max(
                prev[j - 1] + _pair_score(script[i - 1], asr[j - 1]), prev[j] + GAP_PENALTY, row[j - 1] + GAP_PENALTY
            )
    return _traceback(score, script, asr)


def _traceback(score: list[list[float]], script: Sequence[str], asr: Sequence[str]) -> list[tuple[int, int]]:
    pairs, i, j = [], len(script), len(asr)
    while i > 0 and j > 0:
        if abs(score[i][j] - (score[i - 1][j - 1] + _pair_score(script[i - 1], asr[j - 1]))) < 1e-9:
            pairs.append((i - 1, j - 1))
            i, j = i - 1, j - 1
        elif abs(score[i][j] - (score[i - 1][j] + GAP_PENALTY)) < 1e-9:
            i -= 1
        else:
            j -= 1
    return pairs[::-1]


# --- timing ----------------------------------------------------------------------------------


def align_script(script: Sequence[str], asr: Sequence[AsrWord], duration_ms: int) -> Alignment:
    """Times for every script word, in order, from ASR words (see module docstring)."""
    norms, asr_norms = [normalize(w) for w in script], [normalize(w.text) for w in asr]
    anchors = [
        (i, j) for i, j in align_pairs(norms, asr_norms) if similarity(norms[i], asr_norms[j]) >= ANCHOR_SIMILARITY
    ]
    spans: list[tuple[int, int] | None] = [None] * len(script)
    for i, j in anchors:
        spans[i] = (asr[j].start_ms, asr[j].end_ms)
    bounds = [(-1, -1), *anchors, (len(script), len(asr))]
    for (i0, j0), (i1, j1) in pairwise(bounds):
        if i1 - i0 > 1:
            window = _gap_window(asr, j0, j1, duration_ms, norms[i0 + 1 : i1])
            for offset, span in enumerate(_split(window, norms[i0 + 1 : i1])):
                spans[i0 + 1 + offset] = span
    words = [AlignedWord(w, *span) for w, span in zip(script, _monotonic(spans, duration_ms), strict=True)]
    return Alignment(words=words, matched=len(anchors))


def _gap_window(asr: Sequence[AsrWord], j0: int, j1: int, duration_ms: int, norms: Sequence[str]) -> tuple[int, int]:
    """Time available to unmatched script words between ASR anchors j0 and j1 (-1 / len(asr) = edges)."""
    if not asr:
        return 0, duration_ms
    between = asr[j0 + 1 : j1]
    if between:
        return between[0].start_ms, between[-1].end_ms
    guess = MS_PER_CHAR_GUESS * sum(max(len(n), 1) for n in norms)
    start = asr[j0].end_ms if j0 >= 0 else max(0, (asr[j1].start_ms if j1 < len(asr) else duration_ms) - guess)
    end = asr[j1].start_ms if j1 < len(asr) else min(duration_ms, start + guess)
    return start, max(start, end)


def _split(window: tuple[int, int], norms: Sequence[str]) -> list[tuple[int, int]]:
    start, end = window
    weights = [max(len(n), 1) for n in norms]
    total, spans, acc = sum(weights), [], 0
    for weight in weights:
        a = start + (end - start) * acc // total
        acc += weight
        spans.append((a, start + (end - start) * acc // total))
    return spans


def _monotonic(spans: Sequence[tuple[int, int] | None], duration_ms: int) -> list[tuple[int, int]]:
    """Clamp to [0, duration], starts non-decreasing, each word ending no later than the next starts."""
    out: list[tuple[int, int]] = []
    floor = 0
    for span in spans:
        start, end = span if span else (floor, floor)
        start = min(max(start, floor), duration_ms)
        out.append((start, min(max(end, start), duration_ms)))
        floor = start
    return [
        (start, max(start, min(end, out[k + 1][0]))) if k + 1 < len(out) else (start, end)
        for k, (start, end) in enumerate(out)
    ]


def snap_to_pauses(words: Sequence[AlignedWord], pauses: Sequence[tuple[int, int]]) -> list[AlignedWord]:
    """Move word boundaries onto clear pauses in the audio (Whisper ends words ~100 ms early).

    Each pause (start_ms, end_ms) claims the nearest word boundary within SNAP_RADIUS_MS of its
    middle: the previous word then ends where the pause starts and the next word starts where it
    ends, provided both words keep at least MIN_WORD_MS.
    """
    out = list(words)
    used: set[int] = set()
    for pause_start, pause_end in pauses:
        middle = (pause_start + pause_end) / 2
        k = _nearest_boundary(out, middle, used)
        if k is None:
            continue
        before, after = out[k], out[k + 1]
        if pause_start - before.start_ms >= MIN_WORD_MS and after.end_ms - pause_end >= MIN_WORD_MS:
            out[k] = AlignedWord(before.word, before.start_ms, pause_start)
            out[k + 1] = AlignedWord(after.word, pause_end, after.end_ms)
            used.add(k)
    return out


def _nearest_boundary(words: Sequence[AlignedWord], at_ms: float, used: set[int]) -> int | None:
    """Index k of the boundary between words k and k+1 closest to at_ms, if within SNAP_RADIUS_MS."""
    best, best_distance = None, SNAP_RADIUS_MS
    for k in range(len(words) - 1):
        distance = abs((words[k].end_ms + words[k + 1].start_ms) / 2 - at_ms)
        if k not in used and distance <= best_distance:
            best, best_distance = k, distance
    return best


# --- ASR -------------------------------------------------------------------------------------


def model_is_cached(model: str, models_dir: Path) -> bool:
    return any(models_dir.glob(f"models--Systran--faster-whisper-{model}/snapshots/*/model.bin"))


def to_whisper_input(samples: Sequence[int], rate: int):  # -> numpy float32 array at 16 kHz
    """Mono float32 at Whisper's 16 kHz (linear resampling is plenty for recognition)."""
    import numpy as np

    source = np.asarray(samples, dtype=np.float32) / 32768.0
    if rate == WHISPER_RATE or source.size == 0:
        return source
    target = np.arange(0, source.size * WHISPER_RATE // rate) * (rate / WHISPER_RATE)
    return np.interp(target, np.arange(source.size), source).astype(np.float32)


def transcribe(samples: Sequence[int], rate: int, model: str, models_dir: Path) -> list[AsrWord]:
    """Word-timestamped pt-BR transcription (CPU, int8). Downloads the model on first use.

    No initial_prompt: giving Whisper the script as prompt made it skip whole sentences it
    "already saw" (26% of words recognized on one real narration); no conditioning on previous
    text either, which avoids repetition loops.
    """
    from faster_whisper import (
        WhisperModel,  # heavy import: only when a Gemini narration needs it
    )

    if not model_is_cached(model, models_dir):
        log.warning("downloading faster-whisper model %r to %s (one-time, several hundred MB)", model, models_dir)
    whisper = WhisperModel(model, device="cpu", compute_type="int8", download_root=str(models_dir))
    segments, _ = whisper.transcribe(
        to_whisper_input(samples, rate),
        language="pt",
        word_timestamps=True,
        beam_size=5,
        condition_on_previous_text=False,
    )
    return [
        AsrWord(w.word.strip(), round(w.start * 1000), round(w.end * 1000))
        for segment in segments
        for w in segment.words or []
        if normalize(w.word)
    ]
