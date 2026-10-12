"""Unit checks for pause trimming (mp3_pauses.py) and its synthesize.py wiring.

Run: .venv/Scripts/python.exe -m unittest discover -s python/tts -p "test_*.py"
"""

from __future__ import annotations

import array
import io
import json
import logging
import tempfile
import time
import unittest
import wave
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

import mp3_pauses as mp
import synthesize as synth

HEADER = bytes.fromhex("fff364c4")  # MPEG-2 Layer III, 48 kbps, 24 kHz, mono, no CRC (what edge-tts sends)
PAYLOAD = 144 - 4 - 9
FRAME_MS = 24
LOUD_GAIN, NOISE_FLOOR_GAIN = 170, 120
VOICE_SAMPLES = Path(__file__).resolve().parents[2] / "data" / "voice_samples"


def side_info(main_data_begin: int, main_data_bits: int, global_gain: int) -> bytes:
    bits = (main_data_begin << 64) | (main_data_bits << 51) | (global_gain << 34)  # 8 + 1 private + 12 + 9 big_values
    return bits.to_bytes(9, "big")


def frame(data_bytes: int, tag: int, gain: int | None = None) -> mp.Frame:
    """A frame whose main data is `data_bytes` bytes of a recognizable pattern (0 = digital silence)."""
    data = bytes((tag + i) % 251 + 1 for i in range(data_bytes))
    gain = gain if gain is not None else (LOUD_GAIN if data_bytes else 210)
    return mp.Frame(HEADER, side_info(0, data_bytes * 8, gain), PAYLOAD, data, 24000)


def stream(specs: list[int | tuple[int, int]]) -> bytes:
    """Encode frames from main-data sizes or (size, global_gain); sizes > PAYLOAD use the bit reservoir."""
    frames = [
        frame(spec[0], tag, spec[1]) if isinstance(spec, tuple) else frame(spec, tag) for tag, spec in enumerate(specs)
    ]
    return mp.repack(frames)


