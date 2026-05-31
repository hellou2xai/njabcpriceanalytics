"""AI assistant rating and feedback.

Every assistant reply (Celar full page, global dock, Catalog sidebar, ...) gets a
thumbs-up / thumbs-down. "Good" logs the rating; "Bad" opens a modal that asks
for free-text details, then submits both together. Admins read the rollup at
/admin/ai-feedback.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from backend.pg import get_pg
from backend.auth import get_optional_user, require_admin

router = APIRouter(prefix="/api/ai-feedback", tags=["ai-feedback"])


class RatingIn(BaseModel):
    surface: str                       # 'celar', 'catalog', 'global-dock', ...
    rating: str                        # 'good' | 'bad'
    question: Optional[str] = None
    answer: Optional[str] = None
    details: Optional[str] = None      # the popup text (bad only)
    page: Optional[str] = None
    model: Optional[str] = None
    user_agent: Optional[str] = None


@router.post("")
def submit(body: RatingIn, user: Optional[dict] = Depends(get_optional_user)):
    if body.rating not in ("good", "bad"):
        raise HTTPException(status_code=422, detail="rating must be 'good' or 'bad'")
    surface = (body.surface or "").strip()[:60] or "unknown"
    with get_pg() as con:
        con.execute(
            """INSERT INTO ai_feedback
                 (user_id, user_email, surface, rating, question, answer,
                  details, page, model, user_agent)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (
                user["id"] if user else None,
                user["email"] if user else None,
                surface,
                body.rating,
                (body.question or "")[:4000] or None,
                (body.answer or "")[:8000] or None,
                (body.details or "")[:4000] or None,
                (body.page or "")[:300] or None,
                (body.model or "")[:80] or None,
                (body.user_agent or "")[:500] or None,
            ),
        )
    return {"status": "received"}


@router.get("/admin")
def admin_list(
    from_date: Optional[str] = Query(None, description="YYYY-MM-DD inclusive"),
    to_date: Optional[str] = Query(None, description="YYYY-MM-DD inclusive"),
    rating: Optional[str] = Query(None, description="'good' | 'bad'"),
    surface: Optional[str] = Query(None),
    user: dict = Depends(require_admin),
):
    """Admin rollup of AI assistant ratings: per-surface counts + recent rows."""
    where, params = [], []
    if from_date:
        where.append("created_at >= %s"); params.append(f"{from_date} 00:00:00")
    if to_date:
        where.append("created_at <= %s"); params.append(f"{to_date} 23:59:59")
    if rating in ("good", "bad"):
        where.append("rating = %s"); params.append(rating)
    if surface:
        where.append("surface = %s"); params.append(surface)
    wc = (" WHERE " + " AND ".join(where)) if where else ""
    with get_pg() as con:
        per_surface = con.execute(
            f"""SELECT surface,
                       SUM(CASE WHEN rating = 'good' THEN 1 ELSE 0 END) AS good,
                       SUM(CASE WHEN rating = 'bad'  THEN 1 ELSE 0 END) AS bad,
                       COUNT(*) AS total
                FROM ai_feedback{wc}
                GROUP BY 1 ORDER BY total DESC""",
            params,
        ).fetchall()
        totals = con.execute(
            f"""SELECT
                       SUM(CASE WHEN rating = 'good' THEN 1 ELSE 0 END) AS good,
                       SUM(CASE WHEN rating = 'bad'  THEN 1 ELSE 0 END) AS bad,
                       COUNT(*) AS total
                FROM ai_feedback{wc}""",
            params,
        ).fetchone()
        recent = con.execute(
            f"""SELECT id, created_at,
                       COALESCE(user_email, '(anonymous)') AS user_email,
                       surface, rating, question, answer, details, page, model
                FROM ai_feedback{wc}
                ORDER BY created_at DESC, id DESC LIMIT 500""",
            params,
        ).fetchall()
    return {
        "per_surface": [dict(r) for r in per_surface],
        "totals": dict(totals) if totals else {},
        "recent": [dict(r) for r in recent],
    }


@router.delete("/{feedback_id}")
def admin_delete(feedback_id: int, user: dict = Depends(require_admin)):
    with get_pg() as con:
        con.execute("DELETE FROM ai_feedback WHERE id = %s", (feedback_id,))
    return {"status": "deleted"}
