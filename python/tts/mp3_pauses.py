"""Shorten long pauses in edge-tts MP3 narration by dropping whole MP3 frames (no re-encode, no ffmpeg).

edge-tts streams MPEG-2 Layer III, 24 kHz, mono, 48 kbps CBR without CRC: every frame is 144 bytes
and lasts exactly 24 ms, so word timings shift by whole frames and duration stays bytes * 8 / 48000.

Layer III frames are not independent: a frame's main data may start up to 255 bytes back, inside
earlier frames (the "bit reservoir"). Dropping frames therefore needs the main data re-laid out;
`repack` copies every kept frame's main data verbatim and rewrites only main_data_begin, so each
kept frame decodes to exactly the same spectrum as before.

Only "quiet" frames lying wholly inside the timing gap between two words (or before the first /
after the last word) are dropped. Quiet means part2_3_length == 0 (digital silence: no scalefactors,
no Huffman data) or a decoded peak <= QUIET_PEAK_DBFS over the frame and the next one (its overlap
reach); see frame_peaks_dbfs. When no decoded audio is available, global_gain <= QUIET_GLOBAL_GAIN
stands in: on 9 real narrations (~22k frames decoded with ffmpeg) every such frame peaked at or
below -55 dBFS (speech peaks around -3 dBFS), but it misses much of the -60..-75 dBFS noise floor
edge-tts leaves around words, so it trims less. Louder frames inside a gap (breaths, early onsets)
are kept, so a pause made of audible sound may stay longer than the limit.
Measured on the same narrations, the decoder-state mismatch after a cut stays below -52 dBFS (no
click). Anything unexpected in the stream disables trimming instead of risking a broken file.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from itertools import pairwise

HEADER_BYTES = 4
SIDE_INFO_BYTES = 9  # MPEG-2/2.5 Layer III, mono
SAMPLES_PER_FRAME = 576  # MPEG-2/2.5 Layer III: one granule
MAX_MAIN_DATA_BEGIN = 255  # 8-bit field in MPEG-2/2.5
LSF_BITRATES_KBPS = (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160)
SAMPLE_RATES = {0b10: (22050, 24000, 16000), 0b00: (11025, 12000, 8000)}  # MPEG-2, MPEG-2.5
ID3V1_BYTES = 128

QUIET_GLOBAL_GAIN = 133
QUIET_PEAK_DBFS = -55.0
PCM_FULL_SCALE = 32768
LEAD_KEEP_MS = 50
TRAIL_KEEP_MS = 100


class UnsupportedMp3Error(ValueError):
    """The stream is not the plain CBR mono MPEG-2 Layer III edge-tts produces."""


class RepackError(ValueError):
    """A kept frame's main data does not fit the reservoir left by the frames before it."""

    def __init__(self, kept_index: int) -> None:
        super().__init__(f"main data of kept frame {kept_index} does not fit")
        self.kept_index = kept_index


@dataclass(frozen=True)
class Frame:
    header: bytes
    side_info: bytes
    payload_size: int
    main_data: bytes
    sample_rate: int

    @property
    def silent(self) -> bool:
        return not self.main_data

    @property
    def global_gain(self) -> int:
        """Side-info bits 30..37 (after main_data_begin 8, private 1, part2_3_length 12, big_values 9)."""
        return (int.from_bytes(self.side_info, "big") >> (SIDE_INFO_BYTES * 8 - 38)) & 0xFF

    @property
    def quiet(self) -> bool:
        return self.silent or self.global_gain <= QUIET_GLOBAL_GAIN


@dataclass(frozen=True)
class TrimResult:
    audio: bytes
    removed_frames: tuple[int, ...]  # original frame indices, ascending
    frame_ms: float

    def map_ms(self, t_ms: int) -> int:
        """Original timeline -> trimmed timeline (a time inside a removed frame snaps to the cut)."""
        shift = 0.0
        for k in self.removed_frames:
            start, end = k * self.frame_ms, (k + 1) * self.frame_ms
            if t_ms <= start:
                break
            shift += min(t_ms, end) - start
        return round(t_ms - shift)

    @property
    def removed_ms(self) -> float:
        return len(self.removed_frames) * self.frame_ms


# --- parsing ---------------------------------------------------------------------------------


