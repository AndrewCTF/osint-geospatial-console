"""Guard test for identity-scoped history: GET /api/history/track and the
underlying app.history.query_track_by_id — "where was this tail/MMSI over a
time window" answered via the idx_id_t index, not a bbox+time scan.
"""

from __future__ import annotations

import asyncio
import time

import pytest
from fastapi.testclient import TestClient

import app.history as H


def _reset_module(tmp_db: str) -> None:
    """Mirrors test_history.py's helper: reset module state, point at a fresh DB."""
    H._buffer.clear()
    H._last.clear()
    H._rows_written = 0
    H._flush_task = None
    H._coverage_cache = None
    H.override_db_path(tmp_db)


@pytest.mark.asyncio
async def test_query_track_by_id_returns_only_target_in_time_order(
    tmp_path: pytest.TempPathFactory,
) -> None:
    """Seed positions for a target id + a decoy id (interleaved, out of order).
    query_track_by_id must return ONLY the target's points, ordered by time."""
    db = str(tmp_path / "track_by_id.db")
    _reset_module(db)

    now = time.time()
    target = "aircraft:af351f"
    decoy = "aircraft:decoy99"
    # Interleaved + inserted out of chronological order, to prove ORDER BY t.
    rows = [
        ("aircraft", target, now - 30, 10.0, 50.0, 90.0, "{}"),
        ("aircraft", decoy, now - 25, 99.0, 10.0, 0.0, "{}"),
        ("aircraft", target, now - 10, 10.5, 50.2, 91.0, "{}"),
        ("aircraft", decoy, now - 5, 99.5, 10.5, 0.0, "{}"),
        ("aircraft", target, now - 20, 10.2, 50.1, 90.5, "{}"),
    ]
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, H._flush_sync, rows)

    result = await H.query_track_by_id(target, t_from=now - 60, t_to=now + 10)
    tracks = result["tracks"]
    assert len(tracks) == 1, "must return exactly one track for the id"
    track = tracks[0]
    assert track["id"] == target
    assert track["kind"] == "aircraft"

    pts = track["points"]
    assert len(pts) == 3, "only the target's 3 points, not the decoy's"
    times = [p[2] for p in pts]
    assert times == sorted(times), "points must be in ascending time order"
    # No decoy longitude/latitude leaked in.
    lons = {p[0] for p in pts}
    assert 99.0 not in lons and 99.5 not in lons


@pytest.mark.asyncio
async def test_query_track_by_id_respects_time_window_and_limit(
    tmp_path: pytest.TempPathFactory,
) -> None:
    db = str(tmp_path / "track_by_id_window.db")
    _reset_module(db)

    now = time.time()
    target = "vessel:123456789"
    rows = [
        ("vessel", target, now - 1000, 1.0, 1.0, 0.0, "{}"),  # outside window
        ("vessel", target, now - 100, 2.0, 2.0, 0.0, "{}"),
        ("vessel", target, now - 50, 3.0, 3.0, 0.0, "{}"),
        ("vessel", target, now - 10, 4.0, 4.0, 0.0, "{}"),
    ]
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, H._flush_sync, rows)

    result = await H.query_track_by_id(target, t_from=now - 200, t_to=now + 10)
    pts = result["tracks"][0]["points"]
    assert len(pts) == 3, "the fix from 1000s ago must be excluded by the window"

    limited = await H.query_track_by_id(target, t_from=now - 200, t_to=now + 10, limit=2)
    assert len(limited["tracks"][0]["points"]) == 2, "limit must cap the point count"


def test_route_returns_target_entity_composed_from_kind_and_bare_id(
    client: TestClient, tmp_path: pytest.TempPathFactory
) -> None:
    """GET /api/history/track composes kind+id when id has no 'kind:' prefix,
    and passes an already-prefixed id straight through."""
    db = str(tmp_path / "track_route.db")
    _reset_module(db)
    try:
        now = time.time()
        rows = [
            ("aircraft", "aircraft:af351f", now - 5, 10.0, 50.0, 90.0, "{}"),
            ("vessel", "vessel:999", now - 5, 20.0, 20.0, 0.0, "{}"),
        ]
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(loop.run_in_executor(None, H._flush_sync, rows))
        finally:
            loop.close()

        # Bare id + kind param composes "aircraft:af351f".
        r = client.get("/api/history/track", params={"id": "af351f", "kind": "aircraft"})
        assert r.status_code == 200
        body = r.json()
        assert len(body["tracks"]) == 1
        assert body["tracks"][0]["id"] == "aircraft:af351f"

        # Already-prefixed id passes straight through, kind ignored.
        r2 = client.get("/api/history/track", params={"id": "vessel:999"})
        assert r2.status_code == 200
        body2 = r2.json()
        assert len(body2["tracks"]) == 1
        assert body2["tracks"][0]["id"] == "vessel:999"
    finally:
        H.override_db_path(None)


