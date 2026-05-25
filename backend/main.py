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

from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from dotenv import load_dotenv

# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv()

from backend.db import init_user_db
from backend.auth import router as auth_router, get_current_user
from backend.routers import catalog, analytics, deals, intelligence, user_state, alerts, qa, websearch, stores, feedback, admin, consent

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


@app.on_event("startup")
def startup():
    """Create the user-state tables in Postgres, then warm the pricing cache."""
    init_user_db()
    try:
        from backend.pricing_cache import build_pricing_cache
        build_pricing_cache()
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
    with get_duckdb() as con:
        counts = {t: con.execute(f"SELECT count(*) FROM {t}").fetchone()[0] for t in ALL_TABLES}
    return {"status": "reloaded", "counts": counts}


@app.get("/api/health")
def health():
    """Health check for Render. Stays 200 even before the pricing cache is
    populated (first deploy, ingestion not yet run), so the service comes up
    healthy; the happy-path response is unchanged once pricing is loaded."""
    from backend.db import get_duckdb, read_parquet
    from backend.mailer import MAIL_ENABLED
    try:
        with get_duckdb() as con:
            src = read_parquet(con, "cpl")
            count = con.execute(f"SELECT count(*) FROM {src}").fetchone()[0]
        return {"status": "ok", "cpl_rows": count, "mail_enabled": MAIL_ENABLED}
    except Exception:
        return {"status": "starting", "cpl_rows": None, "mail_enabled": MAIL_ENABLED}


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
