# Velocity News Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public BBC/CNN-style "Velocity News" page at `/news` — many categorized stories with images, full neutral rewrites, bias/propaganda callouts, recommended actions, and proofs (source links + dashboard intel/imagery) — powered by the same MiniMax-M3 (NVIDIA NIM) reasoning model the dashboard agent uses.

**Architecture:** Reuse the existing RSS pipeline (`app/news/sources.py`), debias engine (`app/news/analyze.py`), in-memory cache (`app/news/store.py`), and background refresher (`app/routes/news.py`). Add an `image` field to articles, an `og:image` enricher, a richer `analyze_edition()` that (in ONE per-event LLM call) also emits category + full rewrite + recommended actions, deterministic post-processing for "what's wrong"/proofs/supporting-docs, and a public `/api/news/edition` endpoint. Frontend adds a public React-Router route rendering an editorial-light page + story view.

**Tech Stack:** Python 3 / FastAPI / httpx / feedparser (backend); React + React Router v6 + Tailwind + `theme/tokens.css` (frontend); MiniMax-M3 via `app.llm.chat_json(tier="reason")`.

## Global Constraints

- `pnpm -r typecheck` must be green at every commit boundary.
- `cd apps/api && .venv/bin/pytest -q` must hold at ≥25 passed.
- Browser → backend calls go through `apiFetch` (`src/transport/http.ts`); never raw `fetch`. The page is public, so it must work with no auth token (apiFetch already degrades to keyless).
- Do NOT modify `analyze()` or `NewsPanel.tsx` behavior — the edition path is additive; the dashboard panel keeps using `/api/news/analysis`.
- In-process intel/imagery use must call the underlying *functions*, never the FastAPI route handlers (the handlers' `Query(...)` defaults break in-process — established repo gotcha).
- No new runtime dependency — feedparser, httpx, the LLM client are already present.
- Banned words rule (CLAUDE.md): no "global/complete/full coverage" claims without a measured count, in code/comments/commits.
- LLM model id is resolved by `app.llm` (MiniMax-M3 → DeepSeek → Ollama). Do not hardcode the model string in news code; pass `tier="reason"`.

---

### Task 1: Article images from RSS media tags

**Files:**
- Modify: `apps/api/app/news/sources.py` (`Article` dataclass ~31-38; `parse_feed_bytes` ~152-176)
- Test: `apps/api/tests/test_news_images.py` (create)

**Interfaces:**
- Produces: `Article.image: str` (empty string when the feed carries no media); `_entry_image(entry) -> str`.

- [ ] **Step 1: Write the failing test**

```python
# apps/api/tests/test_news_images.py
from app.news.sources import Source, parse_feed_bytes

_SRC = Source("Test", "http://x", "center", "test")

_RSS_WITH_MEDIA = b"""<?xml version="1.0"?>
<rss xmlns:media="http://search.yahoo.com/mrss/" version="2.0"><channel>
<item>
  <title>Story with thumbnail</title>
  <link>https://ex.com/a</link>
  <description>body</description>
  <media:thumbnail url="https://img.ex.com/a.jpg"/>
</item>
<item>
  <title>Story with enclosure</title>
  <link>https://ex.com/b</link>
  <enclosure url="https://img.ex.com/b.jpg" type="image/jpeg"/>
</item>
<item>
  <title>Story with no image</title>
  <link>https://ex.com/c</link>
</item>
</channel></rss>"""

def test_parse_extracts_media_image():
    arts = parse_feed_bytes(_RSS_WITH_MEDIA, _SRC)
    by_title = {a.title: a for a in arts}
    assert by_title["Story with thumbnail"].image == "https://img.ex.com/a.jpg"
    assert by_title["Story with enclosure"].image == "https://img.ex.com/b.jpg"
    assert by_title["Story with no image"].image == ""
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && .venv/bin/pytest tests/test_news_images.py -q`
Expected: FAIL — `Article.__init__() got an unexpected keyword argument 'image'` (or AttributeError on `.image`).

- [ ] **Step 3: Add the field + extractor**

In `apps/api/app/news/sources.py`, add `image` to the dataclass (default keeps every other `Article(...)` call valid):

```python
@dataclass
class Article:
    title: str
    summary: str
    link: str
    source: str
    leaning: str
    published_iso: str | None
    image: str = ""
```

Add the extractor above `parse_feed_bytes`:

```python
def _entry_image(entry: object) -> str:
    """Best-effort image URL from an RSS/Atom entry's media tags."""
    # media:thumbnail / media:content (Yahoo MRSS — feedparser normalizes both)
    for attr in ("media_thumbnail", "media_content"):
        items = getattr(entry, attr, None) or []
        for it in items:
            url = (it.get("url") if isinstance(it, dict) else "") or ""
            if url:
                return url.strip()
    # <enclosure type="image/*"> shows up under links with rel="enclosure"
    for lk in getattr(entry, "links", None) or []:
        if isinstance(lk, dict) and lk.get("rel") == "enclosure":
            if str(lk.get("type", "")).startswith("image") and lk.get("href"):
                return str(lk["href"]).strip()
    return ""
```

In `parse_feed_bytes`, set `image=_entry_image(entry)` in the `Article(...)` constructor.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && .venv/bin/pytest tests/test_news_images.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/app/news/sources.py apps/api/tests/test_news_images.py
git commit -m "Add image field to news Article, parse RSS media tags"
```

---

### Task 2: og:image enrichment for lead stories

**Files:**
- Create: `apps/api/app/news/images.py`
- Test: `apps/api/tests/test_news_ogimage.py` (create)

**Interfaces:**
- Produces:
  - `parse_og_image(html: str) -> str` — pure parser.
  - `async fetch_og_image(url: str) -> str` — bounded fetch + in-memory cache; "" on any failure.

- [ ] **Step 1: Write the failing test**

```python
# apps/api/tests/test_news_ogimage.py
from app.news.images import parse_og_image

def test_parse_og_image_property():
    html = '<head><meta property="og:image" content="https://i.ex/x.jpg"></head>'
    assert parse_og_image(html) == "https://i.ex/x.jpg"

def test_parse_twitter_image_fallback():
    html = '<meta name="twitter:image" content="https://i.ex/t.png">'
    assert parse_og_image(html) == "https://i.ex/t.png"

def test_parse_none():
    assert parse_og_image("<html><body>no meta</body></html>") == ""
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && .venv/bin/pytest tests/test_news_ogimage.py -q`
Expected: FAIL — `ModuleNotFoundError: app.news.images`.

- [ ] **Step 3: Write the module**

```python
# apps/api/app/news/images.py
"""Best-effort og:image enrichment for published news leads.

Pure parser (offline-testable) + a bounded, cached fetch. Only called for the
handful of stories that actually ship in an edition — never the full 400-article
corpus. Any failure degrades to "" so the edition never blocks on a slow page.
"""
from __future__ import annotations

import logging
import re

from app.upstream import get_client

log = logging.getLogger(__name__)

# ponytail: in-memory URL->image cache, single fetch attempt. Swap to a
# persistent/LRU cache if refresh cost matters.
_cache: dict[str, str] = {}

_OG_RE = re.compile(
    r"""<meta[^>]+(?:property|name)\s*=\s*["'](?:og:image|twitter:image)["'][^>]*>""",
    re.IGNORECASE,
)
_CONTENT_RE = re.compile(r"""content\s*=\s*["']([^"']+)["']""", re.IGNORECASE)

_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)


