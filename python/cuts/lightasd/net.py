"""Scoring wrapper with the attribute layout of upstream ASD.py (`model`, `lossAV`), so the released
state dict ("model.*", "lossAV.FC.*"; the training-only "lossV.*" is ignored) loads as is.

`LossAVHead` keeps only the FC layer of lossAV in
https://github.com/Junhua-Liao/Light-ASD/blob/ed38c232de5efe0261dbd68627c0ade7cdfe14eb/loss.py
(MIT, Copyright (c) 2023 Liao Junhua, see LICENSE); its score at inference is FC(x)[:, 1].
"""

from __future__ import annotations

from torch import nn

from .model.Model import ASD_Model


class LossAVHead(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.FC = nn.Linear(128, 2)


class LightASD(nn.Module):
    def __init__(self) -> None:
        super().__init__()
        self.model = ASD_Model()
        self.lossAV = LossAVHead()
