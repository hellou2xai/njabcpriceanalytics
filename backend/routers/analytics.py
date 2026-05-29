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
        # Effective-price counterparts (added to price_changes by the pipeline
        # — see nj_abc_parser/derive.py::build_price_changes). When the parquet
        # was built before this addition the col() helper falls back to NULL
        # and the loop below degrades to frontline-only classification.
        col("effective_case_price"), col("prev_effective_case_price"),
        col("effective_delta"), col("effective_delta_pct"),
        col("effective_direction"),
        "c.upc AS upc", "c.brand AS brand", "c.unit_qty AS unit_qty",
        "c.effective_case_price AS c_effective_case_price",
        "c.has_rip AS has_rip", "c.has_discount AS has_discount",
    ])
    # Tighten the metadata JOIN so cpl rows only match when the SKU's
    # size + pack + vintage agree with the pc row. Without this, a wine with
    # both 2019 and 2020 vintages in the same edition would explode each pc
    # row into multiple joined rows (one per vintage) and the wrong UPC /
    # effective price could land on the row downstream. _vintage_norm_sql
    # normalizes the raw cpl vintage to the same form pc carries.
    #
    # IMPORTANT: unit_qty must be normalised too. The monthly Excel files
    # ingest the pack count as an integer in some editions and a float in
    # others ("12" vs "12.0"), and a strict IS NOT DISTINCT FROM would
    # miss the match. regexp_replace strips a trailing .0 so both shapes
    # land on the same string. Otherwise a May "12.0" row gets stranded,
    # the LAG chain breaks (already fixed in derive) AND the join here
    # would still pull the wrong cpl side.
    from backend.routers.catalog import _vintage_norm_sql
    uq_norm = "regexp_replace(TRIM(CAST({col} AS VARCHAR)), '\\.0+$', '')"
    df = con.execute(f"""
        SELECT {select_cols}
        FROM {src} pc
        LEFT JOIN {cpl} c
          ON c.wholesaler = pc.wholesaler
         AND c.edition    = pc.edition
         AND c.product_name = pc.product_name
         AND c.unit_volume IS NOT DISTINCT FROM pc.unit_volume
         AND {uq_norm.format(col='c.unit_qty')} IS NOT DISTINCT FROM {uq_norm.format(col='pc.unit_qty')}
         AND ({_vintage_norm_sql('c.vintage')}) IS NOT DISTINCT FROM pc.vintage_norm
        WHERE ({' OR '.join(conds)})
    """, params).fetchdf()

    # Apple-to-apple: a single (wholesaler, product_name) can hold several
    # distinct SKUs (different sizes, pack qty, or wine vintage). The cur ↔
    # next pairing must stay within ONE SKU so a 2019 in May is never matched
    # against a 2020 in June — that's not a price move, that's a vintage swap.
    slots: dict = {}
    def _kpart(v):
        return v if (v is not None and not (isinstance(v, float) and v != v)) else None
    def _norm_uq(v):
        """Collapse "12" and "12.0" (parquet round-trip artifact) to one key."""
        s = _kpart(v)
        if s is None: return ""
        s = str(s).strip()
        if "." in s and s.endswith("0"):
            s = s.rstrip("0").rstrip(".")
        return s
    for _, r in df.iterrows():
        cur_s, next_s = ed_by_ws.get(r["wholesaler"], (None, None))
        ed = str(r["edition"])
        slot = "cur" if ed == cur_s else ("next" if ed == next_s else None)
        if slot is None: continue
        key = (
            r["wholesaler"], r["product_name"],
            _kpart(r.get("unit_volume")) or "",
            _norm_uq(r.get("unit_qty")),
            _kpart(r.get("vintage")) or "",
        )
        slots.setdefault(key, {})[slot] = r

    def _isnum(v) -> bool:
        # Catches Python None, NaN float, and pandas NA — which now coexist in
        # the dataframe because the parquet round-trips integer columns through
        # nullable dtypes. Without the pd.isna() catch a pandas NA propagates
        # into downstream `in` / equality checks and blows up with "ambiguous".
        if v is None: return False
        try:
            if pd.isna(v): return False  # type: ignore[arg-type]
        except (TypeError, ValueError):
            pass
        if isinstance(v, float) and v != v: return False
        return True
    def _f(r, name):
        if r is None: return None
        try:
            v = r[name]
        except (KeyError, IndexError):
            return None
        return v if _isnum(v) else None

    out: list[dict] = []
    for _key, s in slots.items():
        ws = _key[0]
        cur_r = s.get("cur"); next_r = s.get("next")

        # Prefer the effective_direction classifier (computed off the after-RIP
        # price) because that's what the user calls "the price". Fall back to
        # the frontline `direction` when the parquet was built before the
        # effective_* columns were added.
        def _dir(r) -> str | None:
            if r is None: return None
            d = _f(r, "effective_direction")
            if d in ("up", "down", "stable", "new"): return d
            d2 = _f(r, "direction")
            return d2 if d2 in ("up", "down", "stable", "new") else None
        cur_match = (_dir(cur_r) == direction)
        next_match = (_dir(next_r) == direction)
        if not (cur_match or next_match):
            continue

        base = cur_r if cur_r is not None else next_r
        row = {c: base[c] for c in base.index}

        # Frontline three prices (list / before-RIP).
        if cur_r is not None:
            fp_prev = _f(cur_r, "prev_case_price")
            fp_cur  = _f(cur_r, "case_price")
        else:
            held = _f(next_r, "prev_case_price")
            fp_prev = held; fp_cur = held
        fp_next = _f(next_r, "case_price")

        # Effective three prices (after best discount + best RIP). Falls back
        # to frontline if the parquet is missing the effective columns, so an
        # older deployment degrades gracefully to the frontline-only view.
        if cur_r is not None:
            ep_prev = _f(cur_r, "prev_effective_case_price")
            ep_cur  = _f(cur_r, "effective_case_price")
        else:
            ep_prev = _f(next_r, "prev_effective_case_price")
            ep_cur  = _f(next_r, "prev_effective_case_price")
        if ep_prev is None: ep_prev = fp_prev
        if ep_cur  is None: ep_cur  = fp_cur
        ep_next = _f(next_r, "effective_case_price")
        if ep_next is None: ep_next = fp_next

        # `prev_case_price` / `case_price` / `next_case_price` are the headline
        # prices the UI displays — set them to the EFFECTIVE values, matching
        # the user's definition of "the price" (= list − discounts − best RIP).
        # Keep the frontline values under explicit frontline_* keys so the card
        # can show both side-by-side.
        row["prev_case_price"] = ep_prev
        row["case_price"]      = ep_cur
        row["next_case_price"] = ep_next
        row["frontline_prev_case_price"] = fp_prev
        row["frontline_case_price"]      = fp_cur
        row["frontline_next_case_price"] = fp_next

        def _delta(a, b):
            if a is None or b is None: return (None, None)
            d = b - a
            p = (d / a * 100.0) if a else None
            return (d, p)
        cur_delta,  cur_delta_pct  = _delta(ep_prev, ep_cur)
        next_delta, next_delta_pct = _delta(ep_cur,  ep_next)
        fl_cur_delta,  fl_cur_delta_pct  = _delta(fp_prev, fp_cur)
        fl_next_delta, fl_next_delta_pct = _delta(fp_cur,  fp_next)
        row["cur_delta"]      = cur_delta
        row["cur_delta_pct"]  = cur_delta_pct
        row["next_delta"]     = next_delta
        row["next_delta_pct"] = next_delta_pct
        row["frontline_cur_delta"]      = fl_cur_delta
        row["frontline_cur_delta_pct"]  = fl_cur_delta_pct
        row["frontline_next_delta"]     = fl_next_delta
        row["frontline_next_delta_pct"] = fl_next_delta_pct
        row["cur_match"]  = bool(cur_match)
        row["next_match"] = bool(next_match)

        # Headline = whichever direction-matching transition has the larger
        # |effective Δ%|. case_delta / case_delta_pct are overwritten so the
        # existing client-side sort + min-rise filter pick up the headlined
        # transition without changes.
        candidates = []
        if cur_match:
            candidates.append(("cur", cur_delta, cur_delta_pct))
        if next_match:
            candidates.append(("next", next_delta, next_delta_pct))
        candidates.sort(
            key=lambda c: (abs(c[2]) if c[2] is not None else (abs(c[1]) if c[1] is not None else -1.0)),
            reverse=True,
        )
        period, head_d, head_dp = candidates[0]
        row["headline_period"] = period
        row["case_delta"] = head_d
        row["case_delta_pct"] = head_dp

        # Legacy validity label (kept so older callers don't break).
        if cur_match and next_match:
            row["validity"] = "both"
        elif cur_match:
            row["validity"] = "current_only"
        else:
            row["validity"] = "next_only"

        cur_s, next_s = ed_by_ws.get(ws, (None, None))
        row["cur_edition"] = cur_s
        row["next_edition"] = next_s
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


