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

The official multilingual (pt-BR) model needs a patch when it is loaded: see PTBR_TOKENIZER_BUFFER_FIXES and
apply_ptbr_patch below. It is isolated there on purpose, so the rest of the engine does not change when the
patch does.
"""

from __future__ import annotations

import argparse
import json
import logging
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
    return parser.parse_args(argv)


# --- pt-BR loading patch -------------------------------------------------------------------------
#
# A CONFERIR EM CASA. The official pt-BR checkpoint only works once two fixed buffers of the tokenizer are
# overwritten after loading. Fill in the real names and values (they live in the home session's test scripts,
# not in this repository). Until then the table is empty: the patch is a no-op and a loud warning is logged,
# so a garbled narration is never a silent surprise.
#     name of the buffer/attribute on the tokenizer -> its fixed value (a list of numbers for a tensor buffer)
PTBR_TOKENIZER_BUFFER_FIXES: Mapping[str, object] = {}


class PatchError(RuntimeError):
    """The model does not have the tokenizer (or the buffer) the patch expects."""


def find_tokenizer(model: object) -> object:
    """Where the patch looks for the tokenizer. A CONFERIR EM CASA: assumed to be `model.tokenizer`."""
    tokenizer = getattr(model, "tokenizer", None)
    if tokenizer is None:
        raise PatchError("model has no .tokenizer; update find_tokenizer() to where the loaded model keeps it")
    return tokenizer


def patch_tokenizer_buffers(tokenizer: object, fixes: Mapping[str, object]) -> list[str]:
    """Overwrite each named buffer (torch module) or attribute of `tokenizer` with its fixed value.

    A torch buffer keeps its dtype and device (`new_tensor`), anything else is assigned as is. Returns the names
    changed; raises PatchError when a name does not exist, because a patch that does not apply is a bug.
    """
    changed: list[str] = []
    for name, value in fixes.items():
        buffers = getattr(tokenizer, "_buffers", None)
        if isinstance(buffers, dict) and name in buffers:
            current = buffers[name]
            buffers[name] = current.new_tensor(value) if hasattr(current, "new_tensor") else value
        elif hasattr(tokenizer, name):
            setattr(tokenizer, name, value)
        else:
            raise PatchError(f"tokenizer has no buffer or attribute {name!r}")
        changed.append(name)
    return changed


def apply_ptbr_patch(model: object, fixes: Mapping[str, object] | None = None) -> list[str]:
    """The one place the pt-BR loading patch is applied (right after from_pretrained)."""
    fixes = PTBR_TOKENIZER_BUFFER_FIXES if fixes is None else fixes
    if not fixes:
        log.warning("pt-BR tokenizer patch is EMPTY (PTBR_TOKENIZER_BUFFER_FIXES): Portuguese output may be garbled")
        return []
    changed = patch_tokenizer_buffers(find_tokenizer(model), fixes)
    log.info("pt-BR tokenizer patch applied: %s", ", ".join(changed))
    return changed


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
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS  # A CONFERIR EM CASA: module/class of the pt-BR model

    device = pick_device(args.device, torch.cuda.is_available())
    log.info("loading Chatterbox on %s", device)
    model = ChatterboxMultilingualTTS.from_pretrained(device=device)
    apply_ptbr_patch(model)
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
    except (RuntimeError, OSError) as exc:  # PatchError is a RuntimeError
        log.error("%s", exc)
        return EXIT_FAILED
    sys.stdout.write(json.dumps(result, ensure_ascii=True) + "\n")
    sys.stdout.flush()
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
