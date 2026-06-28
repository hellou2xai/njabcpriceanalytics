"""Admin product-image overrides.

An admin can upload/replace a product's image. Rather than rebuild the whole
pricing cache for one image (~30s), we keep a tiny `image_overrides` table
(normalised UPC -> R2 url) and OVERLAY it on the Go-UPC enrichment image at serve
time (backend/enrichment_join.attach_enrichment_image). The override therefore
shows IMMEDIATELY and everywhere, and persists across cache rebuilds (it's an
independent live lookup, and it wins over any auto Go-UPC image). The map is tiny
(admin overrides are few) so it's cached in-process with a short TTL and
invalidated on write.
"""
import threading
import time

_lock = threading.Lock()
_cache: "dict | None" = None
_cache_at = 0.0
_TTL = 20.0  # seconds


def _ensure(con) -> None:
    con.execute(
        "CREATE TABLE IF NOT EXISTS image_overrides ("
        "upc text PRIMARY KEY, image_url text NOT NULL, "
        "updated_at text, updated_by text)")


def get_map() -> dict:
    """{normalised_upc: image_url} for admin overrides. Cached (TTL); degrades to
    an empty map if the table/DB is unavailable so it never breaks the catalogue."""
    global _cache, _cache_at
    now = time.time()
    with _lock:
        if _cache is not None and now - _cache_at < _TTL:
            return _cache
    m: dict = {}
    try:
        from backend.pg import get_pg
        with get_pg() as con:
            for upc, url in con.execute(
                    "SELECT upc, image_url FROM image_overrides").fetchall():
                if url:
                    m[str(upc)] = str(url)
    except Exception:
        m = {}
    with _lock:
        _cache, _cache_at = m, time.time()
    return m


def set_override(upc_norm: str, url: str, by: str) -> None:
    """Upsert one override (admin upload) and invalidate the in-process cache."""
    from backend.pg import get_pg
    with get_pg() as con:
        _ensure(con)
        con.execute(
            "INSERT INTO image_overrides (upc, image_url, updated_at, updated_by) "
            "VALUES (%s, %s, now()::text, %s) "
            "ON CONFLICT (upc) DO UPDATE SET image_url = EXCLUDED.image_url, "
            "updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by",
            (upc_norm, url, by))
    global _cache, _cache_at
    with _lock:
        _cache, _cache_at = None, 0.0
