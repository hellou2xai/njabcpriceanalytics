# Pricing-cache index inventory (PERF_TODO #1)

What to index in the DuckDB pricing cache, why, and the measured win. Built from
a full sweep of every request-time query against the cache tables (backend/
routers, pricing.py, rip_utils.py, assistant.py, enrichment_join.py, etc.).

## The core finding (measured, DuckDB 1.5.0, 176k-row cpl_enriched)

A point lookup by UPC, three ways:

| Query | Time | Note |
| --- | --- | --- |
| `WHERE LTRIM(upc,'0') = ?` | **20.2 ms** | the function runs on all 176k rows, every call |
| `WHERE upc_norm = ?` (plain col, no index) | **1.46 ms** | dropping the function alone is ~14x |
| `WHERE upc_norm = ?` (plain col, indexed) | **0.20 ms** | the index adds another ~7x (~100x total) |

Batch (the Products grid fires one `upc IN (...)` per screen):

| Query | Time |
| --- | --- |
| `WHERE LTRIM(upc,'0') IN (15 upcs)` | 23.4 ms |
| `WHERE upc_norm IN (15 upcs)` indexed | 0.79 ms |
| `WHERE upc_norm IN (60 upcs)` indexed | 1.76 ms (whole grid, one query) |

Two independent levers, both needed:
1. **Normalized plain column.** Every hot filter wraps the column in a function
   (`LTRIM(upc,'0')`, `CAST(rip_code AS VARCHAR)`). A function on a column makes
   the index unusable AND forces a per-row scan of all 176k rows. Precompute the
   normalized value into a plain column at cache-build time.
2. **ART index on that column.** Turns the plain scan into a real point probe.

So the work is: add 4 normalized columns, build 20 indexes, and rewrite the
hottest lookups to filter the plain column (not the function).

## Normalized columns to add at cache-build time (4)

Added in `build_pricing_cache()` AFTER the final price_trend `CREATE OR REPLACE
TABLE cpl_enriched` (that statement rebuilds the table and would drop anything
added earlier). Computed `LTRIM(CAST(upc AS VARCHAR),'0')` so it survives the
Postgres-vs-parquet type drift (UPC can come back numeric from Postgres).

| Table | New column | Source expression |
| --- | --- | --- |
| cpl_enriched | `upc_norm` | `LTRIM(CAST(upc AS VARCHAR),'0')` |
| cpl (raw) | `upc_norm` | `LTRIM(CAST(upc AS VARCHAR),'0')` |
| rip | `upc_norm` | `LTRIM(CAST(upc AS VARCHAR),'0')` |
| combo | `upc_norm` | `LTRIM(CAST(upc AS VARCHAR),'0')` |

Already normalized, reuse as-is (no new column): `product_enrichment.upc`,
`sku_mapping.upc_norm`, `celr_products.upc_norm`, `celr_family_keys.key`.

## Indexes (20 in the cache + 1 follow-up on Postgres)

### cpl_enriched (4) — the main catalog, hottest table
| Index | Columns | Serves |
| --- | --- | --- |
| idx_cpl_upc_norm | (upc_norm) | per-card `/search?upcs=`, product detail, cross-distributor compare. The #1 win. |
| idx_cpl_ws_ed | (wholesaler, edition) | the `MAX(edition) per wholesaler` current-edition join (every grid/board/detail) |
| idx_cpl_rip_code | (rip_code) | group_by_rip / "products under this RIP" |
| idx_cpl_combo_code | (combo_code) | combo membership / bundle views |

### cpl (2) — the RAW price list (partial-QD windows, RIP-trap detection)
| Index | Columns | Serves |
| --- | --- | --- |
| idx_cplraw_upc_norm | (upc_norm) | partial-QD / full-month qty lookups in pricing.py (per card) |
| idx_cplraw_ws_ed | (wholesaler, edition) | current-edition raw-row scans |

### rip (4) — RIP sheet, the tier-ladder source
| Index | Columns | Serves |
| --- | --- | --- |
| idx_rip_upc_norm | (upc_norm) | RIP codes for a given product (tier building, per card) |
| idx_rip_ws_ed | (wholesaler, edition) | current-edition RIP join |
| idx_rip_ws_ed_code | (wholesaler, edition, rip_code) | rip-siblings / case-mix basket (the members modal) |
| idx_rip_code | (rip_code) | cross-distributor rip_code scans |

