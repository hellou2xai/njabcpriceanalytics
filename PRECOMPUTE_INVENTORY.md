# Precomputation inventory (PERF_TODO #4)

Where the request path does expensive work that could be precomputed once at
cache-build time, why, and the rough payoff. Built from a full sweep of the
hot endpoints (`routers/catalog.py` `/search` + `/product`, `routers/compare.py`
boards, `pricing.py` `attach_*`, `enrichment_join.py`) against the precomputed
columns that already live in `cpl_enriched` (`nj_abc_parser/derive.py`) and the
cache build (`backend/pricing_cache.py`).

This extends PERF_TODO #4 (image-sort rank + denormalised enrichment + RIP
cluster membership) with the rest of the work. The indexing effort
(PRICING_INDEX_INVENTORY.md, adding `upc_norm` + ~18 ART indexes) is a
SEPARATE lever and is assumed done. Do not re-litigate `upc_norm` here; it is
referenced as a dependency for several items below.

## How to read the "where it belongs" column

Two places to precompute, and the project rule decides which:

- **derive.py (the parquet).** A column that is a deterministic function of the
  raw CPL/RIP/COMBO data for a single `(edition, distributor)` row, or a window
  over editions of the same SKU. FOUNDATION rule: "never recompute a precomputed
  column from `cpl_enriched`; fix `derive.py` and rebuild the parquet instead."
  Prod loads the parquet into Postgres, then the cache is built FROM Postgres, so
  a derive.py column survives the round-trip and serves prod for free.
- **pricing_cache.py (the cache build).** A column/table that depends on a
  JOIN ACROSS tables that only co-exist in the cache (enrichment, sku_mapping,
  celr_products, combo), or that is keyed on the pricing-cache file path. These
  are already where `in_combo`, `unit_volume_std`, the brand-from-enrichment
  overwrite, and the `price_trend` safety net live.

Anything that is genuinely per-request (depends on "today", the user's case
quantity, the search query, or `as_of`) CANNOT be precomputed into a row; the
most you can precompute is the static input it reads (e.g. `rip_windows`, which
is already done — the live price still resolves "today" at query time).

---

## Ranked by payoff / effort

| # | Opportunity | Hotness | Belongs in | Effort |
|---|---|---|---|---|
| 1 | Default-grid image-sort rank as a column | every grid load (the ~9s sort) | cache build | low |
| 2 | Denormalise `image_url` + `enrichment_name` + `abg_sku` into cpl_enriched | every list page (3 `_attach_*` loops) | cache build | medium |
| 3 | Precompute RIP cluster membership + cluster size table | every grouped grid + compare boards | cache build | medium-high |
| 4 | `best_qd` (deepest QD bracket) as columns | every Products card | derive.py | low |
| 5 | CELR family `(cpn, header)` join as columns | every Products grid (3 lookups + Python) | cache build | low-medium |
| 6 | `multi_distributor` / `distributor_count` precompute | every list page (`_attach_dup_upc`) | cache build | medium |
| 7 | `rip_all_codes` list per (ws, ed, upc) | every grouped grid | derive.py or cache | low |
| 8 | Materialise `current_edition` flag per row | every grid/board/detail (the MAX(edition) self-join) | cache build | low |
| 9 | Stop re-CASTing `rip_code`/`upc` to VARCHAR at query time | every catalog/compare query | derive.py (typed cols) | medium |
| 10 | `attach_price_3mo` / `attach_next_tiers` per-edition tier ladders | per-card when include_tiers | cache table (heavy) | high |
| 11 | `_case_mix_sizes` / `_cpn_for_upcs` per-board joins | every compare board | cache table | medium |

Items 1-3 are PERF_TODO #4 already named; they are kept here with the concrete
build SQL and the edition-scoping notes. 4-9 are new.

---

## 1. Default-grid image-sort rank

**STATUS: DONE.** `has_image` BOOLEAN materialised in pricing_cache.py (real
barcode AND a non-empty Go-UPC image, keyed via upc_norm); the grid ORDER BY is
now `has_image DESC, ...`. Proven equal to the correctly-correlated per-row
expression (0 mismatches on a 176k synthetic) and ~6x faster on a warm sort.
Also fixed a latent bug it exposed: the old `images_first` EXISTS used an
unqualified `upc` that bound to the INNER product_enrichment.upc, so it floated
EVERY real-barcode row up, not the image-having ones. has_image does the correct
per-row match (user approved the behaviour change).

