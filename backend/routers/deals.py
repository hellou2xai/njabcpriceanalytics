"""
Deals API. Discounts, clearance, combos, RIPs.

Covers: Â§7 Discount/Offer Views
"""

import math
import re
import threading
import time as _time

# Shared 60s in-process cache of the ai_deal_blurbs map so a busy Time-Sensitive
# Deals or Major Discounts page doesn't re-query Postgres on every request.
_deal_blurb_cache: dict = {"map": None, "expires_at": 0.0}
_deal_blurb_lock = threading.Lock()

def _cached_deal_blurbs() -> dict:
    now = _time.time()
    if _deal_blurb_cache["map"] is not None and _deal_blurb_cache["expires_at"] > now:
        return _deal_blurb_cache["map"]  # type: ignore
    with _deal_blurb_lock:
        if _deal_blurb_cache["map"] is not None and _deal_blurb_cache["expires_at"] > now:
            return _deal_blurb_cache["map"]  # type: ignore
        m: dict = {}
        try:
            from backend.pg import get_pg
            with get_pg() as pg:
                cur = pg.execute("SELECT wholesaler, LTRIM(upc, '0') AS un, edition, blurb FROM ai_deal_blurbs")
                for b in cur.fetchall():
                    m[(b["wholesaler"], b["un"], b["edition"])] = b["blurb"]
        except Exception:
            pass
        _deal_blurb_cache["map"] = m
        _deal_blurb_cache["expires_at"] = now + 60
        return m

from fastapi import APIRouter, Query
from typing import Optional

from backend.db import get_duckdb, read_parquet
from backend.rip_utils import is_bottle_unit, rip_per_case, rip_bundle_cost
from backend.enrichment_join import attach_enrichment_image


def _clean(rec: dict) -> dict:
    """Replace NaN with None and Timestamps with isoformat strings."""
    out = {}
    for k, v in rec.items():
        if isinstance(v, float) and math.isnan(v):
            out[k] = None
        elif hasattr(v, 'isoformat'):
            out[k] = v.isoformat() if v is not None else None
        else:
            out[k] = v
    return out

router = APIRouter(prefix="/api/deals", tags=["deals"])


@router.get("/discounts")
def get_top_discounts(
    wholesaler: Optional[str] = None,
    edition: Optional[str] = None,
    product_type: Optional[str] = None,
    min_discount_pct: float = Query(0, ge=0),
    sort: str = Query("total_savings_per_case", description="Sort by"),
    limit: int = Query(50, ge=1, le=1000),
    per_category: bool = Query(False, description="If true, return top `limit` per product category instead of overall"),
):
    """Discount ranker. §7.1.

    Baselines on the *current* edition (second-latest = this month) and looks up
    the *next* edition's effective price so each row can say whether it's cheaper
    now or next month, plus the savings source (CPL discount / RIP / closeout).
    """
    with get_duckdb() as con:
        src = read_parquet(con, "cpl_enriched")

        # current (this month) + next edition per wholesaler.
        eds_df = con.execute(f"SELECT DISTINCT wholesaler, edition FROM {src}").fetchdf()
        curr_map, next_map = {}, {}
        for ws, group in eds_df.groupby("wholesaler"):
            se = sorted(group["edition"].tolist(), reverse=True)
            next_map[ws] = se[0] if se else None
            curr_map[ws] = se[1] if len(se) > 1 else (se[0] if se else None)

        where = ["has_discount = true", "total_savings_per_case > 0"]
        params = {}

        if wholesaler:
            where.append("wholesaler = $wholesaler")
            params["wholesaler"] = wholesaler
        if edition:
            where.append("edition = $edition")
            params["edition"] = edition
        else:
            conds = []
            for i, (ws, ce) in enumerate(curr_map.items()):
                if (wholesaler and ws != wholesaler) or not ce:
                    continue
                conds.append(f"(wholesaler = $ws{i} AND edition = $ce{i})")
                params[f"ws{i}"], params[f"ce{i}"] = ws, ce
            if not conds:
                return []
            where.append("(" + " OR ".join(conds) + ")")
        if product_type:
            where.append("product_type = $product_type")
            params["product_type"] = product_type
        if min_discount_pct > 0:
            where.append("discount_pct >= $min_pct")
            params["min_pct"] = min_discount_pct

        allowed_sorts = {"total_savings_per_case", "discount_pct", "effective_case_price"}
        sort_col = sort if sort in allowed_sorts else "total_savings_per_case"

        w = " AND ".join(where)
        cols = """wholesaler, edition, upc, product_name, brand, product_type,
                   unit_volume, unit_qty, frontline_case_price, frontline_unit_price,
                   best_case_price, effective_case_price, discount_pct,
                   total_savings_per_case, rip_savings, has_rip, has_discount,
                   has_closeout, discount_1_qty, discount_1_amt"""
        if per_category:
            df = con.execute(f"""
                WITH ranked AS (
                    SELECT {cols},
                           ROW_NUMBER() OVER (
                               PARTITION BY product_type ORDER BY {sort_col} DESC
                           ) AS _rn
                    FROM {src}
                    WHERE {w}
                )
                SELECT {cols} FROM ranked
                WHERE _rn <= $limit
                ORDER BY {sort_col} DESC
            """, {**params, "limit": limit}).fetchdf()
        else:
            df = con.execute(f"""
                SELECT {cols}
                FROM {src}
                WHERE {w}
                ORDER BY {sort_col} DESC
                LIMIT $limit
            """, {**params, "limit": limit}).fetchdf()

        records = [_clean(r) for r in df.to_dict(orient="records")]

        # Next-month effective for the same SKU → "cheaper now or next?"
        next_eds = sorted({v for v in next_map.values() if v})
        upcs = sorted({str(r["upc"]) for r in records if r.get("upc")})
        next_lookup = {}
        if next_eds and upcs:
            uph = ", ".join(f"$u{i}" for i in range(len(upcs)))
            eph = ", ".join(f"$e{i}" for i in range(len(next_eds)))
            np = {f"u{i}": u for i, u in enumerate(upcs)}
            np.update({f"e{i}": e for i, e in enumerate(next_eds)})
            ndf = con.execute(f"""
                SELECT wholesaler, edition, upc, product_name, unit_volume,
                       effective_case_price
                FROM {src}
                WHERE upc IN ({uph}) AND edition IN ({eph})
            """, np).fetchdf()
            for _, nr in ndf.iterrows():
                key = (nr["wholesaler"], nr["edition"], str(nr["upc"]),
                       nr.get("product_name") or "", nr.get("unit_volume") or "")
                v = nr["effective_case_price"]
                next_lookup[key] = None if (v is None or (isinstance(v, float) and math.isnan(v))) else float(v)

        for r in records:
            ws = r["wholesaler"]
            ne_ed = next_map.get(ws)
            ce = r.get("effective_case_price")
            ne = next_lookup.get((ws, ne_ed, str(r.get("upc") or ""),
                                  r.get("product_name") or "", r.get("unit_volume") or "")) if ne_ed else None
            r["next_effective_case_price"] = ne
            if ne is None or ce is None:
                r["better_month"] = "This month"   # no next-month data → act now
            elif ne < ce - 0.01:
                r["better_month"] = "Next month"    # gets cheaper → wait
            elif ne > ce + 0.01:
                r["better_month"] = "This month"     # cheaper now → buy now
            else:
                r["better_month"] = "Same"
            # Savings source: where the discount comes from.
            src_parts = []
            if r.get("has_discount"):
                src_parts.append("CPL discount")
            if r.get("has_rip"):
                src_parts.append("RIP")
            if r.get("has_closeout"):
                src_parts.append("Closeout")
            r["discount_source"] = src_parts

        attach_enrichment_image(con, records)
        # AI deal blurbs from the 60s in-process cache (see _cached_deal_blurbs).
        blurb_map = _cached_deal_blurbs()
        for r in records:
            u = r.get("upc")
            un = str(u).lstrip("0") if u else ""
            r["ai_blurb"] = blurb_map.get((r.get("wholesaler"), un, r.get("edition")))
        return records


