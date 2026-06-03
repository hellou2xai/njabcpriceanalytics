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
from backend.enrichment_join import attach_enrichment_image, attach_sku_mapping


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
    limit: int = Query(50, ge=1, le=50000),
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
        # vintage is included so the next-month price lookup below can match
        # apple-to-apple: a 2019 wine listing in May must not silently pick
        # up the 2020 release's June price (different SKU, looks like a
        # huge swing).
        cols = """wholesaler, edition, upc, product_name, brand, product_type,
                   unit_volume, unit_qty, vintage, frontline_case_price, frontline_unit_price,
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
        # Same UPC is reused across different vintages (2019 vs 2020) AND
        # different pack sizes (12-pack vs 6-pack), so the lookup key
        # carries BOTH normalised vintage and unit_qty. Without them, a
        # wine row's "next month price" silently picks up a different
        # SKU and better_month / next sparkline turn into nonsense (see
        # DE TOREN FUSION V: UPC 816053000375 = 12-pack 2019 + 6-pack 2020).
        from backend.routers.catalog import _vintage_norm_sql, _norm_vintage, _uq_key
        next_eds = sorted({v for v in next_map.values() if v})
        upcs = sorted({str(r["upc"]) for r in records if r.get("upc")})
        next_lookup = {}
        if next_eds and upcs:
            uph = ", ".join(f"$u{i}" for i in range(len(upcs)))
            eph = ", ".join(f"$e{i}" for i in range(len(next_eds)))
            np = {f"u{i}": u for i, u in enumerate(upcs)}
            np.update({f"e{i}": e for i, e in enumerate(next_eds)})
            vn = _vintage_norm_sql("vintage")
            ndf = con.execute(f"""
                SELECT wholesaler, edition, upc, product_name, unit_volume,
                       unit_qty,
                       {vn} AS vintage_norm,
                       effective_case_price
                FROM {src}
                WHERE upc IN ({uph}) AND edition IN ({eph})
            """, np).fetchdf()
            for _, nr in ndf.iterrows():
                vn_v = nr.get("vintage_norm")
                if vn_v is not None and isinstance(vn_v, float) and math.isnan(vn_v):
                    vn_v = None
                key = (nr["wholesaler"], nr["edition"], str(nr["upc"]),
                       nr.get("product_name") or "", nr.get("unit_volume") or "",
                       _uq_key(nr.get("unit_qty")),
                       str(vn_v) if vn_v is not None else "")
                v = nr["effective_case_price"]
                next_lookup[key] = None if (v is None or (isinstance(v, float) and math.isnan(v))) else float(v)

        for r in records:
            ws = r["wholesaler"]
            ne_ed = next_map.get(ws)
            ce = r.get("effective_case_price")
            r_vn = _norm_vintage(r.get("vintage"))
            ne = next_lookup.get((ws, ne_ed, str(r.get("upc") or ""),
                                  r.get("product_name") or "", r.get("unit_volume") or "",
                                  _uq_key(r.get("unit_qty")),
                                  r_vn or "")) if ne_ed else None
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
        attach_sku_mapping(con, records)
        # AI deal blurbs from the 60s in-process cache (see _cached_deal_blurbs).
        blurb_map = _cached_deal_blurbs()
        for r in records:
            u = r.get("upc")
            un = str(u).lstrip("0") if u else ""
            r["ai_blurb"] = blurb_map.get((r.get("wholesaler"), un, r.get("edition")))
        # Attach the Discount + RIP tier ladder for THIS month and next month,
        # so the card's MonthEffectiveSparkline popover shows the full ladder,
        # plus the list of distinct vintages so wines can wear a "Multiple
        # vintages" sticker.
        from backend.routers.catalog import attach_promotion_tiers, attach_vintages_available
        attach_promotion_tiers(con, records)
        attach_vintages_available(con, records)
        return records


@router.get("/clearance")
def get_clearance_items(
    wholesaler: Optional[str] = None,
    edition: Optional[str] = None,
    limit: int = Query(50, ge=1, le=50000),
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
        attach_sku_mapping(con, records)
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


def _window_is_time_sensitive(frm, to) -> bool:
    """Same rule as a time-sensitive CPL line: the validity window is a SPECIFIC
    range, not the whole calendar month (1st → last day). Used for combos too so
    a dated combo promo is classified the same way a dated CPL deal is."""
    import calendar as _cal
    from datetime import date as _d

    def _p(s):
        if not s:
            return None
        try:
            return _d.fromisoformat(str(s)[:10])
        except (TypeError, ValueError):
            return None
    f, t = _p(frm), _p(to)
    if not f or not t:
        return False
    last = _cal.monthrange(t.year, t.month)[1]
    return not (f.day == 1 and t.day == last)


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
        from collections import defaultdict
        from backend import pricing as _pricing
        current_ym = _pricing.current_yyyy_mm()

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
                # comp_curr/comp_next are dicts keyed by UPC so a component is
                # collapsed to ONE row per UPC. Variety packs (e.g. Opici Mom
                # Water) list the SAME pack UPC once per flavor — often with a
                # $0 duplicate half — which previously showed as several rows.
                g = {"comments": None, "curr": None, "next": None,
                     "comp_curr": {}, "comp_next": {}}
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
            # Key by UPC (the reliable identifier — every combo row has one); fall
            # back to a sig only when a row lacks a UPC. On a UPC clash keep the
            # row with the higher combo_price_each so the $0 duplicate halves drop.
            key = comp["upc"] or ("_noupc", comp["product_name"], comp["qty_per_pack"],
                                  comp["combo_price_each"])
            bucket = g["comp_curr"] if slot == "curr" else g["comp_next"]
            prev = bucket.get(key)
            if prev is None or (comp["combo_price_each"] or 0) > (prev["combo_price_each"] or 0):
                bucket[key] = comp

        from backend.search_aliases import expansion_for
        qtokens = [t for t in q.strip().lower().split() if t]
        items = []
        for (ws, code), g in combos.items():
            curr, nxt = g["curr"], g["next"]
            base = curr or nxt
            if base is None:
                continue
            comps = list((g["comp_curr"] if curr else g["comp_next"]).values())
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
                # A combo on a SPECIFIC date window (not the whole month) is
                # time-sensitive, same rule as CPL lines.
                "time_sensitive": _window_is_time_sensitive(base.get("from_date"), base.get("to_date")),
            })

        items.sort(key=lambda x: x["total_savings"] or 0, reverse=True)
        items = items[:limit]
        # Attach the worth-it economics (combo vs individual LIST vs ONE-CASE
        # price, by UPC) so BOTH the combo page and the AI assistant read the
        # same numbers from one implementation.
        try:
            compute_combo_economics(con, items)
        except Exception:
            pass  # never fail the listing over the analysis
        # Allied (ABG) SKU per component, shown next to its UPC. Components don't
        # carry their own wholesaler, so borrow the parent combo's for the gate.
        flat_comps = []
        for it in items:
            for c in it.get("components", []):
                c["wholesaler"] = it.get("wholesaler")
                flat_comps.append(c)
        attach_sku_mapping(con, flat_comps)
        return items


def _combo_qty_bottles(qty_per_pack, bottles_per_case):
    """(cases, bottles) a combo requires of a component. '3   C' -> 3 cases;
    '24 bottle' / bare '48' -> bottles (cases derived via bottles-per-case)."""
    s = str(qty_per_pack or "").strip().lower()
    m = re.match(r"(\d+(?:\.\d+)?)", s)
    if not m:
        return (None, None)
    n = float(m.group(1))
    rest = s[m.end():].strip()
    bpc = bottles_per_case if (bottles_per_case and bottles_per_case > 0) else None
    if "c" in rest:   # case / cs / c
        return (n, (n * bpc) if bpc else None)
    return ((n / bpc) if bpc else None, n)


def _combo_one_case_disc(qa_pairs):
    """Best 'buy ONE case' CPL discount amount from (qty_label, amt) pairs: the
    qty label's leading integer must be 1 and it must not be a bottle tier."""
    for raw_q, raw_a in qa_pairs:
        if raw_q is None:
            continue
        label = str(raw_q).strip().lower()
        if "btl" in label or "bottle" in label:
            continue
        m = re.match(r"\s*(\d+)", label)
        if not m or int(m.group(1)) != 1:
            continue
        try:
            amt = float(raw_a) if raw_a is not None else None
            if amt is not None and amt == amt and amt > 0:
                return amt
        except Exception:
            pass
    return None