def speech(frames: int) -> list[int]:
    """Main-data sizes averaging under one payload, alternating so every other frame borrows from the reservoir."""
    return [170, 80] * (frames // 2)


def speech_with_pause(pause_frames: int, speech_frames: int = 10) -> tuple[bytes, list[tuple[int, int]]]:
    sizes = [0, 0] + speech(speech_frames) + [0] * pause_frames + speech(speech_frames) + [0] * 30
    first_end = (2 + speech_frames) * FRAME_MS
    second_start = first_end + pause_frames * FRAME_MS
    spans = [(2 * FRAME_MS + 10, first_end), (second_start, second_start + speech_frames * FRAME_MS)]
    return stream(sizes), spans


class ParseAndRepackTest(unittest.TestCase):
    def test_round_trip_keeps_every_frames_main_data(self) -> None:
        sizes = [0, 150, 200, 40, 0, 0, 260, 60, 0]
        frames = mp.parse_frames(stream(sizes))
        self.assertEqual([len(f.main_data) for f in frames], sizes)
        self.assertEqual([f.main_data for f in frames], [frame(s, t).main_data for t, s in enumerate(sizes)])

    def test_reservoir_is_used_and_bounded(self) -> None:
        audio = stream([0, 0, 250, 0, 0, 250])
        begins = [audio[i * 144 + 4] for i in range(6)]
        self.assertTrue(all(0 <= b <= mp.MAX_MAIN_DATA_BEGIN for b in begins))
        self.assertGreater(begins[2], 0)

    def test_repack_rejects_data_that_cannot_fit(self) -> None:
        with self.assertRaises(mp.RepackError):
            mp.repack([frame(400, 0)])

    def test_id3_tags_are_ignored(self) -> None:
        audio = stream([0, 100, 0])
        tagged = b"ID3\x04\x00\x00\x00\x00\x00\x05" + b"x" * 5 + audio + b"TAG" + bytes(125)
        self.assertEqual([f.main_data for f in mp.parse_frames(tagged)], [f.main_data for f in mp.parse_frames(audio)])

    def test_unsupported_streams_raise(self) -> None:
        stereo = bytes.fromhex("fff36404") + stream([0])[4:]
        for bad in (b"", b"not an mp3 at all, really", stereo, stream([0, 0])[:-1]):
            with self.subTest(bad=bad[:8]), self.assertRaises(mp.UnsupportedMp3Error):
                mp.parse_frames(bad)


class TrimTest(unittest.TestCase):
    def test_long_pause_is_cut_to_max_and_spectra_survive(self) -> None:
        audio, spans = speech_with_pause(pause_frames=36)  # 864 ms, like edge-tts sentence breaks
        result = mp.trim_pauses(audio, spans, max_pause_ms=250)
        gap = result.map_ms(spans[1][0]) - result.map_ms(spans[0][1])
        self.assertLessEqual(gap, 250)
        self.assertGreater(gap, 250 - FRAME_MS)
        before, after = mp.parse_frames(audio), mp.parse_frames(result.audio)
        kept = [f.main_data for k, f in enumerate(before) if k not in set(result.removed_frames)]
        self.assertEqual([f.main_data for f in after], kept)
        self.assertTrue(all(before[k].silent for k in result.removed_frames))

    def test_duration_and_timings_shift_by_whole_frames(self) -> None:
        audio, spans = speech_with_pause(pause_frames=36)
        result = mp.trim_pauses(audio, spans, max_pause_ms=250)
        removed_ms = len(result.removed_frames) * FRAME_MS
        self.assertEqual(len(result.audio), len(audio) - len(result.removed_frames) * 144)
        self.assertEqual(synth.mp3_duration_ms(len(result.audio)), synth.mp3_duration_ms(len(audio)) - removed_ms)
        self.assertEqual(result.map_ms(spans[0][1]), spans[0][1])  # before the cut: unchanged
        mid_removed = [k for k in result.removed_frames if spans[0][1] < k * FRAME_MS < spans[1][0]]
        self.assertEqual(result.map_ms(spans[1][0]), spans[1][0] - len(mid_removed) * FRAME_MS)

    def test_short_pauses_and_words_are_untouched(self) -> None:
        audio, spans = speech_with_pause(pause_frames=8)  # 192 ms
        result = mp.trim_pauses(audio, spans, max_pause_ms=250)
        first_speech, last_speech = 2, 2 + 10 + 8 + 10
        self.assertFalse([k for k in result.removed_frames if first_speech <= k < last_speech])

    def test_only_quiet_frames_are_dropped(self) -> None:
        noise, breath = (60, NOISE_FLOOR_GAIN), (60, 160)
        gap = [noise] * 10 + [breath] * 10 + [noise] * 10  # 720 ms: noise floor, an audible breath, noise floor
        audio = stream([0, 0, *speech(10), *gap, *speech(10), 0, 0])
        result = mp.trim_pauses(audio, [(48, 288), (1008, 1248)], max_pause_ms=250)
        in_gap = [k for k in result.removed_frames if 12 <= k < 42]
        self.assertEqual(len(in_gap), 20)  # every noise-floor frame, never the breath
        self.assertFalse([k for k in in_gap if 22 <= k < 32])

    def test_decoded_peaks_override_the_gain_proxy(self) -> None:
        frames = mp.parse_frames(stream([0, (60, LOUD_GAIN), (60, LOUD_GAIN), (60, NOISE_FLOOR_GAIN)]))
        self.assertEqual(mp.quiet_frames(frames, None), [True, False, False, True])
        self.assertEqual(mp.quiet_frames(frames, [-20.0, -70.0, -20.0, -20.0]), [True, True, False, False])
        self.assertEqual(mp.quiet_frames(frames, [-70.0]), [True, False, False, True])  # wrong length: proxy

    def test_frame_peaks_cover_the_overlap_into_the_next_frame(self) -> None:
        samples = [0] * (3 * mp.SAMPLES_PER_FRAME)
        samples[mp.SAMPLES_PER_FRAME + 5] = -16384  # -6 dBFS inside frame 1
        peaks = mp.frame_peaks_dbfs(samples, 3)
        self.assertAlmostEqual(peaks[0], -6.02, places=2)
        self.assertAlmostEqual(peaks[1], -6.02, places=2)
        self.assertLess(peaks[2], -90)

    def test_leading_and_trailing_silence_are_trimmed(self) -> None:
        sizes = [0] * 10 + [100] * 10 + [0] * 40
        spans = [(240, 480)]
        result = mp.trim_pauses(stream(sizes), spans, max_pause_ms=250)
        self.assertGreaterEqual(result.map_ms(240), mp.LEAD_KEEP_MS)  # whole frames: 50..73 ms of lead
        self.assertLess(result.map_ms(240), mp.LEAD_KEEP_MS + FRAME_MS)
        duration = len(result.audio) // 144 * FRAME_MS
        self.assertGreaterEqual(duration - result.map_ms(480), mp.TRAIL_KEEP_MS)
        self.assertLessEqual(duration - result.map_ms(480), mp.TRAIL_KEEP_MS + FRAME_MS)

    def test_zero_disables_trimming(self) -> None:
        audio, spans = speech_with_pause(pause_frames=36)
        self.assertEqual(mp.trim_pauses(audio, spans, max_pause_ms=0).audio, audio)

    def test_time_inside_a_removed_frame_snaps_to_the_cut(self) -> None:
        result = mp.TrimResult(audio=b"", removed_frames=(2, 3), frame_ms=24)
        self.assertEqual([result.map_ms(t) for t in (40, 48, 60, 96, 100)], [40, 48, 48, 48, 52])


@unittest.skipUnless(VOICE_SAMPLES.is_dir(), "no local edge-tts samples (data/voice_samples is gitignored)")
class RealNarrationTest(unittest.TestCase):
    def test_real_samples_keep_spectra_and_monotonic_timings(self) -> None:
        for sample in sorted(VOICE_SAMPLES.glob("*/narration.mp3")):
            with self.subTest(sample=sample.parent.name):
                words = json.loads(sample.with_name("timings.json").read_text(encoding="utf-8"))["words"]
                audio = sample.read_bytes()
                result = mp.trim_pauses(audio, [(w["startMs"], w["endMs"]) for w in words], 250)
                removed = set(result.removed_frames)
                kept = [f.main_data for k, f in enumerate(mp.parse_frames(audio)) if k not in removed]
                self.assertEqual([f.main_data for f in mp.parse_frames(result.audio)], kept)
                starts = [result.map_ms(w["startMs"]) for w in words]
                self.assertEqual(starts, sorted(starts))


class DecodeTest(unittest.TestCase):
    def test_wav_samples_reads_the_data_chunk(self) -> None:
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(24000)
            wav.writeframes(array.array("h", [1, -2, 32767]).tobytes())
        self.assertEqual(list(synth.wav_samples(buffer.getvalue()) or []), [1, -2, 32767])
        self.assertIsNone(synth.wav_samples(b"not a wav"))

    def test_without_ffmpeg_no_peaks(self) -> None:
        with mock.patch.object(synth, "find_ffmpeg", return_value=None):
            self.assertIsNone(synth.decode_peaks(stream([0, 0]), timeout=10))

    @unittest.skipUnless(synth.find_ffmpeg() and VOICE_SAMPLES.is_dir(), "needs node_modules ffmpeg and local samples")
    def test_real_sample_decodes_to_one_peak_per_frame(self) -> None:
        sample = next(VOICE_SAMPLES.glob("*/narration.mp3"))
        audio = sample.read_bytes()
        peaks = synth.decode_peaks(audio, timeout=30)
        self.assertIsNotNone(peaks)
        frames = mp.parse_frames(audio)
        self.assertEqual(len(peaks or []), len(frames))
        silent_peaks = [p for p, f in zip(peaks or [], frames, strict=True) if f.silent]
        self.assertTrue(silent_peaks)
        self.assertGreater(max(peaks or []), -20)  # speech is loud


class SynthesizeWiringTest(unittest.TestCase):
    def setUp(self) -> None:
        patcher = mock.patch.object(synth, "find_ffmpeg", return_value=None)  # deterministic: side-info proxy
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_cli_flag_defaults_and_parses(self) -> None:
        base = ["--text-file", "t.txt", "--out-dir", "out"]
        self.assertEqual(synth.parse_args(base).max_pause_ms, 250)
        self.assertEqual(synth.parse_args([*base, "--max-pause-ms=0"]).max_pause_ms, 0)

    def test_negative_max_pause_is_bad_input(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            text = Path(tmp, "t.txt")
            text.write_text("Olá.", encoding="utf-8")
            with self.assertLogs("synthesize", logging.ERROR):
                code = synth.main(["--text-file", str(text), "--out-dir", tmp, "--max-pause-ms=-1"])
        self.assertEqual(code, synth.EXIT_BAD_INPUT)

    def test_run_trims_and_writes_shifted_timings(self) -> None:
        audio, spans = speech_with_pause(pause_frames=36)
        words = [synth.WordTiming(f"w{i}", s, e) for i, (s, e) in enumerate(spans)]
        with tempfile.TemporaryDirectory() as tmp:
            text = Path(tmp, "t.txt")
            text.write_text("Uma frase. Outra frase.", encoding="utf-8")
            argv = ["--text-file", str(text), "--out-dir", tmp, "--max-pause-ms=250"]
            with (
                mock.patch.object(synth, "synthesize_with_retries", return_value=(audio, words)),
                redirect_stdout(io.StringIO()) as out,
            ):
                code = synth.main(argv)
            narration = json.loads(out.getvalue())
            self.assertEqual(code, synth.EXIT_OK)
            written = Path(tmp, synth.AUDIO_FILENAME).read_bytes()
            self.assertEqual(narration["durationMs"], synth.mp3_duration_ms(len(written)))
            self.assertLess(len(written), len(audio))
            gap = narration["words"][1]["startMs"] - narration["words"][0]["endMs"]
            self.assertLessEqual(gap, 250)

    def test_unexpected_audio_falls_back_to_untrimmed(self) -> None:
        words = [synth.WordTiming("a", 0, 100), synth.WordTiming("b", 1000, 1100)]
        with self.assertLogs("synthesize", logging.WARNING):
            audio, shifted = synth.shorten_pauses(b"garbage", words, 250, deadline=time.monotonic() + 60)
        self.assertEqual((audio, shifted), (b"garbage", words))


if __name__ == "__main__":
    unittest.main()