def parse_og_image(html: str) -> str:
    """Extract the og:image (or twitter:image) URL from page HTML; "" if none."""
    if not html:
        return ""
    m = _OG_RE.search(html)
    if not m:
        return ""
    c = _CONTENT_RE.search(m.group(0))
    return c.group(1).strip() if c else ""


async def fetch_og_image(url: str, timeout_s: float = 6.0) -> str:
    """Fetch a page and pull its og:image. Cached; "" on any failure."""
    url = (url or "").strip()
    if not url:
        return ""
    if url in _cache:
        return _cache[url]
    img = ""
    try:
        client = get_client()
        r = await client.get(
            url, timeout=timeout_s, follow_redirects=True,
            headers={"User-Agent": _UA},
        )
        if r.status_code == 200:
            # Only need the <head>; cap bytes scanned.
            img = parse_og_image(r.text[:200_000])
    except Exception as exc:  # noqa: BLE001 — best effort, never raise
        log.debug("og:image fetch %s failed: %s", url, exc)
    _cache[url] = img
    return img
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && .venv/bin/pytest tests/test_news_ogimage.py -q`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add apps/api/app/news/images.py apps/api/tests/test_news_ogimage.py
git commit -m "Add og:image enricher for news leads"
```

---

### Task 3: Edition analysis — category + full rewrite + actions (one LLM call/event)

**Files:**
- Modify: `apps/api/app/news/analyze.py` (add edition constants, prompt, `_refine_event_edition`, `analyze_edition`; reuse `cluster_titles`, `_coerce_event`, `_self_critique_event`, `_headlines_for_event`, `_compact_headlines`, `_json_dumps`)
- Test: `apps/api/tests/test_news_edition.py` (create)

**Interfaces:**
- Consumes: `Article` (with `.image`, `.link`), `cluster_titles`, `_coerce_event`, `_self_critique_event`, `_headlines_for_event`, `llm.chat_json`.
- Produces: `async analyze_edition(articles: list[Article]) -> dict` returning:
  `{"generated", "categories": [str], "lead": story|None, "stories": [story], "method", "backend", "article_count", "source_count"}`
  where each `story` is a `_coerce_event` dict PLUS keys: `id: str`, `category: str` (one of `EDITION_CATEGORIES`), `neutral_rewrite: str`, `recommended_actions: [str]`, `whats_wrong: [{source,technique,quote}]`, `proofs: [{source,url,published}]`, `image: str`, `supporting_docs: []` (filled in Task 4).

- [ ] **Step 1: Write the failing test**

```python
# apps/api/tests/test_news_edition.py
import asyncio
import app.news.analyze as analyze
from app.news.analyze import analyze_edition, EDITION_CATEGORIES
from app.news.sources import Article


def _arts():
    return [
        Article("Iran and Israel trade strikes near Hormuz", "s1",
                "https://bbc.com/1", "BBC World", "center", "2026-06-28T10:00:00Z",
                image="https://img/1.jpg"),
        Article("IDF says Tehran targets hit overnight", "s2",
                "https://reuters.com/2", "Reuters", "wire", "2026-06-28T09:00:00Z"),
        Article("Markets fall as oil spikes on Gulf tension", "s3",
                "https://cnbc.com/3", "CNBC", "center", "2026-06-28T08:00:00Z"),
    ]


class _FakeRes:
    ok = True
    backend = "minimaxai/minimax-m3"
    error = None


async def _fake_chat_json(messages, **kw):
    sys = messages[0]["content"]
    if "Cluster" in sys or "cluster" in sys:
        return ({"events": [
            {"title": "Gulf strikes", "sources": ["BBC World", "Reuters"],
             "neutral_summary": "Strikes reported near Hormuz."},
            {"title": "Oil and markets", "sources": ["CNBC"],
             "neutral_summary": "Oil prices rose."},
        ]}, _FakeRes())
    # per-event edition refine
    return ({
        "title": "Gulf strikes",
        "category": "Conflict",
        "neutral_summary": "Strikes were reported near the Strait of Hormuz.",
        "neutral_rewrite": "Para one.\n\nPara two.",
        "recommended_actions": ["Verify casualty figures against ICRC."],
        "corroboration": {"source_count": 2, "sources": ["BBC World", "Reuters"]},
        "verified_facts": ["Explosions were reported in the area."],
        "attributed_claims": [],
        "bias_flags": [{"source": "BBC World", "technique": "name-calling",
                        "evidence": "the regime"}],
        "propaganda_techniques": ["name-calling"],
        "rhetoric_flags": [],
        "confidence": 0.8,
    }, _FakeRes())


def test_analyze_edition_shape(monkeypatch):
    monkeypatch.setattr(analyze.llm, "chat_json", _fake_chat_json)
    ed = asyncio.run(analyze_edition(_arts()))
    assert ed["stories"], "expected stories"
    s = ed["stories"][0]
    assert s["category"] in EDITION_CATEGORIES
    assert s["neutral_rewrite"]
    assert isinstance(s["recommended_actions"], list)
    assert isinstance(s["whats_wrong"], list) and s["whats_wrong"][0]["quote"] == "the regime"
    assert any(p["url"] for p in s["proofs"]), "proofs carry article URLs"
    assert s["id"]
    assert ed["lead"] is not None
    assert ed["backend"] == "minimaxai/minimax-m3"


def test_analyze_edition_empty():
    ed = asyncio.run(analyze_edition([]))
    assert ed["stories"] == [] and ed["method"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && .venv/bin/pytest tests/test_news_edition.py -q`
Expected: FAIL — `ImportError: cannot import name 'analyze_edition'`.

- [ ] **Step 3: Implement in `analyze.py`**

Add near the other bounds (after line 44):

