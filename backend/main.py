"""
NJ ABC Price Intelligence â€” FastAPI Backend.

Serves the React frontend and provides API endpoints for:
  - Catalog browsing, search, filtering
  - Analytics (price movers, lifecycle, cross-source)
  - Deals (discounts, clearance, combos, RIPs)
  - Decision intelligence (buy signals, buy sheet, scorecard)
  - User state (watchlist, orders, notes, alerts)

All analytical queries run against Parquet files via DuckDB (stateless).
User state is persisted in a local SQLite database.
"""

import os
import sys
from pathlib import Path

import math as _math
from fastapi import FastAPI, Depends, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from dotenv import load_dotenv


def _json_sanitize(o):
    """Recursively replace NaN/Inf floats with None so a stray NaN from the
    pandas/parquet data can never break JSON serialization (FastAPI's default
    json.dumps uses allow_nan=False and 500s on NaN — the prod cart /
    product-variant-upcs failures)."""
    if isinstance(o, float):
        return o if _math.isfinite(o) else None
    if isinstance(o, dict):
        return {k: _json_sanitize(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_json_sanitize(v) for v in o]
    return o


class CleanJSONResponse(JSONResponse):
    """App-wide JSON response that nulls out non-finite floats before encoding."""
    def render(self, content) -> bytes:
        return super().render(_json_sanitize(content))

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv()

from backend.db import init_user_db
from backend.auth import router as auth_router, get_current_user, require_admin
from backend.routers import catalog, analytics, deals, intelligence, user_state, alerts, qa, websearch, stores, feedback, admin, consent, settings, share, todos, activity, lists, cart, assistant, ai_feedback, digest, compare
from procurement_agents.api import router as procurement_agents_router

app = FastAPI(
    title="NJ ABC Price Intelligence",
    version="0.1.0",
    description="Wholesale beverage price analytics for New Jersey ABC licensees",
    default_response_class=CleanJSONResponse,   # NaN/Inf -> null, app-wide
)

# CORS â€” allow React dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",  # Vite dev server
        "http://localhost:3000",
        os.getenv("RENDER_EXTERNAL_URL", ""),
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Compress responses (PERF_TODO baseline). Grid/board JSON is 79-180 KB and
# compresses to ~1/6 on the wire; minimum_size skips tiny payloads where the
# gzip overhead would not pay off. The client opts in via Accept-Encoding, so
# this is transparent to any caller that doesn't send it.
app.add_middleware(GZipMiddleware, minimum_size=1000)


# Long-lived caching for the hashed, immutable JS/CSS bundle (PERF_TODO baseline).
# Vite emits content-hashed filenames under /assets, so each build's files are
# immutable and can be cached forever; a new deploy changes the hash and
# index.html stays no-cache (see serve_spa), so users still pick up new builds.
# Without this the ~2 MB bundle is re-fetched (or revalidated) on every visit.
@app.middleware("http")
async def _immutable_assets(request, call_next):
    resp = await call_next(request)
    path = request.url.path
    if path.startswith("/assets/"):
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif path.startswith("/api/"):
        # CDN safety net (default-deny). The user-independent boards opt INTO
        # edge caching by setting `Cache-Control: public` themselves (via
        # http_cache.public_conditional). EVERY other /api response — auth,
        # cart, lists, watchlist, orders, the assistant — must never be cached
        # by a shared cache, or a Cloudflare "Cache Everything" rule could serve
        # one tenant's data to another. Mark anything not already opted in
        # `private, no-store` so the edge is forced to skip it.
        if "cache-control" not in (k.lower() for k in resp.headers.keys()):
            resp.headers["Cache-Control"] = "private, no-store"
    return resp

# Register routers
app.include_router(auth_router)
app.include_router(stores.router)
app.include_router(catalog.router)
app.include_router(analytics.router)
app.include_router(deals.router)
app.include_router(intelligence.router)
app.include_router(user_state.router)
app.include_router(alerts.router)
app.include_router(qa.router)
app.include_router(websearch.router)
app.include_router(feedback.router)
app.include_router(admin.router)
app.include_router(consent.router)
app.include_router(settings.router)
app.include_router(share.router)
app.include_router(todos.router)
app.include_router(activity.router)
app.include_router(lists.router)
app.include_router(cart.router)
app.include_router(digest.router)
app.include_router(compare.router)
app.include_router(assistant.router)
app.include_router(ai_feedback.router)
app.include_router(procurement_agents_router)


# --- Observability: capture EVERY unhandled error with its full traceback ---
# Render only keeps stderr, which isn't easy to grep live, so we (a) always log
# the traceback and (b) return it IN THE RESPONSE to ADMIN callers, so a 500 in
# prod is diagnosable by curling the failing endpoint with an admin token. Also
# kept in a small ring buffer, exposed at /api/admin/errors for the in-app view.
import logging as _logging
import traceback as _traceback
from collections import deque as _deque
from fastapi import Request as _Request
from fastapi.responses import JSONResponse as _JSONResponse

_err_log = _logging.getLogger("celr.errors")
RECENT_ERRORS: "_deque" = _deque(maxlen=100)


@app.exception_handler(Exception)
async def _capture_unhandled(request: "_Request", exc: Exception):
    tb = _traceback.format_exc()
    entry = {"path": str(request.url.path), "method": request.method,
             "error": f"{type(exc).__name__}: {exc}", "traceback": tb,
             "query": str(request.url.query)}
    try:
        from backend.db import NOW_UTC  # noqa
        import datetime as _dt
        entry["at"] = _dt.datetime.now(_dt.timezone.utc).isoformat()
    except Exception:
        pass
    RECENT_ERRORS.appendleft(entry)
    _err_log.error("UNHANDLED %s %s\n%s", request.method, request.url.path, tb)
    body = {"detail": "Internal Server Error"}
    # Admins see the traceback inline so prod issues are diagnosable on the spot.
    try:
        from backend.auth import _token_from_header, _user_for_token
        from backend.pg import get_pg
        tok = _token_from_header(request.headers.get("authorization"))
        if tok:
            with get_pg() as con:
                u = _user_for_token(con, tok)
            if u and u.get("is_admin"):
                body.update({"error": entry["error"], "traceback": tb, "path": entry["path"]})
    except Exception:
        pass
    return _JSONResponse(status_code=500, content=body)


@app.get("/api/admin/errors")
def _recent_errors(user: dict = Depends(require_admin)):
    """Recent unhandled server errors (admin only) — the in-app prod error view."""
    return {"count": len(RECENT_ERRORS), "errors": list(RECENT_ERRORS)}


@app.on_event("startup")
def startup():
    """Create the user-state tables in Postgres, then warm the pricing cache."""
    init_user_db()
    try:
        from backend.pricing_cache import build_pricing_cache
        build_pricing_cache()
        # Warm the RIP Products tier cache in the background so the first open of
        # that (heavy) page is instant. Never blocks startup or the health check.
        import threading
        from backend.routers.deals import (
            warm_rip_cache, warm_time_sensitive_cache,
            warm_combos_cache, warm_discounts_cache)
        threading.Thread(target=warm_rip_cache, daemon=True).start()
        # Prime the Time-Sensitive Deals payload so the first open is instant.
        threading.Thread(target=warm_time_sensitive_cache, daemon=True).start()
        # Prime the compare boards, combos, discounts, and new-items so the
        # first visitor after a deploy doesn't pay the 7-20s cold-compute cost.
        # Runs sequentially inside one thread (DuckDB is single-threaded).
        from backend.routers.compare import warm_board_caches
        from backend.routers.catalog import warm_new_items
        threading.Thread(
            target=lambda: [
                warm_board_caches(),
                warm_combos_cache(),
                warm_discounts_cache(),
                warm_new_items(),
            ],
            daemon=True,
        ).start()
        # Prime the default Products grid response (perf #2 memo) so the first
        # visitor doesn't eat the cold catalog query.
        try:
            from backend.routers.catalog import warm_catalog_grid
            threading.Thread(target=warm_catalog_grid, daemon=True).start()
        except Exception as e:
            print(f"[startup] catalog grid warm skipped: {e}")
        # Generate any missing AI deal blurbs for the Time-Sensitive Deals page.
        # No-op if ANTHROPIC_API_KEY is unset, capped per run.
        try:
            from backend.ai_blurbs import warm_blurbs_async
            warm_blurbs_async()
        except Exception as e:
            print(f"[startup] blurb generation skipped: {e}")
        try:
            from backend.ai_mover_blurbs import warm_mover_blurbs_async
            warm_mover_blurbs_async()
        except Exception as e:
            print(f"[startup] mover-blurb generation skipped: {e}")
        try:
            from backend.ai_product_blurbs import warm_product_blurbs_async
            warm_product_blurbs_async()
        except Exception as e:
            print(f"[startup] product-blurb generation skipped: {e}")
        try:
            from backend.routers.analytics import warm_pm_cache_async
            warm_pm_cache_async()
        except Exception as e:
            print(f"[startup] price-movers cache warm skipped: {e}")
        # Ensure the FTS GIN index on product_enrichment exists so the
        # semantic-search endpoint stays fast. Idempotent; no-op if the
        # index is already present from a prior run.
        try:
            from backend.semantic_search import ensure_fts_index
            from backend.pg import get_pg
            with get_pg() as pg:
                ensure_fts_index(pg)
        except Exception as e:
            print(f"[startup] semantic-search index ensure skipped: {e}")
    except Exception as e:
        # If the pricing tables aren't in Postgres yet (no ingestion run), the
        # cache builds lazily on the first request instead of blocking startup.
        print(f"[startup] pricing cache deferred: {e}")


@app.on_event("shutdown")
def shutdown():
    """Close the Postgres connection pool cleanly."""
    from backend.pg import close_pool
    close_pool()


@app.post("/api/admin/reload-pricing")
def reload_pricing(user: dict = Depends(get_current_user)):
    """Rebuild the pricing cache from Postgres after a monthly ingestion.
    Auth-guarded; a signed-in owner can refresh without a redeploy."""
    from backend.pricing_cache import build_pricing_cache, ALL_TABLES
    from backend.db import get_duckdb
    build_pricing_cache(force=True)  # always rebuild + republish from new data
    # Rebuild the RIP tier cache against the new data, in the background.
    import threading
    from backend.routers.deals import (
        warm_rip_cache, clear_time_sensitive_cache, warm_time_sensitive_cache,
        warm_combos_cache, warm_discounts_cache)
    from backend.routers.compare import warm_board_caches
    from backend.routers.catalog import warm_new_items
    clear_time_sensitive_cache()   # drop the cached Time-Sensitive payloads
    threading.Thread(target=warm_rip_cache, daemon=True).start()
    threading.Thread(target=warm_time_sensitive_cache, daemon=True).start()
    threading.Thread(
        target=lambda: [
            warm_board_caches(),
            warm_combos_cache(),
            warm_discounts_cache(),
            warm_new_items(),
        ],
        daemon=True,
    ).start()
    # Re-warm the default Products grid memo (auto-invalidated by the new
    # pricing file path) so the post-reload first visitor stays instant.
    try:
        from backend.routers.catalog import warm_catalog_grid
        threading.Thread(target=warm_catalog_grid, daemon=True).start()
    except Exception as e:
        print(f"[reload] catalog grid warm skipped: {e}")
    # Re-run AI deal blurb generation for new products surfaced by this reload.
    try:
        from backend.ai_blurbs import warm_blurbs_async
        warm_blurbs_async()
    except Exception as e:
        print(f"[reload] blurb generation skipped: {e}")
    try:
        from backend.ai_mover_blurbs import warm_mover_blurbs_async
        warm_mover_blurbs_async()
    except Exception as e:
        print(f"[reload] mover-blurb generation skipped: {e}")
    try:
        from backend.ai_product_blurbs import warm_product_blurbs_async
        warm_product_blurbs_async()
    except Exception as e:
        print(f"[reload] product-blurb generation skipped: {e}")
    try:
        from backend.routers.analytics import warm_pm_cache_async
        warm_pm_cache_async()
    except Exception as e:
        print(f"[reload] price-movers cache warm skipped: {e}")


@app.post("/api/admin/blurbs/generate")
def admin_generate_blurbs(limit: int = 50, user: dict = Depends(require_admin)):
    """Synchronously generate up to `limit` AI blurbs of each kind (deal,
    mover-down, mover-up, product) and return counts + first error if any.
    Use the Admin page button or POST it directly with ?limit=<N>."""
    import os, traceback
    from backend.ai_blurbs import generate_blurbs_batch, _candidates, _client_or_none
    out: dict = {
        "key_present": bool(os.getenv("ANTHROPIC_API_KEY")),
        "client_ok": _client_or_none() is not None,
        "limit": int(limit),
    }
    try:
        out["candidates"] = len(_candidates(limit=max(limit, 5)))
    except Exception as e:
        out["candidates_error"] = f"{type(e).__name__}: {e}"
        out["candidates_trace"] = traceback.format_exc().splitlines()[-3:]
    try:
        out["deal_written"] = generate_blurbs_batch(limit=limit)
    except Exception as e:
        out["deal_error"] = f"{type(e).__name__}: {e}"
        out["deal_trace"] = traceback.format_exc().splitlines()[-3:]
    try:
        from backend.ai_mover_blurbs import generate_mover_blurbs_batch
        out["mover_down_written"] = generate_mover_blurbs_batch("down", limit=limit)
        out["mover_up_written"] = generate_mover_blurbs_batch("up", limit=limit)
    except Exception as e:
        out["mover_error"] = f"{type(e).__name__}: {e}"
        out["mover_trace"] = traceback.format_exc().splitlines()[-3:]
    try:
        from backend.ai_product_blurbs import generate_blurbs_batch as gen_product
        out["product_written"] = gen_product(limit=limit)
    except Exception as e:
        out["product_error"] = f"{type(e).__name__}: {e}"
        out["product_trace"] = traceback.format_exc().splitlines()[-3:]
    try:
        from backend.pg import get_pg
        with get_pg() as pg:
            row = pg.execute("SELECT COUNT(*) AS n FROM ai_deal_blurbs").fetchone()
            out["pg_deal_total"] = int(row["n"]) if row else 0
            row2 = pg.execute("SELECT COUNT(*) AS n FROM ai_mover_blurbs").fetchone()
            out["pg_mover_total"] = int(row2["n"]) if row2 else 0
            row3 = pg.execute("SELECT COUNT(*) AS n FROM ai_product_blurbs").fetchone()
            out["pg_product_total"] = int(row3["n"]) if row3 else 0
    except Exception as e:
        out["pg_error"] = f"{type(e).__name__}: {e}"
    return out
    with get_duckdb() as con:
        counts = {t: con.execute(f"SELECT count(*) FROM {t}").fetchone()[0] for t in ALL_TABLES}
    return {"status": "reloaded", "counts": counts}


@app.get("/api/health")
def health():
    """Liveness probe. Always returns 200 once the process is up so monitoring
    (and Render's own keepalive) sees the service as alive even while the
    pricing cache is still warming on a fresh disk."""
    from backend.db import get_duckdb, read_parquet
    from backend.mailer import MAIL_ENABLED
    try:
        with get_duckdb() as con:
            src = read_parquet(con, "cpl")
            count = con.execute(f"SELECT count(*) FROM {src}").fetchone()[0]
        return {"status": "ok", "cpl_rows": count, "mail_enabled": MAIL_ENABLED}
    except Exception:
        return {"status": "starting", "cpl_rows": None, "mail_enabled": MAIL_ENABLED}


@app.get("/api/ready")
def ready(response: Response):
    """Readiness probe. Returns 200 ONLY when the pricing cache is built and
    data endpoints can serve real traffic; returns 503 while booting.

    Point Render's healthCheckPath at this so a new deploy keeps the OLD
    instance receiving traffic until the NEW instance can actually serve data.
    That gives a true zero-downtime rollout instead of the gap users hit while
    the new container is busy copying ~130k rows from Postgres into DuckDB."""
    from backend.db import get_duckdb, read_parquet
    try:
        with get_duckdb() as con:
            src = read_parquet(con, "cpl")
            count = con.execute(f"SELECT count(*) FROM {src}").fetchone()[0]
        if not count or count <= 0:
            response.status_code = 503
            return {"status": "starting", "cpl_rows": count}
        return {"status": "ready", "cpl_rows": count}
    except Exception as e:
        response.status_code = 503
        return {"status": "starting", "cpl_rows": None, "error": f"{type(e).__name__}"}


# In production (Render), serve the built React frontend with an SPA fallback:
# client-side routes (e.g. /dashboard) and page refreshes return index.html
# instead of a 404. API routes are registered above, so they take precedence.
frontend_dist = Path(__file__).parent.parent / "frontend" / "dist"
print(f"[startup] frontend dist {frontend_dist}: {'found' if frontend_dist.exists() else 'MISSING'}")
if frontend_dist.exists():
    _assets = frontend_dist / "assets"
    if _assets.exists():
        app.mount("/assets", StaticFiles(directory=str(_assets)), name="assets")

    @app.get("/{full_path:path}")
    def serve_spa(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not Found")
        candidate = frontend_dist / full_path
        if full_path and candidate.is_file():
            return FileResponse(str(candidate))
        # index.html must never be cached, or browsers keep loading the previous
        # build's JS after a deploy. The hashed assets it points to are immutable.
        return FileResponse(str(frontend_dist / "index.html"),
                            headers={"Cache-Control": "no-cache, no-store, must-revalidate"})
