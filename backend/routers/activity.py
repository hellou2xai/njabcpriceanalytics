"""
Activity tracking for product analytics.

The frontend posts batches of events: a 'pageview' when the user leaves a screen
(carrying the time spent there, in ms) and an 'action' for notable things they
do. Signed-in users are recorded by id and email; anonymous visitors keep a NULL
user. The admin rollups (time per screen, per-user activity, one user's trail)
power the Activity view in the Admin menu. Ingestion is best-effort: a tracking
failure must never break the page, so errors are swallowed.
"""

import json
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from backend.pg import get_pg
from backend.auth import get_optional_user, require_admin

router = APIRouter(prefix="/api/activity", tags=["activity"])

MAX_BATCH = 50


class ActivityEvent(BaseModel):
    type: str                       # 'pageview' | 'action'
    path: Optional[str] = None
    label: Optional[str] = None
    duration_ms: Optional[int] = None
    meta: Optional[dict] = None


class ActivityBatch(BaseModel):
    session_id: Optional[str] = None
    user_agent: Optional[str] = None
    events: list[ActivityEvent] = []


def _since(days: int) -> str:
    """ISO timestamp `days` ago. created_at is stored as ISO text, so a string
    comparison gives a correct time-range filter."""
    return (datetime.now(timezone.utc) - timedelta(days=max(1, days))).isoformat()


@router.post("/track")
def track(batch: ActivityBatch, user: Optional[dict] = Depends(get_optional_user)):
    events = batch.events[:MAX_BATCH]
    if not events:
        return {"status": "empty"}
    uid = user["id"] if user else None
    email = user["email"] if user else None
    sid = (batch.session_id or None) and batch.session_id[:64]
    ua = (batch.user_agent or None) and batch.user_agent[:500]
    try:
        with get_pg() as con:
            for ev in events:
                etype = (ev.type or "")[:20]
                if etype not in ("pageview", "action"):
                    continue
                dur = ev.duration_ms
                if dur is not None:
                    # Clamp out junk: negatives and absurd (>6h) durations.
                    dur = max(0, min(int(dur), 6 * 60 * 60 * 1000))
                con.execute(
                    """INSERT INTO activity_events
                       (user_id, user_email, session_id, event_type, path, label, duration_ms, meta, user_agent)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                    (
                        uid, email, sid, etype,
                        (ev.path or None) and ev.path[:300],
                        (ev.label or None) and ev.label[:200],
                        dur,
                        json.dumps(ev.meta)[:2000] if ev.meta else None,
                        ua,
                    ),
                )
    except Exception as e:  # never let tracking break the client
        print(f"[activity] track failed: {e}")
        return {"status": "error"}
    return {"status": "ok", "count": len(events)}


# ---- Admin analytics ----

@router.get("/admin/summary")
def summary(days: int = 30, user: dict = Depends(require_admin)):
    """Overall analytics: totals plus time spent per screen, last `days` days."""
    since = _since(days)
    with get_pg() as con:
        totals = con.execute(
            """SELECT
                 COUNT(*) AS events,
                 COUNT(*) FILTER (WHERE event_type = 'pageview') AS pageviews,
                 COUNT(*) FILTER (WHERE event_type = 'action') AS actions,
                 COUNT(DISTINCT user_id) AS users,
                 COUNT(DISTINCT session_id) AS sessions,
                 COALESCE(SUM(duration_ms), 0) AS total_ms
               FROM activity_events WHERE created_at >= %s""",
            (since,),
        ).fetchone()
        screens = con.execute(
            """SELECT COALESCE(path, '(unknown)') AS path,
                      MAX(label) AS label,
                      COUNT(*) FILTER (WHERE event_type = 'pageview') AS views,
                      COALESCE(SUM(duration_ms), 0) AS total_ms,
                      COUNT(DISTINCT user_id) AS users
               FROM activity_events
               WHERE created_at >= %s AND event_type = 'pageview'
               GROUP BY COALESCE(path, '(unknown)')
               ORDER BY total_ms DESC
               LIMIT 100""",
            (since,),
        ).fetchall()
        actions = con.execute(
            """SELECT COALESCE(label, '(unlabelled)') AS label, COUNT(*) AS count
               FROM activity_events
               WHERE created_at >= %s AND event_type = 'action'
               GROUP BY COALESCE(label, '(unlabelled)')
               ORDER BY count DESC
               LIMIT 50""",
            (since,),
        ).fetchall()
    return {
        "days": days,
        "totals": dict(totals),
        "screens": [dict(r) for r in screens],
        "actions": [dict(r) for r in actions],
    }


@router.get("/admin/users")
def users_activity(days: int = 30, user: dict = Depends(require_admin)):
    """Per-user activity rollup for the last `days` days, busiest first."""
    since = _since(days)
    with get_pg() as con:
        rows = con.execute(
            """SELECT user_id,
                      COALESCE(MAX(user_email), 'Anonymous') AS user_email,
                      COUNT(*) FILTER (WHERE event_type = 'pageview') AS pageviews,
                      COUNT(*) FILTER (WHERE event_type = 'action') AS actions,
                      COUNT(DISTINCT session_id) AS sessions,
                      COALESCE(SUM(duration_ms), 0) AS total_ms,
                      MAX(created_at) AS last_active
               FROM activity_events
               WHERE created_at >= %s
               GROUP BY user_id
               ORDER BY total_ms DESC, pageviews DESC
               LIMIT 1000""",
            (since,),
        ).fetchall()
    return [dict(r) for r in rows]


@router.get("/admin/user/{user_id}")
def user_activity_detail(user_id: int, days: int = 90, user: dict = Depends(require_admin)):
    """One user's per-screen time breakdown plus their recent event trail."""
    since = _since(days)
    with get_pg() as con:
        screens = con.execute(
            """SELECT COALESCE(path, '(unknown)') AS path,
                      MAX(label) AS label,
                      COUNT(*) FILTER (WHERE event_type = 'pageview') AS views,
                      COALESCE(SUM(duration_ms), 0) AS total_ms
               FROM activity_events
               WHERE user_id = %s AND created_at >= %s AND event_type = 'pageview'
               GROUP BY COALESCE(path, '(unknown)')
               ORDER BY total_ms DESC""",
            (user_id, since),
        ).fetchall()
        recent = con.execute(
            """SELECT event_type, path, label, duration_ms, created_at
               FROM activity_events
               WHERE user_id = %s
               ORDER BY created_at DESC, id DESC
               LIMIT 200""",
            (user_id,),
        ).fetchall()
        totals = con.execute(
            """SELECT COALESCE(SUM(duration_ms), 0) AS total_ms,
                      COUNT(*) FILTER (WHERE event_type = 'pageview') AS pageviews,
                      COUNT(*) FILTER (WHERE event_type = 'action') AS actions,
                      MIN(created_at) AS first_seen, MAX(created_at) AS last_active
               FROM activity_events WHERE user_id = %s AND created_at >= %s""",
            (user_id, since),
        ).fetchone()
    return {
        "user_id": user_id,
        "totals": dict(totals),
        "screens": [dict(r) for r in screens],
        "recent": [dict(r) for r in recent],
    }
