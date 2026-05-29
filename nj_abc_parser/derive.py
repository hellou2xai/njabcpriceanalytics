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

    df = con.execute(f"""
        WITH withv AS (
            SELECT *
                {("" if has_enriched else f", {eff_expr}")},
                CASE WHEN UPPER(product_type) IN ('WINE','SPARKLING','VERMOUTH')
                     THEN {vnorm} ELSE NULL END AS vkey
            {base_select}
        ),
        base AS (
            -- Collapse duplicate rows within a SKU+vintage+edition so LAG
            -- compares one clean value per edition.
            SELECT * FROM withv
            QUALIFY ROW_NUMBER() OVER (
                PARTITION BY wholesaler, product_name, unit_volume, unit_qty, vkey, edition
                ORDER BY frontline_case_price
            ) = 1
        ),
        ranked AS (
            SELECT *,
                LAG(frontline_case_price) OVER (
                    PARTITION BY wholesaler, product_name, unit_volume, unit_qty, vkey
                    ORDER BY edition
                ) AS prev_case_price,
                LAG(best_case_price) OVER (
                    PARTITION BY wholesaler, product_name, unit_volume, unit_qty, vkey
                    ORDER BY edition
                ) AS prev_best_price,
                LAG(effective_case_price) OVER (
                    PARTITION BY wholesaler, product_name, unit_volume, unit_qty, vkey
                    ORDER BY edition
                ) AS prev_effective_case_price,
                LAG(frontline_unit_price) OVER (
                    PARTITION BY wholesaler, product_name, unit_volume, unit_qty, vkey
                    ORDER BY edition
                ) AS prev_unit_price,
                LAG(edition) OVER (
                    PARTITION BY wholesaler, product_name, unit_volume, unit_qty, vkey
                    ORDER BY edition
                ) AS prev_edition,
                LAG(discount_1_amt) OVER (
                    PARTITION BY wholesaler, product_name, unit_volume, unit_qty, vkey
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

    df = con.execute(f"""
        WITH rip_per_code_upc AS (
            -- Best savings keyed by (wholesaler, edition, rip_code, upc).
            -- Preferred match when the RIP sheet's UPC matches the CPL row.
            -- RIP tiers can be quoted per case OR per bottle, and the per-case
            -- conversion of a bottle tier needs the pack size (bottles/case)
            -- which lives on the CPL row, not here — so emit the case-unit best
            -- (already per case) and the bottle-unit best (per bottle) separately
            -- and combine them after the join below.
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
            GROUP BY wholesaler, edition, rip_code, upc
        ),
        rip_per_code AS (
            -- Code-level fallback. Some wholesalers (e.g. Fedway) anchor
            -- a RIP to a stub UPC like '812066000000' for the whole product
            -- line, so we still apply the RIP via the code when the strict
            -- UPC match misses.
            SELECT
                wholesaler, edition, rip_code,
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
            GROUP BY wholesaler, edition, rip_code
        ),
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
        cpl_with_rip AS (
            SELECT
                cc.* EXCLUDE (single_code),
                -- Combine per-case (case tiers) and per-bottle×pack (bottle tiers).
                -- Prefer the exact-UPC RIP row (r1); fall back to code-level (r2).
                GREATEST(
                    COALESCE(r1.best_case_per_case, r2.best_case_per_case, 0),
                    COALESCE(r1.best_bottle_per_bottle, r2.best_bottle_per_bottle, 0)
                        * COALESCE(TRY_CAST(cc.unit_qty AS DOUBLE), 1)
                ) AS code_best_rip
            FROM cpl_codes cc
            LEFT JOIN rip_per_code_upc r1
                ON cc.wholesaler = r1.wholesaler
                AND cc.edition = r1.edition
                AND cc.single_code = r1.rip_code
                AND cc.upc = r1.upc
                AND cc.single_code != ''
                AND cc.single_code != '0'
            LEFT JOIN rip_per_code r2
                ON cc.wholesaler = r2.wholesaler
                AND cc.edition = r2.edition
                AND cc.single_code = r2.rip_code
                AND cc.single_code != ''
                AND cc.single_code != '0'
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
        )
        SELECT
            * EXCLUDE (best_rip_amt, rn),
            -- Effective price: best case price minus RIP savings (capped at 0)
            GREATEST(
                ROUND(COALESCE(best_case_price, frontline_case_price)
                      - COALESCE(best_rip_amt, 0), 2),
                0
            ) AS effective_case_price,
            COALESCE(best_rip_amt, 0) AS rip_savings,
            -- Flags
            CASE WHEN discount_1_amt IS NOT NULL AND discount_1_amt > 0
                 THEN true ELSE false END AS has_discount,
            CASE WHEN best_rip_amt IS NOT NULL AND best_rip_amt > 0
                 THEN true ELSE false END AS has_rip,
            CASE WHEN closeout_permit IS NOT NULL AND closeout_permit != ''
                 THEN true ELSE false END AS has_closeout,
            -- Savings percentage (discount tiers only, not RIP)
            ROUND(
                CASE WHEN frontline_case_price > 0
                THEN ((frontline_case_price - COALESCE(best_case_price, frontline_case_price))
                      / frontline_case_price) * 100
                ELSE 0 END, 2
            ) AS discount_pct,
            -- Total potential savings per case (discount + RIP, capped at frontline price)
            LEAST(
                ROUND(frontline_case_price
                      - COALESCE(best_case_price, frontline_case_price)
                      + COALESCE(best_rip_amt, 0), 2),
                frontline_case_price
            ) AS total_savings_per_case
        FROM joined
        WHERE rn = 1
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
