"""
Admin-only endpoints (visibility for the owner).

Access is restricted by require_admin (email in ADMIN_EMAILS). For now that is
the owner; set ADMIN_EMAILS on the server to add more.
"""

from fastapi import APIRouter, Depends, HTTPException

from backend.pg import get_pg
from backend.auth import require_admin, _is_admin

router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.get("/stats")
def stats(user: dict = Depends(require_admin)):
    """High-level counts across the user-data tables."""
    counts = {}
    with get_pg() as con:
        for table in ("users", "feedback", "orders", "order_lines", "stores", "user_notes", "watchlist"):
            n = con.execute(f"SELECT count(*) AS n FROM {table}").fetchone()["n"]
            counts[table] = n
        # Feedback split by kind for a quick read.
        kinds = con.execute(
            "SELECT COALESCE(kind, 'unspecified') AS kind, count(*) AS n "
            "FROM feedback GROUP BY COALESCE(kind, 'unspecified') ORDER BY n DESC"
        ).fetchall()
    return {"counts": counts, "feedback_by_kind": [dict(k) for k in kinds]}


@router.get("/users")
def list_users(user: dict = Depends(require_admin)):
    """All users with activation state and per-user counts. is_admin is derived
    from the email allowlist (ADMIN_EMAILS), not stored."""
    with get_pg() as con:
        rows = con.execute(
            """SELECT u.id, u.email, u.full_name, u.phone, u.activated, u.created_at,
                      (SELECT count(*) FROM orders o WHERE o.user_id = u.id) AS orders,
                      (SELECT count(*) FROM stores s WHERE s.user_id = u.id) AS stores
               FROM users u
               ORDER BY u.created_at DESC, u.id DESC"""
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["is_admin"] = _is_admin(d["email"])
        out.append(d)
    return out


@router.get("/users/{user_id}")
def user_detail(user_id: int, user: dict = Depends(require_admin)):
    """One user plus their orders, stores, notes, watchlist and feedback."""
    with get_pg() as con:
        u = con.execute(
            "SELECT id, email, full_name, phone, activated, tos_accepted_at, created_at FROM users WHERE id = %s",
            (user_id,)
        ).fetchone()
        if not u:
            raise HTTPException(status_code=404, detail="User not found")
        orders_ = con.execute(
            "SELECT id, name, status, distributor, created_at, updated_at FROM orders WHERE user_id = %s ORDER BY updated_at DESC",
            (user_id,)).fetchall()
        stores_ = con.execute(
            "SELECT id, name, formatted_address, phone FROM stores WHERE user_id = %s ORDER BY name", (user_id,)).fetchall()
        notes_ = con.execute(
            "SELECT id, product_name, wholesaler, note, created_at FROM user_notes WHERE user_id = %s AND deleted = 0 ORDER BY created_at DESC",
            (user_id,)).fetchall()
        wl = con.execute(
            "SELECT id, product_name, wholesaler, target_price FROM watchlist WHERE user_id = %s ORDER BY created_at DESC",
            (user_id,)).fetchall()
        fb = con.execute(
            "SELECT id, kind, message, page, created_at FROM feedback WHERE user_id = %s ORDER BY created_at DESC",
            (user_id,)).fetchall()
    d = dict(u)
    d["is_admin"] = _is_admin(d["email"])
    return {
        "user": d,
        "orders": [dict(r) for r in orders_],
        "stores": [dict(r) for r in stores_],
        "notes": [dict(r) for r in notes_],
        "watchlist": [dict(r) for r in wl],
        "feedback": [dict(r) for r in fb],
    }


_DETAIL_QUERIES = {
    "orders": "SELECT o.id, u.email AS user, o.name, o.distributor, o.status, o.created_at "
              "FROM orders o LEFT JOIN users u ON u.id = o.user_id ORDER BY o.created_at DESC LIMIT 1000",
    "order_lines": "SELECT ol.id, u.email AS user, ol.product_name, ol.wholesaler, ol.qty_cases, ol.qty_units "
                   "FROM order_lines ol LEFT JOIN orders o ON o.id = ol.order_id LEFT JOIN users u ON u.id = o.user_id "
                   "ORDER BY ol.id DESC LIMIT 1000",
    "stores": "SELECT s.id, u.email AS user, s.name, s.formatted_address, s.phone "
              "FROM stores s LEFT JOIN users u ON u.id = s.user_id ORDER BY s.name LIMIT 1000",
    "user_notes": "SELECT n.id, u.email AS user, n.product_name, n.wholesaler, n.note, n.created_at "
                  "FROM user_notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.deleted = 0 ORDER BY n.created_at DESC LIMIT 1000",
    "watchlist": "SELECT w.id, u.email AS user, w.product_name, w.wholesaler, w.target_price "
                 "FROM watchlist w LEFT JOIN users u ON u.id = w.user_id ORDER BY w.created_at DESC LIMIT 1000",
}


@router.get("/detail/{entity}")
def detail(entity: str, user: dict = Depends(require_admin)):
    """Rows for a stat-card drill-down (joined to the owning user's email)."""
    sql = _DETAIL_QUERIES.get(entity)
    if not sql:
        raise HTTPException(status_code=404, detail="Unknown entity")
    with get_pg() as con:
        rows = con.execute(sql).fetchall()
    return [dict(r) for r in rows]


@router.post("/users/{user_id}/activate")
def activate_user(user_id: int, user: dict = Depends(require_admin)):
    with get_pg() as con:
        con.execute("UPDATE users SET activated = 1 WHERE id = %s", (user_id,))
    return {"status": "activated"}


@router.post("/users/{user_id}/deactivate")
def deactivate_user(user_id: int, user: dict = Depends(require_admin)):
    if user_id == user["id"]:
        raise HTTPException(status_code=400, detail="You cannot deactivate your own account.")
    with get_pg() as con:
        con.execute("UPDATE users SET activated = 0 WHERE id = %s", (user_id,))
        con.execute("DELETE FROM auth_tokens WHERE user_id = %s", (user_id,))  # end their sessions
    return {"status": "deactivated"}


@router.delete("/users/{user_id}")
def delete_user(user_id: int, user: dict = Depends(require_admin)):
    """Delete a user and all of their data (cascades). Admins cannot be deleted
    here, and you cannot delete your own account."""
    if user_id == user["id"]:
        raise HTTPException(status_code=400, detail="You cannot delete your own account.")
    with get_pg() as con:
        target = con.execute("SELECT email FROM users WHERE id = %s", (user_id,)).fetchone()
        if not target:
            raise HTTPException(status_code=404, detail="User not found")
        if _is_admin(target["email"]):
            raise HTTPException(status_code=400, detail="Cannot delete an admin account.")
        con.execute("DELETE FROM users WHERE id = %s", (user_id,))
    return {"status": "deleted"}


@router.post("/reload-pricing")
def reload_pricing_admin(user: dict = Depends(require_admin)):
    """Rebuild the pricing cache from Postgres (use after a monthly ingestion).
    Mirrors the top-level endpoint so it is reachable from the admin page."""
    from backend.pricing_cache import build_pricing_cache, ALL_TABLES
    from backend.db import get_duckdb
    build_pricing_cache()
    with get_duckdb() as con:
        counts = {t: con.execute(f"SELECT count(*) FROM {t}").fetchone()[0] for t in ALL_TABLES}
    return {"status": "reloaded", "counts": counts}
