"""Celar AI Assistant endpoint — full-page conversational Q&A with charts + actions."""
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from backend.auth import get_optional_user

router = APIRouter(prefix="/api/assistant", tags=["assistant"])


class AskBody(BaseModel):
    question: str
    history: Optional[list] = None   # prior [{role, content}] turns for memory


@router.post("/ask")
def ask(body: AskBody, user: Optional[dict] = Depends(get_optional_user)):
    """Answer a question with markdown + optional charts + resolved actions, plus
    token/$ usage. Multi-turn via `history`; every call is logged for the admin
    AI-usage rollup."""
    from backend import assistant as engine, ai_usage
    res = engine.ask(body.question, body.history)
    ai_usage.log_usage(user, "celar", body.question, res.get("usage"))
    return res
