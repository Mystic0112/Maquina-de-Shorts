"""Does the fine-tuned Laya rank the target Shorts (viral, or fraco = flops) above the rest? Base vs fine-tuned.

Accuracy is useless here (most Shorts are not viral), so it reports:
- AUC: chance that a random viral Short scores above a random non-viral one (0.5 = coin flip);
- precision@10%: share of target Shorts among the 10% the model likes most, against the base rate;
- durationOnly (sets built with --hooks): AUC of "longer Short = target", so a model that only learned the
  duration does not pass for one that understood the hook.

Usage (home PC, .venv-cuts with laya + torch):
    python python/viral/eval_laya.py --eval data/datasets/viral/eval.fraco.jsonl --model models/laya-fraco
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Sequence
from pathlib import Path


def auc(scores: Sequence[float], labels: Sequence[bool]) -> float:
    """Mann-Whitney AUC with average ranks for ties."""
    order = sorted(range(len(scores)), key=lambda i: scores[i])
    ranks = [0.0] * len(scores)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and scores[order[j + 1]] == scores[order[i]]:
            j += 1
        for k in range(i, j + 1):
            ranks[order[k]] = (i + j) / 2 + 1
        i = j + 1
    pos = [r for r, y in zip(ranks, labels) if y]
    n_pos, n_neg = len(pos), len(labels) - len(pos)
    if n_pos == 0 or n_neg == 0:
        return float("nan")
    return (sum(pos) - n_pos * (n_pos + 1) / 2) / (n_pos * n_neg)


def precision_at(scores: Sequence[float], labels: Sequence[bool], share: float = 0.10) -> float:
    k = max(1, round(len(scores) * share))
    top = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)[:k]
    return sum(1 for i in top if labels[i]) / k


DURATION = re.compile(r"Duração: (\d+) s")


def target_of(rows: list[dict]) -> str:
    """The one question key of the set ("viral" or "fraco")."""
    return next(iter(rows[0]["questions"]))


def durations(rows: list[dict]) -> list[float] | None:
    found = [DURATION.search(r["state"]) for r in rows]
    return [float(m.group(1)) if m else 0.0 for m in found] if any(found) else None


def score(model: str, rows: list[dict]) -> list[float]:
    import laya

    key = target_of(rows)
    agent = laya.load(model)
    results = agent.predict_batch([r["state"] for r in rows], rows[0]["questions"])
    return [float(r["answers"][key]["noul"]) for r in results]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--eval", type=Path, required=True)
    parser.add_argument("--model", required=True, help="fine-tuned checkpoint dir")
    parser.add_argument("--base", default="multilingual")
    args = parser.parse_args(argv)
    rows = [json.loads(line) for line in args.eval.read_text(encoding="utf-8").splitlines() if line.strip()]
    key = target_of(rows)
    labels = [bool((r.get("expected") or r.get("gold"))[key]) for r in rows]  # older sets used "gold"
    base_rate = sum(labels) / len(labels)
    report: dict = {"items": len(rows), "target": key, "positives": sum(labels), "baseRate": round(base_rate, 3)}
    d = durations(rows)
    if d is not None:
        report["durationOnly"] = {"auc": round(auc(d, labels), 3)}
    for name, model in (("base", args.base), ("finetuned", args.model)):
        s = score(model, rows)
        report[name] = {"auc": round(auc(s, labels), 3), "precisionAt10": round(precision_at(s, labels), 3)}
    sys.stdout.write(json.dumps(report) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
