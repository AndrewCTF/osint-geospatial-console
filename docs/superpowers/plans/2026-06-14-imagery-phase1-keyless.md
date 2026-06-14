# Imagery Phase 1 (keyless) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add keyless, date-templated NASA GIBS satellite imagery as selectable raster layers on the globe with a day stepper, proxied + disk-cached by the backend.

**Architecture:** Mirror the existing `tiles.py` proxy pattern — a new `imagery` provider package builds upstream GIBS WMTS-REST URLs; a new `/api/imagery/*` router proxies tiles through the existing `TileCache` (namespaced by `gibs/<layer>/<date>`) and serves a `/api/imagery/catalog`. Frontend adds a GIBS overlay `ImageryLayer` in `GlobeCanvas` driven by new store state (`imageryOverlay = {layer, date}`), plus a small control to pick layer + step the date.

**Tech Stack:** FastAPI, httpx, existing `TileCache`; React + Cesium `UrlTemplateImageryProvider`; Zustand store; pytest + vitest.

**Scope:** Phase 1 = keyless GIBS daily layers only (MODIS Terra/Aqua + VIIRS SNPP/NOAA-20 true color, VIIRS thermal). Geostationary (sub-daily time), Sentinel-1/2/3 + NISAR (keyed) = Phase 2 (separate plan). SAR dark-vessel = Phase 3 (separate plan).

GIBS WMTS-REST URL (EPSG:3857, aligns with Cesium web-mercator z/x/y):
`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/{LAYER}/default/{TIME}/{MATRIXSET}/{z}/{y}/{x}.{ext}`

---

### Task 1: GIBS provider (catalog + URL builder)

**Files:**
- Create: `apps/api/app/imagery/__init__.py`
- Create: `apps/api/app/imagery/gibs.py`
- Test: `apps/api/tests/test_imagery_gibs.py`

- [ ] **Step 1: Write the failing test**

```python
# apps/api/tests/test_imagery_gibs.py
import pytest
from app.imagery import gibs


def test_catalog_has_known_layers():
    ids = {l["id"] for l in gibs.catalog()}
    assert "MODIS_Terra_CorrectedReflectance_TrueColor" in ids
    assert "VIIRS_NOAA20_CorrectedReflectance_TrueColor" in ids


def test_tile_url_true_color():
    url = gibs.tile_url(
        "MODIS_Terra_CorrectedReflectance_TrueColor", "2026-06-10", 3, 4, 2
    )
    assert url == (
        "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/"
        "MODIS_Terra_CorrectedReflectance_TrueColor/default/2026-06-10/"
        "GoogleMapsCompatible_Level9/3/2/4.jpg"
    )


def test_tile_url_unknown_layer_raises():
    with pytest.raises(KeyError):
        gibs.tile_url("NoSuchLayer", "2026-06-10", 0, 0, 0)


def test_ext_and_format_per_layer():
    # thermal anomalies are PNG, true color is JPEG
    tc = gibs.layer("MODIS_Terra_CorrectedReflectance_TrueColor")
    assert tc["ext"] == "jpg"
    th = gibs.layer("VIIRS_NOAA20_Thermal_Anomalies_375m_All")
    assert th["ext"] == "png"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && .venv/bin/pytest tests/test_imagery_gibs.py -q`
Expected: FAIL (module `app.imagery` not found).

- [ ] **Step 3: Write minimal implementation**

```python
# apps/api/app/imagery/__init__.py
"""Satellite imagery providers (keyless GIBS first; keyed CDSE/NISAR later)."""
```