def test_normalize_id_case_lowercases_icao24_hex_only() -> None:
    """Pure-function guard for the normalizer: only an ICAO24-hex-shaped
    value half gets lowercased. MMSI (all digits) is unaffected, and the
    ``kind`` prefix itself is left exactly as given — a future kind might be
    case-sensitive."""
    from app.routes.history import _normalize_id_case

    assert _normalize_id_case("aircraft:AE085B") == "aircraft:ae085b"
    assert _normalize_id_case("aircraft:ae085b") == "aircraft:ae085b"
    assert _normalize_id_case("vessel:234567890") == "vessel:234567890"
    assert _normalize_id_case("Aircraft:AE085B") == "Aircraft:ae085b"


def test_route_matches_uppercase_icao24_case_insensitively(
    client: TestClient, tmp_path: pytest.TempPathFactory
) -> None:
    """The position store always writes icao24 hex lowercase, but a spotter
    types the hex the way most spotting tools display it: uppercase. All
    three input shapes (bare shape-inferred, kind= + bare, already-prefixed)
    must match the lowercase-stored row instead of a silent empty result."""
    db = str(tmp_path / "track_route_uppercase.db")
    _reset_module(db)
    try:
        now = time.time()
        rows = [("aircraft", "aircraft:ae085b", now - 5, 10.0, 50.0, 90.0, "{}")]
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(loop.run_in_executor(None, H._flush_sync, rows))
        finally:
            loop.close()

        r1 = client.get("/api/history/track", params={"id": "AE085B"})
        assert r1.status_code == 200
        assert len(r1.json()["tracks"][0]["points"]) == 1

        r2 = client.get("/api/history/track", params={"id": "AE085B", "kind": "aircraft"})
        assert r2.status_code == 200
        assert len(r2.json()["tracks"][0]["points"]) == 1

        r3 = client.get("/api/history/track", params={"id": "aircraft:AE085B"})
        assert r3.status_code == 200
        assert len(r3.json()["tracks"][0]["points"]) == 1
    finally:
        H.override_db_path(None)


def test_route_infers_aircraft_kind_from_bare_icao24_shape(
    client: TestClient, tmp_path: pytest.TempPathFactory
) -> None:
    """A bare id with NO kind= at all is accepted when its shape is an
    unambiguous 6-char ICAO24 hex — the documented "'af351f' with kind="
    form must also work with kind inferred, not just kind supplied."""
    db = str(tmp_path / "track_route_infer_aircraft.db")
    _reset_module(db)
    try:
        now = time.time()
        rows = [("aircraft", "aircraft:1a2b3c", now - 5, 10.0, 50.0, 90.0, "{}")]
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(loop.run_in_executor(None, H._flush_sync, rows))
        finally:
            loop.close()

        r = client.get("/api/history/track", params={"id": "1a2b3c"})
        assert r.status_code == 200
        body = r.json()
        assert len(body["tracks"]) == 1
        assert body["tracks"][0]["id"] == "aircraft:1a2b3c"
    finally:
        H.override_db_path(None)


def test_route_infers_vessel_kind_from_bare_mmsi_shape(
    client: TestClient, tmp_path: pytest.TempPathFactory
) -> None:
    """A bare 9-digit id (MMSI shape) with no kind= is inferred as a vessel."""
    db = str(tmp_path / "track_route_infer_vessel.db")
    _reset_module(db)
    try:
        now = time.time()
        rows = [("vessel", "vessel:234567890", now - 5, 20.0, 20.0, 0.0, "{}")]
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(loop.run_in_executor(None, H._flush_sync, rows))
        finally:
            loop.close()

        r = client.get("/api/history/track", params={"id": "234567890"})
        assert r.status_code == 200
        body = r.json()
        assert len(body["tracks"]) == 1
        assert body["tracks"][0]["id"] == "vessel:234567890"
    finally:
        H.override_db_path(None)


def test_route_bare_id_no_kind_ambiguous_shape_is_422(client: TestClient) -> None:
    """A bare id with no 'kind:' prefix, no kind= param, and a shape that is
    neither a 6-char ICAO24 hex nor a 9-digit MMSI must 422 with a message
    naming the missing kind — never a silent empty-but-200 track, which is
    what used to happen for every bare id with no kind= (the field report's
    exact repro, id=008de3, is now covered by aircraft-shape inference
    instead: it's 6 hex chars, so it's no longer ambiguous)."""
    r = client.get("/api/history/track", params={"id": "not-an-id-1"})
    assert r.status_code == 422
    assert "kind" in r.json()["detail"]
