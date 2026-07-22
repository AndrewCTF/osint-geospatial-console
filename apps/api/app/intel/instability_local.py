"""Local SQLite sink for Country Instability Index (CII) snapshots — Phase C
of the worldmonitor-gaps plan (the scorer + a later background loop write
here; the route/country_stats integration lands in a later task).

Same idiom as ``action_log_local.py`` / ``news/history_local.py``: WAL SQLite
under ``./data``, a fresh connection per operation run off the event loop's
default executor, and an ``override_db_path()`` test hook.

One row per (iso3, ts_utc) snapshot. ``components`` is the full per-component
breakdown (``{key, raw, normalized, weight, inputs}`` list) JSON-encoded, so a
caller can show its work without recomputing it from the raw signals.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

_DEFAULT_DB_PATH = "./data/instability.db"

_RETENTION_DAYS = 90

# ── DB path injection (for tests) ─────────────────────────────────────────────

_db_path_override: str | None = None


def override_db_path(path: str | None) -> None:
    """Set a custom DB path (tests). Pass None to clear."""
    global _db_path_override
    _db_path_override = path


def _resolved_db_path() -> str:
    return _db_path_override or _DEFAULT_DB_PATH


# ── connection / schema ───────────────────────────────────────────────────────

_SCHEMA = """
CREATE TABLE IF NOT EXISTS instability_snapshots (
  id         INTEGER PRIMARY KEY,
  iso3       TEXT NOT NULL,
  ts_utc     TEXT NOT NULL,
  score      REAL NOT NULL,
  components TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_instability_iso3_ts ON instability_snapshots(iso3, ts_utc DESC);
"""


def _connect() -> sqlite3.Connection:
    path = _resolved_db_path()
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path, check_same_thread=False)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=5000")
    con.executescript(_SCHEMA)
    con.commit()
    return con


async def _run(fn: Any) -> Any:
    return await asyncio.get_running_loop().run_in_executor(None, fn)


def _row_to_dict(r: tuple) -> dict[str, Any]:
    return {
        "iso3": r[0],
        "ts_utc": r[1],
        "score": r[2],
        "components": json.loads(r[3]),
    }


async def append_snapshots(rows: list[dict[str, Any]]) -> int:
    """Persist a batch of ``{iso3, score, components}`` rows in one
    transaction, stamping ``ts_utc`` now, then prune rows older than 90 days.

    Returns the number of rows written.
    """
    if not rows:
        return 0
    ts_utc = datetime.now(UTC).isoformat()
    cutoff = (datetime.now(UTC) - timedelta(days=_RETENTION_DAYS)).isoformat()

    def _sync() -> int:
        con = _connect()
        try:
            con.executemany(
                "INSERT INTO instability_snapshots (iso3, ts_utc, score, components)"
                " VALUES (?,?,?,?)",
                [
                    (
                        row["iso3"],
                        ts_utc,
                        float(row["score"]),
                        json.dumps(row["components"]),
                    )
                    for row in rows
                ],
            )
            con.execute(
                "DELETE FROM instability_snapshots WHERE ts_utc < ?", (cutoff,)
            )
            con.commit()
            return len(rows)
        finally:
            con.close()

    return await _run(_sync)


async def history(iso3: str, days: int = 30) -> list[dict[str, Any]]:
    """Snapshots for one country over the trailing ``days``, oldest first."""
    cutoff = (datetime.now(UTC) - timedelta(days=days)).isoformat()

    def _sync() -> list[dict[str, Any]]:
        con = _connect()
        try:
            rows = con.execute(
                "SELECT iso3, ts_utc, score, components FROM instability_snapshots"
                " WHERE iso3 = ? AND ts_utc >= ? ORDER BY ts_utc ASC",
                (iso3.upper(), cutoff),
            ).fetchall()
        finally:
            con.close()
        return [_row_to_dict(r) for r in rows]

    return await _run(_sync)


async def latest_all() -> dict[str, dict[str, Any]]:
    """Most recent snapshot per iso3, keyed by iso3."""

    def _sync() -> dict[str, dict[str, Any]]:
        con = _connect()
        try:
            rows = con.execute(
                "SELECT iso3, ts_utc, score, components FROM instability_snapshots"
                " WHERE id IN ("
                "  SELECT MAX(id) FROM instability_snapshots GROUP BY iso3"
                ")"
            ).fetchall()
        finally:
            con.close()
        return {r[0]: _row_to_dict(r) for r in rows}

    return await _run(_sync)
