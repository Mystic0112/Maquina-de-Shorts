"""List the edge-tts voices as JSON (used by the dashboard's Configurações page).

Usage:
    python python/tts/list_voices.py

Prints exactly one JSON array to stdout:
    [{"name": "pt-BR-AntonioNeural", "locale": "pt-BR", "gender": "Male",
      "friendlyName": "...", "personalities": ["Friendly", ...]}, ...]
Errors go to stderr. Exit codes: 0 ok, 1 listing failed (e.g. no network).
"""

from __future__ import annotations

import asyncio
import json
import sys

import aiohttp
import edge_tts
from edge_tts.exceptions import EdgeTTSException


async def _list() -> list[dict[str, object]]:
    voices = await edge_tts.list_voices()
    out: list[dict[str, object]] = []
    for v in voices:
        tag = v.get("VoiceTag") or {}
        out.append(
            {
                "name": v.get("ShortName", ""),
                "locale": v.get("Locale", ""),
                "gender": v.get("Gender", ""),
                "friendlyName": v.get("FriendlyName", ""),
                "personalities": list(tag.get("VoicePersonalities") or []),
            }
        )
    return sorted(out, key=lambda x: (str(x["locale"]), str(x["name"])))


def main() -> int:
    try:
        voices = asyncio.run(_list())
    except (aiohttp.ClientError, EdgeTTSException, OSError, TimeoutError) as error:  # network/DNS/endpoint
        print(f"list_voices failed: {error}", file=sys.stderr)
        return 1
    sys.stdout.reconfigure(encoding="utf-8")
    json.dump(voices, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
