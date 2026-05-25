"""
Share tracking.

One row is logged each time someone taps "Share via WhatsApp". Signed-in users
are recorded by id and email; anonymous landing-page visitors are recorded with
no user (shown as Anonymous in the admin view). The admin list is read-only.
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from typing import Optional

from backend.pg import get_pg
from backend.auth import get_optional_user, require_admin

router = APIRouter(prefix="/api/share", tags=["share"])


class ShareEventIn(BaseModel):
    channel: Optional[str] = "whatsapp"
    source: Optional[str] = None        # where the button was: sidebar | landing-nav | landing-footer
    page: Optional[str] = None
    user_agent: Optional[str] = None


@router.post("/track")
def track_share(ev: ShareEventIn, user: Optional[dict] = Depends(get_optional_user)):
    with get_pg() as con:
        con.execute(
            """INSERT INTO share_events (user_id, user_email, channel, source, page, user_agent)
               VALUES (%s, %s, %s, %s, %s, %s)""",
            (
                user["id"] if user else None,
                user["email"] if user else None,
                (ev.channel or "whatsapp")[:30],
                (ev.source or None) and ev.source[:50],
                (ev.page or None) and ev.page[:300],
                (ev.user_agent or None) and ev.user_agent[:500],
            ),
        )
    return {"status": "tracked"}


@router.get("/events")
def list_share_events(user: dict = Depends(require_admin)):
    """Recent share events, newest first. Admin-only."""
    with get_pg() as con:
        rows = con.execute(
            "SELECT id, user_email, channel, source, page, created_at "
            "FROM share_events ORDER BY created_at DESC, id DESC LIMIT 5000"
        ).fetchall()
    return [dict(r) for r in rows]
