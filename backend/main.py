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

from fastapi import FastAPI, Depends, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from dotenv import load_dotenv

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv()

from backend.db import init_user_db
from backend.auth import router as auth_router, get_current_user
from backend.routers import catalog, analytics, deals, intelligence, user_state, alerts, qa, websearch, stores, feedback, admin, consent, settings, share, todos, activity, lists, cart

app = FastAPI(
    title="NJ ABC Price Intelligence",
    version="0.1.0",
    description="Wholesale beverage price analytics for New Jersey ABC licensees",
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
        from backend.routers.deals import warm_rip_cache
        threading.Thread(target=warm_rip_cache, daemon=True).start()
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
            from backend.routers.analytics import warm_pm_cache_async
            warm_pm_cache_async()
        except Exception as e:
            print(f"[startup] price-movers cache warm skipped: {e}")
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
    build_pricing_cache()
    # Rebuild the RIP tier cache against the new data, in the background.
    import threading
    from backend.routers.deals import warm_rip_cache
    threading.Thread(target=warm_rip_cache, daemon=True).start()
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
        from backend.routers.analytics import warm_pm_cache_async
        warm_pm_cache_async()
    except Exception as e:
        print(f"[reload] price-movers cache warm skipped: {e}")


@app.post("/api/admin/blurbs/generate")
def admin_generate_blurbs(limit: int = 10, user: dict = Depends(get_current_user)):
    """Synchronously generate up to `limit` AI deal blurbs and return counts +
    the first error if any. Diagnostic only; the background warm runs at start."""
    import os, traceback
    from backend.ai_blurbs import generate_blurbs_batch, _candidates, _client_or_none
    out: dict = {
        "key_present": bool(os.getenv("ANTHROPIC_API_KEY")),
        "client_ok": _client_or_none() is not None,
    }
    try:
        out["candidates"] = len(_candidates(limit=max(limit, 5)))
    except Exception as e:
        out["candidates_error"] = f"{type(e).__name__}: {e}"
        out["candidates_trace"] = traceback.format_exc().splitlines()[-3:]
    try:
        out["written"] = generate_blurbs_batch(limit=limit)
    except Exception as e:
        out["written_error"] = f"{type(e).__name__}: {e}"
        out["written_trace"] = traceback.format_exc().splitlines()[-3:]
    # Also generate mover blurbs for both directions.
    try:
        from backend.ai_mover_blurbs import generate_mover_blurbs_batch
        out["movers_down"] = generate_mover_blurbs_batch("down", limit=limit)
        out["movers_up"] = generate_mover_blurbs_batch("up", limit=limit)
    except Exception as e:
        out["movers_error"] = f"{type(e).__name__}: {e}"
    # PG diagnostic: how many rows exist + a small sample.
    try:
        from backend.pg import get_pg
        with get_pg() as pg:
            row = pg.execute("SELECT COUNT(*) AS n FROM ai_deal_blurbs").fetchone()
            out["pg_count"] = int(row["n"]) if row else 0
            row2 = pg.execute("SELECT COUNT(*) AS n FROM ai_mover_blurbs").fetchone()
            out["pg_movers_count"] = int(row2["n"]) if row2 else 0
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
