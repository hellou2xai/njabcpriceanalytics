# Pricing & Catalog Foundation

This file is the contract. Every pricing, savings, RIP, tier, ranking, or
"best buy" calculation in this codebase MUST follow what is written here,
and MUST live in one of the canonical helpers listed under "Canonical
helpers — single source of truth" below. If you add a new endpoint, MCP
tool, assistant function, or frontend ranker, it imports from those
helpers. It does NOT re-implement the math.

If reality drifts from this doc (a wholesaler changes a column, the
business rule for "best buy" changes), update the doc AND the canonical
helper in the same commit. Never update the helper alone, never update
only one of the duplicates, never patch the symptom in a single endpoint.

---

## 1. The data pipeline

```
Excel files (raw distributor uploads)
  -> nj_abc_parser/etl.py            (auto-detects wholesaler + edition,
                                      parses CPL / RIP / COMBO / BEER_MM)
  -> parquet_output/{cpl,rip,combo,beer_mm}/wholesaler=X/edition=YYYY-MM/
  -> nj_abc_parser/derive.py.build_cpl_enriched()
  -> parquet_output/derived/cpl_enriched.parquet     <-- the live truth
  -> backend/pricing_cache.py builds the local DuckDB cache
  -> backend/db.py::get_duckdb() opens it read-only at request time
```

Companion derived parquets (also from `derive.py.build_all()`):

- `price_changes.parquet` — edition-over-edition deltas (vintage-aware).
- `item_lifecycle.parquet` — new / discontinued / new_discount /
  lost_discount / new_clearance events between editions.
- `cross_source_links.parquet` — cross-distributor product pairs (UPC
  match or Jaro-Winkler >= 0.88 on product name).

Postgres holds user state only (users, orders, lists, watchlist, cart,
notes, alerts, todos, ai_usage_log, ai_feedback). Postgres does NOT hold
pricing data; pricing reads always go through DuckDB.

---

## 2. Canonical column formulas

Every column below is **precomputed in `nj_abc_parser/derive.py`** and
written into `cpl_enriched.parquet`. Consumers READ these columns; they
never recompute them. If a number looks wrong, fix it in `derive.py` so
every downstream surface gets the corrected value automatically.

### 2.1 RIP per-edition best rebate

```sql
-- derive.py:325-410
best_rip_amt = GREATEST over matched RIP codes of:
  (best case-tier amt/qty)
  + (best bottle-tier amt/qty * unit_qty)        -- bottle tier -> per case
```

Matching strategy: UPC-keyed first (`rip_per_code_upc`), code-level
fallback (`rip_per_code`) for wholesalers (Fedway) that anchor a RIP to
a stub UPC like `812066000000`. Fedway also crams multiple RIP codes
into one CPL cell separated by whitespace — `cpl_codes` UNNESTs them.

### 2.2 Effective case price

```sql
-- derive.py:434-438
effective_case_price = GREATEST(
  ROUND(COALESCE(best_case_price, frontline_case_price) - COALESCE(best_rip_amt, 0), 2),
  0
)
```

`best_case_price` is the wholesaler-supplied CPL-discounted price (from
the source Excel file). `effective_case_price` is THAT minus the best
RIP rebate, floored at zero. This is the number the modal's green "Best
buy" banner reads.

### 2.3 Savings and flags

```sql
-- derive.py:439-460
rip_savings                = COALESCE(best_rip_amt, 0)
has_discount               = (discount_1_amt > 0)
has_rip                    = (best_rip_amt > 0)
has_closeout               = (closeout_permit IS NOT NULL AND closeout_permit != '')
discount_pct               = (frontline - best_case_price) / frontline * 100  -- CPL only
total_savings_per_case     = LEAST(frontline - best_case + best_rip_amt, frontline)
```

`discount_pct` is the CPL-side discount only (does NOT include RIP).
`total_savings_per_case` is the CPL discount plus the RIP rebate, capped
at the frontline price (because a buyer can never save more than the
sticker).

### 2.3.1 Partial-month (time-sensitive) exclusion rule

A discount or RIP whose validity window is NOT a full calendar month is a
TIME-SENSITIVE deal. Those are excluded from every pricing column in
`cpl_enriched`. They live only on `/api/deals/time-sensitive` (which
reads RAW `cpl` and applies its own filter).

