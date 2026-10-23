"""Unit tests for the pure cuts logic (captions, speaker choice, camera, jump cuts, loudness, ASD helpers).

No OpenCV; the Light-ASD model test runs only where torch is installed.
"""

from __future__ import annotations

import importlib.util
import math
import sys
import tempfile
import unittest
from itertools import pairwise
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import asd_math
import camera
import captions
import laya_rank
import render_clip
import speaker
import transcribe
import watermark


def words(*spec: tuple[str, float, float]) -> list[dict[str, object]]:
    return [{"word": w, "start": s, "end": e} for w, s, e in spec]


class CaptionTests(unittest.TestCase):
    def test_groups_three_words_original_case_relative_to_clip(self) -> None:
        ws = words(
            ("Eu", 10.0, 10.2),
            ("tenho", 10.2, 10.5),
            ("outro", 10.5, 10.9),
            ("número", 11.2, 11.6),
            ("aqui", 11.6, 11.9),
        )
        cues = captions.build_cues(ws, clip_start=10.0, clip_end=20.0, words_per_cue=3)
        self.assertEqual([c.text for c in cues], ["Eu tenho outro", "número aqui"])
        self.assertEqual(cues[0].start, 0.0)
        self.assertEqual(cues[0].end, 1.2)  # ends when the next cue starts
        self.assertEqual(cues[1].start, 1.2)

    def test_ignores_words_outside_the_window_and_clamps_end(self) -> None:
        ws = words(("fora", 5.0, 5.5), ("dentro", 10.5, 19.9))
        cues = captions.build_cues(ws, clip_start=10.0, clip_end=20.0)
        self.assertEqual(len(cues), 1)
        self.assertEqual(cues[0].text, "dentro")
        self.assertLessEqual(cues[0].end, 10.0)

    def test_sentence_end_closes_the_cue_early(self) -> None:
        ws = words(
            ("Olha", 0.0, 0.3),
            ("isso!", 0.3, 0.6),
            ("Que", 0.8, 1.0),
            ("coisa", 1.0, 1.3),
            ("doida", 1.3, 1.6),
            ("né?", 1.6, 1.9),
        )
        cues = captions.build_cues(ws, clip_start=0.0, clip_end=5.0, words_per_cue=3)
        self.assertEqual(
            [c.text for c in cues], ["Olha isso!", "Que coisa doida", "né?"]
        )

    def test_censor_replaces_the_last_vowel_of_swear_words(self) -> None:
        self.assertEqual(captions.censor("merda"), "merd4")
        self.assertEqual(captions.censor("Porra,"), "Porr4,")
        self.assertEqual(captions.censor("CARALHO!"), "CARALH0!")
        self.assertEqual(captions.censor("desgraça..."), "desgraç4...")
        self.assertEqual(captions.censor("cu"), "c*")
        self.assertEqual(captions.censor("“fodido”"), "“fodid0”")
        self.assertEqual(captions.censor("computador"), "computador")
        self.assertEqual(captions.censor("..."), "...")

    def test_cue_at_and_colour(self) -> None:
        cues = [captions.Cue(0.0, 1.0, "A"), captions.Cue(1.0, 2.0, "B")]
        self.assertEqual(captions.cue_at(cues, 0.5).text, "A")
        self.assertEqual(captions.cue_at(cues, 1.0).text, "B")
        self.assertIsNone(captions.cue_at(cues, 2.5))
        self.assertEqual(captions.hex_to_bgr("#FFE11A"), (0x1A, 0xE1, 0xFF))
        with self.assertRaises(ValueError):
            captions.build_cues([], 0, 1, words_per_cue=0)


