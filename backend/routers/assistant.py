"""Celar AI Assistant endpoint — full-page conversational Q&A with charts + actions."""
import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from backend.auth import get_optional_user, get_current_user
from backend.pg import get_pg
from backend.db import NOW_UTC

router = APIRouter(prefix="/api/assistant", tags=["assistant"])

# Cap a single transcript so a runaway conversation can't bloat the row / the
# response. Roughly a few hundred rich turns — far beyond a real chat.
_MAX_MESSAGES_BYTES = 2_000_000
_MAX_TITLE = 120


class AskBody(BaseModel):
    question: str
    history: Optional[list] = None   # prior [{role, content}] turns for memory
    page: Optional[str] = None       # screen label (scope + tool prioritization)
    page_path: Optional[str] = None  # screen route (so a UPC filters it in place)
    page_query: Optional[str] = None  # current grid query string, so follow-ups compose filters


@router.post("/ask")
async def ask(body: AskBody, user: Optional[dict] = Depends(get_optional_user)):
    """Answer a question with markdown + optional charts + resolved actions, plus
    token/$ usage. Multi-turn via `history`; `page` tells the assistant which
    screen the user is on so it prioritizes relevant tools (and enables the
    signed-in user's cart/favorites/lists/orders tools). Logged for the rollup.

    Routes to the Claude Agent SDK path (ask_async) when CELR_USE_AGENT_SDK is on,
    else the raw-API loop (run in a threadpool so it doesn't block the event
    loop). The agent path self-degrades to the raw-API loop on any SDK failure."""
    from backend import assistant as engine, ai_usage, llm_client
    try:
        if llm_client.use_agent_sdk():
            res = await engine.ask_async(body.question, body.history, user=user, page=body.page,
                                         page_path=body.page_path, page_query=body.page_query)
        else:
            from fastapi.concurrency import run_in_threadpool
            res = await run_in_threadpool(
                engine.ask, body.question, body.history, user=user, page=body.page,
                page_path=body.page_path, page_query=body.page_query)
    except Exception as e:
        # Never 500 the chat — degrade gracefully so the UI shows a message.
        import logging
        logging.getLogger("assistant").exception("assistant.ask failed: %s", e)
        res = {
            "answer": "Sorry — I couldn't complete that. Please try rephrasing your question.",
            "charts": [], "actions": [], "products": [], "screen": None,
            "usage": {"input_tokens": 0, "output_tokens": 0, "model": "error", "cost_usd": 0.0, "enabled": True},
        }
    try:
        ai_usage.log_usage(user, "celar", body.question, res.get("usage"))
    except Exception:
        import logging
        logging.getLogger("assistant").exception("ai_usage.log_usage failed")
    return res


# ---------------------------------------------------------------------------
# Chat history: server-side saved conversations (one continuous global thread
# per session) so history follows the signed-in user across devices/logins.
# The full transcript is stored as a JSON blob exactly as the UI renders it.
# ---------------------------------------------------------------------------
class SessionSave(BaseModel):
    # Full transcript to persist (replaces the stored copy). title is optional:
    # send it to (re)derive the list label, omit it to leave the label as-is.
    messages: list = []
    title: Optional[str] = None


class SessionRename(BaseModel):
    title: str


def _clean_title(t: Optional[str]) -> str:
    return ((t or "").strip()[:_MAX_TITLE]) or "New chat"


@router.get("/sessions")
def list_sessions(user: dict = Depends(get_current_user)):
    """The user's saved chats, newest activity first (no message bodies)."""
    with get_pg() as con:
        rows = con.execute(
            "SELECT id, title, created_at, updated_at FROM chat_sessions "
            "WHERE user_id=%s ORDER BY updated_at DESC",
            (user["id"],),
        ).fetchall()
    return [dict(r) for r in rows]


@router.post("/sessions")
def create_session(user: dict = Depends(get_current_user)):
    """Start a new, empty saved chat and return its row."""
    with get_pg() as con:
        row = con.execute(
            "INSERT INTO chat_sessions (user_id, title, messages) "
            "VALUES (%s, 'New chat', '[]') RETURNING id, title, created_at, updated_at",
            (user["id"],),
        ).fetchone()
    return dict(row)


@router.get("/sessions/{session_id}")
def get_session(session_id: int, user: dict = Depends(get_current_user)):
    """One saved chat with its full transcript (messages parsed from JSON)."""
    with get_pg() as con:
        row = con.execute(
            "SELECT id, title, messages, created_at, updated_at FROM chat_sessions "
            "WHERE id=%s AND user_id=%s",
            (session_id, user["id"]),
        ).fetchone()
    if not row:
        raise HTTPException(404, "Session not found")
    d = dict(row)
    try:
        d["messages"] = json.loads(d.get("messages") or "[]")
    except Exception:
        d["messages"] = []
    return d


@router.put("/sessions/{session_id}")
def save_session(session_id: int, body: SessionSave, user: dict = Depends(get_current_user)):
    """Replace a saved chat's transcript (and optionally its title)."""
    blob = json.dumps(body.messages or [])
    if len(blob.encode("utf-8")) > _MAX_MESSAGES_BYTES:
        raise HTTPException(413, "Conversation too large to save")
    with get_pg() as con:
        owned = con.execute(
            "SELECT id FROM chat_sessions WHERE id=%s AND user_id=%s",
            (session_id, user["id"]),
        ).fetchone()
        if not owned:
            raise HTTPException(404, "Session not found")
        if body.title is not None:
            con.execute(
                f"UPDATE chat_sessions SET messages=%s, title=%s, updated_at={NOW_UTC} WHERE id=%s",
                (blob, _clean_title(body.title), session_id),
            )
        else:
            con.execute(
                f"UPDATE chat_sessions SET messages=%s, updated_at={NOW_UTC} WHERE id=%s",
                (blob, session_id),
            )
    return {"status": "saved"}


@router.patch("/sessions/{session_id}")
def rename_session(session_id: int, body: SessionRename, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        owned = con.execute(
            "SELECT id FROM chat_sessions WHERE id=%s AND user_id=%s",
            (session_id, user["id"]),
        ).fetchone()
        if not owned:
            raise HTTPException(404, "Session not found")
        con.execute(
            f"UPDATE chat_sessions SET title=%s, updated_at={NOW_UTC} WHERE id=%s",
            (_clean_title(body.title), session_id),
        )
    return {"status": "renamed"}


@router.delete("/sessions/{session_id}")
def delete_session(session_id: int, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        con.execute(
            "DELETE FROM chat_sessions WHERE id=%s AND user_id=%s",
            (session_id, user["id"]),
        )
    return {"status": "deleted"}
