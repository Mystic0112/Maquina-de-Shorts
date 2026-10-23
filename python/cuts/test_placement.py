"""Unit tests for placement.py (overlays avoid the face and burned-in text) and the pure part of textdetect.py.

No OpenCV, except one test that runs where cv2.dnn_TextDetectionModel_DB exists.
"""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import placement as pl
import textdetect
from speaker import Face

EVERYTHING = (0.0, 0.0, 1080.0, 1920.0)


def faces(*boxes: pl.Box) -> pl.Obstacles:
    return pl.Obstacles(faces=boxes)


class MappingTests(unittest.TestCase):
    def test_source_box_through_the_crop_to_output(self) -> None:
        crop = (100, 0, 540, 960)  # scale 2 onto the full 1080x1920 frame
        self.assertEqual(
            pl.map_box((370, 480, 470, 530), crop), (540.0, 960.0, 740.0, 1060.0)
        )
        # partly outside: clipped to the frame; fully outside: dropped
        self.assertEqual(
            pl.map_box((600, 0, 700, 10), crop), (1000.0, 0.0, 1080.0, 20.0)
        )
        self.assertIsNone(pl.map_box((0, 0, 50, 50), crop))
        # "open": the 4:5 window sits 285 px down the output
        self.assertEqual(
            pl.map_box((0, 0, 864, 1080), (0, 0, 864, 1080), pl.OPEN_WINDOW),
            (0.0, 285.0, 1080.0, 1635.0),
        )

    def test_face_padded_and_text_mapped_per_frame(self) -> None:
        face = Face(1, 500.0, 400.0, 100.0, 0.0, 120.0)
        self.assertEqual(pl.face_box(face), (435.0, 322.0, 565.0, 478.0))
        no_height = Face(1, 500.0, 400.0, 100.0, 0.0)  # height falls back to width
        self.assertEqual(pl.face_box(no_height), (435.0, 335.0, 565.0, 465.0))
        crop = (100, 0, 540, 960)
        found = pl.frame_obstacles(
            crop, pl.FULL_FRAME, face, [(0, 0, 50, 50), (370, 480, 470, 530)]
        )
        self.assertEqual(found.faces, ((670.0, 644.0, 930.0, 956.0),))
        self.assertEqual(found.texts, ((540.0, 960.0, 740.0, 1060.0),))
        self.assertEqual(pl.frame_obstacles(crop, pl.FULL_FRAME, None, []).boxes, ())

    def test_text_samples_and_span_union(self) -> None:
        a, b, c = (0, 0, 1, 1), (2, 2, 3, 3), (4, 4, 5, 5)
        samples = [(0.0, [a]), (1.0, [b]), (2.0, [c])]
        self.assertEqual(pl.visible_text(samples, 1.5), [b, c])
        self.assertEqual(pl.visible_text(samples, 0.0), [a])
        self.assertEqual(pl.sample_frames(0, 20, range(10)), [0, 5])
        face = Face(1, 540.0, 960.0, 100.0, 0.0)
        span = pl.span_obstacles(
            [pl.FULL_FRAME] * 20, pl.FULL_FRAME, [face] * 20, [], 10.0, range(10)
        )
        self.assertEqual(len(span(0.0, 2.0).faces), 2)  # frames 0 and 5 only
        self.assertEqual(span(1.0, 2.0).boxes, ())  # all cut out


class CaptionTests(unittest.TestCase):
    def test_default_when_free(self) -> None:
        self.assertEqual(
            pl.place_caption("face", 600, 85, pl.Obstacles()),
            pl.CaptionPlace(1267, False, False),
        )

    def test_face_in_the_band_moves_it_to_078(self) -> None:
        place = pl.place_caption("face", 600, 85, faces((300, 1200, 780, 1300)))
        self.assertEqual(place.y, pl.clamp_centre(round(0.78 * 1920), 85))
        self.assertEqual((place.moved, place.skip), (True, False))

    def test_every_candidate_blocked_keeps_the_default(self) -> None:
        place = pl.place_caption("face", 600, 85, faces(EVERYTHING))
        self.assertEqual(
            place, pl.CaptionPlace(1267, False, False)
        )  # a face never skips

    def test_burned_in_text_over_half_the_band_skips_the_cue(self) -> None:
        own_caption = (200.0, 1220.0, 880.0, 1315.0)
        place = pl.place_caption(
            "face", 600, 85, pl.Obstacles((EVERYTHING,), (own_caption,))
        )
        self.assertEqual(place, pl.CaptionPlace(1267, False, True))
        small_tag = (500.0, 1250.0, 600.0, 1280.0)
        place = pl.place_caption(
            "face", 600, 85, pl.Obstacles((EVERYTHING,), (small_tag,))
        )
        self.assertFalse(place.skip)
        # with a free band elsewhere the cue moves instead of being skipped
        place = pl.place_caption("face", 600, 85, pl.Obstacles(texts=(own_caption,)))
        self.assertEqual((place.moved, place.skip), (True, False))

    def test_safe_zone_clamps(self) -> None:
        self.assertEqual(pl.clamp_centre(100, 85), 192)  # top at 150
        self.assertEqual(pl.clamp_centre(1900, 85), 1457)  # bottom at 1500
        self.assertEqual(pl.clamp_centre(1000, 85), 1000)
        for cy in pl.caption_candidates("face", 170)[1:]:
            self.assertGreaterEqual(cy - 85, pl.SAFE_TOP)
            self.assertLessEqual(cy - 85 + 170, pl.SAFE_BOTTOM)

    def test_open_framing_candidates(self) -> None:
        self.assertEqual(pl.caption_candidates("open", 85), [1756, 1457, 998, 691])
        # a block too tall to start inside the 4:5 window at 0.36 H is not tried there
        self.assertEqual(pl.caption_candidates("open", 900), [1756, 1050, 998])
        self.assertEqual(pl.caption_candidates("face", 900), [1267, 1050, 998, 691])