### combo (3)
| Index | Columns | Serves |
| --- | --- | --- |
| idx_combo_upc_norm | (upc_norm) | combo rows for a product |
| idx_combo_ws_ed | (wholesaler, edition) | current-edition combo join |
| idx_combo_code | (combo_code) | combo-by-code lookup (cart, deals) |

### celr_products (2) — family registry
| Index | Columns | Serves |
| --- | --- | --- |
| idx_celr_upc_norm | (upc_norm) | barcode -> family (grid grouping, compare) |
| idx_celr_cpn | (cpn) | family -> its barcodes (reverse) |

### single-table lookups (7)
| Index | Table (columns) | Serves |
| --- | --- | --- |
| idx_celr_keys_key | celr_family_keys (key) | placeholder-barcode rows -> family by name key |
| idx_pe_upc | product_enrichment (upc) | batched image/spec attach per page |
| idx_sku_dist_upcn | sku_mapping (distributor, upc_norm) | batched ABG SKU attach per page |
| idx_credits | rip_credits (rip_code, wholesaler, edition, upc) | half-case credit per tier |
| idx_ai_deal | ai_deal_blurbs (wholesaler, edition, upc) | deal blurb on detail/TS deals |

### Follow-up (Postgres, NOT the cache)
`ai_product_blurbs` and `ai_mover_blurbs` are read straight from Postgres
(`get_pg()`), not materialised into the cache, so their indexes don't belong
here. Both already have a PK on `(wholesaler, upc, edition[, direction])`, but
the detail-page lookup wraps it in `LTRIM(upc,'0')` which defeats the PK. A
Postgres functional index `ON ai_product_blurbs (wholesaler, LTRIM(upc,'0'),
edition)` (and the same on `ai_mover_blurbs`) is the matching fix. Out of scope
for PERF_TODO #1; logged here.

## Hot call-sites to rewrite to the plain column (so the index is actually used)

The index is dead weight unless the query stops wrapping the column in a
function. Rewrite `LTRIM(upc,'0') = X` -> `upc_norm = X` (and the IN-list form)
at these per-request lookups. NON-hot, once-per-month scans can stay as-is.

- `/api/catalog/search?upcs=` per-card + batched fetch (routers/catalog.py)
- product detail (routers/catalog.py)
- rip-siblings / group_by_rip (routers/catalog.py)
- cross-distributor compare (routers/compare.py)
- pricing.py tier/price lookups joined on `LTRIM(upc,'0')`

### Gotcha: materialising `upc_norm` collides with existing query aliases
Many queries already projected `LTRIM(upc,'0') AS upc_norm`. Once a REAL
`upc_norm` column exists on the base table, two things break and were fixed:
1. `SELECT *, LTRIM(upc,'0') AS upc_norm` -> duplicate column name. Fixed by
   dropping the now-redundant alias (the `*` already carries it). 3 sites in
   catalog.py (cross_distributor / cross_distributor_combined / distributor_exclusive).
2. `SELECT LTRIM(upc,'0') AS upc_norm ... GROUP BY upc_norm` -> the `GROUP BY`
   now binds to the real COLUMN, leaving the SELECT's `LTRIM(...)` ungrouped
   (Binder Error). Fixed by selecting the bare `upc_norm` column. 2 base-table
   `ambiguous` CTEs in catalog.py. (CTE-sourced GROUP BYs are unaffected.)
These only surface on the compare BOARDS, which the tool-level eval does not
call. Verified by invoking the board endpoints directly + a TestClient pass.

## Notes / non-goals
- DuckDB has NO covering/`INCLUDE` indexes (Postgres-ism). ART only. No INCLUDE.
- Indexes help point lookups + IN-lists + equality joins; they do NOT speed the
  default full-grid sort (zonemaps already prune, and that path is memoized).
- Build cost is ~80 ms/index on 176k rows, paid once per cache build (reload),
  not per request. Memory per ART index is a few MB.
- Indexes live in the cache .duckdb file, so read-only worker connections get
  them for free after a reload.