**Window classification** — mirror of
`backend/routers/deals.py::_window_is_time_sensitive` inverted:

```
full-window =
  (from_date IS NULL OR to_date IS NULL)                          -- evergreen
  OR (
    EXTRACT('day' FROM from_date) = 1
    AND to_date = LAST_DAY(to_date)                               -- whole month(s)
  )
```

Anything else (5 Apr → 22 Apr, single-day 16 Apr → 16 Apr, etc.) is
PARTIAL-window.

**What gets excluded** (`derive.py::build_cpl_enriched`):
- `best_rip_amt` — the `rip_per_code_upc` and `rip_per_code` CTEs filter out
  RIP source rows with partial windows. A partial-window RIP code does not
  contribute to any SKU's `best_rip_amt`.
- `effective_case_price` — when the CPL row's own window is partial, the
  `best_case_price` (CPL-discounted price) is replaced with `frontline_case_price`
  in the formula. Result: the CPL discount is dropped, RIP layer is already
  filtered to full-window-only above.
- `has_discount` — false for partial-window CPL rows regardless of
  `discount_1_amt`. So a 5-Apr-only liquidation doesn't crowd the Major
  Discounts ranker.
- `discount_pct` — 0 for partial-window CPL rows.
- `total_savings_per_case` — contains only the RIP portion for partial-window
  CPL rows; their CPL discount is excluded.

**What stays unchanged**:
- The CPL row's `discount_1_qty`..`discount_5_amt`, `from_date`, `to_date`,
  `closeout_permit`, `rip_code` columns are intact. The Time-Sensitive Deals
  endpoint reads them directly.
- The RIP sheet's source rows are intact in the rip parquet; tier-ladder
  rendering still surfaces them (so a buyer sees the promo exists), just
  annotated as time-sensitive by `pricing.attach_tiers`.
- `has_rip` — true if any RIP code matched (including partial-window ones in
  the rip parquet), so the catalog's "Has RIP" filter still finds rows that
  carry a time-sensitive RIP. (Their `effective_case_price` doesn't reflect
  it, however.)

**One row per SKU — full-month line wins.** A SKU can have several CPL lines:
a full-month line plus dated promo lines (and some distributors split even
their full-month quantity-discount tiers across multiple lines). The dedup that
collapses these to one enriched row (`derive.py` `joined` CTE `ROW_NUMBER`)
partitions by `(wholesaler, edition, upc, product_name, unit_volume, vintage,
unit_qty)` — NOT by window — so the lines compete. The `ORDER BY` PREFERS the
full-month line, then deepest RIP, then a deterministic tiebreak
(`best_case_price ASC`, `from_date`, `to_date`). This guarantees
`effective_case_price` is the durable full-month price and never flips between
cache builds. The dated promo lines remain in raw `cpl` and are re-surfaced as
time-sensitive tiers by `attach_tiers`.

**Kramer one-tier-per-line CPL.** Kramer is the only distributor that lists each
quantity-discount tier on its OWN CPL line (same UPC/size/window repeated,
`discount_1` only, `discount_2..5` always blank) instead of packing them into
the `discount_1..5` columns of one line. `wholesalers/kramer.py::_consolidate_cpl_tiers`
(a `post_process` hook) folds those per-line tiers — across rows AND columns —
into the canonical one-row-per-SKU-per-window shape every other distributor
files, and recomputes `best_case_price` as `frontline − deepest discount IN THAT
window` (Kramer repeats the global best on every line, which is wrong once the
windows are separated). The 5-column cap keeps the low-quantity tiers plus the
single deepest; `best_case_price` always reflects the true deepest.

**Rebuild required**: any change to this rule requires regenerating
`cpl_enriched.parquet`:
```
python -c "from nj_abc_parser.derive import build_all; build_all()"
PRICING_SOURCE=parquet python -c "from backend.pricing_cache import build_pricing_cache; build_pricing_cache()"
```
On Render, the next monthly ETL (or a manual run + reload-pricing endpoint
hit) does this.

### 2.3.2 Date-aware "live now" RIP price (precomputed windows, query-time date)

