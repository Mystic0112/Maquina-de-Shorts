"""Unit tests for the pure cuts logic (captions split, speaker hysteresis, pan smoothing). No OpenCV."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import captions
import speaker


def words(*spec: tuple[str, float, float]) -> list[dict[str, object]]:
    return [{"word": w, "start": s, "end": e} for w, s, e in spec]


class CaptionTests(unittest.TestCase):
    def test_groups_three_words_upper_case_relative_to_clip(self) -> None:
        ws = words(
            ("eu", 10.0, 10.2),
            ("tenho", 10.2, 10.5),
            ("outro", 10.5, 10.9),
            ("número", 11.2, 11.6),
            ("aqui", 11.6, 11.9),
        )
        cues = captions.build_cues(ws, clip_start=10.0, clip_end=20.0, words_per_cue=3)
        self.assertEqual([c.text for c in cues], ["EU TENHO OUTRO", "NÚMERO AQUI"])
        self.assertEqual(cues[0].start, 0.0)
        self.assertEqual(cues[0].end, 1.2)  # ends when the next cue starts
        self.assertEqual(cues[1].start, 1.2)

    def test_ignores_words_outside_the_window_and_clamps_end(self) -> None:
        ws = words(("fora", 5.0, 5.5), ("dentro", 10.5, 19.9))
        cues = captions.build_cues(ws, clip_start=10.0, clip_end=20.0)
        self.assertEqual(len(cues), 1)
        self.assertEqual(cues[0].text, "DENTRO")
        self.assertLessEqual(cues[0].end, 10.0)

    def test_cue_at_and_colour(self) -> None:
        cues = [captions.Cue(0.0, 1.0, "A"), captions.Cue(1.0, 2.0, "B")]
        self.assertEqual(captions.cue_at(cues, 0.5).text, "A")
        self.assertEqual(captions.cue_at(cues, 1.0).text, "B")
        self.assertIsNone(captions.cue_at(cues, 2.5))
        self.assertEqual(captions.hex_to_bgr("#FFE11A"), (0x1A, 0xE1, 0xFF))
        with self.assertRaises(ValueError):
            captions.build_cues([], 0, 1, words_per_cue=0)


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


if __name__ == "__main__":
    unittest.main()
