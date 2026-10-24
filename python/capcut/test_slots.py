"""Testes da troca de varias midias (slots.py) com um rascunho sintetico; nao precisam do CapCut."""
import copy
import unittest

import slots


def draft():
    """Mestre de 3 espacos: foto, foto, video (ordem na timeline diferente da ordem no array)."""
    videos = [
        {"id": "M1", "type": "photo", "path": "C:/m/a.jpg", "material_name": "a.jpg", "width": 1000, "height": 1500,
         "duration": slots.PHOTO_DURATION_US, "local_material_id": "L1"},
        {"id": "M2", "type": "photo", "path": "C:/m/b.jpg", "material_name": "b.jpg", "width": 1000, "height": 1500,
         "duration": slots.PHOTO_DURATION_US, "local_material_id": "L2"},
        {"id": "M3", "type": "video", "path": "C:/m/c.mp4", "material_name": "c.mp4", "width": 1920, "height": 1080,
         "duration": 5_000_000, "local_material_id": "L3"},
    ]

    def seg(mid, start, dur):
        return {"material_id": mid, "extra_material_refs": ["E1"],
                "source_timerange": {"start": 0, "duration": dur}, "target_timerange": {"start": start, "duration": dur}}

    content = {"duration": 4_000_000, "materials": {"videos": videos},
               "tracks": [{"type": "video", "segments": [seg("M3", 2_500_000, 1_500_000), seg("M1", 0, 1_000_000),
                                                         seg("M2", 1_000_000, 1_500_000)]},
                          {"type": "audio", "segments": []}]}
    meta = {"draft_materials": [{"type": 0, "value": [
        {"id": "L1", "file_Path": "C:/m/a.jpg", "extra_info": "a.jpg"},
        {"id": "L2", "file_Path": "C:/m/b.jpg", "extra_info": "b.jpg"},
        {"id": "L3", "file_Path": "C:/m/c.mp4", "extra_info": "c.mp4"}]}]}
    return content, meta


def photo(name, w=1080, h=1920):
    return slots.Media(f"D:/novas/{name}", name, "photo", w, h)


def clip(name, seconds, w=1080, h=1920):
    return slots.Media(f"D:/novas/{name}", name, "video", w, h, int(seconds * 1_000_000))


class SwapSlotsTests(unittest.TestCase):
    def test_midias_entram_na_ordem_da_timeline_nao_na_do_array(self) -> None:
        content, meta = draft()
        report = slots.swap_slots(content, meta, [photo("1.jpg"), photo("2.jpg"), clip("3.mp4", 6)])
        by_id = {v["id"]: v for v in content["materials"]["videos"]}
        self.assertEqual(by_id["M1"]["material_name"], "1.jpg")  # comeca em 0 s
        self.assertEqual(by_id["M2"]["material_name"], "2.jpg")
        self.assertEqual(by_id["M3"]["material_name"], "3.mp4")  # e o ultimo da timeline
        self.assertEqual(report.slots, 3)
        self.assertEqual([i for i, _ in report.swapped], [0, 1, 2])

    def test_ids_efeitos_e_tempos_dos_espacos_nao_mudam(self) -> None:
        content, meta = draft()
        before = copy.deepcopy(content)
        slots.swap_slots(content, meta, [photo("1.jpg"), photo("2.jpg"), clip("3.mp4", 6)])
        for old, new in zip(before["tracks"][0]["segments"], content["tracks"][0]["segments"]):
            self.assertEqual(old["material_id"], new["material_id"])
            self.assertEqual(old["extra_material_refs"], new["extra_material_refs"])
            self.assertEqual(old["target_timerange"], new["target_timerange"])
        self.assertEqual(content["duration"], before["duration"])

    def test_foto_vira_foto_e_video_corta_no_tamanho_do_espaco(self) -> None:
        content, meta = draft()
        slots.swap_slots(content, meta, [photo("1.jpg"), clip("2.mp4", 9), clip("3.mp4", 0.5)])
        by_id = {v["id"]: v for v in content["materials"]["videos"]}
        self.assertEqual(by_id["M2"]["type"], "video")
        self.assertEqual(by_id["M2"]["duration"], 9_000_000)
        seg_m2 = next(s for s in content["tracks"][0]["segments"] if s["material_id"] == "M2")
        self.assertEqual(seg_m2["source_timerange"], {"start": 0, "duration": 1_500_000})  # corta no espaco
        self.assertEqual(by_id["M1"]["duration"], slots.PHOTO_DURATION_US)

    def test_video_mais_curto_que_o_espaco_gera_aviso(self) -> None:
        content, meta = draft()
        report = slots.swap_slots(content, meta, [photo("1.jpg"), photo("2.jpg"), clip("3.mp4", 0.5)])
        self.assertTrue(any("3.mp4" in w for w in report.warnings))

    def test_faltando_midia_recusa_a_menos_que_cycle(self) -> None:
        content, meta = draft()
        with self.assertRaises(ValueError):
            slots.swap_slots(content, meta, [photo("1.jpg"), photo("2.jpg")])
        report = slots.swap_slots(content, meta, [photo("1.jpg"), photo("2.jpg")], cycle=True)
        self.assertEqual([n for _, n in report.swapped], ["1.jpg", "2.jpg", "1.jpg"])

    def test_sobrando_midia_avisa(self) -> None:
        content, meta = draft()
        report = slots.swap_slots(content, meta, [photo(f"{n}.jpg") for n in range(5)])
        self.assertEqual(len(report.swapped), 3)
        self.assertTrue(any("2 midia(s) a mais" in w for w in report.warnings))

    def test_meta_draft_materials_acompanha(self) -> None:
        content, meta = draft()
        slots.swap_slots(content, meta, [photo("1.jpg"), photo("2.jpg"), clip("3.mp4", 6)])
        paths = {i["id"]: i["file_Path"] for i in meta["draft_materials"][0]["value"]}
        self.assertEqual(paths["L1"], "D:/novas/1.jpg")
        self.assertEqual(paths["L3"], "D:/novas/3.mp4")

    def test_trilha_inexistente_ou_vazia(self) -> None:
        content, meta = draft()
        with self.assertRaises(ValueError):
            slots.swap_slots(content, meta, [photo("1.jpg")], track_index=3)
        content["tracks"][0]["segments"] = []
        with self.assertRaises(ValueError):
            slots.swap_slots(content, meta, [photo("1.jpg")])

    def test_material_inexistente_no_espaco(self) -> None:
        content, meta = draft()
        content["tracks"][0]["segments"][0]["material_id"] = "XX"
        with self.assertRaises(ValueError):
            slots.swap_slots(content, meta, [photo("1.jpg"), photo("2.jpg"), photo("3.jpg")])

    def test_tipo_e_nome_da_pasta(self) -> None:
        self.assertEqual(slots.media_kind("x/A.JPG"), "photo")
        self.assertEqual(slots.media_kind("x/a.mp4"), "video")
        self.assertEqual(slots.safe_folder_name('Edit: carro <1>?'), "Edit_ carro _1__")


if __name__ == "__main__":
    unittest.main()
