# AGPL-3.0 BOUNDARY: this file imports OpenMontage (AGPL-3.0) code and must only be invoked as a subprocess — never import it from src/ or python/.  # noqa: E501
"""Fetch commercially-reusable stock footage for each scene via OpenMontage's DirectClipSearch.

Contract (see src/orchestrator/types.ts -> FootageClip):

    stdin  : {"outputDir": str,
              "queries": [{"sceneIndex": int, "query": str, "kind"?: "video"|"image"|[...]}],
              "clipsPerQuery": int = 2, "minDurationSeconds": number | null,
              "sources": [str] | null,
              "kinds": ["video" | "image"] = ["video"],   # per-query "kind" overrides it
              # optional extras:
              "maxDurationSeconds": number = 60, "minWidth": int = 640,
              "timeoutSecondsPerQuery": number = 180,
              "deadlineSeconds": number | null}   # wall clock for the whole run; after it no new
                                                  # search/download starts and partial results return
    stdout : exactly one JSON object {"clips": [FootageClip, ...], "errors": [ErrorEntry, ...]}
             Up to clipsPerQuery items of EACH requested kind per query. Images have
             kind "image", durationSeconds 0 and their real (downloaded) width/height.
             Each clip may also carry "licenseUrl" (CC deed, NASA/Pexels/Pixabay terms) and
             "creatorUrl" (author page, e.g. when the Commons author is only given as a link).
             ErrorEntry = {"sceneIndex": int|null, "query": str|null, "source": str|null,
                           "phase": str, "message": str}
    stderr : all logging (API keys and key=/token= URL parameters are redacted everywhere,
             including the stdout "errors")
    exit   : 0 = at least one usable clip, 1 = zero usable clips, 2 = invalid input,
             3 = OpenMontage checkout missing (run scripts/setup_vendor.ps1)

Licensing (no human reviews the output before publishing): only sources on the allowlist are
queried, and every candidate passes a per-item license gate BEFORE it is downloaded:
  - pexels / pixabay_video : their own licenses allow commercial reuse (only if API key is set)
  - nasa                   : public domain only when every credit names NASA, a NASA centre or an
                             enumerated NASA/US-government partner; the FULL search metadata and
                             the asset's metadata.json (EXIF/IPTC/XMP credit fields) are checked,
                             and any other credit (SpaceX, ESA, Getty...) or copyright text rejects.
                             Names in NASA's photographer/secondary_creator fields must be credited
                             NASA-style in the item's own text (or be enumerated NASA staff)
  - wikimedia              : only Public domain / CC0 / CC BY (any version); SA, NC, ND, GFDL
                             and anything unrecognised are dropped; CC BY needs a usable author
                             (Commons Attribution -> Artist link text -> Credit -> name from URL)
Archive sources (wikimedia, nasa) also need lexical overlap between the query and the item's
title/description, and AI-generated items are skipped.

Download weight (raw files feed a Node normalisation step, so keep them small):
  - wikimedia : Commons server-side transcode (1080p, else 720p, VP9 webm) instead of the original;
                the original is used only when no such transcode exists and it fits the caps
  - nasa      : smallest of ~medium/~large that is >= 720p, measured by probing the remote file
                with Remotion's ffprobe before download (also yields the real duration); clips
                longer than maxDurationSeconds are kept only if that file is <= 40 MB
  - caps      : maxDurationSeconds (default 60), sources wider than 1920 px are skipped unless they
                are an explicitly chosen transcode, and a hard 150 MB per-file cap is enforced both
                via Content-Length and while streaming (partial files are deleted)

Still images (kind "image"; sources pexels [key], wikimedia, nasa; Pixabay images are skipped
because OpenMontage only has a standalone tool for them, not a stock-source adapter):
  - same license / relevance / AI-generated gates as video
  - maps, diagrams, charts, logos, coats of arms, flags etc. are skipped (title/category text);
    Commons only JPEG/PNG/TIFF sources (no SVG/GIF/PDF)
  - long side must be >= 1080 px and aspect ratio <= 2.5:1; Commons downloads a scaled
    thumbnail that fits COMMONS_IMAGE_BOX (Commons only serves standard thumbnail widths such as
    1920 and 3840; other requests are rounded up),
    NASA the first of ~large/~medium/~orig that is >= 1080 px (probed remotely); 15 MB cap

Downloads go to "<file>.part" and are renamed atomically; leftovers are deleted at start and
existing files are never reused (skip_existing is off), so a crashed run cannot leave a
truncated clip that a later run would pick up.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[2]
OPENMONTAGE_DIR = PROJECT_ROOT / "vendor" / "openmontage"
OPENMONTAGE_TOOL = OPENMONTAGE_DIR / "tools" / "video" / "direct_clip_search.py"

EXIT_OK, EXIT_NO_CLIPS, EXIT_BAD_INPUT, EXIT_NO_VENDOR = 0, 1, 2, 3

KEYLESS_SOURCES = ("nasa", "wikimedia")
KEYED_SOURCES = {"pexels": "PEXELS_API_KEY", "pixabay_video": "PIXABAY_API_KEY"}
# Keyed stock libraries first (best general-purpose footage), then Commons, then NASA.
SOURCE_ORDER = ("pexels", "pixabay_video", "wikimedia", "nasa")
DEFAULT_CLIPS_PER_QUERY = 2
DEFAULT_MIN_WIDTH = 640
DEFAULT_TIMEOUT_PER_QUERY = 180.0
DEFAULT_MAX_DURATION = 60.0
MAX_DOWNLOAD_BYTES = 150 * 1024 * 1024
MAX_SOURCE_WIDTH = 1920
RELEVANCE_CHECKED_SOURCES = ("wikimedia", "nasa")
VALID_KINDS = ("video", "image")
IMAGE_SOURCES = ("pexels", "wikimedia", "nasa")
MAX_IMAGE_BYTES = 15 * 1024 * 1024
MIN_IMAGE_LONG_SIDE = 1080
MAX_IMAGE_ASPECT = 2.5  # long/short; wider panoramas cannot fill a 9:16 frame
COMMONS_IMAGE_BOX = (
    3840  # standard Commons thumbnail width; 1920 forces ~1.3x upscaling when cropping landscape to 9:16
)
_THUMB_WIDTH_RE = re.compile(r"/(\d+)px-[^/]*$")
COMMONS_IMAGE_MIMES = frozenset({"image/jpeg", "image/png", "image/tiff"})
IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png")
# Text-heavy or symbolic graphics animate badly and often carry trademark/heraldry issues.
TEXT_HEAVY_ANYWHERE = re.compile(
    r"\b(maps?|diagrams?|charts?|logos?|logotypes?|coats? of arms|infographics?|schematics?|graphs?)\b",
    re.IGNORECASE,
)
TEXT_HEAVY_IN_TITLE = re.compile(r"\b(flags?|heraldry|emblems?|seals?|banners?|signatures?|\.svg)\b", re.IGNORECASE)
COPYRIGHT_MARKERS = re.compile(r"©|\(c\)|copyright|all rights reserved", re.IGNORECASE)
# Synthetic media would need a YouTube "altered content" disclosure; skip it entirely.
AI_GENERATED_MARKERS = re.compile(
    r"ai[- _]generated|generated (by|with|using) (an )?ai|artificial intelligence|dream[ _]machine|"
    r"\bsora\b|runway gen|midjourney|stable diffusion|text[- ]to[- ]video|\bveo ?\d",
    re.IGNORECASE,
)

log = logging.getLogger("fetch_footage")


class InputError(ValueError):
    """The stdin request is malformed."""


class VendorMissingError(RuntimeError):
    """vendor/openmontage is not checked out."""


class DownloadTooLargeError(RuntimeError):
    """A streamed download announced a size above MAX_DOWNLOAD_BYTES."""


# ---------------------------------------------------------------------------
# Request parsing
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SceneQuery:
    scene_index: int
    query: str
    kinds: tuple[str, ...] = ("video",)


@dataclass(frozen=True)
class FetchRequest:
    output_dir: Path
    queries: list[SceneQuery]
    clips_per_query: int
    min_duration: float | None
    max_duration: float | None
    sources: list[str] | None
    min_width: int
    timeout_per_query: float
    deadline_seconds: float | None = None


def parse_request(raw: str) -> FetchRequest:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise InputError(f"stdin is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise InputError("stdin must be a JSON object")
    output_dir = data.get("outputDir")
    if not isinstance(output_dir, str) or not output_dir.strip():
        raise InputError("'outputDir' must be a non-empty string")
    return FetchRequest(
        output_dir=Path(output_dir).expanduser().resolve(),
        queries=_parse_queries(data.get("queries"), _parse_kinds(data.get("kinds"), "kinds", ("video",))),
        clips_per_query=_positive_int(data.get("clipsPerQuery"), "clipsPerQuery", DEFAULT_CLIPS_PER_QUERY, 20),
        min_duration=_optional_number(data.get("minDurationSeconds"), "minDurationSeconds"),
        max_duration=_optional_number(data.get("maxDurationSeconds"), "maxDurationSeconds") or DEFAULT_MAX_DURATION,
        sources=_optional_str_list(data.get("sources"), "sources"),
        min_width=_positive_int(data.get("minWidth"), "minWidth", DEFAULT_MIN_WIDTH, 8000),
        timeout_per_query=_optional_number(data.get("timeoutSecondsPerQuery"), "timeoutSecondsPerQuery")
        or DEFAULT_TIMEOUT_PER_QUERY,
        deadline_seconds=_optional_number(data.get("deadlineSeconds"), "deadlineSeconds"),
    )


def _parse_kinds(value: Any, name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    if value is None:
        return default
    items = [value] if isinstance(value, str) else value
    if not isinstance(items, list) or not items or not all(k in VALID_KINDS for k in items):
        raise InputError(f"'{name}' must be one of / a non-empty array of {list(VALID_KINDS)}")
    return tuple(k for k in VALID_KINDS if k in items)


def _parse_queries(value: Any, default_kinds: tuple[str, ...]) -> list[SceneQuery]:
    if not isinstance(value, list) or not value:
        raise InputError("'queries' must be a non-empty array")
    queries: list[SceneQuery] = []
    for i, item in enumerate(value):
        if not isinstance(item, dict):
            raise InputError(f"queries[{i}] must be an object")
        scene_index, query = item.get("sceneIndex"), item.get("query")
        if not isinstance(scene_index, int) or isinstance(scene_index, bool):
            raise InputError(f"queries[{i}].sceneIndex must be an integer")
        if not isinstance(query, str) or not query.strip():
            raise InputError(f"queries[{i}].query must be a non-empty string")
        kinds = _parse_kinds(item.get("kind"), f"queries[{i}].kind", default_kinds)
        queries.append(SceneQuery(scene_index, " ".join(query.split()), kinds))
    return queries


def _positive_int(value: Any, name: str, default: int, maximum: int) -> int:
    if value is None:
        return default
    if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= maximum:
        raise InputError(f"'{name}' must be an integer between 1 and {maximum}")
    return value


def _optional_number(value: Any, name: str) -> float | None:
    if value is None:
        return None
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value < 0:
        raise InputError(f"'{name}' must be a non-negative number or null")
    return float(value)


def _optional_str_list(value: Any, name: str) -> list[str] | None:
    if value is None:
        return None
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise InputError(f"'{name}' must be an array of strings or null")
    return [v.strip() for v in value if v.strip()]


# ---------------------------------------------------------------------------
# Secret redaction (pixabay puts its key in the query string; requests errors echo the URL)
# ---------------------------------------------------------------------------

_SECRET_PARAM_RE = re.compile(r"([?&](?:key|api_key|apikey|token|access_token)=)[^&\s\"']+", re.IGNORECASE)
SECRET_ENV_VARS = ("PEXELS_API_KEY", "PIXABAY_API_KEY")


def redact(text: str) -> str:
    """Mask key=/token= URL parameters and the literal values of the footage API keys."""
    text = _SECRET_PARAM_RE.sub(r"\1[REDACTED]", text)
    for var in SECRET_ENV_VARS:
        secret = os.environ.get(var) or ""
        if len(secret) >= 4:
            text = text.replace(secret, "[REDACTED]")
    return text


class RedactingStream:
    """Text stream wrapper that redacts everything written through it (used for stderr)."""

    def __init__(self, stream: Any) -> None:
        self._stream = stream

    def write(self, text: str) -> int:
        return self._stream.write(redact(text))

    def flush(self) -> None:
        self._stream.flush()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._stream, name)


# ---------------------------------------------------------------------------
# Error collection
# ---------------------------------------------------------------------------


@dataclass
class ErrorLog:
    entries: list[dict[str, Any]] = field(default_factory=list)

    def add(
        self,
        phase: str,
        message: str,
        *,
        scene: SceneQuery | None = None,
        query: str | None = None,
        source: str | None = None,
    ) -> None:
        entry = {
            "sceneIndex": scene.scene_index if scene else None,
            "query": query if query is not None else (scene.query if scene else None),
            "source": source,
            "phase": phase,
            "message": redact(message),
        }
        self.entries.append(entry)
        log.warning("[%s] scene=%s source=%s: %s", phase, entry["sceneIndex"], source, message)


# ---------------------------------------------------------------------------
# Source allowlist + license gate
# ---------------------------------------------------------------------------


def load_footage_keys_from_dotenv(env_file: Path) -> None:
    """Fill PEXELS/PIXABAY keys from the project .env when the caller did not pass them."""
    if not env_file.is_file():
        return
    for line in env_file.read_text(encoding="utf-8", errors="ignore").splitlines():
        key, sep, value = line.strip().partition("=")
        key = key.strip()
        if sep and key in KEYED_SOURCES.values() and not os.environ.get(key):
            value = value.split(" #", 1)[0].strip().strip("'\"")
            if value:
                os.environ[key] = value


def allowed_sources() -> list[str]:
    enabled = set(KEYLESS_SOURCES)
    enabled.update(name for name, env in KEYED_SOURCES.items() if os.environ.get(env))
    return [name for name in SOURCE_ORDER if name in enabled]


def resolve_sources(requested: list[str] | None, errors: ErrorLog) -> list[str]:
    allowed = allowed_sources()
    if requested is None:
        return allowed
    resolved: list[str] = []
    for name in requested:
        if name in allowed:
            resolved.append(name)
        elif name in KEYED_SOURCES:
            errors.add("sources", f"'{name}' skipped: {KEYED_SOURCES[name]} is not set", source=name)
        else:
            errors.add("sources", f"'{name}' is not on the commercial-license allowlist", source=name)
    return [name for name in SOURCE_ORDER if name in resolved]


_LICENSE_NORMALISATION = (
    (re.compile(r"creative\s*commons\s*attribution"), "cc by"),
    (re.compile(r"share\s*alike"), "sa"),
    (re.compile(r"non\s*commercial"), "nc"),
    (re.compile(r"no\s*deriv\w*"), "nd"),
    (re.compile(r"[\s_\-,/]+"), " "),
)
# Commons PD templates are only accepted with a known qualifier (PD-USGov-*, PD-old-70, PD-Art...);
# "pd <anything>" is not blindly trusted.
_PUBLIC_DOMAIN_RE = re.compile(
    r"public domain( mark)?( \d\.\d)?|pd|pd (usgov|us|old|art|scan|self|author|ineligible|gov|1923|1996)"
    r"( [a-z0-9.]+){0,4}|cc0( \d\.\d)?( universal)?|cc zero"
)
_PD_DENY_TOKENS = frozenset({"copyrighted", "copyright", "nonfree", "fair", "restricted", "trademarked", "because"})
_CC_BY_RE = re.compile(
    r"cc by(?: (?P<version>\d(?:\.\d)?))?(?: (?P<port>international|unported|generic|[a-z]{2,3}))?(?: licen[cs]e)?"
)
NASA_TERMS_URL = "https://www.nasa.gov/nasa-brand-center/images-and-media/"
STOCK_LICENSE_URLS = {
    "pexels": "https://www.pexels.com/license/",
    "pixabay_video": "https://pixabay.com/service/license-summary/",
    "nasa": NASA_TERMS_URL,
}


def _normalise_license(license_name: str) -> str:
    text = license_name.lower().strip()
    for pattern, replacement in _LICENSE_NORMALISATION:
        text = pattern.sub(replacement, text)
    return text.strip()


def is_wikimedia_license_allowed(license_name: str) -> bool:
    """Public domain, CC0 and CC BY (any version/port) only. Everything else is rejected."""
    text = _normalise_license(license_name)
    tokens = set(text.split())
    if not text or {"sa", "nc", "nd"} & tokens or _PD_DENY_TOKENS & tokens:
        return False
    return bool(_PUBLIC_DOMAIN_RE.fullmatch(text) or _CC_BY_RE.fullmatch(text))


def license_url_for(source: str, license_name: str) -> str | None:
    """Canonical terms URL for an accepted license string (CC deeds match version and port)."""
    if source in STOCK_LICENSE_URLS:
        return STOCK_LICENSE_URLS[source]
    text = _normalise_license(license_name)
    if text.startswith(("cc0", "cc zero")):
        return "https://creativecommons.org/publicdomain/zero/1.0/"
    if text.startswith("public domain mark"):
        return "https://creativecommons.org/publicdomain/mark/1.0/"
    match = _CC_BY_RE.fullmatch(text)
    if not match or not match.group("version"):
        return None
    version = match.group("version") if "." in match.group("version") else f"{match.group('version')}.0"
    port = match.group("port") or ""
    port_path = f"{port}/" if len(port) <= 3 and port and version != "4.0" else ""
    return f"https://creativecommons.org/licenses/by/{version}/{port_path}"


def license_rejection(source: str, license_name: str, provenance_text: str) -> str | None:
    """Return why a candidate is not commercially reusable, or None if it is."""
    if source in KEYED_SOURCES:
        return None
    if source == "nasa":
        return nasa_provenance_rejection(provenance_text)
    if source == "wikimedia":
        if is_wikimedia_license_allowed(license_name):
            return None
        return f"Wikimedia license not PD/CC0/CC BY: {license_name!r}"
    return f"source '{source}' is not on the allowlist"


# --- NASA provenance (H4): images.nasa.gov also hosts SpaceX (CC BY-NC), ESA (CC BY), wire photos --

NASA_COPYRIGHT_BOILERPLATE = re.compile(
    r"for copyright and restrictions,?\s*(?:refer|see)\s*(?:to)?\s*[:-]?\s*\S*", re.IGNORECASE
)
_FULL_AGENCY_NAME_RE = re.compile(r"national aeronautics (?:and|&) space administration", re.IGNORECASE)
_HTML_TAG_RE = re.compile(r"<[^>]+>")
_BARE_URL_RE = re.compile(r"https?://\S+", re.IGNORECASE)
# Empty or purely technical values (XMP/EXIF "Source" often names the capture medium, not a party).
_EMPTY_CREDIT_VALUES = frozenset(
    {"", "none", "null", "n/a", "na", "-", "digital moving image", "digital camera", "digital still camera"}
)
# Role labels in video credit blocks ("NASA Producers: ...", "Music: ..."): neutral on their own,
# NASA-attributed when prefixed with NASA.
_ROLE_ONLY_RE = re.compile(
    r"((lead|senior|executive|associate|science|video|technical) )?(producers?|editors?|videographers?|animators?|"
    r"visuali[sz]ers?|writers?|narrators?|directors?|photographers?|camera( operators?)?|crew|staff|scientists?|"
    r"engineers?|technicians?|graphics?|music|interviewees?|support|production)"
)
_CREDIT_MARKER_RE = re.compile(
    r"\b(?:credits?\s*:|(?:music|soundtrack|song|images?|photos?|photographs?|videos?|footage|animations?|"
    r"graphics?|illustrations?)\s*:|courtesy(?:\s+of)?\b|(?:image|photo|photograph|video|footage|"
    r"animation|illustration|artwork|visualization|rendering|processing|processed|enhanced|music)\s+by\b)\s*:?",
    re.IGNORECASE,
)
_CREDIT_END_RE = re.compile(r"[\n;]|(?<=[A-Za-z]{2})\.(?:\s+(?=[A-Z][a-z])|\s*$)")
_ENTITY_SPLIT_RE = re.compile(r"\s*(?:/|,|&|\+|;|:|\band\b|\bor\b|\bwith\b)\s*", re.IGNORECASE)
_PERSON_RE = re.compile(r"(?:[A-Z]\.?\s+|[A-Z]\.)+[A-Z][\w'-]+|[A-Z][\w'-]+(?:\s+(?:[A-Z]\.?\s+)?[A-Z][\w'-]+){1,3}")
_ORG_WORDS = frozenset(
    {
        "images",
        "image",
        "photo",
        "photos",
        "pictures",
        "press",
        "news",
        "agency",
        "inc",
        "llc",
        "ltd",
        "corp",
        "corporation",
        "company",
        "co",
        "group",
        "systems",
        "space",
        "aerospace",
        "media",
        "studio",
        "studios",
        "foundation",
        "university",
        "institute",
        "observatory",
        "laboratory",
        "lab",
        "center",
        "centre",
        "society",
        "museum",
        "archive",
        "archives",
        "library",
        "getty",
        "reuters",
        "associated",
        "alamy",
        "shutterstock",
        "spacex",
        "esa",
        "jaxa",
        "roscosmos",
        "boeing",
        "lockheed",
        "northrop",
        "blue",
        "origin",
        "rocket",
        "virgin",
        "galactic",
        "ula",
        "airbus",
        "telescope",
        "hubble",
        "webb",
        "team",
        "mission",
        "public",
        "domain",
        "technologies",
        "technology",
        "machines",
        "labs",
        "alliance",
        "launch",
        "photography",
        "maxar",
        "planet",
        "intuitive",
        "astrobotic",
        "firefly",
        "relativity",
        "axiom",
        "sierra",
        "dynetics",
        "raytheon",
        "industries",
        "international",
        "solutions",
        "ventures",
        "robotics",
        "satellites",
        "satellite",
        "imaging",
        "films",
        "productions",
        "gmbh",
        "plc",
    }
)
# NASA (and NASA-contract) staff photographers whose bare name in NASA's own catalogue fields may be
# trusted without an in-text "NASA/<name>" credit. Normalised: lower case, no dots, single spaces.
NASA_STAFF_PHOTOGRAPHERS = frozenset({
    "bill ingalls", "joel kowsky", "aubrey gemignani", "keegan barber", "connie moore", "carla cioffi",
    "kim shiflett", "frank michaux", "glenn benson", "ben smegelsky", "cory huston", "cory s huston",
    "isaac watson", "kevin o'connell", "kevin davidson", "john kraus", "chris coleman", "jamie peer",
    "randy beaudoin", "steven seipel", "charles babir", "robert markowitz", "josh valcarcel", "james blair",
    "bill stafford", "norah moran", "lauren harnett", "helen arase vargas", "emmett given", "fred deaton",
    "danny nowlin", "sam lott", "charles beason", "carla thomas", "lauren hughes", "jim ross", "ken ulbrich",
    "steve freeman", "genaro vavuris", "marvin smith", "bridget caswell", "jef janis", "quentin schwinn",
    "jordan cochran", "sara lowthian hanna", "david c bowman", "mark knopp", "ryan hill", "michael democker",
    "eric bordelon", "jude guidry", "allison stancil", "terry zaperach", "brea reeves", "patrick black",
    "chris gunn", "taylor mickal", "rebecca roth", "bill hrybyk", "desiree stover", "pat izzo",
})  # fmt: skip
# Independent photographers and citizen image processors whose work is copyrighted / CC BY(-NC) even
# when it is hosted by NASA or credited as "NASA/.../<name>".
INDEPENDENT_CREATORS = frozenset({
    "ben cooper", "kevin m gill", "kevin gill", "sean doran", "seán doran", "gerald eichstädt",
    "gerald eichstaedt", "björn jónsson", "bjorn jonsson", "thomas thomopoulos", "justin cowart", "jason major",
    "andrea luck", "roman tkachenko", "mattias malmer", "ian regan", "brady kenniston", "trevor mahlmann",
    "john pisani", "emily lakdawalla",
})  # fmt: skip
# Normalised (lower-case, hyphens as spaces, leading "NASA"/"NASA's" removed) entity names that may
# appear in a NASA credit line. Everything else, including unknown names, rejects the item.
NASA_ALLOWED_ENTITIES = frozenset({
    "", "public domain", "naca", "hq", "headquarters", "jpl", "jpl caltech", "caltech", "jet propulsion laboratory",
    "gsfc", "goddard", "goddard space flight center", "svs", "scientific visualization studio", "goddard svs",
    "gsfc svs", "conceptual image lab", "jsc", "johnson", "johnson space center", "ksc", "kennedy",
    "kennedy space center", "msfc", "marshall", "marshall space flight center", "arc", "ames", "ames research center",
    "grc", "glenn", "glenn research center", "larc", "langley", "langley research center", "afrc", "armstrong",
    "armstrong flight research center", "dryden", "dfrc", "dryden flight research center", "ssc", "stennis",
    "stennis space center", "wff", "wallops", "wallops flight facility", "wstf", "white sands test facility", "maf",
    "michoud", "michoud assembly facility", "earth observatory", "iss", "iss crew", "iss crew earth observations",
    # US-government co-authors (public domain) and NASA mission contractors whose mission imagery NASA
    # releases without restriction:
    "usgs", "noaa", "space science institute", "ssi", "msss", "malin space science systems", "swri",
    "southwest research institute", "jhuapl", "jhu apl", "johns hopkins apl", "apl",
    "johns hopkins university applied physics laboratory",
})  # fmt: skip
_NASA_ENTITY_PATTERNS = re.compile(r"(expedition|sts|apollo|gemini|skylab|artemis) \d+( crew)?")
_GENERIC_SUFFIX_RE = re.compile(r" (image|images|photo|photos|video|graphic|illustration|animation)$")


def _normalise_entity(entity: str) -> str:
    text = entity.lower().replace("\u2019", "'")
    text = re.sub(r"[-_.]", " ", text)
    text = re.sub(r"\s+", " ", text).strip(" '\":")
    text = re.sub(r"^the ", "", text)
    text = re.sub(r"^nasa('s)?( |$)", "", text).strip()
    return _GENERIC_SUFFIX_RE.sub("", text)


def _credit_entities(credit: str) -> list[str]:
    flattened = re.sub(r"[()\[\]]", ",", _FULL_AGENCY_NAME_RE.sub("NASA", credit))
    entities = (e.strip(" .:-'\"") for e in _ENTITY_SPLIT_RE.split(flattened))
    return [e for e in entities if e.lower() not in _EMPTY_CREDIT_VALUES]


def _looks_like_person(entity: str) -> bool:
    return bool(_PERSON_RE.fullmatch(entity)) and not (_ORG_WORDS & set(entity.lower().replace(".", " ").split()))


def _person_key(name: str) -> str:
    return re.sub(r"\s+", " ", name.lower().replace(".", " ")).strip()


def _is_agency_entity(entity: str) -> bool:
    norm = _normalise_entity(entity)
    return norm in NASA_ALLOWED_ENTITIES or bool(_NASA_ENTITY_PATTERNS.fullmatch(norm))


def credit_rejection(credit: str) -> str | None:
    """A credit passes only if every party is NASA/an allowed partner, or a person credited together
    with one in the same line ("NASA/<name>" or "<name>/NASA"). Known independents never pass."""
    seen_agency = False
    people: list[str] = []
    for entity in _credit_entities(credit):
        norm = _normalise_entity(entity)
        if _is_agency_entity(entity):
            seen_agency = True
        elif _ROLE_ONLY_RE.fullmatch(norm):
            seen_agency = seen_agency or entity.lower().startswith("nasa")
        elif _looks_like_person(entity) and _person_key(entity) not in INDEPENDENT_CREATORS:
            people.append(entity)
        else:
            return f"credits non-NASA party {entity[:60]!r}"
    if people and not seen_agency:
        return f"credits {people[0][:60]!r} without NASA attribution"
    return None


def extract_credits(text: str) -> list[str]:
    credits: list[str] = []
    for match in _CREDIT_MARKER_RE.finditer(text):
        rest = text[match.end() : match.end() + 200]
        end = _CREDIT_END_RE.search(rest)
        credit = (rest[: end.start()] if end else rest).strip()
        if credit and _AGENCY_BEFORE_MARKER_RE.search(text[max(0, match.start() - 12) : match.start()]):
            credit = f"NASA/{credit}"  # "NASA photo by <name>", "NASA's image: <name>"
        if credit:
            credits.append(credit)
    return credits


_AGENCY_BEFORE_MARKER_RE = re.compile(r"\bNASA(?:'s)?\s*$", re.IGNORECASE)


def _clean_provenance_text(text: str) -> str:
    """Drop NASA's own usage boilerplate and bare URLs; HTML tags end a credit line (they wrap policy links)."""
    import html

    text = NASA_COPYRIGHT_BOILERPLATE.sub(" ", html.unescape(_HTML_TAG_RE.sub("\n", text)))
    return _BARE_URL_RE.sub("\n", text)