`effective_case_price` (2.3.1) is the **stable whole-month** price. It bakes in
only full-month RIPs and is deliberately blind to partial-window RIPs, even ones
active right now. That is correct for "the price you can count on all month", but
it hides a real rebate a buyer would get today. (June 2026 sample: 123 RIPs
active on the 1st-of-month are excluded purely because they end mid-month.)

The **price** can't be precomputed (it depends on "today", which changes daily
while the cache rebuilds monthly). But the **windows** can: they're static per
edition, and only the comparison to the reference date varies. So:

- **Precomputed (derive.py).** `cpl_enriched.parquet` carries a `rip_windows`
  column: a **JSON-array STRING** (plain VARCHAR) of
  `{from_date, to_date, amt}` for every RIP window that applies to the row (full
  AND partial), `amt` already converted to per-case using pack size. Dates are
  ISO strings (lexical compare == date compare). It is a string, not a native
  `LIST<STRUCT>`, ON PURPOSE: prod stores pricing in Postgres (which has no
  list-of-struct type), and the cache is rebuilt FROM Postgres, so the column
  has to round-trip as text. Parsed back with `from_json` at query time. Built
  from a no-full-month-gate twin of `rip_per_code_upc` joined through the
  `cpl_codes` multi-code UNNEST.
- **Query-time date.** `pricing.live_rip_amt_sql(col, ref)` and
  `pricing.live_effective_sql(ref)` build the SQL that filters `rip_windows` to
  the windows containing `ref` and takes the best amt:
  `LEAST(effective_case_price, GREATEST(ROUND((effective_case_price +
  rip_savings) - best_active_amt, 2), 0))`. `pricing.attach_live_rip` is the
  **Python mirror** of the same formula (FOUNDATION 7 mirror pattern), reading
  the same `rip_windows` column — one source of windows, one formula.
- `pricing.window_status(from, to, ref_date)` classifies a single window
  (`whole_month` / `evergreen` / `active` / `upcoming` / `expired`) for the
  per-tier badges.

Because the live price is now a SQL expression, the catalog grid can **sort the
whole result set** by it: `/api/catalog/search?sort=live_effective_case_price`
(or `sort=live_savings`), computed before pagination. The DEFAULT sort is still
the stable month price; live price is opt-in (the "Live" affordance on the
Effective column). Stamped fields: `live_effective_case_price`, `live_rip_amt`,
`live_better_than_month`, `live_savings`.

Reference date defaults to today ET; `?as_of=YYYY-MM-DD` overrides it (validated
to a real date, then inlined as a quoted literal because DuckDB rejects bound
params inside the `list_filter` lambda). A cart/order line uses its needed-by
date. Full-catalog live sort over ~42k rows measured at ~10 ms.

**Rebuild required**: a change to `rip_windows` regenerates `cpl_enriched.parquet`
(same commands as 2.3.1). The monthly ETL does this automatically.

### 2.4 Next-month preview

```sql
-- derive.py:471-487  (LEAD over edition partitioned by ws, upc, name, vol, vintage_norm)
next_effective_case_price = LEAD(effective_case_price) OVER w
price_trend = CASE
  WHEN |next - cur| <= 0.005 THEN 'flat'
  WHEN next < cur            THEN 'drop'
  WHEN next > cur            THEN 'increase'
  ELSE NULL
END
```

Reads as: the SAME SKU's effective price next month. Partitioned by
vintage so a 2019 -> 2020 vintage swap isn't read as a price move.

---

## 3. Business rules (the invariants)

### 3.1 Edition selection — "current" vs "next"

- "Current edition" per wholesaler = `MAX(edition) WHERE edition <= today's YYYY-MM`.
- "Next edition" per wholesaler = the latest edition in the parquet,
  used for next-month previews.
- `backend/routers/catalog.py::_current_yyyy_mm()` returns today's YYYY-MM string.
- `backend/routers/catalog.py::_next_yyyy_mm()` returns the next month.
- `backend/ai_catalog_query.py::_current_ym()` is the assistant's mirror.
  Keep them in sync.

So if the May 2026 file is loaded plus the June 2026 preview, May is
"current" until June 1st. The product modal shows current and next
month side by side; the catalog grid defaults to current only.

### 3.2 Vintage normalisation