# Short TTL cache for AI blurb maps. Pulled from Postgres on demand, kept for
# 60s in process so a busy page doesn't re-query PG on every card refresh.
import time as _time
_blurb_map_cache: dict = {}
_blurb_map_lock = _threading.Lock()

def _cached_mover_blurbs(direction: str) -> dict:
    key = f"mover_{direction}"
    now = _time.time()
    entry = _blurb_map_cache.get(key)
    if entry and entry["expires_at"] > now:
        return entry["map"]
    with _blurb_map_lock:
        entry = _blurb_map_cache.get(key)
        if entry and entry["expires_at"] > now:
            return entry["map"]
        m: dict = {}
        try:
            from backend.pg import get_pg
            with get_pg() as pg:
                cur = pg.execute(
                    "SELECT wholesaler, LTRIM(upc, '0') AS un, edition, blurb "
                    "FROM ai_mover_blurbs WHERE direction = %s",
                    (direction,),
                )
                for b in cur.fetchall():
                    m[(b["wholesaler"], b["un"], b["edition"])] = b["blurb"]
        except Exception:
            pass
        _blurb_map_cache[key] = {"map": m, "expires_at": now + 60}
        return m


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
        # New OR-membership filter: a row may be in BOTH 'current' and 'next'
        # buckets if it rose (or dropped) in both transitions, so the filter
        # tests the cur_match / next_match flags rather than the single-bucket
        # validity label.
        #   current / current_only → last→this matched the direction
        #   next    / next_only    → this→next matched the direction
        #   both / all (default)   → either is true (i.e., every row qualifies)
        v = (validity or "all").lower()
        if v in ("current", "current_only"):
            out = [r for r in out if r.get("cur_match")]
        elif v in ("next", "next_only"):
            out = [r for r in out if r.get("next_match")]
        # 'both', 'all', anything else → no further filter
        out = out[:limit]
        # AI blurbs come from a 60s-TTL cached PG read so a busy page does not
        # hammer Postgres on every request.
        blurb_map = _cached_mover_blurbs(direction)
        for row in out:
            u = (row.get("upc") or "")
            un = str(u).lstrip("0") if u else ""
            row["ai_blurb"] = blurb_map.get((row.get("wholesaler"), un, row.get("edition")))
        # Attach the Discount + RIP tier ladder for THIS month and next month
        # so the mover card's MonthEffectiveSparkline popover shows the full
        # ladder, matching the Catalog row's behaviour. Also flag wines with
        # multiple vintages so the card can wear a sticker.
        from backend.routers.catalog import attach_promotion_tiers, attach_vintages_available
        attach_promotion_tiers(con, out)
        attach_vintages_available(con, out)
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
