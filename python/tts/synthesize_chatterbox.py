"""Synthesize pt-BR narration with Chatterbox (local, MIT) into a 16-bit mono WAV.

Usage:
    <chatterbox-venv>/python python/tts/synthesize_chatterbox.py --text-file <path> --out <narration.source.wav>
        [--ref-audio <10-15 s recording>] [--exaggeration 0.5] [--cfg-weight 0.5] [--device auto]

Same contract as synthesize_kokoro.py: the text is split sentence by sentence, the pieces are joined with a
short silence, and one JSON object goes to stdout:
    {"audioPath": str, "durationMs": int, "sentences": int, "engine": "chatterbox"}
Word timings come later from align_narration.py. Logging goes to stderr. Exit codes: 0 ok, 1 synthesis
failed, 2 invalid arguments/input.

VOICE CONSENT: --ref-audio makes the model speak with the voice of that recording. Only use a recording of a
voice you own or have explicit consent to clone (your own, or someone who agreed in writing). Chatterbox embeds
an inaudible Perth watermark in every output; do not try to remove it.

Runs inside its own venv (torch is heavy and its pins clash with Kokoro's); see README "Voz: Chatterbox" and
CHATTERBOX_PYTHON in .env.

Two ways to load the multilingual model (--mode), both measured at home on 2026-11-02 (same 590-character text,
mispronounced words found by transcribing the audio with Whisper):
  v3     ChatterboxMultilingualTTS.from_pretrained(t3_model="v3"): 7.5-9.4% errors. Needs the GitHub build of
         chatterbox-tts (the PyPI 0.1.7 has no t3_model and loads the much worse v2: 9-19%).
  pt-br  the pt-BR checkpoint built by build_ptbr_checkpoint(): 6.6% errors (as good as Kokoro) with a reference
         voice. Its s3gen_v3.pt lacks two fixed buffers of the speech decoder (`tokenizer._mel_filters` 128x201 and
         `tokenizer.window` 400, both float32), which are copied from the main repo's s3gen.pt before loading.
"""

from __future__ import annotations

import argparse
import json
import logging
import shutil
import sys
from collections.abc import Mapping
from pathlib import Path

# Same folder: the helpers are shared with the Kokoro engine (stdlib only, no torch at import time).
from synthesize_kokoro import (
    InputError,
    float_to_pcm16,
    join_with_silence,
    split_sentences,
    to_wav,
)

LANGUAGE_ID = "pt"  # Chatterbox multilingual id for Portuguese
REF_AUDIO_SUFFIXES = (".wav", ".mp3", ".flac")
EXIT_OK, EXIT_FAILED, EXIT_BAD_INPUT = 0, 1, 2

log = logging.getLogger("chatterbox")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Chatterbox TTS (pt-BR) -> 16-bit mono WAV")
    parser.add_argument("--text-file", type=Path, required=True, help="UTF-8 text to speak")
    parser.add_argument("--out", type=Path, required=True, help="output WAV path")
    parser.add_argument("--ref-audio", type=Path, default=None, help="10-15 s recording of a voice you may clone")
    parser.add_argument("--exaggeration", type=float, default=0.5, help="emotion/intensity, 0.25-2 (0.5 neutral)")
    parser.add_argument("--cfg-weight", type=float, default=0.5, help="pacing/guidance, 0-1")
    parser.add_argument("--device", default="auto", help="auto | cuda | cpu")
    parser.add_argument("--mode", default=MODE_V3, help="v3 (from_pretrained) | pt-br (pt-BR checkpoint with the decoder patch)")
    parser.add_argument("--ckpt-dir", type=Path, default=None, help="where the pt-br checkpoint is built/kept (default models/chatterbox-ptbr)")
    return parser.parse_args(argv)


# --- pt-BR checkpoint (mode "pt-br") --------------------------------------------------------------