```python
# ── edition (Velocity News public page) bounds ──────────────────────────────
_MAX_EDITION_EVENTS = 40      # how many stories the public edition publishes
_EDITION_REFINE_S = 30.0      # per-event LLM step for the richer edition pass
_EDITION_BUDGET_S = 240.0     # total wall-clock for the edition build
EDITION_CATEGORIES = ["World", "Conflict", "Politics", "Economy", "Tech", "Science"]
_CATEGORY_SET = {c.lower(): c for c in EDITION_CATEGORIES}
```

Add the edition refine prompt (after `_REFINE_SYSTEM`):

```python
_EDITION_REFINE_SYSTEM = """\
You are a rigorous, non-partisan news editor writing ONE story for a public \
news site. You are given an event title plus the headlines/summaries that \
mention it, each tagged with source + leaning. Reason ONLY over the provided \
text — never invent facts, sources, quotes, numbers, places, or dates.

Apply the same fact discipline as a fact-checker:
- A VERIFIED FACT needs >=2 INDEPENDENT outlets (wires + differing leanings \
count as independent). A statement BY a politician/official/state outlet is an \
ATTRIBUTED CLAIM, never a fact. A promise/prediction is rhetoric.
- Detect bias_flags (loaded/emotive language, one-sidedness, framing) attributed \
to the specific source with the quoted evidence, and name propaganda_techniques \
explicitly (name-calling, card-stacking, appeal-to-fear, false-balance, \
whataboutism, bandwagon, glittering-generalities, manufactured-consensus).

Additionally:
- Classify the story into EXACTLY ONE category from: World, Conflict, Politics, \
Economy, Tech, Science.
- Write neutral_rewrite: a calm, de-spun retelling of the event in 2-4 short \
paragraphs (plain language, no loaded words), separated by blank lines.
- recommended_actions: 1-3 concrete things a reader should do to verify or \
follow the story (e.g. "cross-check the casualty figure against a primary \
source"). No calls to political action.

Output STRICT JSON ONLY, no prose, no markdown fences, matching exactly:
{
  "title": "<short neutral event title>",
  "category": "<one of World|Conflict|Politics|Economy|Tech|Science>",
  "neutral_summary": "<one-line dek>",
  "neutral_rewrite": "<2-4 paragraph de-spun body>",
  "recommended_actions": ["<action>", ...],
  "corroboration": {"source_count": <int>, "sources": ["<name>", ...]},
  "verified_facts": ["<fact corroborated by >=2 independent outlets>", ...],
  "attributed_claims": [
    {"who": "<speaker>", "claim": "<claim>", "status": "unverified|disputed|corroborated"}
  ],
  "bias_flags": [{"source": "<name>", "technique": "<name>", "evidence": "<quote>"}],
  "propaganda_techniques": ["<name>", ...],
  "rhetoric_flags": [{"who": "<speaker>", "claim": "<claim>", "note": "<why not a fact>"}],
  "confidence": <0..1>
}
"""
```

Add a stable id helper + post-processors + the edition refine + the public function (append near the end, before `_json_dumps`):

```python
def _story_id(title: str, link: str) -> str:
    import hashlib
    return hashlib.md5(f"{title}|{link}".encode()).hexdigest()[:12]  # noqa: S324


def _normalize_category(raw: Any) -> str:
    return _CATEGORY_SET.get(str(raw or "").strip().lower(), "World")


def _whats_wrong(ev: dict[str, Any]) -> list[dict[str, str]]:
    """Deterministic: surface bias_flags as {source, technique, quote} for the UI."""
    out: list[dict[str, str]] = []
    for b in ev.get("bias_flags") or []:
        if not isinstance(b, dict):
            continue
        out.append({
            "source": str(b.get("source") or "").strip(),
            "technique": str(b.get("technique") or "").strip(),
            "quote": str(b.get("evidence") or b.get("quote") or "").strip(),
        })
    return out


def _proofs_for(cluster: list[Article]) -> list[dict[str, str]]:
    """Deterministic: clickable source links from the cluster's articles."""
    seen: set[str] = set()
    out: list[dict[str, str]] = []
    for a in cluster:
        if not a.link or a.link in seen:
            continue
        seen.add(a.link)
        out.append({"source": a.source, "url": a.link, "published": a.published_iso or ""})
    return out


def _lead_image(cluster: list[Article]) -> str:
    for a in cluster:
        if a.image:
            return a.image
    return ""


async def _refine_event_edition(
    event: dict[str, Any], articles: list[Article]
) -> dict[str, Any] | None:
    """Edition per-event pass: debias + category + rewrite + actions in one call."""
    ctx = _headlines_for_event(event, articles)
    user = (
        f"Event: {event.get('title') or '(untitled)'}\n\n"
        "Headlines mentioning this event (JSON):\n"
        + _json_dumps(ctx)
        + "\n\nReturn the strict JSON story object described in the system prompt."
    )
    try:
        parsed, res = await asyncio.wait_for(
            llm.chat_json(
                [
                    {"role": "system", "content": _EDITION_REFINE_SYSTEM},
                    {"role": "user", "content": user},
                ],
                tier="reason",
                temperature=0.2,
                max_tokens=4096,
            ),
            timeout=_EDITION_REFINE_S,
        )
    except Exception:  # noqa: BLE001
        return None
    if not res.ok or not isinstance(parsed, dict):
        return None
    if isinstance(parsed.get("events"), list) and parsed["events"]:
        first = parsed["events"][0]
        if isinstance(first, dict):
            parsed = first
    parsed.setdefault("title", event.get("title"))
    parsed["_backend"] = res.backend
    return parsed


async def analyze_edition(articles: list[Article]) -> dict[str, Any]:
    """Build the public Velocity News edition: many categorized, enriched stories.

    Reuses the cheap offline clustering, then runs the richer per-event edition
    pass (debias + category + full rewrite + actions in ONE call per event),
    bounded by event count + wall-clock. whats_wrong / proofs / image are
    deterministic post-processing. supporting_docs is attached in a later step
    (see attach_supporting_docs). Degrades to an empty edition on LLM failure.
    """
    if not articles:
        return {
            "generated": _now_iso(), "categories": EDITION_CATEGORIES,
            "lead": None, "stories": [], "method": "no articles",
            "backend": None, "article_count": 0, "source_count": 0,
        }

    clusters = cluster_titles(articles, max_clusters=_MAX_EDITION_EVENTS)
    if not clusters:
        return {
            "generated": _now_iso(), "categories": EDITION_CATEGORIES,
            "lead": None, "stories": [], "method": "no clusters",
            "backend": None, "article_count": len(articles),
            "source_count": len({a.source for a in articles}),
        }

    loop = asyncio.get_event_loop()
    deadline = loop.time() + _EDITION_BUDGET_S
    stories: list[dict[str, Any]] = []
    backend: str | None = None

    for cluster in clusters:
        if loop.time() >= deadline:
            break
        seed = {
            "title": cluster[0].title,
            "sources": [a.source for a in cluster],
            "neutral_summary": cluster[0].summary[:200],
        }
        out = await _refine_event_edition(seed, articles)
        if out is None:
            continue
        backend = out.pop("_backend", None) or backend
        ev = _self_critique_event(_coerce_event(out))
        ev["category"] = _normalize_category(out.get("category"))
        ev["neutral_rewrite"] = str(out.get("neutral_rewrite") or ev["neutral_summary"]).strip()
        ev["recommended_actions"] = [
            str(a).strip() for a in (out.get("recommended_actions") or []) if str(a).strip()
        ]
        ev["whats_wrong"] = _whats_wrong(ev)
        ev["proofs"] = _proofs_for(cluster)
        ev["image"] = _lead_image(cluster)
        ev["supporting_docs"] = []
        ev["id"] = _story_id(ev["title"], cluster[0].link)
        stories.append(ev)

    if not stories:
        return {
            "generated": _now_iso(), "categories": EDITION_CATEGORIES,
            "lead": None, "stories": [], "method": "llm unavailable",
            "backend": backend, "article_count": len(articles),
            "source_count": len({a.source for a in articles}),
        }

    return {
        "generated": _now_iso(),
        "categories": EDITION_CATEGORIES,
        "lead": stories[0],
        "stories": stories,
        "method": "edition: cluster -> per-event (category+rewrite+debias+actions) -> deterministic proofs/whats-wrong",
        "backend": backend,
        "article_count": len(articles),
        "source_count": len({a.source for a in articles}),
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && .venv/bin/pytest tests/test_news_edition.py -q`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add apps/api/app/news/analyze.py apps/api/tests/test_news_edition.py
git commit -m "Add analyze_edition: categorized stories with rewrite, actions, proofs"
```

---

### Task 4: Attach supporting documents (intel incidents + satellite chip)

**Files:**
- Modify: `apps/api/app/news/analyze.py` (add `attach_supporting_docs`; call it from `analyze_edition` after stories are built)
- Test: `apps/api/tests/test_news_supporting.py` (create)

**Interfaces:**
- Consumes: incidents from `app.intel.incidents.brief()` (in-process function — confirm its name/shape by reading `apps/api/app/intel/incidents.py`; it returns `{"incidents": [{"id","threat_level","narrative","domains","centroid":{"lon","lat"},...}], ...}`). If the callable name differs, adapt — do NOT call the route handler.
- Produces: `async attach_supporting_docs(stories: list[dict]) -> None` (mutates in place). For Conflict-category stories, attaches up to 2 incidents as
  `{"kind":"incident", "incident_id", "threat_level", "narrative", "centroid"}` and, when the incident has a centroid, an extra
  `{"kind":"satellite", "url": "/api/imagery/chip?lat=<lat>&lon=<lon>&radius_km=8", "caption": "Satellite chip near live signal"}`.

> Honesty note (anti-hallucination): incidents are attached as "live signals in this theatre", NOT as proof the article event happened at that exact spot. Captions must say so. Stories with no matching incident get `supporting_docs: []`.

- [ ] **Step 1: Write the failing test**

```python
# apps/api/tests/test_news_supporting.py
import asyncio
import app.news.analyze as analyze
from app.news.analyze import attach_supporting_docs


