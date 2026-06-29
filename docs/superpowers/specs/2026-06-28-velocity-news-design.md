# Velocity News — design spec

Date: 2026-06-28
Status: approved (design), pre-implementation
Branch: gotham-substrate

## Goal

A public, BBC/CNN-style news page at `/news` ("Velocity News"). Many stories,
category-separated, with hero/thumbnail images, full multi-paragraph neutral
rewrites, explicit callouts of bias / propaganda / name-calling with the
loaded quotes highlighted, recommended reader actions, and proofs (source
links + corroboration + embedded dashboard media). Powered by the same
MiniMax-M3 (NVIDIA NIM) reasoning model that drives the dashboard AI agent.

## Decisions (locked with operator)

- **Images:** both — per-article `og:image`/RSS media for hero/thumbnails AND
  dashboard media (satellite chip, intel) embedded as "supporting documents".
- **Access:** public, no login. Route mounted outside `AuthProvider`.
- **Scale:** full BBC/CNN — ~40 categorized stories across sections.
- **Per-story depth:** all four — full neutral rewrite, bias/propaganda/
  name-calling callouts, recommended actions, proofs (links + corroboration +
  media).

## What already exists (reuse, do not rebuild)

- `apps/api/app/news/sources.py` — 13 world RSS feeds (BBC, Guardian, CNN, Fox,
  Al Jazeera, NPR, France24, DW, Sky, CNBC, Reuters/AP via Google News) + 1
  Mideast conflict feed. `fetch_all()` → up to 400 deduped articles
  (`news_max_items`, config.py). `Article` dataclass: title, summary, link,
  source, leaning, published_iso. **No image field today.**
- `apps/api/app/news/analyze.py` — clusters articles into ≤8 events
  (`_MAX_EVENTS`), top 5 get a per-event debias pass. Already produces per
  event: `neutral_summary` (1 line), `corroboration {source_count, sources[]}`,
  `verified_facts[]`, `attributed_claims[]`, `bias_flags[] {source, technique,
  evidence}`, `propaganda_techniques[]` (name-calling, card-stacking,
  appeal-to-fear, false-balance, …), `rhetoric_flags[]`, `confidence`.
  Self-critique downgrades facts with <2 distinct sources.
- `apps/api/app/news/store.py` — in-memory cache, 600s TTL, monotonic ts.
- `apps/api/app/routes/news.py` — `/api/news/analysis`, `/api/news/factcheck`,
  `/api/news/feed`; background refresher (`start_refresher`/`stop_refresher`).
- `apps/api/app/llm.py` — `chat(messages, tier=…)`, `chat_json(...)`.
  `tier="reason"` → `minimaxai/minimax-m3` at
  `https://integrate.api.nvidia.com/v1` (key `NVIDIA_API_KEY`/`MINIMAX_API_KEY`),
  with DeepSeek then Ollama fallback. Same client the dashboard agent uses.
- Dashboard "supporting documents":
  - `/api/intel/brief` (`intel/incidents.py`) — cross-domain fused incidents:
    `threat_level`, `domains[]`, `centroid {lon,lat}`, `narrative` (rule-based,
    cited), `evidence[]`, `follow_up[]`, `coverage_confidence`.
  - `/api/imagery/chip?lat=&lon=&radius_km=` (`routes/imagery.py`) — satellite
    chip image bytes + `X-Imagery-Provider/Gsd-M/Datetime` headers (Maxar →
    Sentinel-2 → GIBS ladder, honest provenance).
- Frontend: React Router v6 (`AppRouter.tsx`), Tailwind + `theme/tokens.css`
  (dark "Cobalt/Ink"), Inter + IBM Plex Mono self-hosted (`main.tsx`),
  `transport/http.ts` `apiFetch` (keyless-capable). Existing `NewsPanel.tsx`
  is a right-rail dashboard tab on `/api/news/analysis` — leave it intact.

## Architecture

### Backend

