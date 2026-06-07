"""
Derived Parquet generation — pre-computed analytical views.

Reads from parquet_output/ (raw ETL output) and writes to parquet_output/derived/.
These power the dashboard, analytics, buy signals, and cross-source comparisons.

Run after ETL: python -c "from nj_abc_parser.derive import build_all; build_all()"
Or via run_etl.py --derive
"""

import logging
from pathlib import Path

import duckdb
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

logger = logging.getLogger("nj_abc_parser")


def _get_conn(parquet_dir: str | Path) -> duckdb.DuckDBPyConnection:
    """Create a DuckDB connection with the parquet directory context."""
    con = duckdb.connect()
    con.execute(f"SET variable parquet_dir = '{Path(parquet_dir).as_posix()}'")
    return con


def _write(df: pd.DataFrame, output_dir: Path, name: str):
    """Write a derived DataFrame to Parquet."""
    out_path = output_dir / f"{name}.parquet"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    for col in df.columns:
        if pd.api.types.is_datetime64_any_dtype(df[col]):
            df[col] = df[col].dt.date

    table = pa.Table.from_pandas(df, preserve_index=False)
    pq.write_table(table, out_path)
    logger.info(f"Derived: {name} → {len(df)} rows → {out_path}")


def build_price_changes(parquet_dir: str | Path, output_dir: Path):
    """
    Gap 1: Edition-over-edition price deltas.

    For each product, computes:
      - previous edition's frontline/best prices
      - absolute and percentage change
      - direction: 'up', 'down', 'stable'
    """
    con = _get_conn(parquet_dir)
    pdir = Path(parquet_dir).as_posix()

    # Vintage is part of a wine's identity — a 2019 selling out while a 2020
    # arrives is NOT a price change. Partition by a normalized vintage (for
    # vintage-sensitive categories only) so we never compare across vintages.
    # NOTE: this is a plain string spliced into an f-string below, so braces are
    # single ({4}). Double braces here would survive into the SQL literally and
    # the regex would never match a year → vkey NULL → cross-vintage comparison.
    vnorm = (
        "CASE "
        "WHEN vintage IS NULL OR vintage = '' THEN NULL "
        "WHEN UPPER(vintage) IN ('NA','N/A','NONE','NV') THEN NULL "
        "WHEN regexp_matches(vintage, '^[0-9]{4}$') THEN vintage "
        "WHEN regexp_matches(vintage, '^[0-9]{4}\\.0+$') THEN substr(vintage, 1, 4) "
        "WHEN regexp_matches(vintage, '^[0-9]{2}$') THEN "
        "CASE WHEN CAST(vintage AS INTEGER) <= 30 THEN '20' || vintage ELSE '19' || vintage END "
        "ELSE NULL END"
    )
    # Prefer the enriched parquet (has effective_case_price) so we can compute
    # the effective-price delta alongside the frontline one. Fall back to the
    # raw cpl partitions when cpl_enriched.parquet isn't built yet — in that
    # case the effective_* output columns will be NULL and consumers degrade
    # to frontline-only direction.
    enriched_path = (Path(parquet_dir) / "derived" / "cpl_enriched.parquet").as_posix()
    if Path(enriched_path).exists():
        base_select = f"FROM read_parquet('{enriched_path}')"
    else:
        base_select = (
            f"FROM read_parquet('{pdir}/cpl/**/data.parquet', "
            f"hive_partitioning=true, union_by_name=true)"
        )
        # When falling back to raw CPL, synthesize the column so the LAG below
        # still binds. The rest of the pipeline handles NULL effective gracefully.
        base_select = base_select  # keep as-is; effective injected via SELECT below

    has_enriched = Path(enriched_path).exists()
    eff_expr = "effective_case_price" if has_enriched else "CAST(NULL AS DOUBLE) AS effective_case_price"

    # Normalised unit_qty key. The monthly Excel files round-trip
    # `unit_qty` as an integer in some editions ("12") and a float in
    # others ("12.0") — same SKU, different string. Without this
    # collapse the LAG partition splits a 12-pack May listing into its
    # own partition and a 12-pack April → June chain shows up as a
    # spurious price move (April $96 -> June $181 attributed to the
    # June row because May was hidden in the "12.0" partition; root
    # cause for FEDERALIST CAB SAUV LODI UPC 86891083186). Trim a
    # trailing ".0" (and any longer ".0+") so "12" / 12 / 12.0 / "12.0"
    # all collapse to "12".
    uq_key = (
        "regexp_replace(TRIM(CAST(unit_qty AS VARCHAR)), '\\.0+$', '')"
    )

    df = con.execute(f"""
        WITH withv AS (
            SELECT *
                {("" if has_enriched else f", {eff_expr}")},
                CASE WHEN UPPER(product_type) IN ('WINE','SPARKLING','VERMOUTH')
                     THEN {vnorm} ELSE NULL END AS vkey,
                {uq_key} AS uq_key
            {base_select}
        ),
        base AS (
            -- Collapse duplicate rows within a SKU+vintage+edition so LAG
            -- compares one clean value per edition.
            SELECT * FROM withv
            QUALIFY ROW_NUMBER() OVER (
                PARTITION BY wholesaler, product_name, unit_volume, uq_key, vkey, edition
                ORDER BY frontline_case_price
            ) = 1
        ),
        ranked AS (
            SELECT *,
                LAG(frontline_case_price) OVER (
                    PARTITION BY wholesaler, product_name, unit_volume, uq_key, vkey
                    ORDER BY edition
                ) AS prev_case_price,
                LAG(best_case_price) OVER (
                    PARTITION BY wholesaler, product_name, unit_volume, uq_key, vkey
                    ORDER BY edition
                ) AS prev_best_price,
                LAG(effective_case_price) OVER (
                    PARTITION BY wholesaler, product_name, unit_volume, uq_key, vkey
                    ORDER BY edition
                ) AS prev_effective_case_price,
                LAG(frontline_unit_price) OVER (
                    PARTITION BY wholesaler, product_name, unit_volume, uq_key, vkey
                    ORDER BY edition
                ) AS prev_unit_price,
                LAG(edition) OVER (
                    PARTITION BY wholesaler, product_name, unit_volume, uq_key, vkey
                    ORDER BY edition
                ) AS prev_edition,
                LAG(discount_1_amt) OVER (
                    PARTITION BY wholesaler, product_name, unit_volume, uq_key, vkey
                    ORDER BY edition
                ) AS prev_discount_1_amt
            FROM base
        )
        SELECT
            wholesaler,
            edition,
            prev_edition,
            upc,
            product_name,
            product_type,
            vintage,
            vkey AS vintage_norm,
            unit_qty,
            unit_volume,
            frontline_case_price AS case_price,
            prev_case_price,
            ROUND(frontline_case_price - prev_case_price, 2) AS case_delta,
            ROUND(
                CASE WHEN prev_case_price > 0
                THEN ((frontline_case_price - prev_case_price) / prev_case_price) * 100
                ELSE NULL END, 2
            ) AS case_delta_pct,
            best_case_price,
            prev_best_price,
            ROUND(best_case_price - prev_best_price, 2) AS best_delta,
            ROUND(
                CASE WHEN prev_best_price > 0
                THEN ((best_case_price - prev_best_price) / prev_best_price) * 100
                ELSE NULL END, 2
            ) AS best_delta_pct,
            -- Effective = list - all discounts - best RIP rebate. The user
            -- treats this as "the" price (see memory: effective-price-definition)
            -- so price-movers detection on the frontend prefers this delta
            -- over the frontline one. We still keep frontline above so the UI
            -- can show both sides of a list-vs-effective story (e.g. a list
            -- hike that's masked by a new RIP).
            effective_case_price,
            prev_effective_case_price,
            ROUND(effective_case_price - prev_effective_case_price, 2) AS effective_delta,
            ROUND(
                CASE WHEN prev_effective_case_price > 0
                THEN ((effective_case_price - prev_effective_case_price) / prev_effective_case_price) * 100
                ELSE NULL END, 2
            ) AS effective_delta_pct,
            frontline_unit_price AS unit_price,
            prev_unit_price,
            discount_1_amt,
            prev_discount_1_amt,
            CASE
                WHEN prev_case_price IS NULL THEN 'new'
                WHEN frontline_case_price > prev_case_price THEN 'up'
                WHEN frontline_case_price < prev_case_price THEN 'down'
                ELSE 'stable'
            END AS direction,
            CASE
                WHEN prev_effective_case_price IS NULL THEN 'new'
                WHEN effective_case_price > prev_effective_case_price THEN 'up'
                WHEN effective_case_price < prev_effective_case_price THEN 'down'
                ELSE 'stable'
            END AS effective_direction
        FROM ranked
        WHERE prev_edition IS NOT NULL
        ORDER BY wholesaler, edition, ABS(case_delta_pct) DESC NULLS LAST
    """).fetchdf()

    _write(df, output_dir, "price_changes")
    con.close()
    return df