**What.** The default Products grid sorts `images_first` (products with a Go-UPC
image float to the top of the storefront). PERF_TODO calls this the ~9s sort
over 134k rows.

**Where now.** `routers/catalog.py:1487-1503`. The ORDER BY embeds a correlated
`EXISTS (SELECT 1 FROM product_enrichment _img WHERE _img.upc = LTRIM(CAST(upc
AS VARCHAR),'0') AND _img.image_url IS NOT NULL ...)` plus the `_VALID_UPC_SQL`
predicate — evaluated per row, every request, before pagination. The default
grid (`q=''`, `sort=product_name`, `images_first=True`) is warmed
(`warm_catalog_grid`, `catalog.py:1843`) and memoised, but the cold build is the
9s, and any filtered variant re-pays it.

**Precompute.** A plain boolean column `has_image` on cpl_enriched, set in the
cache build (enrichment table only exists there):

```sql
ALTER TABLE cpl_enriched ADD COLUMN has_image BOOLEAN DEFAULT false;
UPDATE cpl_enriched SET has_image = true
  WHERE upc_norm IN (SELECT upc FROM product_enrichment
                     WHERE image_url IS NOT NULL AND image_url <> '');
```

(The `_VALID_UPC_SQL` "real barcode" gate should fold in too, so a placeholder
barcode that happens to share an enrichment row doesn't sort up — either
`AND <valid-upc-predicate>` in the UPDATE, or a second `is_clean_upc` column.)
Then the ORDER BY is `has_image DESC, product_name ASC` — a plain column read
the zonemap/index can drive, no correlated subquery.

**Payoff.** This is the single most expensive sort in the app and it runs on the
landing grid. Removing the per-row EXISTS is the headline win of #4.

**Edition scoping.** Safe. Image presence is a property of the UPC, not the
edition. No RIP/price involved, so no recycled-code risk.

**Belongs in.** Cache build (`pricing_cache.py`), NEXT TO the existing
`in_combo` / `unit_volume_std` UPDATEs and BEFORE the price_trend `CREATE OR
REPLACE` (or re-added after it, like `upc_norm`, since that statement rebuilds
the table). Not derive.py — the enrichment table isn't in the parquet.

---

## 2. Denormalise enrichment image / name / SKU into cpl_enriched

**What.** Every list page runs three Python post-pagination loops to attach
per-row enrichment: `_attach_enrichment_image` (image_url + enrichment_name),
`_attach_sku_mapping` (abg_sku), and the brand is already pre-joined.

**Where now.** `enrichment_join.py:37` (`attach_enrichment_image`) and `:97`
(`attach_sku_mapping`), called at `catalog.py:1826-1827`, `:2187-2188`,
`:2594`, and in compare/deals/intelligence. Each does one batch SQL + a Python
dict-join over the page. `attach_enrichment_image` is cheap (one IN-list,
indexed by `idx_pe_upc`). `attach_sku_mapping` is heavier: it carries the
multi-SKU name-disambiguation (`_name_score`, SequenceMatcher) per ambiguous UPC.

**Precompute.** Denormalise the stable, single-valued ones into cpl_enriched at
cache-build time:
- `image_url` and `enrichment_name` — direct from `product_enrichment` by
  `upc_norm` (these never depend on edition or quantity).
- `abg_sku` — only the UNAMBIGUOUS resolutions (single-SKU UPC, or Fedway's
  `dist_item_no` which is already on the row). The name-disambiguation case
  (`_name_score` tie-break) is name-dependent and per-distributor; it could be
  precomputed too but is a smaller slice — fold the deterministic part, keep the
  Python fallback for the genuinely-ambiguous remainder.

```sql
ALTER TABLE cpl_enriched ADD COLUMN image_url VARCHAR;
ALTER TABLE cpl_enriched ADD COLUMN enrichment_name VARCHAR;
UPDATE cpl_enriched SET image_url = pe.image_url, enrichment_name = pe.name
  FROM product_enrichment pe WHERE pe.upc = cpl_enriched.upc_norm;
```

**Payoff.** Removes 2-3 batch queries + 2-3 Python dict-joins from EVERY list
page. Smaller than #1 (these are already batched, not per-card) but it is on
every paginated response, and it lets the SELECT carry the columns directly so
FastAPI serialises straight from the DataFrame.

**Edition scoping.** Mostly safe (UPC-level). The ONE caveat: `abg_sku` must
stay gated by `wholesaler` (the same UPC has different item numbers per
distributor) — so abg_sku precompute must be `WHERE pe.distributor =
cpl_enriched.wholesaler`, never a bare UPC join. Image/name are distributor-
agnostic.

