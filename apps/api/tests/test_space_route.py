"""Tests for GET /api/space/gp — per-request truncation of the CelesTrak set.

The upstream fetch (cache.get_or_fetch) is patched so no network call fires; the
test asserts the route caps `items` to `limit` while reporting the true `count`.
"""

from __future__ import annotations

from unittest.mock import patch

from fastapi.testclient import TestClient

from app.routes import space as space_routes


def test_space_gp_caps_items(client: TestClient) -> None:
    async def fake_fetch(key: str, ttl: float, load) -> dict:  # noqa: ANN001
        return {"group": "active", "items": [{"NORAD_CAT_ID": i} for i in range(5000)]}

    with patch.object(space_routes.cache, "get_or_fetch", new=fake_fetch):
        r = client.get("/api/space/gp?group=active&limit=100")
    assert r.status_code == 200
    b = r.json()
    assert b["count"] == 5000          # true total preserved
    assert b["returned"] == 100        # truncated for the client
    assert len(b["items"]) == 100


def test_space_gp_default_cap(client: TestClient) -> None:
    async def fake_fetch(key: str, ttl: float, load) -> dict:  # noqa: ANN001
        return {"group": "active", "items": [{"NORAD_CAT_ID": i} for i in range(16000)]}

    with patch.object(space_routes.cache, "get_or_fetch", new=fake_fetch):
        r = client.get("/api/space/gp?group=active")
    assert r.status_code == 200
    assert len(r.json()["items"]) == 2000  # default limit, not all 16k


def test_space_gp_rejects_unknown_group(client: TestClient) -> None:
    r = client.get("/api/space/gp?group=evil")
    assert r.status_code == 400