def nasa_provenance_rejection(text: str) -> str | None:
    """Reject on copyright text or any credit line naming a party outside the NASA allowlist."""
    cleaned = _clean_provenance_text(text)
    if COPYRIGHT_MARKERS.search(cleaned):
        return "NASA item mentions third-party copyright"
    for credit in extract_credits(cleaned):
        if reason := credit_rejection(credit):
            return reason
    return None


def _candidate_provenance(cand: Any) -> str:
    extra = getattr(cand, "extra", None) or {}
    if cand.source != "nasa":
        return " ".join(p for p in (cand.creator, cand.source_tags) if p)
    meta = extra.get("nasa_meta") or {}
    if not meta:  # adapter metadata only (source_tags is truncated to 500 chars)
        fields = [cand.creator, str(extra.get("secondary_creator") or "")]
        return " ".join([*(f"Credit: {f}." for f in fields if f), cand.source_tags])
    prose = [str(meta.get(k) or "") for k in ("title", "description", "description_508")]
    return "\n".join([*prose, *nasa_structured_credits(meta)])


_NASA_PAREN_CREDIT_RE = re.compile(r"\(\s*(NASA(?:'s)?\s*/[^()\n]{2,80})\)", re.IGNORECASE)
_NASA_PHOTO_BY_RE = re.compile(
    r"\bNASA(?:'s)?\s+(?:photo|image|video|footage)(?:graph)?s?\s+(?:taken\s+)?by\s+([^.;,\n()]{2,60})", re.IGNORECASE
)


