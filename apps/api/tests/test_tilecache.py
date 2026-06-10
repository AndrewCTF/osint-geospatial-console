"""TileCache unit tests — hit/miss, coalescing, stale-on-failure."""

from __future__ import annotations

import asyncio
from pathlib import Path

from app.tilecache import TileCache


def test_miss_fetches_once_then_disk_hit(tmp_path: Path) -> None:
    tc = TileCache(tmp_path)
    calls = 0

    async def loader() -> bytes | None:
        nonlocal calls
        calls += 1
        return b"PNG"

    async def run() -> None:
        assert await tc.get("carto", 3, 1, 2, "png", 60, loader) == b"PNG"
        assert await tc.get("carto", 3, 1, 2, "png", 60, loader) == b"PNG"

    asyncio.run(run())
    assert calls == 1
    assert (tmp_path / "carto" / "3" / "1" / "2.png").read_bytes() == b"PNG"


def test_concurrent_requests_coalesce(tmp_path: Path) -> None:
    tc = TileCache(tmp_path)
    calls = 0

    async def loader() -> bytes | None:
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.01)
        return b"X"

    async def run() -> list[bytes | None]:
        return list(
            await asyncio.gather(
                *(tc.get("s", 1, 0, 0, "png", 60, loader) for _ in range(10))
            )
        )

    results = asyncio.run(run())
    assert all(r == b"X" for r in results)
    assert calls == 1


def test_stale_served_on_upstream_failure(tmp_path: Path) -> None:
    tc = TileCache(tmp_path)

    async def good() -> bytes | None:
        return b"OLD"

    async def bad() -> bytes | None:
        return None

    async def run() -> bytes | None:
        await tc.get("s", 1, 0, 0, "png", 60, good)
        # ttl 0 → entry counts as expired → loader runs → fails → stale served
        return await tc.get("s", 1, 0, 0, "png", 0, bad)

    assert asyncio.run(run()) == b"OLD"


def test_failure_without_stale_returns_none(tmp_path: Path) -> None:
    tc = TileCache(tmp_path)

    async def bad() -> bytes | None:
        return None

    assert asyncio.run(tc.get("s", 1, 0, 0, "png", 60, bad)) is None
