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

## 50 users x 25s — 2026-06-21 21:35 UTC

- Logins: 50/50 ok | login p50=3974ms p95=4779ms max=4797ms
- Requests: 804 in 31.4s = 25.6 req/s | errors: 755 (93.9%) | 304 cache-hits: 49 (6.1%)
- Latency drift: first-half p95=3819ms -> second-half p95=1448ms
- Error statuses: {'502': 755}

```
endpoint                       n     p50     p95     p99     max   304%   err%
search(text)                 201     814    4406    5227    5621    16%  84.1%
search(include_tiers)        201     889    3132    3631    4203     8%  91.5%
cart                         201     909    2398    2780    3041     0% 100.0%
facets                       201     804    1371    1657    1923     0% 100.0%
```

## 50 users x 25s — 2026-06-21 21:37 UTC

- Logins: 50/50 ok | login p50=3870ms p95=4856ms max=5166ms
- Requests: 748 in 30.3s = 24.6 req/s | errors: 716 (95.7%) | 304 cache-hits: 32 (4.3%)
- Latency drift: first-half p95=5367ms -> second-half p95=1371ms
- Error statuses: {'502': 716}

```
endpoint                       n     p50     p95     p99     max   304%   err%
search(text)                 187     951    5947    6350    6555    11%  89.3%
search(include_tiers)        187     831    1527    3958    5060     6%  93.6%
cart                         187     903    2537    3675    7224     0% 100.0%
facets                       187     819    1350    1477    1902     0% 100.0%
```

## 50 users x 25s — 2026-06-21 21:41 UTC

- Logins: 50/50 ok | login p50=3952ms p95=4630ms max=4648ms
- Requests: 340 in 38.9s = 8.7 req/s | errors: 0 (0.0%) | 304 cache-hits: 142 (41.8%)
- Latency drift: first-half p95=7696ms -> second-half p95=24285ms

```
endpoint                       n     p50     p95     p99     max   304%   err%
search(text)                  85     491   12007   18136   19694    49%   0.0%
search(include_tiers)         85     214   17294   18919   19747    59%   0.0%
cart                          85    4370   28720   29611   29624     0%   0.0%
facets                        85     167    4377   14327   18019    59%   0.0%
```

## Cart optimization result (offer_grid memoized + no double-pricing)

50 users, warm, post-deploy: **0 errors (no crash)**.

| metric | before cart-opt | after cart-opt |
|---|---|---|
| cart p50 | 12.3 s | **4.4 s** |
| cart p95 | 28.2 s | 28.7 s |

So the cart-opt cut the typical (p50) cart load ~2.8x, but the tail (p95) under
50 concurrent is still ~28 s and the whole instance degrades over the run
(first-half p95 7.7 s -> second-half 24.3 s = arrival rate > service rate).

**Why the tail persists:** GET /api/cart still runs, per load, the CPU-heavy
attach_tiers pricing + attach_next_month_prices + mix-RIP + cross-distributor
queries, single-threaded (threads=1) on 2 cores. 50 concurrent cart loads + the
50-way bcrypt login burst saturate the CPUs; cached/304 reads then queue behind
them too.