def build_item_lifecycle(parquet_dir: str | Path, output_dir: Path):
    """
    Gap 6 & 7: New items, discontinued items, new/lost discounts.

    Detects:
      - Items appearing for the first time in an edition (new)
      - Items present in previous edition but missing in current (discontinued)
      - Discounts appearing/disappearing between editions
    """
    con = _get_conn(parquet_dir)
    pdir = Path(parquet_dir).as_posix()

    # New and discontinued items
    df = con.execute(f"""
        WITH editions AS (
            SELECT DISTINCT edition FROM read_parquet('{pdir}/cpl/**/data.parquet', hive_partitioning=true, union_by_name=true)
            ORDER BY edition
        ),
        edition_pairs AS (
            SELECT edition AS curr_edition,
                   LAG(edition) OVER (ORDER BY edition) AS prev_edition
            FROM editions
        ),
        curr AS (
            SELECT wholesaler, edition, product_name, upc, product_type,
                   unit_qty, unit_volume, frontline_case_price, best_case_price,
                   discount_1_amt, closeout_permit
            FROM read_parquet('{pdir}/cpl/**/data.parquet', hive_partitioning=true, union_by_name=true)
        )
        SELECT
            COALESCE(c.wholesaler, p.wholesaler) AS wholesaler,
            ep.curr_edition AS edition,
            ep.prev_edition,
            COALESCE(c.product_name, p.product_name) AS product_name,
            COALESCE(c.upc, p.upc) AS upc,
            COALESCE(c.product_type, p.product_type) AS product_type,
            COALESCE(c.unit_qty, p.unit_qty) AS unit_qty,
            COALESCE(c.unit_volume, p.unit_volume) AS unit_volume,
            c.frontline_case_price AS curr_price,
            p.frontline_case_price AS prev_price,
            c.discount_1_amt AS curr_discount,
            p.discount_1_amt AS prev_discount,
            c.closeout_permit AS curr_closeout,
            p.closeout_permit AS prev_closeout,
            CASE
                WHEN p.product_name IS NULL THEN 'new_item'
                WHEN c.product_name IS NULL THEN 'discontinued'
                WHEN c.discount_1_amt IS NOT NULL AND c.discount_1_amt > 0
                     AND (p.discount_1_amt IS NULL OR p.discount_1_amt = 0) THEN 'new_discount'
                WHEN (c.discount_1_amt IS NULL OR c.discount_1_amt = 0)
                     AND p.discount_1_amt IS NOT NULL AND p.discount_1_amt > 0 THEN 'lost_discount'
                WHEN c.closeout_permit IS NOT NULL AND c.closeout_permit != ''
                     AND (p.closeout_permit IS NULL OR p.closeout_permit = '') THEN 'new_clearance'
                ELSE NULL
            END AS event_type
        FROM edition_pairs ep
        LEFT JOIN curr c ON c.edition = ep.curr_edition
        FULL OUTER JOIN curr p ON p.edition = ep.prev_edition
            AND p.wholesaler = c.wholesaler
            AND p.product_name = c.product_name
            AND p.unit_volume = c.unit_volume
        WHERE ep.prev_edition IS NOT NULL
          AND (p.product_name IS NULL OR c.product_name IS NULL
               OR (c.discount_1_amt IS NOT NULL AND c.discount_1_amt > 0
                   AND (p.discount_1_amt IS NULL OR p.discount_1_amt = 0))
               OR ((c.discount_1_amt IS NULL OR c.discount_1_amt = 0)
                   AND p.discount_1_amt IS NOT NULL AND p.discount_1_amt > 0)
               OR (c.closeout_permit IS NOT NULL AND c.closeout_permit != ''
                   AND (p.closeout_permit IS NULL OR p.closeout_permit = '')))
        ORDER BY wholesaler, edition, event_type
    """).fetchdf()

    _write(df, output_dir, "item_lifecycle")
    con.close()
    return df


