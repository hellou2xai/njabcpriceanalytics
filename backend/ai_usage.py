"""Central AI usage logging.

Every assistant surface (catalog sidebar, Celar full page, …) calls log_usage()
after each answer so we have one row per question: who asked, on which surface,
the model, token counts and the USD cost. This backs both the per-answer cost
shown in the UI and the admin "AI Usage" rollup (tokens + $ per user over a
date range). Best-effort — a logging failure never breaks the chat response.
"""
from __future__ import annotations

from backend.pg import get_pg


def log_usage(user: dict | None, surface: str, question: str, usage: dict | None) -> None:
    usage = usage or {}
    try:
        with get_pg() as con:
            con.execute(
                "INSERT INTO ai_usage_log "
                "(user_id, user_email, surface, question, model, input_tokens, output_tokens, cost_usd) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    user.get("id") if user else None,
                    user.get("email") if user else None,
                    surface,
                    (question or "")[:2000],
                    usage.get("model"),
                    int(usage.get("input_tokens") or 0),
                    int(usage.get("output_tokens") or 0),
                    float(usage.get("cost_usd") or 0.0),
                ),
            )
    except Exception:
        pass