def compute_combo_economics(con, combos, cym=None):
    """Attach an ``economics`` dict to each combo: combo pack price vs (a) the
    individual LIST price and (b) the realistic ONE-CASE price (list - 1-case
    discount), priced BY UPC from the catalog and summed per combo. The pricing
    unit (per bottle vs per case) is detected by reconciling to the pack price.
    Bulk-RIP max prices are deliberately ignored (an unreachable 'trap'). Shared
    by the combo page and the assistant's combo_analyzer so both agree."""
    from backend import pricing as _pricing
    cym = cym or _pricing.current_yyyy_mm()

    def _ff(v):
        try:
            f = float(v)
            return None if f != f else f
        except (TypeError, ValueError):
            return None

    keys = sorted({(c.get("wholesaler"), str(comp.get("upc") or "").lstrip("0"))
                   for c in combos for comp in (c.get("components") or [])
                   if c.get("wholesaler") and str(comp.get("upc") or "").lstrip("0")})
    info: dict = {}
    if keys:
        src = read_parquet(con, "cpl_enriched")
        ph = ", ".join(f"($w{i}, $u{i})" for i in range(len(keys)))
        kp: dict = {}
        for i, (w, u) in enumerate(keys):
            kp[f"w{i}"], kp[f"u{i}"] = w, u
        try:
            # One UPC can map to SEVERAL catalog rows — the individual SKU AND a
            # bundle (e.g. Angeline '...VCOMBO', unit_qty 240, alongside the real
            # 750ML 12-pack). Aggregating across them mixes a bundle's pack size
            # with another row's price. So pick ONE coherent row per UPC: prefer a
            # NON-bundle product with a sane case (2–120 bottles), all fields from
            # that single row. Pack-price reconciliation downstream validates it.
            df = con.execute(
                f"WITH cur AS (SELECT wholesaler, MAX(edition) ed FROM {src} WHERE edition<='{cym}' GROUP BY wholesaler), "
                "ranked AS ( "
                "  SELECT c.wholesaler ws, LTRIM(CAST(c.upc AS VARCHAR),'0') un, "
                "         c.product_name, c.unit_volume, c.unit_qty, c.vintage, c.frontline_case_price fcase, "
                "         c.discount_1_qty d1q, c.discount_1_amt d1a, c.discount_2_qty d2q, c.discount_2_amt d2a, "
                "         c.discount_3_qty d3q, c.discount_3_amt d3a, c.discount_4_qty d4q, c.discount_4_amt d4a, "
                "         c.discount_5_qty d5q, c.discount_5_amt d5a, "
                "         ROW_NUMBER() OVER ( "
                "           PARTITION BY c.wholesaler, LTRIM(CAST(c.upc AS VARCHAR),'0') "
                "           ORDER BY "
                "             CASE WHEN COALESCE(TRY_CAST(c.unit_qty AS DOUBLE),0) > 120 "
                "                    OR UPPER(COALESCE(c.product_name,'')) LIKE '%VCOMBO%' "
                "                    OR UPPER(COALESCE(c.product_name,'')) LIKE '%VARIETY%' "
                "                    OR UPPER(COALESCE(c.product_name,'')) LIKE '%COMBO%' THEN 1 ELSE 0 END ASC, "
                "             CASE WHEN TRY_CAST(c.unit_qty AS DOUBLE) BETWEEN 2 AND 120 THEN 0 ELSE 1 END ASC, "
                # Same UPC often spans VINTAGES (the barcode is reused year to year) —
                # prefer the LATEST vintage, the one a combo almost always features.
                # (If a vintage also differs in pack size, pack-price reconciliation
                # downstream still self-corrects: a wrong pick just won't reconcile.)
                "             TRY_CAST(c.vintage AS INTEGER) DESC NULLS LAST, "
                "             TRY_CAST(c.unit_qty AS DOUBLE) DESC NULLS LAST, "
                "             c.frontline_case_price ASC NULLS LAST "
                "         ) rn "
                f"  FROM {src} c JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed "
                f"  WHERE (c.wholesaler, LTRIM(CAST(c.upc AS VARCHAR),'0')) IN ({ph}) "
                ") "
                "SELECT * FROM ranked WHERE rn = 1", kp).fetchdf()
            for _, r in df.iterrows():
                d = r.to_dict()
                d["one_case_disc"] = _combo_one_case_disc([
                    (d.get("d1q"), d.get("d1a")), (d.get("d2q"), d.get("d2a")),
                    (d.get("d3q"), d.get("d3a")), (d.get("d4q"), d.get("d4a")),
                    (d.get("d5q"), d.get("d5a")),
                ]) or 0.0
                info[(r["ws"], r["un"])] = d
        except Exception:
            pass

    for c in combos:
        ws = c.get("wholesaler")
        pack = _ff(c.get("combo_pack_price"))
        rc = []
        for comp in c.get("components") or []:
            un = str(comp.get("upc") or "").lstrip("0")
            if not un:
                continue
            meta = info.get((ws, un), {})
            bpc = _ff(meta.get("unit_qty"))
            cases, bottles = _combo_qty_bottles(comp.get("qty_per_pack"), bpc)
            cases_req = cases if cases is not None else ((bottles / bpc) if (bottles and bpc) else None)
            fcase = _ff(meta.get("fcase"))
            one_disc = _ff(meta.get("one_case_disc")) or 0.0
            _vint = meta.get("vintage")
            _vint = str(_vint).strip() if _vint is not None and str(_vint).strip() not in ("", "0", "None", "nan") else None
            rc.append({
                "un": un, "name": (meta.get("product_name") or comp.get("product_name")),
                "unit_volume": meta.get("unit_volume") or comp.get("unit_volume"), "vintage": _vint,
                "bpc": bpc, "fcase": fcase, "one_disc": one_disc,
                "sep_case": (fcase - one_disc) if fcase is not None else None,
                "ce": _ff(comp.get("combo_price_each")), "cases_req": cases_req,
            })

        def _tot(unit):
            s = 0.0
            for r in rc:
                if r["ce"] is None or r["cases_req"] is None:
                    return None
                if unit == "bottle":
                    if not r["bpc"]:
                        return None
                    s += r["ce"] * r["cases_req"] * r["bpc"]
                else:
                    s += r["ce"] * r["cases_req"]
            return s
        tb, tc = _tot("bottle"), _tot("case")
        unit = None
        if pack and pack > 0:
            eb = abs(tb - pack) / pack if tb is not None else 9.0
            ec = abs(tc - pack) / pack if tc is not None else 9.0
            if min(eb, ec) <= 0.05:
                unit = "bottle" if eb <= ec else "case"

        comps_out, sep_total, front_total, missing = [], 0.0, 0.0, False
        combo_clean = bool(rc) and unit is not None
        for r in rc:
            bpc, fcase, sep_case, one_disc, ce, cases_req = (
                r["bpc"], r["fcase"], r["sep_case"], r["one_disc"], r["ce"], r["cases_req"])
            suspect = bool(bpc and bpc > 120)
            scost = (sep_case * cases_req) if (sep_case is not None and cases_req is not None and not suspect) else None
            fcost = (fcase * cases_req) if (fcase is not None and cases_req is not None and not suspect) else None
            if unit == "bottle":
                sep_each = (sep_case / bpc) if (sep_case is not None and bpc) else None
                ccost = (ce * cases_req * bpc) if (ce is not None and cases_req is not None and bpc) else None
            elif unit == "case":
                sep_each = sep_case
                ccost = (ce * cases_req) if (ce is not None and cases_req is not None) else None
            else:
                sep_each = ccost = None
            sep_total += scost or 0.0
            front_total += fcost or 0.0
            if not (sep_case is not None and cases_req is not None and not suspect and ce and ce > 0):
                missing = True
                combo_clean = False
            comps_out.append({
                "product_name": r["name"], "upc": r["un"], "unit_volume": r["unit_volume"],
                "vintage": r["vintage"],
                "bottles_per_case": bpc, "cases": cases_req, "price_unit": unit,
                "combo_each": ce, "best_separate_each": sep_each,
                "has_separate_deal": bool(one_disc and one_disc > 0),
                "combo_cost": ccost, "best_separate_cost": scost, "frontline_cost": fcost,
            })
        sep_t = sep_total or None
        save_vs_sep = (sep_t - pack) if (sep_t is not None and pack is not None) else None
        save_vs_front = (front_total - pack) if (front_total and pack is not None) else None
        pct_sep = (save_vs_sep / sep_t * 100) if (save_vs_sep is not None and sep_t) else None
        if not combo_clean or save_vs_sep is None:
            verdict = "unknown"
            save_vs_sep = pct_sep = None
        elif pct_sep >= 3:
            verdict = "worth_it"
        elif pct_sep <= -3:
            verdict = "buy_separately"
        else:
            verdict = "marginal"
        # Component coverage + a plain-English reason when we can't verify — the
        # remaining unverifiable combos are genuine SOURCE gaps (a component with
        # no UPC in the combo feed, a $0 feed price, or a variety pack whose
        # per-unit prices don't reconcile). brand_reg_no can't recover the missing
        # UPCs: it matches the catalog only ~47% of the time across feeds, so
        # using it would attach wrong prices. We report the gap instead of guessing.
        total_comp = len(c.get("components") or [])
        priced = sum(1 for co in comps_out
                     if co.get("combo_cost") is not None and co.get("best_separate_cost") is not None)
        missing_upc = total_comp - len(rc)
        reason = None
        if verdict == "unknown":
            if missing_upc > 0:
                reason = f"{missing_upc} of {total_comp} items carry no UPC in the combo feed"
            elif any(not co.get("combo_each") for co in comps_out):
                reason = "a component is priced $0 in the feed"
            elif unit is None:
                reason = "per-unit prices don't reconcile to the pack (likely a variety/special pack)"
            else:
                reason = "a component isn't on the current price sheet"
        # ADVERTISED savings = what the source/distributor claims (total_savings,
        # computed off the combo feed's own frontline). Kept alongside our
        # EFFECTIVE savings (vs the realistic one-case price) so the buyer sees
        # advertised-vs-effective — the advertised number is often inflated.
        advertised = _ff(c.get("total_savings"))
        c["economics"] = {
            "combo_code": str(c.get("combo_code")), "wholesaler": ws,
            "contents": (c.get("comments") or c.get("product_name")),
            "unit": unit,
            "combo_cost": round(pack, 2) if pack is not None else None,
            "advertised_savings": round(advertised, 2) if advertised is not None else None,
            "separate_best_total": round(sep_t, 2) if sep_t is not None else None,
            "frontline_total": round(front_total, 2) if front_total else None,
            "save_vs_separate": round(save_vs_sep, 2) if save_vs_sep is not None else None,
            "save_vs_frontline": round(save_vs_front, 2) if save_vs_front is not None else None,
            "pct_vs_separate": round(pct_sep, 1) if pct_sep is not None else None,
            "verdict": verdict, "any_component_missing_price": missing,
            "components_total": total_comp, "components_priced": priced,
            "unverified_reason": reason,
            "components": comps_out,
        }
    return combos


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
        from backend import pricing as _pricing
        current_ym = _pricing.current_yyyy_mm()
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

        # A CPL line is TIME-SENSITIVE when its validity window (From/To dates)
        # is a SPECIFIC range — i.e. it does NOT run the whole calendar month
        # (1st → last day). Full-month rows are the regular monthly pricing.
        #
        # CRUCIAL: the dated promo windows live as SEPARATE rows in the RAW cpl
        # (a product carries a full-month row AND, when it's on a dated deal, a
        # sub-month row). The enriched cache dedupes those to one row per UPC and
        # keeps the full-month one — which is why reading cpl_enriched here lost
        # ~50+ dated Fedway deals/month. So we read the RAW cpl, take every
        # sub-month line, and compute the deal price from frontline vs best.
        craw = read_parquet(con, "cpl")
        active_clause = (
            "" if include_past
            else "AND (to_date IS NULL OR CAST(to_date AS DATE) >= CURRENT_DATE)"
        )
        rows = con.execute(f"""
            WITH ce AS (   -- brand only lives on the enriched table
                SELECT wholesaler, edition, CAST(upc AS VARCHAR) AS upc, ANY_VALUE(brand) AS brand
                FROM {src} GROUP BY 1, 2, 3
            ),
            ranked AS (
                SELECT wholesaler, edition, product_name, product_type, unit_volume, unit_qty,
                       CAST(upc AS VARCHAR) AS upc, vintage,
                       CAST(from_date AS DATE) AS from_date, CAST(to_date AS DATE) AS to_date,
                       frontline_case_price,
                       COALESCE(best_case_price, frontline_case_price) AS effective_case_price,
                       rip_code, closeout_permit,
                       ROW_NUMBER() OVER (
                           -- product_name is in the key so placeholder upcs
                           -- (Fedway has upc='0' rows) don't collapse distinct
                           -- products that share the same window.
                           PARTITION BY wholesaler, edition, CAST(upc AS VARCHAR), product_name,
                                        CAST(from_date AS DATE), CAST(to_date AS DATE)
                           ORDER BY COALESCE(best_case_price, frontline_case_price) ASC NULLS LAST
                       ) AS rn
                FROM {craw}
                WHERE from_date IS NOT NULL AND to_date IS NOT NULL
                  AND NOT (EXTRACT(day FROM CAST(from_date AS DATE)) = 1
                           AND CAST(to_date AS DATE) = (date_trunc('month', CAST(to_date AS DATE)) + INTERVAL 1 MONTH - INTERVAL 1 DAY))
                  {active_clause}
                  AND ({' OR '.join(conds)})
            )
            SELECT r.wholesaler, r.edition, r.product_name, r.product_type, r.unit_volume, r.unit_qty,
                   r.upc, ce.brand AS brand, r.vintage, r.from_date, r.to_date,
                   CASE WHEN r.to_date IS NULL THEN NULL
                        ELSE date_diff('day', CURRENT_DATE, r.to_date) END AS days_to_expire,
                   r.frontline_case_price, r.effective_case_price,
                   CASE WHEN r.frontline_case_price IS NOT NULL AND r.effective_case_price IS NOT NULL
                             AND r.frontline_case_price > r.effective_case_price
                        THEN r.frontline_case_price - r.effective_case_price ELSE NULL END AS total_savings_per_case,
                   CASE WHEN r.frontline_case_price IS NOT NULL AND r.effective_case_price IS NOT NULL
                             AND r.frontline_case_price > 0 AND r.frontline_case_price > r.effective_case_price
                        THEN ROUND((r.frontline_case_price - r.effective_case_price) / r.frontline_case_price * 100, 2)
                        ELSE NULL END AS discount_pct,
                   CAST(NULL AS DOUBLE) AS rip_savings,
                   (r.rip_code IS NOT NULL AND CAST(r.rip_code AS VARCHAR) NOT IN ('', '0', 'None', 'nan')) AS has_rip,
                   (r.effective_case_price IS NOT NULL AND r.frontline_case_price IS NOT NULL
                        AND r.frontline_case_price > r.effective_case_price) AS has_discount,
                   (r.closeout_permit IS NOT NULL AND CAST(r.closeout_permit AS VARCHAR) NOT IN ('', '0', 'None', 'nan')) AS has_closeout
            FROM ranked r LEFT JOIN ce
              ON ce.wholesaler = r.wholesaler AND ce.edition = r.edition AND ce.upc = r.upc
            WHERE r.rn = 1
            ORDER BY r.to_date ASC NULLS LAST, total_savings_per_case DESC NULLS LAST
            LIMIT {limit}
        """, params).fetchdf()

        # 60s in-process cached PG lookup (see _cached_deal_blurbs).
        blurb_map = _cached_deal_blurbs()

        out = []
        for _, r in rows.iterrows():
            u = _str(r["upc"])
            un = u.lstrip("0") if u else None
            # Defensive guard: even if a data quality issue lets a stale-to_date
            # row through, skip anything genuinely in the past unless the caller
            # explicitly asked for past deals.
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
                # Edition kept on the output so attach_promotion_tiers can
                # look the row up in cpl_enriched for the CPL discount + RIP
                # columns (it isn't surfaced on the card UI).
                "edition": r["edition"],
                "product_name": r["product_name"],
                "product_type": _str(r["product_type"]),
                "unit_volume": _str(r["unit_volume"]),
                "unit_qty": _str(r["unit_qty"]),
                "upc": _str(r["upc"]),
                "brand": _str(r["brand"]),
                # Vintage is surfaced on the card so the buyer can tell which
                # vintage of a multi-vintage SKU the row refers to. Same UPC
                # is reused across vintages and pack sizes.
                "vintage": _str(r["vintage"]),
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
        attach_sku_mapping(con, out)
        # Attach the full Discount + RIP tier ladder for THIS month and
        # next month, same shape the Catalog row uses, so the card's
        # MonthEffectiveSparkline popover can show Frontline / Discount /
        # RIP / Best for both months side by side. Also flag wines that
        # have multiple vintages so the card can show a "Multiple
        # vintages" sticker.
        from backend.routers.catalog import attach_promotion_tiers, attach_vintages_available
        attach_promotion_tiers(con, out)
        attach_vintages_available(con, out)
        return out