def nasa_attributed_names(text: str) -> set[str]:
    """Person names the item's own text credits NASA-style: 'NASA/<name>', '<name>/NASA',
    '(NASA/<name>)', 'NASA photo by <name>' -- only from credit lines that pass as a whole."""
    cleaned = _clean_provenance_text(text)
    lines = [*extract_credits(cleaned), *_NASA_PAREN_CREDIT_RE.findall(cleaned)]
    lines += [f"NASA/{name.strip()}" for name in _NASA_PHOTO_BY_RE.findall(cleaned)]
    names: set[str] = set()
    for line in lines:
        entities = _credit_entities(line)
        if credit_rejection(line) is None and any(_is_agency_entity(e) for e in entities):
            names.update(_person_key(e) for e in entities if _looks_like_person(e) and not _is_agency_entity(e))
    return names


def nasa_structured_credit(value: str, attributed: set[str]) -> str:
    """Credit text to vet for a NASA catalogue/metadata credit value.

    Values that already name an agency ("NASA/Bill Ingalls", "ESA/A. Gerst") are vetted as written.
    A bare person name counts as NASA only when the item's own text credits it NASA-style or it is an
    enumerated NASA staff photographer; otherwise it stays bare and fails credit_rejection.
    """
    if any(_is_agency_entity(e) for e in _credit_entities(value)):
        return value
    key = _person_key(value)
    trusted = key in attributed or key in NASA_STAFF_PHOTOGRAPHERS
    if trusted and _looks_like_person(value) and key not in INDEPENDENT_CREATORS:
        return f"NASA/{value}"
    return value


