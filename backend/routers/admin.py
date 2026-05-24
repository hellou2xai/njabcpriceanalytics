"""
Admin-only endpoints (visibility for the owner).

Access is restricted by require_admin (email in ADMIN_EMAILS). For now that is
the owner; set ADMIN_EMAILS on the server to add more.
"""

from fastapi import APIRouter, Depends

from backend.pg import get_pg
from backend.auth import require_admin

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
