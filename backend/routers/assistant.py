"""Celar AI Assistant endpoint — full-page conversational Q&A with charts + actions."""
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from backend.auth import get_optional_user

router = APIRouter(prefix="/api/assistant", tags=["assistant"])


class AskBody(BaseModel):
    question: str
    history: Optional[list] = None   # prior [{role, content}] turns for memory
    page: Optional[str] = None       # screen label (scope + tool prioritization)
    page_path: Optional[str] = None  # screen route (so a UPC filters it in place)
    page_query: Optional[str] = None  # current grid query string, so follow-ups compose filters


@router.post("/ask")
def ask(body: AskBody, user: Optional[dict] = Depends(get_optional_user)):
    """Answer a question with markdown + optional charts + resolved actions, plus
    token/$ usage. Multi-turn via `history`; `page` tells the assistant which
    screen the user is on so it prioritizes relevant tools (and enables the
    signed-in user's cart/favorites/lists/orders tools). Logged for the rollup."""
    from backend import assistant as engine, ai_usage
    try:
        res = engine.ask(body.question, body.history, user=user, page=body.page,
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
