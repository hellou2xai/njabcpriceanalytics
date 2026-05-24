# Golden API snapshots (migration safety net)

These snapshots are the regression oracle for the Render / Postgres migration.
The plan keeps DuckDB as the query engine, so every API response must stay
identical after the data layer moves. We prove that by capturing responses now
and diffing them after each migration phase.

## How to use

Capture a labelled snapshot against a running backend:

```
python scripts/snapshot_api.py --label baseline      # current SQLite + DuckDB/Parquet build
python scripts/snapshot_api.py --label postgres       # after a migration phase
```

Diff two snapshot sets:

```
python scripts/compare_snapshots.py baseline postgres
```

Exit code 0 means no hard differences (advisory diffs ignored). Exit code 2
means a regression to investigate before continuing.

## What it captures

1. Read-only pricing/analytics endpoints, called anonymously so output is
   deterministic and user-independent. Limits are set to each endpoint's max so
   the full result set is captured where the cap allows.
2. A scripted auth + user-data flow: a fresh unique user each run signs up,
   creates a division, sales rep, order (with a line and a combo), a note and a
   watchlist entry, then reads everything back. ids, timestamps, tokens and
   email are normalised out so the read-backs diff cleanly across engines.

## Comparison rules

- Floats are rounded to 4 dp.
- Lists are compared order-insensitively via recursive canonicalisation: the
  same query can return rows in a different order among equal sort keys (DuckDB
  parallelism), and that order is not a guaranteed feature. Missing, extra or
  changed rows are still caught. Pure reordering cannot regress under Option 1
  (same engine, same query text).
- Per-endpoint stripped fields (`IGNORE_KEYS` in compare_snapshots.py):
  `deals/combos` drops `product_name`, `comments`, `upc`. These are a
  representative pick over the combo's components, whose order is not fixed, so
  they flip run to run. The economics (combo_code, combo_pack_price,
  total_savings, item_count, validity dates, availability, recommendation,
  components) remain strict invariants.

## Advisory endpoints (mismatch = warning, not failure)

These are inherently non-deterministic and cannot be strict invariants:

- `qa/scan`, `qa/summary`, `catalog/qa/anomalies`: diagnostics that fold
  ambiguous groups into order-varying strings, or carry a generated timestamp.
- `deals/rips`: returns a 1000-row cap of a much larger (~10k) tie-ordered set,
  so the subset varies run to run. RIP math is still verified deterministically
  by `deals/rip-products`, the product-detail `rip_tiers`, and the order
  `best_rip_save`.
- `intelligence/buy-sheet`: classifies products into sections at metric
  thresholds; a product sitting exactly on a boundary can land in one section
  vs another by tie order. Section sizes/sets are otherwise stable.
- `intelligence/missed-opportunities`: top-N by savings with ties at the cutoff,
  so the truncated subset is not a strict invariant.

## Determinism note

The pricing cache reads run single-threaded (`SET threads TO 1` in
`get_duckdb`). Native-table scans are parallelised by default, which made
queries lacking a total ORDER BY (ties) return a varying row order run to run.
Single-threaded reads are deterministic and the dataset is small, so the speed
cost is negligible. This actually made the app more stable than the original
(Parquet-scan) build, which flickered on a few endpoints.

## Fixed before the baseline was frozen

`GET /api/analytics/lifecycle` used to return HTTP 500: it emitted NaN floats
(e.g. `curr_discount`) and FastAPI's JSON encoder rejected them
(`ValueError: Out of range float values are not JSON compliant: nan`). Fixed in
`analytics.py` via a small `_records()` helper that coerces non-finite floats to
None. The baseline now captures it as 200 with null discounts.