def build_cpl_enriched(parquet_dir: str | Path, output_dir: Path):
    """
    Gaps 3, 4, 5: Enriched CPL with brand extraction, RIP join, effective price.

    Adds:
      - brand (extracted from product_name heuristic)
      - rip_savings (best RIP discount for this item)
      - effective_case_price (best_case_price - rip_savings)
      - has_discount, has_rip, has_closeout flags
    """
    con = _get_conn(parquet_dir)
    pdir = Path(parquet_dir).as_posix()

    # Same vintage normaliser used in build_price_changes and the runtime
    # search. Wines reuse one UPC across vintages, so the "next edition"
    # match must compare like-for-like vintage; otherwise a 2019 row in May
    # would chain into a 2020 row in June and look like a price change
    # that's actually a vintage swap.
    vnorm = (
        "CASE "
        "WHEN vintage IS NULL OR vintage = '' THEN NULL "
        "WHEN UPPER(vintage) IN ('NA','N/A','NONE','NV') THEN NULL "
        "WHEN regexp_matches(vintage, '^[0-9]{4}$') THEN vintage "
        "WHEN regexp_matches(vintage, '^[0-9]{4}\\.0+$') THEN substr(vintage, 1, 4) "
        "WHEN regexp_matches(vintage, '^[0-9]{2}$') THEN "
        "CASE WHEN CAST(vintage AS INTEGER) <= 30 THEN '20' || vintage ELSE '19' || vintage END "
        "ELSE NULL END"
    )

    # Full-window predicate: a discount/RIP row is "full-window" when it has
    # no dates (evergreen) OR when its from_date is the 1st of a month AND
    # to_date is the last day of a month. Anything else (e.g. 5 Apr - 22 Apr)
    # is a TIME-SENSITIVE / partial-month deal and is EXCLUDED from
    # effective_case_price + total_savings_per_case + has_discount per the
    # foundation rule. Partial-month deals still appear on the Time-Sensitive
    # Deals page (which reads raw cpl) and as annotated tiers on the modal.
    # Mirrors backend.routers.deals._window_is_time_sensitive inverted.
    full_window = lambda f, t: (  # noqa: E731 - helper, used in f-string SQL
        f"({f} IS NULL OR {t} IS NULL OR ("
        f"EXTRACT('day' FROM {f}) = 1 AND {t} = LAST_DAY({t})"
        f"))"
    )

    df = con.execute(f"""
        WITH rip_per_code_upc AS (
            -- Best savings keyed by (wholesaler, edition, rip_code, upc).
            -- Preferred match when the RIP sheet's UPC matches the CPL row.
            -- RIP tiers can be quoted per case OR per bottle, and the per-case
            -- conversion of a bottle tier needs the pack size (bottles/case)
            -- which lives on the CPL row, not here — so emit the case-unit best
            -- (already per case) and the bottle-unit best (per bottle) separately
            -- and combine them after the join below.
            -- TIME-SENSITIVE FILTER: only count RIP rows whose validity window
            -- is full-month-or-null. Partial-window RIPs are deals you might
            -- catch but the catalog's "always-on effective price" can't assume
            -- — they belong to /api/deals/time-sensitive.
            SELECT
                wholesaler, edition, rip_code, upc,
                MAX(GREATEST(
                    COALESCE(CASE WHEN rip_qty_1 > 0 AND LOWER(rip_unit_1) NOT LIKE 'b%' THEN rip_amt_1 / rip_qty_1 END, 0),
                    COALESCE(CASE WHEN rip_qty_2 > 0 AND LOWER(rip_unit_2) NOT LIKE 'b%' THEN rip_amt_2 / rip_qty_2 END, 0),
                    COALESCE(CASE WHEN rip_qty_3 > 0 AND LOWER(rip_unit_3) NOT LIKE 'b%' THEN rip_amt_3 / rip_qty_3 END, 0),
                    COALESCE(CASE WHEN rip_qty_4 > 0 AND LOWER(rip_unit_4) NOT LIKE 'b%' THEN rip_amt_4 / rip_qty_4 END, 0)
                )) AS best_case_per_case,
                MAX(GREATEST(
                    COALESCE(CASE WHEN rip_qty_1 > 0 AND LOWER(rip_unit_1) LIKE 'b%' THEN rip_amt_1 / rip_qty_1 END, 0),
                    COALESCE(CASE WHEN rip_qty_2 > 0 AND LOWER(rip_unit_2) LIKE 'b%' THEN rip_amt_2 / rip_qty_2 END, 0),
                    COALESCE(CASE WHEN rip_qty_3 > 0 AND LOWER(rip_unit_3) LIKE 'b%' THEN rip_amt_3 / rip_qty_3 END, 0),
                    COALESCE(CASE WHEN rip_qty_4 > 0 AND LOWER(rip_unit_4) LIKE 'b%' THEN rip_amt_4 / rip_qty_4 END, 0)
                )) AS best_bottle_per_bottle
            FROM read_parquet('{pdir}/rip/**/data.parquet', hive_partitioning=true, union_by_name=true)
            WHERE rip_code IS NOT NULL
              AND {full_window('from_date', 'to_date')}
            GROUP BY wholesaler, edition, rip_code, upc
        ),
        rip_windows_per_code_upc AS (
            -- Same per-case / per-bottle best as rip_per_code_upc, but WITHOUT the
            -- full-month gate and grouped per validity window (from_date, to_date)
            -- so each distinct window is preserved. Powers the precomputed
            -- `rip_windows` list column the catalog uses to compute (and SORT by)
            -- the date-aware "live now" price at request time. The windows are
            -- static per edition; only the comparison to "today" varies, so this
            -- belongs in the parquet while the date filter stays at query time.
            SELECT
                wholesaler, edition, rip_code, upc, from_date, to_date,
                MAX(GREATEST(
                    COALESCE(CASE WHEN rip_qty_1 > 0 AND LOWER(rip_unit_1) NOT LIKE 'b%' THEN rip_amt_1 / rip_qty_1 END, 0),
                    COALESCE(CASE WHEN rip_qty_2 > 0 AND LOWER(rip_unit_2) NOT LIKE 'b%' THEN rip_amt_2 / rip_qty_2 END, 0),
                    COALESCE(CASE WHEN rip_qty_3 > 0 AND LOWER(rip_unit_3) NOT LIKE 'b%' THEN rip_amt_3 / rip_qty_3 END, 0),
                    COALESCE(CASE WHEN rip_qty_4 > 0 AND LOWER(rip_unit_4) NOT LIKE 'b%' THEN rip_amt_4 / rip_qty_4 END, 0)
                )) AS best_case_per_case,
                MAX(GREATEST(
                    COALESCE(CASE WHEN rip_qty_1 > 0 AND LOWER(rip_unit_1) LIKE 'b%' THEN rip_amt_1 / rip_qty_1 END, 0),
                    COALESCE(CASE WHEN rip_qty_2 > 0 AND LOWER(rip_unit_2) LIKE 'b%' THEN rip_amt_2 / rip_qty_2 END, 0),
                    COALESCE(CASE WHEN rip_qty_3 > 0 AND LOWER(rip_unit_3) LIKE 'b%' THEN rip_amt_3 / rip_qty_3 END, 0),
                    COALESCE(CASE WHEN rip_qty_4 > 0 AND LOWER(rip_unit_4) LIKE 'b%' THEN rip_amt_4 / rip_qty_4 END, 0)
                )) AS best_bottle_per_bottle
            FROM read_parquet('{pdir}/rip/**/data.parquet', hive_partitioning=true, union_by_name=true)
            WHERE rip_code IS NOT NULL
            GROUP BY wholesaler, edition, rip_code, upc, from_date, to_date
        ),
        -- How many DISTINCT listings share each (wholesaler, edition, UPC).
        -- "Listing" = the same identity the `joined` CTE partitions on
        -- (product_name, unit_volume, vintage). One UPC is reused across
        -- vintages/pack sizes (a $395 2021 cab and a $690 2023 cab can carry
        -- the SAME UPC). This count drives the RIP-applicability rule below:
        --   single listing  -> RIP-sheet presence by UPC is enough (the CPL
        --                       rip_code is unreliable, esp. opici which stores
        --                       a free-text label that won't byte-match);
        --   many listings    -> each CPL row must carry its OWN valid code that
        --                       matches the sheet, so a RIP can never bleed from
        --                       one vintage onto another.
        listing_counts AS (
            SELECT wholesaler, edition, CAST(upc AS VARCHAR) AS upc_s,
                   COUNT(DISTINCT (
                       product_name,
                       COALESCE(unit_volume, ''),
                       COALESCE(CAST(vintage AS VARCHAR), '')
                   )) AS n_listings
            FROM read_parquet('{pdir}/cpl/**/data.parquet', hive_partitioning=true, union_by_name=true)
            GROUP BY wholesaler, edition, CAST(upc AS VARCHAR)
        ),
        -- Best full-month RIP per (wholesaler, edition, UPC) across EVERY code
        -- listing that UPC. Used only on the single-listing path, where there is
        -- exactly one product behind the UPC so any code on the sheet for it
        -- applies. Inherits the full-month gate from rip_per_code_upc.
        rip_per_upc_any AS (
            SELECT wholesaler, edition, CAST(upc AS VARCHAR) AS upc_s,
                   MAX(best_case_per_case)     AS best_case_per_case,
                   MAX(best_bottle_per_bottle) AS best_bottle_per_bottle
            FROM rip_per_code_upc
            GROUP BY wholesaler, edition, CAST(upc AS VARCHAR)
        ),
        -- NOTE: the previous code-level fallback (rip_per_code CTE) is
        -- intentionally removed. The canonical rule is: a RIP applies to a
        -- product ONLY when the RIP sheet has a row explicitly pairing this
        -- product's UPC with the code. A stub-UPC row anchoring a RIP to
        -- "all products under this code" is no longer treated as valid
        -- applicability — it has to be an explicit (code, UPC) match.
        -- Some wholesalers (Fedway) cram multiple rip codes into one cell
        -- separated by whitespace, e.g. '10049 30017'. Split them so each
        -- code matches independently.
        cpl_codes AS (
            SELECT c.*,
                   UNNEST(
                       CASE WHEN c.rip_code IS NULL OR c.rip_code = ''
                            THEN ['']
                            ELSE string_split(REGEXP_REPLACE(c.rip_code, '\\s+', ' '), ' ')
                       END
                   ) AS single_code
            FROM read_parquet('{pdir}/cpl/**/data.parquet', hive_partitioning=true, union_by_name=true) c
        ),
        rip_windows_agg AS (
            -- Per CPL line, the list of EVERY RIP window that applies (full AND
            -- partial), each with its per-case amount (bottle tiers x pack). The
            -- catalog computes the live price at request time as
            --   base - MAX(amt where ref BETWEEN from_date AND to_date)
            -- so it can sort the whole grid by "best price active today" without
            -- a per-request join. Stored as a JSON-array STRING (plain VARCHAR)
            -- so it round-trips through Postgres (the prod store has no native
            -- list-of-struct type); parsed back with from_json at query time.
            -- Dates as ISO strings (lexical compare == date compare). Collapsed
            -- on the same identity the `joined` CTE uses so the LEFT JOIN is 1:1.
            SELECT
                cc.wholesaler, cc.edition, cc.upc, cc.product_name, cc.unit_volume, cc.vintage,
                CAST(to_json(list(DISTINCT struct_pack(
                    from_date := CAST(rw.from_date AS VARCHAR),
                    to_date := CAST(rw.to_date AS VARCHAR),
                    amt := ROUND(GREATEST(
                        COALESCE(rw.best_case_per_case, 0),
                        COALESCE(rw.best_bottle_per_bottle, 0) * COALESCE(TRY_CAST(cc.unit_qty AS DOUBLE), 1)
                    ), 2)
                ))) AS VARCHAR) AS rip_windows
            FROM cpl_codes cc
            LEFT JOIN listing_counts lc
                ON lc.wholesaler = cc.wholesaler
                AND lc.edition = cc.edition
                AND lc.upc_s = CAST(cc.upc AS VARCHAR)
            JOIN rip_windows_per_code_upc rw
                ON cc.wholesaler = rw.wholesaler
                AND cc.edition = rw.edition
                AND cc.upc = rw.upc
                -- Single listing (real UPC, not an all-same-digit stub): any
                -- code's window for this UPC. Many listings: only the window
                -- under THIS row's own valid matching code.
                AND (
                    (COALESCE(lc.n_listings, 1) <= 1
                     AND LENGTH(REPLACE(CAST(cc.upc AS VARCHAR), LEFT(CAST(cc.upc AS VARCHAR), 1), '')) > 0)
                    OR (cc.single_code = rw.rip_code
                        AND cc.single_code != '' AND cc.single_code != '0')
                )
            WHERE GREATEST(
                    COALESCE(rw.best_case_per_case, 0),
                    COALESCE(rw.best_bottle_per_bottle, 0) * COALESCE(TRY_CAST(cc.unit_qty AS DOUBLE), 1)
                  ) > 0
            GROUP BY cc.wholesaler, cc.edition, cc.upc, cc.product_name, cc.unit_volume, cc.vintage
        ),
        cpl_with_rip AS (
            SELECT
                cc.* EXCLUDE (single_code),
                -- Combine per-case (case tiers) and per-bottle×pack (bottle tiers).
                -- Applicability follows listing_counts:
                --   single listing -> best RIP across ANY code for this UPC
                --     (rip_per_upc_any), because the CPL rip_code is unreliable
                --     (opici stores a free-text label) but there's only one
                --     product behind the UPC so sheet presence is unambiguous;
                --   many listings  -> strict (code, UPC) match on THIS row's own
                --     valid code (rip_per_code_upc), so a RIP never bleeds from
                --     one vintage onto another. 0/blank/non-matching code = none.
                CASE
                    -- Single-listing lenient path, but NOT for placeholder UPCs
                    -- (e.g. '11111111111111'): an all-same-digit stub is a code-
                    -- level catch-all on the sheet, not a real product pairing,
                    -- so it falls through to the strict code match instead.
                    WHEN COALESCE(lc.n_listings, 1) <= 1
                         AND LENGTH(REPLACE(CAST(cc.upc AS VARCHAR), LEFT(CAST(cc.upc AS VARCHAR), 1), '')) > 0 THEN
                        GREATEST(
                            COALESCE(ru.best_case_per_case, 0),
                            COALESCE(ru.best_bottle_per_bottle, 0)
                                * COALESCE(TRY_CAST(cc.unit_qty AS DOUBLE), 1)
                        )
                    ELSE
                        GREATEST(
                            COALESCE(r1.best_case_per_case, 0),
                            COALESCE(r1.best_bottle_per_bottle, 0)
                                * COALESCE(TRY_CAST(cc.unit_qty AS DOUBLE), 1)
                        )
                END AS code_best_rip
            FROM cpl_codes cc
            LEFT JOIN listing_counts lc
                ON lc.wholesaler = cc.wholesaler
                AND lc.edition = cc.edition
                AND lc.upc_s = CAST(cc.upc AS VARCHAR)
            LEFT JOIN rip_per_code_upc r1
                ON cc.wholesaler = r1.wholesaler
                AND cc.edition = r1.edition
                AND cc.single_code = r1.rip_code
                AND cc.upc = r1.upc
                AND cc.single_code != ''
                AND cc.single_code != '0'
            LEFT JOIN rip_per_upc_any ru
                ON ru.wholesaler = cc.wholesaler
                AND ru.edition = cc.edition
                AND ru.upc_s = CAST(cc.upc AS VARCHAR)
        ),
        joined AS (
            -- Collapse per-code rows back to one row per CPL line by taking
            -- the max per-case RIP savings across all matched codes.
            -- Vintage is part of the partition: wine reuses one UPC across
            -- vintages (e.g. a $169 non-vintage listing and a $36 2023 closeout),
            -- so collapsing without it would arbitrarily drop one vintage per
            -- edition and make the surviving prices look like an impossible swing.
            SELECT
                * EXCLUDE (code_best_rip),
                MAX(code_best_rip) OVER (
                    PARTITION BY wholesaler, edition, upc, product_name, unit_volume, vintage
                ) AS best_rip_amt,
                ROW_NUMBER() OVER (
                    PARTITION BY wholesaler, edition, upc, product_name, unit_volume, vintage
                    ORDER BY COALESCE(code_best_rip, 0) DESC
                ) AS rn
            FROM cpl_with_rip
        ),
        enriched AS (
            SELECT
                j.* EXCLUDE (best_rip_amt, rn),
                -- Date-aware RIP windows for the runtime "live now" price + sort,
                -- as a JSON-array string. Empty array when the SKU carries no RIP.
                COALESCE(rwa.rip_windows, '[]') AS rip_windows,
                -- Tag whether THIS CPL row's window is full-month (or null).
                -- A partial-window CPL row (e.g. 5 Apr - 22 Apr) is a time-
                -- sensitive deal; its discount is excluded from effective
                -- price + savings + has_discount per the foundation rule.
                {full_window('from_date', 'to_date')} AS cpl_full_window,
                -- Effective price: best case price minus RIP savings (capped at 0).
                -- When the CPL row is partial-window, use frontline_case_price as
                -- the discount base (drop the CPL discount); the RIP layer is
                -- already filtered to full-window-only above.
                GREATEST(
                    ROUND(
                        (CASE
                            WHEN {full_window('from_date', 'to_date')}
                                THEN COALESCE(best_case_price, frontline_case_price)
                            ELSE frontline_case_price
                         END)
                        - COALESCE(best_rip_amt, 0),
                    2),
                    0
                ) AS effective_case_price,
                COALESCE(best_rip_amt, 0) AS rip_savings,
                -- Flags. has_discount is true ONLY when the CPL row is full-window
                -- AND the discount tier is non-zero — so a partial-month "$0/cs"
                -- liquidation doesn't dominate the Major Discounts ranker.
                CASE
                    WHEN discount_1_amt IS NOT NULL AND discount_1_amt > 0
                         AND {full_window('from_date', 'to_date')}
                    THEN true ELSE false
                END AS has_discount,
                CASE WHEN best_rip_amt IS NOT NULL AND best_rip_amt > 0
                     THEN true ELSE false END AS has_rip,
                CASE WHEN closeout_permit IS NOT NULL AND closeout_permit != ''
                     THEN true ELSE false END AS has_closeout,
                -- Savings percentage (discount tiers only, not RIP). Partial-
                -- window rows report zero CPL savings.
                ROUND(
                    CASE
                        WHEN frontline_case_price > 0 AND {full_window('from_date', 'to_date')}
                            THEN ((frontline_case_price - COALESCE(best_case_price, frontline_case_price))
                                  / frontline_case_price) * 100
                        ELSE 0
                    END, 2
                ) AS discount_pct,
                -- Total potential savings per case (discount + RIP, capped at
                -- frontline). Partial-window CPL rows contribute the RIP portion
                -- only; their discount portion is excluded.
                LEAST(
                    ROUND(
                        (CASE
                            WHEN {full_window('from_date', 'to_date')}
                                THEN (frontline_case_price - COALESCE(best_case_price, frontline_case_price))
                            ELSE 0
                         END)
                        + COALESCE(best_rip_amt, 0),
                    2),
                    frontline_case_price
                ) AS total_savings_per_case
            FROM joined j
            LEFT JOIN rip_windows_agg rwa
                ON j.wholesaler IS NOT DISTINCT FROM rwa.wholesaler
                AND j.edition IS NOT DISTINCT FROM rwa.edition
                AND j.upc IS NOT DISTINCT FROM rwa.upc
                AND j.product_name IS NOT DISTINCT FROM rwa.product_name
                AND j.unit_volume IS NOT DISTINCT FROM rwa.unit_volume
                AND j.vintage IS NOT DISTINCT FROM rwa.vintage
            WHERE j.rn = 1
        )
        -- Precompute the this-month -> next-month effective comparison so the
        -- catalog search can filter by Price Drop / Price Increase as a plain
        -- column read instead of running a self-join on every request.
        -- Partition key matches what backend.routers.catalog._attach_next_month_prices
        -- uses post-pagination so the filter and the per-row "Better price"
        -- sticker agree. NULL trend = no next-edition match for this row.
        SELECT *,
            LEAD(effective_case_price) OVER w AS next_effective_case_price,
            LAG(effective_case_price) OVER w AS prev_effective_case_price,
            -- Both-directional trend so the LATEST loaded edition is never null.
            -- Forward (this -> next edition) is "buy now vs wait" and is used
            -- whenever a next edition exists. When there isn't one yet (you're on
            -- the newest sheet, e.g. June while July is not published till mid
            -- month), fall back to a backward comparison vs the prior edition so
            -- Price Increases/Drops and price_movers still work. Self-heals: when
            -- a newer edition loads, this edition gains a LEAD and flips forward.
            CASE
                WHEN effective_case_price IS NULL THEN NULL
                WHEN LEAD(effective_case_price) OVER w IS NOT NULL THEN
                    CASE
                        WHEN ABS(LEAD(effective_case_price) OVER w - effective_case_price) <= 0.005 THEN 'flat'
                        WHEN LEAD(effective_case_price) OVER w < effective_case_price THEN 'drop'
                        ELSE 'increase'
                    END
                WHEN LAG(effective_case_price) OVER w IS NOT NULL THEN
                    CASE
                        WHEN ABS(effective_case_price - LAG(effective_case_price) OVER w) <= 0.005 THEN 'flat'
                        WHEN effective_case_price < LAG(effective_case_price) OVER w THEN 'drop'
                        ELSE 'increase'
                    END
                ELSE NULL
            END AS price_trend
        FROM enriched
        WINDOW w AS (
            PARTITION BY wholesaler,
                         COALESCE(CAST(upc AS VARCHAR), ''),
                         COALESCE(product_name, ''),
                         COALESCE(unit_volume, ''),
                         {vnorm}
            ORDER BY edition
        )
        ORDER BY wholesaler, edition, product_name
    """).fetchdf()

    # Brand extraction: parse brand from product_name
    df["brand"] = df["product_name"].apply(_extract_brand)

    _write(df, output_dir, "cpl_enriched")
    con.close()
    return df