class JokeAndEmojiTests(unittest.TestCase):
    def test_joke_takes_the_first_clear_band_above_the_caption(self) -> None:
        limit = 1267 - 85 // 2 - 20  # caption top minus the humor TEXT_GAP
        self.assertEqual(
            pl.place_joke(1117, 400, 73, limit, "face", pl.Obstacles()), 1117
        )
        face = faces((300, 1050, 780, 1180))
        self.assertEqual(pl.place_joke(1117, 400, 73, limit, "face", face), 998)
        # no caption showing: anything clear goes, the lower band first
        self.assertEqual(
            pl.place_joke(1267, 400, 73, None, "face", faces((300, 1200, 780, 1300))),
            1463,
        )
        self.assertEqual(
            pl.place_joke(1117, 400, 73, limit, "face", faces(EVERYTHING)), 1117
        )

    def test_emoji_side_choice(self) -> None:
        self.assertEqual(pl.emoji_x(700, 150, 150, pl.Obstacles()), 540)
        centre = (400.0, 500.0, 700.0, 900.0)
        self.assertEqual(pl.emoji_x(700, 150, 150, faces(centre)), 300)
        self.assertEqual(
            pl.emoji_x(700, 150, 150, faces(centre, (0, 600, 380, 800))), 780
        )
        self.assertEqual(pl.emoji_x(700, 150, 150, faces(EVERYTHING)), 540)
        # a wide sticker keeps 40 px from the edges
        self.assertEqual(pl.emoji_x(700, 600, 150, faces((800, 600, 830, 800))), 340)
        self.assertEqual(pl.emoji_x(700, 600, 150, faces((230, 600, 245, 800))), 740)


class TextBoxTests(unittest.TestCase):
    def test_quads_back_to_frame_pixels(self) -> None:
        scale = 736 / 1920  # 1920x1080 letterboxed to 736x414 + padding
        quads = [
            [[10, 30], [10, 10], [100, 10], [100, 30]],
            [[10, 52], [10, 50], [100, 50], [100, 52]],  # under 1% of the height
            [[0, 400], [0, 380], [50, 380], [50, 420]],  # runs into the padding
        ]
        boxes = textdetect.boxes_from_quads(quads, scale, 1920, 1080)
        self.assertEqual(len(boxes), 2)
        for got, want in zip(
            boxes[0], (10 / scale, 10 / scale, 100 / scale, 30 / scale), strict=True
        ):
            self.assertAlmostEqual(got, want)
        self.assertEqual(boxes[1][3], 1080.0)


@unittest.skipUnless(
    importlib.util.find_spec("cv2") is not None
    and hasattr(importlib.import_module("cv2"), "dnn_TextDetectionModel_DB"),
    "OpenCV without dnn_TextDetectionModel_DB",
)
class DetectorTests(unittest.TestCase):
    def test_missing_model_warns_and_yields_no_boxes(self) -> None:
        import numpy as np

        self.assertIsNone(textdetect.load_detector(None))
        with self.assertLogs("cuts.textdetect", level="WARNING"):
            self.assertIsNone(textdetect.load_detector("/nope/text_detection.onnx"))
        square, scale = textdetect.letterbox(np.zeros((1080, 1920, 3), np.uint8))
        self.assertEqual((square.shape, scale), ((736, 736, 3), 736 / 1920))

    def test_inference_error_warns_and_yields_no_boxes(self) -> None:
        import cv2
        import numpy as np

        broken = cv2.dnn_TextDetectionModel_DB(cv2.dnn.Net())
        with self.assertLogs("cuts.textdetect", level="WARNING"):
            self.assertIsNone(
                textdetect.detect_text(broken, np.zeros((64, 64, 3), np.uint8))
            )


if __name__ == "__main__":
    unittest.main()
