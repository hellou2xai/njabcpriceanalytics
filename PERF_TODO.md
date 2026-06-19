# Performance TODO (resume here)

Prioritized optimizations for the catalog/web app. #1 is the long-standing ask.

## 1. Index the pricing cache (PRIORITY — "make the query cheap so millions can query")
The pricing data is a DuckDB cache file (`backend/pricing_cache.py` builds native
tables from Postgres/parquet). It has **NO indexes**, so the hot point-lookup
queries each do a full ~134k-row scan. These are exactly what an index fixes:
- per-card Products fetches (`/search?upcs=<upc>&include_tiers=true`) — fired per visible card
- product detail (`/product/...?upc=`)
- `/rip-siblings/<code>` (by rip_code + upc)
- cross-distributor / compare joins, and the group_by_rip join (on wholesaler, edition, upc)

Plan:
- In `build_pricing_cache()`, after creating `cpl_enriched`, add a **normalized
  UPC column** `upc_norm = LTRIM(CAST(upc AS VARCHAR),'0')` and `CREATE INDEX` on it
  — most queries filter `LTRIM(upc,'0') = X`, and a function on the column defeats
  any index on raw `upc`, so the indexed column must be the normalized one.
- Add indexes (DuckDB ART) on the join/filter keys: `upc_norm`, `(wholesaler, edition)`,
  `rip_code`. Also `rip` table on `(wholesaler, edition, rip_code, upc)`.
- Rewrite the hot lookups to filter `upc_norm = X` (not `LTRIM(upc,'0')=X`) so the
  index is used. Keep behavior identical.
- Caveat: DuckDB indexes help POINT LOOKUPS + JOINS; the default-grid full-scan
  sort benefits less (zonemaps already prune) — but that path is already memoized.
- Benchmark scan vs index before/after. NOTE: the local benchmark couldn't open
  the cache because the dev backend holds the file — stop the backend first
  (`taskkill` the :8000 uvicorn) or copy the .duckdb and test on the copy.
- Rebuild required after build changes:
  `python -c "from nj_abc_parser.derive import build_all; build_all()"` then
  `PRICING_SOURCE=parquet python -c "from backend.pricing_cache import build_pricing_cache; build_pricing_cache()"`.

## 2. Batch the per-card Products fetches (collapse the request storm)
Each visible card fires its OWN `rep-tiers` + `card-cross-dist` requests
(`frontend/src/components/ProductsGrid.tsx` ~lines 657-726), so ~10-15 cards =
~20-30 `/search?upcs=<one>&include_tiers=true` requests per screen.
Plan: lift to the grid level — collect all visible cards' rep UPCs, fire ONE
`/search?upcs=<csv>&include_tiers=true`, build an upc_norm→rows map, pass each
card its slice (one batched request serves BOTH rep-tiers and cross-dist, since
it returns every distributor's rows for those UPCs). Target: ~20-30 req/screen → 1-2.

## 3. Cap the connection-pool overflow (real defect in shipped code)
`backend/db.py` `get_duckdb()`: when the pool (POOL_SIZE=8) is exhausted, it falls
back to UNBOUNDED temporary connections — a 300-user burst could open hundreds and
blow memory. Cap it (hard max of N extra, or just block/queue), and size the pool
to the box (`POOL_SIZE = max(8, cpu_count*2)`).

## 4. Optional follow-ups
- HTTP `Cache-Control` on the user-independent GET endpoints (`/search`, `/facets`,
  boards) so browser/CDN absorbs repeat load (they're already memoized server-side).
- Confirm group_by_rip cold cost after indexing; if still heavy, precompute the RIP
  cluster membership into a cache table (was deferred — the cost is wide-row fan-out).

## Context / decisions already shipped (don't redo)
- catalog `/search` + `/facets` memoized (cache_util, keyed on params + ET date +
  pricing file path) + warmed at startup/reload. Repeat loads instant.
- DuckDB access is a per-worker POOL of independent connections (NOT one shared
  connection — that serialized everything because each runs `SET threads TO 1`).
- See memory: catalog-search-performance, textsize-zoom-footer-cutoff.