@router.get("/clearance")
def get_clearance_items(
    wholesaler: Optional[str] = None,
    edition: Optional[str] = None,
    limit: int = Query(50, ge=1, le=1000),
):
    """Clearance / closeout items. Â§7.2"""
    with get_duckdb() as con:
        src = read_parquet(con, "cpl_enriched")
        where = ["has_closeout = true"]
        params = {}

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
        df = con.execute(f"""
            SELECT wholesaler, edition, upc, product_name, product_type,
                   unit_volume, frontline_case_price, best_case_price,
                   effective_case_price, discount_pct, total_savings_per_case,
                   closeout_permit
            FROM {src}
            WHERE {w}
            ORDER BY discount_pct DESC
            LIMIT $limit
        """, {**params, "limit": limit}).fetchdf()
        records = [_clean(r) for r in df.to_dict(orient="records")]
        attach_enrichment_image(con, records)
        return records


@router.get("/combo-index")
def get_combo_index():
    """Index of products that belong to a combo bundle, keyed for the catalog
    to flag/link them. Returns one entry per (wholesaler, upc, combo_code) for
    the latest edition per wholesaler."""
    with get_duckdb() as con:
        src = read_parquet(con, "combo")
        eds = con.execute(f"SELECT wholesaler, MAX(edition) AS ed FROM {src} GROUP BY wholesaler").fetchdf()
        ed_map = dict(zip(eds["wholesaler"], eds["ed"]))
        if not ed_map:
            return {"items": []}
        params, pairs = {}, []
        for i, (w, e) in enumerate(ed_map.items()):
            params[f"w{i}"], params[f"e{i}"] = w, e
            pairs.append(f"(wholesaler = $w{i} AND edition = $e{i})")
        df = con.execute(f"""
            SELECT DISTINCT wholesaler, upc, combo_code, LTRIM(upc, '0') AS upc_norm
            FROM {src}
            WHERE ({' OR '.join(pairs)})
              AND upc IS NOT NULL AND upc != '' AND upc != '0'
        """, params).fetchdf()
        items = [
            {"wholesaler": r["wholesaler"], "upc": str(r["upc"]),
             "upc_norm": str(r["upc_norm"]), "combo_code": str(r["combo_code"])}
            for _, r in df.iterrows()
        ]
        return {"items": items}


