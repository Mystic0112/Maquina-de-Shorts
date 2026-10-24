"""Testes do slideshow de fotos (photo_edit.py) com um rascunho-mestre sintetico; nao precisam do CapCut nem de ffprobe."""
import copy
import unittest
from unittest import mock

import photo_edit as pe


def scaffold_content():
    video = {"id": "V1", "type": "video", "path": "C:/m/a.mp4", "material_name": "a.mp4", "width": 720, "height": 1280,
             "duration": 5_000_000, "local_material_id": "L0", "has_audio": True}
    seg = {"id": "S0", "material_id": "V1", "extra_material_refs": ["SP1", "CV1"],
           "source_timerange": {"start": 0, "duration": 5_000_000}, "target_timerange": {"start": 0, "duration": 5_000_000},
           "clip": {"scale": {"x": 1, "y": 1}}}
    return {"id": "C0", "duration": 5_000_000, "canvas_config": {"width": 720, "height": 1280},
            "keyframes": {"videos": [], "audios": []},
            "tracks": [{"id": "T0", "type": "video", "segments": [seg]}],
            "materials": {"videos": [video], "speeds": [{"id": "SP1", "speed": 1.0}], "canvases": [{"id": "CV1"}],
                          "sound_channel_mappings": [], "material_colors": [], "vocal_separations": [], "placeholder_infos": []}}


class HelperTests(unittest.TestCase):
    def test_cover_scale_cobre_o_quadro(self) -> None:
        self.assertAlmostEqual(pe.cover_scale(1080, 1920), 1.0)          # ja e 9:16
        self.assertGreater(pe.cover_scale(1920, 1080), 1.0)               # foto deitada precisa de mais escala
        self.assertGreaterEqual(pe.cover_scale(1000, 1000), 1.0)

    def test_ponto_de_keyframe(self) -> None:
        p = pe.kf_point(1_500_000, 1.23456789)
        self.assertEqual(p["time_offset"], 1_500_000)
        self.assertEqual(p["values"], [1.234568])
        self.assertTrue(p["id"])


class BuildTests(unittest.TestCase):
    def build(self, n=3, per_us=2_000_000, zoom=0.12):
        files = [f"C:/fotos/{i}.jpg" for i in range(n)]
        with mock.patch.object(pe, "load_json", return_value=copy.deepcopy(scaffold_content())), \
                mock.patch.object(pe, "probe_image", return_value=(1920, 1080)):
            return pe.build(files, "scaffold", "Meu Edit", per_us, zoom, "ffprobe")

    def test_uma_foto_por_segmento_em_sequencia(self) -> None:
        content, pack, segments = self.build(n=3, per_us=2_000_000)
        self.assertEqual(len(segments), 3)
        starts = [s["target_timerange"]["start"] for s in segments]
        self.assertEqual(starts, [0, 2_000_000, 4_000_000])
        self.assertEqual(content["duration"], 6_000_000)
        self.assertEqual(pack["total"], 6_000_000)
        photos = content["materials"]["videos"]
        self.assertEqual([p["type"] for p in photos], ["photo"] * 3)
        self.assertTrue(all(p["duration"] == pe.PHOTO_DURATION_US for p in photos))

    def test_zoom_alterna_entrando_e_saindo(self) -> None:
        _content, _pack, segments = self.build(n=2, zoom=0.2)
        cov = pe.cover_scale(1920, 1080)
        first = segments[0]["common_keyframes"][0]["keyframe_list"]
        second = segments[1]["common_keyframes"][0]["keyframe_list"]
        self.assertAlmostEqual(first[0]["values"][0], cov, places=5)
        self.assertAlmostEqual(first[1]["values"][0], cov * 1.2, places=5)
        self.assertAlmostEqual(second[0]["values"][0], cov * 1.2, places=5)
        self.assertAlmostEqual(second[1]["values"][0], cov, places=5)

    def test_referencias_resolvem_e_ids_sao_unicos(self) -> None:
        content, _pack, segments = self.build(n=3)
        self.assertEqual(pe.validate(content), [])
        ids = [it["id"] for arr in content["materials"].values() for it in arr]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(len({s["id"] for s in segments}), 3)

    def test_validate_acusa_referencia_solta(self) -> None:
        content, _pack, _segments = self.build(n=1)
        content["tracks"][0]["segments"][0]["material_id"] = "FANTASMA"
        content["tracks"][0]["segments"][0]["extra_material_refs"].append("SOLTO")
        problems = pe.validate(content)
        self.assertTrue(any("FANTASMA" in p for p in problems))
        self.assertTrue(any("SOLTO" in p for p in problems))


if __name__ == "__main__":
    unittest.main()