class JumpCutTests(unittest.TestCase):
    def test_keep_frames_snaps_drops_empty_and_merges_touching(self) -> None:
        keep = [(650.0, 656.5), (656.51, 656.52), (656.5, 660.0), (661.0, 662.0)]
        self.assertEqual(
            render_clip.keep_frames(keep, start=650.0, fps=30.0),
            [(0, 300), (330, 360)],
        )
        self.assertEqual(
            render_clip.keep_frames([(10.0, 32.0)], 10.0, 29.97), [(0, 659)]
        )

    def test_audio_filter_trims_each_range_and_concats(self) -> None:
        self.assertEqual(
            render_clip.audio_filter([(0, 195), (246, 420)], 30.0),
            "[1:a]atrim=start=0.000000:end=6.500000,asetpts=PTS-STARTPTS[a0];"
            "[1:a]atrim=start=8.200000:end=14.000000,asetpts=PTS-STARTPTS[a1];"
            "[a0][a1]concat=n=2:v=0:a=1[aout]",
        )


class LoudnessTests(unittest.TestCase):
    def test_sine_zeros_and_partial_last_window(self) -> None:
        rate = 16_000
        sine = [0.5 * math.sin(2 * math.pi * 440 * n / rate) for n in range(rate // 10)]
        # one 100 ms window of a 0.5 sine (rms 0.3536 = -9.0 dBFS), one of silence, then 50 ms of the sine
        audio = sine + [0.0] * (rate // 10) + sine[: rate // 20]
        self.assertEqual(transcribe.loudness_db(audio, rate), [-9.0, -90.0, -9.0])
        self.assertEqual(transcribe.loudness_db([], rate), [])


def frame(*faces: tuple[int, float, float]) -> list[speaker.Face]:
    return [
        speaker.Face(track_id, cx, 100.0, 120.0, activity)
        for track_id, cx, activity in faces
    ]


class SpeakerTests(unittest.TestCase):
    def test_short_burst_does_not_switch_speaker(self) -> None:
        frames = [frame((0, 300.0, 5.0), (1, 1500.0, 1.0))] * 10
        frames += [
            frame((0, 300.0, 1.0), (1, 1500.0, 9.0))
        ] * 5  # 5-frame burst from face 1
        frames += [frame((0, 300.0, 5.0), (1, 1500.0, 1.0))] * 10
        chosen = speaker.choose_speaker(frames, hold_frames=12)
        self.assertTrue(all(f is not None and f.track_id == 0 for f in chosen))

    def test_sustained_talking_switches_after_hold(self) -> None:
        frames = [frame((0, 300.0, 5.0), (1, 1500.0, 1.0))] * 5
        frames += [frame((0, 300.0, 1.0), (1, 1500.0, 9.0))] * 20
        chosen = speaker.choose_speaker(frames, hold_frames=12)
        ids = [f.track_id for f in chosen if f]
        self.assertEqual(ids[: 5 + 11], [0] * 16)
        self.assertEqual(ids[16:], [1] * 9)

    def test_speaker_leaving_frame_hands_over_immediately(self) -> None:
        frames = (
            [frame((0, 300.0, 5.0), (1, 1500.0, 1.0))] * 3
            + [frame((1, 1500.0, 0.5))]
            + [frame()]
        )
        chosen = speaker.choose_speaker(frames, hold_frames=12)
        self.assertEqual(
            [f.track_id if f else None for f in chosen], [0, 0, 0, 1, None]
        )

    def test_smooth_path_ignores_jitter_and_eases_real_moves(self) -> None:
        jitter = speaker.smooth_path([960.0, 990.0, 940.0, 970.0], source_width=1920.0)
        self.assertTrue(all(abs(x - 960.0) < 1e-6 for x in jitter))
        move = speaker.smooth_path([300.0] * 3 + [1500.0] * 60, source_width=1920.0)
        self.assertLess(move[3], 400.0)  # no jump cut
        self.assertGreater(move[-1], 1400.0)  # but it gets there
        self.assertEqual(speaker.smooth_path([None, None], 1920.0), [960.0, 960.0])

    def test_clamp_window_and_track_assignment(self) -> None:
        self.assertEqual(speaker.clamp_window(100.0, 608, 1920), 0)
        self.assertEqual(speaker.clamp_window(1900.0, 608, 1920), 1312)
        self.assertEqual(speaker.clamp_window(960.0, 608, 1920), 656)
        previous = frame((0, 300.0, 1.0), (1, 1500.0, 1.0))
        pairs, next_id = speaker.assign_tracks(
            previous, [(1510.0, 100.0, 120.0), (900.0, 100.0, 120.0)], next_id=2
        )
        self.assertEqual(pairs, [(0, 1), (1, 2)])
        self.assertEqual(next_id, 3)


class SpeakerByScoreTests(unittest.TestCase):
    def test_threshold_hold_and_silence(self) -> None:
        a_talks = frame((0, 300.0, 1.0), (1, 1500.0, -1.0))
        b_talks = frame((0, 300.0, -1.0), (1, 1500.0, 2.0))
        nobody = frame((0, 300.0, -1.0), (1, 1500.0, -0.5))
        frames = [a_talks] * 2 + [b_talks] * 4 + [nobody] * 4
        chosen = speaker.choose_speaker_by_score(
            frames, hold_frames=3, silence_frames=2
        )
        ids = [f.track_id if f else None for f in chosen]
        self.assertEqual(ids, [0, 0, 0, 0, 1, 1, 1, 1, None, None])

    def test_nobody_above_threshold_means_no_speaker(self) -> None:
        frames = [frame((0, 300.0, -0.1), (1, 1500.0, 0.0))] * 3
        chosen = speaker.choose_speaker_by_score(frames, 3, 2)
        self.assertEqual(chosen, [None, None, None])

    def test_speaker_leaving_hands_over_to_whoever_speaks(self) -> None:
        frames = [frame((0, 300.0, 1.0), (1, 1500.0, -1.0)), frame((1, 1500.0, 0.5))]
        chosen = speaker.choose_speaker_by_score(frames, 12, 45)
        self.assertEqual([f.track_id for f in chosen if f], [0, 1])


class AsdMathTests(unittest.TestCase):
    def test_crop_box_matches_upstream_formula(self) -> None:
        # half size 50, scale 0.4: 70 px to each side, 50 px up, 90 px down
        self.assertEqual(asd_math.crop_box(100.0, 200.0, 50.0), (30, 150, 170, 290))
        self.assertEqual(asd_math.crop_box(100.5, 200.5, 10.0), (86, 190, 114, 218))
        boxes = np.array([[100.0, 200.0, 80.0, 100.0]] * 3)  # half size = max(w, h) / 2
        self.assertEqual(asd_math.crop_boxes(boxes), [(30, 150, 170, 290)] * 3)

    def test_padded_region_fills_outside_with_grey(self) -> None:
        image = np.arange(100, dtype=np.uint8).reshape(10, 10)
        out = asd_math.padded_region(image, (-2, -1, 3, 2))
        self.assertEqual(out.shape, (3, 5))
        self.assertTrue((out[0] == 110).all() and (out[:, :2] == 110).all())
        self.assertEqual(out[1:, 2:].tolist(), image[0:2, 0:3].tolist())

    def test_median_smooth_removes_a_spike(self) -> None:
        smooth = asd_math.median_smooth([5, 5, 100, 5, 5], kernel=3)
        self.assertEqual(smooth.tolist(), [5, 5, 5, 5, 5])

    def test_lengths_chunks_and_averaging(self) -> None:
        self.assertEqual(asd_math.aligned_lengths(239, 60), (236, 59))
        self.assertEqual(asd_math.aligned_lengths(400, 60), (240, 60))
        self.assertEqual(asd_math.chunk_bounds(60, 1), [(0, 25), (25, 50), (50, 60)])
        self.assertEqual(asd_math.chunk_bounds(60, 6), [(0, 60)])
        self.assertEqual(asd_math.average_durations([[1, 2], [3, 4]]), [2.0, 3.0])
        smooth = asd_math.moving_average([0.0, 0.0, 10.0, 0.0, 0.0])
        self.assertAlmostEqual(smooth[0], 10 / 3)
        self.assertAlmostEqual(smooth[2], 2.0)

    def test_sampling_25_fps_and_back(self) -> None:
        self.assertEqual(asd_math.source_index(25, 29.97), 30)
        self.assertEqual(asd_math.sample_index(30, 29.97), 25)
        # 50 fps source: sample j is frame 2j; the gap between frames 0 and 10 is interpolated
        track = asd_math.track_samples(
            [(0, 0.0, 0.0, 10.0, 12.0), (10, 100.0, 50.0, 10.0, 12.0)], 50.0
        )
        self.assertEqual(track.j0, 0)
        self.assertEqual(
            track.boxes[:, 0].tolist(), [0.0, 20.0, 40.0, 60.0, 80.0, 100.0]
        )
        self.assertIsNone(asd_math.track_samples([], 25.0))

    def test_dense_faces_maps_scores_to_source_frames(self) -> None:
        scored = asd_math.TrackSamples(
            2, np.array([[10.0, 20.0, 30.0, 40.0]] * 3), [0.5, 1.0]
        )
        unscored = asd_math.TrackSamples(0, np.array([[1.0, 1.0, 1.0, 1.0]] * 6))
        frames = asd_math.dense_faces({7: scored, 8: unscored}, fps=25.0, n_frames=6)
        self.assertEqual(
            [[f.activity for f in fs] for fs in frames],
            [[], [], [0.5], [1.0], [1.0], []],
        )
        self.assertEqual(frames[2][0], speaker.Face(7, 10.0, 20.0, 30.0, 0.5, 40.0))


def face_at(cx: float, track_id: int = 0, width: float = 152.0) -> speaker.Face:
    return speaker.Face(track_id, cx, 500.0, width, 1.0, width * 1.2)


class CameraTests(unittest.TestCase):
    def test_target_shot_zooms_on_the_speaker_and_out_without_one(self) -> None:
        shot = camera.target_shot(face_at(960.0, width=200.0), [], None, 1920, 1080)
        self.assertAlmostEqual(
            shot.height, 200 / 0.38 * 16 / 9
        )  # face = 38% of the crop width
        self.assertAlmostEqual(
            shot.cy, 500 + 0.1 * shot.height
        )  # face at 40% of the crop height
        tiny = camera.target_shot(face_at(960.0, width=20.0), [], None, 1920, 1080)
        self.assertAlmostEqual(tiny.height, 1080 / 1.25)
        wide = camera.target_shot(
            None, [face_at(400.0), face_at(800.0)], None, 1920, 1080
        )
        self.assertEqual(wide, camera.Shot(600.0, 540.0, 1080.0))
        self.assertEqual(camera.target_shot(None, [], 1500.0, 1920, 1080).cx, 1500.0)
        # the mouth fallback never earns a push-in: full-height window on the guessed speaker
        loose = camera.target_shot(face_at(960.0), [], None, 1920, 1080, zoom=False)
        self.assertEqual(loose, camera.Shot(960.0, 540.0, 1080.0))

    def test_path_pushes_in_then_pulls_back_smoothly(self) -> None:
        speakers = [None] * 30 + [face_at(960.0)] * 150 + [None] * 150
        path = camera.camera_path(speakers, [[]] * len(speakers), 1920, 1080, 30.0)
        self.assertEqual(path[0].height, 1080.0)
        self.assertLess(path[179].height, 880.0)  # zoomed in on the speaker (floor: 1080 / 1.25 = 864)
        self.assertGreater(path[-1].height, 1050.0)  # back to the wide shot
        steps = [abs(b.height - a.height) for a, b in pairwise(path)]
        self.assertLessEqual(max(steps), camera.ZOOM_ALPHA * 1080 + 1e-9)

    def test_speaker_change_eases_and_jitter_is_ignored(self) -> None:
        speakers = [face_at(300.0, 0)] * 30 + [face_at(1500.0, 1)] * 30
        path = camera.camera_path(speakers, [[]] * 60, 1920, 1080, 30.0)
        steps = [abs(b.cx - a.cx) for a, b in pairwise(path)]
        self.assertLess(max(steps), 0.3 * 1200)  # no cut
        self.assertGreater(path[30 + 9].cx, 300 + 0.9 * 1200)  # there within ~0.3 s
        jitter = [face_at(960.0 + (10 if k % 2 else -10)) for k in range(30)]
        still = camera.camera_path(jitter, [[]] * 30, 1920, 1080, 30.0)
        self.assertTrue(all(abs(s.cx - still[0].cx) < 1e-9 for s in still))

    def test_crop_rect_stays_inside_the_frame(self) -> None:
        self.assertEqual(
            camera.crop_rect(camera.Shot(10, 10, 600), 1920, 1080), (0, 0, 338, 600)
        )
        self.assertEqual(
            camera.crop_rect(camera.Shot(1910, 1075, 600), 1920, 1080),
            (1582, 480, 338, 600),
        )
        self.assertEqual(
            camera.crop_rect(camera.Shot(960, 540, 5000), 1920, 1080),
            (656, 0, 608, 1080),
        )


def talking(*faces: tuple[int, float, float]) -> list[speaker.Face]:
    return [speaker.Face(t, cx, 500.0, 150.0, score, 180.0) for t, cx, score in faces]


class GroupShotTests(unittest.TestCase):
    def test_overlap_needs_min_duration_and_holds_after(self) -> None:
        both = talking((0, 600.0, 1.0), (1, 1300.0, 0.5))
        one = talking((0, 600.0, 1.0), (1, 1300.0, -1.0))
        # 10 fps: overlap needs 5 frames, the group shot holds 10 frames after it
        blip = camera.group_frames([one] * 2 + [both] * 4 + [one] * 4, fps=10.0)
        self.assertTrue(all(g == [] for g in blip))
        frames = [both] * 6 + [one] * 12
        groups = camera.group_frames(frames, fps=10.0)
        active = [bool(g) for g in groups]
        self.assertEqual(active, [False] * 4 + [True] * 12 + [False] * 2)
        self.assertEqual({f.track_id for f in groups[4]}, {0, 1})

    def test_group_shot_holds_every_padded_face(self) -> None:
        faces = talking((0, 800.0, 1.0), (1, 1100.0, 1.0))
        shot = camera.group_shot(faces, 1920, 1080)
        # x span: 800 - 75 - 90 to 1100 + 75 + 90 = 635..1265 -> 630 px wide -> 1120 px tall > 1080: doesn't fit
        self.assertEqual(shot, camera.Shot(950.0, 540.0, 1080.0))
        close = talking((0, 850.0, 1.0), (1, 1050.0, 1.0))
        shot = camera.group_shot(close, 1920, 1080)
        # x span 685..1215 = 530 px -> 942.2 tall, wider than one face's shot (the 864 px floor)
        self.assertAlmostEqual(shot.height, 530 / camera.ASPECT)
        self.assertAlmostEqual(shot.cx, 950.0)
        self.assertAlmostEqual(shot.cy, 500.0)
        left, _, width, _ = camera.crop_rect(shot, 1920, 1080)
        self.assertLessEqual(left, 685)
        self.assertGreaterEqual(left + width, 1215)

    def test_camera_eases_out_to_the_group_slowly(self) -> None:
        faces = talking((0, 850.0, 1.0), (1, 1050.0, 1.0))
        speakers = [faces[0]] * 60
        groups = [[]] * 20 + [faces] * 40
        path = camera.camera_path(
            speakers, [faces] * 60, 1920, 1080, 30.0, True, groups
        )
        target = camera.group_shot(faces, 1920, 1080)
        self.assertLess(path[19].height, target.height - 50)
        steps = [abs(b.height - a.height) for a, b in pairwise(path)]
        self.assertLessEqual(max(steps), camera.ZOOM_ALPHA * 1080)
        self.assertLess(abs(path[-1].height - target.height), 20)


class WatermarkTests(unittest.TestCase):
    def test_origin_for_every_position_and_safe_zones(self) -> None:
        expected = {
            "top-left": (48, 150),
            "top-right": (832, 150),
            "top": (440, 150),
            "bottom-left": (48, 1400),
            "bottom-right": (832, 1400),
            "bottom": (440, 1400),
        }
        for position, xy in expected.items():
            self.assertEqual(watermark.origin(position, 200, 100), xy, position)
        self.assertEqual(
            watermark.origin("bottom", 200, 1450), (440, 150)
        )  # too tall: top limit wins

    def test_parse_validates_and_skips_empty(self) -> None:
        self.assertIsNone(watermark.parse_watermark(None))
        self.assertIsNone(watermark.parse_watermark({"text": " ", "image": None}))
        spec = watermark.parse_watermark(
            {"text": "@canal", "position": "top", "opacity": 0.5, "size": 10}
        )
        self.assertEqual(spec, watermark.Watermark("@canal", None, "top", 0.5, 10.0))
        for bad in (
            {"text": "x", "position": "middle"},
            {"text": "x", "opacity": 0},
            {"text": "x", "size": 50},
            "x",
        ):
            with self.assertRaises(ValueError):
                watermark.parse_watermark(bad)

    @unittest.skipUnless(importlib.util.find_spec("PIL"), "Pillow not installed")
    def test_missing_image_falls_back_to_text_with_opacity(self) -> None:
        spec = watermark.Watermark("@canal", "/nope/logo.png", "top", 0.5, 10.0)
        with self.assertLogs("cuts.watermark", level="WARNING"):
            overlay = watermark.build_overlay(spec, None)
        self.assertEqual(overlay.shape[2], 4)
        self.assertLessEqual(int(overlay[:, :, 3].max()), 128)
        self.assertIsNone(
            watermark.build_overlay(
                watermark.Watermark(None, "/nope.png", "top", 1, 10), None
            )
        )

    def test_missing_font_warns_and_falls_back(self) -> None:
        with self.assertLogs("cuts.render", level="WARNING"):
            font = render_clip.resolve_font("/nope/Montserrat-ExtraBold.ttf")
        self.assertNotEqual(font, "/nope/Montserrat-ExtraBold.ttf")


@unittest.skipUnless(importlib.util.find_spec("torch"), "torch not installed")
class LightAsdModelTests(unittest.TestCase):
    def test_random_weights_give_one_score_per_frame(self) -> None:
        import torch

        from lightasd.net import LightASD

        net = LightASD().eval()
        with torch.inference_mode():
            embed_a = net.model.forward_audio_frontend(torch.randn(1, 200, 13))
            embed_v = net.model.forward_visual_frontend(
                torch.rand(1, 50, 112, 112) * 255
            )
            out = net.model.forward_audio_visual_backend(embed_a, embed_v)
            self.assertEqual(tuple(out.shape), (50, 128))
            self.assertEqual(tuple(net.lossAV.FC(out).shape), (50, 2))

    def test_weights_load_with_prefix_and_fail_loudly_when_incomplete(self) -> None:
        import torch

        import asd
        from lightasd.net import LightASD

        state = {f"module.{k}": v for k, v in LightASD().state_dict().items()}
        state["lossV.FC.weight"] = torch.zeros(2, 128)
        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp) / "w.model")
            torch.save(state, path)
            self.assertEqual(type(asd.load_model(path, "cpu")).__name__, "LightASD")
            del state["module.lossAV.FC.weight"]
            torch.save(state, path)
            with self.assertRaises(RuntimeError):
                asd.load_model(path, "cpu")


class LayaWindowTests(unittest.TestCase):
    def test_one_window_per_start_closest_to_the_middle_of_the_range(self) -> None:
        segs = [
            {"start": float(t), "end": float(t + 10), "text": f"s{t}"}
            for t in range(0, 100, 10)
        ]
        windows = laya_rank.build_windows(segs, 30, 60)
        # target 45 s: 40 and 50 s tie, the first one found (40 s) wins; starts past 60 s cannot reach 30 s
        self.assertEqual(
            [(w["start"], w["end"]) for w in windows][:2], [(0.0, 40.0), (10.0, 50.0)]
        )
        self.assertEqual(windows[-1]["start"], 70.0)
        self.assertEqual(windows[0]["text"], "s0 s10 s20 s30")
        self.assertTrue(all(30 <= w["end"] - w["start"] <= 60 for w in windows))

    def test_score_needs_every_answer_to_be_yes(self) -> None:
        self.assertEqual(
            laya_rank.window_score({"a": {"noul": 0.9}, "b": {"noul": 0.5}}), 0.45
        )


if __name__ == "__main__":
    unittest.main()