@router.get("/combos")
def get_combos(
    wholesaler: Optional[str] = None,
    edition: Optional[str] = None,
    q: str = "",
    limit: int = Query(50, ge=1, le=100000),
):
    """Bundle/combo deals. ONE row per combo (components grouped). §7.3

    The source has one row per bundle component (and sometimes duplicate
    component rows), with combo_pack_price/total_savings constant per
    combo_code. We collapse to a single row per combo and expose the deduped
    component list so the UI shows one line per bundle.
    """
    with get_duckdb() as con:
        src = read_parquet(con, "combo")
        # cpl_enriched carries the real per-UPC product name. Fedway's combo
        # feed stores the brand_reg_no in product_name (numeric code) and the
        # from_date in comments, so without this join the bundle title and
        # component names both render as garbage. Other distributors also
        # benefit: their combo product_name is also a code in the source.
        cpl_src = read_parquet(con, "cpl_enriched")
        from datetime import date as _date
        from collections import defaultdict
        t = _date.today()
        current_ym = f"{t.year:04d}-{t.month:02d}"

        # Per-wholesaler current edition (latest <= this month, else newest) and
        # the next edition after it, so we can show this-vs-next-month outlook.
        ed_df = con.execute(f"SELECT DISTINCT wholesaler, edition FROM {src}").fetchdf()
        by_ws = defaultdict(list)
        for _, r in ed_df.iterrows():
            by_ws[r["wholesaler"]].append(r["edition"])
        cur_ed, nxt_ed = {}, {}
        for ws, elist in by_ws.items():
            elist = sorted(elist)
            if edition:
                curr = edition
            else:
                past = [e for e in elist if e <= current_ym]
                curr = past[-1] if past else elist[-1]
            after = [e for e in elist if e > curr]
            cur_ed[ws] = curr
            nxt_ed[ws] = after[0] if after else None

        target_ws = [wholesaler] if wholesaler else list(by_ws.keys())
        pairs = []
        for ws in target_ws:
            if ws not in cur_ed:
                continue
            pairs.append((ws, cur_ed[ws]))
            if nxt_ed.get(ws):
                pairs.append((ws, nxt_ed[ws]))
        if not pairs:
            return []

        params, clauses = {}, []
        for i, (ws, e) in enumerate(pairs):
            params[f"w{i}"], params[f"e{i}"] = ws, e
            clauses.append(f"(c.wholesaler = $w{i} AND c.edition = $e{i})")
        # COALESCE(cpl.product_name, c.product_name) overrides bogus combo
        # product_names (e.g. Fedway used to store codes here). Date-like
        # comments (e.g. '2026-06-01 00:00:00') get nulled so the title falls
        # back to "Combo {code}" via the application-side default below.
        #
        # The CPL is wrapped in a name-only CTE that DEDUPLICATES per
        # (wholesaler, edition, upc). Without this, placeholder upcs in the
        # CPL (notably upc='0', which Fedway has ~3,100 of per edition)
        # cartesian-multiply with combo rows that also carry placeholder
        # upcs, blowing the row count up to 40-166x. The SQL stays fast
        # either way, but pandas then has to iterate a 300k-row dataframe in
        # Python, which is the actual perceived slowness on this page.
        df = con.execute(f"""
            WITH cpl_names AS (
                SELECT wholesaler, edition, upc,
                       ANY_VALUE(NULLIF(product_name, '')) AS product_name
                FROM {cpl_src}
                WHERE upc IS NOT NULL AND CAST(upc AS VARCHAR) <> ''
                GROUP BY wholesaler, edition, upc
            )
            SELECT c.wholesaler, c.edition, c.combo_code, c.upc,
                   COALESCE(NULLIF(cpl.product_name, ''), c.product_name) AS product_name,
                   c.combo_pack_price, c.qty_per_pack, c.frontline_price_each,
                   c.combo_price_each, c.total_savings,
                   CASE WHEN try_cast(LEFT(c.comments, 10) AS DATE) IS NULL
                        THEN c.comments ELSE NULL END AS comments,
                   c.from_date, c.to_date
            FROM {src} c
            LEFT JOIN cpl_names cpl
              ON cpl.wholesaler = c.wholesaler
             AND cpl.edition = c.edition
             AND cpl.upc = c.upc
            WHERE {' OR '.join(clauses)}
            ORDER BY c.total_savings DESC NULLS LAST
        """, params).fetchdf()

        def _f(v):
            try:
                fv = float(v)
            except (TypeError, ValueError):
                return None
            return None if fv != fv else fv  # NaN

        def _s(v):
            if v is None or (isinstance(v, float) and v != v):
                return None
            s = str(v).strip()
            return s if s and s.lower() != "nan" else None

        # Group by (wholesaler, combo_code); split current vs next by edition.
        combos = {}
        for _, r in df.iterrows():
            ws = r["wholesaler"]
            code = _s(r.get("combo_code")) or ""
            ed = r["edition"]
            slot = "curr" if ed == cur_ed.get(ws) else ("next" if ed == nxt_ed.get(ws) else None)
            if slot is None:
                continue
            g = combos.get((ws, code))
            if g is None:
                g = {"comments": None, "curr": None, "next": None,
                     "comp_curr": [], "comp_next": [], "_sc": set(), "_sn": set()}
                combos[(ws, code)] = g
            if not g["comments"]:
                g["comments"] = _s(r.get("comments"))
            if g[slot] is None:
                g[slot] = {"combo_pack_price": _f(r.get("combo_pack_price")),
                           "total_savings": _f(r.get("total_savings")), "upc": _s(r.get("upc")),
                           "from_date": _s(r.get("from_date")), "to_date": _s(r.get("to_date"))}
            comp = {"product_name": _s(r.get("product_name")), "upc": _s(r.get("upc")),
                    "qty_per_pack": _s(r.get("qty_per_pack")),
                    "frontline_price_each": _f(r.get("frontline_price_each")),
                    "combo_price_each": _f(r.get("combo_price_each"))}
            sig = (comp["product_name"], comp["upc"], comp["qty_per_pack"],
                   comp["frontline_price_each"], comp["combo_price_each"])
            seen, bucket = (g["_sc"], g["comp_curr"]) if slot == "curr" else (g["_sn"], g["comp_next"])
            if sig not in seen:
                seen.add(sig)
                bucket.append(comp)

        from backend.search_aliases import expansion_for
        qtokens = [t for t in q.strip().lower().split() if t]
        items = []
        for (ws, code), g in combos.items():
            curr, nxt = g["curr"], g["next"]
            base = curr or nxt
            if base is None:
                continue
            comps = g["comp_curr"] if curr else g["comp_next"]
            savings, combo_price = base["total_savings"], base["combo_pack_price"]
            next_price = nxt["combo_pack_price"] if nxt else None
            next_savings = nxt["total_savings"] if nxt else None
            availability = "continues" if (curr and nxt) else ("ending" if curr else "new")
            cs, ns = savings or 0, next_savings or 0
            cp, npr = combo_price or 0, next_price or 0
            if availability == "ending":
                recommendation = "Buy now - ends this month"
            elif availability == "new":
                recommendation = "New next month"
            elif ns > cs + 0.01:
                recommendation = "Better deal next month"
            elif ns < cs - 0.01:
                recommendation = "Better deal now"
            elif npr > cp + 0.01:
                recommendation = "Price rises next month"
            elif npr < cp - 0.01:
                recommendation = "Price drops next month"
            else:
                recommendation = "Stable"
            comments = g["comments"]
            # When the source comments are empty or were dropped as garbage
            # (e.g. Fedway writes from_date into the Comments column), build the
            # bundle description from the components themselves. The pieces are
            # all present: qty_per_pack from the COMBO sheet + real product
            # names joined from cpl_enriched on UPC. Format follows the other
            # distributors' shape (qty x name / qty x name / ...).
            if not comments:
                parts = []
                for c in comps:
                    name = c.get("product_name")
                    if not name:
                        continue
                    qty = c.get("qty_per_pack")
                    parts.append(f"{qty} x {name}" if qty else name)
                if parts:
                    comments = " / ".join(parts)
            if qtokens:
                hay = " ".join([comments or "", code] + [c["product_name"] or "" for c in comps]).lower()
                if not all(any(cand in hay for cand in [tok, *(expansion_for(tok) or [])]) for tok in qtokens):
                    continue
            items.append({
                "wholesaler": ws, "combo_code": code, "comments": comments,
                "product_name": comments or f"Combo {code}", "upc": base.get("upc"),
                "combo_pack_price": combo_price, "total_savings": savings,
                "components": comps, "item_count": len(comps),
                "next_combo_pack_price": next_price, "next_total_savings": next_savings,
                "availability": availability, "recommendation": recommendation,
                "valid_from": base.get("from_date"), "valid_through": base.get("to_date"),
                "next_valid_from": nxt.get("from_date") if nxt else None,
                "next_valid_through": nxt.get("to_date") if nxt else None,
            })

        items.sort(key=lambda x: x["total_savings"] or 0, reverse=True)
        return items[:limit]


