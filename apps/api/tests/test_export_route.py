"""Tests for GET /api/export — GeoJSON + CSV download of the live picture.

The aircraft snapshot is faked by patching ``adsb.global_snapshot`` (the same
seam test_intel_route / test_jamming_route use), so no upstream HTTP fires.
"""

from __future__ import annotations

from unittest.mock import patch

from fastapi.testclient import TestClient

from app.routes import adsb as adsb_routes


async def _fake_snapshot() -> dict:
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": "aircraft:abc123",
                "geometry": {"type": "Point", "coordinates": [10.0, 50.0]},
                "properties": {
                    "icao24": "abc123",
                    "callsign": "DLH123",
                    "category": "airliner",
                    "track_deg": 90.0,
                    "ground_speed": 450,
                },
            },
            {
                "type": "Feature",
                "id": "aircraft:def456",
                "geometry": {"type": "Point", "coordinates": [-120.0, 35.0]},
                "properties": {
                    "icao24": "def456",
                    "callsign": "UAL1",
                    "category": "private",
                    "track_deg": 270.0,
                },
            },
        ],
    }


def test_export_geojson(client: TestClient) -> None:
    with patch.object(adsb_routes, "global_snapshot", new=_fake_snapshot):
        r = client.get("/api/export?fmt=geojson&kinds=aircraft")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/geo+json")
    assert "attachment" in r.headers.get("content-disposition", "")
    body = r.json()
    assert body["type"] == "FeatureCollection"
    assert len(body["features"]) == 2
    assert body["features"][0]["properties"]["kind"] == "aircraft"


def test_export_csv(client: TestClient) -> None:
    with patch.object(adsb_routes, "global_snapshot", new=_fake_snapshot):
        r = client.get("/api/export?fmt=csv&kinds=aircraft")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    lines = r.text.strip().splitlines()
    assert lines[0] == "id,kind,lon,lat,label,category,course,speed"
    assert len(lines) == 3  # header + 2 aircraft
    assert "DLH123" in r.text


def test_export_bbox_clips(client: TestClient) -> None:
    # bbox over Europe — keeps [10,50], drops [-120,35].
    with patch.object(adsb_routes, "global_snapshot", new=_fake_snapshot):
        r = client.get("/api/export?bbox=0,40,20,60")
    assert r.status_code == 200
    feats = r.json()["features"]
    assert len(feats) == 1
    assert feats[0]["properties"]["icao24"] == "abc123"


def test_export_rejects_bad_fmt(client: TestClient) -> None:
    r = client.get("/api/export?fmt=xml")
    assert r.status_code == 422  # Query pattern guard


def test_export_kml(client: TestClient) -> None:
    with patch.object(adsb_routes, "global_snapshot", new=_fake_snapshot):
        r = client.get("/api/export?fmt=kml&kinds=aircraft")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/vnd.google-earth.kml+xml")
    assert r.headers.get("content-disposition", "").endswith('.kml"')
    assert "<kml" in r.text and "<Placemark>" in r.text and "DLH123" in r.text
    assert "<coordinates>10.0,50.0" in r.text


def test_export_limit_truncates(client: TestClient) -> None:
    with patch.object(adsb_routes, "global_snapshot", new=_fake_snapshot):
        r = client.get("/api/export?fmt=geojson&kinds=aircraft&limit=1")
    assert r.status_code == 200
    assert len(r.json()["features"]) == 1
