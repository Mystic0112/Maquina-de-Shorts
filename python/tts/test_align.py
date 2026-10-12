"""Unit checks for Gemini narration post-processing: PCM pause trimming, script alignment, CLI.

Run: .venv/Scripts/python.exe -m unittest discover -s python/tts -p "test_*.py"
"""

from __future__ import annotations

import array
import io
import json
import logging
import tempfile
import unittest
from contextlib import redirect_stdout
from itertools import pairwise
from pathlib import Path
from unittest import mock

import align
import align_narration
import pcm_pauses as pp

RATE = 24_000


def tone(ms: int, amplitude: int = 12_000) -> list[int]:
    """Square-ish wave: loud enough to count as speech."""
    return [amplitude if (i // 20) % 2 else -amplitude for i in range(RATE * ms // 1000)]


def hush(ms: int, level: int = 30) -> list[int]:
    """Noise floor around -60 dBFS (Gemini pauses are not digital zero)."""
    return [level if i % 2 else -level for i in range(RATE * ms // 1000)]


def pcm(*parts: list[int]) -> pp.Pcm:
    return pp.Pcm(array.array("h", [s for part in parts for s in part]), RATE)


def asr(*words: tuple[str, int, int]) -> list[align.AsrWord]:
    return [align.AsrWord(text, start, end) for text, start, end in words]


class PcmPausesTest(unittest.TestCase):
    def test_long_interior_pause_keeps_max_pause(self) -> None:
        audio = pcm(hush(50), tone(400), hush(800), tone(400), hush(100))
        trimmed, cuts = pp.trim_pauses(audio, 250)
        self.assertEqual(len(cuts), 1)
        self.assertLessEqual(pp.longest_quiet_ms(trimmed), 250)
        self.assertGreaterEqual(pp.longest_quiet_ms(trimmed), 230)
        self.assertEqual(trimmed.duration_ms, round(len(trimmed.samples) * 1000 / RATE))

    def test_short_pauses_are_kept(self) -> None:
        audio = pcm(hush(50), tone(300), hush(200), tone(300), hush(100))
        self.assertEqual(pp.trim_pauses(audio, 250)[1], [])

    def test_leading_and_trailing_silence(self) -> None:
        audio = pcm(hush(600), tone(400), hush(900))
        trimmed, _ = pp.trim_pauses(audio, 250)
        quiet = pp.window_quiet(trimmed.samples, RATE // 100)
        lead = quiet.index(False) * 10
        tail = (len(quiet) - len(quiet) + quiet[::-1].index(False)) * 10
        self.assertAlmostEqual(lead, pp.LEAD_KEEP_MS, delta=10)
        self.assertAlmostEqual(tail, pp.TRAIL_KEEP_MS, delta=10)

    def test_zero_disables_and_speech_is_untouched(self) -> None:
        audio = pcm(hush(600), tone(400), hush(900), tone(400))
        self.assertEqual(pp.trim_pauses(audio, 0)[1], [])
        trimmed, _ = pp.trim_pauses(audio, 250)
        loud = [s for s in trimmed.samples if abs(s) == 12_000]
        self.assertEqual(len(loud), len(tone(400)) * 2)

    def test_crossfade_has_no_jump(self) -> None:
        audio = pcm(tone(300), hush(900, level=200), tone(300))
        trimmed, _ = pp.trim_pauses(audio, 250)
        quiet_part = [s for s in trimmed.samples if abs(s) < 1000]
        steps = [abs(b - a) for a, b in pairwise(quiet_part)]
        self.assertLessEqual(max(steps), 400)  # never more than the noise floor's own swing

    def test_wav_round_trip_and_rejects_stereo(self) -> None:
        audio = pcm(tone(30))
        self.assertEqual(pp.read_wav(pp.to_wav(audio)), audio)
        with self.assertRaises(pp.PcmFormatError):
            pp.read_wav(b"RIFF....WAVEjunk")

    def test_pauses_ms_lists_interior_pauses(self) -> None:
        audio = pcm(hush(200), tone(300), hush(150), tone(300), hush(60), tone(300), hush(200))
        self.assertEqual(pp.pauses_ms(audio, 120), [(500, 650)])


class AlignTest(unittest.TestCase):
    def test_script_words_drop_punctuation_but_keep_hyphens(self) -> None:
        self.assertEqual(
            align.script_words("Primeira: o guarda-chuva — “molhado”!"), ["Primeira", "o", "guarda-chuva", "molhado"]
        )

    def test_normalize_matches_the_typescript_rule(self) -> None:
        self.assertEqual(align.normalize("Ação!"), "acao")
        self.assertEqual(align.normalize("Vênus,"), "venus")

    def test_exact_transcript_keeps_asr_times(self) -> None:
        script = ["Vênus", "gira", "devagar"]
        result = align.align_script(script, asr(("Vênus", 0, 300), ("gira", 320, 600), ("devagar", 620, 1100)), 1200)
        self.assertEqual(
            [(w.word, w.start_ms, w.end_ms) for w in result.words],
            [("Vênus", 0, 300), ("gira", 320, 600), ("devagar", 620, 1100)],
        )
        self.assertEqual(result.matched_ratio, 1.0)

    def test_numbers_written_as_digits_are_interpolated(self) -> None:
        script = align.script_words("Em mil oitocentos e dezoito, Cubitt inventou")
        words = asr(("Em", 0, 100), ("1818,", 120, 1120), ("Cubbitt", 1150, 1500), ("inventou", 1520, 2000))
        result = align.align_script(script, words, 2100)
        spans = {w.word: (w.start_ms, w.end_ms) for w in result.words}
        self.assertEqual([w.word for w in result.words], script)
        self.assertEqual(spans["mil"][0], 120)
        self.assertEqual(spans["dezoito"][1], 1120)
        self.assertLess(spans["oitocentos"][0], spans["e"][0])
        self.assertEqual(spans["Cubitt"], (1150, 1500))  # misspelled but similar: still an anchor

    def test_missing_and_extra_asr_words(self) -> None:
        script = ["um", "dois", "três", "quatro"]
        result = align.align_script(script, asr(("um", 0, 100), ("hã", 110, 150), ("quatro", 400, 500)), 600)
        self.assertEqual([w.word for w in result.words], script)
        starts = [w.start_ms for w in result.words]
        self.assertEqual(starts, sorted(starts))
        self.assertTrue(all(w.end_ms >= w.start_ms for w in result.words))
        self.assertEqual(result.matched, 2)

    def test_no_recognized_words_spreads_over_the_audio(self) -> None:
        result = align.align_script(["a", "bb"], [], 900)
        self.assertEqual([(w.start_ms, w.end_ms) for w in result.words], [(0, 300), (300, 900)])
        self.assertEqual(result.matched_ratio, 0.0)

    def test_snap_moves_boundaries_onto_pauses(self) -> None:
        words = [align.AlignedWord("fim", 0, 380), align.AlignedWord("Novo", 520, 900)]
        snapped = align.snap_to_pauses(words, [(420, 600)])
        self.assertEqual([(w.start_ms, w.end_ms) for w in snapped], [(0, 420), (600, 900)])

    def test_snap_ignores_far_pauses_and_tiny_words(self) -> None:
        words = [align.AlignedWord("a", 0, 380), align.AlignedWord("b", 400, 900)]
        self.assertEqual(align.snap_to_pauses(words, [(2000, 2200)]), words)
        self.assertEqual(align.snap_to_pauses(words, [(10, 300)]), words)  # "a" would be < MIN_WORD_MS


class AlignNarrationCliTest(unittest.TestCase):
    def run_cli(self, audio: pp.Pcm, text: str, recognized: list[align.AsrWord], *extra: str) -> tuple[int, dict, Path]:
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: [p.unlink() for p in tmp.iterdir()] and tmp.rmdir())
        (tmp / "in.wav").write_bytes(pp.to_wav(audio))
        (tmp / "t.txt").write_text(text, encoding="utf-8")
        argv = ["--audio-in", str(tmp / "in.wav"), "--text-file", str(tmp / "t.txt"), "--out-dir", str(tmp), *extra]
        with mock.patch.object(align, "transcribe", return_value=recognized), redirect_stdout(io.StringIO()) as out:
            code = align_narration.main(argv)
        return code, json.loads(out.getvalue() or "{}"), tmp

    def test_writes_trimmed_wav_and_script_words(self) -> None:
        audio = pcm(hush(400), tone(500), hush(900), tone(500), hush(600))
        recognized = asr(("Olá", 60, 540), ("mundo", 820, 1300))
        code, narration, out_dir = self.run_cli(audio, "Olá. Mundo!", recognized)
        self.assertEqual(code, 0)
        self.assertEqual([w["word"] for w in narration["words"]], ["Olá", "Mundo"])
        written = pp.read_wav((out_dir / "narration.wav").read_bytes())
        self.assertEqual(narration["durationMs"], written.duration_ms)
        self.assertLess(written.duration_ms, audio.duration_ms)
        self.assertEqual(narration["alignment"], {"matchedRatio": 1.0, "model": "base"})
        self.assertEqual(
            json.loads((out_dir / "timings.json").read_text(encoding="utf-8"))["words"], narration["words"]
        )

    def test_audio_that_does_not_say_the_script_fails(self) -> None:
        with self.assertLogs("align_narration", logging.ERROR):
            code, _, _ = self.run_cli(
                pcm(tone(2000)), "um dois três quatro", asr(("outra", 0, 500), ("coisa", 600, 900))
            )
        self.assertEqual(code, align_narration.EXIT_FAILED)

    def test_empty_audio_fails_and_bad_args_are_input_errors(self) -> None:
        with self.assertLogs("align_narration", logging.ERROR):
            code, _, _ = self.run_cli(pcm(tone(100)), "olá", [])
        self.assertEqual(code, align_narration.EXIT_FAILED)
        with self.assertLogs("align_narration", logging.ERROR):
            code, _, _ = self.run_cli(pcm(tone(1000)), "olá", [], "--max-pause-ms=-1")
        self.assertEqual(code, align_narration.EXIT_BAD_INPUT)


if __name__ == "__main__":
    unittest.main()