def strip_id3(audio: bytes) -> bytes:
    if audio[:3] == b"ID3" and len(audio) >= 10:
        size = (audio[6] << 21) | (audio[7] << 14) | (audio[8] << 7) | audio[9]
        footer = 10 if audio[5] & 0x10 else 0
        audio = audio[10 + size + footer :]
    if len(audio) >= ID3V1_BYTES and audio[-ID3V1_BYTES:][:3] == b"TAG":
        audio = audio[:-ID3V1_BYTES]
    return audio


def _frame_layout(header: int) -> tuple[int, int]:
    """(frame size in bytes, sample rate) for a supported header, else UnsupportedMp3Error."""
    version, layer, no_crc = (header >> 19) & 3, (header >> 17) & 3, (header >> 16) & 1
    bitrate_index, rate_index, padding = (header >> 12) & 15, (header >> 10) & 3, (header >> 9) & 1
    channel_mode = (header >> 6) & 3
    if header >> 21 != 0x7FF or version not in SAMPLE_RATES or layer != 0b01:
        raise UnsupportedMp3Error(f"not an MPEG-2/2.5 Layer III frame header: {header:08x}")
    if not no_crc or channel_mode != 0b11 or not 0 < bitrate_index < 15 or rate_index == 3:
        raise UnsupportedMp3Error(f"unsupported frame (CRC, stereo or free/bad bitrate): {header:08x}")
    sample_rate = SAMPLE_RATES[version][rate_index]
    return 72_000 * LSF_BITRATES_KBPS[bitrate_index] // sample_rate + padding, sample_rate


def _split_frames(audio: bytes) -> list[tuple[bytes, bytes, bytes, int]]:
    """(header, side info, payload, sample rate) for every frame; the stream must end on a frame."""
    frames, pos = [], 0
    while pos < len(audio):
        if pos + HEADER_BYTES + SIDE_INFO_BYTES > len(audio):
            raise UnsupportedMp3Error(f"truncated frame at byte {pos}")
        size, rate = _frame_layout(int.from_bytes(audio[pos : pos + HEADER_BYTES], "big"))
        if pos + size > len(audio):
            raise UnsupportedMp3Error(f"truncated frame at byte {pos}")
        side_end = pos + HEADER_BYTES + SIDE_INFO_BYTES
        frames.append(
            (audio[pos : pos + HEADER_BYTES], audio[pos + HEADER_BYTES : side_end], audio[side_end : pos + size], rate)
        )
        pos += size
    return frames


def parse_frames(audio: bytes) -> list[Frame]:
    raw = _split_frames(strip_id3(audio))
    if not raw or len({rate for *_, rate in raw}) != 1:
        raise UnsupportedMp3Error("no frames, or the sample rate changes mid-stream")
    stream = b"".join(payload for _, _, payload, _ in raw)
    frames, offset = [], 0
    for header, side_info, payload, rate in raw:
        main_data_begin = side_info[0]
        part2_3_bits = ((side_info[1] & 0x7F) << 5) | (side_info[2] >> 3)  # skip 1 private bit
        start, end = offset - main_data_begin, offset - main_data_begin + math.ceil(part2_3_bits / 8)
        if start < 0 or end > offset + len(payload):
            raise UnsupportedMp3Error(f"frame {len(frames)} main data lies outside the stream")
        frames.append(Frame(header, side_info, len(payload), stream[start:end], rate))
        offset += len(payload)
    return frames


# --- re-laying out the bit reservoir ---------------------------------------------------------


def repack(frames: Sequence[Frame]) -> bytes:
    """Serialize frames, placing each frame's main data as early as the reservoir allows."""
    stream, begins, data_end = bytearray(), [], 0
    for index, frame in enumerate(frames):
        payload_start = len(stream)
        start = max(data_end, payload_start - MAX_MAIN_DATA_BEGIN)
        data_end = start + len(frame.main_data)
        if data_end > payload_start + frame.payload_size:
            raise RepackError(index)
        stream.extend(bytes(frame.payload_size))
        stream[start:data_end] = frame.main_data
        begins.append(payload_start - start)
    out, offset = bytearray(), 0
    for frame, begin in zip(frames, begins, strict=True):
        out += frame.header + bytes([begin]) + frame.side_info[1:] + stream[offset : offset + frame.payload_size]
        offset += frame.payload_size
    return bytes(out)


# --- loudness -------------------------------------------------------------------------------


