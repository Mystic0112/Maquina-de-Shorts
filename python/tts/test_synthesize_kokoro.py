"""Unit checks for synthesize_kokoro.py helpers (no kokoro/torch needed).

Run: .venv/Scripts/python.exe -m unittest discover -s python/tts -p "test_*.py"
"""

from __future__ import annotations

import array
import io
import tempfile
import unittest
import wave
from pathlib import Path

import synthesize_kokoro as sk


class SplitSentencesTest(unittest.TestCase):
    def test_splits_on_sentence_punctuation_and_normalizes_whitespace(self) -> None:
        text = "Olá, mundo.  Você sabia?\nIsso é incrível! E agora… fim"
        self.assertEqual(
            sk.split_sentences(text), ["Olá, mundo.", "Você sabia?", "Isso é incrível!", "E agora…", "fim"]
        )

    def test_long_sentences_break_on_commas(self) -> None:
        text = "Primeira parte da frase, segunda parte da frase; terceira parte da frase, quarta parte."
        pieces = sk.split_sentences(text, limit=40)
        self.assertEqual(
            pieces, ["Primeira parte da frase,", "segunda parte da frase;", "terceira parte da frase, quarta parte."]
        )
        self.assertEqual(" ".join(pieces), text)

    def test_long_sentence_without_commas_stays_whole(self) -> None:
        text = "a" * 300 + "."
        self.assertEqual(sk.split_sentences(text, limit=50), [text])

    def test_empty_text(self) -> None:
        self.assertEqual(sk.split_sentences("  \n "), [])


class AudioTest(unittest.TestCase):
    def test_join_inserts_gap_only_between_chunks(self) -> None:
        chunk = array.array("h", [1000] * 240)
        joined = sk.join_with_silence([chunk, chunk, chunk], gap_ms=10, rate=24_000)
        self.assertEqual(len(joined), 3 * 240 + 2 * 240)
        self.assertEqual(joined[240:480].tolist(), [0] * 240)
        self.assertEqual(joined[480], 1000)

    def test_float_to_pcm16_clips(self) -> None:
        self.assertEqual(sk.float_to_pcm16([0.0, 1.0, -1.0, 2.0, -2.0]).tolist(), [0, 32767, -32767, 32767, -32767])

    def test_to_wav_is_16bit_mono_24k(self) -> None:
        samples = array.array("h", [0, 1, -1, 32767])
        with wave.open(io.BytesIO(sk.to_wav(samples)), "rb") as wav:
            self.assertEqual(
                (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getnframes()), (1, 2, 24_000, 4)
            )
            self.assertEqual(array.array("h", wav.readframes(4)).tolist(), samples.tolist())


class EspeakTest(unittest.TestCase):
    def test_respects_existing_env_and_skips_non_linux(self) -> None:
        env = {"ESPEAK_DATA_PATH": "/custom", "PHONEMIZER_ESPEAK_LIBRARY": "/custom.so"}
        sk.configure_espeak(env, platform="linux")
        self.assertEqual(env, {"ESPEAK_DATA_PATH": "/custom", "PHONEMIZER_ESPEAK_LIBRARY": "/custom.so"})
        env = {}
        sk.configure_espeak(env, platform="win32")
        self.assertEqual(env, {})


class OfflineHubTest(unittest.TestCase):
    def test_offline_only_when_weights_are_cached(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env = {"HF_HUB_CACHE": tmp}
            sk.prefer_offline_hub(env)
            self.assertNotIn("HF_HUB_OFFLINE", env)  # first run must download
            Path(tmp, "models--hexgrad--Kokoro-82M", "snapshots").mkdir(parents=True)
            sk.prefer_offline_hub(env)
            self.assertEqual(env["HF_HUB_OFFLINE"], "1")
            env = {"HF_HUB_CACHE": tmp, "HF_HUB_OFFLINE": "0"}
            sk.prefer_offline_hub(env)
            self.assertEqual(env["HF_HUB_OFFLINE"], "0")  # caller's choice wins


if __name__ == "__main__":
    unittest.main()
