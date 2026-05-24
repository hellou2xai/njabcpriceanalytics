"""
Beta feedback: bug reports and improvement suggestions.

The user only types a message. The user id and email (from the bearer token),
the page they were on, and their browser user-agent are attached automatically
and are not shown to the user. Submissions work whether or not signed in.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

from backend.pg import get_pg
from backend.auth import get_optional_user, get_current_user

router = APIRouter(prefix="/api/feedback", tags=["feedback"])


class FeedbackIn(BaseModel):
    message: str
    kind: Optional[str] = None        # 'bug' | 'idea'
    page: Optional[str] = None        # route the user was on
    user_agent: Optional[str] = None


@router.post("")
def submit_feedback(fb: FeedbackIn, user: Optional[dict] = Depends(get_optional_user)):
    msg = (fb.message or "").strip()
    if not msg:
        raise HTTPException(status_code=422, detail="Message is required")
    with get_pg() as con:
        con.execute(
            """INSERT INTO feedback (user_id, user_email, kind, message, page, user_agent)
               VALUES (%s, %s, %s, %s, %s, %s)""",
            (
                user["id"] if user else None,
                user["email"] if user else None,
                (fb.kind or None),
                msg[:5000],
                (fb.page or None) and fb.page[:300],
                (fb.user_agent or None) and fb.user_agent[:500],
            ),
        )
    return {"status": "received"}


@router.get("")
def list_feedback(user: dict = Depends(get_current_user)):
    """All feedback, newest first. Auth-guarded; for collecting reports."""
    with get_pg() as con:
        rows = con.execute(
            "SELECT * FROM feedback ORDER BY created_at DESC, id DESC"
        ).fetchall()
    return [dict(r) for r in rows]