MODE_V3, MODE_PTBR = "v3", "pt-br"
MAIN_REPO = "ResembleAI/chatterbox"
PTBR_REPO = "ResembleAI/Chatterbox-Multilingual-pt-br"
# From the main repo: the voice encoder, the voice conditionals and the s3gen the two buffers are copied from.
MAIN_FILES = ("ve.pt", "conds.pt", "s3gen.pt")
# From the pt-BR repo: the grapheme tokenizer, the pt-BR T3 weights and its s3gen_v3.pt (saved as s3gen.pt).
PTBR_FILES = ("grapheme_mtl_merged_expanded_v1.json", "t3_pt_br.safetensors")
PTBR_S3GEN = "s3gen_v3.pt"
T3_PTBR = "t3_pt_br.safetensors"
# state_dict keys the pt-BR s3gen_v3.pt lacks (both float32: _mel_filters 128x201, window 400).
MISSING_S3GEN_BUFFERS = ("tokenizer._mel_filters", "tokenizer.window")


class PatchError(RuntimeError):
    """The checkpoint does not have what the pt-BR recipe expects."""


def patch_s3gen_state(ptbr_state: dict, main_state: Mapping[str, object]) -> list[str]:
    """Copy the two buffers the pt-BR s3gen lacks from the main repo's s3gen state. Returns the keys copied.

    Keys already present are left alone, and a key the main repo does not have is an error: a half-patched decoder
    would speak garbled Portuguese without saying why.
    """
    copied: list[str] = []
    for key in MISSING_S3GEN_BUFFERS:
        if key in ptbr_state:
            continue
        if key not in main_state:
            raise PatchError(f"the main repo's s3gen.pt has no {key!r}; cannot patch the pt-BR decoder")
        ptbr_state[key] = main_state[key]
        copied.append(key)
    return copied


def default_ckpt_dir() -> Path:
    return Path(__file__).resolve().parents[2] / "models" / "chatterbox-ptbr"


def build_ptbr_checkpoint(ckpt_dir: Path) -> Path:
    """Folder ChatterboxMultilingualTTS.from_local can load; built once (downloads ~8 GB from Hugging Face), then reused."""
    if all((ckpt_dir / name).is_file() for name in ("ve.pt", "conds.pt", "s3gen.pt", T3_PTBR)):
        return ckpt_dir
    import torch
    from huggingface_hub import hf_hub_download

    ckpt_dir.mkdir(parents=True, exist_ok=True)
    log.info("building the pt-BR checkpoint in %s (first run downloads the weights)", ckpt_dir)
    for name in MAIN_FILES[:2]:
        shutil.copyfile(hf_hub_download(MAIN_REPO, name), ckpt_dir / name)
    for name in PTBR_FILES:
        shutil.copyfile(hf_hub_download(PTBR_REPO, name), ckpt_dir / name)
    ptbr_state = torch.load(hf_hub_download(PTBR_REPO, PTBR_S3GEN), map_location="cpu")
    main_state = torch.load(hf_hub_download(MAIN_REPO, "s3gen.pt"), map_location="cpu")
    copied = patch_s3gen_state(ptbr_state, main_state)
    log.info("pt-BR decoder patch applied: copied %s from the main repo's s3gen.pt", ", ".join(copied) or "nothing (already there)")
    torch.save(ptbr_state, ckpt_dir / "s3gen.pt")
    return ckpt_dir


def load_model(mode: str, device: str, ckpt_dir: Path | None) -> object:
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS

    if mode == MODE_PTBR:
        folder = build_ptbr_checkpoint(ckpt_dir or default_ckpt_dir())
        return ChatterboxMultilingualTTS.from_local(folder, device, t3_model=T3_PTBR)
    try:
        return ChatterboxMultilingualTTS.from_pretrained(device=device, t3_model="v3")
    except TypeError as exc:
        # The PyPI build (0.1.7) has no t3_model and would silently be the v2, the worst of the tested models.
        raise RuntimeError(
            "this chatterbox-tts has no t3_model (PyPI 0.1.7?): install the GitHub build pinned in the README, "
            "section Voz: Chatterbox, or the v2 would be used"
        ) from exc


# --- main ----------------------------------------------------------------------------------------


