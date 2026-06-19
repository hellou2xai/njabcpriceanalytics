# Precompute opportunities by page

What each data-heavy page queries, how it's computed **now**, and what could be
**precomputed** (at cache build time / `derive.py` / a materialized table) so the
request becomes a cheap keyed lookup instead of a live scan/join.

Caching legend:
- **memoized** = `cache_util` in-process memo (keyed on params + ET date + pricing
  file path); repeat identical requests served from RAM, no DB hit.
- **warmed** = a startup/reload daemon thread pre-runs it so the first hit is warm.
- **live** = computed from scratch on every request (no memo) — top precompute targets.
- All pricing reads go through the per-worker DuckDB connection **pool**.

| Page | Endpoint(s) | How it's computed now | What can be precomputed |
|---|---|---|---|
| Products | `catalog.search`, `catalog.facets` | Grid query memoized + warmed; facets memoized + warmed. **Per card** still fires its own `rep-tiers` + `card-cross-dist` (`/search?upcs=<one>&include_tiers`) on scroll-in (~20–30 req/screen). | **Index `upc_norm`** so the per-card lookups stop full-scanning 134k rows. Precompute a per-SKU **card summary** (rep `price_3mo`, `best_qd`, `best_rip`, cross-dist best) at build so cards need no fetch. Batch remaining per-card calls into one. |
| Catalog (admin) | `catalog.search`, `catalog.facets`, `deals.comboIndex` | Same as Products (memoized + warmed). | Same as Products. |
| Product detail | `catalog.product`, `catalog.ripSiblings`, `catalog.search` (sizes) | **live** point lookups by UPC — each scans 134k rows (`LTRIM(upc,'0')=X`). | **Index `upc_norm` + `rip_code`** (biggest win for these point lookups). Precompute per-product tier ladder + sibling set per edition. |
| Time-Sensitive Deals | `deals.timeSensitive` | **warmed** (`warm_time_sensitive_cache`) + memoized. | Materialize the dated-deal list per edition at build (`derive.py`) → pure read. |
| Best Quantity Discounts | `compare.bestQd` | **live** — deepest-QD-per-product across distributors, heavy join every request (compare.py is NOT memoized). | **Materialize the board**: deepest QD per (product, edition) into a table at build → cheap lookup + sort. Add memo as a stopgap. |
| Best RIPs | `compare.bestRips` | **live** — same shape as Best QD. | Materialize deepest-RIP-per-product per edition at build. |
| Compare Prices | `compare.products`, `compare.tiers`, `catalog.priceHistory` | **live** — cross-distributor match (UPC + size + pack + vintage) computed per request. | Precompute a **cross-distributor match table** (UPC↔distributors, like-for-like) at build; memoize the comparison. |
| Compare RIPs | `compare.rips` | **live**. | Same cross-distributor precompute + memo. |
| Edition Comparison | `compare.editions`, `compare.editionOptions`, `compare.editionSparklines` | **live** month-over-month per SKU. | `price_3mo`/`next_*` already precomputed in `derive.py`; extend to a per-SKU multi-edition series so the page is a read. |
| Price 360 | `compare.price360` | **live** per-UPC all-distributor/all-size roll-up. | Precompute a per-UPC "360" summary at build; index `upc_norm`. |
| Price Movers / Drops / Increases | `analytics.priceMovers` | **memoized + warmed** (`warm_pm_cache_async`); `price_trend` precomputed in `derive.py`. | Mostly done. Could materialize the mover list per edition. |
| Dashboard | `analytics.dashboard`, `analytics.priceMovers`, `deals.discounts`/`timeSensitive`, `catalog.crossDistributor*`, `catalog.newItems`, `catalog.priceComparison`, `catalog.qaAnomalies` | KPIs + movers memoized/warmed; cross-distributor + QA are **live**. | Precompute a single **dashboard snapshot** per edition at build (one keyed read for the whole hero). |
| New Items | `catalog.search` (introduced_within_months) | Goes through memoized `/search`; `introduced_edition` precomputed in `derive.py`. | Mostly done; could materialize the new-items set per edition. |
| Combos | `deals.combos` | **memoized** (`cached_response`). | Could materialize the combo index at build. |
| Discounts / Major Discounts | `deals.discounts`, `catalog.categories` | **memoized** (`cached_response`). | Materialize top-discounts per edition; index. |
| RIP Products | `deals.ripProducts`, `catalog.categories` | **memoized** + **warmed** (`warm_rip_cache`). | Mostly done; materialize the RIP-products list per edition. |
| Clearance | `deals.clearance`, `catalog.categories` | **memoized** (`cached_response`). | Materialize closeout list per edition. |
| Alerts | `alerts.get`, `alerts.markRead` | Postgres user-state, already **indexed** (`idx_alerts_rollup`). | N/A (per-user, already indexed). |

## Cross-cutting (covers most of the "live" rows above)
1. **Index the pricing cache** — `upc_norm` (normalized) + `(wholesaler, edition)` +
   `rip_code` ART indexes in `build_pricing_cache()`. Turns every point lookup
   (product detail, rip-siblings, per-card, price360) from a 134k-row scan into a
   keyed lookup. See `PERF_TODO.md` #1.
2. **Materialize the boards** — deepest QD / deepest RIP / cross-distributor match,
   per (product, edition), at `derive.py`/build time. The compare.py boards
   (Best QD, Best RIPs, Compare Prices/RIPs, Price 360) are the only big endpoints
   with NO memoization and the heaviest live joins.
3. **Memoize compare.py** — quick stopgap before materializing (same `cache_util`
   pattern already used by catalog.py / deals.py / analytics.py).