def _extract_brand(product_name: str) -> str | None:
    """
    Extract brand from NJ ABC product names.

    NJ ABC product names follow patterns like:
      "MACALLAN 12Y SO 110"  → MACALLAN
      "14 HANDS CAB SAUV"    → 14 HANDS
      "-196 LEMON 6X4"       → -196
      "CH D'ESCLANS WHISPERING ANGEL ROSE" → CH D'ESCLANS

    Heuristic: take first N words until we hit a size indicator,
    age statement, grape variety, or pack configuration.
    """
    import re
    if not product_name or not isinstance(product_name, str):
        return None

    name = product_name.strip()
    if not name:
        return None

    # Stop words that indicate end of brand
    stop_patterns = re.compile(
        r'\b('
        r'\d+Y\b|\d+YR\b|\d+ML\b|\d+L\b|\d+OZ\b|\d+PK?\b|\d+P\b|'
        r'\d+X\d+|'
        r'CAB|SAUV|CHARD|PINOT|MERLOT|ROSE|RIESLING|BLEND|'
        r'BOURBON|WHISKEY|WHISKY|VODKA|GIN|RUM|TEQUILA|BRANDY|COGNAC|'
        r'RED\s?BL|WHITE|BLANCO|REPOSADO|ANEJO|EXTRA|'
        r'TALL|ZERO|VAR|VARIETY|'
        r'CN$|BTL|CS$|'
        r'\d+/\d+'
        r')\b',
        re.IGNORECASE
    )

    words = name.split()
    brand_words = []

    for i, word in enumerate(words):
        # If this word matches a stop pattern, stop collecting
        if stop_patterns.search(word) and i > 0:
            break
        brand_words.append(word)
        # Reasonable brand length: 1-4 words
        if len(brand_words) >= 4:
            break

    return " ".join(brand_words) if brand_words else None


