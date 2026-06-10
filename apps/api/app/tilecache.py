"""Disk-backed tile cache with per-key coalescing and stale-on-failure.

Tiles are near-immutable (basemap restyles monthly at most, satellite
mosaics yearly, terrain never), so a long-TTL disk cache means each tile is
fetched from upstream at most once per TTL window — regardless of how many
browser sessions request it. Upstream sees O(unique tiles), not
O(users x tiles). This is the rate-limit fix.

File IO is synchronous on purpose: tiles are ~10-100 KB local-disk reads on
a single-analyst deployment; a thread hop per tile would cost more than the
read. Writes are atomic (tmp + os.replace) so a crashed write never leaves
a truncated tile to be served later.
"""

from __future__ import annotations

import asyncio
import os
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from pathlib import Path

# Bounded per-key lock table — same eviction idea as upstream.TtlCache.
_MAX_LOCKS = 4096


class TileCache:
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        self._locks: OrderedDict[str, asyncio.Lock] = OrderedDict()

    def _path(self, source: str, z: int, x: int, y: int, ext: str) -> Path:
        return self.root / source / str(z) / str(x) / f"{y}.{ext}"

    def _lock_for(self, key: str) -> asyncio.Lock:
        lock = self._locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[key] = lock
        self._locks.move_to_end(key)
        while len(self._locks) > _MAX_LOCKS:
            self._locks.popitem(last=False)
        return lock

    @staticmethod
    def _fresh(path: Path, ttl_sec: float) -> bool:
        try:
            return (time.time() - path.stat().st_mtime) < ttl_sec
        except OSError:
            return False

    async def get(
        self,
        source: str,
        z: int,
        x: int,
        y: int,
        ext: str,
        ttl_sec: float,
        loader: Callable[[], Awaitable[bytes | None]],
    ) -> bytes | None:
        """Return tile bytes, or None when upstream failed and no copy exists.

        Fresh disk hit short-circuits without locking. On miss, a per-key
        lock coalesces concurrent fetches into one upstream call. When the
        loader fails (returns None), any stale copy — regardless of age —
        is served instead, so a dead upstream degrades to "frozen tiles",
        never to "blank map".
        """
        path = self._path(source, z, x, y, ext)
        if self._fresh(path, ttl_sec):
            try:
                return path.read_bytes()
            except OSError:
                pass
        async with self._lock_for(f"{source}/{z}/{x}/{y}"):
            # Double-check: another waiter may have written it while we queued.
            if self._fresh(path, ttl_sec):
                try:
                    return path.read_bytes()
                except OSError:
                    pass
            data = await loader()
            if data:
                path.parent.mkdir(parents=True, exist_ok=True)
                tmp = path.with_suffix(path.suffix + ".tmp")
                tmp.write_bytes(data)
                os.replace(tmp, path)
                return data
            try:
                return path.read_bytes()
            except OSError:
                return None
