"""Shared per-page response cache.

Every list/analysis endpoint that is USER-INDEPENDENT and recomputes the same
answer per request (Price Drops/Increases, Discounts, Clearance, Combos, the
comparison boards) can memo its response here. The cache key always includes the
pricing-cache FILE PATH, so a data reload (which swaps the file) auto-invalidates
every entry — no manual busting. Small in-process LRU, thread-safe.

Convention (matches the existing compare-board cache): the cached value is the
already-built response object (list/dict). Callers MUST treat it as read-only
(don't mutate a returned list in place) since it is shared across requests.
"""
from __future__ import annotations

import threading
from collections import OrderedDict
from typing import Any, Callable

_LOCK = threading.Lock()
_CACHE: "OrderedDict[tuple, Any]" = OrderedDict()
_MAX = 512


def pricing_tag() -> str:
    """Identity of the current pricing-cache file; part of every key so a reload
    invalidates the memo automatically. Empty string if unavailable (then the
    cache still works within one process lifetime)."""
    try:
        from backend.pricing_cache import get_pricing_path
        return str(get_pricing_path())
    except Exception:
        return ""


def cached_response(endpoint: str, params: tuple, build: Callable[[], Any]) -> Any:
    """Return the memoized response for (pricing version, endpoint, params),
    building it via ``build()`` on a miss. ``params`` must be hashable.

    The builder runs OUTSIDE the lock so a slow build for one key never blocks
    reads/writes for others; two concurrent misses on the same key may both
    build (idempotent), which is fine and avoids holding the lock across DB work.
    """
    key = (pricing_tag(), endpoint, params)
    with _LOCK:
        hit = _CACHE.get(key)
        if hit is not None:
            _CACHE.move_to_end(key)
            return hit
    value = build()
    with _LOCK:
        _CACHE[key] = value
        _CACHE.move_to_end(key)
        while len(_CACHE) > _MAX:
            _CACHE.popitem(last=False)
    return value


def peek(endpoint: str, params: tuple) -> Any:
    """Return the memoized value for (pricing version, endpoint, params), or None
    on a miss. For call sites whose result is built inline (a single big function
    body) rather than via a build() closure — pair with store()."""
    key = (pricing_tag(), endpoint, params)
    with _LOCK:
        hit = _CACHE.get(key)
        if hit is not None:
            _CACHE.move_to_end(key)
        return hit


def store(endpoint: str, params: tuple, value: Any) -> None:
    """Memoize ``value`` for (pricing version, endpoint, params). Treat the stored
    value as read-only (it is shared across requests)."""
    key = (pricing_tag(), endpoint, params)
    with _LOCK:
        _CACHE[key] = value
        _CACHE.move_to_end(key)
        while len(_CACHE) > _MAX:
            _CACHE.popitem(last=False)


def clear() -> None:
    """Drop everything (called on an explicit pricing reload as a belt-and-braces
    measure; the pricing-tag key already makes stale entries unreachable)."""
    with _LOCK:
        _CACHE.clear()
