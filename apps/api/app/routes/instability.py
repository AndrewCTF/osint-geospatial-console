"""GET /api/country/instability* — Country Instability Index (CII) routes.

Serves the snapshots ``app/intel/instability.py`` scores and
``app/intel/instability_local.py`` persists, plus the background loop that
keeps the local store fresh (mirrors ``routes/news.py``'s
``start_refresher``/``_refresh_loop``/``stop_refresher`` trio: warm up, score
+ store on an interval, never die on a bad cycle).
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from app.intel import instability, instability_local

log = logging.getLogger(__name__)

router = APIRouter(tags=["instability"])


@router.get("/api/country/instability")
async def instability_ranked(limit: int = Query(25, ge=1, le=250)) -> dict[str, Any]:
    """Every country with a stored snapshot, ranked by score descending.

    ``{items: [{iso3, score, top_component: {key, normalized, weight} | None,
    components_present, ts_utc}], generated_utc}``. Empty ``items`` (never a
    404) when the scorer hasn't produced a snapshot yet.
    """
    snapshots = await instability_local.latest_all()
    rows = sorted(snapshots.values(), key=lambda r: r["score"], reverse=True)[:limit]
    items = [
        {
            "iso3": r["iso3"],
            "score": r["score"],
            "top_component": _top_component(r["components"]),
            "components_present": [c["key"] for c in r["components"]],
            "ts_utc": r["ts_utc"],
        }
        for r in rows
    ]
    return {"items": items, "generated_utc": datetime.now(UTC).isoformat()}


@router.get("/api/country/instability/{iso3}")
async def instability_detail(
    iso3: str, days: int = Query(30, ge=1, le=90)
) -> Any:
    """One country's latest snapshot + trailing history.

    ``{iso3, score, components, components_present, ts_utc, history:
    [{ts_utc, score}], baseline}`` where ``baseline`` is the oldest score in
    the returned ``?days=`` window (``None`` when fewer than two snapshots
    exist yet — a single point has nothing to compare against). 404 when the
    scorer has never produced a snapshot for this country.
    """
    iso3u = iso3.strip().upper()
    snapshots = await instability_local.latest_all()
    latest = snapshots.get(iso3u)
    if latest is None:
        return JSONResponse(
            status_code=404, content={"error": f"no instability snapshot for {iso3u!r}"}
        )
    hist = await instability_local.history(iso3u, days=days)
    history_points = [{"ts_utc": h["ts_utc"], "score": h["score"]} for h in hist]
    baseline = history_points[0]["score"] if len(history_points) > 1 else None
    return {
        "iso3": iso3u,
        "score": latest["score"],
        "components": latest["components"],
        "components_present": [c["key"] for c in latest["components"]],
        "ts_utc": latest["ts_utc"],
        "history": history_points,
        "baseline": baseline,
    }


def _top_component(components: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not components:
        return None
    top = max(components, key=lambda c: c["normalized"] * c["weight"])
    return {"key": top["key"], "normalized": top["normalized"], "weight": top["weight"]}


# ── background scorer loop ──────────────────────────────────────────────────
# Same idiom as `routes/news.py`'s start_refresher/_refresh_loop/stop_refresher:
# a short warmup (let boot finish before the first multi-source fan-out), then
# score_and_store() every cycle, any exception logged and swallowed so one bad
# cycle never kills the loop, gated off entirely by OSINT_DISABLE_BACKGROUND
# via main.py (this module never reads that env var itself — the lifespan
# `if background:` block decides whether to call start_scorer() at all).
_SCORE_INTERVAL_SEC = 15 * 60

_tasks: list[asyncio.Task[None]] = []
_stop = asyncio.Event()


async def _score_loop(stop: asyncio.Event) -> None:
    try:
        await asyncio.wait_for(stop.wait(), timeout=3.0)
        return
    except TimeoutError:
        pass

    while not stop.is_set():
        try:
            await instability.score_and_store()
        except Exception as exc:  # noqa: BLE001 — never let the loop die
            log.warning("instability scoring failed: %s", exc)
        interval = max(60, _SCORE_INTERVAL_SEC)
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval)
        except TimeoutError:
            continue


def start_scorer() -> None:
    """Start the background CII scoring loop (no-op when already running)."""
    if _tasks:
        return
    _stop.clear()
    _tasks.append(asyncio.create_task(_score_loop(_stop), name="instability_score"))


async def stop_scorer() -> None:
    """Cancel the background loop and await its teardown."""
    _stop.set()
    for t in _tasks:
        t.cancel()
    for t in _tasks:
        try:
            await t
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
    _tasks.clear()
