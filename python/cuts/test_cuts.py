"""Unit tests for the pure cuts logic (captions, speaker hysteresis, pan smoothing, jump cuts, loudness). No OpenCV."""

from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import captions
import laya_rank
import render_clip
import speaker
import transcribe


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
