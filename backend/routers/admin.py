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
            """SELECT u.id, u.email, u.full_name, u.activated, u.created_at,
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
