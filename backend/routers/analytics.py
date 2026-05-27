"""
Analytics API â€” price movers, lifecycle events, cross-source comparisons.

Covers: Â§6 Dashboard, Â§8 Analytics, Â§15 Materialized Views
"""

import math

from fastapi import APIRouter, Query
from typing import Optional

from backend.db import get_duckdb, read_parquet

router = APIRouter(prefix="/api/analytics", tags=["analytics"])


def _records(df):
    """DataFrame to a list of dicts with non-finite floats (NaN/inf) coerced to
    None. Pandas leaves NaN in numeric columns and FastAPI's JSON encoder
    rejects NaN as non-compliant, which otherwise 500s the response."""
    recs = df.to_dict(orient="records")
    for row in recs:
        for k, v in row.items():
            if isinstance(v, float) and not math.isfinite(v):
                row[k] = None
    return recs


@router.get("/dashboard")
def get_dashboard(wholesaler: Optional[str] = None, edition: Optional[str] = None):
    """Dashboard KPIs â€” Â§6.1"""
    with get_duckdb() as con:
        src = read_parquet(con, "cpl_enriched")
        where = ["1=1"]
        params = {}
        if wholesaler:
            where.append("wholesaler = $wholesaler")
            params["wholesaler"] = wholesaler
        if not edition:
            # Use latest edition
            edition_q = f"(SELECT MAX(edition) FROM {src}"
            if wholesaler:
                edition_q += " WHERE wholesaler = $wholesaler"
            edition_q += ")"
            where.append(f"edition = {edition_q}")
        else:
            where.append("edition = $edition")
            params["edition"] = edition

        w = " AND ".join(where)

        kpis = con.execute(f"""
            SELECT
                count(*) AS total_items,
                sum(CASE WHEN has_discount THEN 1 ELSE 0 END) AS active_discounts,
                sum(CASE WHEN has_closeout THEN 1 ELSE 0 END) AS clearance_items,
                sum(CASE WHEN has_rip THEN 1 ELSE 0 END) AS active_rips,
                round(sum(CASE WHEN has_discount THEN total_savings_per_case ELSE 0 END), 2) AS total_savings_pool,
                round(avg(frontline_case_price), 2) AS avg_case_price
            FROM {src}
            WHERE {w}
        """, params).fetchdf().to_dict(orient="records")[0]

        # Price movement counts from price_changes
        pc = read_parquet(con, "price_changes")
        pc_where = ["1=1"]
        if wholesaler:
            pc_where.append("wholesaler = $wholesaler")
        if edition:
            pc_where.append("edition = $edition")
        else:
            pc_where.append(f"edition = (SELECT MAX(edition) FROM {pc}" +
                           (f" WHERE wholesaler = $wholesaler" if wholesaler else "") + ")")

        pw = " AND ".join(pc_where)
        movers = con.execute(f"""
            SELECT
                sum(CASE WHEN direction = 'down' THEN 1 ELSE 0 END) AS price_drops,
                sum(CASE WHEN direction = 'up' THEN 1 ELSE 0 END) AS price_increases
            FROM {pc}
            WHERE {pw}
        """, params).fetchdf().to_dict(orient="records")[0]

        return {**kpis, **movers}