def build_cross_source_links(parquet_dir: str | Path, output_dir: Path):
    """
    Gap 2: Cross-source product linking via fuzzy matching.

    Matches products across wholesalers by product_name similarity.
    Uses DuckDB's jaro_winkler_similarity for speed.
    """
    con = _get_conn(parquet_dir)
    pdir = Path(parquet_dir).as_posix()

    # Get latest edition per wholesaler, distinct products
    df = con.execute(f"""
        WITH latest AS (
            SELECT wholesaler, MAX(edition) AS edition
            FROM read_parquet('{pdir}/cpl/**/data.parquet', hive_partitioning=true, union_by_name=true)
            GROUP BY wholesaler
        ),
        products AS (
            SELECT DISTINCT c.wholesaler, c.product_name, c.upc, c.product_type,
                   c.unit_qty, c.unit_volume, c.frontline_case_price, c.best_case_price,
                   c.vintage,
                   LTRIM(c.upc, '0') AS upc_norm,
                   CASE WHEN c.vintage IS NULL OR c.vintage='' THEN NULL WHEN UPPER(c.vintage) IN ('NA','N/A','NONE','NV') THEN NULL WHEN regexp_matches(c.vintage,'^[0-9]{{4}}$') THEN c.vintage WHEN regexp_matches(c.vintage,'^[0-9]{{4}}\\.0+$') THEN substr(c.vintage,1,4) WHEN regexp_matches(c.vintage,'^[0-9]{{2}}$') THEN CASE WHEN CAST(c.vintage AS INTEGER)<=30 THEN '20'||c.vintage ELSE '19'||c.vintage END ELSE NULL END AS vintage_norm,
                   (UPPER(c.product_type) IN ('WINE','SPARKLING','VERMOUTH')) AS is_vintage_product
            FROM read_parquet('{pdir}/cpl/**/data.parquet', hive_partitioning=true, union_by_name=true) c
            INNER JOIN latest l ON c.wholesaler = l.wholesaler AND c.edition = l.edition
        )
        SELECT
            a.wholesaler AS wholesaler_a,
            a.product_name AS product_name_a,
            a.upc AS upc_a,
            a.frontline_case_price AS case_price_a,
            a.best_case_price AS best_price_a,
            b.wholesaler AS wholesaler_b,
            b.product_name AS product_name_b,
            b.upc AS upc_b,
            b.frontline_case_price AS case_price_b,
            b.best_case_price AS best_price_b,
            a.product_type,
            a.unit_volume,
            ROUND(jaro_winkler_similarity(
                UPPER(a.product_name), UPPER(b.product_name)
            ), 3) AS name_similarity,
            ROUND(b.frontline_case_price - a.frontline_case_price, 2) AS price_delta,
            CASE WHEN (
                     (a.upc IS NOT NULL AND a.upc != '' AND a.upc != '0' AND NOT regexp_matches(a.upc,'^(0+|9+|1+)$') AND NOT a.upc LIKE '999999%' AND LENGTH(a.upc) >= 8)
                     AND (b.upc IS NOT NULL AND b.upc != '' AND b.upc != '0' AND NOT regexp_matches(b.upc,'^(0+|9+|1+)$') AND NOT b.upc LIKE '999999%' AND LENGTH(b.upc) >= 8)
                     AND a.upc_norm = b.upc_norm
                 ) THEN true ELSE false END AS upc_match,
            a.upc_norm AS upc_norm,
            a.vintage_norm AS a_vintage,
            b.vintage_norm AS b_vintage
        FROM products a
        CROSS JOIN products b
        WHERE a.wholesaler < b.wholesaler
          AND a.unit_volume = b.unit_volume
          AND (
              (
                  (a.upc IS NOT NULL AND a.upc != '' AND a.upc != '0' AND NOT regexp_matches(a.upc,'^(0+|9+|1+)$') AND NOT a.upc LIKE '999999%' AND LENGTH(a.upc) >= 8)
                  AND (b.upc IS NOT NULL AND b.upc != '' AND b.upc != '0' AND NOT regexp_matches(b.upc,'^(0+|9+|1+)$') AND NOT b.upc LIKE '999999%' AND LENGTH(b.upc) >= 8)
                  AND a.upc_norm = b.upc_norm
              )
              OR (
                  jaro_winkler_similarity(UPPER(a.product_name), UPPER(b.product_name)) >= 0.88
                  AND NOT (
                      (a.upc IS NOT NULL AND a.upc != '' AND a.upc != '0' AND NOT regexp_matches(a.upc,'^(0+|9+|1+)$') AND NOT a.upc LIKE '999999%' AND LENGTH(a.upc) >= 8)
                      AND (b.upc IS NOT NULL AND b.upc != '' AND b.upc != '0' AND NOT regexp_matches(b.upc,'^(0+|9+|1+)$') AND NOT b.upc LIKE '999999%' AND LENGTH(b.upc) >= 8)
                  )
              )
          )
          AND (
              NOT (a.is_vintage_product OR b.is_vintage_product)
              OR a.vintage_norm IS NOT DISTINCT FROM b.vintage_norm
              OR a.vintage_norm IS NULL OR b.vintage_norm IS NULL
          )
        ORDER BY name_similarity DESC, a.product_name
    """).fetchdf()

    _write(df, output_dir, "cross_source_links")
    con.close()
    return df


def build_all(parquet_dir: str | Path = "parquet_output"):
    """Build all derived Parquet files."""
    parquet_dir = Path(parquet_dir)
    output_dir = parquet_dir / "derived"
    output_dir.mkdir(parents=True, exist_ok=True)

    print("\nBuilding derived Parquet files...")
    print("=" * 50)

    # cpl_enriched first because build_price_changes now reads effective_case_price
    # from it (see the effective_* columns in price_changes — those depend on the
    # enrichment join that lives only in cpl_enriched).
    build_cpl_enriched(parquet_dir, output_dir)
    build_price_changes(parquet_dir, output_dir)
    build_item_lifecycle(parquet_dir, output_dir)

    print("\nBuilding cross-source links (this may take a minute)...")
    build_cross_source_links(parquet_dir, output_dir)

    print("=" * 50)
    print("All derived files built.\n")