```python
# derive.py:62-69, mirrored in catalog.py:51 (_vintage_norm_sql) and catalog.py:114 (_norm_vintage)
None / "" / "NA" / "N/A" / "NONE" / "NV"   -> NULL  (no vintage)
"2019"                                       -> "2019"
"2019.0"                                     -> "2019"
"19"  (2-digit, <= 30)                       -> "2019"
"31"  (2-digit, > 30)                        -> "1931"
anything else                                -> NULL
```

Applied ONLY to WINE / SPARKLING / VERMOUTH categories. Same UPC across
vintages is treated as different SKUs for price-history and
next-month comparisons. NV ("non-vintage") is treated as no vintage.

### 3.3 Pack size (`unit_qty`)

Bottles per case. Same SKU sometimes comes through as `"12"` and
sometimes `"12.0"` from Excel float coercion. The canonical key is:

```sql
-- catalog.py:89 _uq_key
regexp_replace(TRIM(CAST(unit_qty AS VARCHAR)), '\.0+$', '')
```

Pack size is REQUIRED to convert bottle-unit RIPs to per-case savings.
A 6-bottle pack with a $5/bottle RIP saves $30/case, NOT $5/case.

### 3.4 RIP unit math

`backend/rip_utils.py` is the single home for unit conversion. Two
canonical formulas:

```python
rip_per_case(amount, qty, unit, pack):
    case-unit tier   -> amount / qty
    bottle-unit tier -> (amount / qty) * pack

rip_per_bottle(amount, qty, unit, pack):
    case-unit tier   -> (amount / qty) / pack
    bottle-unit tier -> amount / qty
```

`is_bottle_unit(unit)` is True when the unit string starts with `'b'`
(case-insensitive, after whitespace trim). Anything else (including
NULL and empty) is treated as cases — that matches how Fedway,
high_grade and peerless encode their files.

### 3.5 CPL + RIP tier stacking

The truth lives in `backend/pricing.py::attach_tiers()` (extracted from
`backend/routers/catalog.py:396 _attach_discount_rip_tiers`). Two
sub-rules:

1. **CPL discount tiers are mutually exclusive.** Only the highest-amount
   tier the buyer qualifies for at their case quantity applies.
   Qualification:
   - case-unit tier qualifies when `cases_bought >= tier.qty`
   - bottle-unit tier qualifies when `cases_bought * pack >= tier.qty`
2. **RIP tiers STACK on top of the CPL tier the buyer also clears at
   that qty.** A bottle-unit RIP of 60 bottles at pack 12 = 5 cases;
   the buyer clears the 5-case CPL tier automatically AND gets the RIP,
   so `combined_save = rip_per_case + best_disc_at(5_cases)`.

### 3.6 "Best buy" semantics

The product modal's green "Best buy" banner is **frontend-only logic in
`frontend/src/components/PriceBreakdown.tsx:139-149`**. It picks the
month/distributor row with the lowest `effective_case_price`. There is
NO backend selection.

**There is no canonical "best deals across catalog" ranker today.** The
assistant's `_t_best_gp_deals` invented one (rank by `gp_pct DESC`) which
surfaces 100%-off stocking deals at #1 (Beronia Rose case). The new
canonical ranker is `backend/pricing.py::rank_best_deals()` — see
section 4.4 below.

---

## 4. Canonical helpers — single source of truth

All pricing/tier/RIP/ranking math MUST come from these helpers. If you
add a new helper, add it here. If you find duplicated math anywhere
else, treat it as a bug and route the caller back to one of these.

### 4.1 RIP unit math — `backend/rip_utils.py`

| Helper | Purpose |
|---|---|
| `normalize_unit(s)` | `'case'` / `'bottle'` / `None`. |
| `is_bottle_unit(s)` | True iff `normalize_unit(s) == 'bottle'`. |
| `rip_per_case(amount, qty, unit, pack)` | Per-case rebate, bottle-aware. |
| `rip_per_bottle(amount, qty, unit, pack)` | Per-bottle rebate, mirror. |
| `rip_bundle_cost(qty, unit, case_price, btl_price)` | Cost of one RIP bundle. For ROI. |

### 4.2 Pricing module — `backend/pricing.py`