**Belongs in.** Cache build. Note the placeholder-barcode guard (`_joinable_upc`
/ `is_registry_upc`) must be applied so a stub UPC doesn't inherit a stranger's
image — mirror `enrichment_join._joinable_upc` in the UPDATE's WHERE.

---

## 3. RIP cluster membership + cluster-size table

**STATUS: DONE (the expensive half).** Precomputed `rip_cluster_sizes_pre`
(wholesaler, edition, rip_code -> cluster_members) in pricing_cache.py with the
BYTE-IDENTICAL body of the live CTE — that was the flagged ~7s hash-join. The
grouped grid reads it (CTE body swapped to `SELECT * FROM rip_cluster_sizes_pre`
when present, full compute as fallback). Keyed on edition (recycled-code safe).
Verified: 0 parity mismatches vs the live computation over all 13,611
(ws,ed,code) rows; local read 91ms -> 5.5ms (prod ~7s win larger). The cheaper
CTEs (mix_listing_counts, rip_groups, code_split) and the un-flattenable
single-vs-multi membership rule stay inline. NOT YET done: the full membership
table that would also absorb #7 (rip_all_codes) and #11 (compare boards'
`_case_mix_sizes` / `_cpn_for_upcs`) — those still recompute; follow-up.

**What.** `group_by_rip` (the "Group by Case Mix RIP" toggle) fans each UPC out
to one row per RIP code it belongs to, ordered by cluster size. The membership
and the cluster size are deterministic per `(edition, distributor)`.

**Where now.** `routers/catalog.py:1216-1344` builds, PER REQUEST, four CTEs
against the `rip` parquet and a self-join to `cpl_enriched`:
`mix_listing_counts`, `rip_groups`, `rip_cluster_sizes`, `rip_memberships`,
`code_split`. The comment at `:1311` flags `rip_cluster_sizes` as the "single 7s
hash-join in EXPLAIN ANALYZE for the grouped grid". The OFF path
(`:1555-1581`) rebuilds `rip_groups` + `mix_listing_counts` too, just to tag
`rip_group_code`. Compare boards recompute the same shape:
`compare.py:1519` `_case_mix_sizes`, `:238` `_cpn_for_upcs`.

**Precompute.** A cache table `rip_membership(wholesaler, edition, upc_norm,
rip_code, cluster_members, n_listings)` built once at cache-build time, plus a
`rip_group_min` / `rip_group_codes` per `(ws, ed, upc)`. The grid then LEFT JOINs
this small table instead of rebuilding the CTEs:

```sql
CREATE TABLE rip_membership AS
WITH listing_counts AS ( ... COUNT DISTINCT (name,size,vintage,unit_qty) per (ws,ed,upc) ... ),
     groups AS ( ... rip codes per (ws,ed,upc) from rip sheet ... ),
     cluster_sizes AS ( ... distinct catalog SKUs per (ws,ed,rip_code) ... )
SELECT ... ;
CREATE INDEX idx_ripmem ON rip_membership (wholesaler, edition, upc_norm);
```

