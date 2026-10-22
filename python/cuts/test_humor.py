"""Unit tests for the humor layer of a cut (humor.py): parsing, timing, geometry; one drawing test with OpenCV."""

from __future__ import annotations

import importlib.util
import sys
import unittest
from itertools import pairwise
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import humor
import speaker


def item(start: float, end: float, **extra: str) -> humor.Item:
    return humor.Item(start, end, **extra)


class TimingTests(unittest.TestCase):
    def test_activity_and_fade_alpha(self) -> None:
        items = [item(10.0, 11.0), item(12.0, 13.0)]
        self.assertEqual(humor.active(items, 10.5), 0)
        self.assertIsNone(humor.active(items, 11.0))  # the end is exclusive
        self.assertEqual(humor.active(items, 12.0), 1)
        self.assertIsNone(humor.active(items, 9.0))
        joke = items[0]
        self.assertEqual(humor.fade_alpha(joke, 10.0), 0.0)
        self.assertAlmostEqual(humor.fade_alpha(joke, 10.06), 0.5)
        self.assertEqual(humor.fade_alpha(joke, 10.5), 1.0)
        self.assertAlmostEqual(humor.fade_alpha(joke, 10.94), 0.5)
        self.assertEqual(humor.fade_alpha(joke, 11.2), 0.0)

    def test_emoji_pop_in_eases_out_and_holds(self) -> None:
        emoji = item(5.0, 6.0)
        self.assertAlmostEqual(humor.pop_scale(emoji, 5.0), 0.6)
        self.assertAlmostEqual(humor.pop_scale(emoji, 5.075), 0.6 + 0.4 * 0.875)
        self.assertEqual(humor.pop_scale(emoji, 5.15), 1.0)
        self.assertEqual(humor.pop_scale(emoji, 5.9), 1.0)  # no fade-out
        curve = [humor.pop_scale(emoji, 5.0 + k / 100) for k in range(16)]
        self.assertTrue(all(a <= b for a, b in pairwise(curve)))
        steps = [b - a for a, b in pairwise(curve)]
        self.assertGreater(steps[0], steps[-1])  # ease-out: fast first

    def test_punch_zoom_over_its_life(self) -> None:
        punch = item(2.0, 3.0, kind="punch")
        self.assertEqual(humor.punch_factor(punch, 1.9), 1.0)
        self.assertEqual(humor.punch_factor(punch, 2.0), 1.0)
        self.assertAlmostEqual(humor.punch_factor(punch, 2.08), 1.25)
        self.assertAlmostEqual(humor.punch_factor(punch, 2.5), 1.25)
        self.assertAlmostEqual(humor.punch_factor(punch, 2.925), 1.125)  # halfway down
        self.assertLess(humor.punch_factor(punch, 2.999), 1.001)
        self.assertEqual(humor.punch_factor(punch, 3.0), 1.0)
        self.assertEqual(humor.effect_zoom(item(0, 1, kind="spotlight"), 0.5), 1.1)
        self.assertEqual(humor.effect_zoom(item(0, 1, kind="flash"), 0.5), 1.0)
        self.assertEqual(humor.effect_zoom(None, 0.5), 1.0)
        # applied to the crop before the resize: shrinks around the crop centre
        self.assertEqual(
            humor.zoom_rect((100, 0, 608, 1080), 1.25), (161, 108, 486, 864)
        )
        self.assertEqual(humor.zoom_rect((100, 0, 608, 1080), 1.0), (100, 0, 608, 1080))

    def test_flash_alpha_ramps_down(self) -> None:
        flash = item(0.0, 1.0, kind="flash")
        self.assertAlmostEqual(humor.flash_alpha(flash, 0.0), 0.35)
        self.assertAlmostEqual(humor.flash_alpha(flash, 0.5), 0.175)
        self.assertEqual(humor.flash_alpha(flash, 1.0), 0.0)