Extracted from `backend/routers/catalog.py` so the assistant, the MCP
server, the catalog router, the deals router and any future caller all
read from the same code.

| Helper | Was previously | Purpose |
|---|---|---|
| `attach_tiers(con, records, ref_date=None)` | `catalog.py:396 _attach_discount_rip_tiers` | Build the per-product tier ladder (CPL discounts + stacked RIP rebates) the modal shows. Mutates `records[i]["tiers"]` in place. Every tier carries `from_date`, `to_date`, `window_status`, `days_to_expire` classified against `ref_date` (default today ET). |
| `window_status(from_date, to_date, ref_date=None)` | NEW | Classify a validity window vs a reference date: `whole_month` / `evergreen` / `active` / `upcoming` / `expired`, plus `days_to_expire` and `starts_in`. The single rule for "is this RIP/discount live on date X". |
| `attach_live_rip(con, records, ref_date=None)` | NEW | Date-aware "live now" RIP overlay (Python). Stamps `live_rip_amt`, `live_effective_case_price`, `live_better_than_month` from each record's precomputed `rip_windows` column, filtered to windows active on `ref_date`. Python mirror of `live_effective_sql`. See 2.3.2. |
| `live_rip_amt_sql(col, ref)` / `live_effective_sql(ref, ...)` | NEW | SQL snippets for the live rebate / live price from the `rip_windows` list column. Used by the catalog search so the grid can SORT by `live_effective_case_price` / `live_savings`. Mirror of `attach_live_rip`. |
| `best_disc_at(disc_tiers, cases, pack)` | `catalog.py:545` closure | Highest qualifying CPL discount amount at `cases` cases for pack size `pack`. |
| `lookup_rips_for_records(con, records)` | `catalog.py:472 _lookup_rips` | Fetch the RIP-sheet rows that apply to a set of CPL records, with code+UPC and code-level fallback. |
| `attach_next_month_prices(con, records)` | `catalog.py:313 _attach_next_month_prices` | Add `next_case_price` and `better_month` to each record. |
| `attach_next_tiers(con, records)` | `catalog.py:602 _attach_next_tiers` | Same as `attach_tiers` but for next edition's matching UPCs. |
| `rank_best_deals(con, kind, *, min_effective_pct_of_frontline=None, category=None, distributor=None, limit=25)` | NEW | See 4.4. |

`backend/routers/catalog.py` re-exports `_attach_discount_rip_tiers =
pricing.attach_tiers` (and similar) so existing call sites keep working.

### 4.3 Product detail — `backend/routers/catalog.py::get_product_detail()`

This stays in `catalog.py` because it's the HTTP handler. But its tier
construction MUST go through `pricing.attach_tiers()`. The duplicated
tier-stacking code at `catalog.py:1754-1768` and `:3115-3137` is
removed. Both call sites now call `pricing.attach_tiers([record])` and
read `record["tiers"]`.

### 4.4 Best-deals ranker — `pricing.rank_best_deals()`

```python
def rank_best_deals(
    con,
    kind: str,                                  # 'gp_pct' | 'savings' | 'closeout' | 'time_sensitive'
    *,
    min_effective_pct_of_frontline: float | None = None,
    category: str | None = None,
    distributor: str | None = None,
    limit: int = 25,
) -> list[dict]:
    """Return the top-N best-deal rows for one consistent ranking definition.

    `kind` selects the WHERE + ORDER BY:
        gp_pct          -> has_discount AND effective < frontline,
                            ORDER BY (frontline - effective) / frontline DESC
        savings         -> has_discount AND total_savings_per_case > 0,
                            ORDER BY total_savings_per_case DESC
        closeout        -> has_closeout = true,
                            ORDER BY total_savings_per_case DESC
        time_sensitive  -> dated promo NOT spanning the whole month,
                            ORDER BY to_date ASC, total_savings_per_case DESC

    `min_effective_pct_of_frontline`:
        If set (e.g. 0.10), the WHERE clause also enforces
        `effective_case_price >= frontline_case_price * x`.
        This is the stocking-deal floor: a 100%-off liquidation row
        (Beronia Rose at $0/cs) gets filtered out so the ranker
        doesn't crown it the "best deal". Default None = no floor;
        the assistant's tool wrappers pass 0.10 by default.
    """
```