def nasa_structured_credits(meta: dict[str, Any]) -> list[str]:
    """NASA's catalogue fields (center, photographer, secondary_creator) as credit lines."""
    prose = "\n".join(str(meta.get(k) or "") for k in ("title", "description", "description_508"))
    attributed = nasa_attributed_names(prose)
    center = str(meta.get("center") or "").strip()
    lines = [f"Credit: {center}." if center else ""]
    for key in ("photographer", "secondary_creator"):
        value = str(meta.get(key) or "").strip()
        if value.lower() not in _EMPTY_CREDIT_VALUES:
            lines.append(f"Credit: {nasa_structured_credit(value, attributed)}.")
    return [line for line in lines if line]


def capture_full_nasa_metadata() -> None:
    """Keep NASA's full (untruncated) search metadata on each candidate for the provenance gate."""
    from tools.video.stock_sources.nasa import NasaSource

    original = NasaSource._hydrate_candidate

    def hydrate(self: Any, item: dict, filters: Any) -> Any:
        cand = original(self, item, filters)
        if cand is not None:
            cand.extra["nasa_meta"] = dict((item.get("data") or [{}])[0])
        return cand

    NasaSource._hydrate_candidate = hydrate  # type: ignore[method-assign]


_META_CREDIT_KEY_RE = re.compile(
    r"^(?!ICC_Profile|File|Composite|System)\w+:(Artist|Copyright|CopyrightNotice|Credit|Rights|Creator|By-?line|"
    r"Photographer|SecondaryCreator|Source|Author)$"
)


def nasa_asset_metadata_rejection(
    manifest: list[str], timeout: float = 20, attributed: set[str] | None = None
) -> str | None:
    """Check the EXIF/IPTC/XMP/AVAIL credit fields of the asset's metadata.json; no metadata = reject.

    Bare person names get the same rule as the catalogue fields (see nasa_structured_credit).
    """
    attributed = attributed or set()
    import requests

    meta_url = next((u for u in manifest if u.lower().endswith("/metadata.json")), None)
    if not meta_url:
        return "no metadata.json to verify provenance"
    try:
        resp = requests.get(meta_url.replace("http://", "https://", 1), timeout=timeout)
        resp.raise_for_status()
        meta = resp.json()
    except (requests.RequestException, ValueError) as exc:
        return f"could not verify provenance ({type(exc).__name__})"
    for key, value in meta.items() if isinstance(meta, dict) else []:
        if not _META_CREDIT_KEY_RE.match(str(key)):
            continue
        for item in value if isinstance(value, list) else [value]:
            text = _clean_provenance_text(str(item if item is not None else "")).strip()
            if text.lower() in _EMPTY_CREDIT_VALUES:
                continue
            if COPYRIGHT_MARKERS.search(text):
                return f"{key} says {text[:60]!r}"
            if reason := credit_rejection(nasa_structured_credit(text, attributed)):
                return f"{key}: {reason}"
    return None


@dataclass
class GateConfig:
    """Everything the pre-download gate needs; shared across all searches in one run."""

    used_clip_ids: set[str]
    max_duration: float | None
    min_width: int
    max_bytes: int
    max_image_bytes: int
    ffprobe: str | None
    nasa_probe_budget: int
    deadline: float | None = None  # time.monotonic() value


def seconds_left(deadline: float | None) -> float | None:
    return None if deadline is None else deadline - time.monotonic()


def deadline_passed(deadline: float | None) -> bool:
    left = seconds_left(deadline)
    return left is not None and left <= 0


def _bounded(timeout: float, deadline: float | None) -> float:
    left = seconds_left(deadline)
    return timeout if left is None else max(1.0, min(timeout, left))


def install_candidate_gate(source_names: list[str], cfg: GateConfig) -> None:
    """Wrap each adapter's search() (gate) and download() (atomic .part + rename)."""
    from tools.video.stock_sources import all_sources

    for src in all_sources():
        if src.name in source_names:
            cls = type(src)
            cls.search = _gated_search(cls.search, cfg)  # type: ignore[method-assign]
            cls.download = _atomic_download(cls.download)  # type: ignore[method-assign]


PART_SUFFIX = ".part"


def _atomic_download(original: Callable[..., Any]) -> Callable[..., Any]:
    """Vendor adapters stream straight into the final path; route them through '<name>.part'."""

    def download(self: Any, candidate: Any, out_path: Any) -> Path:
        final = Path(out_path)
        partial = final.with_name(final.name + PART_SUFFIX)
        try:
            original(self, candidate, partial)
            os.replace(partial, final)
        except BaseException:
            with contextlib.suppress(OSError):
                partial.unlink()
            raise
        return final

    return download


def remove_stale_partials(clips_dir: Path) -> None:
    for leftover in clips_dir.glob(f"*{PART_SUFFIX}"):
        with contextlib.suppress(OSError):
            leftover.unlink()
            log.info("removed leftover partial download %s", leftover.name)


def _gated_search(original: Callable[..., list[Any]], cfg: GateConfig) -> Callable[..., list[Any]]:
    def search(self: Any, query: str, filters: Any) -> list[Any]:
        screened = [c for c in original(self, query, filters) if _screen(c, query, cfg) is None]
        return refine_renditions(screened, cfg)

    return search


