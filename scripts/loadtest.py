#!/usr/bin/env python
"""Closed-loop load test: N concurrent virtual users hammering a realistic
read-heavy endpoint mix, measuring latency percentiles + error rate + cache
status. Each user issues one request at a time in a loop, so ~N requests are
in flight at all times for the whole duration (true concurrency, not a fixed
request count).

Usage:
    python scripts/loadtest.py [BASE_URL] [CONCURRENCY] [DURATION_SEC]
Defaults: https://nj.celr.ai  100  45
"""
import asyncio
import random
import sys
import time
from collections import defaultdict

import httpx

BASE = sys.argv[1] if len(sys.argv) > 1 else "https://nj.celr.ai"
CONCURRENCY = int(sys.argv[2]) if len(sys.argv) > 2 else 100
DURATION = float(sys.argv[3]) if len(sys.argv) > 3 else 45.0

# Realistic browsing mix. (weight, label, path, params). Params with a list are
# randomised per request to spread load across editions/terms (worst case for
# server memo + a realistic variety of pages).
TERMS = ["vodka", "tequila", "bourbon", "cabernet", "pinot noir", "ipa",
         "tito's", "absolut", "jack daniels", "chardonnay", "rum", "gin"]
PHRASES = ["old vine zinfandel", "single barrel bourbon", "natural orange wine",
           "smoky islay scotch", "high rye bourbon", "crisp dry rose"]
EDITIONS = ["2026-06", "2026-07", "2026-05"]

REQUESTS = [
    (25, "catalog/search", "/api/catalog/search",
     {"q": TERMS, "limit": 24}),
    (8,  "catalog/grid", "/api/catalog/search",
     {"limit": 60, "images_first": "true"}),
    (10, "analytics/price-movers", "/api/analytics/price-movers",
     {"limit": 50}),
    (10, "deals/discounts", "/api/deals/discounts", {"limit": 50}),
    (8,  "deals/clearance", "/api/deals/clearance", {"limit": 50}),
    (8,  "deals/combos", "/api/deals/combos", {"limit": 50}),
    (8,  "semantic-search", "/api/catalog/semantic-search",
     {"q": PHRASES, "limit": 24}),
    (6,  "catalog/facets", "/api/catalog/facets", {}),
    (5,  "catalog/categories", "/api/catalog/categories", {}),
    (4,  "catalog/editions", "/api/catalog/editions", {}),
]

_weighted = []
for w, label, path, params in REQUESTS:
    _weighted += [(label, path, params)] * w


def _resolve(params):
    out = {}
    for k, v in params.items():
        out[k] = random.choice(v) if isinstance(v, list) else v
    return out


lat = defaultdict(list)       # label -> [ms]
status = defaultdict(int)     # http code -> count
cache = defaultdict(int)      # cf-cache-status -> count
errors = []
stop_at = 0.0


async def user(client, uid):
    # Stagger start across the first 2s so we don't thundering-herd at t=0.
    await asyncio.sleep(random.uniform(0, 2.0))
    while time.monotonic() < stop_at:
        label, path, params = random.choice(_weighted)
        t0 = time.monotonic()
        try:
            r = await client.get(BASE + path, params=_resolve(params))
            dt = (time.monotonic() - t0) * 1000
            lat[label].append(dt)
            status[r.status_code] += 1
            cache[r.headers.get("cf-cache-status", "-")] += 1
            if r.status_code >= 500 and len(errors) < 20:
                errors.append(f"{label} [{r.status_code}]: {r.text[:300]}")
        except Exception as e:
            dt = (time.monotonic() - t0) * 1000
            status["ERR"] += 1
            if len(errors) < 20:
                errors.append(f"{label}: {type(e).__name__}: {e}")


def pct(vals, p):
    if not vals:
        return 0.0
    s = sorted(vals)
    i = min(len(s) - 1, int(round((p / 100) * (len(s) - 1))))
    return s[i]


async def main():
    global stop_at
    print(f"Load test: {BASE}  |  {CONCURRENCY} concurrent users  |  {DURATION:.0f}s")
    print("warming up / staggering start over 2s ...\n")
    limits = httpx.Limits(max_connections=CONCURRENCY + 20,
                          max_keepalive_connections=CONCURRENCY + 20)
    timeout = httpx.Timeout(30.0, connect=10.0)
    try:
        client = httpx.AsyncClient(http2=True, limits=limits, timeout=timeout,
                                   headers={"User-Agent": "celr-loadtest/1.0"},
                                   follow_redirects=True)
    except Exception:
        client = httpx.AsyncClient(limits=limits, timeout=timeout,
                                   headers={"User-Agent": "celr-loadtest/1.0"},
                                   follow_redirects=True)
    async with client:
        stop_at = time.monotonic() + DURATION + 2.0  # +2 for the stagger window
        wall0 = time.monotonic()
        await asyncio.gather(*[user(client, i) for i in range(CONCURRENCY)])
        wall = time.monotonic() - wall0 - 1.0  # approx active window

    all_lat = [x for v in lat.values() for x in v]
    total = sum(status.values())
    ok = sum(c for s, c in status.items() if isinstance(s, int) and 200 <= s < 300)
    errs = total - ok
    print("=" * 68)
    print(f"requests:    {total}   ok(2xx): {ok}   errors/non-2xx: {errs} "
          f"({100*errs/max(total,1):.2f}%)")
    print(f"throughput:  {total/max(wall,1):.1f} req/s   over ~{wall:.0f}s "
          f"active   @ {CONCURRENCY} concurrent")
    print(f"latency ms:  p50={pct(all_lat,50):.0f}  p90={pct(all_lat,90):.0f}  "
          f"p95={pct(all_lat,95):.0f}  p99={pct(all_lat,99):.0f}  "
          f"max={max(all_lat) if all_lat else 0:.0f}")
    print(f"status:      " + "  ".join(f"{k}:{v}" for k, v in sorted(status.items(), key=str)))
    print(f"cf-cache:    " + "  ".join(f"{k}:{v}" for k, v in sorted(cache.items())))
    print("-" * 68)
    print(f"{'endpoint':28} {'n':>6} {'p50':>7} {'p95':>7} {'p99':>7} {'max':>7}")
    for label in sorted(lat, key=lambda k: -pct(lat[k], 95)):
        v = lat[label]
        print(f"{label:28} {len(v):>6} {pct(v,50):>7.0f} {pct(v,95):>7.0f} "
              f"{pct(v,99):>7.0f} {max(v):>7.0f}")
    if errors:
        print("-" * 68)
        print("sample errors:")
        for e in errors[:10]:
            print("  ", e)


if __name__ == "__main__":
    asyncio.run(main())
