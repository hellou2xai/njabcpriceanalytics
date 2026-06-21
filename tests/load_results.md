# Load test results (after Phase 1 caching, warm ETag cache)

## 15 users x 25s — 2026-06-21 20:56 UTC

- Logins: 15/15 ok | login p50=1286ms p95=1395ms max=1401ms
- Requests: 164 in 28.1s = 5.8 req/s | errors: 0 (0.0%) | 304 cache-hits: 58 (35.4%)
- Latency drift: first-half p95=5719ms -> second-half p95=4617ms

```
endpoint                       n     p50     p95     p99     max   304%   err%
search(text)                  41     200    5592    5719    5719    54%   0.0%
search(include_tiers)         41     206    6384    6993    6993    32%   0.0%
cart                          41    3588    5207    5785    5785     0%   0.0%
facets                        41     126    4176    4617    4617    56%   0.0%
```

## 30 users x 25s — 2026-06-21 20:57 UTC

- Logins: 30/30 ok | login p50=2483ms p95=2723ms max=2731ms
- Requests: 296 in 31.7s = 9.3 req/s | errors: 0 (0.0%) | 304 cache-hits: 137 (46.3%)
- Latency drift: first-half p95=10100ms -> second-half p95=10919ms

```
endpoint                       n     p50     p95     p99     max   304%   err%
search(text)                  74     284     469     526     586    51%   0.0%
search(include_tiers)         74     208     400     422    1687    69%   0.0%
cart                          74    7589   11877   12933   14189     0%   0.0%
facets                        74     173     296     306    6495    65%   0.0%
```

## 50 users x 25s — 2026-06-21 20:58 UTC

- Logins: 50/50 ok | login p50=3844ms p95=4446ms max=4479ms
- Requests: 332 in 36.1s = 9.2 req/s | errors: 0 (0.0%) | 304 cache-hits: 125 (37.7%)
- Latency drift: first-half p95=5674ms -> second-half p95=26879ms

```
endpoint                       n     p50     p95     p99     max   304%   err%
search(text)                  83     385     811     877     882    51%   0.0%
search(include_tiers)         83     125     410     482     603    51%   0.0%
cart                          83   12273   28230   28477   28979     0%   0.0%
facets                        83     182     285     354     481    49%   0.0%
```

## Summary / interpretation

**Before Phase 1 (cold, no HTTP caching):** 50 users → 92.5% 502s and the
process crashed (~2-3 min outage).

**After Phase 1 (warm ETag cache):** 50 users → **0 errors, no crash.** The
user-independent endpoints are now fast under load (≈50% served as cheap 304s):

| endpoint | 50-user p50 | 50-user p95 |
|---|---|---|
| search (text) | 385 ms | 811 ms |
| search (include_tiers) | 125 ms | 410 ms |
| facets | 182 ms | 285 ms |
| **cart** | **12,273 ms** | **28,230 ms** |

**New bottleneck = `GET /api/cart`.** It is user-specific (not cacheable) and now
runs the smart-cart suggestion engine on every load (analyze_lines + per-line
offer_grid + tier attach, each opening DuckDB connections). Under 50 concurrent
cart loads on 2 CPU (threads=1) these serialize → p95 28 s, degrading over the run
(first-half p95 5.7 s → second-half 26.9 s).

**Next levers (cart):**
1. The per-line *comparison* (offer_grid by edition+upc) is user-INDEPENDENT —
   memoize it server-side (cache_util) keyed on (upc, edition); only the
   qty-dependent suggestions need per-request compute.
2. Compute suggestions lazily (separate endpoint / on expand) so the base cart
   loads fast.
3. Cut per-line connection churn (analyze_lines + offer_grid each open their own
   DuckDB connection per cart load).
Plus the still-pending Phase 0 (cap pool overflow) and the threads=1 → multi-core
change for the uncacheable paths.