@router.get("/price-movers")
def get_price_movers(
    wholesaler: Optional[str] = None,
    edition: Optional[str] = None,
    direction: str = Query("down", description="up or down"),
    limit: int = Query(20, ge=1, le=100),
):
    """Top price movers - 6.2, 8.1. Resilient to older ingested data that may
    lack some derived columns (e.g. vintage_norm): any missing column is
    selected as NULL so the endpoint returns rows instead of 500-ing (which is
    why the dashboard count showed but the drill-down was empty)."""
    with get_duckdb() as con:
        src = read_parquet(con, "price_changes")
        avail = {d[0] for d in con.execute(f"SELECT * FROM {src} LIMIT 0").description}

        def col(name):
            return name if name in avail else f"NULL AS {name}"

        if "vintage_norm" in avail:
            vintage_expr = "vintage_norm AS vintage"
        elif "vintage" in avail:
            vintage_expr = "vintage AS vintage"
        else:
            vintage_expr = "NULL AS vintage"

        select_cols = ", ".join([
            "wholesaler", "edition", "product_name",
            col("product_type"), col("unit_volume"), vintage_expr,
            col("case_price"), col("prev_case_price"),
            col("case_delta"), col("case_delta_pct"), "direction",
        ])

        where = ["direction = $direction"]
        params = {"direction": direction}
        if wholesaler:
            where.append("wholesaler = $wholesaler")
            params["wholesaler"] = wholesaler
        if edition:
            where.append("edition = $edition")
            params["edition"] = edition
        else:
            where.append(f"edition = (SELECT MAX(edition) FROM {src}" +
                        (f" WHERE wholesaler = $wholesaler" if wholesaler else "") + ")")

        w = " AND ".join(where)
        order = "ORDER BY ABS(case_delta_pct) DESC NULLS LAST" if "case_delta_pct" in avail else ""
        df = con.execute(f"""
            SELECT {select_cols}
            FROM {src}
            WHERE {w}
            {order}
            LIMIT $limit
        """, {**params, "limit": limit}).fetchdf()
        return _records(df)


@router.get("/lifecycle")
def get_lifecycle_events(
    wholesaler: Optional[str] = None,
    edition: Optional[str] = None,
    event_type: Optional[str] = None,
    limit: int = Query(50, ge=1, le=1000),
):
    """New items, discontinued, new/lost discounts â€” Â§8.1"""
    with get_duckdb() as con:
        src = read_parquet(con, "item_lifecycle")
        where = ["1=1"]
        params = {}
        if wholesaler:
            where.append("wholesaler = $wholesaler")
            params["wholesaler"] = wholesaler
        if edition:
            where.append("edition = $edition")
            params["edition"] = edition
        if event_type:
            where.append("event_type = $event_type")
            params["event_type"] = event_type

        w = " AND ".join(where)
        df = con.execute(f"""
            SELECT * FROM {src}
            WHERE {w}
            ORDER BY edition DESC, event_type
            LIMIT $limit
        """, {**params, "limit": limit}).fetchdf()
        return _records(df)


@router.get("/cross-source")
def get_cross_source_comparison(
    product_name: Optional[str] = None,
    min_similarity: float = Query(0.9, ge=0.5, le=1.0),
    limit: int = Query(50, ge=1, le=1000),
):
    """Cross-source price comparison â€” Â§8.2, Â§11"""
    with get_duckdb() as con:
        src = read_parquet(con, "cross_source_links")
        where = [f"(upc_match = true OR name_similarity >= $min_sim)"]
        params = {"min_sim": min_similarity}

        if product_name:
            where.append("(UPPER(product_name_a) LIKE UPPER($q) OR UPPER(product_name_b) LIKE UPPER($q))")
            params["q"] = f"%{product_name}%"

        w = " AND ".join(where)
        df = con.execute(f"""
            SELECT * FROM {src}
            WHERE {w}
            ORDER BY name_similarity DESC
            LIMIT $limit
        """, {**params, "limit": limit}).fetchdf()
        return _records(df)


@router.get("/category-trends")
def get_category_trends(wholesaler: Optional[str] = None):
    """Average price change by category â€” Â§8.1"""
    with get_duckdb() as con:
        src = read_parquet(con, "price_changes")
        where = ["product_type IS NOT NULL"]
        params = {}
        if wholesaler:
            where.append("wholesaler = $wholesaler")
            params["wholesaler"] = wholesaler

        w = " AND ".join(where)
        df = con.execute(f"""
            SELECT product_type, edition,
                   round(avg(case_delta_pct), 2) AS avg_change_pct,
                   count(*) AS items,
                   sum(CASE WHEN direction='up' THEN 1 ELSE 0 END) AS increases,
                   sum(CASE WHEN direction='down' THEN 1 ELSE 0 END) AS decreases
            FROM {src}
            WHERE {w}
            GROUP BY product_type, edition
            ORDER BY edition, product_type
        """, params).fetchdf()
        return _records(df)
