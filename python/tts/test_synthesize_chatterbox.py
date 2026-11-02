"""Unit checks for synthesize_chatterbox.py helpers (no chatterbox/torch needed).

Run: .venv/Scripts/python.exe -m unittest discover -s python/tts -p "test_*.py"
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import synthesize_chatterbox as sc
import synthesize_kokoro as sk


class FakeTensor:
    """Stands in for a torch buffer: new_tensor keeps what a real one keeps (dtype/device), here a tag."""

    def __init__(self, values: list[int], tag: str) -> None:
        self.values, self.tag = values, tag

    def new_tensor(self, values: list[int]) -> FakeTensor:
        return FakeTensor(list(values), self.tag)


class FakeTokenizer:
    """A torch-module-like tokenizer: `_buffers` holds the registered buffers, plain attributes the rest."""

    def __init__(self) -> None:
        self._buffers = {"pad_ids": FakeTensor([0, 0], "cuda:0")}
        self.sot = 255


class PatchTokenizerBuffersTest(unittest.TestCase):
    def test_overwrites_buffer_keeping_its_tag_and_plain_attribute(self) -> None:
        tok = FakeTokenizer()
        changed = sc.patch_tokenizer_buffers(tok, {"pad_ids": [7, 8, 9], "sot": 1})
        self.assertEqual(changed, ["pad_ids", "sot"])
        self.assertEqual((tok._buffers["pad_ids"].values, tok._buffers["pad_ids"].tag), ([7, 8, 9], "cuda:0"))
        self.assertEqual(tok.sot, 1)

    def test_unknown_name_is_an_error_not_a_silent_skip(self) -> None:
        with self.assertRaises(sc.PatchError):
            sc.patch_tokenizer_buffers(FakeTokenizer(), {"nope": 1})

    def test_apply_finds_tokenizer_on_model(self) -> None:
        class Model:
            tokenizer = FakeTokenizer()

        self.assertEqual(sc.apply_ptbr_patch(Model(), {"sot": 3}), ["sot"])
        self.assertEqual(Model.tokenizer.sot, 3)

    def test_apply_without_tokenizer_fails_loudly(self) -> None:
        with self.assertRaises(sc.PatchError):
            sc.apply_ptbr_patch(object(), {"sot": 3})

    def test_empty_table_is_a_noop_that_warns(self) -> None:
        with self.assertLogs("chatterbox", level="WARNING"):
            self.assertEqual(sc.apply_ptbr_patch(object(), {}), [])


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