The assistant's three currently-divergent handlers (`_t_best_gp_deals`,
`_t_find_deals`, `_t_closeouts`) call this. They expose an optional
`include_stocking_deals: bool = False` argument; setting it True
removes the floor.

---

## 5. Endpoint map (who calls what)

Read this when adding or changing an endpoint. It tells you which
helper your endpoint MUST call.

### 5.1 Catalog router (`backend/routers/catalog.py`)

| Endpoint | Helpers it MUST call | Consumed by |
|---|---|---|
| `/api/catalog/search` | `pricing.attach_tiers` (if `include_tiers`), `pricing.attach_next_month_prices`, `pricing.attach_next_tiers` | Catalog page |
| `/api/catalog/new-items` | same | New Items page |
| `/api/catalog/product/{w}/{n}` | `pricing.attach_tiers` on a single-row list | Product modal |
| `/api/catalog/product-breakdown/{w}/{n}` | `pricing.attach_tiers` per edition row | Price Breakdown chart in modal |
| `/api/catalog/price-history/{w}/{n}` | `_classify_trend` (catalog-local) | Price history sub-card |
| `/api/catalog/price-comparison` | reads precomputed columns only | Dashboard tile |
| `/api/catalog/cross-distributor[-combined]` | reads precomputed columns only | Cross-distributor pages |
| `/api/catalog/distributor-exclusive` | reads precomputed columns only | Distributor-exclusive page |
| `/api/catalog/rip-siblings/{w}/{code}` | `pricing.attach_tiers` | Cluster expansion in modal |
| `/api/catalog/facets`, `/categories`, `/editions` | reads precomputed columns only | Filter panel |

### 5.2 Deals router (`backend/routers/deals.py`)

| Endpoint | Helpers it MUST call | Consumed by |
|---|---|---|
| `/api/deals/time-sensitive` | `_window_is_time_sensitive`, `rip_utils.rip_per_case`, `attach_promotion_tiers`, `attach_vintages_available` | Time-Sensitive Deals page |
| `/api/deals/discounts` | `pricing.rank_best_deals(kind='savings', min_discount_pct=...)` (via thin wrapper), `attach_promotion_tiers`, `attach_vintages_available` | Major Discounts page |
| `/api/deals/combos` | `_window_is_time_sensitive` | Combos page |
| `/api/deals/rip-products` | `_build_rip_items` + `pricing.attach_tiers` for tier panels | RIP Products page |
| `/api/deals/combo-index` | reads precomputed columns only | Combo-flag overlay on catalog rows |

`attach_promotion_tiers` itself ends up calling `pricing.attach_tiers`
internally — it's a batched wrapper for the deals page shape.

### 5.3 Analytics + intelligence

| Endpoint | Helpers it MUST call |
|---|---|
| `/api/analytics/price-movers` | reads `price_changes` parquet; transitions use precomputed `effective_*` columns; recomputed deltas in Python are documented in `analytics.py:292-308`. |
| `/api/analytics/dashboard` | reads precomputed columns only |
| `/api/analytics/lifecycle` | reads `item_lifecycle` parquet |
| `/api/intelligence/buy-signals` | reads precomputed columns + `direction` from `price_changes`; the 6 labels (LAST_CHANCE / STRONG_BUY / BUY_NOW / GOOD_BUY / DEFER / HOLD) are the closest thing to a canonical "best deal" definition and their thresholds live in `intelligence.py:75-86`. |

### 5.4 Assistant tool handlers (`backend/assistant.py`)

Every `_t_*` handler that returns prices MUST read precomputed columns
from `cpl_enriched`. Every handler that returns tier ladders MUST call
`pricing.attach_tiers()`. Every handler that ranks must call
`pricing.rank_best_deals()`. Handlers may layer their own filters
(category, distributor, brand) on top of those calls.

