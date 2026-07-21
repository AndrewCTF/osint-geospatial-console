"""Tests for apps/api/app/news/storygeo.py (A8: real satellite chips for
news stories). No network — locate_story is pure/deterministic."""

from __future__ import annotations

from app.news.storygeo import locate_story
from app.routes import news as news_routes


def test_chokepoint_title_match_returns_coords_and_radius() -> None:
    geo = locate_story({"title": "Tanker seized near the Strait of Hormuz", "summary": ""})
    assert geo is not None
    assert geo["place"] == "Strait of Hormuz"
    assert geo["method"] == "chokepoint"
    assert geo["radius_km"] == 20.0
    assert 55.5 <= geo["lon"] <= 57.0
    assert 25.5 <= geo["lat"] <= 27.0


def test_chokepoint_alias_maps_to_canonical_oceans_entry() -> None:
    geo = locate_story({"title": "Houthi drone strike near the Bab el-Mandeb", "summary": ""})
    assert geo is not None
    assert geo["place"] == "Bab-el-Mandeb"
    assert geo["method"] == "chokepoint"


def test_sea_table_match() -> None:
    geo = locate_story({"title": "Shipping disruption in the Red Sea widens", "summary": ""})
    assert geo is not None
    assert geo["place"] == "Red Sea"
    assert geo["method"] == "sea"
    assert geo["radius_km"] == 20.0


def test_grain_corridor_alias() -> None:
    geo = locate_story(
        {"title": "Grain exports resume", "summary": "A vessel left via the Black Sea grain corridor today."}
    )
    assert geo is not None
    assert geo["place"] == "Black Sea grain corridor"


def test_case_insensitive_match() -> None:
    geo = locate_story({"title": "Chaos in the strait of hormuz overnight", "summary": ""})
    assert geo is not None
    assert geo["place"] == "Strait of Hormuz"


def test_no_confident_match_returns_none() -> None:
    assert locate_story({"title": "Central bank raises interest rates", "summary": "Markets react."}) is None


def test_country_name_alone_never_resolves() -> None:
    # A bare country mention must NOT resolve to any centroid — the operator
    # explicitly rejected a country-centroid fallback (desert-nowhere chips).
    assert locate_story({"title": "Iran announces new sanctions response", "summary": ""}) is None


def test_non_dict_and_empty_story_return_none() -> None:
    assert locate_story({}) is None
    assert locate_story({"title": "", "summary": ""}) is None


def test_port_name_match_reuses_places_dataset(monkeypatch) -> None:
    from app.news import storygeo

    fake_ports = [{"name": "Rotterdam", "lat": 51.95, "lon": 4.14, "wpi": "12345"}]
    monkeypatch.setattr(storygeo.places, "ports", lambda: fake_ports)
    geo = locate_story({"title": "Congestion builds at the Port of Rotterdam", "summary": ""})
    assert geo is not None
    assert geo["method"] == "port"
    assert geo["place"] == "Rotterdam"
    assert geo["lat"] == 51.95 and geo["lon"] == 4.14
    assert geo["radius_km"] == 8.0


def test_short_port_names_are_skipped_to_avoid_false_positives(monkeypatch) -> None:
    from app.news import storygeo

    fake_ports = [{"name": "Oran", "lat": 35.7, "lon": -0.6, "wpi": "1"}]
    monkeypatch.setattr(storygeo.places, "ports", lambda: fake_ports)
    # "Oran" (4 chars) is below the length-5 floor, so ordinary prose that
    # happens to contain it must not resolve to a location.
    assert locate_story({"title": "Migrants stage protest", "summary": "Oran out the vote, organizers said."}) is None


def test_word_boundary_prevents_partial_substring_match(monkeypatch) -> None:
    from app.news import storygeo

    fake_ports = [{"name": "Adenport", "lat": 12.78, "lon": 45.03, "wpi": "2"}]
    monkeypatch.setattr(storygeo.places, "ports", lambda: fake_ports)
    # "Adenport" must not match inside an unrelated longer word.
    assert locate_story({"title": "A story about NotAdenportRelated things", "summary": ""}) is None
    geo = locate_story({"title": "Strike near Adenport terminal", "summary": ""})
    assert geo is not None and geo["place"] == "Adenport"


async def test_refresh_once_attaches_geo_to_matching_stories(monkeypatch) -> None:
    """Drive the actual news refresh pipeline integration point (routes/news.py
    refresh_once) with a canned edition and confirm the geo-attach step runs
    and only touches stories that resolve to a real place."""

    canned_edition = {
        "stories": [
            {"id": "s1", "title": "Tensions rise near the Strait of Hormuz", "summary": ""},
            {"id": "s2", "title": "Local election results announced", "summary": ""},
        ],
        "article_count": 2,
    }

    async def fake_refresh_analysis() -> dict:
        return {"method": "ok"}

    async def fake_refresh_edition() -> dict:
        return canned_edition

    async def fake_enrich_images(stories, **kwargs) -> int:
        return 0

    async def fake_verify_edition(edition):
        return edition

    async def fake_append_snapshot(*args, **kwargs) -> None:
        return None

    async def fake_latest(kind):
        return {"created_utc": None}

    monkeypatch.setattr(news_routes, "_refresh_analysis", fake_refresh_analysis)
    monkeypatch.setattr(news_routes, "_refresh_edition", fake_refresh_edition)
    monkeypatch.setattr(news_routes.news_images, "enrich_images", fake_enrich_images)
    monkeypatch.setattr(news_routes.news_verify, "verify_edition", fake_verify_edition)
    monkeypatch.setattr(news_routes.history_local, "append_snapshot", fake_append_snapshot)
    monkeypatch.setattr(news_routes.history_local, "latest", fake_latest)
    monkeypatch.setattr(news_routes.store, "set_edition", lambda e: None)

    await news_routes.refresh_once()

    stories = canned_edition["stories"]
    assert stories[0].get("geo") is not None
    assert stories[0]["geo"]["place"] == "Strait of Hormuz"
    assert "geo" not in stories[1]
