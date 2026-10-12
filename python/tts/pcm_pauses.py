"""Shorten long pauses in 16-bit mono PCM narration (Gemini TTS output) sample-accurately.

A pause is a run of 10 ms windows whose peak stays below SILENCE_DBFS. Interior pauses longer than
max_pause_ms keep max_pause_ms (half after the previous sound, half before the next one); leading
silence keeps LEAD_KEEP_MS and trailing silence TRAIL_KEEP_MS. Cuts are joined with a short linear
crossfade so the noise floor (-50..-70 dBFS in Gemini output) never steps. Trimming happens before
word alignment, so word timings come straight from the final audio and need no remapping.
"""

from __future__ import annotations

import array
import io
import math
import sys
import wave
from collections.abc import Sequence
from dataclasses import dataclass

SAMPLE_WIDTH = 2
WINDOW_MS = 10
SILENCE_DBFS = -40.0  # Gemini speech peaks near -1.5 dBFS; its noise floor sits at -50..-70 dBFS
LEAD_KEEP_MS = 50
TRAIL_KEEP_MS = 100
CROSSFADE_MS = 5
FULL_SCALE = 32768


class PcmFormatError(ValueError):
    """Audio is not 16-bit mono PCM."""


@dataclass(frozen=True)
class Pcm:
    samples: array.array[int]
    rate: int

    @property
    def duration_ms(self) -> int:
        return round(len(self.samples) * 1000 / self.rate)


@dataclass(frozen=True)
class Cut:
    start: int  # first removed sample
    end: int  # first kept sample after the cut


# --- I/O -------------------------------------------------------------------------------------


def _samples_from_bytes(data: bytes) -> array.array[int]:
    samples = array.array("h", data[: len(data) // SAMPLE_WIDTH * SAMPLE_WIDTH])
    if sys.byteorder == "big":
        samples.byteswap()
    return samples


def read_wav(data: bytes) -> Pcm:
    try:
        with wave.open(io.BytesIO(data), "rb") as wav:
            if wav.getsampwidth() != SAMPLE_WIDTH or wav.getnchannels() != 1:
                raise PcmFormatError(f"need 16-bit mono WAV, got {wav.getsampwidth() * 8}-bit x{wav.getnchannels()}")
            return Pcm(_samples_from_bytes(wav.readframes(wav.getnframes())), wav.getframerate())
    except (wave.Error, EOFError) as exc:
        raise PcmFormatError(f"not a WAV file: {exc}") from exc


def to_wav(pcm: Pcm) -> bytes:
    samples = array.array("h", pcm.samples)
    if sys.byteorder == "big":
        samples.byteswap()
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(SAMPLE_WIDTH)
        wav.setframerate(pcm.rate)
        wav.writeframes(samples.tobytes())
    return buffer.getvalue()


# --- detection -------------------------------------------------------------------------------


def window_quiet(samples: Sequence[int], window: int, threshold_dbfs: float = SILENCE_DBFS) -> list[bool]:
    limit = FULL_SCALE * 10 ** (threshold_dbfs / 20)
    quiet = []
    for start in range(0, len(samples), window):
        chunk = samples[start : start + window]
        quiet.append(max(max(chunk), -min(chunk)) < limit)
    return quiet


def quiet_runs(quiet: Sequence[bool]) -> list[tuple[int, int]]:
    """[first, stop) window index ranges of consecutive quiet windows."""
    runs, start = [], None
    for index, is_quiet in enumerate(quiet):
        if is_quiet and start is None:
            start = index
        elif not is_quiet and start is not None:
            runs.append((start, index))
            start = None
    if start is not None:
        runs.append((start, len(quiet)))
    return runs


def plan_cuts(pcm: Pcm, max_pause_ms: int, threshold_dbfs: float = SILENCE_DBFS) -> list[Cut]:
    """Sample ranges to drop; empty when max_pause_ms is 0 or the audio is all silence."""
    window = pcm.rate * WINDOW_MS // 1000
    total = len(pcm.samples)
    runs = quiet_runs(window_quiet(pcm.samples, window, threshold_dbfs))
    if max_pause_ms <= 0 or not runs or runs == [(0, math.ceil(total / window))]:
        return []
    cuts = []
    for first, stop in runs:
        start, end = first * window, min(stop * window, total)
        cut = _cut_for_run(start, end, total, pcm.rate, max_pause_ms)
        if cut:
            cuts.append(cut)
    return cuts


def _cut_for_run(start: int, end: int, total: int, rate: int, max_pause_ms: int) -> Cut | None:
    def keep(ms: int) -> int:
        return rate * ms // 1000

    if start == 0:
        cut = Cut(0, end - keep(LEAD_KEEP_MS))
    elif end == total:
        cut = Cut(start + keep(TRAIL_KEEP_MS), total)
    else:
        half = keep(max_pause_ms) // 2
        cut = Cut(start + half, end - (keep(max_pause_ms) - half))
    return cut if cut.end - cut.start > keep(CROSSFADE_MS) else None


# --- applying --------------------------------------------------------------------------------


def apply_cuts(pcm: Pcm, cuts: Sequence[Cut]) -> Pcm:
    """Drop each cut; the samples around an interior cut overlap in a crossfade of CROSSFADE_MS."""
    fade = pcm.rate * CROSSFADE_MS // 1000
    out = array.array("h")
    position = 0
    for cut in cuts:
        interior = 0 < cut.start and cut.end < len(pcm.samples)
        out.extend(pcm.samples[position : cut.start - (fade if interior else 0)])
        if interior:
            out.extend(_crossfade(pcm.samples[cut.start - fade : cut.start], pcm.samples[cut.end : cut.end + fade]))
            position = cut.end + fade
        else:
            position = cut.end
    out.extend(pcm.samples[position:])
    return Pcm(out, pcm.rate)


def _crossfade(tail: Sequence[int], head: Sequence[int]) -> list[int]:
    length = min(len(tail), len(head))
    return [round(tail[i] * (1 - (i + 0.5) / length) + head[i] * ((i + 0.5) / length)) for i in range(length)]


def trim_pauses(pcm: Pcm, max_pause_ms: int, threshold_dbfs: float = SILENCE_DBFS) -> tuple[Pcm, list[Cut]]:
    cuts = plan_cuts(pcm, max_pause_ms, threshold_dbfs)
    return (apply_cuts(pcm, cuts), cuts) if cuts else (pcm, [])


def longest_quiet_ms(pcm: Pcm, threshold_dbfs: float = SILENCE_DBFS, interior_only: bool = True) -> int:
    window = pcm.rate * WINDOW_MS // 1000
    quiet = window_quiet(pcm.samples, window, threshold_dbfs)
    runs = quiet_runs(quiet)
    if interior_only:
        runs = [(a, b) for a, b in runs if a > 0 and b < len(quiet)]
    return max(((b - a) * WINDOW_MS for a, b in runs), default=0)


def pauses_ms(pcm: Pcm, min_ms: int, threshold_dbfs: float = SILENCE_DBFS) -> list[tuple[int, int]]:
    """Interior quiet runs of at least min_ms, as (start_ms, end_ms)."""
    window = pcm.rate * WINDOW_MS // 1000
    quiet = window_quiet(pcm.samples, window, threshold_dbfs)
    return [
        (first * WINDOW_MS, stop * WINDOW_MS)
        for first, stop in quiet_runs(quiet)
        if first > 0 and stop < len(quiet) and (stop - first) * WINDOW_MS >= min_ms
    ]
