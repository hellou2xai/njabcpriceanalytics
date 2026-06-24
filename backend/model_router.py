"""Cost-efficiency model router.

The tiering logic now lives in `backend/llm_client.py` (the single AI seam) so
all model selection is in one place. This module re-exports it unchanged for the
existing import sites (`from backend.model_router import choose_model` / `HAIKU`
/ `SONNET`). Prefer importing from `backend.llm_client` in new code.
"""
from __future__ import annotations

from backend.llm_client import HAIKU, SONNET, choose_model

__all__ = ["HAIKU", "SONNET", "choose_model"]