def frame_peaks_dbfs(samples: Sequence[int], frame_count: int) -> list[float]:
    """Peak of each frame's decoded output span (its own 576 samples plus the next 576 its overlap reaches)."""
    peaks = []
    for k in range(frame_count):
        window = samples[k * SAMPLES_PER_FRAME : (k + 2) * SAMPLES_PER_FRAME]
        peak = max(max(window, default=0), -min(window, default=0), 1)
        peaks.append(20 * math.log10(peak / PCM_FULL_SCALE))
    return peaks


def quiet_frames(frames: Sequence[Frame], peaks_dbfs: Sequence[float] | None) -> list[bool]:
    """Decoded peaks when available (exact); otherwise the side-info global_gain proxy."""
    if peaks_dbfs is None or len(peaks_dbfs) != len(frames):
        return [frame.quiet for frame in frames]
    return [frame.silent or peak <= QUIET_PEAK_DBFS for frame, peak in zip(frames, peaks_dbfs, strict=True)]


# --- choosing frames to drop -----------------------------------------------------------------


def _gap_removals(
    quiet: Sequence[bool], prev_end: float, next_start: float, max_pause_ms: int, frame_ms: float
) -> list[int]:
    excess = next_start - prev_end - max_pause_ms
    if excess <= 0:
        return []
    first, stop = max(math.ceil(prev_end / frame_ms), 0), min(math.floor(next_start / frame_ms), len(quiet))
    candidates = [k for k in range(first, stop) if quiet[k]]
    count = min(len(candidates), math.ceil(excess / frame_ms))
    middle = (len(candidates) - count) // 2  # keep the frames nearest the words
    return candidates[middle : middle + count]


def _leading_removals(quiet: Sequence[bool], first_start: float, frame_ms: float) -> list[int]:
    removed: list[int] = []
    for k, is_quiet in enumerate(quiet):
        if (k + 1) * frame_ms > first_start - LEAD_KEEP_MS or not is_quiet:
            break
        removed.append(k)
    return removed


def _trailing_removals(quiet: Sequence[bool], last_end: float, frame_ms: float) -> list[int]:
    removed: list[int] = []
    for k in range(len(quiet) - 1, 0, -1):
        if k * frame_ms < last_end + TRAIL_KEEP_MS or not quiet[k]:
            break
        removed.append(k)
    return removed


def plan_removals(
    quiet: Sequence[bool], spans: Sequence[tuple[int, int]], max_pause_ms: int, frame_ms: float
) -> set[int]:
    """Frames to drop so no inter-word gap exceeds max_pause_ms (where quiet frames allow it)."""
    removed = set(_leading_removals(quiet, spans[0][0], frame_ms))
    removed.update(_trailing_removals(quiet, spans[-1][1], frame_ms))
    for (_, prev_end), (next_start, _) in pairwise(spans):
        removed.update(_gap_removals(quiet, prev_end, next_start, max_pause_ms, frame_ms))
    return removed


def _repack_restoring(frames: Sequence[Frame], removed: set[int]) -> tuple[bytes, set[int]]:
    """Repack without `removed`; when a kept frame's data cannot fit, put back the nearest dropped frame before it."""
    removed = set(removed)
    while True:
        kept = [k for k in range(len(frames)) if k not in removed]
        try:
            return repack([frames[k] for k in kept]), removed
        except RepackError as exc:
            blocking = kept[exc.kept_index]
            earlier = [k for k in removed if k < blocking]
            if not earlier:
                raise
            removed.discard(max(earlier))


def trim_pauses(
    audio: bytes,
    spans: Sequence[tuple[int, int]],
    max_pause_ms: int,
    peaks_dbfs: Sequence[float] | None = None,
) -> TrimResult:
    """Drop frames per plan_removals; spans are (startMs, endMs) of the words in order.

    peaks_dbfs: optional per-frame decoded peaks (frame_peaks_dbfs) to judge quietness exactly.
    """
    frames = parse_frames(audio)
    frame_ms = SAMPLES_PER_FRAME * 1000 / frames[0].sample_rate
    if max_pause_ms <= 0 or not spans:
        return TrimResult(audio=audio, removed_frames=(), frame_ms=frame_ms)
    planned = plan_removals(quiet_frames(frames, peaks_dbfs), spans, max_pause_ms, frame_ms)
    trimmed, removed = _repack_restoring(frames, planned)
    return TrimResult(audio=trimmed, removed_frames=tuple(sorted(removed)), frame_ms=frame_ms)
