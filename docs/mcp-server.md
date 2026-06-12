# MCP server + intel layer

The backend doubles as a **Model Context Protocol** server (`app.mcp_server`)
so an AI agent can interrogate the same warm feeds the globe renders — ADS-B
aircraft, AIS vessels, the GPS-jamming layer, and the fusion engine — without
flooding its own context window. Every response is distilled JSON (counts,
grids, ≤50-item samples), never a raw 15k-feature dump.

See also [`adsb-aircraft-pipeline.md`](./adsb-aircraft-pipeline.md) for how the
~13 k-aircraft global feed itself is sourced and merged.

## Architecture

```
agent ──stdio/http──▶ app.mcp_server (11 tools)
                          │  httpx
                          ▼
                     /api/intel/*  (app.routes.intel)
                          │
                          ▼
                     app.intel.{analytics, aoi, geo}
                          │  reads (no new steady-state upstream load)
        ┌─────────────────┼───────────────────────────┐
        ▼                 ▼                            ▼
 adsb.adsb_global   correlate.store (AIS)      correlate.bus (alerts)
 (sticky snapshot)                              + routes.jamming aggregation
```

- **`app/intel/geo.py`** — aircraft/vessel classification (mirrors the
  operator-visible `apps/web/src/globe/adapters/styles.ts` dispatch: same ADS-B
  Mode-S category codes, emergency squawks, ITU ship-type buckets, military
  callsign heuristic) plus bbox / haversine helpers.
- **`app/intel/aoi.py`** — area-primary loading (below).
- **`app/intel/analytics.py`** — the distilled analytics: `situation`,
  `density`, `jamming`, `query_aircraft`, `lookup_aircraft`, `query_vessels`,
  `anomalies`, `area_intel`. Reads the already-warm in-process snapshot — it
  opens **no** new steady-state upstream fan-out.
- **`app/routes/intel.py`** — the `/api/intel/*` HTTP surface the MCP drives.
- **`app/mcp_server.py`** — FastMCP server exposing 11 tools over that HTTP
  surface (+ the Ollama-backed `deep_analyze`).

## Area-primary loading

> *"When the agent wants an area, load that area PRIMARY, then only load others."*

The guarded global snapshot (`app.routes.adsb`) is untouched. `focus_area`
adds an **additive** mechanism on top:

1. Registers an AOI and does an immediate dedicated `/v2/point` fetch for just
   that area (cheap, rarely throttled even when the global firehose is
   rate-limited).
2. A background warmer (tied to the app lifespan) keeps every registered AOI
   hot on a short cycle — priority — while the rest of the world keeps
   streaming from the global snapshot ("only load others").
3. If every host refuses the direct fetch, it degrades gracefully to filtering
   the global snapshot for the AOI bbox — the agent always gets data
   (`load_mode` reports `direct` vs `snapshot`).

Bounded to 8 AOIs (LRU). Uses the same shared httpx client + upstream
semaphore + host list as the adsb module, so it can never out-pace the global
fan-out's rate budget.

## HTTP API — `/api/intel/*`

All return compact JSON. Geography is accepted as a centre (`lat,lon[,radius_nm]`)
or an explicit bbox (`min_lon,min_lat,max_lon,max_lat`).

| Endpoint | Purpose |
| --- | --- |
| `GET /situation` | Global orienting summary (cheap first call) |
| `GET /area` | Load a region PRIMARY + full intel bundle in one shot |
| `GET /density` | Aircraft density grid for an area |
| `GET /jamming` | GPS-jamming assessment (global or scoped) |
| `GET /aircraft` | Filtered aircraft query |
| `GET /aircraft/{ident}` | Single-aircraft lookup (ICAO24 or callsign) |
| `GET /vessels` | AIS vessels in an area (`dark_only` supported) |
| `GET /anomalies` | Fused report + triage threat level |
| `GET /aois` | Active priority areas |
| `GET /sources` | Feed health + which feeds are key-gated |

## MCP tools

11 tools — the full table is in the [README](../README.md#mcp-server--query-the-live-console-from-an-ai-agent):
`get_situation`, `focus_area`, `aircraft_density`, `gps_jamming`,
`query_aircraft`, `lookup_aircraft`, `query_vessels`, `anomalies`,
`list_focus_areas`, `data_sources`, `deep_analyze`.

### `deep_analyze` (local Ollama)

Gathers the relevant intel JSON and hands it to a **local Ollama model** to
reason over — heavy analysis stays on the box, only the conclusion returns to
the agent's context. Auto-picks the smallest installed model; degrades to
returning the raw structured JSON (`analysis: null`) when Ollama is absent.

## Running

```bash
# backend must be up (provides the warm feeds)
uv run --project apps/api uvicorn app.main:app --port 8000

uv run --project apps/api python -m app.mcp_server              # stdio
uv run --project apps/api python -m app.mcp_server --http --port 8765
uv run --project apps/api python -m app.mcp_server --list-tools  # introspect
```

`.mcp.json` at the repo root wires the `osint-geoint` server for Claude Code.
Config (env or `apps/api/.env`): `API_BASE`, `API_KEY`, `OLLAMA_HOST`,
`OLLAMA_MODEL`.

### Other agents

Verified end-to-end with **opencode** (`opencode mcp list` → connected) driving
the tools through both a local Ollama model and DeepSeek (`deepseek-v4-flash`,
OpenAI-compatible). Any MCP-capable client works.

## Robustness

The MCP server never crashes a tool call:

- backend down → structured `backend_unreachable` error + hint
- Ollama down → `deep_analyze` falls back to raw intel JSON
- empty snapshot / out-of-range params → handled (HTTP 422 at the route)
- the AOI warmer is cancelled on app shutdown (no leaked background task)

## Testing

```bash
cd apps/api && .venv/bin/pytest -q          # unit + route + degradation tests
# manual integration drivers (need a live backend on :8000):
.venv/bin/python tests/mcp_client_check.py  # MCP stdio handshake
.venv/bin/python tests/mcp_full_check.py    # all 11 tools end-to-end + Ollama
```
