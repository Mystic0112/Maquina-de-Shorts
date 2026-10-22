"""Pure metrics of eval_laya.py (no laya/torch needed)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import eval_laya


class MetricsTests(unittest.TestCase):
    def test_auc(self) -> None:
        self.assertEqual(eval_laya.auc([0.9, 0.8, 0.2, 0.1], [True, True, False, False]), 1.0)
        self.assertEqual(eval_laya.auc([0.1, 0.2, 0.8, 0.9], [True, True, False, False]), 0.0)
        self.assertEqual(eval_laya.auc([0.5, 0.5, 0.5, 0.5], [True, False, True, False]), 0.5)

    def test_precision_at_top_share(self) -> None:
        scores = [i / 100 for i in range(100)]
        labels = [i >= 95 for i in range(100)]  # the 5 best are viral
        self.assertEqual(eval_laya.precision_at(scores, labels, 0.10), 0.5)


if __name__ == "__main__":
    unittest.main()