```python
# apps/api/app/imagery/gibs.py
"""NASA GIBS WMTS-REST adapter — keyless, date-templated global imagery.

URL: https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/{LAYER}/default/{TIME}/{MATRIXSET}/{z}/{y}/{x}.{ext}
EPSG:3857 GoogleMapsCompatible matrix sets align tile z/x/y with Cesium's
web-mercator imagery provider. TIME is YYYY-MM-DD (or 'default'). No API key.
"""

from __future__ import annotations

from typing import Any

_BASE = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best"

# id -> display/tiling metadata. matrixset caps the max native zoom per the
# source resolution (250 m/1 km -> Level9; 375 m thermal -> Level9).
_LAYERS: dict[str, dict[str, Any]] = {
    "MODIS_Terra_CorrectedReflectance_TrueColor": {
        "title": "MODIS Terra — True Color", "group": "Optical (daily)",
        "matrixset": "GoogleMapsCompatible_Level9", "ext": "jpg", "max_z": 9,
    },
    "MODIS_Aqua_CorrectedReflectance_TrueColor": {
        "title": "MODIS Aqua — True Color", "group": "Optical (daily)",
        "matrixset": "GoogleMapsCompatible_Level9", "ext": "jpg", "max_z": 9,
    },
    "VIIRS_SNPP_CorrectedReflectance_TrueColor": {
        "title": "VIIRS SNPP — True Color", "group": "Optical (daily)",
        "matrixset": "GoogleMapsCompatible_Level9", "ext": "jpg", "max_z": 9,
    },
    "VIIRS_NOAA20_CorrectedReflectance_TrueColor": {
        "title": "VIIRS NOAA-20 — True Color", "group": "Optical (daily)",
        "matrixset": "GoogleMapsCompatible_Level9", "ext": "jpg", "max_z": 9,
    },
    "VIIRS_NOAA20_Thermal_Anomalies_375m_All": {
        "title": "VIIRS NOAA-20 — Thermal Anomalies", "group": "Thermal",
        "matrixset": "GoogleMapsCompatible_Level9", "ext": "png", "max_z": 9,
    },
}


def catalog() -> list[dict[str, Any]]:
    return [{"id": k, **v} for k, v in _LAYERS.items()]


def layer(layer_id: str) -> dict[str, Any]:
    return _LAYERS[layer_id]


def tile_url(layer_id: str, date: str, z: int, x: int, y: int) -> str:
    meta = _LAYERS[layer_id]  # KeyError on unknown layer (caller maps to 404)
    return (
        f"{_BASE}/{layer_id}/default/{date}/{meta['matrixset']}"
        f"/{z}/{y}/{x}.{meta['ext']}"
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && .venv/bin/pytest tests/test_imagery_gibs.py -q`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add apps/api/app/imagery/__init__.py apps/api/app/imagery/gibs.py apps/api/tests/test_imagery_gibs.py
git commit -m "imagery: add keyless GIBS WMTS adapter (catalog + tile URL builder)"
```

---

### Task 2: Imagery proxy + catalog routes

**Files:**
- Create: `apps/api/app/routes/imagery.py`
- Modify: `apps/api/app/main.py` (include router)
- Test: `apps/api/tests/test_imagery_routes.py`

- [ ] **Step 1: Write the failing test**

```python
# apps/api/tests/test_imagery_routes.py
import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("OSINT_DISABLE_BACKGROUND", "1")
    monkeypatch.setenv("TILE_CACHE_DIR", str(tmp_path))
    return TestClient(create_app())


def test_catalog_lists_gibs(client):
    r = client.get("/api/imagery/catalog")
    assert r.status_code == 200
    body = r.json()
    ids = {l["id"] for l in body["layers"]}
    assert "MODIS_Terra_CorrectedReflectance_TrueColor" in ids
    assert all(l["provider"] == "gibs" for l in body["layers"])


def test_tile_proxies_and_caches(client, monkeypatch):
    calls = {"n": 0}

    async def fake_fetch(url: str):
        calls["n"] += 1
        assert url.startswith("https://gibs.earthdata.nasa.gov/wmts/")
        return b"\xff\xd8\xff\xe0PNGorJPEGbytes"

    monkeypatch.setattr("app.routes.imagery._fetch_bytes", fake_fetch)
    path = "/api/imagery/gibs/MODIS_Terra_CorrectedReflectance_TrueColor/3/4/2?date=2026-06-10"
    r1 = client.get(path)
    r2 = client.get(path)
    assert r1.status_code == 200 and r2.status_code == 200
    assert r1.content == b"\xff\xd8\xff\xe0PNGorJPEGbytes"
    assert calls["n"] == 1  # second served from disk cache


