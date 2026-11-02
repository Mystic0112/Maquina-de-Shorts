"""Unit checks for synthesize_chatterbox.py helpers (no chatterbox/torch needed).

Run: .venv/Scripts/python.exe -m unittest discover -s python/tts -p "test_*.py"
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import synthesize_chatterbox as sc
import synthesize_kokoro as sk


class PatchS3genTest(unittest.TestCase):
    def test_copies_only_the_two_missing_buffers(self) -> None:
        ptbr = {"flow.weight": 1, "tokenizer.window": "keep-mine"}
        main = {"tokenizer._mel_filters": "mel", "tokenizer.window": "main-window", "flow.weight": 2}
        self.assertEqual(sc.patch_s3gen_state(ptbr, main), ["tokenizer._mel_filters"])
        self.assertEqual(ptbr, {"flow.weight": 1, "tokenizer.window": "keep-mine", "tokenizer._mel_filters": "mel"})

    def test_a_main_checkpoint_without_the_buffers_is_an_error_not_a_half_patch(self) -> None:
        with self.assertRaises(sc.PatchError):
            sc.patch_s3gen_state({}, {"tokenizer.window": "w"})

    def test_complete_state_changes_nothing(self) -> None:
        full = {"tokenizer._mel_filters": 1, "tokenizer.window": 2}
        self.assertEqual(sc.patch_s3gen_state(full, {}), [])


class ModeTest(unittest.TestCase):
    def test_defaults_and_unknown_mode(self) -> None:
        args = sc.parse_args(["--text-file", "t.txt", "--out", "o.wav"])
        self.assertEqual((args.mode, args.ckpt_dir), (sc.MODE_V3, None))
        with tempfile.TemporaryDirectory() as tmp:
            text = Path(tmp, "t.txt")
            text.write_text("Olá.", encoding="utf-8")
            with self.assertRaises(sk.InputError):
                sc.run(sc.parse_args(["--text-file", str(text), "--out", str(Path(tmp, "o.wav")), "--mode=v2"]))

    def test_default_checkpoint_folder_is_inside_models(self) -> None:
        self.assertEqual(sc.default_ckpt_dir().parts[-2:], ("models", "chatterbox-ptbr"))


class ArgsAndDeviceTest(unittest.TestCase):
    def test_reference_audio_must_exist_and_be_audio(self) -> None:
        self.assertIsNone(sc.validate_ref_audio(None))
        with tempfile.TemporaryDirectory() as tmp:
            good, bad = Path(tmp, "voz.wav"), Path(tmp, "voz.txt")
            good.write_bytes(b"x")
            bad.write_bytes(b"x")
            self.assertEqual(sc.validate_ref_audio(good), good.resolve())
            with self.assertRaises(sk.InputError):
                sc.validate_ref_audio(bad)
            with self.assertRaises(sk.InputError):
                sc.validate_ref_audio(Path(tmp, "missing.wav"))

    def test_pick_device(self) -> None:
        self.assertEqual(sc.pick_device("auto", True), "cuda")
        self.assertEqual(sc.pick_device("auto", False), "cpu")
        self.assertEqual(sc.pick_device("cpu", True), "cpu")
        with self.assertRaises(sk.InputError):
            sc.pick_device("cuda", False)
        with self.assertRaises(sk.InputError):
            sc.pick_device("tpu", True)

    def test_run_rejects_out_of_range_settings_before_loading_anything(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            text = Path(tmp, "t.txt")
            text.write_text("Olá.", encoding="utf-8")
            base = ["--text-file", str(text), "--out", str(Path(tmp, "o.wav"))]
            with self.assertRaises(sk.InputError):
                sc.run(sc.parse_args([*base, "--exaggeration=3"]))
            with self.assertRaises(sk.InputError):
                sc.run(sc.parse_args([*base, "--cfg-weight=-1"]))


if __name__ == "__main__":
    unittest.main()
