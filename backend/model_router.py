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


# On the standalone /assistant page there is no grid, so the chat itself must
# render summaries and comparison tables and follow the no-grid phrasing rules.
# That needs stronger instruction-following, so any listing / discovery question
# there goes to Sonnet (a bare UPC or greeting still stays on Haiku).
_DISCOVERY = (
    "show", "list", "find", "cheapest", "under $", "under ", "discount", "deal",
    "deals", "rebate", "rip", "best", "top ", "wines", "wine", "compare", "which",
    "lowest", "highest", "biggest",
)


def choose_model(question: str, *, force: str | None = None, standalone: bool = False) -> str:
    """Return the model id to use. `force` ('haiku'|'sonnet') overrides the heuristic.
    `standalone` lowers the bar for Sonnet on the dedicated /assistant page, where
    the chat must produce reliable tables instead of just driving a grid."""
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
    if standalone and any(k in q for k in _DISCOVERY):
        return SONNET
    return HAIKU
