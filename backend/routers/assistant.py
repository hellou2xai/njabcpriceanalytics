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


@router.post("/ask")
def ask(body: AskBody, user: Optional[dict] = Depends(get_optional_user)):
    """Answer a question with markdown + optional charts + resolved actions, plus
    token/$ usage. Multi-turn via `history`; `page` tells the assistant which
    screen the user is on so it prioritizes relevant tools (and enables the
    signed-in user's cart/favorites/lists/orders tools). Logged for the rollup."""
    from backend import assistant as engine, ai_usage
    res = engine.ask(body.question, body.history, user=user, page=body.page, page_path=body.page_path)
    ai_usage.log_usage(user, "celar", body.question, res.get("usage"))
    return res