def _screen(cand: Any, query: str, cfg: GateConfig) -> str | None:
    """Metadata-only checks. Returns the rejection reason (also logged) or None."""
    title = _candidate_title(cand)
    if reason := license_rejection(cand.source, cand.license or "", _candidate_provenance(cand)):
        reason = f"license: {reason}"
    elif AI_GENERATED_MARKERS.search(f"{title} {_candidate_provenance(cand)}"):
        reason = "synthetic media"
    elif cand.kind == "image" and (image_reason := image_metadata_rejection(cand)):
        reason = image_reason
    elif not is_relevant(cand, query):
        reason = "not relevant to query"
    elif cand.clip_id in cfg.used_clip_ids:
        reason = "already used by another scene"
    if reason:
        log.info("gate dropped %s (%s) %s", cand.clip_id, reason, title[:70])
    return reason


def image_metadata_rejection(cand: Any) -> str | None:
    title = _candidate_title(cand)
    if TEXT_HEAVY_IN_TITLE.search(title) or TEXT_HEAVY_ANYWHERE.search(f"{title} {cand.source_tags}"):
        return "text-heavy/symbolic graphic (map, diagram, logo, flag...)"
    mime = str((cand.extra or {}).get("mime") or "")
    if cand.source == "wikimedia" and mime not in COMMONS_IMAGE_MIMES:
        return f"unsupported image type {mime or 'unknown'}"
    if cand.width and cand.height:
        return image_shape_problem(cand.width, cand.height)
    return None


def image_shape_problem(width: int, height: int) -> str | None:
    long_side, short_side = max(width, height), max(1, min(width, height))
    if long_side < MIN_IMAGE_LONG_SIDE:
        return f"too small ({width}x{height})"
    if long_side / short_side > MAX_IMAGE_ASPECT:
        return f"aspect ratio {long_side / short_side:.1f}:1 too extreme ({width}x{height})"
    return None


def refine_renditions(cands: list[Any], cfg: GateConfig) -> list[Any]:
    """Point each candidate at a small-enough rendition and drop what cannot be made to fit."""
    commons_titles = [_candidate_title(c) for c in cands if c.source == "wikimedia"]
    images = bool(cands) and cands[0].kind == "image"
    commons_info = fetch_commons_imageinfo(commons_titles) if images else fetch_commons_videoinfo(commons_titles)
    kept: list[Any] = []
    nasa_probes = 0
    for cand in cands:
        if deadline_passed(cfg.deadline):
            log.info("deadline reached while vetting candidates; %d kept", len(kept))
            break
        info = commons_info.get(_candidate_title(cand))
        if cand.source == "wikimedia":
            reason = refine_wikimedia_image(cand, info, cfg) if images else refine_wikimedia(cand, info, cfg)
            reason = reason or apply_commons_attribution(cand, info)
            _remember_commons_license_url(cand.clip_id, info)
        elif cand.source == "nasa":
            if nasa_probes >= cfg.nasa_probe_budget:
                continue
            nasa_probes += 1
            manifest = _NASA_MANIFESTS.get(cand.download_url, [])
            meta = (cand.extra or {}).get("nasa_meta") or {}
            prose = "\n".join(str(meta.get(k) or "") for k in ("title", "description", "description_508"))
            reason = nasa_asset_metadata_rejection(manifest, _bounded(20, cfg.deadline), nasa_attributed_names(prose))
            if reason:
                reason = f"license: {reason}"
            else:
                reason = refine_nasa_image(cand, cfg) if images else refine_nasa(cand, cfg)
        else:
            reason = None
        reason = reason or _size_rejection(cand, cfg)
        if reason:
            log.info("rendition gate dropped %s (%s)", cand.clip_id, reason)
        else:
            _VETTED_CLIP_IDS.add(cand.clip_id)
            rendition = (cand.extra or {}).get("rendition", "default")
            log.info("candidate %s -> %s %dx%d %.1fs", cand.clip_id, rendition, cand.width, cand.height, cand.duration)
            kept.append(cand)
    return kept


def _size_rejection(cand: Any, cfg: GateConfig) -> str | None:
    extra = cand.extra or {}
    if cand.kind == "image":
        return None  # images are bounded by the chosen rendition, the 1080 px floor and 15 MB cap
    if cand.width > MAX_SOURCE_WIDTH and not extra.get("explicit_transcode"):
        return f"{cand.width}px wide exceeds {MAX_SOURCE_WIDTH}px"
    waived = extra.get("duration_cap_waived")
    if cfg.max_duration and cand.duration and cand.duration > cfg.max_duration and not waived:
        return f"{cand.duration:.0f}s exceeds {cfg.max_duration:.0f}s"
    return None


# --- Wikimedia Commons: prefer server-side transcodes over (often 4K) originals ----------------

_COMMONS_API = "https://commons.wikimedia.org/w/api.php"
_COMMONS_UA = "maquina-de-fazer-dinheiro/0.1 (footage adapter; OpenMontage-based)"
COMMONS_TRANSCODE_PREFERENCE = ("1080p.vp9.webm", "1080p.webm", "720p.vp9.webm", "720p.webm")


def fetch_commons_videoinfo(titles: list[str]) -> dict[str, dict[str, Any]]:
    """Map File: title -> videoinfo (size, width, height, derivatives). Empty dict on failure."""
    return _commons_file_info(
        titles, "videoinfo", {"viprop": "size|derivatives|extmetadata", "viextmetadatafilter": _COMMONS_EXTMETA}
    )


def fetch_commons_imageinfo(titles: list[str]) -> dict[str, dict[str, Any]]:
    """Map File: title -> imageinfo incl. a thumbnail URL scaled to fit COMMONS_IMAGE_BOX."""
    box = str(COMMONS_IMAGE_BOX)
    return _commons_file_info(
        titles,
        "imageinfo",
        {"iiprop": "url|size|mime|extmetadata", "iiextmetadatafilter": _COMMONS_EXTMETA, "iiurlwidth": box,
         "iiurlheight": box},
    )  # fmt: skip


_COMMONS_LICENSE_URLS: dict[str, str] = {}
_CREATOR_URLS: dict[str, str] = {}
# Clip ids that passed the full pre-download gate; anything else is refused after download.
_VETTED_CLIP_IDS: set[str] = set()
_COMMONS_EXTMETA = "LicenseUrl|Attribution|Artist|Credit"
_UNUSABLE_AUTHORS = frozenset({
    "unknown", "unknown author", "author unknown", "unknown photographer", "anonymous", "anon", "n/a", "none",
    "see below", "see source", "see description", "not provided", "various",
})  # fmt: skip
_URL_SITE_LABELS = {
    "youtube.com": "YouTube", "youtu.be": "YouTube", "flickr.com": "Flickr", "vimeo.com": "Vimeo",
    "commons.wikimedia.org": "Wikimedia Commons", "wikidata.org": "Wikidata", "instagram.com": "Instagram",
    "twitter.com": "X", "x.com": "X", "facebook.com": "Facebook",
}  # fmt: skip
_GENERIC_URL_SEGMENTS = frozenset(
    {"user", "users", "channel", "c", "people", "photos", "wiki", "watch", "video", "videos", "profile", "u", "w"}
)
_HREF_RE = re.compile(r"""href\s*=\s*["']([^"']+)["']""", re.IGNORECASE)


def _html_text_and_href(raw: str) -> tuple[str, str | None]:
    import html

    match = _HREF_RE.search(raw)
    href = html.unescape(match.group(1)).strip() if match else None
    if href and href.startswith("//"):
        href = "https:" + href
    text = re.sub(r"\s+", " ", html.unescape(_HTML_TAG_RE.sub(" ", raw))).strip()
    return text, _canonical_wiki_url(href) if href else None


def _canonical_wiki_url(url: str) -> str:
    """'…/w/index.php?title=User:X&action=edit&redlink=1' (a red link) -> '…/wiki/User:X'."""
    from urllib.parse import parse_qs, quote, urlparse

    parts = urlparse(url)
    title = (parse_qs(parts.query).get("title") or [""])[0]
    if parts.path.endswith("/index.php") and title:
        return f"{parts.scheme or 'https'}://{parts.netloc}/wiki/{quote(title.replace(' ', '_'), safe=':/')}"
    return url


def usable_author(name: str) -> bool:
    text = name.strip().strip(".")
    low = text.lower()
    return (
        bool(text)
        and not _BARE_URL_RE.fullmatch(text)
        and low not in _UNUSABLE_AUTHORS
        and not low.startswith("unknown")
    )


def name_from_url(url: str) -> str | None:
    """'https://www.youtube.com/user/Editor' -> 'Editor (YouTube)'; None when no name can be derived."""
    from urllib.parse import unquote, urlparse

    parts = urlparse(url if "://" in url else "https://" + url)
    host = parts.netloc.lower().removeprefix("www.").removeprefix("m.")
    label = next((v for k, v in _URL_SITE_LABELS.items() if host == k or host.endswith("." + k)), host)
    for segment in (unquote(s) for s in parts.path.split("/") if s):
        segment = segment.split(":", 1)[1] if segment.lower().startswith("user:") else segment
        segment = segment.lstrip("@").replace("_", " ").strip()
        if segment.lower() in _GENERIC_URL_SEGMENTS or re.fullmatch(r"UC[\w-]{22}|\d+|[\w-]{11}", segment):
            continue
        if re.search(r"[A-Za-z]", segment) and len(segment) <= 60:
            return f"{segment} ({label})" if label else segment
    return None