def test_unknown_layer_404(client):
    r = client.get("/api/imagery/gibs/NoSuchLayer/0/0/0?date=2026-06-10")
    assert r.status_code == 404


def test_unknown_provider_404(client):
    r = client.get("/api/imagery/nope/Layer/0/0/0?date=2026-06-10")
    assert r.status_code == 404
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && .venv/bin/pytest tests/test_imagery_routes.py -q`
Expected: FAIL (404 route not found / import error).

- [ ] **Step 3: Write minimal implementation**

```python
# apps/api/app/routes/imagery.py
"""Satellite imagery tile proxy + catalog.

Mirrors tiles.py: typed-int z/x/y, disk TileCache (namespaced by
provider/layer/date so each day caches independently), stale-on-failure.
Keyless GIBS only in Phase 1.
"""

from __future__ import annotations

import asyncio
import re

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from app.config import Settings, get_settings
from app.imagery import gibs
from app.tilecache import TileCache
from app.upstream import get_client

router = APIRouter(tags=["imagery"])

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_MEDIA = {"jpg": "image/jpeg", "png": "image/png"}
_TTL = 6 * 3600.0  # daily layer refreshes slowly; 6h disk cache

_caches: dict[str, TileCache] = {}
_FETCH_SEMAPHORE = asyncio.Semaphore(8)


def _cache_for(root: str) -> TileCache:
    tc = _caches.get(root)
    if tc is None:
        tc = TileCache(root)
        _caches[root] = tc
    return tc


async def _fetch_bytes(url: str) -> bytes | None:
    async with _FETCH_SEMAPHORE:
        for attempt in (0, 1):
            try:
                r = await get_client().get(url)
            except Exception:
                r = None
            if r is not None and r.status_code == 200:
                return r.content
            if attempt == 0:
                await asyncio.sleep(0.5)
    return None


@router.get("/api/imagery/catalog")
async def imagery_catalog() -> dict:
    return {"layers": [{"provider": "gibs", **l} for l in gibs.catalog()]}


@router.get("/api/imagery/{provider}/{layer}/{z}/{x}/{y}")
async def imagery_tile(
    provider: str,
    layer: str,
    z: int,
    x: int,
    y: int,
    date: str = Query(..., description="YYYY-MM-DD"),
    settings: Settings = Depends(get_settings),
) -> Response:
    if provider != "gibs":
        raise HTTPException(404, "unknown provider")
    if not _DATE_RE.match(date):
        raise HTTPException(400, "date must be YYYY-MM-DD")
    try:
        meta = gibs.layer(layer)
        url = gibs.tile_url(layer, date, z, x, y)
    except KeyError:
        raise HTTPException(404, "unknown layer") from None
    if not (0 <= z <= meta["max_z"]):
        raise HTTPException(400, "z out of range")

    async def load() -> bytes | None:
        return await _fetch_bytes(url)

    data = await _cache_for(settings.tile_cache_dir).get(
        f"gibs/{layer}/{date}", z, x, y, meta["ext"], _TTL, load
    )
    if data is None:
        raise HTTPException(502, "imagery upstream failed")
    return Response(
        content=data,
        media_type=_MEDIA[meta["ext"]],
        headers={"Cache-Control": "public, max-age=21600", "X-Imagery": f"gibs/{layer}"},
    )
```

Modify `apps/api/app/main.py`: add import near the other route imports and include the router.

```python
# with the other "from app.routes import ..." lines:
from app.routes import imagery as imagery_routes
# with the other app.include_router(...) lines:
app.include_router(imagery_routes.router)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && .venv/bin/pytest tests/test_imagery_routes.py -q`
Expected: PASS (4 passed).

- [ ] **Step 5: Run full backend suite + ruff**

Run: `cd apps/api && .venv/bin/ruff check app/ tests/ && .venv/bin/pytest -q`
Expected: ruff clean; pytest ≥ prior count, all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/app/routes/imagery.py apps/api/app/main.py apps/api/tests/test_imagery_routes.py
git commit -m "imagery: add /api/imagery proxy + catalog (keyless GIBS, date-namespaced cache)"
```

