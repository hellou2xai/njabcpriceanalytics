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


# In-process cache of the full classified price-movers list per direction. The
# heavy work (joins + Python classification) runs once per pricing-cache version
# and per direction; subsequent requests just filter the cached list, which
# keeps the endpoint well under Render's proxy timeout even cold.
import threading as _threading
_pm_cache: dict = {"token": None, "down": None, "up": None}
_pm_lock = _threading.Lock()


def _pm_compute_full(con, direction: str) -> list[dict]:
    """Compute the full classified mover list for a direction (no filters)."""
    from backend.enrichment_join import attach_enrichment_image
    from datetime import date as _date
    import pandas as pd

    today = _date.today()
    current_ym = f"{today.year:04d}-{today.month:02d}"

    src = read_parquet(con, "price_changes")
    cpl = read_parquet(con, "cpl_enriched")
    avail = {d[0] for d in con.execute(f"SELECT * FROM {src} LIMIT 0").description}
    def col(name):
        return f"pc.{name}" if name in avail else f"NULL AS {name}"
    if "vintage_norm" in avail:
        vintage_expr = "pc.vintage_norm AS vintage"
    elif "vintage" in avail:
        vintage_expr = "pc.vintage AS vintage"
    else:
        vintage_expr = "NULL AS vintage"

    eds_df = con.execute(
        f"""SELECT wholesaler,
               COALESCE(MAX(CASE WHEN edition <= $c THEN edition END), MAX(edition)) AS cur_ed,
               MIN(CASE WHEN edition > $c THEN edition END) AS next_ed
            FROM {cpl} GROUP BY wholesaler""",
        {"c": current_ym},
    ).fetchdf()

    ed_by_ws: dict = {}
    conds, params, i = [], {}, 0
    for _, row in eds_df.iterrows():
        ws = row["wholesaler"]
        cur_ed = row.get("cur_ed"); next_ed = row.get("next_ed")
        cur_s = str(cur_ed) if cur_ed is not None and (not isinstance(cur_ed, float) or cur_ed == cur_ed) else None
        next_s = str(next_ed) if next_ed is not None and (not isinstance(next_ed, float) or next_ed == next_ed) else None
        ed_by_ws[ws] = (cur_s, next_s)
        for ed in (cur_s, next_s):
            if not ed: continue
            conds.append(f"(pc.wholesaler = $w{i} AND pc.edition = $e{i})")
            params[f"w{i}"], params[f"e{i}"] = ws, ed
            i += 1
    if not conds:
        return []

    select_cols = ", ".join([
        "pc.wholesaler", "pc.edition", "pc.product_name",
        col("product_type"), col("unit_volume"), vintage_expr,
        col("case_price"), col("prev_case_price"),
        col("case_delta"), col("case_delta_pct"), "pc.direction",
        "c.upc AS upc", "c.brand AS brand", "c.unit_qty AS unit_qty",
        "c.effective_case_price AS effective_case_price",
        "c.has_rip AS has_rip", "c.has_discount AS has_discount",
    ])
    df = con.execute(f"""
        SELECT {select_cols}
        FROM {src} pc
        LEFT JOIN {cpl} c
          ON c.wholesaler = pc.wholesaler
         AND c.edition    = pc.edition
         AND c.product_name = pc.product_name
        WHERE ({' OR '.join(conds)})
    """, params).fetchdf()

    slots: dict = {}
    for _, r in df.iterrows():
        cur_s, next_s = ed_by_ws.get(r["wholesaler"], (None, None))
        ed = str(r["edition"])
        slot = "cur" if ed == cur_s else ("next" if ed == next_s else None)
        if slot is None: continue
        key = (r["wholesaler"], r["product_name"])
        slots.setdefault(key, {})[slot] = r

    out: list[dict] = []
    for (ws, _name), s in slots.items():
        cur_r = s.get("cur"); next_r = s.get("next")
        cur_match = cur_r is not None and cur_r["direction"] == direction
        next_match = next_r is not None and next_r["direction"] == direction
        def _price_holds() -> bool:
            if next_r is None: return True
            cp = cur_r["case_price"] if cur_r is not None else None
            np_ = next_r["case_price"]
            if cp is None or np_ is None or cp != cp or np_ != np_:
                return next_match
            tol = max(0.02, abs(cp) * 0.005)
            if direction == "down":
                return np_ <= cp + tol
            return np_ >= cp - tol
        if cur_match:
            vlabel = "both" if _price_holds() else "current_only"
            base = cur_r
        elif next_match and next_r is not None:
            vlabel = "next_only"; base = next_r
        else:
            continue
        row = {c: base[c] for c in base.index}
        row["validity"] = vlabel
        cur_s, next_s = ed_by_ws.get(ws, (None, None))
        row["cur_edition"] = cur_s
        row["next_edition"] = next_s
        row["next_case_price"] = next_r["case_price"] if next_r is not None else None
        out.append(row)

    out.sort(key=lambda r: abs(r.get("case_delta_pct") or 0), reverse=True)
    out = _records(pd.DataFrame(out)) if out else []
    try:
        attach_enrichment_image(con, out)
    except Exception:
        pass
    return out


