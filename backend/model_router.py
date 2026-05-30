"""Pick the cheapest model that can handle a question (cost efficiency program).

Haiku is ~3-5x cheaper than Sonnet and plenty for simple lookups, filters, and
single actions ("show wine under $150", "add 2 cases of X to cart"). Sonnet is
reserved for genuinely analytical work — comparisons, trends, breakdowns, charts,
multi-step reasoning. A keyword + shape heuristic decides, so routing itself
costs ZERO tokens (no classifier call).

Env overrides: CELR_HAIKU_MODEL, CELR_SONNET_MODEL.
"""
from __future__ import annotations

import os

HAIKU = os.getenv("CELR_HAIKU_MODEL", "claude-haiku-4-5-20251001")
SONNET = os.getenv("CELR_SONNET_MODEL", os.getenv("CELR_SEARCH_AI_MODEL", "claude-sonnet-4-6"))

# Signals that a question needs Sonnet-level reasoning.
_COMPLEX = (
    "compare", "comparison", "vs ", "versus", "trend", "why", "analy", "breakdown",
    "break down", "distribut", "across", "recommend", "suggest", "summar", "margin",
    "forecast", "explain", "over time", "history", "chart", "graph", "plot",
    "best value", "which is", "how many", "average", "most ", "least ", "top ",
)


def choose_model(question: str, *, force: str | None = None) -> str:
    """Return the model id to use. `force` ('haiku'|'sonnet') overrides the heuristic."""
    if force == "haiku":
        return HAIKU
    if force == "sonnet":
        return SONNET
    q = (question or "").lower().strip()
    if not q:
        return HAIKU
    # Long / multi-clause questions tend to need more reasoning.
    if len(q) > 160 or q.count("?") > 1 or " and " in q and len(q) > 90:
        return SONNET
    if any(k in q for k in _COMPLEX):
        return SONNET
    return HAIKU