The catalog grid keeps the `single-listing OR own-code-matches` membership rule
in the JOIN predicate (that rule cannot be flattened away — it depends on the
row's own `rip_code`), but reads `n_listings` and `cluster_members` from the
table instead of recomputing them.

**Payoff.** High. Removes the 7s cluster-size hash-join from every grouped grid
AND the `_case_mix_sizes` recompute from every compare board (boards are cached
in `_board_cache`, so the win there is the cold board + cache-miss). The
membership table is small (one row per UPC per code).

**Edition scoping. CRITICAL.** RIP codes are RECYCLED per edition (code 10954 =
Parrot Bay in May, Sarti Rosa in June — CLAUDE.md). The table MUST key every row
on `(wholesaler, edition, ...)` and consumers MUST filter to the row's edition.
A cluster-size keyed on `(wholesaler, rip_code)` WITHOUT edition would merge two
unrelated products' clusters across months. This is exactly the kind of leak the
project rule warns about — the precompute does not change the risk surface (the
live CTEs already partition by edition), but the table schema must carry edition
in the key, not just rip_code.

**Belongs in.** Could be either. The membership/cluster math joins `rip` to
`cpl_enriched`, both of which are in the parquet AND the cache, so it COULD be a
derive.py parquet (`rip_membership.parquet`). Leaning cache build because it is a
pure serving-layer convenience (no pricing number depends on it) and keeping it
out of derive.py avoids another parquet to ship. Either way it must reuse the
single-vs-multi-listing rule from `derive.py` / `attach_tiers` (FOUNDATION
3.4.2) verbatim, not re-derive it.

---

## 4. `best_qd` deepest-QD bracket as columns

**STATUS: deferred (deliberate).** `_attach_best_qd` is a ~40-line Python branch
(regex qty parse, `ceil`, the skip-1-case rule, pack fallback, a nested output
object). A faithful SQL mirror in derive.py carries real drift risk against
FOUNDATION-adjacent sticker math, for a loop that is already cheap pure
arithmetic (no SQL). Low value-for-risk; do only with a strict both-ways parity
harness if the card path ever shows up in profiling.

### Original analysis

**What.** The Products card sticker shows the deepest quantity-discount bracket
(cases to unlock, case price, bottle price, save/case, total cost, total save).

**Where now.** `routers/catalog.py:1876` `_attach_best_qd` — a Python loop over
every record on every page, scanning `discount_1..5_qty/amt`, picking the largest
amount, computing `ceil(qty)`, total cost/save. Pure arithmetic on columns
already on the row, recomputed per request.

**Precompute.** This is a deterministic function of the CPL discount columns +
`best_case_price` + `unit_qty` for one row — a textbook derive.py column. Emit
`best_qd_cases`, `best_qd_case_price`, `best_qd_bottle_price`,
`best_qd_save_per_case` in `build_cpl_enriched` (the deepest non-1-case bracket;
NULL when `best_case_price >= frontline`). The frontend already reads a `best_qd`
object — keep the shape by assembling it from the columns, or emit a JSON string
like `rip_windows`.

**Payoff.** Per-card, every Products page. Small per row but it is a Python loop
on the hot list path. Low effort.

**Edition scoping.** Safe — single-row arithmetic, no cross-edition or RIP-code
read.

**Belongs in.** derive.py. It reads ONLY precomputed/raw columns of the same
row; the FOUNDATION rule says fix it there and rebuild the parquet, never in a
post-fetch loop. Mirror the "skip 1-case QD" rule (`best_qd` skips `cases <= 1`)
and the `_qd_multi_case_sql` filter predicate so the sticker and the "In QD (>1
CS)" filter agree.

---

## 5. CELR family `(cpn, header)` resolution

**What.** The Products grid collapses a product's differently-named sizes into
one card via the CELR family registry.

**Where now.** `routers/catalog.py:1704-1769`. Per page: one query to
`celr_products` by `upc_norm` (IN-list), a SECOND query to `celr_family_keys` for
rows not resolved by barcode (computing `_celr_family_key` per row in Python
first), then a Python loop assigning `product_group` / `product_display` /
`celr_product_number` with `_celr_display_header`. Two SQL round-trips + Python
per page.

**Precompute.** The barcode->family resolution (`celr_products` join) is
deterministic per UPC and can be denormalised into cpl_enriched at cache build
(both tables are in the cache):

```sql
ALTER TABLE cpl_enriched ADD COLUMN cpn INTEGER;
ALTER TABLE cpl_enriched ADD COLUMN celr_header VARCHAR;
UPDATE cpl_enriched SET cpn = cp.cpn, celr_header = cp.header_name
  FROM celr_products cp WHERE cp.upc_norm = cpl_enriched.upc_norm
    AND <is_clean_upc(upc)>;
```

The name-key fallback (placeholder barcodes -> family by name key) depends on
`_celr_family_key(product_name, product_type)` which IS deterministic per row, so
it could also be precomputed (compute the key column in derive.py, join
`celr_family_keys` in the cache build). That removes the second query AND the
Python key computation.

**Payoff.** Every Products grid (the default landing view). Removes 2 queries +
the Python family loop. The display-header formatting (`_celr_display_header`,
which depends on product_type) is cheap and can stay, fed by the precomputed
header.

**Edition scoping.** Safe — family identity is UPC/name based, edition-
independent by design (a family spans editions). The placeholder-barcode guard
(`_is_clean_upc`) must gate the barcode join so a stub doesn't weld two families
(the documented "placeholder 111111111117 welds products" hazard from MEMORY).

**Belongs in.** Cache build for the barcode join (registry tables are cache-only,
rebuilt from Postgres each load so manual merges/aliases flow through). The
`celr_family_key` STRING could be a derive.py column (pure function of name +
type) so the name-key join has an indexed key.

