"""GET /api/route/* — operator navigation (Velocity Ops).

- /api/route/road    — fastest on-road route (public OSRM demo, keyless, online).
- /api/route/offroad — war-zone off-road path over a keyless DEM (A* slope cost).
- /api/route/fastest — on-road if reachable, else fall back to off-road.

Honesty: the on-road route is real OSRM. The off-road path is a trafficability
ESTIMATE over slope + water only (see app.intel.offroad). Public OSRM is
rate-limited + online-only; an offline/edge deploy points OSRM_URL at a
self-hosted regional extract.
"""

from __future__ import annotations

from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Query

from app.intel import offroad
from app.upstream import cache, get_client

router = APIRouter(tags=["route"])

# Public OSRM demo. Overridable for a self-hosted/offline extract.
_OSRM_BASE = "https://router.project-osrm.org"
_OSRM_TIMEOUT = httpx.Timeout(10.0, connect=4.0)


async def _osrm_route(
    from_lat: float, from_lon: float, to_lat: float, to_lon: float, profile: str
) -> dict[str, Any]:
    url = (
        f"{_OSRM_BASE}/route/v1/{profile}/"
        f"{from_lon},{from_lat};{to_lon},{to_lat}"
    )
    try:
        r = await get_client().get(
            url,
            params={"overview": "full", "geometries": "geojson", "steps": "true"},
            timeout=_OSRM_TIMEOUT,
            headers={"User-Agent": "Mozilla/5.0"},
        )
    except httpx.HTTPError as e:
        return {"reachable": False, "unavailable": True, "note": f"osrm transport: {e}"}
    if r.status_code != 200:
        return {"reachable": False, "unavailable": True, "note": f"osrm upstream {r.status_code}"}
    j = r.json()
    routes = j.get("routes") or []
    if not routes:
        return {"reachable": False, "note": "no route"}
    top = routes[0]
    steps = [
        {
            "name": s.get("name") or "",
            "distance_m": s.get("distance"),
            "maneuver": (s.get("maneuver") or {}).get("type"),
        }
        for leg in top.get("legs", [])
        for s in leg.get("steps", [])
    ]
    return {
        "reachable": True,
        "mode": "road",
        "profile": profile,
        "route": (top.get("geometry") or {}).get("coordinates") or [],
        "distance_km": round((top.get("distance") or 0) / 1000, 2),
        "duration_min": round((top.get("duration") or 0) / 60, 1),
        "steps": steps[:60],
        "source": "OSRM (project-osrm.org demo)",
    }


@router.get("/api/route/road")
async def route_road(
    from_lat: float = Query(...),
    from_lon: float = Query(...),
    to_lat: float = Query(...),
    to_lon: float = Query(...),
    mode: str = Query("driving", pattern="^(driving|walking|cycling)$"),
) -> dict[str, Any]:
    key = f"route:road:{mode}:{from_lat:.4f},{from_lon:.4f}:{to_lat:.4f},{to_lon:.4f}"
    return await cache.get_or_fetch(
        key, 300.0, lambda: _osrm_route(from_lat, from_lon, to_lat, to_lon, mode)
    )


@router.get("/api/route/offroad")
async def route_offroad(
    from_lat: float = Query(...),
    from_lon: float = Query(...),
    to_lat: float = Query(...),
    to_lon: float = Query(...),
) -> dict[str, Any]:
    key = f"route:offroad:{from_lat:.4f},{from_lon:.4f}:{to_lat:.4f},{to_lon:.4f}"

    async def load() -> dict[str, Any]:
        try:
            return {"mode": "offroad", **await offroad.plan_offroad(from_lat, from_lon, to_lat, to_lon)}
        except ValueError as e:
            raise HTTPException(400, str(e))

    return await cache.get_or_fetch(key, 6 * 3600.0, load)


@router.get("/api/route/fastest")
async def route_fastest(
    from_lat: float = Query(...),
    from_lon: float = Query(...),
    to_lat: float = Query(...),
    to_lon: float = Query(...),
) -> dict[str, Any]:
    """On-road if OSRM can route it, else fall back to the off-road estimate."""
    road = await _osrm_route(from_lat, from_lon, to_lat, to_lon, "driving")
    if road.get("reachable"):
        return road
    try:
        return {"mode": "offroad", "road_failed": road.get("note"), **await offroad.plan_offroad(
            from_lat, from_lon, to_lat, to_lon
        )}
    except ValueError as e:
        return {"reachable": False, "note": f"road unavailable; off-road: {e}"}