**Remaining cart levers:**
1. Precompute/cache the tier ladder (attach_tiers is user-independent per
   edition+UPC+pack -> PRECOMPUTE #10 sku_tiers) so cart pricing is a lookup.
2. Compute suggestions lazily (separate endpoint / on expand) so the base cart
   loads fast; analyze_next_month/mix/cross only when the panel is opened.
3. Phase 3 (threads>1 for uncacheable paths) + Phase 4 (more CPU) — 2 cores
   cannot serve dozens of concurrent multi-second cart queries regardless.

## 100 users x 25s — 2026-06-21 21:45 UTC

- Logins: 100/100 ok | login p50=7446ms p95=9067ms max=9131ms
- Requests: 436 in 36.8s = 11.8 req/s | errors: 254 (58.3%) | 304 cache-hits: 129 (29.6%)
- Latency drift: first-half p95=4699ms -> second-half p95=21583ms
- Error statuses: {'502': 254}

```
endpoint                       n     p50     p95     p99     max   304%   err%
search(text)                 109    1500   22757   23026   23294    65%  17.4%
search(include_tiers)        109    1665   21276   21583   21956    42%  39.4%
cart                         109    9017   19869   20806   22032     0%  87.2%
facets                       109     746    1965    3364    4443    11%  89.0%
```

## 100 users (warm) — capacity exceeded

| metric | 50 users (warm) | 100 users (warm) |
|---|---|---|
| errors | 0% | **58% (502)** |
| login p50 | ~4 s | **7.4 s** (p95 9 s) |
| search(text) p95 | 0.8 s* | 22.8 s |
| cart p95 | 28 s | 19.9 s (87% err) |
| 304 cache-hits | ~42% | 30% |

(*best fully-warm 50-user run.) At 100 concurrent the 2-CPU instance is saturated:
the 100-way bcrypt login burst alone takes ~7-9 s each, the uncacheable cart +
sheer request volume pin both cores, and ~58% of requests 502. Caching still
serves ~30% as 304s but can't offset the CPU wall. Conclusion: 100 concurrent
needs Phase 4 (more CPU / horizontal scale behind a load balancer) — software
tuning alone won't get 2 cores there. Login bcrypt cost is also a real factor at
this concurrency.

## 100 users x 25s — 2026-06-21 21:53 UTC

- Logins: 100/100 ok | login p50=7252ms p95=8667ms max=8981ms
- Requests: 532 in 41.3s = 12.9 req/s | errors: 0 (0.0%) | 304 cache-hits: 234 (44.0%)
- Latency drift: first-half p95=2522ms -> second-half p95=27061ms

```
endpoint                       n     p50     p95     p99     max   304%   err%
search(text)                 133    1019    2222   10687   11230    53%   0.0%
search(include_tiers)        133     406    2419    9790   11280    64%   0.0%
cart                         133   14993   28796   29689   29994     0%   0.0%
facets                       133     183    6180   12791   14203    59%   0.0%
```

## 100 users (properly warmed) — 0 errors

The earlier "58% errors at 100" run was COLD (the pre-warm helper had a bug). With
the server warm, 100 concurrent users completes with **0 errors** — the service
stays up and the cached reads are fast:

| endpoint | p50 | p95 | 304% | err% |
|---|---|---|---|---|
| search(text) | 1.0 s | 2.2 s | 53% | 0% |
| search(include_tiers) | 0.4 s | 2.4 s | 64% | 0% |
| facets | 0.18 s | 6.2 s | 59% | 0% |
| **cart** | **15.0 s** | **28.8 s** | 0% | 0% |
| login (burst) | 7.3 s | 8.7 s | — | — |

44% of all reads served as cheap 304s. Remaining bottlenecks at 100 concurrent:
(1) **cart** — uncacheable + CPU-heavy (p50 15 s), drags the tail and the
second-half drift (p95 2.5 s -> 27 s); (2) **login** — 100-way bcrypt on 2 cores
(~7 s). Caching (Phase 1) is what makes 100 users survivable; cart precompute +
lazy suggestions and login-cost tuning are the next ceilings, then CPU for headroom.

## 50 users x 25s — 2026-06-21 21:58 UTC

- Logins: 50/50 ok | login p50=3924ms p95=4529ms max=4550ms
- Requests: 432 in 33.2s = 13.0 req/s | errors: 0 (0.0%) | 304 cache-hits: 150 (34.7%)
- Latency drift: first-half p95=7211ms -> second-half p95=13029ms

```
endpoint                       n     p50     p95     p99     max   304%   err%
search(text)                 108     386     899    1037    1101    48%   0.0%
search(include_tiers)        108     194     419     492     584    44%   0.0%
cart                         108    7916   15183   18890   21610     0%   0.0%
facets                       108     186    8193   10891   14201    47%   0.0%
```
