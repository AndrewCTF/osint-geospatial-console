"""Local SQLite instability_snapshots sink (Phase C, CII).

``instability_local`` mirrors ``app/intel/action_log_local.py``'s idiom (WAL
SQLite, per-test ``override_db_path``).
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from app.intel import instability_local


@pytest.fixture(autouse=True)
def _isolate_instability_db(tmp_path):
    instability_local.override_db_path(str(tmp_path / "instability.db"))
    yield
    instability_local.override_db_path(None)


def test_append_and_latest_all_round_trip() -> None:
    rows = [
        {"iso3": "UKR", "score": 82.3, "components": [{"key": "armed_conflict", "raw": 40}]},
        {"iso3": "FRA", "score": 12.0, "components": [{"key": "market_risk_off", "raw": 12.0}]},
    ]
    n = asyncio.run(instability_local.append_snapshots(rows))
    assert n == 2

    latest = asyncio.run(instability_local.latest_all())
    assert set(latest) == {"UKR", "FRA"}
    assert latest["UKR"]["score"] == 82.3
    assert latest["UKR"]["components"] == [{"key": "armed_conflict", "raw": 40}]
    assert isinstance(latest["UKR"]["ts_utc"], str) and latest["UKR"]["ts_utc"]


def test_append_empty_list_is_a_noop() -> None:
    assert asyncio.run(instability_local.append_snapshots([])) == 0
    assert asyncio.run(instability_local.latest_all()) == {}


def test_history_returns_country_series_oldest_first() -> None:
    asyncio.run(instability_local.append_snapshots([{"iso3": "UKR", "score": 50.0, "components": []}]))
    asyncio.run(instability_local.append_snapshots([{"iso3": "UKR", "score": 60.0, "components": []}]))
    rows = asyncio.run(instability_local.history("ukr", days=30))
    assert [r["score"] for r in rows] == [50.0, 60.0]


def test_history_excludes_other_countries() -> None:
    asyncio.run(instability_local.append_snapshots([{"iso3": "UKR", "score": 50.0, "components": []}]))
    asyncio.run(instability_local.append_snapshots([{"iso3": "FRA", "score": 10.0, "components": []}]))
    rows = asyncio.run(instability_local.history("UKR", days=30))
    assert len(rows) == 1
    assert rows[0]["iso3"] == "UKR"


def test_latest_all_keeps_only_the_newest_row_per_iso3() -> None:
    asyncio.run(instability_local.append_snapshots([{"iso3": "UKR", "score": 50.0, "components": []}]))
    asyncio.run(instability_local.append_snapshots([{"iso3": "UKR", "score": 90.0, "components": []}]))
    latest = asyncio.run(instability_local.latest_all())
    assert latest["UKR"]["score"] == 90.0


def test_prune_drops_rows_older_than_90_days(monkeypatch: pytest.MonkeyPatch) -> None:
    # Insert an "old" row directly, bypassing append_snapshots' own
    # now()-stamped ts_utc, then confirm the next append prunes it.
    import sqlite3

    con = sqlite3.connect(instability_local._resolved_db_path())
    con.execute(
        "CREATE TABLE IF NOT EXISTS instability_snapshots ("
        " id INTEGER PRIMARY KEY, iso3 TEXT NOT NULL, ts_utc TEXT NOT NULL,"
        " score REAL NOT NULL, components TEXT NOT NULL)"
    )
    old_ts = (datetime.now(UTC) - timedelta(days=200)).isoformat()
    con.execute(
        "INSERT INTO instability_snapshots (iso3, ts_utc, score, components) VALUES (?,?,?,?)",
        ("OLD", old_ts, 5.0, "[]"),
    )
    con.commit()
    con.close()

    asyncio.run(instability_local.append_snapshots([{"iso3": "UKR", "score": 1.0, "components": []}]))

    rows = asyncio.run(instability_local.history("OLD", days=365))
    assert rows == []


def test_override_db_path_isolates_between_tests(tmp_path) -> None:
    other = tmp_path / "other.db"
    instability_local.override_db_path(str(other))
    asyncio.run(instability_local.append_snapshots([{"iso3": "DEU", "score": 5.0, "components": []}]))
    assert other.exists()