@router.get("/time-sensitive")
def time_sensitive(wholesaler: Optional[str] = None, include_past: bool = False, limit: int = Query(2000, ge=1, le=20000)):
    """Deals whose validity window is a SPECIFIC range inside the month (start
    is not the 1st or end is not the last day), still active (ends today or
    later), with days-to-expire. These are the urgent, easy-to-miss deals."""
    def _n(v):
        try:
            f = float(v)
        except (TypeError, ValueError):
            return None
        return None if f != f else f

    def _str(v):
        if v is None or (isinstance(v, float) and v != v):
            return None
        s = str(v).strip()
        return s or None

    with get_duckdb() as con:
        src = read_parquet(con, "cpl_enriched")
        from datetime import date as _date
        t = _date.today()
        current_ym = f"{t.year:04d}-{t.month:02d}"
        # Current edition AND the next edition per wholesaler, so dated deals
        # for next month surface too (gives the buyer time to prep).
        eds = con.execute(
            f"""SELECT wholesaler,
                       COALESCE(MAX(CASE WHEN edition <= $c THEN edition END), MAX(edition)) AS cur_ed,
                       MIN(CASE WHEN edition > $c THEN edition END) AS next_ed
                FROM {src} GROUP BY wholesaler""",
            {"c": current_ym},
        ).fetchdf()
        conds, params, idx = [], {}, 0
        for _, row in eds.iterrows():
            ws = row["wholesaler"]
            if wholesaler and ws != wholesaler:
                continue
            for ed in (row["cur_ed"], row["next_ed"]):
                if ed is None or (isinstance(ed, float) and ed != ed):
                    continue
                conds.append(f"(wholesaler = $w{idx} AND edition = $e{idx})")
                params[f"w{idx}"], params[f"e{idx}"] = ws, ed
                idx += 1
        if not conds:
            return []

        # Two ways a row qualifies as time-sensitive:
        #  (a) it has a specific from/to window that isn't the full calendar
        #      month (the original definition), OR
        #  (b) the CPL flags it as a CLOSEOUT — closeouts are inherently
        #      time-sensitive (inventory disappears once cleared) regardless
        #      of whether the sheet carries explicit dates for them.
        # Closeouts without a to_date stay in even when include_past=False.
        active_clause = (
            "" if include_past
            else "AND (to_date IS NULL OR CAST(to_date AS DATE) >= CURRENT_DATE)"
        )
        dated_window = (
            "from_date IS NOT NULL AND to_date IS NOT NULL "
            "AND NOT (EXTRACT(day FROM CAST(from_date AS DATE)) = 1 "
            "AND CAST(to_date AS DATE) = (date_trunc('month', CAST(to_date AS DATE)) + INTERVAL 1 MONTH - INTERVAL 1 DAY))"
        )
        rows = con.execute(f"""
            SELECT wholesaler, edition, product_name, product_type, unit_volume, unit_qty, upc, brand,
                   CAST(from_date AS DATE) AS from_date, CAST(to_date AS DATE) AS to_date,
                   CASE WHEN to_date IS NULL THEN NULL
                        ELSE date_diff('day', CURRENT_DATE, CAST(to_date AS DATE))
                   END AS days_to_expire,
                   frontline_case_price, effective_case_price, total_savings_per_case, discount_pct,
                   rip_savings, has_rip, has_discount, has_closeout
            FROM {src}
            WHERE (({dated_window}) OR has_closeout = true)
              {active_clause}
              AND ({' OR '.join(conds)})
            ORDER BY to_date ASC NULLS LAST, total_savings_per_case DESC NULLS LAST
            LIMIT {limit}
        """, params).fetchdf()

        # Exclude products whose RIP carries into next month: a deal is only
        # time-sensitive if it genuinely ends and does NOT recur next month.
        rip_next = set()
        try:
            nx = con.execute(f"""
                WITH nexted AS (SELECT wholesaler, MIN(CASE WHEN edition > $c THEN edition END) AS ned
                                FROM {src} GROUP BY wholesaler)
                SELECT DISTINCT e.wholesaler AS w, LTRIM(e.upc,'0') AS un
                FROM {src} e JOIN nexted n ON e.wholesaler = n.wholesaler AND e.edition = n.ned
                WHERE e.has_rip = true AND e.upc IS NOT NULL
            """, {"c": current_ym}).fetchall()
            rip_next = {(r[0], str(r[1])) for r in nx}
        except Exception:
            rip_next = set()

        # 60s in-process cached PG lookup (see _cached_deal_blurbs).
        blurb_map = _cached_deal_blurbs()

        out = []
        for _, r in rows.iterrows():
            u = _str(r["upc"])
            un = u.lstrip("0") if u else None
            # Closeouts skip the "RIP recurs next month" exclusion: inventory
            # being cleared is genuinely time-sensitive even when the SKU's
            # rebate happens to carry into the next CPL.
            if (not bool(r["has_closeout"])) and un and (r["wholesaler"], un) in rip_next:
                continue
            # Defensive guard: even if the SQL filter or a data quality issue lets
            # a stale-to_date row through, skip anything genuinely in the past
            # unless the caller explicitly asked for past deals.
            dte_raw = r["days_to_expire"]
            try:
                dte_int = int(dte_raw) if dte_raw == dte_raw and dte_raw is not None else None
            except (TypeError, ValueError):
                dte_int = None
            if not include_past and dte_int is not None and dte_int < 0:
                continue
            has_closeout = bool(r["has_closeout"])
            has_rip = bool(r["has_rip"])
            has_discount = bool(r["has_discount"])
            kinds = []
            if has_closeout: kinds.append("Closeout")
            if has_rip: kinds.append("RIP")
            if has_discount: kinds.append("Discount")
            dte = r["days_to_expire"]
            out.append({
                "wholesaler": r["wholesaler"],
                "product_name": r["product_name"],
                "product_type": _str(r["product_type"]),
                "unit_volume": _str(r["unit_volume"]),
                "unit_qty": _str(r["unit_qty"]),
                "upc": _str(r["upc"]),
                "brand": _str(r["brand"]),
                "from_date": str(r["from_date"])[:10] if r["from_date"] is not None else None,
                "to_date": str(r["to_date"])[:10] if r["to_date"] is not None else None,
                "days_to_expire": int(dte) if dte == dte else None,  # drop NaN
                "frontline_case_price": _n(r["frontline_case_price"]),
                "effective_case_price": _n(r["effective_case_price"]),
                "total_savings_per_case": _n(r["total_savings_per_case"]),
                "discount_pct": _n(r["discount_pct"]),
                "rip_savings": _n(r["rip_savings"]),
                "has_rip": has_rip,
                "has_discount": has_discount,
                "has_closeout": has_closeout,
                "deal_kind": " / ".join(kinds) or "Special price",
                "ai_blurb": blurb_map.get((r["wholesaler"], un or "", r["edition"])) if un else None,
            })

        # Add product images (Go-UPC enrichment) for the card view.
        attach_enrichment_image(con, out)
        return out


@router.get("/rips")
def get_active_rips(
    wholesaler: Optional[str] = None,
    edition: Optional[str] = None,
    q: str = "",
    limit: int = Query(50, ge=1, le=1000),
):
    """Active RIP promotions. Â§7.4"""
    with get_duckdb() as con:
        src = read_parquet(con, "rip")
        where = ["1=1"]
        params = {}

        if wholesaler:
            where.append("wholesaler = $wholesaler")
            params["wholesaler"] = wholesaler
        if edition:
            where.append("edition = $edition")
            params["edition"] = edition
        if q:
            where.append("UPPER(rip_description) LIKE UPPER($q)")
            params["q"] = f"%{q}%"

        w = " AND ".join(where)
        df = con.execute(f"""
            SELECT * FROM {src}
            WHERE {w}
            ORDER BY rip_amt_1 DESC NULLS LAST
            LIMIT $limit
        """, {**params, "limit": limit}).fetchdf()
        return [_clean(r) for r in df.to_dict(orient="records")]


_QTY_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(.*)$")


def _parse_disc_qty(s):
    """Parse '1 Cases', '5.0', '10 bottle' -> (qty:int, unit_label:str)."""
    if s is None:
        return None, None
    txt = str(s).strip()
    if not txt:
        return None, None
    m = _QTY_RE.match(txt)
    if not m:
        return None, None
    try:
        qty = int(float(m.group(1)))
    except (ValueError, TypeError):
        return None, None
    if qty <= 0:
        return None, None
    tail = (m.group(2) or "").lower().strip()
    if tail.startswith("bottle") or tail in ("b", "btl", "bottles"):
        unit = "Bottles"
    else:
        unit = "Cases"
    return qty, unit


def _extract_tiers(row):
    """Build [{qty, unit, amt}] from discount_1..5 columns of a CPL row."""
    import pandas as pd
    tiers = []
    for i in range(1, 6):
        amt = row.get(f"discount_{i}_amt")
        if amt is None or pd.isna(amt) or amt <= 0:
            continue
        qty, unit = _parse_disc_qty(row.get(f"discount_{i}_qty"))
        if qty is None:
            continue
        tiers.append({"qty": qty, "unit": unit, "amt": float(amt)})
    return tiers


