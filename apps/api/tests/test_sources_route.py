"""GET /api/intel/sources must enumerate every key-gated feed (honesty:
a feed that silently needs a key shouldn't look 'always on')."""

from __future__ import annotations

from fastapi.testclient import TestClient


def test_sources_lists_all_key_gated(client: TestClient) -> None:
    r = client.get("/api/intel/sources")
    assert r.status_code == 200
    kg = r.json()["key_gated"]
    # The four previously-listed plus the three that were silently omitted.
    for feed in (
        "aisstream",
        "firms_fires",
        "opensky_authed",
        "gfw_dark_vessels",
        "acled_events",
        "cloudflare_outages",
        "openaip",
    ):
        assert feed in kg, f"{feed} missing from key_gated"
        assert isinstance(kg[feed], bool)


def test_sources_has_honesty_note(client: TestClient) -> None:
    b = client.get("/api/intel/sources").json()
    assert "key_gated_note" in b and "degraded" in b