@router.get("/rips")
def get_active_rips(
    wholesaler: Optional[str] = None,
    edition: Optional[str] = None,
    q: str = "",
    limit: int = Query(50, ge=1, le=50000),
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
            # Description text, plus the codes a buyer can read off the sheet:
            # the RIP code itself, the UPC, and (via code_search) an Allied
            # ABG item number that maps to a member UPC.
            params["q"] = f"%{q}%"
            _ors = ["UPPER(rip_description) LIKE UPPER($q)",
                    "CAST(rip_code AS VARCHAR) LIKE $q",
                    "CAST(upc AS VARCHAR) LIKE $q"]
            from backend.code_search import identifier_clause
            _idc, _idp = identifier_clause(q, upc_expr="upc")
            if _idc:
                _ors.append(_idc)
                params.update(_idp)
            where.append("(" + " OR ".join(_ors) + ")")

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
        from backend import pricing as _pricing
        rip_df = con.execute(f"""
            SELECT rip_code, wholesaler, edition, upc, from_date, to_date,
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

        # Rank used when two RIP rows give the same (unit, qty, amt) under one
        # code/UPC but with different validity windows: keep the one most
        # relevant NOW so the tier badges read "active" over "expired".
        _win_rank = {"active": 0, "whole_month": 1, "evergreen": 2, "upcoming": 3, "expired": 4}

        rip_lookup = {}
        for _, r in rip_df.iterrows():
            win = _pricing.window_status(r.get("from_date"), r.get("to_date"))
            wmeta = {
                "from_date": _pricing._iso(r.get("from_date")),
                "to_date": _pricing._iso(r.get("to_date")),
                "window_status": win["status"],
                "days_to_expire": win["days_to_expire"],
            }
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
                        **wmeta,
                    })
            if not tiers_here:
                continue
            key = (str(r["rip_code"]), r["wholesaler"], r["edition"], str(r.get("upc", "")))
            rip_lookup.setdefault(key, []).extend(tiers_here)

        # Dedupe each lookup entry by (norm_unit, qty, amt). When the same tier
        # exists under multiple windows, keep the most-relevant-now one.
        for k, tlist in rip_lookup.items():
            best: dict = {}
            for t in tlist:
                sig = (_norm_unit_key(t["unit"]), t["qty"], t["amt"])
                cur = best.get(sig)
                if cur is None or _win_rank.get(t.get("window_status"), 5) < _win_rank.get(cur.get("window_status"), 5):
                    best[sig] = t
            rip_lookup[k] = list(best.values())

        # Map (wholesaler, normalised UPC) -> sorted list of every RIP code
        # this UPC qualifies under in the RIP sheet (across both target
        # editions). Drives the per-row "all RIP codes" chip cluster on the
        # UI: clicking any chip opens the products-in-this-RIP popup.
        upc_to_rip_codes: dict[tuple[str, str], list[str]] = {}
        for (rc, ws_, ed_, upc_) in rip_lookup.keys():
            rc_s = str(rc).strip()
            if not rc_s or rc_s.lower() in ("0", "none", "nan"):
                continue
            un = str(upc_).lstrip("0")
            if not un:
                continue
            key = (ws_, un)
            existing = upc_to_rip_codes.setdefault(key, [])
            if rc_s not in existing:
                existing.append(rc_s)
        for key in upc_to_rip_codes:
            upc_to_rip_codes[key].sort()

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
                # A CPL cell can pack several codes ("240002 250002"); the RIP
                # sheet stores each as its own row, so look up every split code
                # (same rule as pricing.attach_tiers / derive.py) instead of the
                # literal multi-code string, which would match nothing.
                for code in _pricing._split_rip_codes(rip_code):
                    rk = (code, ws, p["edition"], upc)
                    rip_tiers.extend({**t, "source": "rip"} for t in rip_lookup.get(rk, []))

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

            # When several codes contribute the same (source, unit, qty) tier
            # (a UPC stacked under two codes with different windows, e.g. an
            # active 1-8 Jun deal and an upcoming 11-30 Jun one), keep the one
            # most relevant NOW so the badge reads "active" over "upcoming".
            def _prefer(old, new):
                if old is None:
                    return new
                return new if (_win_rank.get(new.get("window_status"), 5)
                               < _win_rank.get(old.get("window_status"), 5)) else old

            tier_pairs = {}
            for t in (curr_tiers or []):
                k = (t["source"], _norm_unit(t["unit"]), t["qty"])
                tier_pairs.setdefault(k, {"curr": None, "next": None, "unit": t["unit"], "qty": t["qty"], "source": t["source"]})
                tier_pairs[k]["curr"] = _prefer(tier_pairs[k]["curr"], t)
            for t in (next_tiers or []):
                k = (t["source"], _norm_unit(t["unit"]), t["qty"])
                if k not in tier_pairs:
                    tier_pairs[k] = {"curr": None, "next": None, "unit": t["unit"], "qty": t["qty"], "source": t["source"]}
                tier_pairs[k]["next"] = _prefer(tier_pairs[k]["next"], t)

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
                    # Per-side validity window so the sparkline popover can badge
                    # this tier Active now / Expires in N days / Starts DD MMM
                    # against today (curr) and against next month (next). Only
                    # RIP-source tiers carry these; discount tiers are evergreen
                    # within their edition here.
                    "curr_window_status": (tp.get("curr") or {}).get("window_status"),
                    "curr_from_date": (tp.get("curr") or {}).get("from_date"),
                    "curr_to_date": (tp.get("curr") or {}).get("to_date"),
                    "curr_days_to_expire": (tp.get("curr") or {}).get("days_to_expire"),
                    "next_window_status": (tp.get("next") or {}).get("window_status"),
                    "next_from_date": (tp.get("next") or {}).get("from_date"),
                    "next_to_date": (tp.get("next") or {}).get("to_date"),
                    "next_days_to_expire": (tp.get("next") or {}).get("days_to_expire"),
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
                    # Every RIP code this UPC qualifies under in the RIP
                    # sheet (a UPC stacked across 5 rebates shows all 5).
                    "rip_codes": list(upc_to_rip_codes.get((ws, str(meta["upc"]).lstrip("0")), [])),
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
        # carry has_rip=true, or the product isn't on the CPL at all, or the
        # CPL row's rip_code points to a DIFFERENT rebate this UPC also
        # qualifies under). Without this, codes like 111889 ("Sutter Home
        # Moscato / Pink / Sweet Red / White Zin") show 0 products even
        # though 4 UPCs qualify, because every one of those UPCs has its CPL
        # row pointing at 111886 (a related but distinct Sutter Home
        # rebate). The skip set keys by (ws, upc, rip_code) so a UPC stacked
        # across N rebates is emitted N times, once per code.
        target_pair_set = {(ws_, ed_) for ws_, ed_ in target_pairs}
        existing_pairs = {(it["wholesaler"],
                           str(it.get("upc") or "").lstrip("0"),
                           str(it.get("rip_number") or ""))
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
            if (ws_, upc_norm, rc_str) in existing_pairs:
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
                        "rip_codes": list(upc_to_rip_codes.get((ws_, upc_norm), [])),
                    }
                    items.append(row)

        # 3-month sparkline history (1-case-discount + best-RIP) per product,
        # attached to every row of that product. Computed once (this list is
        # cached with the pricing file), so the RIP page gets the same two-line
        # 3-month sparkline the Catalog uses.
        try:
            from backend import pricing as _pricing
            metas: dict = {}
            for r in items:
                k = (r.get("wholesaler"), str(r.get("upc") or ""))
                if r.get("upc") and k not in metas:
                    metas[k] = {"wholesaler": r.get("wholesaler"), "upc": r.get("upc"),
                                "product_name": r.get("product_name"), "unit_volume": r.get("unit_volume"),
                                "unit_qty": r.get("unit_qty"), "vintage": r.get("vintage")}
            meta_list = list(metas.values())
            _pricing.attach_price_3mo(con, meta_list)
            p3 = {(m.get("wholesaler"), str(m.get("upc") or "")): m.get("price_3mo") for m in meta_list}
            for r in items:
                r["price_3mo"] = p3.get((r.get("wholesaler"), str(r.get("upc") or ""))) or []
        except Exception:
            for r in items:
                r.setdefault("price_3mo", [])

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
    size: Optional[str] = None,        # exact unit_volume match e.g. '1.5L', '750ML'
    new_next: bool = False,
    source: Optional[str] = None,
    sort: str = Query("rip_save_per_case", description="Sort field"),
    order: str = Query("desc", description="asc or desc"),
    limit: int = Query(50, ge=1, le=50000),
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
    corrected_query: str | None = None
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
            # Token-AND search across name + brand + UPC + rip_number, with
            # each token also accepting its common distributor abbreviation
            # so a typed-in real brand name ("Sutter Home", "Robert Mondavi
            # Reserve") finds the distributor's truncated text ("SUTTER HM
            # CAB", "ROBT MONDAVI RSV"). Three complementary expansion
            # sources kick in for every token:
            #   1. backend.search_aliases.expansion_for — curated shorthand
            #      ("jw" -> "johnnie walker", "henny" -> "hennessy")
            #   2. SHORT_FORMS below — curated wine / spirits abbreviations
            #      ("home" -> "hm", "chardonnay" -> "ch"/"chard", ...).
            #   3. Vowel-strip heuristic ("reserve" -> "rsrv", "vineyards"
            #      -> "vnyrds", "manor" -> "mnr") to catch the long tail
            #      no curated map covers.
            # When NOTHING hits we fall through to the catalog's spell-fix
            # against the catalogue vocabulary, then to the AI rewrite —
            # exactly the chain the catalog uses for genuine misses.
            from backend.search_aliases import expansion_for as _alias_for
            SHORT_FORMS = {
                # Varietals
                "cabernet": ["cab"], "sauvignon": ["sauv", "sb"], "chardonnay": ["ch", "chard"],
                "merlot": ["mer"], "pinot": ["pin"], "noir": ["nr"], "grigio": ["pg"],
                "blanc": ["bl"], "moscato": ["mos"], "zinfandel": ["zin"], "syrah": ["syr"],
                "riesling": ["ries"], "tempranillo": ["temp"],
                # Estate / winery / brand words
                "home": ["hm"], "homes": ["hm"],
                "estate": ["est"], "estates": ["est"],
                "vineyard": ["vyd", "vnyd", "vy"], "vineyards": ["vyd", "vnyd", "vy"],
                "winery": ["wnry", "win"], "wineries": ["wnry"],
                "selection": ["sel", "selct"], "reserve": ["res", "rsv"], "reserva": ["rsv"],
                "founders": ["foundr", "fndr"], "founder": ["foundr"],
                # Spirits
                "scotch": ["sc"], "single": ["sgl", "sngl"], "malt": ["mlt"],
                "whiskey": ["wsky", "whsky", "whky"], "whisky": ["wsky", "whsky"],
                "bourbon": ["brbn", "bbn"], "rye": ["ry"],
                "vodka": ["vd", "vdk"], "tequila": ["teq", "tqla"], "rum": ["rm"],
                "gin": ["gn"], "champagne": ["champ", "chp"], "brandy": ["brndy"],
                # Vintage years / packaging
                "year": ["yr"], "years": ["yr", "yrs"], "old": ["yo"],
                "case": ["cs"], "bottle": ["btl"], "bottles": ["btl"],
                "pack": ["pk"], "twin": ["tw"], "tray": ["tr"],
                # Common brand fragments
                "robert": ["robt", "rbt"], "richard": ["rich"], "william": ["wm"],
            }

            def _vowel_strip(word: str) -> str:
                """First letter + interior consonants only ("home"->"hm",
                "reserve"->"rsrv", "vineyards"->"vnyrds"). A cheap heuristic
                that catches the long tail of distributor abbreviations no
                curated map covers."""
                if not word or len(word) < 3:
                    return word
                return word[0] + "".join(c for c in word[1:] if c.lower() not in "aeiou")

            def _expansions_for(tok: str) -> list[str]:
                """Every accepted form of a query token: the literal, any
                curated alias (search_aliases), any wine/spirits short form,
                and the vowel-strip abbreviation as a final fallback."""
                seen, out = set(), []
                for cand in (
                    [tok]
                    + (_alias_for(tok) or [])
                    + SHORT_FORMS.get(tok, [])
                    + [_vowel_strip(tok)]
                ):
                    c = (cand or "").lower().strip()
                    if c and c not in seen:
                        seen.add(c)
                        out.append(c)
                return out

            def _filter_items(items_list: list[dict], qq: str) -> list[dict]:
                toks = [t for t in qq.lower().split() if t]
                if not toks:
                    return items_list
                # An identifier query (Allied ABG item number, RIP code) may
                # not appear in the haystack at all - the ABG SKU lives in
                # sku_mapping, not on the tier row. Resolve it to UPCs once
                # and accept any row carrying one of them.
                from backend.code_search import resolve_codes_to_upcs
                id_upcs = set(resolve_codes_to_upcs(con, qq))
                tok_terms = [_expansions_for(t) for t in toks]
                out = []
                for it in items_list:
                    if id_upcs and str(it.get("upc") or "").lstrip("0") in id_upcs:
                        out.append(it)
                        continue
                    hay = " ".join([
                        (it.get("product_name") or "").lower(),
                        (it.get("brand") or "").lower(),
                        str(it.get("upc") or "").lower(),
                        str(it.get("rip_number") or "").lower(),
                    ])
                    if all(any(term in hay for term in terms) for terms in tok_terms):
                        out.append(it)
                return out

            filtered = _filter_items(items, q)

            # Spell-fix + AI rewrite for genuine misses ("cordon blue" ->
            # "cordon bleu"). Off automatically when ANTHROPIC_API_KEY is unset.
            if not filtered and any(ch.isalpha() for ch in q):
                try:
                    from backend.routers.catalog import _spell_fix as _cat_spell_fix, _vocab as _cat_vocab
                    cpl_src = read_parquet(con, "cpl_enriched")
                    fixed = _cat_spell_fix(q, _cat_vocab(con, cpl_src))
                    if fixed and fixed.lower() != q.lower():
                        retried = _filter_items(items, fixed)
                        if retried:
                            filtered, corrected_query = retried, fixed
                except Exception:
                    pass
                if not filtered:
                    try:
                        from backend.ai_search import ai_expand_query
                        ai_q = ai_expand_query(q)
                        if ai_q and ai_q.lower() != q.lower():
                            retried = _filter_items(items, ai_q)
                            if retried:
                                filtered, corrected_query = retried, ai_q
                    except Exception:
                        pass

            items = filtered

        if min_savings is not None:
            items = [i for i in items if (i["rip_save_per_case"] or 0) >= min_savings]

        if min_gp is not None:
            items = [i for i in items if max(i.get("curr_gp_pct") or 0, i.get("next_gp_pct") or 0) >= min_gp]

        if tier_unit in ("case", "btl"):
            items = [i for i in items if _norm_unit(i.get("rip_unit")) == tier_unit]

        if size:
            # Exact unit_volume match — the buyer picks a size from the dropdown
            # (1.5L, 750ML, ...) and we filter to just that pack. Case-insensitive
            # and whitespace-tolerant so "750 ML" matches "750ML".
            sz_norm = size.strip().lower().replace(" ", "")
            items = [
                i for i in items
                if (i.get("unit_volume") or "").strip().lower().replace(" ", "") == sz_norm
            ]

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
        attach_sku_mapping(con, page_items)
        return {
            "total": total,
            "limit": limit,
            "offset": offset,
            "items": page_items,
            "corrected_query": corrected_query,
        }
