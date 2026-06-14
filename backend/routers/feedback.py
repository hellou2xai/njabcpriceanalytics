"""
Beta feedback: bug reports and improvement suggestions.

The user types a message (or dictates it by voice, transcribed to text in the
browser) and can attach one or more screenshots. The user id and email (from
the bearer token), the page they were on, and their browser user-agent are
attached automatically and are not shown to the user. Submissions work whether
or not signed in.

Screenshots are uploaded to the SAME R2 bucket as product images (see
backend/r2.py) under a `feedback/<id>/` prefix, and their public URLs + keys
are stored as a JSON array in feedback.attachments so an admin can retrieve
them. If R2 is not configured, the text feedback is still saved (images are
skipped, not fatal).
"""

import json
import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from backend.pg import get_pg
from backend.auth import get_optional_user, require_admin
from backend import r2

router = APIRouter(prefix="/api/feedback", tags=["feedback"])

# Accepted screenshot types + limits (defensive — the widget already restricts).
_EXT = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}
MAX_IMAGES = 6
MAX_IMG_BYTES = 8 * 1024 * 1024  # 8 MB per screenshot


@router.post("")
async def submit_feedback(
    message: str = Form(""),
    kind: Optional[str] = Form(None),          # 'bug' | 'idea'
    page: Optional[str] = Form(None),          # route the user was on
    user_agent: Optional[str] = Form(None),
    screenshots: List[UploadFile] = File(default=[]),
    user: Optional[dict] = Depends(get_optional_user),
):
    msg = (message or "").strip()
    if not msg and not screenshots:
        raise HTTPException(status_code=422, detail="Add a message or a screenshot")

    # Upload each screenshot to R2 (skipped gracefully if R2 is off / a file is
    # bad), collecting {url, key, name} for the admin to retrieve later.
    attachments: list[dict] = []
    if screenshots:
        sid = uuid.uuid4().hex[:12]
        for i, f in enumerate(screenshots[:MAX_IMAGES]):
            ct = (f.content_type or "").lower()
            if ct not in _EXT:
                continue
            data = await f.read()
            if not data or len(data) > MAX_IMG_BYTES:
                continue
            key = f"feedback/{sid}/{i}.{_EXT[ct]}"
            try:
                url = r2.upload_bytes(key, data, ct)
                attachments.append({"url": url, "key": key,
                                    "name": (f.filename or "")[:120]})
            except Exception:
                pass  # R2 unavailable / upload failed -> keep the text feedback

    with get_pg() as con:
        con.execute(
            """INSERT INTO feedback
                 (user_id, user_email, kind, message, page, user_agent, attachments)
               VALUES (%s, %s, %s, %s, %s, %s, %s)""",
            (
                user["id"] if user else None,
                user["email"] if user else None,
                (kind or None),
                msg[:5000],
                (page or None) and page[:300],
                (user_agent or None) and user_agent[:500],
                json.dumps(attachments) if attachments else None,
            ),
        )
    return {"status": "received", "screenshots": len(attachments)}


@router.get("")
def list_feedback(user: dict = Depends(require_admin)):
    """All feedback, newest first. Admin-only; for collecting reports."""
    with get_pg() as con:
        rows = con.execute(
            "SELECT * FROM feedback ORDER BY created_at DESC, id DESC"
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        raw = d.get("attachments")
        try:
            d["attachments"] = json.loads(raw) if raw else []
        except Exception:
            d["attachments"] = []
        out.append(d)
    return out


@router.delete("/{feedback_id}")
def delete_feedback(feedback_id: int, user: dict = Depends(require_admin)):
    """Remove a feedback entry once handled. Admin-only."""
    with get_pg() as con:
        con.execute("DELETE FROM feedback WHERE id = %s", (feedback_id,))
    return {"status": "deleted"}
