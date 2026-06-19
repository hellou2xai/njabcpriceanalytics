"""HTTP conditional-GET helper for USER-INDEPENDENT responses (PERF_TODO baseline).

These endpoints already memoize their response in backend.cache_util keyed on a
per-request `ckey` that contains NO user identity, so the same key yields the
same bytes for every caller. That makes them safe to mark `Cache-Control: public`
(a shared CDN/browser cache can serve them to anyone) and to give an ETag.

The ETag is the CONTENT VERSION, derived from (pricing-cache file path, ckey):
- same params + same data load  -> same ETag -> a repeat request revalidates as
  304 Not Modified (no body on the wire), or is served straight from the CDN
  within max-age without touching the server at all.
- a data reload swaps the pricing file -> pricing_tag changes -> the ETag changes
  -> caches refetch. Same auto-invalidation contract as cache_util itself.

NEVER call this for a response that embeds user-specific data: `public` would
leak one user's view into a shared cache. Only the cache_util-memoized list
endpoints qualify.
"""
from __future__ import annotations

import hashlib
from typing import Optional

from fastapi import Request, Response

from backend import cache_util


def public_conditional(request: Request, response: Response, ckey,
                       max_age: int = 120) -> Optional[Response]:
    """Set `ETag` + `Cache-Control: public` for a user-independent response keyed
    by ``ckey`` (the same key the endpoint memoizes on). Returns a 304 Response to
    return EARLY when the client's `If-None-Match` already holds this version,
    else None (caller proceeds to build/return the body)."""
    raw = repr((cache_util.pricing_tag(), ckey))
    etag = 'W/"' + hashlib.md5(raw.encode()).hexdigest() + '"'
    cc = f"public, max-age={max_age}"
    inm = request.headers.get("if-none-match", "")
    if etag and any(etag == t.strip() for t in inm.split(",")):
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": cc})
    response.headers["ETag"] = etag
    response.headers["Cache-Control"] = cc
    return None