def _pm_cached(con, direction: str) -> list[dict]:
    from backend.pricing_cache import get_pricing_path
    token = str(get_pricing_path())
    if _pm_cache.get("token") == token and _pm_cache.get(direction) is not None:
        return _pm_cache[direction]  # type: ignore
    with _pm_lock:
        if _pm_cache.get("token") == token and _pm_cache.get(direction) is not None:
            return _pm_cache[direction]  # type: ignore
        result = _pm_compute_full(con, direction)
        # If the cache token changed since we got into the lock, reset the bag.
        if _pm_cache.get("token") != token:
            _pm_cache.clear(); _pm_cache["token"] = token
        _pm_cache[direction] = result
        _pm_cache["token"] = token
        return result


def warm_pm_cache_async():
    """Pre-compute the price-mover lists in the background so the first request
    after a deploy or reload doesn't wait through the heavy classification."""
    def _run():
        try:
            with get_duckdb() as con:
                _pm_cached(con, "down")
                _pm_cached(con, "up")
        except Exception as e:
            print(f"[pm] price-movers cache warm skipped: {e}")
    _threading.Thread(target=_run, daemon=True).start()


@router.get("/price-movers")
def get_price_movers(
    wholesaler: Optional[str] = None,
    edition: Optional[str] = None,
    direction: str = Query("down", description="up or down"),
    validity: str = Query("all", description="all | current_only | next_only | both"),
    limit: int = Query(500, ge=1, le=5000),
):
    """Top price movers (6.2, 8.1). Resilient to older ingested data that may
    lack some derived columns (e.g. vintage_norm) - any missing column is
    selected as NULL so the endpoint returns rows instead of 500-ing.

    Joins back to cpl_enriched to surface the product's upc, brand, the current
    effective (post-discount/RIP) case price, and the has_rip/has_discount
    flags, and runs the catalogue's enrichment join so the card view can show
    the product image."""
    with get_duckdb() as con:
        full = _pm_cached(con, direction)
        out = list(full)
        if wholesaler:
            out = [r for r in out if r.get("wholesaler") == wholesaler]
        if validity != "all":
            out = [r for r in out if r.get("validity") == validity]
        out = out[:limit]
        # Attach the pre-generated AI mover blurb if we have one. Read live from
        # Postgres (small table), keyed by (wholesaler, ltrim(upc), edition,
        # direction). Missing blurbs simply leave the field null on the row.
        try:
            from backend.pg import get_pg
            blurb_map: dict = {}
            with get_pg() as pg:
                cur = pg.execute(
                    "SELECT wholesaler, LTRIM(upc, '0') AS un, edition, blurb "
                    "FROM ai_mover_blurbs WHERE direction = %s",
                    (direction,),
                )
                for b in cur.fetchall():
                    blurb_map[(b["wholesaler"], b["un"], b["edition"])] = b["blurb"]
            for row in out:
                u = (row.get("upc") or "")
                un = str(u).lstrip("0") if u else ""
                row["ai_blurb"] = blurb_map.get((row.get("wholesaler"), un, row.get("edition")))
        except Exception:
            for row in out:
                row.setdefault("ai_blurb", None)
        return out


@router.get("/price-mover-editions")
def get_price_mover_editions(direction: str = Query("down", description="up or down")):
    """Distinct editions for which we have price movers in the given direction,
    newest first. Drives the Price Month filter on the Price Drops / Increases
    pages."""
    with get_duckdb() as con:
        src = read_parquet(con, "price_changes")
        df = con.execute(f"""
            SELECT DISTINCT edition FROM {src}
            WHERE direction = $d AND edition IS NOT NULL
            ORDER BY edition DESC
        """, {"d": direction}).fetchdf()
        return [str(r["edition"]) for _, r in df.iterrows()]


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