---

## 6. `multi_distributor` / `distributor_count` precompute

**What.** Each row is tagged with how many distributors carry the same barcode
(informational "also at Allied, Fedway") vs same-distributor reuse.

**Where now.** `routers/catalog.py:468` `_attach_dup_upc`. Per page: a query with
a `latest`/`cur`/`per` CTE chain over cpl_enriched (latest edition per
wholesaler, distinct product names per (upc, wholesaler), distributor count per
upc) + a Python loop. One batch query per page but it self-scans cpl_enriched
with `LTRIM(upc,'0')` (defeats the index pre-`upc_norm`).

**Precompute.** `distributor_count` and `multi_distributor` are deterministic per
UPC given the latest-edition snapshot. Precompute a small table keyed on
`upc_norm` at cache build (after `upc_norm` exists):

```sql
CREATE TABLE upc_distributor_span AS
WITH latest AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched GROUP BY wholesaler),
     cur AS (SELECT upc_norm, wholesaler, product_name FROM cpl_enriched e
             JOIN latest l USING (wholesaler) WHERE e.edition = l.ed),
     per AS (SELECT upc_norm, wholesaler, COUNT(DISTINCT product_name) pc FROM cur GROUP BY 1,2)
SELECT upc_norm, COUNT(DISTINCT wholesaler) ndist, MAX(pc) maxpc,
       list_sort(list_distinct(list(wholesaler))) AS distrib_list
FROM per GROUP BY upc_norm;
```

Then `_attach_dup_upc` is a single indexed IN-list against this tiny table (or
denormalise `distributor_count` + `multi_distributor` straight onto cpl_enriched,
since "latest edition" is the serving snapshot).

**Payoff.** Every list page. Replaces a 3-CTE self-scan with a point lookup.

