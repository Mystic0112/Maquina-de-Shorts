"""Ranks every candidate cut window of a transcript with Laya (zero-shot decision model, Apache-2.0).

One window per segment start: the run of whole segments whose length is closest to the middle of
[min, max] seconds. Laya answers yes/no questions about each window in batched forward passes; the window
score is the product of the "yes" probabilities. The agy then only needs to choose among the best windows.

Reads nothing from the network except the Laya weights on the first run (Hugging Face cache).
stdout: {"model", "device", "loadSeconds", "scoreSeconds", "windows": [{start, end, score, answers}]} sorted
by score, best first. Logs go to stderr.

Usage: python laya_rank.py --transcript transcript.json [--min 30] [--max 60] [--device cuda]
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from collections.abc import Sequence
from pathlib import Path

log = logging.getLogger("laya_rank")

MODEL = "multilingual"  # mmBERT-base, 322M parameters, covers pt-BR

QUESTIONS = {
    "sozinho": {
        "type": "noul",
        "instructions": "Este trecho de podcast faz sentido sozinho, para quem nunca viu o episódio?",
    },
    "forte": {
        "type": "noul",
        "instructions": "Este trecho tem um momento forte: revelação, polêmica, história curiosa, humor ou número surpreendente?",
    },
}


def build_windows(
    segments: Sequence[dict], min_seconds: float, max_seconds: float
) -> list[dict]:
    """One window per segment start; whole segments only, length in [min, max], closest to the middle."""
    target = (min_seconds + max_seconds) / 2
    windows: list[dict] = []
    for i, first in enumerate(segments):
        best: tuple[float, int] | None = None
        for j in range(i, len(segments)):
            length = segments[j]["end"] - first["start"]
            if length > max_seconds:
                break
            if length >= min_seconds and (best is None or abs(length - target) < best[0]):
                best = (abs(length - target), j)
        if best is None:
            continue
        last = segments[best[1]]
        text = " ".join(s["text"].strip() for s in segments[i : best[1] + 1])
        windows.append({"start": first["start"], "end": last["end"], "text": text})
    return windows


def window_score(answers: dict) -> float:
    """Product of P(yes) over every question: a window must work alone AND have a strong moment."""
    score = 1.0
    for answer in answers.values():
        score *= float(answer["noul"])
    return round(score, 4)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="rank cut windows with Laya")
    parser.add_argument("--transcript", type=Path, required=True)
    parser.add_argument("--min", type=float, default=30.0)
    parser.add_argument("--max", type=float, default=60.0)
    parser.add_argument("--device", default=None, help="cuda | cpu (default: cuda when available)")
    parser.add_argument("--batch-size", type=int, default=32)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="[laya] %(levelname)s %(message)s")
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    args = parse_args(argv)
    transcript = json.loads(args.transcript.read_text(encoding="utf-8"))
    windows = build_windows(transcript["segments"], args.min, args.max)
    if not windows:
        log.error("no window of %.0f-%.0f s in %s", args.min, args.max, args.transcript)
        return 1
    try:
        import laya
        import torch
    except ImportError as exc:
        log.error("laya/torch missing in this interpreter: %s", exc)
        return 1
    device = args.device or ("cuda" if torch.cuda.is_available() else "cpu")
    started = time.perf_counter()
    agent = laya.load(MODEL, device=device)
    load_seconds = time.perf_counter() - started
    started = time.perf_counter()
    results = agent.predict_batch(
        [w["text"] for w in windows], QUESTIONS, batch_size=args.batch_size
    )
    score_seconds = time.perf_counter() - started
    log.info(
        "%d windows scored in %.1f s on %s (model load %.1f s)",
        len(windows), score_seconds, device, load_seconds,
    )
    ranked = []
    for window, result in zip(windows, results):
        answers = {qid: round(float(a["noul"]), 4) for qid, a in result["answers"].items()}
        ranked.append(
            {
                "start": window["start"],
                "end": window["end"],
                "score": window_score(result["answers"]),
                "answers": answers,
            }
        )
    ranked.sort(key=lambda w: w["score"], reverse=True)
    sys.stdout.write(
        json.dumps(
            {
                "model": MODEL,
                "device": device,
                "loadSeconds": round(load_seconds, 1),
                "scoreSeconds": round(score_seconds, 1),
                "windows": ranked,
            },
            ensure_ascii=False,
        )
        + "\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