def commons_creator(info: dict[str, Any] | None, fallback: str = "") -> tuple[str, str | None]:
    """Author for attribution: Attribution -> Artist link text -> Credit -> adapter creator -> name from URL."""
    ext = (info or {}).get("extmetadata") or {}
    texts: list[str] = []
    urls: list[str] = []
    for key in ("Attribution", "Artist", "Credit"):
        text, href = _html_text_and_href(str((ext.get(key) or {}).get("value") or ""))
        texts.append(text)
        urls += [u for u in (href, text if _BARE_URL_RE.fullmatch(text) else None) if u]
    texts.append(fallback)
    if _BARE_URL_RE.fullmatch(fallback.strip()):
        urls.append(fallback.strip())
    first_url = urls[0] if urls else None
    for text in texts:
        if usable_author(text):
            return text, first_url
    for url in urls:
        if derived := name_from_url(url):
            return derived, url
    return "", first_url


def is_cc_by(license_name: str) -> bool:
    return bool(_CC_BY_RE.fullmatch(_normalise_license(license_name)))


def apply_commons_attribution(cand: Any, info: dict[str, Any] | None) -> str | None:
    """Set cand.creator (+ creatorUrl) from Commons metadata; CC BY without a usable author is rejected."""
    name, url = commons_creator(info, str(cand.creator or ""))
    cand.creator = name
    if url:
        _CREATOR_URLS[cand.clip_id] = url
    if not name and is_cc_by(cand.license or ""):
        return "license: CC BY item without a usable author to attribute"
    return None


def _remember_commons_license_url(clip_id: str, info: dict[str, Any] | None) -> None:
    raw = str((((info or {}).get("extmetadata") or {}).get("LicenseUrl") or {}).get("value") or "").strip()
    if raw.startswith("//"):
        raw = "https:" + raw
    if raw.startswith(("http://", "https://")):
        _COMMONS_LICENSE_URLS[clip_id] = raw


def _commons_file_info(titles: list[str], prop: str, extra: dict[str, str]) -> dict[str, dict[str, Any]]:
    import requests

    info: dict[str, dict[str, Any]] = {}
    for start in range(0, len(titles), 50):
        params = {"action": "query", "format": "json", "prop": prop, **extra,
                  "titles": "|".join(titles[start:start + 50])}  # fmt: skip
        try:
            resp = requests.get(_COMMONS_API, params=params, headers={"User-Agent": _COMMONS_UA}, timeout=30)
            resp.raise_for_status()
            pages = (resp.json().get("query") or {}).get("pages") or {}
        except (requests.RequestException, ValueError) as exc:
            log.warning("Commons %s lookup failed: %s", prop, exc)
            continue
        for page in pages.values():
            if page.get(prop):
                info[page.get("title", "")] = page[prop][0]
    return info


def pick_commons_transcode(derivatives: list[dict[str, Any]]) -> dict[str, Any] | None:
    by_key = {d.get("transcodekey"): d for d in derivatives if d.get("src")}
    for key in COMMONS_TRANSCODE_PREFERENCE:
        if key in by_key:
            return by_key[key]
    return None


def refine_wikimedia(cand: Any, videoinfo: dict[str, Any] | None, cfg: GateConfig) -> str | None:
    videoinfo = videoinfo or {}
    transcode = pick_commons_transcode(videoinfo.get("derivatives") or [])
    if transcode:
        cand.download_url = transcode["src"]
        cand.width = int(transcode.get("width") or cand.width)
        cand.height = int(transcode.get("height") or cand.height)
        cand.extra["explicit_transcode"] = True
        cand.extra["rendition"] = transcode.get("transcodekey")
        return None
    size = int(videoinfo.get("size") or 0)
    if size > cfg.max_bytes:
        return f"no 720p/1080p transcode and original is {size / 1e6:.0f} MB"
    cand.extra["rendition"] = "original"
    return None  # original within caps (width/duration checked by _size_rejection)


def refine_wikimedia_image(cand: Any, info: dict[str, Any] | None, cfg: GateConfig) -> str | None:
    """Download Commons' scaled thumbnail (fits COMMONS_IMAGE_BOX) instead of the often 50-100 MP original."""
    if not info or not info.get("thumburl"):
        return "Commons imageinfo/thumbnail lookup failed"
    url = str(info["thumburl"])
    orig_w, orig_h = int(info.get("width") or 0), int(info.get("height") or 0)
    if max(orig_w, orig_h) <= COMMONS_IMAGE_BOX:  # Commons never upscales: thumburl is the original
        width, height, rendition = orig_w, orig_h, "original"
        if int(info.get("size") or 0) > cfg.max_image_bytes:
            return f"original is {int(info['size']) / 1e6:.0f} MB"
    else:
        width, height = _served_thumb_size(url, orig_w, orig_h, info)
        rendition = f"thumb {width}px"
    if not _url_path(url).lower().endswith(IMAGE_EXTENSIONS):
        return f"thumbnail is not JPEG/PNG ({_url_path(url)[-20:]})"
    if problem := image_shape_problem(width, height):
        return problem
    cand.download_url, cand.width, cand.height = url, width, height
    cand.extra["explicit_transcode"] = True
    cand.extra["rendition"] = rendition
    return None


def _served_thumb_size(url: str, orig_w: int, orig_h: int, info: dict[str, Any]) -> tuple[int, int]:
    """Commons may round the requested width up to a standard size; the URL's NNNpx- prefix is the truth."""
    match = _THUMB_WIDTH_RE.search(_url_path(url))
    if match and orig_w:
        served_w = min(int(match.group(1)), orig_w)
        return served_w, round(orig_h * served_w / orig_w)
    return int(info.get("thumbwidth") or 0), int(info.get("thumbheight") or 0)


def _url_path(url: str) -> str:
    from urllib.parse import urlparse

    return urlparse(url).path


# --- NASA: smallest rendition that is still >= 720p --------------------------------------------

NASA_RENDITION_LADDER = ("medium", "large")  # by NASA convention: ~medium=720p, ~large=1080p
NASA_LONG_CLIP_MAX_BYTES = 40 * 1024 * 1024  # set to 0 to apply maxDurationSeconds strictly
_NASA_MANIFESTS: dict[str, list[str]] = {}
NASA_IMAGE_LADDER = ("large", "medium", "orig")  # ~large ~1920 px, ~medium ~1280 px, ~orig unbounded
_NASA_TAG_RE = re.compile(r"~(orig|large|medium|small|mobile|preview|thumb)\.(\w+)$", re.IGNORECASE)
_NASA_VIDEO_EXTS = ("mp4", "m4v")
_NASA_IMAGE_EXTS = ("jpg", "jpeg", "png")


def remember_nasa_manifests() -> None:
    """Make the adapter pick from our ladders and keep the manifest so refine_* can walk them."""
    from tools.video.stock_sources import nasa

    def remembering(original_pick: Callable[[list[str]], str], ladder: tuple[str, ...], exts: tuple[str, ...]):
        def pick(file_urls: list[str]) -> str:
            chosen = _nasa_rendition_urls(file_urls, ladder, exts)
            url = next(iter(chosen.values()), "") or original_pick(file_urls)
            _NASA_MANIFESTS[nasa._encode_url_path(url)] = list(file_urls)
            return url

        return pick

    nasa._pick_video_url = remembering(nasa._pick_video_url, NASA_RENDITION_LADDER, _NASA_VIDEO_EXTS)
    nasa._pick_image_url = remembering(nasa._pick_image_url, NASA_IMAGE_LADDER, _NASA_IMAGE_EXTS)


def _nasa_rendition_urls(file_urls: list[str], ladder: tuple[str, ...], exts: tuple[str, ...]) -> dict[str, str]:
    """Ladder tag -> URL for the renditions present in a manifest, in ladder order."""
    found: dict[str, str] = {}
    for url in file_urls:
        match = _NASA_TAG_RE.search(url)
        if match and match.group(1).lower() in ladder and match.group(2).lower() in exts:
            found.setdefault(match.group(1).lower(), url)
    return {tag: found[tag] for tag in ladder if tag in found}


def refine_nasa(cand: Any, cfg: GateConfig) -> str | None:
    from tools.video.stock_sources import nasa

    manifest = _NASA_MANIFESTS.get(cand.download_url, [])
    ladder = _nasa_rendition_urls(manifest, NASA_RENDITION_LADDER, _NASA_VIDEO_EXTS)
    if not ladder:
        return "no ~medium/~large mp4 rendition"
    if not cfg.ffprobe:
        cand.download_url = nasa._encode_url_path(next(iter(ladder.values())))
        return None  # cannot measure before download; streaming size cap still applies
    best: tuple[str, ProbeResult] | None = None
    for tag, url in ladder.items():
        probe = probe_media(cfg.ffprobe, nasa._encode_url_path(url), timeout=_bounded(25, cfg.deadline))
        if probe is None or probe.width > MAX_SOURCE_WIDTH:
            continue
        if best is None or probe.width > best[1].width:
            best = (tag, probe)
        if min(probe.width, probe.height) >= 720:
            break
    if best is None:
        return "could not probe any ~medium/~large rendition"
    tag, probe = best
    if probe.width < cfg.min_width:
        return f"best rendition only {probe.width}x{probe.height}"
    url = nasa._encode_url_path(ladder[tag])
    if cfg.max_duration and probe.duration > cfg.max_duration:
        # Nearly every NASA video is 1.5-15 min, so a pure duration cap would exclude NASA entirely.
        # Stage 03 trims to <=20 s anyway; what matters is the download weight, so accept long
        # clips only when the chosen file is small.
        size = remote_content_length(url)
        if not size or size > NASA_LONG_CLIP_MAX_BYTES:
            return f"{probe.duration:.0f}s > {cfg.max_duration:.0f}s and file is {size / 1e6:.0f} MB"
        cand.extra["duration_cap_waived"] = True
    cand.download_url = url
    cand.width, cand.height, cand.duration = probe.width, probe.height, probe.duration
    cand.extra["rendition"] = tag
    return None