def test_attach_supporting_docs(monkeypatch):
    async def fake_brief(*a, **k):
        return {"incidents": [
            {"id": "inc1", "threat_level": "elevated", "narrative": "Vessel + jamming.",
             "domains": ["dark-vessel"], "centroid": {"lon": 56.3, "lat": 26.6}},
        ]}
    monkeypatch.setattr(analyze, "_incident_brief", fake_brief, raising=False)
    stories = [
        {"id": "a", "category": "Conflict", "title": "Gulf", "supporting_docs": []},
        {"id": "b", "category": "Tech", "title": "Chips", "supporting_docs": []},
    ]
    asyncio.run(attach_supporting_docs(stories))
    docs = stories[0]["supporting_docs"]
    kinds = {d["kind"] for d in docs}
    assert "incident" in kinds and "satellite" in kinds
    sat = next(d for d in docs if d["kind"] == "satellite")
    assert "lat=26.6" in sat["url"] and "lon=56.3" in sat["url"]
    assert stories[1]["supporting_docs"] == []  # non-conflict untouched
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && .venv/bin/pytest tests/test_news_supporting.py -q`
Expected: FAIL — `cannot import name 'attach_supporting_docs'`.

- [ ] **Step 3: Implement**

In `analyze.py`, add a thin indirection so the test can monkeypatch the brief call, then the attacher:

```python
async def _incident_brief() -> dict[str, Any]:
    """In-process intel brief (function, NOT the route handler). Empty on failure."""
    try:
        from app.intel import incidents as _inc  # noqa: PLC0415
        res = _inc.brief()  # confirm sync/async + name when implementing
        if asyncio.iscoroutine(res):
            res = await res
        return res if isinstance(res, dict) else {}
    except Exception:  # noqa: BLE001 — supporting docs are best-effort
        return {}


async def attach_supporting_docs(stories: list[dict[str, Any]]) -> None:
    """Attach live intel incidents + satellite chip URLs to Conflict stories."""
    conflict = [s for s in stories if s.get("category") == "Conflict"]
    if not conflict:
        return
    brief = await _incident_brief()
    incidents = [i for i in (brief.get("incidents") or []) if isinstance(i, dict)][:2]
    if not incidents:
        return
    docs: list[dict[str, Any]] = []
    for inc in incidents:
        c = inc.get("centroid") if isinstance(inc.get("centroid"), dict) else {}
        docs.append({
            "kind": "incident",
            "incident_id": str(inc.get("id") or ""),
            "threat_level": str(inc.get("threat_level") or ""),
            "narrative": str(inc.get("narrative") or ""),
            "centroid": c,
        })
        lat, lon = c.get("lat"), c.get("lon")
        if isinstance(lat, int | float) and isinstance(lon, int | float):
            docs.append({
                "kind": "satellite",
                "url": f"/api/imagery/chip?lat={lat}&lon={lon}&radius_km=8",
                "caption": "Satellite chip near live signal (not the exact story location)",
            })
    for s in conflict:
        s["supporting_docs"] = docs
```

Wire it into `analyze_edition` just before the final `return` (the success path):

```python
    await attach_supporting_docs(stories)
    return { ... }  # existing success dict