def validate_ref_audio(path: Path | None) -> Path | None:
    if path is None:
        return None
    ref = path.expanduser().resolve()
    if not ref.is_file():
        raise InputError(f"missing reference audio: {ref}")
    if ref.suffix.lower() not in REF_AUDIO_SUFFIXES:
        raise InputError(f"reference audio must be one of {', '.join(REF_AUDIO_SUFFIXES)}, got {ref.suffix or 'no extension'}")
    return ref


def pick_device(requested: str, cuda_available: bool) -> str:
    if requested not in ("auto", "cuda", "cpu"):
        raise InputError(f"--device must be auto, cuda or cpu, got {requested}")
    if requested == "cuda" and not cuda_available:
        raise InputError("--device cuda, but CUDA is not available in this venv")
    return requested if requested != "auto" else ("cuda" if cuda_available else "cpu")


def synthesize(sentences: list[str], args: argparse.Namespace, ref: Path | None) -> tuple[list, int]:
    import torch  # heavy imports only here so the helpers stay testable

    device = pick_device(args.device, torch.cuda.is_available())
    log.info("loading Chatterbox (%s) on %s", args.mode, device)
    model = load_model(args.mode, device, args.ckpt_dir)
    options: dict[str, object] = {
        "language_id": LANGUAGE_ID,
        "exaggeration": args.exaggeration,
        "cfg_weight": args.cfg_weight,
    }
    if ref is not None:
        options["audio_prompt_path"] = str(ref)
    chunks = []
    for index, sentence in enumerate(sentences, 1):
        wav = model.generate(sentence, **options)
        samples = float_to_pcm16(wav.squeeze().detach().cpu().tolist())
        if not len(samples):
            log.warning("sentence %d produced no audio: %r", index, sentence[:60])
            continue
        chunks.append(samples)
        log.info("sentence %d/%d: %d ms", index, len(sentences), len(samples) * 1000 // model.sr)
    return chunks, int(model.sr)


def run(args: argparse.Namespace) -> dict[str, object]:
    if not args.text_file.is_file():
        raise InputError(f"missing text file: {args.text_file}")
    if not 0.25 <= args.exaggeration <= 2.0:
        raise InputError(f"--exaggeration must be between 0.25 and 2, got {args.exaggeration}")
    if not 0.0 <= args.cfg_weight <= 1.0:
        raise InputError(f"--cfg-weight must be between 0 and 1, got {args.cfg_weight}")
    if args.mode not in (MODE_V3, MODE_PTBR):
        raise InputError(f"--mode must be {MODE_V3} or {MODE_PTBR}, got {args.mode}")
    ref = validate_ref_audio(args.ref_audio)
    sentences = split_sentences(args.text_file.read_text(encoding="utf-8-sig"))
    if not sentences:
        raise InputError(f"text file has no words: {args.text_file}")
    chunks, rate = synthesize(sentences, args, ref)
    if not chunks:
        raise RuntimeError("Chatterbox produced no audio")
    samples = join_with_silence(chunks, rate=rate)
    out: Path = args.out.expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(to_wav(samples, rate=rate))
    return {
        "audioPath": str(out),
        "durationMs": round(len(samples) * 1000 / rate),
        "sentences": len(sentences),
        "engine": "chatterbox",
    }


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="[chatterbox] %(levelname)s %(message)s")
    args = parse_args(argv)
    try:
        result = run(args)
    except InputError as exc:
        log.error("%s", exc)
        return EXIT_BAD_INPUT
    except ImportError as exc:
        log.error(
            "chatterbox is missing in this interpreter (%s); see README 'Voz: Chatterbox' and CHATTERBOX_PYTHON: %s",
            sys.executable,
            exc,
        )
        return EXIT_FAILED
    except (RuntimeError, OSError) as exc:  # PatchError and the missing-t3_model error are RuntimeErrors
        log.error("%s", exc)
        return EXIT_FAILED
    sys.stdout.write(json.dumps(result, ensure_ascii=True) + "\n")
    sys.stdout.flush()
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