class GeometryTests(unittest.TestCase):
    def test_crosshair_in_output_coordinates(self) -> None:
        rect = (656, 0, 608, 1080)  # full-height 9:16 window of a 1920x1080 source
        face = speaker.Face(0, 960.0, 540.0, 150.0, 1.0)
        self.assertEqual(humor.crosshair_center(rect, face), (540, 960))
        off_centre = speaker.Face(0, 800.0, 300.0, 150.0, 1.0)
        self.assertEqual(humor.crosshair_center(rect, off_centre), (256, 533))
        zoomed = humor.zoom_rect(
            rect, 1.1
        )  # the spotlight's extra zoom moves the face outward
        self.assertLess(humor.crosshair_center(zoomed, off_centre)[0], 256)
        self.assertEqual(humor.crosshair_center(rect, None), (540, 960))
        outside = speaker.Face(1, 100.0, 300.0, 150.0, 1.0)
        self.assertEqual(humor.crosshair_center(rect, outside), (540, 960))

    def test_emoji_above_joke_above_caption(self) -> None:
        joke_y, emoji_y = humor.stack_layout(1267, 85, 73, 150)
        self.assertEqual(joke_y, 1267 - 150)
        joke_top = joke_y - 73 // 2
        self.assertEqual(
            emoji_y + 150 // 2, joke_top - 40
        )  # bottom edge 40 px above the joke
        self.assertGreater(
            1267 - 85 // 2, joke_y + 73 // 2
        )  # joke clear of the caption
        # no caption: the joke takes the caption line
        joke_y, emoji_y = humor.stack_layout(1267, None, 73, 150)
        self.assertEqual(joke_y, 1267)
        self.assertEqual(emoji_y, 1267 - 36 - 40 - 75)
        # caption only, then nothing at all
        self.assertEqual(
            humor.stack_layout(1267, 85, None, 150), (None, 1267 - 42 - 40 - 75)
        )
        self.assertEqual(
            humor.stack_layout(1267, None, None, 150), (None, 1267 - 40 - 75)
        )
        # tall wrapped texts push the joke further up instead of overlapping
        joke_y, _ = humor.stack_layout(1267, 170, 146, None)
        self.assertEqual(joke_y, 1267 - (170 + 146) // 2 - 20)


class ParseTests(unittest.TestCase):
    def test_malformed_items_are_skipped_and_the_rest_kept(self) -> None:
        raw = {
            "jokes": [
                {"start": 10.0, "end": 11.0, "text": "*risos stage 3*"},
                {"start": "x", "end": 12.0, "text": "a"},
                {"start": 12.0, "end": 11.5, "text": "backwards"},
                {"start": 13.0, "end": 14.0, "text": "  "},
                {"start": 10.5, "end": 10.8, "text": "overlaps"},
                "not an object",
                {"start": 15.0, "end": 16.0, "text": "*APERTANDO*"},
            ],
            "emojis": "nope",
            "effects": [
                {"start": 1.0, "end": 2.0, "type": "zoom"},
                {"start": 3.0, "end": 3.5, "type": "flash", "text": "ERRADO"},
                {"start": 4.0, "end": 4.6, "type": "punch", "text": None},
            ],
        }
        with self.assertLogs("cuts.humor", level="WARNING") as logs:
            plan = humor.parse_humor(raw)
        self.assertEqual(len(logs.output), 7)
        assert plan is not None
        self.assertEqual(
            [j.text for j in plan.jokes], ["*risos stage 3*", "*APERTANDO*"]
        )
        self.assertEqual(plan.emojis, ())
        self.assertEqual(
            [(e.kind, e.text) for e in plan.effects],
            [("flash", "ERRADO"), ("punch", None)],
        )
        self.assertEqual(humor.active(plan.jokes, 15.5), 1)

    def test_absent_or_wrong_type_gives_none(self) -> None:
        self.assertIsNone(humor.parse_humor(None))
        self.assertIsNone(humor.parse_humor({"jokes": []}))
        with self.assertLogs("cuts.humor", level="WARNING"):
            self.assertIsNone(humor.parse_humor(["x"]))


@unittest.skipUnless(
    importlib.util.find_spec("cv2") and importlib.util.find_spec("PIL"),
    "OpenCV/Pillow not installed",
)
class LayerTests(unittest.TestCase):
    def test_bad_emoji_is_skipped_while_joke_and_flash_draw(self) -> None:
        import numpy as np

        plan = humor.parse_humor(
            {
                "jokes": [{"start": 0.0, "end": 1.0, "text": "*risos*"}],
                "emojis": [{"start": 0.0, "end": 1.0, "image": "/nope/1f602.png"}],
                "effects": [
                    {"start": 0.0, "end": 1.0, "type": "flash", "text": "ERRADO"},
                    {"start": 2.0, "end": 3.0, "type": "spotlight"},
                ],
            }
        )
        assert plan is not None
        with self.assertLogs(level="WARNING"):
            layer = humor.HumorLayer(plan, None, "open")
        out = np.zeros((1920, 1080, 3), np.uint8)
        layer.draw_effects(out, 0.5, None, None)
        self.assertGreater(int(out[10, 10, 2]), 0)  # red tint
        self.assertEqual(int(out[10, 10, 0]), 0)
        layer.draw_text(out, 0.5, None, 1757)
        self.assertEqual(
            int(out[1700:1820].max()), 255
        )  # white joke on the caption line
        spot = np.full((1920, 1080, 3), (0, 0, 200), np.uint8)
        layer.draw_effects(spot, 2.5, None, None)  # "open" skips the spotlight
        self.assertEqual(int(spot[5, 5, 2]), 200)
        self.assertEqual(layer.counts(), {"jokes": 1, "emojis": 0, "effects": 1})

    def test_spotlight_greys_and_draws_the_crosshair(self) -> None:
        import numpy as np

        plan = humor.Humor(effects=(item(0.0, 1.0, kind="spotlight"),))
        layer = humor.HumorLayer(plan, None, "face")
        self.assertEqual(
            layer.crop((0, 0, 608, 1080), 0.5), humor.zoom_rect((0, 0, 608, 1080), 1.1)
        )
        out = np.full((1920, 1080, 3), (0, 0, 200), np.uint8)
        layer.draw_effects(out, 0.5, (656, 0, 608, 1080), None)
        self.assertEqual(len(set(out[5, 5].tolist())), 1)  # grey
        self.assertEqual(
            out[960, 540 + 60].tolist(), [255, 255, 255]
        )  # on the ring and the arm
        self.assertNotEqual(
            out[960, 540].tolist(), [255, 255, 255]
        )  # gap in the middle
        self.assertEqual(layer.counts(), {"jokes": 0, "emojis": 0, "effects": 1})


if __name__ == "__main__":
    unittest.main()