| Handler | Today | After refactor |
|---|---|---|
| `_t_price_details`, `_t_deal_360` | already call `get_product_detail` | unchanged |
| `_t_best_gp_deals` | inline SQL, ranks by `gp_pct DESC`, no floor | calls `rank_best_deals(kind='gp_pct', min_effective_pct_of_frontline=0.10)` |
| `_t_find_deals` (kind='discount') | inline SQL, no floor | calls `rank_best_deals(kind='savings', min_effective_pct_of_frontline=0.10)` |
| `_t_find_deals` (kind='clearance') | inline SQL | calls `rank_best_deals(kind='closeout', min_effective_pct_of_frontline=0.10)` |
| `_t_find_deals` (kind='time_sensitive') | inline SQL by `to_date ASC` | calls `rank_best_deals(kind='time_sensitive')` (floor not applicable) |
| `_t_closeouts` | inline SQL | calls `rank_best_deals(kind='closeout', min_effective_pct_of_frontline=0.10)` |
| `_t_compare_distributors`, `_t_distributor_arbitrage`, `_t_size_value`, `_t_rip_lookup`, `_t_best_one_case_rip`, `_t_rip_tier_gap` | inline SQL but reuse `effective_case_price` (canonical column) | unchanged for now; flagged for review |
| `_t_category_breakdown`, `_t_distributor_breakdown`, `_t_deal_counts`, `_t_top_products`, `_t_price_movers`, `_t_get_cart`, `_t_get_favorites` | inline aggregates over canonical columns | unchanged |

### 5.5 MCP server (`backend/mcp_server.py`)

Already a thin wrapper: every `@mcp.tool()` delegates 1:1 to
`_eng._t_*`. So fixes in (5.4) propagate to MCP automatically. **Do
not add math to `mcp_server.py`.** If a new MCP tool is needed, write
the canonical helper in `pricing.py`, expose it via a thin `_t_*` in
`assistant.py`, then add the `@mcp.tool()` wrapper.

---

## 6. Rules for future contributors (and future me)

1. **Pricing math lives in `backend/pricing.py` and `backend/rip_utils.py`.**
   Not in routers, not in `assistant.py`, not in `mcp_server.py`, not
   in `derive.py` consumers, not in the frontend. The two exceptions are
   the canonical column formulas inside `derive.py` (because they're
   precomputed into the parquet) and the modal's "best buy" picker in
   `PriceBreakdown.tsx` — and we plan to move that picker to the
   backend in a future refactor.

2. **Never recompute a precomputed column.** Read
   `effective_case_price`, `discount_pct`, `rip_savings`,
   `total_savings_per_case`, `next_effective_case_price`, `price_trend`
   directly from `cpl_enriched`. If those numbers are wrong, fix
   `derive.py` and rebuild the parquet.

3. **Never recompute a tier ladder.** Call `pricing.attach_tiers()`.

4. **Never invent a "best deal" ranker.** Call
   `pricing.rank_best_deals()`. If you need a new `kind`, ADD it to the
   ranker, don't fork it.

5. **Stocking-deal floor.** Any "best deal" ranker exposed to the
   assistant MUST default to `min_effective_pct_of_frontline=0.10`.
   Without it, free-with-purchase RIPs and 100%-off liquidations
   dominate. The user can override by asking for stocking deals
   explicitly (the assistant then passes `include_stocking_deals=True`).

6. **MCP changes flow through the engine, not the server.** If you
   change pricing logic, change `pricing.py`. MCP, the assistant, the
   catalog router and the frontend will all pick it up.

7. **Update this doc when the math changes.** A pull request that
   changes a formula without touching this file is wrong.

---

## 7. Known acceptable duplications (and why)

- `_current_yyyy_mm` exists in BOTH `catalog.py:21` and
  `ai_catalog_query.py:_current_ym`. They are intentionally separate so
  the assistant can be unit-tested without HTTP imports. Keep them in
  sync; they MUST return the same value.
- `_vintage_norm_sql` (SQL) and `_norm_vintage` (Python) exist as
  mirrors. Both implement the same rules from section 3.2; the SQL
  version is used in DuckDB queries, the Python version is used after
  the fetch. Changes go in lockstep.
- The frontend's `effective_case_price = case_price / unit_qty`
  per-bottle helper appears in `PriceBreakdown.tsx` because it's a
  trivial division and round-trip to the backend would add latency.
  Acceptable; flagged as "watch for drift" if pack-size logic ever
  becomes non-trivial.

Anything else that looks like duplication is a bug. Open an issue or
collapse it.
