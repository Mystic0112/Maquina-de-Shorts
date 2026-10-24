"""Testes do encaixe de cortes nos graves (retime_bass.py) com audio sintetico; nao precisam de ffmpeg."""
import json
import math
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np

import retime_bass as rb


def kick_track(times, sr=22050, seconds=12.0):
    """Faixa sintetica: um golpe de grave (60 Hz com decaimento) em cada instante de `times`."""
    x = np.zeros(int(sr * seconds))
    t = np.arange(int(sr * 0.2)) / sr
    burst = np.sin(2 * np.pi * 60 * t) * np.exp(-t * 18)
    for at in times:
        i = int(at * sr)
        x[i:i + len(burst)] += burst[: len(x) - i]
    return x, sr


class AnalyzeTests(unittest.TestCase):
    def test_acha_os_golpes_de_grave_e_o_periodo(self) -> None:
        times = [1.0 + 0.5 * k for k in range(16)]            # 120 bpm
        samples, sr = kick_track(times)
        analysis = rb.analyze_bass(samples, sr)
        for t in times:
            self.assertLess(np.min(np.abs(analysis.hits - t)), 0.04, t)
        self.assertAlmostEqual(analysis.period, 0.5, delta=0.03)

    def test_agudo_nao_conta_como_grave(self) -> None:
        sr = 22050
        t = np.arange(sr * 4) / sr
        hiss = np.sin(2 * np.pi * 2000 * t) * (np.sin(2 * np.pi * 2 * t) > 0.9)
        self.assertEqual(len(rb.analyze_bass(hiss, sr).hits), 0)


class PlanTests(unittest.TestCase):
    hits = np.array([1.00, 1.75, 2.50, 3.25])
    strengths = np.array([8.0, 8.0, 8.0, 8.0])

    def test_corte_perto_de_um_grave_vai_para_ele(self) -> None:
        targets, _ = rb.plan_cuts([1.08, 1.70, 2.58], self.hits, self.strengths, 0.0, 0.75)
        self.assertEqual([round(t, 2) for t in targets], [1.00, 1.75, 2.50])

    def test_cortes_continuam_em_ordem_e_velocidade_razoavel(self) -> None:
        cuts = [0.9, 1.6, 2.4, 3.3]
        targets, _ = rb.plan_cuts(cuts, self.hits, self.strengths, 0.0, 0.75)
        self.assertTrue(all(b > a for a, b in zip(targets, targets[1:])))
        bounds_in, bounds_out = [0.0, *cuts], [0.0, *targets]
        for i in range(len(cuts)):
            speed = (bounds_in[i + 1] - bounds_in[i]) / (bounds_out[i + 1] - bounds_out[i])
            self.assertGreaterEqual(speed, rb.SPEED_MIN)
            self.assertLessEqual(speed, rb.SPEED_MAX)

    def test_sem_plano_valido_devolve_none(self) -> None:
        # dois cortes colados no mesmo grave: o segundo nao tem para onde ir sem trecho de ~0 s
        targets, cost = rb.plan_cuts([1.00, 1.05], np.array([1.0]), np.array([8.0]), 0.0, 5.0, max_shift=0.02)
        self.assertIsNone(targets)
        self.assertEqual(cost, math.inf)

    def test_melhor_ponto_da_musica_alinha_os_graves_com_os_cortes(self) -> None:
        hits = np.array([3.0 + 0.6 * k for k in range(0, 14, 2)])      # graves de 1,2 em 1,2 s a partir de 3,0
        analysis = rb.BassAnalysis(hits, np.full(len(hits), 8.0), 0.6, 0.0)
        cuts = [1.2, 2.4, 3.6]                                          # cortes a cada 1,2 s
        start, targets, _ = rb.best_start(cuts, analysis, 1.0, 3.0, step=0.05)
        # cada corte tem de cair num grave: grave - start == corte
        for t in targets:
            self.assertLess(np.min(np.abs(hits - start - t)), 0.03)


class FiltergraphTests(unittest.TestCase):
    def test_um_trecho_por_corte_mais_o_final(self) -> None:
        graph, speeds, duration = rb.build_filtergraph([1.0, 2.0], [1.1, 2.0], 3.0)
        self.assertEqual(len(speeds), 3)
        self.assertIn("concat=n=3:v=1:a=0[v]", graph)
        self.assertAlmostEqual(speeds[0], 1.0 / 1.1, places=5)
        self.assertAlmostEqual(speeds[2], 1.0, places=5)               # o final mantem a velocidade
        self.assertAlmostEqual(duration, 2.0 + 1.0, places=5)
        self.assertNotIn("fps=", graph)                                # fps vai por -r (ffmpeg reduzido nao tem o filtro)


class ResolveMusicTests(unittest.TestCase):
    def test_arquivo_id_e_nome_da_lista(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "data" / "music").mkdir(parents=True)
            song = root / "data" / "music" / "faixa-abc123.mp3"
            song.write_bytes(b"ID3")
            (root / "data" / "music" / "library.json").write_text(
                json.dumps([{"id": "faixa-abc123", "name": "Minha Faixa", "file": "faixa-abc123.mp3"}]), encoding="utf-8")
            with mock.patch.object(rb, "REPO_ROOT", root):
                self.assertEqual(rb.resolve_music(str(song)), str(song))
                self.assertEqual(rb.resolve_music("faixa-abc123"), str(song))
                self.assertEqual(rb.resolve_music("minha faixa"), str(song))
                with self.assertRaises(SystemExit):
                    rb.resolve_music("nao-existe")


if __name__ == "__main__":
    unittest.main()