---

### Task 3: Frontend GIBS overlay + date stepper

**Files:**
- Modify: `apps/web/src/state/stores.ts` (add imagery-overlay state)
- Modify: `apps/web/src/globe/GlobeCanvas.tsx` (build + add/remove GIBS overlay layer)
- Create: `apps/web/src/imagery/ImageryControl.tsx` (layer picker + date stepper)
- Modify: `apps/web/src/App.tsx` (mount the control)
- Test: `apps/web/src/imagery/imagery.test.ts` (URL builder + reducer)

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/imagery/imagery.test.ts
import { describe, expect, it } from 'vitest';
import { gibsOverlayUrl } from './gibsUrl';

describe('gibsOverlayUrl', () => {
  it('builds a date-templated backend URL with Cesium z/x/y placeholders', () => {
    expect(gibsOverlayUrl('MODIS_Terra_CorrectedReflectance_TrueColor', '2026-06-10')).toBe(
      '/api/imagery/gibs/MODIS_Terra_CorrectedReflectance_TrueColor/{z}/{x}/{y}?date=2026-06-10',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && pnpm vitest run src/imagery/imagery.test.ts`
Expected: FAIL (`./gibsUrl` not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/web/src/imagery/gibsUrl.ts
// Backend proxy URL for a GIBS layer on a given UTC date. Cesium fills
// {z}/{x}/{y}; the backend re-templates to the GIBS WMTS-REST upstream.
export function gibsOverlayUrl(layer: string, date: string): string {
  return `/api/imagery/gibs/${layer}/{z}/{x}/{y}?date=${date}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && pnpm vitest run src/imagery/imagery.test.ts`
Expected: PASS.

- [ ] **Step 5: Add store state**

In `apps/web/src/state/stores.ts`, add to the relevant Zustand store:

```ts
// imagery overlay: null = off; else a GIBS layer id + UTC date (YYYY-MM-DD)
imageryOverlay: null as { layer: string; date: string } | null,
setImageryOverlay: (o: { layer: string; date: string } | null) =>
  set({ imageryOverlay: o }),
```

(Match the existing store's `set`/slice idiom; if multiple stores exist, add to the same one that holds layer-visibility/basemap state.)

- [ ] **Step 6: Wire the overlay into GlobeCanvas**

In `apps/web/src/globe/GlobeCanvas.tsx`, add a builder beside `buildSatImagery`:

```tsx
import { gibsOverlayUrl } from '../imagery/gibsUrl';

// GIBS imagery overlay (keyless, date-templated) drawn ON TOP of the base.
function buildGibsOverlay(layer: string, date: string, maxLevel: number): Cesium.ImageryLayer {
  const provider = new Cesium.UrlTemplateImageryProvider({
    url: gibsOverlayUrl(layer, date),
    maximumLevel: maxLevel,
    credit: 'NASA EOSDIS GIBS',
  });
  return Cesium.ImageryLayer.fromProviderAsync(Promise.resolve(provider), {});
}
```

Add a `useEffect` that reacts to `imageryOverlay`: keep the overlay layer in a ref; on change remove the old one and, if non-null, add a fresh one and `scene.requestRender()`. Max level 9 for the Phase-1 layers.

```tsx
const gibsLayerRef = useRef<Cesium.ImageryLayer | null>(null);
useEffect(() => {
  const viewer = viewerRef.current;
  if (!viewer) return;
  const scene = viewer.scene;
  if (gibsLayerRef.current) {
    scene.imageryLayers.remove(gibsLayerRef.current, true);
    gibsLayerRef.current = null;
  }
  if (imageryOverlay) {
    const lyr = buildGibsOverlay(imageryOverlay.layer, imageryOverlay.date, 9);
    scene.imageryLayers.add(lyr);
    gibsLayerRef.current = lyr;
  }
  scene.requestRender();
}, [imageryOverlay]);
```

(`imageryOverlay` read from the store at the top of the component with the existing selector pattern.)

- [ ] **Step 7: Build the control**

```tsx
// apps/web/src/imagery/ImageryControl.tsx
import { useEffect, useState } from 'react';
import { apiFetch } from '../net/apiFetch'; // use the project's existing wrapper path

type CatalogLayer = { id: string; title: string; group: string };

function shiftDate(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function ImageryControl({
  overlay,
  setOverlay,
}: {
  overlay: { layer: string; date: string } | null;
  setOverlay: (o: { layer: string; date: string } | null) => void;
}) {
  const [layers, setLayers] = useState<CatalogLayer[]>([]);
  useEffect(() => {
    apiFetch('/api/imagery/catalog')
      .then((r) => r.json())
      .then((b) => setLayers(b.layers))
      .catch(() => setLayers([]));
  }, []);
  const today = new Date().toISOString().slice(0, 10);
  const date = overlay?.date ?? today;
  return (
    <div className="imagery-control">
      <select
        value={overlay?.layer ?? ''}
        onChange={(e) =>
          setOverlay(e.target.value ? { layer: e.target.value, date } : null)
        }
      >
        <option value="">Imagery: off</option>
        {layers.map((l) => (
          <option key={l.id} value={l.id}>{l.title}</option>
        ))}
      </select>
      {overlay && (
        <span className="imagery-date">
          <button onClick={() => setOverlay({ ...overlay, date: shiftDate(overlay.date, -1) })}>◀</button>
          <span>{overlay.date}</span>
          <button
            disabled={overlay.date >= today}
            onClick={() => setOverlay({ ...overlay, date: shiftDate(overlay.date, 1) })}
          >▶</button>
        </span>
      )}
    </div>
  );
}
```

Mount `<ImageryControl overlay={imageryOverlay} setOverlay={setImageryOverlay} />` in `App.tsx` near the existing layer rail / controls, wiring the store selectors. Confirm the actual `apiFetch` import path used elsewhere (e.g. `../net/apiFetch`) and reuse it (CLAUDE.md: no raw fetch).

- [ ] **Step 8: Run frontend checks**

Run: `cd apps/web && pnpm vitest run src/imagery/ && cd ../.. && pnpm -r typecheck`
Expected: vitest pass; typecheck green.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/imagery apps/web/src/globe/GlobeCanvas.tsx apps/web/src/state/stores.ts apps/web/src/App.tsx
git commit -m "imagery: GIBS overlay layer + date stepper control on the globe"
```

---

### Task 4: Manual verification (acceptance)

- [ ] Boot API + web. Pick "MODIS Terra — True Color" → global daily imagery drapes on the globe.
- [ ] Step the date back one day → imagery visibly changes (different clouds), confirming date templating.
- [ ] `curl -s -o /tmp/t.jpg -w '%{http_code} %{size_download}\n' "http://127.0.0.1:8000/api/imagery/gibs/MODIS_Terra_CorrectedReflectance_TrueColor/3/4/2?date=<yesterday>"` → 200, non-trivial size; second call served from disk cache.
- [ ] `/api/imagery/catalog` lists all five layers.
- [ ] Turn imagery off → overlay removed, base layer intact.

## Self-review notes

- Spec coverage: implements Spec A §3 keyless tier + time control (Phase 1 subset). Keyed providers + dark-vessel + damage are out of scope here (Phases 2–4, own plans).
- No placeholders: all code shown; types (`imageryOverlay {layer,date}`, `gibsOverlayUrl`, `gibs.tile_url`) consistent across tasks.
- The one integration unknown is the exact Zustand store slice + `apiFetch` import path — resolve by matching existing code at execution time (noted inline).