```

- [ ] **Step 4: Run tests**

Run: `cd apps/api && .venv/bin/pytest tests/test_news_supporting.py tests/test_news_edition.py -q`
Expected: PASS (3 passed). (Edition test still green — non-conflict path untouched; if the fixture's story is Conflict, `_incident_brief` returns `{}` → `supporting_docs` stays `[]`.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/app/news/analyze.py apps/api/tests/test_news_supporting.py
git commit -m "Attach intel incidents + satellite chips to conflict news stories"
```

---

### Task 5: Edition cache + public `/api/news/edition` endpoint + refresher build

**Files:**
- Modify: `apps/api/app/news/store.py` (add edition slot, mirroring the analysis slot)
- Modify: `apps/api/app/routes/news.py` (add `_refresh_edition`, the route, and build the edition inside `refresh_once`)
- Test: `apps/api/tests/test_news_edition_route.py` (create)

**Interfaces:**
- Consumes: `analyze_edition`, `store.set_edition/get_edition/is_edition_stale`.
- Produces: `GET /api/news/edition` → cached edition dict (public, keyless). Empty-state shape when never built / LLM down (HTTP 200 with `stories: []`).

- [ ] **Step 1: Write the failing test**

```python
# apps/api/tests/test_news_edition_route.py
from fastapi.testclient import TestClient
import app.routes.news as news_routes
from app.news import store
from app.main import create_app


def test_edition_endpoint_empty_state():
    store.reset()
    app = create_app()
    with TestClient(app) as c:
        r = c.get("/api/news/edition")
    assert r.status_code == 200
    body = r.json()
    assert "stories" in body and isinstance(body["stories"], list)


def test_edition_served_from_cache(monkeypatch):
    store.reset()
    store.set_edition({"stories": [{"id": "x", "category": "World", "title": "t"}],
                       "categories": ["World"], "lead": None, "method": "test"})
    app = create_app()
    with TestClient(app) as c:
        r = c.get("/api/news/edition")
    assert r.status_code == 200
    assert r.json()["stories"][0]["id"] == "x"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && .venv/bin/pytest tests/test_news_edition_route.py -q`
Expected: FAIL — `AttributeError: module 'app.news.store' has no attribute 'set_edition'` (or 404 on the route).

- [ ] **Step 3a: Add the edition cache slot in `store.py`**

```python
# ── edition (public news page) ──────────────────────────────────────────────
_edition: dict[str, Any] | None = None
_edition_ts: float = 0.0


def set_edition(edition: dict[str, Any]) -> None:
    global _edition, _edition_ts
    _edition = edition
    _edition_ts = time.monotonic()


def get_edition() -> dict[str, Any] | None:
    return _edition


def edition_age_s() -> float | None:
    if _edition_ts == 0.0:
        return None
    return time.monotonic() - _edition_ts


def is_edition_stale(max_age_s: float) -> bool:
    age = edition_age_s()
    return age is None or age > max_age_s
```

Also extend `reset()` to clear `_edition`/`_edition_ts` (add them to the `global` line and set `_edition = None`, `_edition_ts = 0.0`).

- [ ] **Step 3b: Add route + refresh + refresher wiring in `routes/news.py`**

Add an edition refresh interval constant near the top (heavier than analysis):

```python
_EDITION_REFRESH_SEC = 1200  # ~20 min — ~40 reason-tier rewrites is expensive
_edition_lock = asyncio.Lock()
```

Add the refresh helper + endpoint (after `news_analysis`):

```python
def _empty_edition() -> dict[str, Any]:
    return {
        "generated": None, "categories": news_analyze.EDITION_CATEGORIES,
        "lead": None, "stories": [], "method": "not yet built",
        "backend": None, "article_count": 0, "source_count": 0,
    }


async def _refresh_edition() -> dict[str, Any]:
    """Build + cache the edition under a lock; never cache an LLM-down result."""
    async with _edition_lock:
        if not store.is_edition_stale(_EDITION_REFRESH_SEC):
            cached = store.get_edition()
            if cached is not None:
                return cached
        articles = await _ensure_articles()
        edition = await news_analyze.analyze_edition(articles)
        if edition.get("stories"):
            store.set_edition(edition)
        return edition


@router.get("/api/news/edition")
async def news_edition() -> Any:
    """Public Velocity News edition (cached; refreshed by the background loop).

    Public + keyless. Serves the cached edition; if none exists yet it kicks a
    build but returns a well-formed empty edition rather than blocking the page.
    """
    s = get_settings()
    if not s.news_enabled:
        return {"enabled": False, **_empty_edition()}
    cached = store.get_edition()
    if cached is not None:
        return cached
    # No edition yet: try a short build, else empty-state (never 500/hang the page).
    try:
        return await asyncio.wait_for(_refresh_edition(), timeout=88.0)
    except TimeoutError:
        return _empty_edition()
```

Extend `refresh_once` so the background loop builds the edition too (best-effort; analysis stays primary):

```python
async def refresh_once() -> dict[str, Any]:
    """Fetch → analyze → cache (analysis), then best-effort build the edition."""
    result = await _refresh_analysis()
    try:
        await _refresh_edition()
    except Exception as exc:  # noqa: BLE001 — edition failure must not kill the loop
        log.warning("news edition build failed: %s", exc)
    return result
```

- [ ] **Step 4: Run tests**

Run: `cd apps/api && .venv/bin/pytest tests/test_news_edition_route.py -q`
Expected: PASS (2 passed).
Then full suite: `cd apps/api && .venv/bin/pytest -q` → ≥25 passed, no regressions.

- [ ] **Step 5: Commit**

```bash
git add apps/api/app/news/store.py apps/api/app/routes/news.py apps/api/tests/test_news_edition_route.py
git commit -m "Add public /api/news/edition endpoint with cached background build"
```

---

### Task 6: Frontend types + public route + editorial theme

**Files:**
- Create: `apps/web/src/news/types.ts`
- Create: `apps/web/src/news/news.css`
- Modify: `apps/web/src/AppRouter.tsx` (import + 2 routes; keep them OUTSIDE auth chrome)
- Test: typecheck

**Interfaces:**
- Produces: `Edition`, `Story`, `WhatsWrong`, `Proof`, `SupportingDoc` TS types matching the Task 3/4 JSON; routes `/news` and `/news/:id`.

- [ ] **Step 1: Write the types**

