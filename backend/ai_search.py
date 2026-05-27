"""Optional real-time AI query understanding for product search.

When a text search returns NOTHING, we ask Claude (a small, fast Sonnet model) to
translate the shorthand a retailer typed ("JW Blue", "Johnnie Blue", "that smoky
islay scotch") into the real brand / product terms, and the search retries once
with those terms. The deterministic alias table (backend/search_aliases) handles
the common cases instantly with no API call; this only kicks in for genuine misses.

Off by default. It activates automatically when ANTHROPIC_API_KEY is set in the
environment. Every answer is cached in-process so the same query never calls the
API twice. Model id is configurable via CELR_SEARCH_AI_MODEL (defaults to Sonnet).
"""
from __future__ import annotations
import os
import threading

_MODEL = os.getenv("CELR_SEARCH_AI_MODEL", "claude-sonnet-4-6")
_cache: dict[str, str | None] = {}
_lock = threading.Lock()
_client = None
_client_init = False

_SYSTEM = (
    "You translate liquor-store search shorthand into the real product/brand terms "
    "for matching a US wholesale liquor catalogue (spirits, wine, beer). "
    "Given a short query, reply with ONLY the canonical brand and key descriptors as "
    "a plain space-separated search string: lowercase, no punctuation, no explanation. "
    "Examples:\n"
    "jw blue -> johnnie walker blue label\n"
    "johnnie blue -> johnnie walker blue label\n"
    "henny vs -> hennessy vs\n"
    "grey goose -> grey goose\n"
    "smoky islay scotch -> laphroaig\n"
    "If you do not recognise it, reply with the query unchanged."
)


def _client_or_none():
    global _client, _client_init
    if _client_init:
        return _client
    _client_init = True
    if not os.getenv("ANTHROPIC_API_KEY"):
        _client = None
        return None
    try:
        import anthropic
        _client = anthropic.Anthropic()
    except Exception:
        _client = None
    return _client


def enabled() -> bool:
    return _client_or_none() is not None


def ai_expand_query(q: str) -> str | None:
    """Return a canonical brand/product search string for a shorthand query, or None
    (disabled, unrecognised, or unchanged). Cached per process."""
    q = (q or "").strip()
    if len(q) < 4 or len(q) > 60:      # skip tiny partials and overly long text
        return None
    key = q.lower()
    with _lock:
        if key in _cache:
            return _cache[key]
    client = _client_or_none()
    if client is None:
        with _lock:
            _cache[key] = None
        return None
    result: str | None = None
    try:
        msg = client.messages.create(
            model=_MODEL,
            max_tokens=40,
            system=_SYSTEM,
            messages=[{"role": "user", "content": q}],
        )
        text = "".join(
            getattr(b, "text", "") for b in msg.content if getattr(b, "type", "") == "text"
        ).strip()
        if text and text.lower() != key:
            result = text
    except Exception:
        result = None
    with _lock:
        _cache[key] = result
    return result