def refine_nasa_image(cand: Any, cfg: GateConfig) -> str | None:
    """First of ~large/~medium/~orig whose long side is >= 1080 px (orig only if <= 15 MB)."""
    from tools.video.stock_sources import nasa

    manifest = _NASA_MANIFESTS.get(cand.download_url, [])
    ladder = _nasa_rendition_urls(manifest, NASA_IMAGE_LADDER, _NASA_IMAGE_EXTS)
    if not ladder:
        return "no ~large/~medium/~orig JPEG/PNG rendition"
    for tag, raw_url in ladder.items():
        url = nasa._encode_url_path(raw_url)
        if tag == "orig" and not 0 < remote_content_length(url) <= cfg.max_image_bytes:
            continue
        if not cfg.ffprobe:
            cand.download_url, cand.extra["rendition"] = url, tag
            return None  # dimensions are measured after download
        probe = probe_media(cfg.ffprobe, url, timeout=_bounded(25, cfg.deadline), still=True)
        if probe and image_shape_problem(probe.width, probe.height) is None:
            cand.download_url, cand.width, cand.height = url, probe.width, probe.height
            cand.extra["rendition"] = tag
            return None
    return f"no rendition with long side >= {MIN_IMAGE_LONG_SIDE}px within {cfg.max_image_bytes / 1e6:.0f} MB"


def remote_content_length(url: str) -> int:
    import requests

    try:
        resp = requests.head(url, allow_redirects=True, timeout=20)
        return int(resp.headers.get("Content-Length") or 0) if resp.ok else 0
    except (requests.RequestException, ValueError):
        return 0


# --- Hard download size cap ---------------------------------------------------------------------


_DOWNLOAD_CAP = {"bytes": MAX_DOWNLOAD_BYTES}


def set_download_cap(max_bytes: int) -> None:
    """Change the active per-file cap (searches run sequentially, one kind at a time)."""
    _DOWNLOAD_CAP["bytes"] = max_bytes


def cap_download_size(max_bytes: int) -> None:
    """Abort streamed downloads above the active cap, by Content-Length up front and by counting bytes.

    Process-wide patch of requests.get; DirectClipSearch wraps requests.get per call, so it sees
    this wrapper. The adapter's partial file is deleted afterwards (see run_direct_clip_search).
    """
    import requests

    set_download_cap(max_bytes)
    original_get = requests.get

    def get(*args: Any, **kwargs: Any) -> Any:
        response = original_get(*args, **kwargs)
        if not kwargs.get("stream"):
            return response
        max_bytes = _DOWNLOAD_CAP["bytes"]
        length = int(response.headers.get("Content-Length") or 0)
        if length > max_bytes:
            response.close()
            raise DownloadTooLargeError(f"Content-Length {length / 1e6:.0f} MB exceeds {max_bytes / 1e6:.0f} MB")
        response.iter_content = _counting_iter(response, response.iter_content, max_bytes)
        return response

    requests.get = get


def _counting_iter(response: Any, iter_content: Callable[..., Any], max_bytes: int) -> Callable[..., Any]:
    def counted(*args: Any, **kwargs: Any) -> Any:
        received = 0
        for chunk in iter_content(*args, **kwargs):
            received += len(chunk or b"")
            if received > max_bytes:
                response.close()
                raise DownloadTooLargeError(f"stream passed {max_bytes / 1e6:.0f} MB, aborted")
            yield chunk

    return counted


def _query_stems(query: str) -> list[str]:
    tokens = {t for t in re.findall(r"[a-z0-9]+", query.lower()) if len(t) >= 3}
    return sorted({t[: max(4, len(t) - 2)] for t in tokens})


def _candidate_title(cand: Any) -> str:
    extra = getattr(cand, "extra", None) or {}
    return str(extra.get("title") or cand.source_url or cand.clip_id)


def is_relevant(cand: Any, query: str) -> bool:
    """Archive search engines fall back to single loose tokens; require real query overlap.

    Queries of 1-2 words need one matching stem, longer queries need two (prefix stems so that
    'volcano' matches 'volcanic' and 'pyramids' matches 'pyramid').
    """
    if cand.source not in RELEVANCE_CHECKED_SOURCES:
        return True
    stems = _query_stems(query)
    if not stems:
        return True
    haystack = f"{_candidate_title(cand)} {cand.source_tags}".lower()
    required = 1 if len(stems) <= 2 else 2
    return sum(1 for stem in stems if stem in haystack) >= required


# ---------------------------------------------------------------------------
# Probing (Remotion ships ffprobe; there is no system ffmpeg)
# ---------------------------------------------------------------------------


def find_ffprobe() -> str | None:
    override = os.environ.get("FFPROBE_PATH")
    if override and Path(override).is_file():
        return override
    exe = "ffprobe.exe" if os.name == "nt" else "ffprobe"
    for candidate in sorted((PROJECT_ROOT / "node_modules" / "@remotion").glob(f"compositor-*/{exe}")):
        return str(candidate)
    return shutil.which("ffprobe")


@dataclass(frozen=True)
class ProbeResult:
    duration: float
    width: int
    height: int


def probe_media(ffprobe: str, target: str, *, timeout: float = 60, still: bool = False) -> ProbeResult | None:
    """Probe a local file or a remote http(s) URL (only headers are fetched for remote mp4)."""
    cmd = [ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams",
           "-select_streams", "v:0", target]  # fmt: skip
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))  # fmt: skip
    except (OSError, subprocess.TimeoutExpired) as exc:
        log.warning("ffprobe failed on %s: %s", target[-80:], exc)
        return None
    if proc.returncode != 0:
        return None
    return _parse_probe(proc.stdout, still)


def _parse_probe(stdout: str, still: bool = False) -> ProbeResult | None:
    try:
        info = json.loads(stdout or "{}")
    except json.JSONDecodeError:
        return None
    streams = info.get("streams") or []
    if not streams:
        return None
    stream = streams[0]
    width, height = int(stream.get("width") or 0), int(stream.get("height") or 0)
    if _rotation(stream) in (90, 270):
        width, height = height, width
    if still:
        return ProbeResult(0.0, width, height) if width > 0 and height > 0 else None
    duration = float((info.get("format") or {}).get("duration") or stream.get("duration") or 0.0)
    if width <= 0 or height <= 0 or duration <= 0:
        return None
    return ProbeResult(duration, width, height)


def _rotation(stream: dict[str, Any]) -> int:
    for side in stream.get("side_data_list") or []:
        if "rotation" in side:
            return abs(int(float(side["rotation"]))) % 360
    return abs(int(float((stream.get("tags") or {}).get("rotate", 0)))) % 360


# ---------------------------------------------------------------------------
# OpenMontage invocation
# ---------------------------------------------------------------------------


def ensure_openmontage_importable() -> None:
    if not OPENMONTAGE_TOOL.is_file():
        raise VendorMissingError(
            f"OpenMontage checkout not found at {OPENMONTAGE_DIR}. Run: "
            "powershell -ExecutionPolicy Bypass -File scripts/setup_vendor.ps1"
        )
    if str(OPENMONTAGE_DIR) not in sys.path:
        sys.path.insert(0, str(OPENMONTAGE_DIR))


def simplify_query(query: str) -> str | None:
    words = query.split()
    if len(words) > 2:
        return " ".join(words[:2])
    if len(words) == 2:
        return max(words, key=len)
    return None


def run_direct_clip_search(
    req: FetchRequest, query: str, sources: list[str], kind: str, deadline: float | None = None
) -> tuple[list[dict], list[dict], str]:
    """Return (clip records, tool errors, fatal error message or '')."""
    from tools.video.direct_clip_search import DirectClipSearch

    if kind == "image":  # size/duration rules for stills live in the gate (long side, 15 MB)
        filters: dict[str, Any] = {}
        set_download_cap(MAX_IMAGE_BYTES)
    else:
        filters = {"min_duration": req.min_duration, "max_duration": req.max_duration, "min_width": req.min_width}
        set_download_cap(MAX_DOWNLOAD_BYTES)
    inputs = {
        "output_dir": str(req.output_dir),
        "queries": [{"query": query, "slot_id": query, "kind": kind}],
        "sources": sources,
        "clips_per_query": req.clips_per_query,
        "filters": filters,
        "extract_thumbnails": False,
        # Never trust an existing file: it may be a leftover from an older, non-atomic run.
        "skip_existing": False,
        "timeout_seconds": _bounded(req.timeout_per_query, deadline),
    }
    result = DirectClipSearch().execute(inputs)
    data = result.data or {}
    tool_errors = list(data.get("errors") or [])
    failed_ids = {str(e["clip_id"]) for e in tool_errors if e.get("phase") == "download" and e.get("clip_id")}
    if data.get("timed_out") and data.get("clip_id"):
        failed_ids.add(str(data["clip_id"]))
    for clip_id in failed_ids:
        _remove_partial_download(req.output_dir / "clips", clip_id)
    return list(data.get("clips") or []), tool_errors, "" if result.success else str(result.error)


def _remove_partial_download(clips_dir: Path, clip_id: str) -> None:
    for partial in clips_dir.glob(f"{glob_escape(clip_id)}.*"):
        with contextlib.suppress(OSError):
            partial.unlink()
            log.info("removed partial download %s", partial.name)


