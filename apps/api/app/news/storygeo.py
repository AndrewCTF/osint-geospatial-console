"""Deterministic, no-network location resolution for a news story (A8).

The operator wants stories to carry a REAL satellite chip of the actual place
they describe (a Red Sea tanker story gets a Red Sea chip, not a country
centroid). A country-centroid fallback is explicitly rejected: "Iran" resolves
to desert nowhere, which is worse than showing no imagery at all. So
``locate_story`` only returns a location when it can name a SPECIFIC place —
a named maritime chokepoint/sea/canal, or a named seaport — matched by a
whole-word, case-insensitive hit in the story's own title/summary text.

Precision order:
  1. Named chokepoint / strait / canal / sea (curated table; chokepoint
     coordinates are REUSED from ``app.routes.oceans._CHOKEPOINTS`` — this
     module does not duplicate them, only extends with the seas/canals that
     table doesn't carry).
  2. Named seaport, reusing the existing WPI dataset (``app.places.ports``).
  3. No confident match → ``None``. No country-centroid fallback, ever.
"""

from __future__ import annotations

import re
from typing import Any

from app import places
from app.routes.oceans import _CHOKEPOINTS

# Straits/canals/seas get a wide chip (they are large bodies of water; a
# single AOI can only cover part of one, but 20 km beats a tighter box that
# risks framing empty water). Named ports are compact and get a tight chip.
_RADIUS_SEA_KM = 20.0
_RADIUS_PORT_KM = 8.0

# Alternate phrasings for chokepoints already carried in oceans.py, mapped to
# that table's canonical name so we reuse its coordinates instead of
# duplicating them.
_CHOKEPOINT_ALIASES: dict[str, str] = {
    "suez canal": "Suez / Gulf of Suez",
    "gulf of suez": "Suez / Gulf of Suez",
    "bab el-mandeb": "Bab-el-Mandeb",
    "bab el mandeb": "Bab-el-Mandeb",
    "mandeb strait": "Bab-el-Mandeb",
}

# Named seas/canals/straits the oceans.py chokepoint table has no entry for
# at all (it only carries congestion-tracked straits). (name, lon, lat).
_EXTRA_SEAS: list[tuple[str, float, float]] = [
    ("Red Sea", 38.0, 20.0),
    ("Black Sea grain corridor", 31.0, 44.7),
    ("Kerch Strait", 36.55, 45.30),
]

_CHOKEPOINT_COORDS: dict[str, tuple[float, float]] = {
    name: (clon, clat) for (name, _a, _b, _c, _d, clon, clat) in _CHOKEPOINTS
}


def _named_water_bodies() -> list[tuple[str, str, float, float]]:
    """``(search_phrase, canonical_place_name, lon, lat)`` for every chokepoint
    (direct name + aliases) plus the extra seas/canals table. Built once per
    call (cheap: a couple dozen entries) so edits to the source tables are
    picked up without a cache to invalidate."""
    out: list[tuple[str, str, float, float]] = []
    for name, (lon, lat) in _CHOKEPOINT_COORDS.items():
        out.append((name, name, lon, lat))
    for alias, canonical in _CHOKEPOINT_ALIASES.items():
        coords = _CHOKEPOINT_COORDS.get(canonical)
        if coords is not None:
            out.append((alias, canonical, coords[0], coords[1]))
    for name, lon, lat in _EXTRA_SEAS:
        out.append((name, name, lon, lat))
    # Longest phrase first so a more specific alias ("gulf of suez") wins over
    # a shorter one before a generic substring could.
    out.sort(key=lambda t: len(t[0]), reverse=True)
    return out


def _contains_word(haystack_cf: str, needle: str) -> bool:
    """Whole-word, case-insensitive containment: ``needle`` must not be a
    substring of a larger word in ``haystack_cf`` (already casefolded)."""
    n = needle.casefold()
    if not n or n not in haystack_cf:
        return False
    return re.search(r"(?<![a-z0-9])" + re.escape(n) + r"(?![a-z0-9])", haystack_cf) is not None


def _story_text(story: dict) -> str:
    title = story.get("title") or ""
    summary = story.get("summary") or story.get("neutral_summary") or ""
    return f"{title} {summary}".casefold()


def locate_story(story: dict) -> dict[str, Any] | None:
    """Resolve one story to a real place, or ``None`` when no confident named
    location is found in its title/summary. Never a network call.

    Returns ``{lat, lon, radius_km, place, method}`` where ``method`` is
    ``"chokepoint"``, ``"sea"``, or ``"port"``.
    """
    if not isinstance(story, dict):
        return None
    text = _story_text(story)
    if not text.strip():
        return None

    for phrase, canonical, lon, lat in _named_water_bodies():
        if _contains_word(text, phrase):
            method = "chokepoint" if canonical in _CHOKEPOINT_COORDS else "sea"
            return {
                "lat": lat,
                "lon": lon,
                "radius_km": _RADIUS_SEA_KM,
                "place": canonical,
                "method": method,
            }

    # Named seaport (WPI dataset). Skip very short names — too many false
    # positives ("Nome", "Metu") against ordinary prose.
    for port in places.ports():
        name = str(port.get("name") or "")
        if len(name) < 5:
            continue
        if _contains_word(text, name):
            lat_v, lon_v = port.get("lat"), port.get("lon")
            if lat_v is None or lon_v is None:
                continue
            return {
                "lat": float(lat_v),
                "lon": float(lon_v),
                "radius_km": _RADIUS_PORT_KM,
                "place": name,
                "method": "port",
            }

    return None