**Edition scoping.** This one is "latest edition per wholesaler" BY DESIGN (so a
renamer like Highgrade doesn't look like a duplicate) — so it is NOT edition-
scoped, it is a cross-edition latest-snapshot fact. That is fine and intended,
but it means it lives in the CACHE BUILD (depends on "what is the latest edition
loaded", which is a cache-state fact), not derive.py per-row. Rebuilt every cache
load, so it self-heals when a new edition arrives.

**Belongs in.** Cache build (it is a function of the whole loaded corpus's latest
editions, keyed on the pricing-cache file path, exactly like `price_trend`'s
safety net).

---

## 7. `rip_all_codes` list per (ws, ed, upc)

**What.** When group_by_rip is on, each row carries the full list of RIP codes
its UPC stacks under (`rip_all_codes`), so the UI can show every rebate.

**Where now.** `routers/catalog.py:1777-1806`. A separate batch query to the
`rip` parquet (DISTINCT codes per (ws, ed, upc) for the page's pairs) + a Python
group-by, done because DuckDB's `list_distinct` returns a numpy array FastAPI
can't serialise.

**Precompute.** `list_distinct(list(rip_code))` per `(wholesaler, edition,
upc_norm)` is exactly the `rip_groups.rip_group_codes` already computed in the
membership CTEs (#3). If #3 lands as a table, this is a free column on it. Emit
it as a JSON string (like `rip_windows`) so it serialises cleanly and avoids the
numpy-array workaround.

**Payoff.** Every grouped grid. Folds into #3; near-zero extra cost if #3 is done.

**Edition scoping. CRITICAL** — same recycled-code rule as #3: key on edition,
never just `(ws, upc)`.

**Belongs in.** Same place as #3 (the membership table). As a JSON-string column
it can even be a derive.py parquet column.

---

## 8. `current_edition` flag per row

**What.** Almost every grid/board/detail query computes "current edition per
wholesaler" = `MAX(edition WHERE edition <= today)` and self-joins cpl_enriched
to it, to show only the current month.

**Where now.** Everywhere: `catalog.py:786`, `:2059`, `:2911`, `:3143`,
`pricing.rank_best_deals` (`pricing.py:1766`), `compare._editions_for`
(`compare.py:126`), `_prev_prices`, etc. Each is a `GROUP BY wholesaler` MAX
subquery + JOIN. `idx_cpl_ws_ed` (already planned) helps, but it is still a
join-per-request.

**Precompute.** "current" depends on today's date, which changes daily while the
cache rebuilds monthly — BUT within a month it is stable, and the cache is
rebuilt on reload anyway. Materialise a boolean `is_current_edition` at cache
build (computed against `eastern_today()` at build time):

```sql
ALTER TABLE cpl_enriched ADD COLUMN is_current_edition BOOLEAN DEFAULT false;
UPDATE cpl_enriched SET is_current_edition = true
  WHERE edition = (SELECT MAX(edition) FROM cpl_enriched c2
                   WHERE c2.wholesaler = cpl_enriched.wholesaler
                     AND c2.edition <= '<today-yyyy-mm>');
```

Then the grid filter is `WHERE is_current_edition` — no self-join.

**Payoff.** On nearly every endpoint. Medium per-query, very broad.

**Edition scoping.** SUBTLE risk. The flag bakes in "today" at build time. If the
cache is built on May 31 and not rebuilt, on June 1 the flag still points at May
(wrong) until the next reload. The existing code computes "current" at REQUEST
time via `current_yyyy_mm()`, which is always correct. So this precompute trades
correctness-across-the-month-boundary for speed. Mitigation: a daily reload
(already implied by the nightly cron) OR keep the request-time MAX as the source
of truth and only use the flag as a fast pre-filter that a cheap edition-equality
check confirms. Given the month-boundary hazard, this is LOWER priority than its
breadth suggests — recommend it only alongside a guaranteed daily cache rebuild.
The multi-edition trend/sparkline views must NOT use the flag (they legitimately
mix editions).

**Belongs in.** Cache build (depends on build-time "today" + the loaded corpus).
Never derive.py (the parquet is date-agnostic; baking "today" into the parquet
would be wrong the moment it is read in a different month).

---

## 9. Stop re-CASTing `rip_code` / `upc` to VARCHAR at query time

**STATUS: columns emitted in derive.py (foundation); consumer repoint
deferred.** `build_cpl_enriched` now emits `vintage_norm`, `unit_qty_key`,
`rip_code_str` (byte-identical to the existing `vnorm`/`uqnorm`/CAST; 0
mismatches on the 176k rebuild, purely additive — verified the rebuild changes
no existing column beyond the build's own ~700-row multi-threaded
non-determinism, which is pre-existing). Activates at the next data load (the
monthly parquet rebuild + ingest); no special re-ingest needed. NOT repointed
yet: each consumer uses a SITE-SPECIFIC normalisation (the dedup QUALIFY
partitions on RAW `CAST(vintage AS VARCHAR)`, not the normalised `vintage_norm`;
`unit_qty_key` == the dedup's `uq_key` and IS a safe swap), and the win is
marginal (these are window/partition expressions, not index-defeating filters
like upc_norm). Repoint per-site after the column lands in prod (no fallback
branching needed then). Net value is the removed SQL/Python drift surface, not
speed.

### Original analysis

**What.** The catalog and compare queries are saturated with `CAST(rip_code AS
VARCHAR)`, `CAST(upc AS VARCHAR)`, `LTRIM(CAST(upc AS VARCHAR),'0')`,
`COALESCE(CAST(vintage AS VARCHAR),'')`, and
`regexp_replace(TRIM(CAST(unit_qty AS VARCHAR)),'\.0+$','')`. ~60 occurrences in
catalog.py alone (grep at lines 818-3328). The CAST exists because Postgres can
return these numeric while parquet returns them string (the documented
parquet-vs-Postgres type drift, MEMORY: parquet-vs-postgres-vintage-float).

**Where now.** Pervasive — `catalog.py` group_by_rip CTEs, dedup
(`QUALIFY ... PARTITION BY ... CAST(vintage AS VARCHAR)`), `compare.py` board
SQL, `pricing.attach_tiers` lookups.

**Precompute.** Materialise the canonical string forms ONCE at cache build (or in
derive.py) so query-time code reads plain columns:
- `upc_norm` — already planned (PRICING_INDEX_INVENTORY).
- `rip_code_str = CAST(rip_code AS VARCHAR)` — index-friendly, removes the
  per-row CAST in every membership/cluster query.
- `vintage_str = COALESCE(CAST(vintage AS VARCHAR),'')` and the normalised
  `vintage_norm` (the `_vintage_norm_sql` output) — used in every dedup
  partition and the next-month/3mo identity keys; recomputed in SQL AND in Python
  (`norm_vintage`) per request.
- `unit_qty_key = regexp_replace(TRIM(CAST(unit_qty AS VARCHAR)),'\.0+$','')` —
  the canonical pack key (`_uq_key`), recomputed in ~8 places.

**Payoff.** Broad but individually small. The bigger structural win is that a
plain `vintage_norm` / `unit_qty_key` column lets the DEDUP `QUALIFY` and the
identity joins use real columns (and potentially an index), instead of a
function-wrapped expression that forces a full scan — the same lever as
`upc_norm` but for the OTHER identity columns. The dedup partition
(`catalog.py:1201`) runs on every grid.

**Edition scoping.** Safe — these are pure type/format normalisations of the same
row's own columns. No cross-edition or RIP read.

**Belongs in.** derive.py for `vintage_norm` / `unit_qty_key` / `rip_code_str`
(pure per-row functions, canonical identity — and they ALREADY have Python/SQL
mirror helpers that must stay in sync, so materialising once removes a drift
surface). `upc_norm` stays in the cache build as planned (it must survive the
Postgres round-trip and the price_trend CREATE OR REPLACE). Reuse
`pricing.uq_key` / `pricing.norm_vintage` semantics exactly; do not invent a new
normalisation.

---

## 10. `attach_price_3mo` / `attach_next_tiers` per-edition tier ladders

**What.** With `include_tiers`, each card gets a 3-month sparkline
(`price_3mo`: per-edition frontline / disc1 / RIP price + a full tier ladder PER
EDITION) and a next-month tier ladder (`next_tiers`).

**Where now.** `pricing.py:1517` `attach_price_3mo` and `:1444`
`attach_next_tiers`. Both fetch the matching SKU's rows across editions, then
call `attach_tiers` on EACH edition's rows — i.e. the full RIP-sheet join + tier
construction, multiple editions deep, for every card with tiers expanded.
`attach_tiers` itself (pricing.py:455-1213) is the single most expensive Python
path: per call it issues ~5 SQL queries (rip rows, rip_credits, credit_pack
fallback join, partial-window cpl rows, full-month qtys, UPC-broad windows,
listing counts) and runs nested Python loops to stack CPL+RIP tiers.

**Precompute.** The tier LADDER for a `(wholesaler, edition, upc, pack, vintage)`
is deterministic EXCEPT for the `ref_date`-dependent `window_status` /
`days_to_expire` annotations (which depend on "today"). So precompute the
ref-date-INDEPENDENT skeleton: a cache table `sku_tiers(wholesaler, edition,
upc_norm, unit_qty, vintage_norm, tiers_json)` where `tiers_json` is the stacked
CPL+RIP ladder WITHOUT the window-status fields. At request time, `attach_tiers`
becomes "load the JSON, stamp window_status against ref_date" — a Python pass
with NO SQL. The 3mo/next ladders then read the same table by identity.

**Payoff.** Potentially large (the per-card tier path is the heaviest), but HIGH
effort and HIGH risk: `attach_tiers` encodes ~15 documented correctness rules
(half-case credits, time-sensitive windows, Remy multi-code windows, single-vs-
multi listing, partial QD reconciliation). Precomputing the ladder means moving
all of that into the build and trusting it never drifts from the live path.

**Edition scoping.** Table is per-edition by construction — but the half-case
credit + single-vs-multi-listing rules are edition-specific and recycled-code-
sensitive; the build MUST reuse `attach_tiers`' exact rules. This is the most
dangerous item to precompute wrong.

**Belongs in.** A cache table built by CALLING the canonical `attach_tiers` at
build time over every (ws, ed, upc) — NOT a re-implementation. That keeps one
source of math. Only worth doing if profiling shows the tier path dominates after
1-9 land. Defer; flagged for a follow-up.

---

## 11. `_case_mix_sizes` / `_cpn_for_upcs` per-board joins (compare)

**STATUS: cross-distributor offer GRID now precomputed as `sku_offer`** (backend/
precompute_offers.py, built last in pricing_cache.py). One row per (edition,
identity, distributor) with frontline/after-QD/RIP/net + cross-distributor
`net_rank`, built by CALLING `compare._common_rows` (no forked math). Grouped on a
cpn-aware `group_key` (cpn + size/pack/vintage) so it MERGES the same product
under different barcodes AND SPLITS a barcode two products share; falls back to the
barcode `match_key` when no cpn. RIP is stored PER DISTRIBUTOR (1,605 SKUs locally
where RIP presence differs across houses). Built in ~5s for 140k rows (DataFrame
bulk insert; row-by-row executemany was 157s). Consumed by the smart cart
(`attach_line_suggestions`) for the per-line comparison + in-place
switch-distributor. NOT YET: repointing the compare BOARDS + `_case_mix_sizes` to
read it (they still recompute live); that's the remaining half of this item.

### Original analysis

**What.** Compare boards (`best_rips`, `compare_rips`, Price 360) compute "mix to
qualify" cluster sizes (`_case_mix_sizes`) and CELR family numbers
(`_cpn_for_upcs`) per board.

**Where now.** `compare.py:1519` `_case_mix_sizes` (rip-sheet codes JOIN
cpl_enriched, COUNT per (ws, code)), `compare.py:238` `_cpn_for_upcs`. Boards are
memoised in `_board_cache` (keyed on cache tag + params), so the per-request cost
is only on cache miss — but the cold board pays it, and the cluster-size join is
the same shape as #3's `rip_cluster_sizes`.

**Precompute.** Both fold into existing precompute:
- `_case_mix_sizes` -> read from the #3 `rip_membership.cluster_members` column
  (same `(ws, ed, rip_code)` count). One shared table serves the grouped grid AND
  the compare boards.
- `_cpn_for_upcs` -> read the #5 `cpn` column denormalised onto cpl_enriched, or
  the `celr_products` index.

**Payoff.** Removes the cold-board recompute and unifies the cluster-size math
with the grid (#3). Medium.

**Edition scoping. CRITICAL** — same recycled-RIP-code rule; `_case_mix_sizes` is
already edition-scoped via `_edition_pred`, so the precomputed table must carry
edition and the board must filter to its resolved editions.

**Belongs in.** Cache build (shares the #3 table). No new math — point both
helpers at the shared membership table.

---

## Cross-cutting notes

- **Build order in `pricing_cache.py`.** New cpl_enriched columns must be added
  AFTER the `price_trend` `CREATE OR REPLACE TABLE cpl_enriched` (line 309) —
  that statement rebuilds the table and drops anything added before it. This is
  why `upc_norm` is added last (line 363). Items 1, 2, 5, 6, 8 follow the same
  rule: add after price_trend, before the index creation, or re-add post-rebuild.

- **derive.py vs cache build, the deciding question:** does the value depend ONLY
  on raw CPL/RIP/COMBO of the same row (or a window over editions of the same
  SKU)? Then derive.py (items 4, 7, 9). Does it need a JOIN to a cache-only table
  (enrichment, sku_mapping, celr_products, combo) or "today"/"latest loaded
  edition"? Then cache build (items 1, 2, 3, 5, 6, 8, 11).

- **Reuse, never re-implement.** Items that touch pricing/RIP math (3, 7, 10, 11)
  MUST reuse the canonical rules: the single-vs-multi-listing gate and code-split
  from `derive.py` / `pricing.attach_tiers` (FOUNDATION 3.4.2), `rip_utils`
  unit math, `pricing.uq_key` / `pricing.norm_vintage`. A precompute that forks
  the rule re-introduces the exact leaks the FOUNDATION documents (RIP 112112
  onto Chivas Goya, Gran Gala borrowed sparkline).

- **The recycled-RIP-code trap is the one to watch.** Every RIP-related
  precompute (3, 7, 10, 11) is correct ONLY if the materialised row carries
  `(wholesaler, edition)` in its key and consumers filter to that edition. A
  cluster/membership/tier table keyed on `rip_code` alone WILL merge May's Parrot
  Bay cluster with June's Sarti Rosa. This does not make the precompute wrong by
  nature — the live CTEs already partition by edition — it just means the table
  schema must not drop edition for "compactness".

---

## Suggested sequencing

1. **#1 (image-sort rank)** — biggest single win, lowest risk, directly the
   PERF_TODO #4 headline. Do first.
2. **#9 (materialise vintage_norm / unit_qty_key / rip_code_str in derive.py)** —
   unblocks index usage on the dedup/identity columns and removes a drift
   surface; pairs naturally with the `upc_norm` index work.
3. **#4 (best_qd) + #2 (enrichment denormalise)** — both straightforward, both on
   every Products page.
4. **#3 (RIP membership table)** — the structural win for grouped grid + compare
   boards; absorbs #7 and #11. Highest care on edition keying.
5. **#5 (CELR family) + #6 (distributor span)** — remove the remaining per-page
   query+loop pairs.
6. **#8 (current-edition flag)** — only with a guaranteed daily rebuild.
7. **#10 (precomputed tier ladders)** — defer; only if the tier path still
   dominates after the above, and only by calling the canonical `attach_tiers`
   at build time.