1. **`Article.image: str`** added in `sources.py`. Populate from RSS
   `media:content` / `media:thumbnail` / `enclosure` during feed parse (free,
   in-feed). No extra network for the 400.

2. **`og:image` enrichment** (`news/images.py`, new, small). For the lead
   article of each *published* event that lacks an in-feed image, fetch the
   article URL and parse `<meta property="og:image">` (fallback
   `twitter:image`). Bounded to published leads only (~40, not 400). Cached by
   URL in-memory with TTL. Browser User-Agent. Per-fetch timeout; failures
   degrade to no image (never block the edition).
   - ponytail ceiling: in-memory URL cache, single fetch attempt; swap to a
     persistent cache if refresh cost matters.

3. **`analyze_edition()`** in `analyze.py` (new function, reuses the existing
   cluster + debias machinery; does not touch `analyze()`):
   - Raise published event count to ~40 (new `_MAX_EDITION_EVENTS`; keep
     `_MAX_EVENTS=8` for the legacy panel path).
   - Per event, add:
     - `category` — one of World / Conflict / Politics / Economy / Tech /
       Science (LLM classification; batched — classify many events in one call
       to bound cost).
     - `neutral_rewrite` — full multi-paragraph de-spun article body
       (reason-tier), distinct from the existing 1-line `neutral_summary`.
     - `whats_wrong` — assembled from existing `bias_flags` +
       `propaganda_techniques` + name-calling, each item carrying `{source,
       technique, quote}` so the UI can highlight the loaded quote.
     - `recommended_actions[]` — NEW (what a reader should watch / verify /
       do).
     - `proofs[]` — corroboration upgraded from source names to
       `{source, url, published}` using the clustered articles' links.
     - `supporting_docs[]` — for events with a derivable location (conflict /
       geo): best-matching `/api/intel/brief` incident (in-process call, not
       the route handler) + a satellite chip URL
       `/api/imagery/chip?lat=&lon=`. Empty for non-geo stories.

4. **`GET /api/news/edition`** (`routes/news.py`, public). Serves the cached
   edition JSON. Background refresher also builds the edition (cadence ~20 min
   — slower than the 600s analysis because ~40 reason-tier rewrites are heavy).
   Edition cached separately in `store.py`; not cached on LLM failure (retry
   next cycle), matching the existing analysis behavior.

5. **In-process intel/imagery calls.** `analyze_edition` calls the brief/chip
   *functions*, not the FastAPI route handlers (the handlers' `Query(...)`
   defaults break in-process — established repo gotcha). Chip is referenced by
   URL in the payload; the browser fetches the image.

### Edition JSON (response of `/api/news/edition`)

```json
{
  "generated": "2026-06-28T14:30:45Z",
  "categories": ["World", "Conflict", "Politics", "Economy", "Tech", "Science"],
  "lead": { "...one promoted story object..." },
  "stories": [
    {
      "id": "stable-hash",
      "category": "Conflict",
      "title": "neutral headline",
      "image": "https://…/og-image.jpg",
      "neutral_summary": "one-line dek",
      "neutral_rewrite": "multi-paragraph de-spun body…",
      "corroboration": { "source_count": 3, "sources": ["BBC World", "Reuters"] },
      "verified_facts": ["…"],
      "attributed_claims": [ { "who": "…", "claim": "…", "status": "unverified" } ],
      "whats_wrong": [
        { "source": "Fox World", "technique": "name-calling",
          "quote": "the loaded phrase as published" }
      ],
      "propaganda_techniques": ["name-calling", "appeal to fear"],
      "rhetoric_flags": [ { "who": "…", "claim": "…", "note": "prediction, not fact" } ],
      "recommended_actions": ["Cross-check claim X against primary source Y", "…"],
      "proofs": [ { "source": "Reuters", "url": "https://…", "published": "…Z" } ],
      "supporting_docs": [
        { "kind": "satellite", "url": "/api/imagery/chip?lat=..&lon=..",
          "caption": "AOI near centroid" },
        { "kind": "incident", "incident_id": "…", "threat_level": "elevated",
          "narrative": "cited rule-based summary", "centroid": { "lon": 0, "lat": 0 } }
      ],
      "confidence": 0.85
    }
  ],
  "method": "edition: cluster -> classify -> rewrite -> debias(reuse) -> actions -> attach intel/imagery",
  "backend": "minimaxai/minimax-m3",
  "article_count": 237,
  "source_count": 13
}
```

