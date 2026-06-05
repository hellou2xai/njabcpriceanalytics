"""POS ingestion contract.

Row shapes (plain dicts, the normalized form every feed adapter must produce):

sales row:
    {"business_date": "YYYY-MM-DD", "upc": str, "product_name": str,
     "category": str, "units_sold": int, "unit_retail": float,
     "net_revenue": float}

inventory row:
    {"as_of_date": "YYYY-MM-DD", "upc": str, "product_name": str,
     "on_hand_units": int}

Both ingest functions are idempotent: re-running the same feed updates the
existing (store, date, upc) rows instead of duplicating them. Loading goes
through a COPY into a temp table then a single INSERT ... ON CONFLICT merge,
so a two-year backfill stays fast.
"""

from backend.pg import get_pg


def _copy_merge(pg, rows, temp_cols, copy_sql, merge_sql, params):
    """COPY `rows` (tuples) into a temp table, then merge with one statement."""
    pg.execute(copy_sql["create"])
    with pg.cursor() as cur:
        with cur.copy(copy_sql["copy"]) as cp:
            for r in rows:
                cp.write_row(r)
    pg.execute(merge_sql, params)
    pg.execute(copy_sql["drop"])


def ingest_sales(store_id: int, user_id: int, rows: list[dict], source: str) -> int:
    """Load normalized daily sales rows for one store. Returns rows ingested."""
    if not rows:
        return 0
    tuples = [(r["business_date"], r["upc"], r.get("product_name"),
               r.get("category"), int(r["units_sold"]),
               r.get("unit_retail"), float(r["net_revenue"])) for r in rows]
    dates = [t[0] for t in tuples]
    with get_pg() as pg:
        _copy_merge(
            pg, tuples,
            temp_cols=7,
            copy_sql={
                "create": """CREATE TEMP TABLE _pos_sales_in (
                    business_date text, upc text, product_name text,
                    category text, units_sold integer,
                    unit_retail double precision, net_revenue double precision
                ) ON COMMIT DROP""",
                "copy": "COPY _pos_sales_in (business_date, upc, product_name, "
                        "category, units_sold, unit_retail, net_revenue) FROM STDIN",
                "drop": "DROP TABLE IF EXISTS _pos_sales_in",
            },
            merge_sql="""
                INSERT INTO pos_sales_daily
                    (store_id, user_id, business_date, upc, product_name,
                     category, units_sold, unit_retail, net_revenue, source)
                SELECT %s, %s, business_date, upc, product_name,
                       category, units_sold, unit_retail, net_revenue, %s
                FROM _pos_sales_in
                ON CONFLICT (store_id, business_date, upc) DO UPDATE SET
                    units_sold   = EXCLUDED.units_sold,
                    unit_retail  = EXCLUDED.unit_retail,
                    net_revenue  = EXCLUDED.net_revenue,
                    product_name = EXCLUDED.product_name,
                    category     = EXCLUDED.category,
                    source       = EXCLUDED.source
            """,
            params=(store_id, user_id, source),
        )
        pg.execute(
            "INSERT INTO pos_ingest_log (store_id, user_id, source, kind, "
            "period_start, period_end, rows_ingested) VALUES (%s,%s,%s,'sales',%s,%s,%s)",
            (store_id, user_id, source, min(dates), max(dates), len(tuples)))
    return len(tuples)


def ingest_inventory(store_id: int, user_id: int, rows: list[dict], source: str) -> int:
    """Load an on-hand snapshot for one store. Returns rows ingested."""
    if not rows:
        return 0
    tuples = [(r["as_of_date"], r["upc"], r.get("product_name"),
               int(r["on_hand_units"])) for r in rows]
    dates = [t[0] for t in tuples]
    with get_pg() as pg:
        _copy_merge(
            pg, tuples,
            temp_cols=4,
            copy_sql={
                "create": """CREATE TEMP TABLE _pos_inv_in (
                    as_of_date text, upc text, product_name text,
                    on_hand_units integer
                ) ON COMMIT DROP""",
                "copy": "COPY _pos_inv_in (as_of_date, upc, product_name, "
                        "on_hand_units) FROM STDIN",
                "drop": "DROP TABLE IF EXISTS _pos_inv_in",
            },
            merge_sql="""
                INSERT INTO pos_inventory
                    (store_id, user_id, as_of_date, upc, product_name,
                     on_hand_units, source)
                SELECT %s, %s, as_of_date, upc, product_name, on_hand_units, %s
                FROM _pos_inv_in
                ON CONFLICT (store_id, as_of_date, upc) DO UPDATE SET
                    on_hand_units = EXCLUDED.on_hand_units,
                    product_name  = EXCLUDED.product_name,
                    source        = EXCLUDED.source
            """,
            params=(store_id, user_id, source),
        )
        pg.execute(
            "INSERT INTO pos_ingest_log (store_id, user_id, source, kind, "
            "period_start, period_end, rows_ingested) VALUES (%s,%s,%s,'inventory',%s,%s,%s)",
            (store_id, user_id, source, min(dates), max(dates), len(tuples)))
    return len(tuples)
