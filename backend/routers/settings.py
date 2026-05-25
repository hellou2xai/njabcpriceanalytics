"""
Admin-editable app settings (key/value).

The WhatsApp share message and link live here so the owner can edit the copy
from the Admin page without a code change. The read endpoint is public (the
signed-out landing page uses it); the write endpoint is admin-only.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

from backend.pg import get_pg
from backend.auth import require_admin
from backend.db import NOW_UTC

router = APIRouter(prefix="/api/settings", tags=["settings"])

DEFAULT_SHARE_MESSAGE = (
    "What takes you 50+ hours a month, CELR.ai shows in seconds:\n"
    "• Real price + discount on every item\n"
    "• Which RIPs and rebates you qualify for\n"
    "• Buy now or wait for next month\n"
    "• Deals about to expire\n"
    "All in one screen. Free during early access:"
)
DEFAULT_SHARE_URL = "https://nj.celr.ai"


def _get(con, key: str, default: str) -> str:
    row = con.execute("SELECT value FROM app_settings WHERE key = %s", (key,)).fetchone()
    return row["value"] if row and row["value"] is not None else default


@router.get("/share-message")
def get_share_message():
    """Current WhatsApp share message + link (public)."""
    with get_pg() as con:
        return {
            "message": _get(con, "share_message", DEFAULT_SHARE_MESSAGE),
            "url": _get(con, "share_url", DEFAULT_SHARE_URL),
        }


class ShareMessageIn(BaseModel):
    message: str
    url: Optional[str] = None


@router.put("/share-message")
def set_share_message(body: ShareMessageIn, user: dict = Depends(require_admin)):
    """Update the share message + link. Admin only."""
    msg = (body.message or "").strip()
    if not msg:
        raise HTTPException(status_code=422, detail="Message is required")
    url = (body.url or "").strip() or DEFAULT_SHARE_URL
    with get_pg() as con:
        for k, v in (("share_message", msg), ("share_url", url)):
            con.execute(
                f"""INSERT INTO app_settings (key, value, updated_at)
                    VALUES (%s, %s, {NOW_UTC})
                    ON CONFLICT (key) DO UPDATE
                      SET value = EXCLUDED.value, updated_at = {NOW_UTC}""",
                (k, v),
            )
    return {"message": msg, "url": url}