### Frontend

- New folder `apps/web/src/news/`:
  - `VelocityNewsPage.tsx` — masthead "VELOCITY NEWS", category nav, lead hero
    (large `og:image`), then a section per category with a card grid. Fetches
    `/api/news/edition` via `apiFetch` (keyless).
  - `StoryView.tsx` — full story: hero image → full neutral rewrite
    (paragraphs) → **"What's wrong" callout** (loaded quotes highlighted,
    technique chips) → recommended actions → proofs (clickable source links +
    corroboration) → supporting docs (satellite chip `<img>`, incident card,
    link to the live dashboard map). Opened via `/news/:id` route or in-page
    selection.
- **Editorial light theme scoped to `/news`** (BBC/CNN read as white/editorial;
  the dashboard stays dark). Reuse Inter (headlines) + IBM Plex Mono (bylines/
  tags) already bundled; Velocity steel-blue (`--accent #4fa0d8`) as the
  section accent; a small scoped CSS file rather than touching global tokens.
- **Routing:** add `<Route path="/news" …>` and `<Route path="/news/:id" …>` in
  `AppRouter.tsx`, mounted so they do **not** require auth (outside
  `AuthProvider`, or an auth-optional wrapper).

## Data flow

```
background refresher (~20 min)
  -> sources.fetch_all()            # 400 articles, now w/ in-feed images
  -> analyze_edition()
       cluster -> classify category -> full neutral rewrite
       -> reuse bias/propaganda/rhetoric pass -> recommended actions
       -> proofs (article URLs) -> attach intel brief + satellite chip (geo)
       -> og:image enrich published leads
  -> store edition in cache
GET /api/news/edition  (public)  -> cached edition
  -> VelocityNewsPage / StoryView render
```

## Error handling

- Any feed fetch failure: that feed is skipped (existing behavior).
- LLM failure: edition not cached, retried next cycle; if no edition yet, the
  endpoint returns a well-formed empty edition (`stories: []`, `method:
  "llm unavailable"`) so the page renders an empty-state, never 500s.
- `og:image` / chip / intel failures degrade to absent fields; the story still
  renders.
- Frontend: loading skeletons; empty-state when `stories` is empty; broken
  image → category placeholder.

## Testing

- `apps/api`: `test_news_edition.py` — `analyze_edition` shape (categories
  present, each story has the new fields), category classifier maps to the
  allowed set, `og:image` parser extracts from sample HTML, edition endpoint
  returns 200 + cached shape, empty-state on LLM-down. Keep suite ≥25 passing.
- `apps/web`: `pnpm -r typecheck` green. Render `VelocityNewsPage` against a
  fixture edition (categories + cards present); `StoryView` renders rewrite +
  callouts + actions + proofs.
- Live verification (operator standard): boot app, open `/news` unauthenticated,
  confirm multiple categorized stories with images, open a story, confirm full
  rewrite + highlighted loaded quotes + actions + proof links + a satellite
  chip; screenshot at 1920px.

## Deliberate cuts (YAGNI / ponytail)

- No video embeds (add only if RSS supplies media; flagged).
- No per-story database — in-memory cache like the current pipeline.
- No new auth system — page is public.
- `analyze()` / `NewsPanel` left untouched; edition is additive.

## Known ceilings to flag at build time

- ~40 reason-tier rewrites per refresh is the cost driver. Levers: refresh
  cadence (~20 min), per-event `max_tokens` cap, batched classification,
  reusing (not re-running) the bias pass. If too slow/expensive, drop story
  count or move rewrite to the `fast` tier for non-lead stories.
- `og:image` scraping depends on third-party pages; bounded + cached + best
  effort.