def _norm_unit(u):
    """Normalise a unit label to 'case' | 'btl' (used by the RIP tier filters)."""
    if u is None:
        return ""
    s = str(u).lower().strip()
    if s in ("c", "case", "cases") or s.startswith("case"):
        return "case"
    if s in ("b", "btl", "bottle", "bottles") or s.startswith("btl") or s.startswith("bottle"):
        return "btl"
    return s


def _build_rip_items(con, wholesaler=None, product_type=None, q="", rip_code=None):
    """Products with incentives: DISCOUNT tiers (CPL) and RIP tiers (RIP sheet, by rip_code+upc), curr+next side by side."""
    import pandas as pd

    if True:
        src = read_parquet(con, "cpl_enriched")
        rip_src = read_parquet(con, "rip")

        # 1. Latest two editions per wholesaler
        eds_df = con.execute(f"SELECT DISTINCT wholesaler, edition FROM {src}").fetchdf()
        ed_map = {}
        for ws, group in eds_df.groupby("wholesaler"):
            sorted_eds = sorted(group["edition"].tolist(), reverse=True)
            next_ed = sorted_eds[0]
            curr_ed = sorted_eds[1] if len(sorted_eds) > 1 else None
            ed_map[ws] = (curr_ed, next_ed)

        if wholesaler and wholesaler not in ed_map:
            return {"total": 0, "limit": limit, "offset": offset, "items": []}

        target_pairs = []
        for ws, (curr_ed, next_ed) in ed_map.items():
            if wholesaler and ws != wholesaler:
                continue
            if curr_ed:
                target_pairs.append((ws, curr_ed))
            target_pairs.append((ws, next_ed))

        if not target_pairs:
            return {"total": 0, "limit": limit, "offset": offset, "items": []}

        params = {}
        for i, (ws, ed) in enumerate(target_pairs):
            params[f"ws_{i}"] = ws
            params[f"ed_{i}"] = ed
        ed_filter_inner = " OR ".join(
            f"(wholesaler = $ws_{i} AND edition = $ed_{i})"
            for i in range(len(target_pairs))
        )
        ed_filter_outer = " OR ".join(
            f"(c.wholesaler = $ws_{i} AND c.edition = $ed_{i})"
            for i in range(len(target_pairs))
        )

        extra = []
        if product_type:
            extra.append("c.product_type = $product_type")
            params["product_type"] = product_type
        if q:
            # Smart search: name/brand with shorthand aliases (JW -> Walker, etc.), OR RIP code.
            from backend.routers.catalog import _q_clause
            clause, qp, _ = _q_clause(q, name_col="c.product_name", brand_col="c.brand", upc_col="c.upc")
            params.update(qp)
            params["q_rip"] = f"%{q}%"
            extra.append(f"({clause} OR CAST(c.rip_code AS VARCHAR) LIKE $q_rip)")
        extra_sql = (" AND " + " AND ".join(extra)) if extra else ""

        # Restrict to a specific RIP number (matches products carrying that
        # rip_code in either targeted edition).
        rip_key_filter = ""
        if rip_code:
            rip_key_filter = " AND CAST(rip_code AS VARCHAR) LIKE $rip_code"
            params["rip_code"] = f"%{rip_code}%"

        # 2. Products with any incentive (discount tier OR has_rip) in curr or next
        products_df = con.execute(f"""
            WITH incentive_keys AS (
                SELECT DISTINCT wholesaler, upc
                FROM {src}
                WHERE ({ed_filter_inner})
                  AND (has_rip = true
                       OR discount_1_amt > 0 OR discount_2_amt > 0 OR discount_3_amt > 0
                       OR discount_4_amt > 0 OR discount_5_amt > 0)
                  {rip_key_filter}
            )
            SELECT c.wholesaler, c.edition, c.upc, c.product_name, c.product_type,
                   c.unit_qty, c.unit_volume,
                   c.frontline_case_price, c.frontline_unit_price,
                   c.best_case_price,
                   c.has_discount, c.discount_pct,
                   c.rip_code,
                   c.discount_1_qty, c.discount_1_amt,
                   c.discount_2_qty, c.discount_2_amt,
                   c.discount_3_qty, c.discount_3_amt,
                   c.discount_4_qty, c.discount_4_amt,
                   c.discount_5_qty, c.discount_5_amt
            FROM {src} c
            JOIN incentive_keys ik ON c.wholesaler = ik.wholesaler AND c.upc = ik.upc
            WHERE ({ed_filter_outer}){extra_sql}
        """, params).fetchdf()

        if products_df.empty:
            return {"total": 0, "limit": limit, "offset": offset, "items": []}

        # 3. RIP sheet lookup: (rip_code, wholesaler, edition, upc) -> deduped tier list
        rip_df = con.execute(f"""
            SELECT rip_code, wholesaler, edition, upc,
                   rip_unit_1, rip_qty_1, rip_amt_1,
                   rip_unit_2, rip_qty_2, rip_amt_2,
                   rip_unit_3, rip_qty_3, rip_amt_3,
                   rip_unit_4, rip_qty_4, rip_amt_4
            FROM {rip_src}
        """).fetchdf()

        def _norm_unit_key(u):
            if u is None:
                return ""
            s = str(u).lower().strip()
            if s in ("c", "case", "cases", "case(s)") or s.startswith("case"):
                return "case"
            if s in ("b", "btl", "bottle", "bottles") or s.startswith("btl") or s.startswith("bottle"):
                return "btl"
            return s

        rip_lookup = {}
        for _, r in rip_df.iterrows():
            tiers_here = []
            for i in range(1, 5):
                unit = r.get(f"rip_unit_{i}")
                qty = r.get(f"rip_qty_{i}")
                amt = r.get(f"rip_amt_{i}")
                if pd.notna(amt) and amt > 0 and pd.notna(qty) and qty > 0:
                    tiers_here.append({
                        "unit": unit if pd.notna(unit) else "Cases",
                        "qty": int(qty),
                        "amt": float(amt),
                    })
            if not tiers_here:
                continue
            key = (str(r["rip_code"]), r["wholesaler"], r["edition"], str(r.get("upc", "")))
            rip_lookup.setdefault(key, []).extend(tiers_here)

        # Dedupe each lookup entry by (norm_unit, qty, amt)
        for k, tlist in rip_lookup.items():
            seen = set()
            deduped = []
            for t in tlist:
                sig = (_norm_unit_key(t["unit"]), t["qty"], t["amt"])
                if sig in seen:
                    continue
                seen.add(sig)
                deduped.append(t)
            rip_lookup[k] = deduped

        # 4. Index by (wholesaler, upc) -> {curr, next, meta}; prefer next-edition metadata
        product_map = {}
        for _, p in products_df.iterrows():
            ws = p["wholesaler"]
            curr_ed, next_ed = ed_map[ws]
            if p["edition"] == curr_ed:
                slot = "curr"
            elif p["edition"] == next_ed:
                slot = "next"
            else:
                continue

            upc = str(p["upc"])
            key = (ws, upc)
            if key not in product_map:
                product_map[key] = {
                    "curr": None,
                    "next": None,
                    "meta": {
                        "wholesaler": ws, "upc": upc,
                        "product_name": p["product_name"],
                        "product_type": p["product_type"],
                        "unit_qty": p["unit_qty"],
                        "unit_volume": p["unit_volume"],
                        "curr_edition": curr_ed,
                        "next_edition": next_ed,
                    },
                }

            disc_tiers = [{**t, "source": "discount"} for t in _extract_tiers(p)]
            rip_code = str(p["rip_code"]) if pd.notna(p["rip_code"]) else None
            rip_tiers = []
            if rip_code and rip_code not in ("None", "nan", "0"):
                rk = (rip_code, ws, p["edition"], upc)
                rip_tiers = [{**t, "source": "rip"} for t in rip_lookup.get(rk, [])]

            product_map[key][slot] = {
                "case_price": float(p["frontline_case_price"]) if pd.notna(p["frontline_case_price"]) else None,
                "btl_price": float(p["frontline_unit_price"]) if pd.notna(p["frontline_unit_price"]) else None,
                "has_discount": bool(p["has_discount"]) if pd.notna(p["has_discount"]) else False,
                "discount_pct": float(p["discount_pct"]) if pd.notna(p["discount_pct"]) else 0.0,
                "rip_code": rip_code,
                "tiers": disc_tiers + rip_tiers,
            }

            if slot == "next":
                meta = product_map[key]["meta"]
                if pd.notna(p["product_name"]):
                    meta["product_name"] = p["product_name"]
                if pd.notna(p["product_type"]):
                    meta["product_type"] = p["product_type"]
                if pd.notna(p["unit_qty"]):
                    meta["unit_qty"] = p["unit_qty"]
                if pd.notna(p["unit_volume"]):
                    meta["unit_volume"] = p["unit_volume"]

        def _norm_unit(u):
            if u is None:
                return ""
            s = str(u).lower().strip()
            if s in ("c", "case", "cases") or s.startswith("case"):
                return "case"
            if s in ("b", "btl", "bottle", "bottles") or s.startswith("btl") or s.startswith("bottle"):
                return "btl"
            return s

        def _real_code(*codes):
            """First real (non-stub) RIP code, treating 0/None/blank as none."""
            for c in codes:
                if c is not None and str(c) not in ("0", "None", "nan", ""):
                    return str(c)
            return None

        def _calc(case_price, btl_price, unit_qty, qty, amt, unit, source):
            uq = 0
            try:
                if unit_qty is not None and not (isinstance(unit_qty, float) and math.isnan(unit_qty)):
                    uq = int(unit_qty)
            except (TypeError, ValueError):
                uq = 0
            if source == "discount":
                # CPL discount amount is already per case; qty is the threshold.
                save_per_case = round(amt, 2)
            else:
                # RIP rebate is a bundle total; per case = amt/qty, and a
                # bottle-unit tier is per-bottle so ×pack (uq) to reach per case.
                save_per_case = round(rip_per_case(amt, qty, unit, uq), 2)
            effective = round(case_price - save_per_case, 2) if case_price else None
            effective_btl = None
            if btl_price and btl_price > 0:
                effective_btl = round(btl_price - (save_per_case / uq if uq > 0 else 0), 2)
            gp_pct = round((save_per_case / case_price) * 100, 2) if case_price and case_price > 0 else 0
            return {
                "rip_amt": amt,
                "save_per_case": save_per_case,
                "effective_case_price": max(effective, 0) if effective is not None else None,
                "effective_btl_price": max(effective_btl, 0) if effective_btl is not None else None,
                "gp_pct": gp_pct,
            }

        # 6. Emit one row per (product+upc, tier): union of tier (unit, qty) across editions
        items = []
        for p in product_map.values():
            curr = p["curr"]
            nxt = p["next"]
            meta = p["meta"]
            ws = meta["wholesaler"]
            curr_ed, next_ed = ed_map[ws]

            curr_tiers = curr.get("tiers") if curr else []
            next_tiers = nxt.get("tiers") if nxt else []

            if not curr_tiers and not next_tiers:
                continue

            tier_pairs = {}
            for t in (curr_tiers or []):
                k = (t["source"], _norm_unit(t["unit"]), t["qty"])
                tier_pairs.setdefault(k, {"curr": None, "next": None, "unit": t["unit"], "qty": t["qty"], "source": t["source"]})
                tier_pairs[k]["curr"] = t
            for t in (next_tiers or []):
                k = (t["source"], _norm_unit(t["unit"]), t["qty"])
                if k not in tier_pairs:
                    tier_pairs[k] = {"curr": None, "next": None, "unit": t["unit"], "qty": t["qty"], "source": t["source"]}
                tier_pairs[k]["next"] = t

            # Stable order: discounts first, then RIPs; within each, by qty ascending
            ordered = sorted(
                tier_pairs.values(),
                key=lambda x: (0 if x["source"] == "discount" else 1, x["qty"]),
            )

            for tp in ordered:
                row = {
                    "wholesaler": ws,
                    "upc": meta["upc"],
                    "product_name": meta["product_name"],
                    "product_type": meta["product_type"],
                    "unit_qty": meta["unit_qty"],
                    "unit_volume": meta["unit_volume"],
                    "curr_edition": curr_ed,
                    "next_edition": next_ed,
                    "source": tp["source"],
                    "rip_unit": tp["unit"],
                    "rip_qty": tp["qty"],
                    "curr_case_price": (curr or {}).get("case_price"),
                    "curr_btl_price": (curr or {}).get("btl_price"),
                    "curr_has_discount": (curr or {}).get("has_discount", False),
                    "curr_discount_pct": (curr or {}).get("discount_pct", 0.0),
                    "curr_rip_code": (curr or {}).get("rip_code"),
                    "next_case_price": (nxt or {}).get("case_price"),
                    "next_btl_price": (nxt or {}).get("btl_price"),
                    "next_has_discount": (nxt or {}).get("has_discount", False),
                    "next_discount_pct": (nxt or {}).get("discount_pct", 0.0),
                    "next_rip_code": (nxt or {}).get("rip_code"),
                    # The real RIP number tied to this UPC's value (ignores the
                    # '0' stub a product carries in a month its RIP lapses).
                    "rip_number": _real_code((curr or {}).get("rip_code"), (nxt or {}).get("rip_code")),
                }

                if tp["curr"] and curr and curr.get("case_price") is not None:
                    c = _calc(curr["case_price"], curr["btl_price"], meta["unit_qty"], tp["curr"]["qty"], tp["curr"]["amt"], tp["unit"], tp["source"])
                    row["curr_rip_amt"] = c["rip_amt"]
                    row["curr_save_per_case"] = c["save_per_case"]
                    row["curr_effective_case_price"] = c["effective_case_price"]
                    row["curr_effective_btl_price"] = c["effective_btl_price"]
                    row["curr_gp_pct"] = c["gp_pct"]
                else:
                    row["curr_rip_amt"] = None
                    row["curr_save_per_case"] = None
                    row["curr_effective_case_price"] = None
                    row["curr_effective_btl_price"] = None
                    row["curr_gp_pct"] = None

                if tp["next"] and nxt and nxt.get("case_price") is not None:
                    n = _calc(nxt["case_price"], nxt["btl_price"], meta["unit_qty"], tp["next"]["qty"], tp["next"]["amt"], tp["unit"], tp["source"])
                    row["next_rip_amt"] = n["rip_amt"]
                    row["next_save_per_case"] = n["save_per_case"]
                    row["next_effective_case_price"] = n["effective_case_price"]
                    row["next_effective_btl_price"] = n["effective_btl_price"]
                    row["next_gp_pct"] = n["gp_pct"]
                else:
                    row["next_rip_amt"] = None
                    row["next_save_per_case"] = None
                    row["next_effective_case_price"] = None
                    row["next_effective_btl_price"] = None
                    row["next_gp_pct"] = None

                row["rip_save_per_case"] = max(row["curr_save_per_case"] or 0, row["next_save_per_case"] or 0)
                row["has_discount"] = bool(row["curr_has_discount"] or row["next_has_discount"])
                row["discount_pct"] = max(row["curr_discount_pct"] or 0, row["next_discount_pct"] or 0)
                row["needs_rep_verify"] = False

                items.append(row)

        # 7. RIP-sheet orphans: UPCs the RIP sheet ties to a rebate but that
        # didn't surface on the CPL-side query (the CPL row either doesn't
        # carry has_rip=true, or the product isn't on the CPL at all). Without
        # this, RIPs like 111202 show 4 products instead of 5. We emit a tier
        # row per orphan with no list price, a needs_rep_verify=True flag, and
        # whatever name/brand product_enrichment has for the UPC; the UI then
        # shows a "check with sales rep" sticker and still allows add-to-cart.
        target_pair_set = {(ws_, ed_) for ws_, ed_ in target_pairs}
        existing_pairs = {(it["wholesaler"], str(it.get("upc") or "").lstrip("0"))
                          for it in items}

        # Group orphans by (ws, upc, rip_code) across curr+next editions.
        # Keying by rip_code keeps separate orphan rows when one UPC belongs
        # to multiple RIP rebates; merging them would attribute all tiers to
        # whichever code came first.
        orphan_index: dict = {}
        _BAD_UPC = {"", "0", "none", "nan", "null"}
        for (rc, ws_, ed_, upc_), tiers in rip_lookup.items():
            if not tiers:
                continue
            if (ws_, ed_) not in target_pair_set:
                continue
            # Drop rip-sheet rows that don't have a real UPC. Some legacy rows
            # carry None/NaN/empty UPCs and would otherwise generate a giant
            # block of meaningless "Unknown product" orphans.
            upc_str = str(upc_)
            upc_norm = upc_str.lstrip("0")
            if upc_norm.lower() in _BAD_UPC:
                continue
            if not upc_norm.isdigit():
                continue
            # Same for the rip code itself: skip 0/None/blank stubs.
            rc_str = str(rc)
            if rc_str.lower() in _BAD_UPC:
                continue
            if (ws_, upc_norm) in existing_pairs:
                continue
            curr_ed_o, next_ed_o = ed_map.get(ws_, (None, None))
            if ed_ == curr_ed_o:
                slot = "curr"
            elif ed_ == next_ed_o:
                slot = "next"
            else:
                continue
            key = (ws_, upc_norm, rc_str)
            entry = orphan_index.setdefault(key, {
                "rip_code": rc_str, "raw_upc": upc_str,
                "curr_tiers": [], "next_tiers": [],
                "curr_ed": curr_ed_o, "next_ed": next_ed_o,
            })
            entry[f"{slot}_tiers"].extend({**t, "source": "rip"} for t in tiers)

        if orphan_index:
            # One-shot enrichment lookup for orphan names/brands. The
            # enrichment table is keyed by normalised UPC (leading zeros
            # stripped), same as how cpl_enriched joins it elsewhere.
            upcs_for_lookup = sorted({k[1] for k in orphan_index.keys()})
            enrich_map: dict = {}
            try:
                placeholders = ", ".join(f"$u_{i}" for i in range(len(upcs_for_lookup)))
                enrich_params = {f"u_{i}": u for i, u in enumerate(upcs_for_lookup)}
                enrich_df = con.execute(
                    f"SELECT upc, name, brand FROM product_enrichment WHERE upc IN ({placeholders})",
                    enrich_params,
                ).fetchdf()
                for _, er in enrich_df.iterrows():
                    enrich_map[str(er["upc"])] = (
                        er["name"] if pd.notna(er["name"]) else None,
                        er["brand"] if pd.notna(er["brand"]) else None,
                    )
            except Exception:
                # Enrichment table can be empty in parquet dev mode; that's fine.
                pass

            for (ws_, upc_norm, _rc), info in orphan_index.items():
                name, brand = enrich_map.get(upc_norm, (None, None))
                tier_pairs = {}
                for t in info["curr_tiers"]:
                    k = (_norm_unit(t["unit"]), t["qty"])
                    tier_pairs.setdefault(k, {"curr": None, "next": None,
                                              "unit": t["unit"], "qty": t["qty"]})
                    tier_pairs[k]["curr"] = t
                for t in info["next_tiers"]:
                    k = (_norm_unit(t["unit"]), t["qty"])
                    if k not in tier_pairs:
                        tier_pairs[k] = {"curr": None, "next": None,
                                         "unit": t["unit"], "qty": t["qty"]}
                    tier_pairs[k]["next"] = t
                ordered = sorted(tier_pairs.values(), key=lambda x: x["qty"])
                pretty_name = name or f"Unknown product (UPC {upc_norm})"
                for tp in ordered:
                    row = {
                        "wholesaler": ws_,
                        "upc": info["raw_upc"],
                        "brand": brand,
                        "product_name": pretty_name,
                        "product_type": None,
                        "unit_qty": None,
                        "unit_volume": None,
                        "curr_edition": info["curr_ed"],
                        "next_edition": info["next_ed"],
                        "source": "rip",
                        "rip_unit": tp["unit"],
                        "rip_qty": tp["qty"],
                        # No CPL price means no save/effective calculation.
                        "curr_case_price": None,
                        "curr_btl_price": None,
                        "curr_has_discount": False,
                        "curr_discount_pct": 0.0,
                        "curr_rip_code": info["rip_code"] if tp.get("curr") else None,
                        "next_case_price": None,
                        "next_btl_price": None,
                        "next_has_discount": False,
                        "next_discount_pct": 0.0,
                        "next_rip_code": info["rip_code"] if tp.get("next") else None,
                        "rip_number": info["rip_code"],
                        "curr_rip_amt": (tp.get("curr") or {}).get("amt"),
                        "curr_save_per_case": None,
                        "curr_effective_case_price": None,
                        "curr_effective_btl_price": None,
                        "curr_gp_pct": None,
                        "next_rip_amt": (tp.get("next") or {}).get("amt"),
                        "next_save_per_case": None,
                        "next_effective_case_price": None,
                        "next_effective_btl_price": None,
                        "next_gp_pct": None,
                        "rip_save_per_case": 0,
                        "has_discount": False,
                        "discount_pct": 0,
                        "needs_rep_verify": True,
                    }
                    items.append(row)

        return items