```ts
// apps/web/src/news/types.ts
export interface WhatsWrong { source: string; technique: string; quote: string; }
export interface Proof { source: string; url: string; published: string; }
export interface SupportingDoc {
  kind: 'incident' | 'satellite';
  url?: string; caption?: string;
  incident_id?: string; threat_level?: string; narrative?: string;
  centroid?: { lon: number; lat: number };
}
export interface Story {
  id: string;
  category: string;
  title: string;
  image: string;
  neutral_summary: string;
  neutral_rewrite: string;
  corroboration: { source_count: number; sources: string[] };
  verified_facts: string[];
  attributed_claims: { who: string; claim: string; status: string }[];
  whats_wrong: WhatsWrong[];
  propaganda_techniques: string[];
  rhetoric_flags: { who: string; claim: string; note: string }[];
  recommended_actions: string[];
  proofs: Proof[];
  supporting_docs: SupportingDoc[];
  confidence: number;
}
export interface Edition {
  generated: string | null;
  categories: string[];
  lead: Story | null;
  stories: Story[];
  method: string;
  backend: string | null;
  article_count: number;
  source_count: number;
}
```

- [ ] **Step 2: Write the scoped editorial theme**

```css
/* apps/web/src/news/news.css — editorial light theme, scoped under .vnews */
.vnews { background:#f6f6f4; color:#16181c; min-height:100vh; }
.vnews a { color:inherit; text-decoration:none; }
.vnews .vn-wrap { max-width:1100px; margin:0 auto; padding:0 20px 64px; }
.vnews .vn-masthead { border-bottom:3px solid #16181c; padding:18px 0 10px; margin-bottom:8px; }
.vnews .vn-brand { font-family:Inter,system-ui,sans-serif; font-weight:800; font-size:30px; letter-spacing:-0.02em; }
.vnews .vn-brand b { color:#4fa0d8; }
.vnews .vn-nav { display:flex; gap:18px; flex-wrap:wrap; border-bottom:1px solid #d8d8d4; padding:8px 0; position:sticky; top:0; background:#f6f6f4; z-index:5; }
.vnews .vn-nav a { font-family:"IBM Plex Mono",monospace; font-size:12px; text-transform:uppercase; letter-spacing:0.05em; color:#55585e; }
.vnews .vn-nav a.active, .vnews .vn-nav a:hover { color:#16181c; }
.vnews h1,.vnews h2,.vnews h3 { font-family:Inter,system-ui,sans-serif; letter-spacing:-0.01em; }
.vnews .vn-sec-title { font-size:14px; text-transform:uppercase; letter-spacing:0.08em; color:#4fa0d8; border-bottom:2px solid #4fa0d8; display:inline-block; margin:28px 0 12px; padding-bottom:2px; }
.vnews .vn-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:20px; }
@media (max-width:820px){ .vnews .vn-grid{ grid-template-columns:1fr; } }
.vnews .vn-card { cursor:pointer; }
.vnews .vn-card img,.vnews .vn-hero img { width:100%; aspect-ratio:16/9; object-fit:cover; background:#e2e2dd; border-radius:3px; }
.vnews .vn-card h3 { font-size:17px; margin:8px 0 4px; }
.vnews .vn-card p { font-size:13px; color:#44474d; margin:0; }
.vnews .vn-byline { font-family:"IBM Plex Mono",monospace; font-size:11px; color:#80838a; margin-top:6px; }
.vnews .vn-hero { display:grid; grid-template-columns:1.4fr 1fr; gap:24px; margin:14px 0; }
.vnews .vn-hero h1 { font-size:34px; line-height:1.1; margin:10px 0; }
@media (max-width:820px){ .vnews .vn-hero{ grid-template-columns:1fr; } }
.vnews .vn-chip { font-family:"IBM Plex Mono",monospace; font-size:10px; text-transform:uppercase; padding:2px 6px; border-radius:2px; background:#16181c; color:#fff; }
/* story view */
.vnews .vn-article { max-width:760px; margin:0 auto; }
.vnews .vn-article p { font-size:18px; line-height:1.7; margin:0 0 18px; }
.vnews .vn-callout { background:#fff4f0; border-left:4px solid #d9480f; padding:14px 16px; border-radius:3px; margin:20px 0; }
.vnews .vn-callout h4 { margin:0 0 8px; color:#d9480f; font-size:13px; text-transform:uppercase; letter-spacing:0.06em; }
.vnews .vn-quote { background:#ffe3d6; padding:1px 4px; border-radius:2px; }
.vnews .vn-actions { background:#eef6fb; border-left:4px solid #4fa0d8; padding:14px 16px; border-radius:3px; margin:20px 0; }
.vnews .vn-proofs a { display:block; font-family:"IBM Plex Mono",monospace; font-size:12px; color:#1c6aa8; padding:3px 0; }
.vnews .vn-support img { width:100%; border-radius:3px; margin-top:8px; }
.vnews .vn-tag { font-family:"IBM Plex Mono",monospace; font-size:11px; background:#16181c; color:#fff; padding:2px 6px; border-radius:2px; margin:0 6px 6px 0; display:inline-block; }
```

- [ ] **Step 3: Add the routes (outside auth)**

In `apps/web/src/AppRouter.tsx`, add imports:

```tsx
import { VelocityNewsPage } from './news/VelocityNewsPage.js';
import { StoryView } from './news/StoryView.js';
```

