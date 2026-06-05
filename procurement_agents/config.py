"""Pipeline configuration. Env-overridable, same pattern as model_router.py,
but deliberately NOT routed through choose_model(): these are pipeline roles,
not chat-complexity tiers."""

import os

SCOUT_MODEL = os.getenv("CELR_AGENT_SCOUT_MODEL", "claude-sonnet-4-6")
SOURCING_MODEL = os.getenv("CELR_AGENT_SOURCING_MODEL", "claude-sonnet-4-6")

MAX_TURNS = 8                 # tool-use turns per agent before forcing output
MAX_CANDIDATES = 25           # scout shortlist cap
MAX_CASES_PER_LINE = 10       # hard quantity ceiling while we run on dummy POS
MIN_GP = float(os.getenv("CELR_AGENT_MIN_GP", "0.20"))
MAX_RUN_TOKENS = int(os.getenv("CELR_AGENT_MAX_RUN_TOKENS", "400000"))
TOOL_RESULT_CHAR_CAP = 50_000  # truncate giant tool results before the model

# USD per 1M tokens, substring-matched on the model id (input, output).
# Cache reads bill at ~0.1x input; cache writes at ~1.25x input.
PRICING = {
    "opus": (5.0, 25.0),
    "sonnet": (3.0, 15.0),
    "haiku": (1.0, 5.0),
}


def price_for(model: str) -> tuple[float, float]:
    m = (model or "").lower()
    for key, rates in PRICING.items():
        if key in m:
            return rates
    return PRICING["sonnet"]


def usd(model: str, input_tokens: int, output_tokens: int,
        cache_read: int = 0, cache_write: int = 0) -> float:
    rin, rout = price_for(model)
    return ((input_tokens * rin) + (output_tokens * rout)
            + (cache_read * rin * 0.1) + (cache_write * rin * 1.25)) / 1_000_000