def glob_escape(text: str) -> str:
    return re.sub(r"([\[\]*?])", r"[\1]", text)


# ---------------------------------------------------------------------------
# Per-scene orchestration
# ---------------------------------------------------------------------------


@dataclass
class FetchContext:
    req: FetchRequest
    sources: list[str]
    ffprobe: str | None
    errors: ErrorLog
    used_clip_ids: set[str]
    deadline: float | None = None


def sources_for_kind(sources: list[str], kind: str) -> list[str]:
    return [s for s in sources if s in IMAGE_SOURCES] if kind == "image" else list(sources)


def fetch_scene(ctx: FetchContext, scene: SceneQuery, kind: str) -> list[dict[str, Any]]:
    sources = sources_for_kind(ctx.sources, kind)
    if not sources:
        ctx.errors.add("sources", f"no allowlisted source provides {kind}s", scene=scene)
        return []
    clips = _fetch_and_validate(ctx, scene, scene.query, kind, sources)
    if clips:
        return clips
    fallback = simplify_query(scene.query)
    if fallback and fallback.lower() != scene.query.lower() and not deadline_passed(ctx.deadline):
        log.info("scene %d: no %ss for %r, retrying with %r", scene.scene_index, kind, scene.query, fallback)
        clips = _fetch_and_validate(ctx, scene, fallback, kind, sources)
    if not clips:
        ctx.errors.add("search", f"no usable {kind}s after retry", scene=scene)
    return clips


def _fetch_and_validate(
    ctx: FetchContext, scene: SceneQuery, query: str, kind: str, sources: list[str]
) -> list[dict[str, Any]]:
    log.info("scene %d: searching %s %r on %s", scene.scene_index, kind, query, ", ".join(sources))
    records, tool_errors, fatal = run_direct_clip_search(ctx.req, query, sources, kind, ctx.deadline)
    for err in tool_errors:
        ctx.errors.add(str(err.get("phase") or "openmontage"), str(err.get("error") or err),
                       scene=scene, query=query, source=err.get("source"))  # fmt: skip
    if fatal:
        ctx.errors.add("openmontage", fatal.strip().splitlines()[0], scene=scene, query=query)
    clips = [clip for rec in records if (clip := _to_footage_clip(ctx, scene, rec)) is not None]
    return clips if kind == "image" else _apply_min_duration(ctx, scene, clips)


def _to_footage_clip(ctx: FetchContext, scene: SceneQuery, rec: dict[str, Any]) -> dict[str, Any] | None:
    source, license_name = str(rec.get("source") or ""), str(rec.get("license") or "")
    creator = str(rec.get("creator") or "")
    # Provenance was vetted before download on the FULL metadata; this record only carries truncated
    # tags, so the re-check covers the source allowlist and license string, and refuses any item that
    # never received a pre-download verdict from the gate.
    reason = license_rejection(source, license_name, "")
    if not reason and str(rec.get("clip_id") or "") not in _VETTED_CLIP_IDS:
        reason = "no pre-download provenance verdict for this item"
    path = Path(str(rec.get("path") or "")).resolve()
    if reason or not path.is_file():
        ctx.errors.add(
            "license" if reason else "download", reason or f"file missing: {path}", scene=scene, source=source
        )
        if reason:
            with contextlib.suppress(OSError):
                path.unlink()
        return None
    kind = "image" if rec.get("kind") == "image" else "video"
    dims = _measure(ctx, path, rec, still=kind == "image")
    problem = _measured_problem(kind, dims)
    if problem:
        ctx.errors.add("probe", f"{problem}, discarded: {path.name}", scene=scene, source=source)
        with contextlib.suppress(OSError):
            path.unlink()
        return None
    assert dims is not None
    clip_id = str(rec.get("clip_id") or "")
    ctx.used_clip_ids.add(clip_id)
    clip: dict[str, Any] = {
        "sceneIndex": scene.scene_index,
        "path": str(path),
        "kind": kind,
        "durationSeconds": round(dims.duration, 3),
        "width": dims.width,
        "height": dims.height,
        "source": source,
        "sourceUrl": str(rec.get("source_url") or ""),
        "creator": _clean_creator(creator),
        "license": license_name,
    }
    license_url = license_url_for(source, license_name) or _COMMONS_LICENSE_URLS.get(clip_id)
    if license_url:
        clip["licenseUrl"] = license_url
    if creator_url := _CREATOR_URLS.get(clip_id):
        clip["creatorUrl"] = creator_url
    return clip


def _measure(ctx: FetchContext, path: Path, rec: dict[str, Any], *, still: bool) -> ProbeResult | None:
    if ctx.ffprobe:
        return probe_media(ctx.ffprobe, str(path), still=still)
    fallback = ProbeResult(float(rec.get("duration") or 0.0), int(rec.get("width") or 0), int(rec.get("height") or 0))
    return fallback if (still or fallback.duration > 0) and fallback.width > 0 else None


def _measured_problem(kind: str, dims: ProbeResult | None) -> str | None:
    if dims is None:
        return f"unreadable or empty {kind}"
    if kind == "image":
        return image_shape_problem(dims.width, dims.height)
    return None


def _clean_creator(creator: str) -> str:
    creator = " ".join(creator.split())
    return creator if len(creator) <= 200 else creator[:197] + "..."


def _apply_min_duration(ctx: FetchContext, scene: SceneQuery, clips: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Soft filter: prefer clips meeting the minimum, but keep the longest one rather than nothing."""
    minimum = ctx.req.min_duration
    if not minimum or not clips:
        return clips
    long_enough = [c for c in clips if c["durationSeconds"] >= minimum]
    if long_enough:
        return long_enough
    longest = max(clips, key=lambda c: c["durationSeconds"])
    ctx.errors.add("duration", f"no clip >= {minimum}s; kept longest ({longest['durationSeconds']}s)", scene=scene)
    return [longest]


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def fetch_all(req: FetchRequest, errors: ErrorLog, started: float | None = None) -> list[dict[str, Any]]:
    started = time.monotonic() if started is None else started
    deadline = started + req.deadline_seconds if req.deadline_seconds is not None else None
    sources = resolve_sources(req.sources, errors)
    if not sources:
        errors.add("sources", "no allowlisted sources left to query")
        return []
    ensure_openmontage_importable()
    ffprobe = find_ffprobe()
    if not ffprobe:
        log.warning("ffprobe not found; falling back to adapter metadata (NASA clips will be dropped)")
    ctx = FetchContext(req, sources, ffprobe, errors, used_clip_ids=set(), deadline=deadline)
    gate = GateConfig(ctx.used_clip_ids, req.max_duration, req.min_width, MAX_DOWNLOAD_BYTES, MAX_IMAGE_BYTES,
                      ffprobe, nasa_probe_budget=req.clips_per_query * 2, deadline=deadline)  # fmt: skip
    install_candidate_gate(sources, gate)
    capture_full_nasa_metadata()
    remember_nasa_manifests()
    cap_download_size(MAX_DOWNLOAD_BYTES)
    remove_stale_partials(req.output_dir / "clips")
    clips: list[dict[str, Any]] = []
    jobs = [(scene, kind) for scene in req.queries for kind in scene.kinds]
    for done, (scene, kind) in enumerate(jobs):
        if deadline_passed(deadline):
            skipped = len(jobs) - done
            errors.add("deadline", f"deadlineSeconds={req.deadline_seconds:g} reached; {skipped} search(es) skipped")
            return clips
        clips.extend(fetch_scene(ctx, scene, kind))
    if deadline_passed(deadline):  # it may also expire inside the last search (partial results)
        errors.add("deadline", f"deadlineSeconds={req.deadline_seconds:g} reached during the last search")
    return clips


def emit(stdout: Any, clips: list[dict[str, Any]], errors: ErrorLog) -> None:
    stdout.write(redact(json.dumps({"clips": clips, "errors": errors.entries}, ensure_ascii=True)))
    stdout.write("\n")
    stdout.flush()


def main() -> int:
    started = time.monotonic()
    sys.stderr = RedactingStream(sys.stderr)
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="[fetch_footage] %(levelname)s %(message)s")
    real_stdout = sys.stdout
    errors = ErrorLog()
    clips: list[dict[str, Any]] = []
    try:
        req = parse_request(sys.stdin.read())
        load_footage_keys_from_dotenv(PROJECT_ROOT / ".env")
        # Third-party code must never write to our stdout (it carries the JSON contract).
        with contextlib.redirect_stdout(sys.stderr):
            clips = fetch_all(req, errors, started)
    except InputError as exc:
        errors.add("input", str(exc))
        log.error("invalid input: %s", exc)
        emit(real_stdout, clips, errors)
        return EXIT_BAD_INPUT
    except VendorMissingError as exc:
        errors.add("setup", str(exc))
        log.error("%s", exc)
        emit(real_stdout, clips, errors)
        return EXIT_NO_VENDOR
    except Exception as exc:  # last-resort guard: the caller always gets one JSON object
        log.exception("unexpected failure")
        errors.add("internal", f"{type(exc).__name__}: {exc}")
        emit(real_stdout, clips, errors)
        return EXIT_NO_CLIPS
    emit(real_stdout, clips, errors)
    if not clips:
        log.error("zero usable clips across all %d queries (see 'errors' in stdout JSON)", len(req.queries))
        return EXIT_NO_CLIPS
    images = sum(1 for c in clips if c["kind"] == "image")
    log.info("done: %d videos + %d images for %d scenes", len(clips) - images, images,
             len({c["sceneIndex"] for c in clips}))  # fmt: skip
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