# In-memory cache of the full (unfiltered) RIP tier list. It only changes when the
# pricing cache is rebuilt, so we key it on the current cache file path and rebuild
# when that pointer moves (a data reload). Warmed at startup so the first page open
# is instant; a text search or a specific rip_code is always built fresh.
_rip_lock = threading.Lock()
_rip_cache: dict = {"token": None, "items": None}


def _rip_items_cached(con):
    from backend.pricing_cache import get_pricing_path
    token = str(get_pricing_path())
    if _rip_cache["token"] == token and _rip_cache["items"] is not None:
        return _rip_cache["items"]
    with _rip_lock:
        if _rip_cache["token"] == token and _rip_cache["items"] is not None:
            return _rip_cache["items"]
        items = _build_rip_items(con)
        _rip_cache["items"] = items
        _rip_cache["token"] = token
        return items


def warm_rip_cache():
    """Precompute the cached RIP tier list so the first RIP Products load is fast."""
    try:
        with get_duckdb() as con:
            _rip_items_cached(con)
    except Exception as e:
        print(f"[startup] RIP cache warm skipped: {e}")


@router.get("/rip-products")
def get_rip_products(
    wholesaler: Optional[str] = None,
    product_type: Optional[str] = None,
    q: str = "",
    rip_code: Optional[str] = None,
    min_savings: Optional[float] = None,
    min_gp: Optional[float] = None,
    tier_unit: Optional[str] = None,   # 'case' | 'btl'
    new_next: bool = False,
    source: Optional[str] = None,
    sort: str = Query("rip_save_per_case", description="Sort field"),
    order: str = Query("desc", description="asc or desc"),
    limit: int = Query(50, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    """Products with incentives: DISCOUNT tiers (CPL) and RIP tiers (RIP sheet, by
    rip_code+upc), current + next edition side by side.

    Every filter (q, rip_code, distributor, product_type, etc.) is applied
    in-memory against the pre-built tier list (see _rip_items_cached). The
    cache is built once per data load and reused; filtering ~50k tier rows
    in Python takes single-digit milliseconds, so every keystroke returns
    instantly instead of triggering a fresh DuckDB tier build.

    Two important rules:
      - Items without an associated RIP code are dropped here. This page is
        "Products with RIP", so a pure-discount row has no business on it.
      - Text search (q) checks product name, brand, UPC, and rip_number, so
        typing either a product name or a RIP code hits the same fast path."""
    with get_duckdb() as con:
        items = list(_rip_items_cached(con))

        # The RIP Products page only lists products with a real RIP code; pure
        # discount-only items (no rip_number) are filtered out here, not in the
        # UI, so pagination counts and the summary cards are accurate.
        items = [i for i in items if i.get("rip_number")]

        if wholesaler:
            items = [i for i in items if i.get("wholesaler") == wholesaler]
        if product_type:
            items = [i for i in items if i.get("product_type") == product_type]
        if rip_code:
            rc = str(rip_code).strip()
            items = [i for i in items if rc in str(i.get("rip_number") or "")]
        if q:
            # Tokenise the query so "sutter home" finds rows whose distributor
            # text is the abbreviation "SUTTER HM CAB" (literal-substring
            # search misses these because the user's words never appear
            # contiguously). Each token must hit somewhere across name /
            # brand / UPC / rip_number; short distributor abbreviations
            # (HM = Home, CH = Chardonnay etc.) are accepted as the
            # equivalent of the full word so a typed-in real name still
            # finds the abbreviated row.
            SHORT_FORMS = {
                "home": ["hm"],
                "homes": ["hm"],
                "chardonnay": ["ch", "chard"],
                "cabernet": ["cab"],
                "merlot": ["mer"],
                "moscato": ["mos"],
                "sauvignon": ["sauv"],
                "pinot": ["pin"],
                "reserve": ["res", "rsv"],
                "vineyards": ["vyd", "vnyd"],
                "vineyard": ["vyd", "vnyd"],
                "winery": ["wnry"],
            }
            tokens = [t for t in q.lower().split() if t]
            if tokens:
                def hits(it, tok):
                    hay = " ".join([
                        (it.get("product_name") or "").lower(),
                        (it.get("brand") or "").lower(),
                        str(it.get("upc") or "").lower(),
                        str(it.get("rip_number") or "").lower(),
                    ])
                    if tok in hay:
                        return True
                    for short in SHORT_FORMS.get(tok, ()):
                        if short in hay:
                            return True
                    return False
                items = [i for i in items if all(hits(i, t) for t in tokens)]

        if min_savings is not None:
            items = [i for i in items if (i["rip_save_per_case"] or 0) >= min_savings]

        if min_gp is not None:
            items = [i for i in items if max(i.get("curr_gp_pct") or 0, i.get("next_gp_pct") or 0) >= min_gp]

        if tier_unit in ("case", "btl"):
            items = [i for i in items if _norm_unit(i.get("rip_unit")) == tier_unit]

        if new_next:
            items = [i for i in items
                     if not (i.get("curr_save_per_case") or 0) and (i.get("next_save_per_case") or 0) > 0]

        if source in ("discount", "rip"):
            items = [i for i in items if i.get("source") == source]

        sort_map = {
            "rip_save_per_case": "rip_save_per_case",
            "rip_amt": "next_rip_amt",
            "rip_qty": "rip_qty",
            "frontline_case_price": "next_case_price",
            "effective_case_price": "next_effective_case_price",
            "gp_pct": "next_gp_pct",
            "discount_pct": "discount_pct",
            "product_name": "product_name",
            "curr_save_per_case": "curr_save_per_case",
            "next_save_per_case": "next_save_per_case",
            "curr_case_price": "curr_case_price",
            "next_case_price": "next_case_price",
            "curr_effective_case_price": "curr_effective_case_price",
            "next_effective_case_price": "next_effective_case_price",
        }
        sort_key = sort_map.get(sort, "rip_save_per_case")
        reverse = order.lower() != "asc"

        # Keep every tier row of a product together (the catalog-style grouped
        # view assumes adjacency). Order products by their best value for the
        # chosen metric; a product's leading sort keys are identical across its
        # rows, so they never scatter regardless of sort direction.
        src_rank = {"discount": 0, "rip": 1}

        def _row_metric(x):
            if sort_key == "product_name":
                return (x.get("product_name") or "").lower()
            v = x.get(sort_key)
            return v if v is not None else (float("-inf") if reverse else float("inf"))

        group_best: dict = {}
        for x in items:
            g = (x["wholesaler"], str(x["upc"]), str(x.get("unit_volume") or ""))
            m = _row_metric(x)
            if g not in group_best:
                group_best[g] = m
            elif sort_key == "product_name":
                group_best[g] = m  # same product name across its rows
            else:
                group_best[g] = max(group_best[g], m) if reverse else min(group_best[g], m)

        numeric_sort = sort_key != "product_name"

        def _key(x):
            g = (x["wholesaler"], str(x["upc"]), str(x.get("unit_volume") or ""))
            gm = group_best[g]
            # Bake direction into the group metric so within-group order stays
            # natural (discount first, then RIP tiers by ascending quantity).
            lead = (-gm if reverse else gm) if numeric_sort else gm
            return (lead, g[0], g[1], g[2], src_rank.get(x.get("source"), 2), x.get("rip_qty") or 0)

        if numeric_sort:
            items.sort(key=_key)
        else:
            items.sort(key=_key, reverse=reverse)

        total = len(items)
        page_items = items[offset:offset + limit]

        attach_enrichment_image(con, page_items)
        return {
            "total": total,
            "limit": limit,
            "offset": offset,
            "items": page_items,
        }