Add these two routes inside `<Routes>` (alongside the others — they render their own full-page chrome and ignore `AuthProvider`'s auth gate since they never call `useAuth`):

```tsx
          <Route path="/news" element={<VelocityNewsPage />} />
          <Route path="/news/:id" element={<StoryView />} />
```

Also exclude `/news` from the floating TopBar chrome: in `TopBar`, change the early-return guard to also hide on news pages:

```tsx
  if (['/login', '/signup', '/forgot', '/reset'].includes(loc.pathname)) return null;
  if (loc.pathname.startsWith('/news')) return null;
```

> Note: Tasks 7 and 8 create `VelocityNewsPage` and `StoryView`; this task's typecheck will fail until those exist. Do Tasks 6→7→8 in order, then typecheck once at the end of Task 8. (If you prefer green-at-each-task, create empty stub components here first.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/news/types.ts apps/web/src/news/news.css apps/web/src/AppRouter.tsx
git commit -m "Add Velocity News types, editorial theme, and public routes"
```

---

### Task 7: VelocityNewsPage — masthead, categories, hero, grids

**Files:**
- Create: `apps/web/src/news/VelocityNewsPage.tsx`
- Test: typecheck (Task 8) + live (Task 9)

**Interfaces:**
- Consumes: `apiFetch` (`../transport/http.js`), `Edition`/`Story` types, `news.css`.
- Produces: default-exported-free named export `VelocityNewsPage`. Builds an absolute media URL via `backendUrl` for `supporting_docs` chips later; story images are absolute http(s) already.

- [ ] **Step 1: Write the component**

```tsx
// apps/web/src/news/VelocityNewsPage.tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../transport/http.js';
import type { Edition, Story } from './types.js';
import './news.css';

function Card({ s }: { s: Story }): JSX.Element {
  return (
    <Link to={`/news/${s.id}`} className="vn-card">
      {s.image ? <img src={s.image} alt="" loading="lazy" /> : <div className="vn-card-ph" style={{ aspectRatio: '16/9', background: '#e2e2dd', borderRadius: 3 }} />}
      <h3>{s.title}</h3>
      <p>{s.neutral_summary}</p>
      <div className="vn-byline">
        {s.category} · {s.corroboration?.source_count ?? 0} sources
        {s.whats_wrong?.length ? ` · ${s.whats_wrong.length} bias flags` : ''}
      </div>
    </Link>
  );
}

export function VelocityNewsPage(): JSX.Element {
  const [ed, setEd] = useState<Edition | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    apiFetch('/api/news/edition')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j: Edition) => { if (alive) setEd(j); })
      .catch(() => { if (alive) setErr(true); });
    return () => { alive = false; };
  }, []);

  const cats = ed?.categories ?? [];
  const lead = ed?.lead ?? null;
  const rest = (ed?.stories ?? []).filter((s) => s.id !== lead?.id);

  return (
    <div className="vnews">
      <div className="vn-wrap">
        <div className="vn-masthead">
          <Link to="/news" className="vn-brand">VELOCITY <b>NEWS</b></Link>
        </div>
        <nav className="vn-nav">
          {cats.map((c) => <a key={c} href={`#${c}`}>{c}</a>)}
        </nav>

        {!ed && !err && <p style={{ padding: '40px 0' }}>Loading the edition…</p>}
        {err && <p style={{ padding: '40px 0' }}>News is unavailable right now.</p>}
        {ed && ed.stories.length === 0 && (
          <p style={{ padding: '40px 0' }}>The edition is being assembled — check back shortly.</p>
        )}

        {lead && (
          <Link to={`/news/${lead.id}`} className="vn-hero">
            <div>
              {lead.image && <img src={lead.image} alt="" />}
            </div>
            <div>
              <span className="vn-chip">{lead.category}</span>
              <h1>{lead.title}</h1>
              <p>{lead.neutral_summary}</p>
              <div className="vn-byline">{lead.corroboration?.source_count ?? 0} sources corroborating</div>
            </div>
          </Link>
        )}

        {cats.map((c) => {
          const inCat = rest.filter((s) => s.category === c);
          if (inCat.length === 0) return null;
          return (
            <section key={c} id={c}>
              <div className="vn-sec-title">{c}</div>
              <div className="vn-grid">
                {inCat.map((s) => <Card key={s.id} s={s} />)}
              </div>
            </section>
          );
        })}

        {ed && (
          <p className="vn-byline" style={{ marginTop: 40 }}>
            {ed.article_count} articles · {ed.source_count} sources · model {ed.backend ?? 'n/a'}
          </p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/news/VelocityNewsPage.tsx
git commit -m "Add Velocity News front page (masthead, categories, hero, grids)"
```

---

### Task 8: StoryView — rewrite, what's-wrong callout, actions, proofs, supporting docs

**Files:**
- Create: `apps/web/src/news/StoryView.tsx`
- Test: `pnpm -r typecheck`

**Interfaces:**
- Consumes: `apiFetch`, `backendUrl` (`../transport/http.js`), `Edition`/`Story` types, `news.css`, route param `:id`.
- Produces: named export `StoryView`. Fetches the edition, finds the story by id (re-fetch keeps it stateless/bookmarkable). Highlights each `whats_wrong.quote` inside the rewrite text.

- [ ] **Step 1: Write the component**

```tsx
// apps/web/src/news/StoryView.tsx
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiFetch, backendUrl } from '../transport/http.js';
import type { Edition, Story } from './types.js';
import './news.css';

function highlight(text: string, quotes: string[]): (string | JSX.Element)[] {
  // Wrap each loaded quote found in the rewrite with a highlight span.
  let parts: (string | JSX.Element)[] = [text];
  quotes.filter(Boolean).forEach((q, qi) => {
    const next: (string | JSX.Element)[] = [];
    parts.forEach((p) => {
      if (typeof p !== 'string' || !p.includes(q)) { next.push(p); return; }
      const segs = p.split(q);
      segs.forEach((seg, i) => {
        if (seg) next.push(seg);
        if (i < segs.length - 1) next.push(<span key={`${qi}-${i}`} className="vn-quote">{q}</span>);
      });
    });
    parts = next;
  });
  return parts;
}

export function StoryView(): JSX.Element {
  const { id } = useParams();
  const [story, setStory] = useState<Story | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let alive = true;
    apiFetch('/api/news/edition')
      .then((r) => r.json())
      .then((j: Edition) => {
        if (!alive) return;
        const s = j.stories.find((x) => x.id === id) ?? null;
        if (s) setStory(s); else setMissing(true);
      })
      .catch(() => { if (alive) setMissing(true); });
    return () => { alive = false; };
  }, [id]);

  const allQuotes = story ? story.whats_wrong.map((w) => w.quote) : [];

  return (
    <div className="vnews">
      <div className="vn-wrap">
        <div className="vn-masthead">
          <Link to="/news" className="vn-brand">VELOCITY <b>NEWS</b></Link>
        </div>

        {missing && <p style={{ padding: '40px 0' }}><Link to="/news">← Back</Link> · Story not found.</p>}
        {!story && !missing && <p style={{ padding: '40px 0' }}>Loading…</p>}

        {story && (
          <article className="vn-article">
            <Link to="/news" className="vn-byline">← All stories</Link>
            <span className="vn-chip" style={{ marginLeft: 8 }}>{story.category}</span>
            <h1 style={{ fontSize: 32, margin: '12px 0' }}>{story.title}</h1>
            <div className="vn-byline">
              {story.corroboration?.source_count ?? 0} sources · confidence {(story.confidence ?? 0).toFixed(2)}
            </div>
            {story.image && <img src={story.image} alt="" style={{ width: '100%', borderRadius: 3, margin: '14px 0' }} />}

            {story.neutral_rewrite.split(/\n{2,}/).map((para, i) => (
              <p key={i}>{highlight(para, allQuotes)}</p>
            ))}

            {story.whats_wrong.length > 0 && (
              <div className="vn-callout">
                <h4>What's wrong with the coverage</h4>
                {story.whats_wrong.map((w, i) => (
                  <div key={i} style={{ marginBottom: 8 }}>
                    <span className="vn-tag">{w.technique || 'bias'}</span>
                    <strong>{w.source}</strong>: <span className="vn-quote">{w.quote}</span>
                  </div>
                ))}
                {story.propaganda_techniques.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    {story.propaganda_techniques.map((t) => <span key={t} className="vn-tag">{t}</span>)}
                  </div>
                )}
              </div>
            )}

            {story.recommended_actions.length > 0 && (
              <div className="vn-actions">
                <h4 style={{ margin: '0 0 8px', color: '#1c6aa8', fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.06em' }}>What you should do</h4>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {story.recommended_actions.map((a, i) => <li key={i} style={{ marginBottom: 4 }}>{a}</li>)}
                </ul>
              </div>
            )}

            {story.verified_facts.length > 0 && (
              <>
                <h3 style={{ marginTop: 24 }}>Verified facts</h3>
                <ul>{story.verified_facts.map((f, i) => <li key={i}>{f}</li>)}</ul>
              </>
            )}

            {story.proofs.length > 0 && (
              <div className="vn-proofs">
                <h3 style={{ marginTop: 24 }}>Proof &amp; sources</h3>
                {story.proofs.map((p, i) => (
                  <a key={i} href={p.url} target="_blank" rel="noreferrer">
                    {p.source} ↗ {p.published ? `(${p.published.slice(0, 10)})` : ''}
                  </a>
                ))}
              </div>
            )}

            {story.supporting_docs.length > 0 && (
              <div className="vn-support">
                <h3 style={{ marginTop: 24 }}>Supporting documents (live dashboard signals)</h3>
                {story.supporting_docs.map((d, i) => {
                  if (d.kind === 'satellite' && d.url) {
                    return (
                      <figure key={i} style={{ margin: '12px 0' }}>
                        <img src={backendUrl(d.url)} alt={d.caption ?? ''} />
                        <figcaption className="vn-byline">{d.caption}</figcaption>
                      </figure>
                    );
                  }
                  return (
                    <div key={i} style={{ margin: '10px 0' }}>
                      <span className="vn-tag">{d.threat_level || 'signal'}</span> {d.narrative}
                    </div>
                  );
                })}
                <Link to="/" className="vn-byline">Open the live dashboard →</Link>
              </div>
            )}
          </article>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd /home/andrew/Projects/OSINT && pnpm -r typecheck`
Expected: PASS (green). Fix any type mismatch against `types.ts`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/news/StoryView.tsx
git commit -m "Add Velocity News story view with bias callouts, actions, proofs, intel"
```

---

### Task 9: Live verification (operator standard)

**Files:** none (verification only)

- [ ] **Step 1: Boot backend + frontend**

```bash
cd /home/andrew/Projects/OSINT/apps/api && .venv/bin/uvicorn app.main:app --port 8000 &
cd /home/andrew/Projects/OSINT/apps/web && pnpm dev &
```

- [ ] **Step 2: Trigger an edition build** (first hit builds it; reason-tier is slow)

```bash
curl -s "http://127.0.0.1:8000/api/news/edition" | python3 -c "import sys,json; d=json.load(sys.stdin); print('stories', len(d['stories']), 'cats', d.get('categories'), 'method', d.get('method'), 'backend', d.get('backend'))"
```
Expected: `stories` > 0 (after a build cycle), categories listed, backend `minimaxai/minimax-m3` (or the fallback that's actually configured).

- [ ] **Step 3: Browser verification at 1920px (Playwright)**

Navigate to the dev URL `/news` UNAUTHENTICATED. Confirm:
- masthead "VELOCITY NEWS", category nav, a hero with image, ≥2 category sections with card grids and images.
- Click a story → full multi-paragraph rewrite, "What's wrong" callout with highlighted loaded quote(s) + technique tags, "What you should do" actions, proof links, and (for a Conflict story) a satellite chip image / incident narrative.
Screenshot each at 1920px and save under the gitignored screenshots dir.

- [ ] **Step 4: Backend suite + typecheck final gate**

```bash
cd /home/andrew/Projects/OSINT/apps/api && .venv/bin/pytest -q   # ≥25 passed
cd /home/andrew/Projects/OSINT && pnpm -r typecheck              # green
```

- [ ] **Step 5: Record outcome**

Tier each claim (proven-live / plumbed-unverified / not-built) with the evidence (curl output + screenshots). Update memory if anything non-obvious surfaced.

---

## Self-Review

**Spec coverage:**
- Many categorized stories → Task 3 (`_MAX_EDITION_EVENTS=40`, `category`) + Task 7 (sections). ✓
- Images (og:image + RSS media + dashboard media) → Task 1 (RSS media), Task 2 (og:image; wire into edition build if leads lack images — see note below), Task 4 (satellite chips). ✓
- Full neutral rewrite → Task 3 `neutral_rewrite`. ✓
- Bias/propaganda/name-calling callouts → Task 3 reuse + `whats_wrong`, Task 8 callout. ✓
- Recommended actions → Task 3 `recommended_actions`, Task 8. ✓
- Proofs (links + corroboration + media) → Task 3 `proofs`, Task 4 supporting_docs, Task 8. ✓
- Public page, no login → Task 6 routes outside auth chrome. ✓
- Same MiniMax-M3 model → `tier="reason"` throughout (Task 3). ✓
- BBC/CNN UI → Task 6 theme + Task 7/8. ✓

**Gap found + fix (og:image wiring):** Task 2 builds the enricher but the edition build never calls it. Add to Task 3's `analyze_edition`, after `ev["image"] = _lead_image(cluster)`:
```python
        if not ev["image"]:
            from app.news.images import fetch_og_image  # noqa: PLC0415
            for a in cluster:
                if a.link:
                    ev["image"] = await fetch_og_image(a.link)
                    if ev["image"]:
                        break
```
This keeps og:image scraping bounded to published leads only (≤40), per the spec. Include this in Task 3 Step 3.

**Placeholder scan:** none — every code/test step has real content.

**Type consistency:** `analyze_edition` story keys (`id`, `category`, `neutral_rewrite`, `recommended_actions`, `whats_wrong{source,technique,quote}`, `proofs{source,url,published}`, `supporting_docs`, `image`) match `types.ts` and the React components. `EDITION_CATEGORIES` exported from `analyze.py`, imported by the route's `_empty_edition`. Edition endpoint shape (`categories`, `lead`, `stories`, `method`, `backend`, `article_count`, `source_count`) matches `Edition` in `types.ts`. ✓

**Implementation note to verify at build time:** confirm `app.intel.incidents.brief()`'s exact callable name + sync/async + return shape by reading `apps/api/app/intel/incidents.py` before Task 4 Step 3; adapt `_incident_brief` accordingly (the route handler is off-limits in-process).
