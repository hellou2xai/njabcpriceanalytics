"""
Cookie / consent log.

Every consent decision a visitor makes (accept all, reject non-essential, or
saved custom preferences) is recorded here, for signed-in and anonymous
visitors alike. The browser sends a random ``anon_id`` it keeps in local
storage so repeat decisions can be correlated, with no personal data involved.
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from typing import Optional

from backend.pg import get_pg
from backend.auth import get_optional_user, require_admin

router = APIRouter(prefix="/api/consent", tags=["consent"])


class ConsentIn(BaseModel):
    anon_id: Optional[str] = None
    analytics: bool = False
    marketing: bool = False
    decision: Optional[str] = None        # 'accept_all' | 'reject' | 'custom'
    policy_version: Optional[str] = None
    page: Optional[str] = None
    user_agent: Optional[str] = None


@router.post("")
def record_consent(c: ConsentIn, user: Optional[dict] = Depends(get_optional_user)):
    """Log a consent decision. Necessary cookies are always on."""
    with get_pg() as con:
        con.execute(
            """INSERT INTO cookie_consents
               (user_id, user_email, anon_id, necessary, analytics, marketing,
                decision, policy_version, page, user_agent)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (
                user["id"] if user else None,
                user["email"] if user else None,
                (c.anon_id or None) and c.anon_id[:64],
                1,
                1 if c.analytics else 0,
                1 if c.marketing else 0,
                (c.decision or None) and c.decision[:20],
                (c.policy_version or None) and c.policy_version[:20],
                (c.page or None) and c.page[:300],
                (c.user_agent or None) and c.user_agent[:500],
            ),
        )
    return {"status": "recorded"}


@router.get("")
def list_consents(user: dict = Depends(require_admin)):
    """All consent records, newest first. Admin-only."""
    with get_pg() as con:
        rows = con.execute(
            "SELECT * FROM cookie_consents ORDER BY created_at DESC, id DESC LIMIT 5000"
        ).fetchall()
    return [dict(r) for r in rows]
