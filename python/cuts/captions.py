"""Caption cues for a cut: up to N words per cue (a sentence end closes the cue early), original case,
profanity censored the way Brazilian cut channels do it ("MERD4"), timed from the word timestamps (pure, no OpenCV)."""

from __future__ import annotations

import string
from collections.abc import Iterable, Mapping
from dataclasses import dataclass

MIN_CUE_SECONDS = 0.35
MAX_HOLD_GAP_SECONDS = 1.0  # a cue stays on screen through a pause up to this long
SENTENCE_END = (".", "?", "!")
EDGE_PUNCTUATION = string.punctuation + "…«»“”‘’¡¿"
PROFANITY = frozenset(
    {
        "porra", "caralho", "merda", "puta", "puto", "foda", "foder", "fodeu", "fudeu", "fudido", "fodido",
        "cacete", "buceta", "bosta", "desgraça", "desgraçado", "arrombado", "viado", "cu",
    }
)  # fmt: skip
VOWEL_DIGITS = {
    **dict.fromkeys("aãáâà", "4"),
    **dict.fromkeys("eéê", "3"),
    **dict.fromkeys("ií", "1"),
    **dict.fromkeys("oóôõ", "0"),
    **dict.fromkeys("uú", "*"),
}


@dataclass(frozen=True)
class Cue:
    start: float  # seconds relative to the clip start
    end: float
    text: str


def censor(word: str) -> str:
    """Replaces the last vowel of a listed swear word with a digit ("merda," -> "merd4,"); other words unchanged."""
    core = word.strip(EDGE_PUNCTUATION)
    if core.lower() not in PROFANITY:
        return word
    offset = len(word) - len(word.lstrip(EDGE_PUNCTUATION))
    last = max(i for i, ch in enumerate(core) if ch.lower() in VOWEL_DIGITS)
    digit = VOWEL_DIGITS[core[last].lower()]
    return word[: offset + last] + digit + word[offset + last + 1 :]


def group_words(
    words: list[Mapping[str, object]], words_per_cue: int
) -> list[list[Mapping[str, object]]]:
    """Consecutive groups of at most `words_per_cue` words; a word ending a sentence (. ? !) closes its group."""
    groups: list[list[Mapping[str, object]]] = []
    current: list[Mapping[str, object]] = []
    for word in words:
        current.append(word)
        if len(current) == words_per_cue or str(word["word"]).strip().endswith(
            SENTENCE_END
        ):
            groups.append(current)
            current = []
    if current:
        groups.append(current)
    return groups


def build_cues(
    words: Iterable[Mapping[str, object]],
    clip_start: float,
    clip_end: float,
    words_per_cue: int = 3,
) -> list[Cue]:
    """Groups the words spoken inside [clip_start, clip_end] into cues of up to `words_per_cue` words.

    A cue stays on screen until the next cue starts when the pause between them is short (<= 1 s), otherwise it
    ends with its last word; cues never overlap. Times are relative to the clip start.
    """
    if words_per_cue < 1:
        raise ValueError("words_per_cue must be >= 1")
    inside = [
        w
        for w in words
        if float(w["start"]) >= clip_start - 0.05
        and float(w["end"]) <= clip_end + 0.05
        and str(w["word"]).strip()
    ]
    groups = group_words(inside, words_per_cue)
    cues: list[Cue] = []
    for index, group in enumerate(groups):
        start = max(0.0, float(group[0]["start"]) - clip_start)
        end = max(float(group[-1]["end"]) - clip_start, start + MIN_CUE_SECONDS)
        if index + 1 < len(groups):
            next_start = float(groups[index + 1][0]["start"]) - clip_start
            if next_start - end <= MAX_HOLD_GAP_SECONDS:
                end = next_start
            end = min(end, max(start + MIN_CUE_SECONDS, next_start))
        end = min(end, clip_end - clip_start)
        text = " ".join(censor(str(w["word"]).strip()) for w in group)
        cues.append(Cue(round(start, 3), round(end, 3), text))
    return cues


def cue_at(cues: list[Cue], t: float) -> Cue | None:
    """Cue visible at time t (cues are sorted and non-overlapping)."""
    for cue in cues:
        if cue.start <= t < cue.end:
            return cue
        if cue.start > t:
            break
    return None


def hex_to_bgr(color: str) -> tuple[int, int, int]:
    value = color.lstrip("#")
    if len(value) != 6:
        raise ValueError(f"expected #RRGGBB, got {color!r}")
    r, g, b = (int(value[i : i + 2], 16) for i in (0, 2, 4))
    return (b, g, r)
