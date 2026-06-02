"""Celar AI Assistant — full-page conversational engine.

A Claude-style assistant that answers questions about the pricing catalog with
properly formatted markdown, optional charts, and the ability to perform the
same human actions as the sidebar (add to cart / favorites / lists, set qty).

How it works (token-aware, real data):
  - Claude runs an agentic loop with READ-ONLY data tools that return compact
    aggregates straight from DuckDB (category/distributor breakdowns, top
    products, price history, deal counts). Rows never flood the context — tools
    return small summaries.
  - When the buyer asks to DO something, Claude calls an ACTION tool; the backend
    resolves the concrete product(s) from DuckDB and records the action for the
    frontend to execute (cart/watchlist/lists APIs).
  - Charts: Claude embeds a fenced ```chart block with {type,title,labels,series}
    built from real tool numbers; the frontend renders it with recharts.
  - `history` gives multi-turn memory. Usage (tokens + USD cost, summed across the
    loop) is returned and logged.

Falls back to a short notice when ANTHROPIC_API_KEY is unset/invalid.
"""
from __future__ import annotations

import json
import math
import re

from backend.db import get_duckdb
from backend.ai_catalog_query import (
    _client_or_none, _cost_usd, _MODEL, _current_ym, _resolve_products,
    _history_messages, enabled, resolve_distributor as _resolve_distributor,
)
# Canonical pricing helpers — every "best deal" / tier / ranking question
# must read from here, not from inline SQL. See backend/FOUNDATION.md.
from backend import pricing as _pricing
from backend import rip_utils as _rip   # canonical case/bottle RIP unit math

_ACTION_TYPES =("add_to_cart", "update_quantity", "add_to_favorites", "add_to_list", "swap_distributor", "submit_order", "reorder", "message_rep", "set_order_note", "assign_rep", "create_rep", "remove_from_cart")
_MAX_TURNS = 6
# Stocking-deal floor used by the "best deals" ranker by default. A row whose
# effective_case_price is below this fraction of frontline (e.g. a 100%-off
# free-with-purchase rebate at $0/cs) is excluded from the ranking — those
# are real data points but they dominate naive savings-DESC sorts and aren't
# what a buyer means by "best deal in the catalog". Override via the tool
# arg `include_stocking_deals=True` when the user explicitly asks.
_STOCKING_FLOOR_PCT = 0.10


def _is_stocking_row(r: dict) -> bool:
    """True for a $0 / near-free 'free-with-purchase' row: effective price is
    below _STOCKING_FLOOR_PCT of frontline. Rows with no/zero frontline are NOT
    treated as stocking (we can't judge them), so they pass through."""
    try:
        front = r.get("frontline_case_price")
        eff = r.get("effective_case_price")
        if front is None or eff is None or float(front) <= 0:
            return False
        return float(eff) < float(front) * _STOCKING_FLOOR_PCT
    except (TypeError, ValueError):
        return False


# Same-UPC price gaps larger than this ratio (dearest / cheapest) are almost
# certainly bad source data (e.g. a $4,299 vs $120 row on the same barcode), not
# a real arbitrage, so the arbitrage ranker drops them by default.
_ARBITRAGE_MAX_RATIO = 8.0


def _clean(v):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    return v


# --------------------------- data tools (read-only) ---------------------------

def _t_category_breakdown(con, _args):
    rows = con.execute(f"""
        WITH cur AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched
                     WHERE edition <= '{_current_ym()}' GROUP BY wholesaler)
        SELECT product_type AS category, COUNT(*) AS products,
               ROUND(AVG(frontline_case_price), 2) AS avg_case_price
        FROM cpl_enriched c JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed
        WHERE product_type IS NOT NULL
        GROUP BY 1 ORDER BY products DESC LIMIT 20
    """).fetchdf()
    return rows.to_dict(orient="records")


def _t_distributor_breakdown(con, _args):
    rows = con.execute(f"""
        WITH cur AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched
                     WHERE edition <= '{_current_ym()}' GROUP BY wholesaler)
        SELECT c.wholesaler AS distributor, COUNT(*) AS products,
               ROUND(AVG(frontline_case_price), 2) AS avg_case_price,
               SUM(CASE WHEN has_rip THEN 1 ELSE 0 END) AS with_rip,
               SUM(CASE WHEN has_discount THEN 1 ELSE 0 END) AS with_discount
        FROM cpl_enriched c JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed
        GROUP BY 1 ORDER BY products DESC
    """).fetchdf()
    return rows.to_dict(orient="records")


def _t_deal_counts(con, _args):
    row = con.execute(f"""
        WITH cur AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched
                     WHERE edition <= '{_current_ym()}' GROUP BY wholesaler)
        SELECT COUNT(*) AS products,
               SUM(CASE WHEN has_rip THEN 1 ELSE 0 END) AS with_rip,
               SUM(CASE WHEN has_discount THEN 1 ELSE 0 END) AS with_discount,
               SUM(CASE WHEN has_closeout THEN 1 ELSE 0 END) AS closeouts
        FROM cpl_enriched c JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed
    """).fetchdf()
    return row.to_dict(orient="records")[0] if len(row) else {}


def _t_top_products(con, args):
    view = {
        "categories": [args["category"]] if args.get("category") else [],
        "divisions": [args["distributor"]] if args.get("distributor") else [],
        "hasRip": args.get("has_rip"), "hasDiscount": args.get("has_discount"),
        "priceMin": args.get("price_min"), "priceMax": args.get("price_max"),
        "sizes": args.get("sizes") or [],
        # Semantic hints so 'California wines', 'Napa cabs', 'rising bourbons'
        # resolve the same way the catalog grid does (not a naive name LIKE).
        "region": args.get("region"), "varietal": args.get("varietal"),
        "price_trend": args.get("price_trend"),
    }
    which = {"cheapest": "cheapest", "expensive": "most_expensive"}.get(args.get("order_by"), "cheapest")
    cap = min(int(args.get("limit") or 10), 25)
    # Hide $0 free-with-purchase stocking rows by default (otherwise the
    # 'cheapest' list is dominated by 100%-off liquidation rows like Beronia
    # Rose). Opt back in with include_stocking_deals=True.
    exclude_stocking = not bool(args.get("include_stocking_deals"))
    prods = _resolve_products(con, view, args.get("match") or "", which, cap,
                              exclude_stocking=exclude_stocking)
    return prods


def _t_price_history(con, args):
    match = (args.get("match") or "").strip()
    if not match:
        return {"error": "match required"}
    prods = _resolve_products(con, {}, match, "first", 1)
    if not prods:
        return {"error": "no product matched"}
    p = prods[0]
    rows = con.execute("""
        SELECT edition, frontline_case_price, effective_case_price
        FROM cpl_enriched
        WHERE wholesaler = ? AND product_name = ?
        ORDER BY edition
    """, [p["wholesaler"], p["product_name"]]).fetchdf()
    return {"product": p["product_name"], "wholesaler": p["wholesaler"],
            "history": rows.to_dict(orient="records")}


def _t_price_timeline(con, args):
    """Month-over-month price comparison for ONE product across editions.

    Follows the product by UPC (the stable key — names change between editions)
    and returns, PER DISTRIBUTOR, a per-edition series of frontline + effective
    case price, RIP savings and discount flag, each with the month-over-month
    delta, plus a summary (cheapest / dearest month, net change, latest vs prior,
    trend). Use for 'price over months', 'how has X's price changed', 'compare X
    prices across months', 'price trend / history for X'. Optional `distributor`
    to focus one supplier and `months` to cap how many recent editions."""
    match = (args.get("match") or "").strip()
    if not match:
        return {"error": "Provide a product name or UPC in match."}
    distributor = (args.get("distributor") or "").strip()
    try:
        months_n = int(args.get("months") or args.get("limit") or 12)
    except (TypeError, ValueError):
        months_n = 12
    months_n = min(max(months_n, 2), 36)

    compact = re.sub(r"[\s\-]", "", match)
    upc, name_hint = None, None
    if compact.isdigit() and len(compact) >= 6:
        upc = compact.lstrip("0") or compact
    else:
        toks = [t for t in re.split(r"\s+", match) if t]
        if toks:
            wc = " AND ".join(
                "(UPPER(product_name) LIKE UPPER(?) OR UPPER(COALESCE(brand,'')) LIKE UPPER(?))"
                for _ in toks)
            rp: list = []
            for t in toks:
                rp += [f"%{t}%", f"%{t}%"]
            try:
                # Prefer the standard 750ML when the name is ambiguous across
                # sizes (so 'Macallan Double Cask 12' resolves to the 750ML
                # bottle, not the 50ML 12-pack), unless the user named a size.
                size_hint = bool(re.search(r"\b(50\s?ml|375|187|1\.?75|1\s?l\b|1000|liter|litre)\b",
                                           match.lower()))
                size_rank = ("0" if size_hint else
                             "(CASE WHEN UPPER(REPLACE(ANY_VALUE(unit_volume), ' ', '')) "
                             "LIKE '750%' THEN 0 ELSE 1 END)")
                r = con.execute(
                    "SELECT LTRIM(CAST(upc AS VARCHAR),'0') un, ANY_VALUE(product_name) pn, "
                    "COUNT(*) n, MAX(edition) last_ed FROM cpl_enriched "
                    f"WHERE {wc} AND upc IS NOT NULL "
                    "AND LTRIM(CAST(upc AS VARCHAR),'0') NOT IN ('', '0') "
                    f"GROUP BY 1 ORDER BY {size_rank}, last_ed DESC, n DESC LIMIT 1", rp).fetchone()
                if r:
                    upc, name_hint = r[0], r[1]
            except Exception:
                pass
    if not upc:
        return {"error": f"Couldn't resolve a product with a UPC for '{match}'."}

    where = ["LTRIM(CAST(c.upc AS VARCHAR),'0') = ?"]
    qp: list = [upc]
    if distributor:
        where.append("LOWER(c.wholesaler) = LOWER(?)")
        qp.append(distributor)
    try:
        recs = con.execute(
            "SELECT c.edition, c.wholesaler, c.product_name, c.unit_volume, c.unit_qty, "
            "c.frontline_case_price, c.effective_case_price, c.rip_savings, "
            "c.total_savings_per_case, c.has_rip, c.has_discount "
            f"FROM cpl_enriched c WHERE {' AND '.join(where)} "
            "ORDER BY c.edition", qp).fetchdf().to_dict(orient="records")
    except Exception as e:
        return {"error": f"{type(e).__name__}"}
    if not recs:
        return {"error": f"No price history found for '{match}'."}

    hint_tokens = set(re.findall(r"[A-Z0-9]+", (name_hint or match).upper()))

    def _overlap(nm) -> int:
        return len(hint_tokens & set(re.findall(r"[A-Z0-9]+", str(nm or "").upper())))

    # Group by distributor, then ONE row per edition. A UPC can collide with a
    # second product in the same edition (bad source data) — disambiguate by name
    # similarity to the resolved product, tie-broken by higher list price.
    by_ws: dict = {}
    for r in recs:
        ws = r["wholesaler"]
        ed = str(r["edition"])
        slot = by_ws.setdefault(ws, {})
        cur = slot.get(ed)
        if cur is None:
            slot[ed] = r
            continue
        if (_overlap(r["product_name"]), _num(r["frontline_case_price"]) or 0) > \
           (_overlap(cur["product_name"]), _num(cur["frontline_case_price"]) or 0):
            slot[ed] = r

    distributors = []
    for ws, eds in by_ws.items():
        series = [eds[e] for e in sorted(eds)][-months_n:]
        timeline, prev_eff = [], None
        for r in series:
            eff = _num(r.get("effective_case_price"))
            front = _num(r.get("frontline_case_price"))
            delta = round(eff - prev_eff, 2) if (eff is not None and prev_eff is not None) else None
            pct = round((eff - prev_eff) / prev_eff * 100, 1) if (delta is not None and prev_eff) else None
            timeline.append({
                "edition": str(r.get("edition")),
                "frontline_case_price": front, "effective_case_price": eff,
                "rip_savings": _num(r.get("rip_savings")) or 0.0,
                "total_savings_per_case": _num(r.get("total_savings_per_case")) or 0.0,
                "has_rip": bool(r.get("has_rip")), "has_discount": bool(r.get("has_discount")),
                "delta_vs_prev": delta, "pct_vs_prev": pct,
            })
            if eff is not None:
                prev_eff = eff
        effs = [(t["edition"], t["effective_case_price"]) for t in timeline if t["effective_case_price"] is not None]
        cheapest = min(effs, key=lambda x: x[1]) if effs else None
        dearest = max(effs, key=lambda x: x[1]) if effs else None
        first_eff, last_eff = (effs[0][1] if effs else None), (effs[-1][1] if effs else None)
        net = round(last_eff - first_eff, 2) if (first_eff is not None and last_eff is not None) else None
        trend = ("flat" if net is None or abs(net) < 0.01 else ("up" if net > 0 else "down"))
        distributors.append({
            "wholesaler": ws,
            "unit_volume": series[-1].get("unit_volume") if series else None,
            "bottles_per_case": (str(series[-1].get("unit_qty")) if series and series[-1].get("unit_qty") is not None else None),
            "timeline": timeline,
            "cheapest_month": ({"edition": cheapest[0], "effective_case_price": cheapest[1]} if cheapest else None),
            "dearest_month": ({"edition": dearest[0], "effective_case_price": dearest[1]} if dearest else None),
            "first_effective": first_eff, "latest_effective": last_eff,
            "net_change": net,
            "net_pct": (round(net / first_eff * 100, 1) if (net is not None and first_eff) else None),
            "trend": trend,
        })
    distributors.sort(key=lambda d: d["wholesaler"])
    return {"product": name_hint or (recs[-1].get("product_name") if recs else match),
            "upc": upc, "months": months_n, "distributor_count": len(distributors),
            "distributors": distributors}


def _t_price_details(con, args):
    """Full alcohol-retail pricing breakdown for one product: frontline case &
    bottle price, discount tiers, RIP tiers, effective price, bottles/case, and
    the last 3 editions of price history. The assistant auto-attaches a price
    waterfall + a 3-month history chart from this."""
    match = (args.get("match") or "").strip()
    view = {"categories": [args["category"]] if args.get("category") else [],
            "divisions": [args["distributor"]] if args.get("distributor") else []}
    prods = _resolve_products(con, view, match, "first", 1)
    if not prods:
        return {"error": "no product matched"}
    p = prods[0]
    from backend.routers.catalog import get_product_detail
    detail = get_product_detail(p["wholesaler"], p["product_name"], upc=p.get("upc"),
                                unit_volume=p.get("unit_volume"), unit_qty=p.get("unit_qty"),
                                vintage=p.get("vintage"))
    prod = detail.get("product") or {}
    hist = con.execute(
        "SELECT edition, frontline_case_price, effective_case_price FROM cpl_enriched "
        "WHERE wholesaler = ? AND product_name = ? ORDER BY edition DESC LIMIT 3",
        [p["wholesaler"], p["product_name"]],
    ).fetchdf()
    history = list(reversed(hist.to_dict(orient="records")))
    # Next-month price for a plain-English buy-now-vs-wait recommendation.
    nxt = con.execute(
        "SELECT edition, effective_case_price, frontline_case_price FROM cpl_enriched "
        "WHERE wholesaler = ? AND product_name = ? AND edition > ? ORDER BY edition LIMIT 1",
        [p["wholesaler"], p["product_name"], _current_ym()],
    ).fetchdf()
    this_eff = prod.get("effective_case_price")
    next_eff = None
    next_edition = None
    if len(nxt):
        nrow = nxt.iloc[0]
        next_edition = nrow["edition"]
        next_eff = _clean(nrow["effective_case_price"])
        if next_eff is None:
            next_eff = _clean(nrow["frontline_case_price"])
        next_eff = float(next_eff) if next_eff is not None else None
    if this_eff is None:
        rec = "Pricing unavailable."
    elif next_eff is None:
        rec = f"Buy now — ${this_eff:.2f}/cs today; it isn't on next month's price sheet (may be gone)."
    elif abs(this_eff - next_eff) < 0.01:
        rec = f"No rush — ${this_eff:.2f}/cs holds the same next month."
    elif next_eff > this_eff:
        rec = f"Buy now — ${this_eff:.2f}/cs today rises to ${next_eff:.2f}/cs next month (save ${next_eff - this_eff:.2f}/cs)."
    else:
        rec = f"Consider waiting — drops from ${this_eff:.2f}/cs to ${next_eff:.2f}/cs next month (save ${this_eff - next_eff:.2f}/cs)."
    return {
        "product_name": p["product_name"], "wholesaler": p["wholesaler"],
        "unit_volume": p.get("unit_volume"), "vintage": p.get("vintage"),
        "bottles_per_case": prod.get("unit_qty"),
        "frontline_case_price": prod.get("frontline_case_price"),
        "frontline_bottle_price": prod.get("frontline_unit_price"),
        "best_case_price_after_discount": prod.get("best_case_price"),
        "effective_case_price": this_eff,
        "next_month_case_effective": next_eff,
        "next_edition": next_edition,
        "best_buy_recommendation": rec,
        # Date-aware "live now" RIP overlay: the whole-month effective price is
        # above; this is the price if a dated RIP active today is applied. Only
        # populated when a currently-active partial-window RIP beats the month
        # price (live_better_than_month true).
        "live_effective_case_price": prod.get("live_effective_case_price"),
        "live_rip_amount_per_case": prod.get("live_rip_amt"),
        "live_better_than_month": prod.get("live_better_than_month"),
        "discount_tiers": detail.get("discount_tiers") or [],
        "rip_tiers": detail.get("rip_tiers") or [],
        "price_history_3mo": history,
    }


def _t_compare_distributors(con, args):
    """Side-by-side comparison of ONE product across every distributor that
    carries it. `match` may be a UPC or a product name (we resolve the UPC),
    then list each distributor's case/effective price, savings, RIP/discount."""
    match = (args.get("match") or "").strip()
    if not match:
        return {"error": "provide a UPC or product name in `match`"}
    compact = match.replace(" ", "").replace("-", "")
    if compact.isdigit() and len(compact) >= 6:
        upc_norm = compact.lstrip("0")
        name_hint = None
    else:
        prods = _resolve_products(con, {}, match, "first", 1)
        if not prods:
            return {"error": "no product matched"}
        upc_norm = str(prods[0].get("upc") or "").lstrip("0")
        name_hint = prods[0].get("product_name")
    if not upc_norm:
        return {"error": "matched product has no UPC to compare across distributors"}
    cym = _current_ym()
    try:
        rows = con.execute(
            f"WITH cur AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched WHERE edition<='{cym}' GROUP BY wholesaler) "
            "SELECT c.wholesaler, c.product_name, c.unit_volume, c.unit_qty, c.upc, c.vintage, "
            "c.frontline_case_price, c.effective_case_price, c.total_savings_per_case, c.has_rip, c.has_discount "
            "FROM cpl_enriched c JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed "
            "WHERE LTRIM(CAST(c.upc AS VARCHAR),'0') = ? "
            "ORDER BY c.effective_case_price ASC NULLS LAST", [upc_norm]).fetchdf()
    except Exception as e:
        return {"error": f"{type(e).__name__}"}
    recs = rows.to_dict(orient="records")
    return {"upc": upc_norm, "product": name_hint or (recs[0]["product_name"] if recs else None),
            "distributor_count": len(recs), "comparison": recs}


def _rip_tiers_for(con, code, ws=None, edition=None, as_of=None):
    """(description, [tiers]) for a RIP code. A code's FULL tier ladder is split
    across MULTIPLE rip rows — each row holds up to 4 tier slots, and a code spans
    several UPCs/rows — so we read ALL rows for the code in its latest edition and
    UNION their tiers. (Reading a single row dropped tiers such as the
    '3 Cases -> $108' rung on Anteel code 100027.) Tiers are deduped by
    (unit, qty, amount, window) and sorted by rebate amount. `edition` (YYYY-MM)
    reads the ladder AS OF that month so a past-month lookup shows that month's
    tiers.

    Each tier carries its validity window relative to ``as_of`` (default today):
    ``from_date`` / ``to_date`` / ``window_status`` (whole_month | active |
    upcoming | expired | evergreen) / ``days_to_expire`` / ``is_time_sensitive``,
    so the assistant can tell the buyer a rebate is live now vs whole-month vs
    not yet started. Two distinct date ranges at the same qty/amount both survive
    the dedup (the buyer sees the full picture)."""
    cym = edition or _current_ym()
    base = ["CAST(rip_code AS VARCHAR) = ?"]
    bp = [str(code)]
    if ws:
        base.append("wholesaler = ?")
        bp.append(ws)
    try:
        med = con.execute(
            f"SELECT MAX(edition) FROM rip WHERE {' AND '.join(base)} AND edition <= ?", bp + [cym]).fetchone()
        ed = med[0] if med and med[0] else None
        if not ed:
            return None, []
        df = con.execute(
            "SELECT rip_description, from_date, to_date, "
            "rip_unit_1, rip_qty_1, rip_amt_1, rip_unit_2, rip_qty_2, rip_amt_2, "
            "rip_unit_3, rip_qty_3, rip_amt_3, rip_unit_4, rip_qty_4, rip_amt_4 "
            f"FROM rip WHERE {' AND '.join(base)} AND edition = ? LIMIT 1000", bp + [ed]).fetchdf()
    except Exception:
        return None, []
    if df.empty:
        return None, []
    desc, seen, tiers = None, set(), []
    for _, r in df.iterrows():
        if desc is None:
            d = r.get("rip_description")
            if d is not None and str(d) != "nan":
                desc = str(d)
        win = _pricing.window_status(r.get("from_date"), r.get("to_date"), as_of)
        rfrom = _pricing._iso(r.get("from_date"))
        rto = _pricing._iso(r.get("to_date"))
        rts = _pricing.is_time_sensitive_window(r.get("from_date"), r.get("to_date"))
        for j in range(1, 5):
            amt, qty, unit = r.get(f"rip_amt_{j}"), r.get(f"rip_qty_{j}"), r.get(f"rip_unit_{j}")
            try:
                a, q = float(amt), float(qty)
            except (TypeError, ValueError):
                continue
            if a != a or q != q or a <= 0 or q <= 0:
                continue
            u = str(unit) if unit and str(unit) != "nan" else "Cases"
            key = (u, int(q), round(a, 2), rfrom, rto)
            if key in seen:
                continue
            seen.add(key)
            tiers.append({
                "qty": int(q), "unit": u, "amount": round(a, 2),
                "from_date": rfrom, "to_date": rto,
                "window_status": win["status"], "days_to_expire": win["days_to_expire"],
                "is_time_sensitive": rts,
            })
    tiers.sort(key=lambda t: t["amount"])
    return desc, tiers


_MONTH_NAMES = {
    "january": 1, "jan": 1, "february": 2, "feb": 2, "march": 3, "mar": 3,
    "april": 4, "apr": 4, "may": 5, "june": 6, "jun": 6, "july": 7, "jul": 7,
    "august": 8, "aug": 8, "september": 9, "sept": 9, "sep": 9, "october": 10,
    "oct": 10, "november": 11, "nov": 11, "december": 12, "dec": 12,
}


def _resolve_month(con, text) -> Optional[str]:
    """Parse a user month reference into a 'YYYY-MM' edition, or None.

    Accepts '2026-05', '05/2026', 'May', 'may 2026', 'this month'. A bare month
    name with no year resolves to the most recent edition in the data with that
    month (so 'May' on a June-current dataset -> '2026-05'). Returns None when no
    month is referenced, so the caller falls back to the current edition."""
    if not text:
        return None
    s = str(text).strip().lower()
    if s in ("this month", "current", "now"):
        return _current_ym()
    m = re.search(r"\b(20\d{2})[-/.](0?[1-9]|1[0-2])\b", s)         # 2026-05
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}"
    m = re.search(r"\b(0?[1-9]|1[0-2])[-/.](20\d{2})\b", s)         # 05/2026
    if m:
        return f"{m.group(2)}-{int(m.group(1)):02d}"
    mon = None
    for name, num in _MONTH_NAMES.items():
        if re.search(rf"\b{name}\b", s):
            mon = num
            break
    if mon is None:
        return None
    yr = re.search(r"\b(20\d{2})\b", s)
    if yr:
        return f"{yr.group(1)}-{mon:02d}"
    try:
        row = con.execute(
            "SELECT MAX(edition) FROM cpl_enriched WHERE edition LIKE ?",
            [f"%-{mon:02d}"]).fetchone()
        if row and row[0]:
            return str(row[0])
    except Exception:
        pass
    return f"{_current_ym()[:4]}-{mon:02d}"


def _t_rip_lookup(con, args):
    """RIP rebate lookup by brand/product NAME or a RIP code.

    Handles the real-data facts that (a) the SAME UPC can qualify under MULTIPLE
    RIP codes, and (b) different DISTRIBUTORS use different codes — by reading the
    full set of codes per (distributor, UPC) from the RIP sheet, not just the one
    code on the catalog row. Returns matched products (each with all its codes),
    a by-distributor code map, and per-code tiers + description + product count.

    Pass `month` ('May' / '2026-05') to look up a PAST edition so a rebate that
    existed then but has since expired is still found."""
    # Honour a month/edition reference so an expired past-month rebate is found.
    cym = _resolve_month(con, args.get("month")) or _current_ym()
    code = str(args.get("rip_code") or "").strip()
    match = (args.get("match") or "").strip()

    def _code_detail(rc, ws=None):
        desc, tiers = _rip_tiers_for(con, rc, ws, edition=cym)
        # Augment each tier with per-case (or per-bottle) savings + flag the best.
        best_amt = max((t["amount"] for t in tiers), default=0.0)
        for t in tiers:
            u = (t.get("unit") or "").lower()
            t["unit_short"] = "btl" if ("btl" in u or "bottle" in u) else "cs"
            t["per_unit_savings"] = round(t["amount"] / t["qty"], 2) if t.get("qty") else None
            t["best"] = bool(best_amt > 0 and t["amount"] == best_amt)
        # The real Case Mix: products that share this RIP code (from the RIP sheet,
        # joined to the catalogue for names/prices). These are what the retailer
        # mixes to reach a tier.
        # member_count is the CANONICAL Case-Mix size: distinct UPCs in the RIP
        # sheet for this (wholesaler, edition, code), counted with the same
        # filter the catalog uses. The members[] list below is just a sample for
        # display (capped at 25 product cards). Don't conflate the two — earlier
        # code used len(members) for the count, which always saturated at 25.
        members, member_count = [], 0
        try:
            # RIP codes are RECYCLED across editions — Fedway code 10265 was Jameson
            # in April, Mortlach in May, Ricard in June. So the Case Mix for a code
            # is ONLY the UPCs carrying it in the LATEST edition the code appears in
            # (matching _rip_tiers_for), never every edition <= now.
            cond = "CAST(rip_code AS VARCHAR) = ?"
            sub: list = [str(rc)]
            if ws:
                cond += " AND wholesaler = ?"
                sub.append(ws)
            # 1. Canonical count = distinct catalog SKUs joined to the cluster's
            # UPCs (no LIMIT). Same UPC + different vintage / pack size counts as
            # separate items, so the AI's count agrees with the catalog page's
            # row count rather than the RIP sheet's UPC count.
            #
            # Scope is strictly (edition, distributor, code). The ripupc CTE
            # MUST drop blank/zero UPCs — without that, the RIP sheet's all-
            # zeros placeholder row leaks in as un='' and the cpl join then
            # matches every blank-UPC product in the catalog, bleeding
            # unrelated brands into the cluster. Same filter on the cpl side
            # is belt-and-braces against any rogue blank c.upc.
            pr_count: list = sub + sub
            try:
                cnt_df = con.execute(
                    f"WITH cur AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched WHERE edition<='{cym}' GROUP BY wholesaler), "
                    f"ripupc AS (SELECT DISTINCT wholesaler, LTRIM(CAST(upc AS VARCHAR),'0') un FROM rip "
                    f"WHERE {cond} AND edition = (SELECT MAX(edition) FROM rip WHERE {cond} AND edition<='{cym}') "
                    "  AND upc IS NOT NULL "
                    "  AND CAST(upc AS VARCHAR) NOT IN ('', '0', 'None', 'nan') "
                    "  AND LTRIM(CAST(upc AS VARCHAR), '0') NOT IN ('', 'None', 'nan')) "
                    "SELECT COUNT(DISTINCT (LTRIM(CAST(c.upc AS VARCHAR),'0'), "
                    "  COALESCE(CAST(c.vintage AS VARCHAR),''), "
                    "  COALESCE(c.unit_volume,''), "
                    "  COALESCE(CAST(c.unit_qty AS VARCHAR),''))) "
                    "FROM cpl_enriched c JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed "
                    "JOIN ripupc r ON r.wholesaler=c.wholesaler AND r.un=LTRIM(CAST(c.upc AS VARCHAR),'0') "
                    "WHERE c.upc IS NOT NULL "
                    "  AND LTRIM(CAST(c.upc AS VARCHAR), '0') NOT IN ('', 'None', 'nan')",
                    pr_count).fetchone()
                member_count = int(cnt_df[0]) if cnt_df and cnt_df[0] is not None else 0
            except Exception:
                member_count = 0
            # 2. Sample of member products for display (capped at 25). Same
            # filters as the count query — otherwise the sample shows unrelated
            # brands that happened to have a blank UPC in the catalog.
            pr_sample: list = sub + sub
            df = con.execute(
                f"WITH cur AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched WHERE edition<='{cym}' GROUP BY wholesaler), "
                f"ripupc AS (SELECT DISTINCT wholesaler, LTRIM(CAST(upc AS VARCHAR),'0') un FROM rip "
                f"WHERE {cond} AND edition = (SELECT MAX(edition) FROM rip WHERE {cond} AND edition<='{cym}') "
                "  AND upc IS NOT NULL "
                "  AND CAST(upc AS VARCHAR) NOT IN ('', '0', 'None', 'nan') "
                "  AND LTRIM(CAST(upc AS VARCHAR), '0') NOT IN ('', 'None', 'nan')) "
                "SELECT DISTINCT c.product_name, c.unit_volume, c.frontline_case_price, c.effective_case_price "
                "FROM cpl_enriched c JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed "
                "JOIN ripupc r ON r.wholesaler=c.wholesaler AND r.un=LTRIM(CAST(c.upc AS VARCHAR),'0') "
                "WHERE c.upc IS NOT NULL "
                "  AND LTRIM(CAST(c.upc AS VARCHAR), '0') NOT IN ('', 'None', 'nan') "
                "ORDER BY c.frontline_case_price NULLS LAST LIMIT 25", pr_sample).fetchdf()
            for _, m in df.iterrows():
                cp = m["frontline_case_price"]
                members.append({"product_name": m["product_name"], "unit_volume": m["unit_volume"],
                                "case_price": float(cp) if cp is not None and cp == cp else None})
            # Defensive: if the count query failed but we have members, fall back
            # to the sample length (still better than nothing).
            if not member_count and members:
                member_count = len(members)
        except Exception:
            pass
        return {"rip_code": rc, "wholesaler": ws, "description": desc, "tiers": tiers,
                "best_rebate": best_amt or None, "member_count": member_count,
                "member_count_note": (f"{member_count} total, showing first 25"
                                      if member_count > len(members) else None),
                "case_mix_members": members}

    # By explicit code.
    if code and code not in ("0", "None", "nan"):
        return {"query": code, "matched_count": 0, "matched_products": [],
                "by_distributor": {}, "rip_codes": [_code_detail(code)], "note": None}

    if not match:
        return {"error": "Provide a product/brand name (match) or a rip_code."}

    # 1) Match products by UPC (6+ digit barcode) or by name/brand.
    where = ["1=1"]
    params: dict = {}
    _compact = re.sub(r"[\s\-]", "", match)
    if _compact.isdigit() and len(_compact) >= 6:
        params["upc_n"] = _compact.lstrip("0") or _compact
        params["upc_raw"] = f"%{_compact}%"
        where.append("(LTRIM(CAST(c.upc AS VARCHAR), '0') = $upc_n OR CAST(c.upc AS VARCHAR) LIKE $upc_raw)")
    else:
        # Each token must match name OR brand OR unit_volume (so size tokens
        # like '1.75' / '750ML' / 'L' qualify the row — the catalog stores
        # the SIZE in unit_volume, not embedded in product_name, so without
        # this the assistant's RIP template silently failed on questions
        # like 'rip mix for malibu pink 1.75 l' with matched_count = 0).
        for i, t in enumerate(t for t in re.split(r"\s+", match) if t):
            params[f"m{i}"] = f"%{t}%"
            ki = f"${'m'+str(i)}"
            where.append(
                f"(UPPER(c.product_name) LIKE UPPER({ki}) "
                f"OR UPPER(COALESCE(c.brand,'')) LIKE UPPER({ki}) "
                f"OR UPPER(COALESCE(c.unit_volume,'')) LIKE UPPER({ki}) "
                f"OR UPPER(COALESCE(c.unit_volume_std,'')) LIKE UPPER({ki}))"
            )
    try:
        rows = con.execute(
            f"WITH cur AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched WHERE edition<='{cym}' GROUP BY wholesaler) "
            "SELECT c.wholesaler, c.product_name, c.unit_volume, CAST(c.upc AS VARCHAR) AS upc, "
            "CAST(c.rip_code AS VARCHAR) AS cpl_rip "
            "FROM cpl_enriched c JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed "
            f"WHERE {' AND '.join(where)} LIMIT 300", params).fetchdf()
    except Exception as e:
        return {"error": f"{type(e).__name__}"}
    if rows.empty:
        return {"error": f"No products matched '{match}'."}

    # 1b) Resolve by UPC across distributors. The SAME UPC is often listed under a
    #     DIFFERENT product NAME per distributor (e.g. Fedway 'MALIBU DOLE VARIETY
    #     8PK CANS' vs Allied 'MALIBU DOLE VAR 3X8', UPC 80432002803). A name match
    #     alone misses the other distributors and wrongly looks "exclusive", so pull
    #     in every distributor carrying the matched UPCs.
    match_upcs = sorted({(str(r["upc"]) or "").lstrip("0")
                         for _, r in rows.iterrows() if (str(r["upc"]) or "").lstrip("0")})
    if match_upcs:
        ph = ", ".join("?" for _ in match_upcs)
        try:
            more = con.execute(
                f"WITH cur AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched WHERE edition<='{cym}' GROUP BY wholesaler) "
                "SELECT c.wholesaler, c.product_name, c.unit_volume, CAST(c.upc AS VARCHAR) AS upc, "
                "CAST(c.rip_code AS VARCHAR) AS cpl_rip "
                "FROM cpl_enriched c JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed "
                f"WHERE LTRIM(CAST(c.upc AS VARCHAR),'0') IN ({ph})", match_upcs).fetchdf()
            if not more.empty:
                import pandas as _pd
                rows = _pd.concat([rows, more], ignore_index=True).drop_duplicates(
                    subset=["wholesaler", "upc", "product_name"])
        except Exception:
            pass

    # 2) Full set of RIP codes per (distributor, normalized UPC) from the RIP sheet
    #    — a UPC can appear under several codes, and codes differ by distributor.
    keys = sorted({(r["wholesaler"], (str(r["upc"]) or "").lstrip("0"))
                   for _, r in rows.iterrows() if (str(r["upc"]) or "").lstrip("0")})
    upc_codes: dict = {}
    if keys:
        ph = ", ".join(f"($w{i}, $u{i})" for i in range(len(keys)))
        kp: dict = {}
        for i, (w, u) in enumerate(keys):
            kp[f"w{i}"], kp[f"u{i}"] = w, u
        try:
            # Each UPC's RIP codes come ONLY from the CURRENT rip sheet per
            # distributor (latest edition <= now). Codes are recycled month to
            # month, so reading older editions would tag a UPC with a code that now
            # belongs to a different product.
            rr = con.execute(
                f"WITH ripcur AS (SELECT wholesaler, MAX(edition) ed FROM rip WHERE edition<='{cym}' GROUP BY wholesaler) "
                "SELECT DISTINCT rp.wholesaler, LTRIM(CAST(rp.upc AS VARCHAR),'0') AS un, CAST(rp.rip_code AS VARCHAR) AS rip_code "
                "FROM rip rp JOIN ripcur rc ON rp.wholesaler=rc.wholesaler AND rp.edition=rc.ed "
                "WHERE CAST(rp.rip_code AS VARCHAR) NOT IN ('', '0', 'None', 'nan') "
                f"AND (rp.wholesaler, LTRIM(CAST(rp.upc AS VARCHAR),'0')) IN ({ph})", kp).fetchdf()
            for _, r in rr.iterrows():
                upc_codes.setdefault((r["wholesaler"], r["un"]), set()).add(str(r["rip_code"]).strip())
        except Exception:
            pass

    # 3) Attach all codes per product + a by-distributor roll-up.
    matched: list[dict] = []
    by_dist: dict = {}
    all_codes: set = set()
    for _, r in rows.iterrows():
        un = (str(r["upc"]) or "").lstrip("0")
        codes = set(upc_codes.get((r["wholesaler"], un), set()))
        cpl = str(r["cpl_rip"] or "").strip()
        if cpl not in ("", "0", "None", "nan"):
            codes.add(cpl)
        codes_sorted = sorted(codes)
        matched.append({"product_name": r["product_name"], "wholesaler": r["wholesaler"],
                        "unit_volume": r["unit_volume"], "upc": un or None, "rip_codes": codes_sorted})
        if codes_sorted:
            by_dist.setdefault(r["wholesaler"], set()).update(codes_sorted)
            for c in codes_sorted:
                all_codes.add((c, r["wholesaler"]))

    # Sort RIP codes by Case-Mix size (biggest first), then code, then distributor,
    # so the AI mirrors the catalog's group_by_rip ordering.
    _details_all = [_code_detail(c, ws) for c, ws in sorted(all_codes)]
    _details_all.sort(key=lambda d: (-(d.get("member_count") or 0),
                                     d.get("rip_code") or "",
                                     d.get("wholesaler") or ""))
    code_details = _details_all[:15]
    note = None
    if not all_codes:
        _when = "this month" if cym == _current_ym() else f"in {cym}"
        note = f"Found {len(matched)} product(s) matching '{match}', but none have a RIP rebate {_when}."
    # Order each distributor's codes by Case-Mix size (biggest first), so the
    # quick by_distributor map agrees with the detailed rip_codes list above.
    _size_for = {(d.get("rip_code"), d.get("wholesaler")): (d.get("member_count") or 0)
                 for d in _details_all}
    by_dist_sorted = {
        k: sorted(v, key=lambda c: (-(_size_for.get((c, k), 0)), c))
        for k, v in by_dist.items()
    }
    return {"query": match, "edition": cym, "matched_count": len(matched), "matched_products": matched[:25],
            "by_distributor": by_dist_sorted, "rip_codes": code_details, "note": note}


def _t_rip_summary(con, args):
    """Per-distributor RIP roll-up: every (wholesaler, rip_code) active in the
    current edition, with the CANONICAL Case-Mix size (distinct catalog SKUs:
    same UPC + different vintage = different item) and the RIP's description.
    Same scoping as the catalog (latest rip edition <= today, joined to the
    latest cpl_enriched per wholesaler, blank/zero UPCs filtered) so the
    counts agree with what the catalog page shows.

    Args:
      distributor: filter to one wholesaler (slug or label).
      min_members: only return clusters with at least N SKUs (default 1).
      limit_per_distributor: cap each distributor's top-N (default 50).
    """
    cym = args.get("month") or _current_ym()
    cym = _resolve_month(con, cym) or cym
    ws = (args.get("distributor") or "").strip().lower() or None
    try:
        min_n = max(1, int(args.get("min_members") or 1))
    except Exception:
        min_n = 1
    try:
        per_dist_cap = max(1, int(args.get("limit_per_distributor") or 50))
    except Exception:
        per_dist_cap = 50
    ws_clause = ""
    ws_params: list = []
    if ws:
        ws_clause = "AND LOWER(wholesaler) = LOWER(?)"
        ws_params = [ws]
    try:
        df = con.execute(
            "WITH cpl_cur AS ("
            f"  SELECT wholesaler, MAX(edition) ed FROM cpl_enriched WHERE edition<='{cym}' GROUP BY wholesaler"
            "), "
            "rip_cur AS ("
            f"  SELECT wholesaler, MAX(edition) ed FROM rip WHERE edition<='{cym}' "
            f"  {ws_clause} GROUP BY wholesaler"
            "), "
            "rip_set AS ("
            "  SELECT r.wholesaler, "
            "         CAST(r.rip_code AS VARCHAR) AS rip_code, "
            "         LTRIM(CAST(r.upc AS VARCHAR), '0') AS upc_n "
            "  FROM rip r JOIN rip_cur rc ON r.wholesaler=rc.wholesaler AND r.edition=rc.ed "
            "  WHERE r.upc IS NOT NULL "
            "    AND CAST(r.upc AS VARCHAR) NOT IN ('', '0', 'None', 'nan') "
            "    AND LTRIM(CAST(r.upc AS VARCHAR), '0') NOT IN ('', 'None', 'nan') "
            "    AND r.rip_code IS NOT NULL "
            "    AND CAST(r.rip_code AS VARCHAR) NOT IN ('', '0', 'None', 'nan') "
            "), "
            "rip_desc AS ("
            "  SELECT wholesaler, CAST(rip_code AS VARCHAR) AS rip_code, "
            "         ANY_VALUE(rip_description) AS description "
            "  FROM rip r JOIN rip_cur rc ON r.wholesaler=rc.wholesaler AND r.edition=rc.ed "
            "  WHERE rip_description IS NOT NULL AND CAST(rip_description AS VARCHAR) <> '' "
            "  GROUP BY 1, 2"
            ") "
            "SELECT rs.wholesaler, rs.rip_code, "
            "       COUNT(DISTINCT (LTRIM(CAST(c.upc AS VARCHAR),'0'), "
            "                       COALESCE(CAST(c.vintage AS VARCHAR),''), "
            "                       COALESCE(c.unit_volume,''), "
            "                       COALESCE(CAST(c.unit_qty AS VARCHAR),''))) AS member_count, "
            "       ANY_VALUE(rd.description) AS description "
            "FROM rip_set rs "
            "JOIN cpl_cur cc ON cc.wholesaler = rs.wholesaler "
            "JOIN cpl_enriched c ON c.wholesaler = cc.wholesaler AND c.edition = cc.ed "
            "                   AND LTRIM(CAST(c.upc AS VARCHAR),'0') = rs.upc_n "
            "LEFT JOIN rip_desc rd ON rd.wholesaler = rs.wholesaler "
            "                     AND rd.rip_code = rs.rip_code "
            "WHERE c.upc IS NOT NULL "
            "  AND LTRIM(CAST(c.upc AS VARCHAR),'0') NOT IN ('', 'None', 'nan') "
            "GROUP BY rs.wholesaler, rs.rip_code "
            "HAVING COUNT(DISTINCT (LTRIM(CAST(c.upc AS VARCHAR),'0'), "
            "                       COALESCE(CAST(c.vintage AS VARCHAR),''), "
            "                       COALESCE(c.unit_volume,''), "
            "                       COALESCE(CAST(c.unit_qty AS VARCHAR),''))) >= ? "
            "ORDER BY rs.wholesaler, member_count DESC, rs.rip_code",
            ws_params + [min_n]).fetchdf()
    except Exception as e:
        return {"error": f"{type(e).__name__}"}
    by_dist: dict = {}
    for _, r in df.iterrows():
        wh = r["wholesaler"]
        by_dist.setdefault(wh, []).append({
            "rip_code": str(r["rip_code"]),
            "member_count": int(r["member_count"]),
            "description": (None if r["description"] is None or
                            (isinstance(r["description"], float) and r["description"] != r["description"])
                            else str(r["description"])),
        })
    # Cap each distributor's list (biggest first already) so a 200+ row distributor
    # doesn't blow the context. Total cluster count surfaced as `total` per group.
    summary: dict = {}
    for wh, lst in by_dist.items():
        summary[wh] = {"total_codes": len(lst), "clusters": lst[:per_dist_cap]}
    return {"edition": cym, "by_distributor": summary,
            "total_codes": sum(len(v) for v in by_dist.values())}


def _ml_of(vol):
    """Parse a unit_volume label ('750 ML', '1.75L', '1 L', '12 OZ') to millilitres."""
    if vol is None:
        return None
    s = str(vol).upper().replace(" ", "")
    m = re.match(r"([0-9]*\.?[0-9]+)\s*(ML|L|LITER|LITRE|OZ)?", s)
    if not m:
        return None
    try:
        num = float(m.group(1))
    except ValueError:
        return None
    unit = m.group(2) or "ML"
    if unit in ("L", "LITER", "LITRE"):
        return num * 1000.0
    if unit == "OZ":
        return num * 29.5735
    return num


def _age_years(name):
    """Best-effort age statement for a spirit from its name (12, 18, 21YR ...).
    An age statement is a distinct product the way a vintage is for wine, so we
    surface it. Prefers an explicit YR/Y/YO suffix; falls back to a bare 8–50
    number that isn't a pack/volume token."""
    if not name:
        return None
    s = str(name).upper()
    m = re.search(r"\b(\d{1,2})\s*(?:YR|YRS|YO|YEARS?)\b", s)
    if m:
        try:
            return int(m.group(1))
        except ValueError:
            return None
    for m in re.finditer(r"\b(\d{1,2})\b(?!\s*(?:P\b|PK|PACK|ML|L\b|OZ|%|/))", s):
        n = int(m.group(1))
        if 8 <= n <= 50:
            return n
    return None


def _rip_per_case_tiers(tier_tuples, pack):
    """[(per_case, qty_in_unit, unit_norm)] for each positive RIP tier. Unit math
    goes through rip_utils so a BOTTLE tier is converted to per-case via `pack`
    (bottles/case) exactly as every other surface does — see FOUNDATION.md §4.1."""
    out = []
    for u, q, a in tier_tuples:
        try:
            qf, af = float(q), float(a)
        except (TypeError, ValueError):
            continue
        if qf != qf or af != af or qf <= 0 or af <= 0:
            continue
        pc = _rip.rip_per_case(af, qf, u, pack)
        if pc <= 0:
            continue
        out.append((round(pc, 2), qf, _rip.normalize_unit(u)))
    return out


def _t_best_one_case_rip(con, args):
    """Best 'buy just ONE case' RIP rebates: rebates whose per-case value buying a
    single case is essentially the same as buying in bulk (e.g. 30 cases), so a
    small buyer isn't penalised. Counts BOTH case-unit tiers (qty<=1 case) and
    bottle-unit tiers (qty<=pack, i.e. reachable with one case's worth of bottles),
    with bottle rebates converted to per-case. Ranked by per-case rebate at one
    case."""
    cym = _current_ym()
    cap = min(int(args.get("limit") or 12), 25)
    dist = (args.get("distributor") or "").strip()
    where = ["CAST(r.rip_code AS VARCHAR) NOT IN ('', '0', 'None', 'nan')"]
    params = [cym, cym]
    if dist:
        where.append("LOWER(r.wholesaler) = LOWER(?)")
        params.append(dist)
    try:
        df = con.execute(f"""
            WITH rcur AS (SELECT wholesaler, MAX(edition) ed FROM rip WHERE edition<=? GROUP BY wholesaler),
                 ccur AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched WHERE edition<=? GROUP BY wholesaler),
                 cpl AS (SELECT c.wholesaler AS w, LTRIM(CAST(c.upc AS VARCHAR),'0') AS un,
                                ANY_VALUE(c.product_name) AS product_name, ANY_VALUE(c.unit_volume) AS unit_volume,
                                ANY_VALUE(c.unit_qty) AS unit_qty, MIN(c.frontline_case_price) AS frontline_case_price,
                                MIN(c.effective_case_price) AS effective_case_price
                         FROM cpl_enriched c JOIN ccur ON c.wholesaler=ccur.wholesaler AND c.edition=ccur.ed
                         GROUP BY 1, 2)
            SELECT r.wholesaler, CAST(r.rip_code AS VARCHAR) AS rip_code, r.rip_description AS descr,
                   LTRIM(CAST(r.upc AS VARCHAR),'0') AS un,
                   r.rip_unit_1 u1, r.rip_qty_1 q1, r.rip_amt_1 a1,
                   r.rip_unit_2 u2, r.rip_qty_2 q2, r.rip_amt_2 a2,
                   r.rip_unit_3 u3, r.rip_qty_3 q3, r.rip_amt_3 a3,
                   r.rip_unit_4 u4, r.rip_qty_4 q4, r.rip_amt_4 a4,
                   cpl.product_name, cpl.unit_volume, cpl.unit_qty,
                   cpl.frontline_case_price, cpl.effective_case_price
            FROM rip r
            JOIN rcur ON r.wholesaler=rcur.wholesaler AND r.edition=rcur.ed
            -- Join by UPC only when it's a REAL barcode (>=10 digits). Placeholder
            -- upcs like '1' (e.g. the FAUST/FAVIA rebate row) would otherwise
            -- collide with any product whose upc also normalises to '1'. Rows
            -- whose upc doesn't join fall back to a name lookup below.
            LEFT JOIN cpl ON cpl.w=r.wholesaler AND cpl.un=LTRIM(CAST(r.upc AS VARCHAR),'0')
                         AND LENGTH(LTRIM(CAST(r.upc AS VARCHAR),'0')) >= 10
            WHERE {' AND '.join(where)}
        """, params).fetchdf()
    except Exception as e:
        return {"error": f"{type(e).__name__}"}

    def _eval(tt, pack):
        """(rebate_at_1, best_per_case) for these tiers bought as ONE case, or None
        if it doesn't qualify as a flat 1-case rebate. Case tiers qualify at
        qty<=1 case; bottle tiers at qty<=pack bottles (one case's worth)."""
        pcs = _rip_per_case_tiers(tt, pack)
        if not pcs:
            return None
        ones = []
        for pc, qf, norm in pcs:
            if norm == "bottle":
                if pack and qf <= pack:
                    ones.append(pc)
            elif qf <= 1:                       # case or implicit-case tier
                ones.append(pc)
        if not ones:
            return None
        rebate_at_1 = max(ones)
        best_pc = max(pc for pc, _q, _n in pcs)
        # "no significant difference between 1 case and 30 cases": the single-case
        # per-case rebate is within ~10% of the best per-case rebate at any quantity.
        if best_pc <= 0 or rebate_at_1 < 0.9 * best_pc:
            return None
        return rebate_at_1, best_pc

    # Pass 1: provisional ranking (pack from the UPC join when present; no-join
    # rows are refined after the name lookup in pass 2).
    cands = []
    for _, row in df.iterrows():
        tt = [(row.get(f"u{j}"), row.get(f"q{j}"), row.get(f"a{j}")) for j in (1, 2, 3, 4)]
        res = _eval(tt, _num(row.get("unit_qty")))
        if res is None:
            continue
        cands.append((res[0], tt, row))
    cands.sort(key=lambda c: c[0], reverse=True)

    deals, seen, name_cache, name_lookups = [], set(), {}, 0
    for _prov, tt, row in cands:
        if len(deals) >= cap:
            break
        pname = row.get("product_name")
        upc = row.get("un")
        eff = _num(row.get("effective_case_price"))
        fr = _num(row.get("frontline_case_price"))
        unit_volume = row.get("unit_volume")
        pack = _num(row.get("unit_qty"))
        # No UPC match (placeholder/short upc on the rebate row) -> resolve the
        # product by the rebate's NAME (rip_description) instead, so the rebate
        # still maps to the right product rather than being dropped. Cached +
        # capped so we never run unbounded per-row lookups.
        if (not pname or (isinstance(pname, float) and pname != pname)):
            descr = row.get("descr")
            descr = str(descr).strip() if descr is not None and str(descr) != "nan" else ""
            if not descr or name_lookups >= 60:
                continue
            if descr not in name_cache:
                name_lookups += 1
                try:
                    hit = _resolve_products(con, {}, descr, "first", 1)
                except Exception:
                    hit = []
                name_cache[descr] = hit[0] if hit else None
            hp = name_cache[descr]
            if not hp:
                continue
            pname = hp.get("product_name")
            upc = str(hp.get("upc") or "").lstrip("0") or upc
            eff = _num(hp.get("effective_case_price"))
            fr = _num(hp.get("frontline_case_price"))
            unit_volume = hp.get("unit_volume") or unit_volume
            pack = _num(hp.get("unit_qty")) or pack
            if not pname:
                continue
        # Recompute bottle-aware with the now-known pack (a name-resolved row's
        # bottle tiers need it to convert to per-case).
        res = _eval(tt, pack)
        if res is None:
            continue
        rebate_at_1, best_pc = res
        # Sanity guard: a per-case rebate can't exceed the case price itself — if
        # it does, the rebate row is bad data or mis-joined, so drop it.
        case_price = fr or eff
        if case_price is not None and rebate_at_1 > case_price:
            continue
        key = (row.get("wholesaler"), upc or pname, row.get("rip_code"))
        if key in seen:
            continue
        seen.add(key)
        descr = row.get("descr")
        deals.append({
            "product_name": pname, "wholesaler": row.get("wholesaler"),
            "upc": upc, "unit_volume": unit_volume,
            "rip_code": row.get("rip_code"),
            "rip_description": str(descr) if descr is not None and str(descr) != "nan" else None,
            "rebate_per_case_at_1": round(rebate_at_1, 2),
            "best_per_case_any_qty": round(best_pc, 2),
            "effective_case_price": eff,
            "frontline_case_price": fr,
            "note": f"${rebate_at_1:.2f}/case rebate on a SINGLE case — same per-case value as buying in bulk.",
        })
    deals.sort(key=lambda d: d["rebate_per_case_at_1"], reverse=True)
    return deals[:cap]


def _t_deal_360(con, args):
    """Deal 360 for ONE item: every angle of its pricing side by side — frontline,
    CPL discount tiers, RIP rebate tiers, any time-sensitive (dated, sub-month)
    promo window, and combo memberships — for THIS month and next, with the
    buy-now-vs-wait recommendation. Built on price_details + dated promos + combos."""
    core = _t_price_details(con, args)
    if isinstance(core, dict) and core.get("error"):
        return core
    view = {"categories": [args["category"]] if args.get("category") else [],
            "divisions": [args["distributor"]] if args.get("distributor") else []}
    prods = _resolve_products(con, view, (args.get("match") or "").strip(), "first", 1)
    p = prods[0] if prods else {}
    ws = p.get("wholesaler")
    un = str(p.get("upc") or "").lstrip("0")
    cym = _current_ym()

    ts = []   # dated (sub-month) promo windows from the RAW cpl
    combos = []
    if ws and un:
        try:
            tdf = con.execute("""
                SELECT CAST(from_date AS DATE) f, CAST(to_date AS DATE) t,
                       frontline_case_price, best_case_price, edition
                FROM cpl
                WHERE wholesaler = ? AND LTRIM(CAST(upc AS VARCHAR),'0') = ?
                  AND from_date IS NOT NULL AND to_date IS NOT NULL
                  AND NOT (EXTRACT(day FROM CAST(from_date AS DATE)) = 1
                           AND CAST(to_date AS DATE) = (date_trunc('month', CAST(to_date AS DATE)) + INTERVAL 1 MONTH - INTERVAL 1 DAY))
                  AND CAST(to_date AS DATE) >= CURRENT_DATE
                ORDER BY f LIMIT 10
            """, [ws, un]).fetchdf()
            for _, r in tdf.iterrows():
                ts.append({"from": str(r["f"])[:10], "to": str(r["t"])[:10],
                           "edition": r["edition"],
                           "list_case_price": _num(r["frontline_case_price"]),
                           "deal_case_price": _num(r["best_case_price"])})
        except Exception:
            pass
        try:
            cdf = con.execute("""
                SELECT DISTINCT CAST(combo_code AS VARCHAR) AS combo_code, combo_pack_price,
                       total_savings, qty_per_pack
                FROM combo
                WHERE wholesaler = ? AND LTRIM(CAST(upc AS VARCHAR),'0') = ? AND edition <= ?
                ORDER BY total_savings DESC NULLS LAST LIMIT 10
            """, [ws, un, cym]).fetchdf()
            for _, r in cdf.iterrows():
                combos.append({"combo_code": r["combo_code"],
                               "pack_price": _num(r["combo_pack_price"]),
                               "total_savings": _num(r["total_savings"]),
                               "qty_per_pack": _num(r["qty_per_pack"])})
        except Exception:
            pass

    core["time_sensitive_windows"] = ts
    core["has_time_sensitive"] = bool(ts)
    core["combo_deals"] = combos
    core["has_combo"] = bool(combos)

    # --- Alcohol-specific identity: brand, category, size (+ml), and the
    # age/vintage that make two otherwise-identical labels DIFFERENT products
    # (vintage for wine, age statement like 12/18YR for spirits). ---
    pname = core.get("product_name")
    brand = category = None
    if ws and pname:
        try:
            mr = con.execute(
                "SELECT ANY_VALUE(brand) b, ANY_VALUE(product_type) t FROM cpl_enriched "
                "WHERE wholesaler=? AND product_name=?", [ws, pname]).fetchone()
            if mr:
                brand, category = mr[0], mr[1]
        except Exception:
            pass
    core["brand"] = brand
    core["category"] = category
    core["size"] = core.get("unit_volume")
    core["size_ml"] = round(_ml_of(core.get("unit_volume")), 1) if _ml_of(core.get("unit_volume")) else None
    core["age_years"] = _age_years(pname)         # spirits age statement
    # vintage already on core for wine
    core["price_after_rip_case"] = core.get("effective_case_price")

    try:
        bpc = float(core.get("bottles_per_case") or 0)
    except (TypeError, ValueError):
        bpc = 0.0
    def _btl(case):
        c = _num(case)
        return round(c / bpc, 2) if (c is not None and bpc) else None
    core["price_after_rip_bottle"] = _btl(core.get("effective_case_price"))

    # --- Last / current / upcoming month price insight (case AND bottle). ---
    hist = core.get("price_history_3mo") or []
    current = {
        "edition": hist[-1]["edition"] if hist else None,
        "list_case": core.get("frontline_case_price"),
        "effective_case": core.get("effective_case_price"),
        "list_bottle": core.get("frontline_bottle_price"),
        "effective_bottle": _btl(core.get("effective_case_price")),
    }
    last_month = None
    if len(hist) >= 2:
        h = hist[-2]
        lc = _num(h.get("effective_case_price"))
        last_month = {"edition": h.get("edition"),
                      "list_case": _num(h.get("frontline_case_price")),
                      "effective_case": lc, "effective_bottle": _btl(lc)}
    next_month = None
    ne_ed = core.get("next_edition")
    if ne_ed and str(ne_ed) != str(current.get("edition")):
        ne = core.get("next_month_case_effective")
        next_month = {"edition": ne_ed, "effective_case": ne, "effective_bottle": _btl(ne)}
    core["months"] = {"last": last_month, "current": current, "upcoming": next_month}
    return core


def _t_size_value(con, args):
    """Size / value efficiency: for a brand or product, the effective price per
    BOTTLE and per LITER (after discounts + RIP) across every size it comes in, so
    the buyer can see when upsizing (e.g. 750ML -> 1L) is nearly free. Ranked by
    best value per litre; also flags near-free upsize opportunities."""
    match = (args.get("match") or "").strip()
    if not match:
        return {"error": "provide a brand or product name in `match`"}
    view = {"categories": [args["category"]] if args.get("category") else [],
            "divisions": [args["distributor"]] if args.get("distributor") else []}
    prods = _resolve_products(con, view, match, "cheapest", 40)
    if not prods:
        return {"error": f"no products matched '{match}'"}
    rows = []
    for p in prods:
        ml = _ml_of(p.get("unit_volume"))
        try:
            uq = float(p.get("unit_qty"))
        except (TypeError, ValueError):
            uq = None
        eff = p.get("effective_case_price")
        eff = float(eff) if (eff is not None and eff == eff) else None
        eff_btl = (eff / uq) if (eff is not None and uq) else None
        per_l = (eff_btl / ml * 1000.0) if (eff_btl is not None and ml) else None
        rows.append({
            "product_name": p.get("product_name"), "wholesaler": p.get("wholesaler"),
            "upc": p.get("upc"), "unit_volume": p.get("unit_volume"),
            "ml": round(ml, 1) if ml else None,
            "bottles_per_case": int(uq) if uq else None,
            "effective_case_price": _num(eff),
            "effective_bottle_price": round(eff_btl, 2) if eff_btl is not None else None,
            "price_per_liter": round(per_l, 2) if per_l is not None else None,
        })
    valued = sorted([r for r in rows if r["price_per_liter"] is not None],
                    key=lambda r: r["price_per_liter"])
    for i, r in enumerate(valued):
        r["value_rank"] = i + 1
    # Near-free upsize: a larger bottle whose per-bottle price is within ~12% of a
    # smaller one — you get materially more volume for almost the same money.
    by_ml = sorted([r for r in valued if r["ml"] and r["effective_bottle_price"]], key=lambda r: r["ml"])
    upsize = []
    for i in range(len(by_ml)):
        for j in range(i + 1, len(by_ml)):
            s, b = by_ml[i], by_ml[j]
            if b["ml"] > s["ml"] and b["effective_bottle_price"] <= s["effective_bottle_price"] * 1.12:
                upsize.append({
                    "from": f'{s["unit_volume"]} @ ${s["effective_bottle_price"]:.2f}/btl',
                    "to": f'{b["unit_volume"]} @ ${b["effective_bottle_price"]:.2f}/btl',
                    "extra_volume_pct": round((b["ml"] / s["ml"] - 1) * 100),
                    "price_premium_pct": round((b["effective_bottle_price"] / s["effective_bottle_price"] - 1) * 100),
                })
    return {"query": match, "count": len(valued),
            "by_value_per_liter": valued[: min(int(args.get("limit") or 20), 40)],
            "best_value": valued[0] if valued else None,
            "upsize_opportunities": upsize[:10]}


def _t_rip_tier_gap(con, args):
    """'Almost there' RIP tier gap: for a brand/product (or RIP code) and how many
    cases the buyer already plans, show the rebate tier ladder (BOTH case and
    bottle tiers, bottle rebates converted to per-case), how many MORE cases/
    bottles reach each tier, and the next tier to aim for."""
    code = str(args.get("rip_code") or "").strip()
    match = (args.get("match") or "").strip()
    try:
        have = float(args.get("have") if args.get("have") is not None else args.get("current_cases") or 0)
    except (TypeError, ValueError):
        have = 0.0
    cym = _current_ym()
    ws = None
    members = []
    pack = None
    if code and code not in ("0", "None", "nan"):
        desc, traw = _rip_tiers_for(con, code)
        tiers = [{"qty": t["qty"], "unit": t["unit"], "amount": t["amount"]} for t in traw]
    else:
        if not match:
            return {"error": "provide a brand/product `match` or a `rip_code`."}
        rl = _t_rip_lookup(con, {"match": match})
        if isinstance(rl, dict) and rl.get("error"):
            return rl
        codes = (rl or {}).get("rip_codes") or []
        if not codes:
            return {"query": match, "note": (rl or {}).get("note") or f"No RIP rebate found for '{match}'."}
        codes.sort(key=lambda c: (c.get("best_rebate") or 0), reverse=True)
        chosen = codes[0]
        code, ws, desc = chosen.get("rip_code"), chosen.get("wholesaler"), chosen.get("description")
        tiers = chosen.get("tiers") or []
        members = chosen.get("case_mix_members") or []
        hit = _resolve_products(con, {}, match, "first", 1)
        if hit:
            pack = _num(hit[0].get("unit_qty"))
    # bottles/case needed to convert bottle tiers and bottle thresholds to cases.
    if pack is None and code:
        try:
            prow = con.execute(
                "WITH cur AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched WHERE edition<=? GROUP BY wholesaler), "
                "ripupc AS (SELECT DISTINCT wholesaler, LTRIM(CAST(upc AS VARCHAR),'0') un FROM rip "
                "WHERE CAST(rip_code AS VARCHAR)=? AND edition = "
                "(SELECT MAX(edition) FROM rip WHERE CAST(rip_code AS VARCHAR)=? AND edition<=?) "
                "  AND upc IS NOT NULL "
                "  AND CAST(upc AS VARCHAR) NOT IN ('', '0', 'None', 'nan') "
                "  AND LTRIM(CAST(upc AS VARCHAR), '0') NOT IN ('', 'None', 'nan')) "
                "SELECT ANY_VALUE(c.unit_qty) FROM cpl_enriched c JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed "
                "JOIN ripupc r ON r.wholesaler=c.wholesaler AND r.un=LTRIM(CAST(c.upc AS VARCHAR),'0') "
                "WHERE c.upc IS NOT NULL "
                "  AND LTRIM(CAST(c.upc AS VARCHAR), '0') NOT IN ('', 'None', 'nan')",
                [cym, str(code), str(code), cym]).fetchone()
            if prow:
                pack = _num(prow[0])
        except Exception:
            pass

    def _ck(t):   # cases-equivalent commitment, for ordering the ladder
        q = _num(t.get("qty")) or 0
        return q / pack if (_rip.normalize_unit(t.get("unit")) == "bottle" and pack) else q
    valid = [t for t in tiers if _num(t.get("qty")) and _num(t.get("amount"))]
    valid.sort(key=_ck)
    ladder, next_tier = [], None
    for t in valid:
        norm = _rip.normalize_unit(t.get("unit"))
        q, a = float(t["qty"]), float(t["amount"])
        per_case = _rip.rip_per_case(a, q, t.get("unit"), pack)
        if norm == "bottle":
            unit_label = "bottles"
            have_in_unit = have * pack if pack else None
            more = max(0.0, q - have_in_unit) if have_in_unit is not None else None
            more_cases = round(more / pack, 1) if (more is not None and pack) else None
        else:
            unit_label = "cases"
            have_in_unit = have
            more = max(0.0, q - have)
            more_cases = round(more, 1)
        ladder.append({
            "buy_qty": q, "unit": unit_label, "rebate": round(a, 2),
            "per_case": round(per_case, 2),
            "more_needed": (round(more, 1) if more is not None else None),
            "more_cases_equiv": more_cases,
        })
        if next_tier is None and have_in_unit is not None and have_in_unit < q:
            next_tier = {"buy_qty": q, "unit": unit_label, "rebate": round(a, 2),
                         "more_needed": round(more, 1) if more is not None else None,
                         "more_cases_equiv": more_cases}
    if not ladder:
        note = f"No usable rebate tiers found for '{match or code}'."
    elif next_tier:
        mc = next_tier.get("more_cases_equiv")
        more_txt = (f"{next_tier['more_needed']:.0f} more {next_tier['unit']}"
                    + (f" (~{mc:.0f} case(s))" if (next_tier['unit'] == 'bottles' and mc) else ""))
        note = (f"With {have:.0f} case(s) planned, buy {more_txt} to unlock the "
                f"${next_tier['rebate']:.2f} rebate.")
    else:
        note = f"With {have:.0f} case(s) you're already at the top tier."
    return {"rip_code": code, "wholesaler": ws, "description": desc, "cases_planned": have,
            "bottles_per_case": pack, "tier_ladder": ladder, "next_tier": next_tier,
            "case_mix_members": members[:15], "note": note}


def _t_distributor_arbitrage(con, args):
    """Catalog-wide cross-distributor arbitrage: same product (UPC) carried by 2+
    distributors, ranked by how much cheaper the cheapest is vs the dearest
    (effective case price). Surfaces 'buy this from X, not Y' opportunities."""
    cym = _current_ym()
    cap = min(int(args.get("limit") or 15), 30)
    cat = (args.get("category") or "").strip()
    try:
        min_pct = float(args.get("min_savings_pct") or 0)
    except (TypeError, ValueError):
        min_pct = 0.0
    where = ["c.effective_case_price IS NOT NULL", "c.effective_case_price > 0",
             "c.upc IS NOT NULL", "LTRIM(CAST(c.upc AS VARCHAR),'0') NOT IN ('', '0')"]
    # Exclude $0/near-free stocking rows so a free-with-purchase price doesn't
    # manufacture a fake 'biggest gap' (unless the caller opts in).
    if not bool(args.get("include_stocking_deals")):
        where.append(f"(c.frontline_case_price IS NULL OR c.frontline_case_price <= 0 "
                     f"OR c.effective_case_price >= c.frontline_case_price * {_STOCKING_FLOOR_PCT})")
    params = [cym]
    if cat:
        where.append("UPPER(c.product_type) = UPPER(?)")
        params.append(cat)
    try:
        df = con.execute(f"""
            WITH cur AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched WHERE edition<=? GROUP BY wholesaler),
                 base AS (SELECT LTRIM(CAST(c.upc AS VARCHAR),'0') AS un, c.wholesaler AS w,
                                 ANY_VALUE(c.product_name) AS pn, ANY_VALUE(c.unit_volume) AS uv,
                                 MIN(c.effective_case_price) AS eff
                          FROM cpl_enriched c JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed
                          WHERE {' AND '.join(where)}
                          GROUP BY 1, 2)
            SELECT un, ANY_VALUE(pn) AS product_name, ANY_VALUE(uv) AS unit_volume,
                   COUNT(DISTINCT w) AS distributors,
                   MIN(eff) AS cheapest_price, MAX(eff) AS dearest_price,
                   ARG_MIN(w, eff) AS cheapest_distributor, ARG_MAX(w, eff) AS dearest_distributor
            FROM base GROUP BY un HAVING COUNT(DISTINCT w) >= 2
        """, params).fetchdf()
    except Exception as e:
        return {"error": f"{type(e).__name__}"}
    out = []
    for _, r in df.iterrows():
        cheap, dear = r["cheapest_price"], r["dearest_price"]
        if cheap is None or dear is None or dear <= 0:
            continue
        savings = dear - cheap
        pct = savings / dear * 100 if dear else 0
        if savings <= 0.01 or pct < min_pct:
            continue
        # Anomaly guard: a same-UPC gap this extreme is bad data, not arbitrage.
        if cheap > 0 and dear > cheap * _ARBITRAGE_MAX_RATIO and not args.get("include_anomalies"):
            continue
        out.append({
            "product_name": r["product_name"], "upc": r["un"], "unit_volume": r["unit_volume"],
            "wholesaler": r["cheapest_distributor"],         # cheapest source (for the card)
            "effective_case_price": round(float(cheap), 2),  # buy-here price
            "frontline_case_price": round(float(dear), 2),   # vs dearest (shown struck through)
            "cheapest_distributor": r["cheapest_distributor"], "cheapest_price": round(float(cheap), 2),
            "dearest_distributor": r["dearest_distributor"], "dearest_price": round(float(dear), 2),
            "savings_per_case": round(float(savings), 2), "savings_pct": round(float(pct), 1),
            "distributors": int(r["distributors"]),
        })
    out.sort(key=lambda d: d["savings_per_case"], reverse=True)
    return out[:cap]


def _t_best_gp_deals(con, args):
    """Best gross-profit deals: products ranked by GP% (CPL+RIP savings vs list).
    Delegates to pricing.rank_best_deals so the ranking is the SAME definition
    every surface uses. Stocking-deal floor defaults to 10% — a 100%-off
    liquidation no longer crowns the list. Pass include_stocking_deals=True
    to opt back in; pass min_pct to require deeper savings still."""
    include_stocking = bool(args.get("include_stocking_deals"))
    floor = None if include_stocking else _STOCKING_FLOOR_PCT
    rows = _pricing.rank_best_deals(
        con,
        kind="gp_pct",
        min_effective_pct_of_frontline=floor,
        category=(args.get("category") or "").strip() or None,
        distributor=(args.get("distributor") or "").strip() or None,
        limit=int(args.get("limit") or 12),
    )
    # Optional secondary filter — caller may want gp_pct >= N% on top of the
    # stocking floor (e.g. "deals at least 20% off"). Applied after the SQL
    # because the ranker already surfaces gp_pct in each row.
    try:
        min_pct = float(args.get("min_pct") or 0)
    except (TypeError, ValueError):
        min_pct = 0.0
    if min_pct > 0:
        rows = [r for r in rows if (r.get("gp_pct") or 0) >= min_pct]
    return rows


def _t_closeouts(con, args):
    """Closeout / last-chance buys, ranked by savings via pricing.rank_best_deals.
    Stocking-deal floor defaults to 10% so a $0/cs 'free with purchase' clear
    doesn't dominate. Pass include_stocking_deals=True to include those."""
    include_stocking = bool(args.get("include_stocking_deals"))
    floor = None if include_stocking else _STOCKING_FLOOR_PCT
    return _pricing.rank_best_deals(
        con,
        kind="closeout",
        min_effective_pct_of_frontline=floor,
        category=(args.get("category") or "").strip() or None,
        distributor=(args.get("distributor") or "").strip() or None,
        limit=int(args.get("limit") or 15),
    )


def _t_semantic_search(con, args):
    """Free-text semantic catalog search over the enrichment corpus.

    Layer #3 of the assistant's semantic stack. Use for descriptive phrases
    that don't map cleanly to a structured region/varietal slot - 'old vine
    zinfandel from a cool climate', 'high altitude napa cabernet', 'small-
    producer natural orange wine'. Returns ranked product cards with a
    relevance score so the answer can cite the top hits."""
    from backend.semantic_search import semantic_search as _ss
    from backend.pg import get_pg
    q = (args.get("q") or args.get("query") or "").strip()
    limit = int(args.get("limit") or 12)
    pt = (args.get("product_type") or "").strip() or None
    if not q:
        return []
    try:
        with get_pg() as pg:
            rows = _ss(pg, con, q, limit=limit, product_type=pt)
    except Exception as e:
        import logging
        logging.getLogger("assistant").warning("semantic_search failed: %s", e)
        return []
    # Drop $0/near-free stocking rows so semantic matches don't surface a
    # free-with-purchase row as '100% off' (unless the caller opts in).
    if not bool(args.get("include_stocking_deals")):
        rows = [r for r in (rows or []) if not _is_stocking_row(r)]
    return rows


def _t_combo_deals(con, args):
    """COMBO / BUNDLE deals (a whole product type the other tools don't cover):
    one row per combo with its pack price, total savings and component list, this
    month vs next. Optional q (brand/keyword) and distributor. Use for 'what
    combos / bundles are there', 'combo deals on X', 'is there a bundle for Y'."""
    from backend.routers.deals import get_combos
    try:
        return get_combos(wholesaler=(args.get("distributor") or None),
                          q=(args.get("q") or ""), limit=min(int(args.get("limit") or 15), 50))
    except Exception as e:
        return {"error": f"{type(e).__name__}"}


def _combo_qty_bottles(qty_per_pack, bottles_per_case):
    """(cases, bottles) a combo requires of a component. qty_per_pack is like
    '3   C' (3 cases), '24 bottle', or a bare '48' (Fedway stores bottles). A
    trailing 'c' (C / cs / case / cases) means CASES — anything else (bottle/btl
    or blank) means BOTTLES, with the missing unit derived via bottles/case."""
    s = str(qty_per_pack or "").strip().lower()
    m = re.match(r"(\d+(?:\.\d+)?)", s)
    if not m:
        return (None, None)
    n = float(m.group(1))
    rest = s[m.end():].strip()
    bpc = bottles_per_case if (bottles_per_case and bottles_per_case > 0) else None
    # 'case'/'cs'/'c' contain 'c'; 'bottle'/'btl' do not.
    if "c" in rest:
        return (n, (n * bpc) if bpc else None)
    return ((n / bpc) if bpc else None, n)


def _t_combo_analyzer(con, args):
    """Analyze whether COMBO / bundle deals are actually WORTH taking: for each
    combo, compare the combo pack price against (a) frontline and (b) the
    best-separate price — buying each component on its OWN best CPL discount + RIP
    with NO combo. Returns net advantage vs separate, % saved, the forced-quantity
    caveat and a worth-it verdict, ranked best-first. Use for 'is this combo worth
    it', 'analyze combo deals', 'should I take the bundle', 'combo vs buying
    separately'. Optional q (brand/keyword), distributor, combo_code, limit."""
    from backend.routers.deals import get_combos
    cym = _current_ym()
    code = str(args.get("combo_code") or "").strip()
    # Analyze EVERY matching combo (no silent cap — there are ~1,000+). A full
    # fetch is fast (~0.3s); the template summarizes + ranks, so scale is fine.
    _lim = int(args.get("limit") or 0)
    try:
        combos = get_combos(wholesaler=(args.get("distributor") or None),
                            q=(args.get("q") or ""), limit=(_lim if _lim > 0 else 100000))
    except Exception as e:
        return {"error": f"{type(e).__name__}"}
    if code:
        combos = [c for c in combos if str(c.get("combo_code")) == code]
    if not combos:
        return {"count": 0, "combos": [], "note": "No combos matched."}
    # Economics are computed once by deals.compute_combo_economics (attached by
    # get_combos), so the combo PAGE and this analyzer agree exactly. Pull each
    # combo's economics, rank most worth-it first, and tally the verdicts.
    analyzed = [c["economics"] for c in combos if isinstance(c.get("economics"), dict)]
    analyzed.sort(key=lambda x: (x.get("save_vs_separate") is None, -(x.get("save_vs_separate") or 0)))
    vc = {"worth_it": 0, "marginal": 0, "buy_separately": 0, "unknown": 0}
    for a in analyzed:
        vc[a.get("verdict", "unknown")] = vc.get(a.get("verdict", "unknown"), 0) + 1
    return {"count": len(analyzed), "verdict_counts": vc, "combos": analyzed}


def _t_category_distributor_compare(con, args):
    """Which distributor is best for a whole CATEGORY: per distributor, the count,
    average effective case price, and # with a discount / RIP for that category
    (current edition). Use for 'who's cheapest for wine', 'best distributor for
    spirits', 'compare distributors for tequila'."""
    cat = (args.get("category") or "").strip()
    if not cat:
        return {"error": "provide a `category` (e.g. Wine, Spirits, Beer)"}
    cym = _current_ym()
    try:
        df = con.execute(
            f"WITH cur AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched WHERE edition<='{cym}' GROUP BY wholesaler) "
            "SELECT c.wholesaler AS distributor, COUNT(*) AS products, "
            "ROUND(AVG(c.effective_case_price), 2) AS avg_effective_case, "
            "ROUND(MIN(c.effective_case_price), 2) AS cheapest_case, "
            "SUM(CASE WHEN c.has_discount THEN 1 ELSE 0 END) AS with_discount, "
            "SUM(CASE WHEN c.has_rip THEN 1 ELSE 0 END) AS with_rip "
            "FROM cpl_enriched c JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed "
            "WHERE UPPER(c.product_type)=UPPER(?) AND c.effective_case_price IS NOT NULL "
            "GROUP BY 1 ORDER BY avg_effective_case ASC NULLS LAST", [cat]).fetchdf()
    except Exception as e:
        return {"error": f"{type(e).__name__}"}
    return {"category": cat, "by_distributor": _json_safe(df.to_dict(orient="records"))}


def _t_deals_by_category(con, args):
    """Which CATEGORIES have the most / deepest deals this edition: per category,
    total products, # discounted, average discount %, # with RIP, # closeouts —
    ranked by discounted count. Use for 'which category has the deepest deals',
    'where are the most discounts', 'best category to buy on deal'."""
    cym = _current_ym()
    try:
        df = con.execute(
            f"WITH cur AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched WHERE edition<='{cym}' GROUP BY wholesaler) "
            "SELECT c.product_type AS category, COUNT(*) AS products, "
            "SUM(CASE WHEN c.has_discount THEN 1 ELSE 0 END) AS discounted, "
            "ROUND(AVG(CASE WHEN c.has_discount THEN c.discount_pct END), 1) AS avg_discount_pct, "
            "SUM(CASE WHEN c.has_rip THEN 1 ELSE 0 END) AS with_rip, "
            "SUM(CASE WHEN c.has_closeout THEN 1 ELSE 0 END) AS closeouts "
            "FROM cpl_enriched c JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed "
            "WHERE c.product_type IS NOT NULL "
            "GROUP BY 1 ORDER BY discounted DESC NULLS LAST", []).fetchdf()
    except Exception as e:
        return {"error": f"{type(e).__name__}"}
    return {"by_category": _json_safe(df.to_dict(orient="records"))}


def _btl_price(r):
    """Effective per-bottle price for a catalogue row, or None."""
    eff = _num(r.get("effective_case_price"))
    try:
        uq = float(r.get("unit_qty"))
    except (TypeError, ValueError):
        uq = None
    return round(eff / uq, 2) if (eff is not None and uq) else None


def _product_type_of(con, name, upc=None):
    """Look up a product's category (product_type) from the catalogue."""
    try:
        un = str(upc or "").lstrip("0")
        if un:
            row = con.execute(
                "WITH latest AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched GROUP BY wholesaler) "
                "SELECT ANY_VALUE(c.product_type) FROM cpl_enriched c JOIN latest l "
                "ON c.wholesaler=l.wholesaler AND c.edition=l.ed WHERE LTRIM(CAST(c.upc AS VARCHAR),'0')=?", [un]).fetchone()
            if row and row[0]:
                return str(row[0])
        if name:
            row = con.execute("SELECT ANY_VALUE(product_type) FROM cpl_enriched WHERE product_name=?", [name]).fetchone()
            if row and row[0]:
                return str(row[0])
    except Exception:
        pass
    return None


def _t_build_assortment(con, args):
    """ASSORTMENT BUILDER: a curated, priced shortlist for a natural-language
    brief ('by-the-glass cool-climate pinots under $18/btl', 'value bourbons for a
    well'), honoring max_bottle_price / max_case_price. Uses semantic search, then
    a structured varietal/region fallback. Returns product cards."""
    q = (args.get("q") or args.get("query") or "").strip()
    limit = min(int(args.get("limit") or 15), 40)
    pt = (args.get("category") or args.get("product_type") or "").strip() or None
    max_btl = _num(args.get("max_bottle_price"))
    max_cs = _num(args.get("max_case_price"))
    rows = _t_semantic_search(con, {"q": q, "limit": 60, "product_type": pt}) if q else []
    if not rows:
        view = {"categories": [pt] if pt else [], "varietal": args.get("varietal"), "region": args.get("region")}
        rows = _resolve_products(con, view, q, "cheapest", 60, exclude_stocking=True)
    out = []
    for r in rows:
        eff = _num(r.get("effective_case_price"))
        btl = _btl_price(r)
        if max_cs is not None and (eff is None or eff > max_cs):
            continue
        if max_btl is not None and (btl is None or btl > max_btl):
            continue
        out.append({k: r.get(k) for k in ("product_name", "wholesaler", "upc", "unit_volume", "unit_qty",
                                          "vintage", "effective_case_price", "frontline_case_price")}
                   | {"effective_bottle_price": btl})
        if len(out) >= limit:
            break
    return out


def _t_find_substitute(con, args):
    """SUBSTITUTION FINDER: given a product that's gone or too pricey (`match`),
    the closest in-stock alternatives by style/category at a similar-or-lower
    price. Returns ranked product cards."""
    match = (args.get("match") or "").strip()
    if not match:
        return {"error": "name the product to replace in `match`"}
    prods = _resolve_products(con, {}, match, "first", 1)
    if not prods:
        return {"error": f"no product matched '{match}'"}
    p = prods[0]
    eff = _num(p.get("effective_case_price"))
    cat = _product_type_of(con, p.get("product_name"), p.get("upc"))
    pun = str(p.get("upc") or "").lstrip("0")
    ceil_cs = _num(args.get("max_case_price")) or (round(eff * 1.1, 2) if eff is not None else None)
    rows = _t_semantic_search(con, {"q": match, "limit": 40, "product_type": cat}) or []
    if not rows:
        rows = _resolve_products(con, {"categories": [cat] if cat else []}, match, "cheapest", 40, exclude_stocking=True)
    out = []
    for r in rows:
        run = str(r.get("upc") or "").lstrip("0")
        if run and run == pun:
            continue   # not the same product
        reff = _num(r.get("effective_case_price"))
        if ceil_cs is not None and (reff is None or reff > ceil_cs):
            continue
        out.append({k: r.get(k) for k in ("product_name", "wholesaler", "upc", "unit_volume", "unit_qty",
                                          "vintage", "effective_case_price", "frontline_case_price")}
                   | {"effective_bottle_price": _btl_price(r)})
        if len(out) >= 12:
            break
    return {"replacing": p.get("product_name"), "category": cat,
            "original_effective_case": round(eff, 2) if eff is not None else None,
            "price_ceiling_case": ceil_cs, "alternatives": out}


def _t_build_budget_basket(con, args):
    """BUDGET BASKET: build the best order that fits a $ budget. Greedily fills
    from the top-ranked deals (by GP% or total savings, with the stocking floor
    on) at 1 case each until the budget is reached. Optional category/distributor.
    Returns the basket + total spend, total savings, and remaining budget."""
    budget = _num(args.get("budget"))
    if not budget or budget <= 0:
        return {"error": "provide a positive `budget`"}
    rank = (args.get("rank_by") or "gp").lower()
    kind = "savings" if rank in ("savings", "save", "saving") else "gp_pct"
    try:
        rows = _pricing.rank_best_deals(
            con, kind, category=(args.get("category") or None),
            distributor=(args.get("distributor") or None),
            min_effective_pct_of_frontline=_STOCKING_FLOOR_PCT, limit=300)
    except Exception as e:
        return {"error": f"{type(e).__name__}"}
    basket, spent, saved = [], 0.0, 0.0
    for r in rows:
        eff = _num(r.get("effective_case_price"))
        if eff is None or eff <= 0 or spent + eff > budget:
            continue
        basket.append({k: r.get(k) for k in ("product_name", "wholesaler", "upc", "unit_volume", "unit_qty",
                                             "vintage", "effective_case_price", "frontline_case_price")}
                      | {"cases": 1})
        spent += eff
        sv = _num(r.get("total_savings_per_case"))
        if sv:
            saved += sv
        if spent >= budget * 0.985 or len(basket) >= 60:
            break
    return {"budget": round(budget, 2), "line_count": len(basket),
            "total_spend": round(spent, 2), "total_savings": round(saved, 2),
            "remaining": round(budget - spent, 2), "ranked_by": kind, "basket": basket,
            "note": "Add all with perform_action(type=add_to_cart) on each, or refine the brief."}


def _t_dated_deal_reminders(con, args):
    """DATED-DEAL REMINDERS: dated (sub-month) promos whose window STARTS or ENDS
    within `within_days` (default 7) of today — the easy-to-miss short windows.
    Reads the already-ingested raw cpl (where the dated promo rows live). Returns
    product cards tagged 'Starts in N days' / 'Ends in N days'."""
    days = max(1, min(int(args.get("within_days") or 7), 31))
    dist = (args.get("distributor") or "").strip()
    where = [
        "from_date IS NOT NULL", "to_date IS NOT NULL",
        "NOT (EXTRACT(day FROM CAST(from_date AS DATE)) = 1 "
        "AND CAST(to_date AS DATE) = (date_trunc('month', CAST(to_date AS DATE)) + INTERVAL 1 MONTH - INTERVAL 1 DAY))",
        f"(CAST(to_date AS DATE) BETWEEN CURRENT_DATE AND CURRENT_DATE + {days} "
        f"OR CAST(from_date AS DATE) BETWEEN CURRENT_DATE AND CURRENT_DATE + {days})",
    ]
    params = []
    if dist:
        where.append("LOWER(wholesaler) = LOWER(?)")
        params.append(dist)
    try:
        df = con.execute(
            "WITH latest AS (SELECT wholesaler, MAX(edition) ed FROM cpl GROUP BY wholesaler) "
            "SELECT c.wholesaler, c.product_name, CAST(c.upc AS VARCHAR) upc, c.unit_volume, c.unit_qty, "
            "CAST(c.from_date AS DATE) f, CAST(c.to_date AS DATE) t, "
            "c.frontline_case_price fcp, c.best_case_price bcp, "
            "date_diff('day', CURRENT_DATE, CAST(c.from_date AS DATE)) starts_in, "
            "date_diff('day', CURRENT_DATE, CAST(c.to_date AS DATE)) ends_in "
            "FROM cpl c JOIN latest l ON c.wholesaler=l.wholesaler AND c.edition=l.ed "
            f"WHERE {' AND '.join(where)} ORDER BY t ASC LIMIT 200", params).fetchdf()
    except Exception as e:
        return {"error": f"{type(e).__name__}"}
    seen, out = set(), []
    for _, r in df.iterrows():
        key = (r["wholesaler"], str(r["upc"]).lstrip("0"), str(r["f"]), str(r["t"]))
        if key in seen:
            continue
        seen.add(key)
        try:
            si, ei = int(r["starts_in"]), int(r["ends_in"])
        except (TypeError, ValueError):
            continue
        if si > 0:
            reminder = f"Starts in {si} day{'s' if si != 1 else ''}"
        elif ei >= 0:
            reminder = f"Ends in {ei} day{'s' if ei != 1 else ''}"
        else:
            continue
        out.append({"product_name": r["product_name"], "wholesaler": r["wholesaler"],
                    "upc": str(r["upc"]), "unit_volume": r["unit_volume"], "unit_qty": r["unit_qty"],
                    "from": str(r["f"])[:10], "to": str(r["t"])[:10],
                    "starts_in_days": max(si, 0), "ends_in_days": ei, "reminder": reminder,
                    "effective_case_price": _num(r["bcp"]), "frontline_case_price": _num(r["fcp"])})
        if len(out) >= 40:
            break
    return out


_DATA_TOOLS = {
    "category_breakdown": (_t_category_breakdown, "Product counts and average case price per category (current edition)."),
    "price_timeline": (_t_price_timeline, "Month-over-month price comparison for ONE product across editions. Follows the product by UPC (stable across editions even when the name changes) and returns, per distributor, a per-edition series of frontline + effective case price, RIP savings and discount flag, each with the month-over-month delta and %, plus a summary (cheapest / dearest month, net change, latest vs prior, trend up/down/flat). Use for ANY 'price over months / over time', 'how has X's price changed', 'compare X prices across months', 'price history/trend for X'. Pass `distributor` to focus one supplier and `months` to cap recent editions. A line chart of effective $/case over months is attached automatically."),
    "rip_lookup": (_t_rip_lookup, "RIP rebate lookup by brand/product NAME (e.g. 'sutter home') or by a RIP code. A UPC can have MULTIPLE codes and codes differ BY DISTRIBUTOR; returns matched products (each with all its codes), a by_distributor code map, and per-code tiers + description + product count. Use for any 'what RIP / rebate / RIP code' question. Pass month='May' / '2026-05' when the user names a month, so a rebate from a past edition that has since expired is still found (rebates change every edition)."),
    "rip_summary": (_t_rip_summary, "Per-distributor RIP roll-up: every (wholesaler, rip_code) active in the current edition with the Case-Mix size (distinct catalog SKUs; same UPC + different vintage counts as a different item) and the RIP description. Use for 'by distributor show every RIP and case-mix size', 'how many products per RIP', 'rip codes per distributor with item counts'. Args: distributor (filter to one wholesaler), min_members (default 1), limit_per_distributor (default 50)."),
    "compare_distributors": (_t_compare_distributors, "Side-by-side price comparison of ONE product across all distributors carrying it. `match` = UPC or product name (UPC is resolved). Returns each distributor's case/effective price + savings; shown as a table and the rows as add-to-cart cards."),
    "distributor_breakdown": (_t_distributor_breakdown, "Per-distributor product counts, avg case price, and #with RIP/discount."),
    "deal_counts": (_t_deal_counts, "Totals: products, #with RIP, #with discount, #closeouts."),
    "top_products": (_t_top_products, "Resolve matching products. Args: match, category, distributor, has_rip, has_discount, price_min, price_max, order_by(cheapest|expensive), limit."),
    "price_history": (_t_price_history, "Price history across editions for the product matching `match`."),
    "price_details": (_t_price_details, "FULL price breakdown for ONE product (call this for any 'price'/'pricing'/'cost'/'deal' question about a specific product): frontline case & bottle price, discount tiers, RIP tiers, effective price, bottles/case, 3-month history."),
    "best_one_case_rip": (_t_best_one_case_rip, "BEST 'buy just one case' RIP rebates — rebates whose per-case value at a SINGLE case is essentially the same as buying in bulk (e.g. 30 cases), so a small buyer isn't penalised. Ranked by per-case rebate at 1 case. Optional: distributor, limit. Use for 'best 1 case RIP deal', 'RIP deals worth it on one case', 'no-bulk RIP rebates'."),
    "deal_360": (_t_deal_360, "COMPREHENSIVE alcohol pricing for ONE item — use for ANY product price/pricing/cost/deal/'tell me about' question. Returns size (+ml) & bottles/case, case AND bottle price, vintage (wine) + age_years (spirits), CPL discount tiers, RIP code+tiers+best rebate, price_after_rip (case & bottle), time-sensitive windows, combo deals, and a months map (last/current/upcoming case & bottle prices) with buy-now-vs-wait. Auto-attaches waterfall + last->now->next line charts."),
    "size_value": (_t_size_value, "SIZE / VALUE efficiency for a brand/product: effective price per BOTTLE and per LITER (after discounts + RIP) across every size, ranked by best value-per-litre, plus near-free UPSIZE opportunities (e.g. when 750ML and 1L cost almost the same per bottle). Use for 'best value size', 'price per liter', '750 vs 1L', 'is the bigger bottle worth it'."),
    "rip_tier_gap": (_t_rip_tier_gap, "'Almost there' RIP tier gap for a brand/product (or rip_code), given optional cases the buyer plans (`have`): the rebate tier ladder, how many MORE cases reach each tier, the incremental rebate for stretching, and the next tier to aim for. Use for 'how close am I to the next rebate', 'worth buying more to hit the tier'."),
    "distributor_arbitrage": (_t_distributor_arbitrage, "Catalog-wide cross-distributor arbitrage: same product (UPC) sold by 2+ distributors, ranked by how much cheaper the cheapest is vs the dearest (effective case price). Optional category, min_savings_pct. Use for 'where can I save by switching distributor', 'biggest price gaps between distributors'."),
    "best_gp_deals": (_t_best_gp_deals, "Best gross-profit deals: products ranked by discount depth / GP% (savings vs list). Optional category, distributor, min_pct. Use for 'best margin deals', 'highest GP%', 'deepest discounts by percent'."),
    "closeouts": (_t_closeouts, "Closeout / last-chance buys being cleared this edition (won't return next month), ranked by savings. Optional category, distributor. Use for 'closeouts', 'last chance', 'what's being discontinued/cleared'."),
    "build_assortment": (_t_build_assortment, "ASSORTMENT BUILDER: a curated priced shortlist for a natural-language brief (q), honoring max_bottle_price / max_case_price (+ optional category/varietal/region). Use for 'build a by-the-glass list of cool-climate pinots under $18/btl', 'a value bourbon well', 'a sparkling list under $X'. Returns product cards."),
    "find_substitute": (_t_find_substitute, "SUBSTITUTION FINDER: given a product that's gone or too pricey (match), the closest in-stock alternatives by style/category at a similar-or-lower price (optional max_case_price). Use for 'X is too expensive, what's a close swap', 'alternative to Y', 'something like Z but cheaper'."),
    "build_budget_basket": (_t_build_budget_basket, "BUDGET BASKET: build the best order that fits a $ budget (required `budget`), greedily from the top deals by GP% (rank_by='gp', default) or total savings (rank_by='savings'), optional category/distributor. Returns the basket + total spend, total savings, remaining. Use for 'build me a $5,000 order, best margins', 'fill a $2k tequila order with the deepest discounts'."),
    "dated_deal_reminders": (_t_dated_deal_reminders, "DATED-DEAL REMINDERS: dated (sub-month) promos whose window STARTS or ENDS within `within_days` (default 7), optional distributor — the easy-to-miss short windows, tagged 'Starts/Ends in N days'. Use for 'what deals start or end soon', 'any short-window deals this week', 'expiring deals'."),
    "combo_deals": (_t_combo_deals, "COMBO / BUNDLE deals: one row per combo with pack price, total savings and components (this month vs next). Optional q (brand/keyword), distributor. Use for 'what combos/bundles are there', 'combo deals on X', 'is there a bundle for Y'."),
    "combo_analyzer": (_t_combo_analyzer, "COMBO WORTH-IT ANALYZER: for each combo, compares the pack price against (a) frontline and (b) the best-SEPARATE price (buying each component on its OWN best discount + RIP, no combo). Returns net advantage vs separate, % saved, the forced-quantity caveat and a worth-it verdict, ranked best-first. Use for 'is this combo worth it', 'analyze the combo(s)', 'should I take the bundle', 'combo vs buying separately'. Optional q (brand/keyword), distributor, combo_code, limit."),
    "category_distributor_compare": (_t_category_distributor_compare, "Which distributor is best for a whole CATEGORY (required `category`): per distributor count, avg + cheapest effective case price, # with discount/RIP. Use for 'who's cheapest for wine', 'best distributor for spirits'."),
    "deals_by_category": (_t_deals_by_category, "Which CATEGORIES have the most/deepest deals this edition: per category total, # discounted, avg discount %, # RIP, # closeouts, ranked by discounted count. Use for 'which category has the deepest deals', 'where are the most discounts'."),
    "semantic_search": (_t_semantic_search, "FREE-TEXT semantic search over the enrichment corpus. USE this for descriptive natural-language queries that DON'T map to a region/varietal slot — 'old vine zinfandel from a cool climate', 'small-producer natural orange wine', 'high altitude napa cabernet', 'biodynamic Burgundy', 'rare single barrel bourbon from kentucky', 'small batch japanese whisky'. Args: q (the user's phrase), limit (default 12), product_type (optional narrowing). Returns ranked product cards (product_name, wholesaler, upc, prices, score). Prefer region/varietal slots when they match; fall back to this for the long tail."),
}


# --------------------------- context tools (deals + user data) ---------------
# These take (con, args, ctx); ctx carries user_id for user-specific reads.

def _t_find_deals(con, args, ctx):
    """Deals by kind. Delegates to pricing.rank_best_deals so the ranking
    is the canonical one every surface uses. The stocking-deal floor applies to
    EVERY kind (overridable via include_stocking_deals) so a $0 free-with-purchase
    row never surfaces as '100% off'."""
    kind_raw = (args.get("kind") or "discount").lower()
    limit = int(args.get("limit") or 10)
    include_stocking = bool(args.get("include_stocking_deals"))
    floor = None if include_stocking else _STOCKING_FLOOR_PCT
    if kind_raw in ("clearance", "closeout"):
        return _pricing.rank_best_deals(
            con, kind="closeout", min_effective_pct_of_frontline=floor, limit=limit,
        )
    if kind_raw in ("time_sensitive", "time-sensitive", "ending", "expiring"):
        return _pricing.rank_best_deals(
            con, kind="time_sensitive", min_effective_pct_of_frontline=floor, limit=limit,
        )
    # Default: biggest savings.
    return _pricing.rank_best_deals(
        con, kind="savings",
        min_effective_pct_of_frontline=None if include_stocking else _STOCKING_FLOOR_PCT,
        limit=limit,
    )


def _t_price_movers(con, args, ctx):
    """Products whose price is going up or down in the latest edition. Resolves
    through _resolve_products so the SAME category / region / varietal / brand
    filters the catalog uses apply here too — 'California wines going up' returns
    California wines, not whatever spirits happen to be rising."""
    direction = (args.get("direction") or args.get("price_trend") or "drop").lower()
    trend = "increase" if direction in ("increase", "up", "rising", "rise") else "drop"
    cap = min(int(args.get("limit") or 10), 25)
    view = {
        "categories": [args["category"]] if args.get("category") else [],
        "divisions": [args["distributor"]] if args.get("distributor") else [],
        "region": args.get("region"), "varietal": args.get("varietal"),
        "priceMin": args.get("price_min"), "priceMax": args.get("price_max"),
        "price_trend": trend,
    }
    try:
        return _resolve_products(con, view, args.get("match") or "", "cheapest", cap,
                                 exclude_stocking=not bool(args.get("include_stocking_deals")))
    except Exception:
        return {"error": "price-trend data unavailable in this build"}


def _t_get_cart(con, args, ctx):
    uid = ctx.get("user_id")
    if not uid:
        return {"error": "user not signed in"}
    from backend.pg import get_pg
    with get_pg() as pg:
        rows = pg.execute(
            "SELECT product_name, wholesaler, qty_cases, qty_units FROM cart_items "
            "WHERE user_id=%s AND COALESCE(saved_for_later,0)=0 ORDER BY product_name", (uid,)).fetchall()
    return {"count": len(rows), "items": [dict(r) for r in rows]}


def _t_get_favorites(con, args, ctx):
    uid = ctx.get("user_id")
    if not uid:
        return {"error": "user not signed in"}
    from backend.pg import get_pg
    with get_pg() as pg:
        rows = pg.execute(
            "SELECT product_name, wholesaler, unit_volume FROM watchlist WHERE user_id=%s ORDER BY product_name",
            (uid,)).fetchall()
    return {"count": len(rows), "items": [dict(r) for r in rows]}


def _t_get_lists(con, args, ctx):
    uid = ctx.get("user_id")
    if not uid:
        return {"error": "user not signed in"}
    from backend.pg import get_pg
    with get_pg() as pg:
        rows = pg.execute(
            "SELECT l.name, COUNT(li.id) AS items FROM lists l "
            "LEFT JOIN list_items li ON li.list_id=l.id WHERE l.user_id=%s GROUP BY l.name ORDER BY l.name",
            (uid,)).fetchall()
    return {"lists": [dict(r) for r in rows]}


def _t_get_orders(con, args, ctx):
    uid = ctx.get("user_id")
    if not uid:
        return {"error": "user not signed in"}
    from backend.pg import get_pg
    with get_pg() as pg:
        rows = pg.execute(
            "SELECT id, name, status, created_at FROM orders WHERE user_id=%s ORDER BY created_at DESC LIMIT 10",
            (uid,)).fetchall()
    return {"orders": [dict(r) for r in rows]}


def _t_get_sales_reps(con, args, ctx):
    """The signed-in user's sales reps with contact info (name, distributor, email,
    phone). Use to show who to follow up with after sending an order, or before
    messaging a rep. To email a rep a question, use perform_action(type=message_rep,
    rep_id=<id>, message=<text>)."""
    uid = ctx.get("user_id")
    if not uid:
        return {"error": "user not signed in"}
    from backend.pg import get_pg
    with get_pg() as pg:
        rows = pg.execute(
            "SELECT id, name, distributor, division, email, phone FROM sales_reps WHERE user_id=%s ORDER BY name",
            (uid,)).fetchall()
    reps = [dict(r) for r in rows]
    return {"count": len(reps), "sales_reps": reps,
            "note": "No sales reps saved yet — add them in Sales Reps." if not reps else None}


def _t_cart_rep_status(con, args, ctx):
    """ORDER-READINESS for submission: per distributor in the ACTIVE cart, whether a
    sales rep is assigned (and who), plus the user's existing reps to choose from.
    Call this BEFORE submit_order — every distributor needs a rep or its lines won't
    be emailed. If a distributor has no rep: assign one with perform_action(
    type=assign_rep, distributor, rep_id), or if none suitable exists, ask the user
    for the rep's name + email + phone and perform_action(type=create_rep,
    distributor, rep_name, rep_email, rep_phone) (creates AND assigns)."""
    uid = ctx.get("user_id")
    if not uid:
        return {"error": "user not signed in"}
    from backend.pg import get_pg
    with get_pg() as pg:
        rows = pg.execute(
            "SELECT ci.wholesaler w, ci.sales_rep_id rid, sr.name rep_name, COUNT(*) lines "
            "FROM cart_items ci LEFT JOIN sales_reps sr ON sr.id=ci.sales_rep_id "
            "WHERE ci.user_id=%s AND COALESCE(ci.saved_for_later,0)=0 "
            "GROUP BY ci.wholesaler, ci.sales_rep_id, sr.name", (uid,)).fetchall()
        reps = [dict(r) for r in pg.execute(
            "SELECT id, name, distributor, email, phone FROM sales_reps WHERE user_id=%s ORDER BY name",
            (uid,)).fetchall()]
    if not rows:
        return {"item_count": 0, "note": "Your cart is empty — nothing to submit."}
    dist: dict = {}
    for r in rows:
        d = dist.setdefault(r["w"], {"distributor": r["w"], "lines": 0, "assigned_lines": 0,
                                     "rep_id": None, "rep_name": None})
        d["lines"] += r["lines"]
        if r["rid"]:
            d["assigned_lines"] += r["lines"]
            d["rep_id"] = r["rid"]; d["rep_name"] = r["rep_name"]
    distributors = list(dist.values())
    needing = []
    for d in distributors:
        if d["assigned_lines"] < d["lines"]:
            # Surface reps already tied to this distributor as the natural choices.
            cands = [rp for rp in reps if (rp.get("distributor") or "").lower() == d["distributor"].lower()]
            needing.append({**d, "candidate_reps": cands})
    return {"item_count": sum(d["lines"] for d in distributors),
            "distributors": distributors,
            "distributors_needing_rep": needing,
            "existing_reps": reps,
            "ready_to_submit": len(needing) == 0,
            "note": ("All distributors have a sales rep — ready to submit." if not needing
                     else f"{len(needing)} distributor(s) need a sales rep before you can submit.")}


def _t_order_history(con, args, ctx):
    """REORDER / ORDER HISTORY: the user's past orders WITH their line items, plus a
    'frequently ordered' rollup. Powers 'reorder my last order', 'same as last
    month', 'what do I usually buy'. To actually re-add an order to the cart, call
    perform_action(type=reorder, order_id=<id>) — confirm first."""
    uid = ctx.get("user_id")
    if not uid:
        return {"error": "user not signed in"}
    from backend.pg import get_pg
    cap = min(int(args.get("limit") or 6), 12)
    oid = args.get("order_id")
    with get_pg() as pg:
        if oid:
            heads = pg.execute(
                "SELECT id, name, status, distributor, created_at FROM orders WHERE user_id=%s AND id=%s",
                (uid, int(oid))).fetchall()
        else:
            heads = pg.execute(
                "SELECT id, name, status, distributor, created_at FROM orders WHERE user_id=%s "
                "ORDER BY created_at DESC LIMIT %s", (uid, cap)).fetchall()
        heads = [dict(h) for h in heads]
        if not heads:
            return {"order_count": 0, "note": "You have no past orders yet."}
        ids = [h["id"] for h in heads]
        ph = ", ".join(["%s"] * len(ids))
        lines = [dict(r) for r in pg.execute(
            f"SELECT order_id, product_name, wholesaler, upc, unit_volume, qty_cases, qty_units "
            f"FROM order_lines WHERE order_id IN ({ph})", tuple(ids)).fetchall()]
    by_order: dict = {}
    freq: dict = {}
    for ln in lines:
        by_order.setdefault(ln["order_id"], []).append({
            "product_name": ln.get("product_name"), "distributor": ln.get("wholesaler"),
            "size": ln.get("unit_volume"), "upc": str(ln.get("upc") or "").lstrip("0") or None,
            "qty_cases": ln.get("qty_cases") or 0, "qty_units": ln.get("qty_units") or 0})
        key = (ln.get("product_name"), ln.get("wholesaler"), ln.get("unit_volume"))
        f = freq.setdefault(key, {"product_name": ln.get("product_name"), "distributor": ln.get("wholesaler"),
                                  "size": ln.get("unit_volume"), "times_ordered": 0, "total_cases": 0.0})
        f["times_ordered"] += 1
        f["total_cases"] += (ln.get("qty_cases") or 0)
    orders = [{**h, "lines": by_order.get(h["id"], []), "line_count": len(by_order.get(h["id"], []))}
              for h in heads]
    frequently_ordered = sorted(freq.values(), key=lambda x: (x["times_ordered"], x["total_cases"]), reverse=True)[:15]
    return {"order_count": len(orders), "orders": orders,
            "frequently_ordered": frequently_ordered,
            "note": "Call perform_action(type=reorder, order_id=<id>) to re-add an order to the cart (confirm first)."}


def _t_lapsed_items(con, args, ctx):
    """WIN-BACK: products the user ordered BEFORE but not recently, flagged when
    they're attractive again NOW — on a CPL discount, carrying a RIP rebate, or
    price dropped vs last month. Powers 'what have I stopped buying', 'win-back
    opportunities', 'anything I used to order worth grabbing now'."""
    uid = ctx.get("user_id")
    if not uid:
        return {"error": "user not signed in"}
    from backend.pg import get_pg
    days = int(args.get("lapsed_days") or 45)
    with get_pg() as pg:
        cand = [dict(r) for r in pg.execute(
            "SELECT ol.product_name, ol.wholesaler, LTRIM(CAST(ol.upc AS VARCHAR),'0') AS un, "
            "ol.unit_volume, MAX(o.created_at::timestamptz) AS last_ordered, COUNT(*) AS times "
            "FROM order_lines ol JOIN orders o ON o.id=ol.order_id "
            "WHERE o.user_id=%s AND ol.upc IS NOT NULL "
            "GROUP BY 1,2,3,4 HAVING MAX(o.created_at::timestamptz) < NOW() - make_interval(days => %s)",
            (uid, days)).fetchall()]
        active = pg.execute(
            "SELECT LTRIM(CAST(upc AS VARCHAR),'0') un FROM cart_items WHERE user_id=%s AND COALESCE(saved_for_later,0)=0 "
            "UNION SELECT LTRIM(CAST(upc AS VARCHAR),'0') un FROM watchlist WHERE user_id=%s", (uid, uid)).fetchall()
    active_upcs = {str(r["un"]).lstrip("0") for r in active if r.get("un")}
    cand = [c for c in cand if c.get("un") and c["un"] not in active_upcs]
    if not cand:
        return {"lapsed_count": 0, "opportunities": [],
                "note": f"Nothing you've stopped ordering (looked back {days}+ days)."}
    upcs = sorted({c["un"] for c in cand})
    ph = ", ".join("?" for _ in upcs)
    cym = _pricing.current_yyyy_mm()
    price = {}
    try:
        df = con.execute(
            "WITH cur AS (SELECT wholesaler, COALESCE(MAX(CASE WHEN edition<=? THEN edition END), MAX(edition)) ed "
            "FROM cpl_enriched GROUP BY wholesaler) "
            "SELECT LTRIM(CAST(c.upc AS VARCHAR),'0') un, c.wholesaler w, c.effective_case_price eff, "
            "c.frontline_case_price fl, c.has_rip, c.has_discount, c.price_trend "
            "FROM cpl_enriched c JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed "
            f"WHERE LTRIM(CAST(c.upc AS VARCHAR),'0') IN ({ph})", [cym] + upcs).fetchdf()
        for _, r in df.iterrows():
            price[(r["w"], str(r["un"]))] = r
    except Exception:
        pass
    opps = []
    for c in cand:
        r = price.get((c["wholesaler"], c["un"]))
        if r is None:
            continue
        eff = _num(r["eff"]); fl = _num(r["fl"])
        reasons = []
        if bool(r["has_rip"]):
            reasons.append("RIP rebate available")
        if bool(r["has_discount"]) or (eff is not None and fl and eff < fl - 0.01):
            reasons.append("on a CPL discount")
        if str(r["price_trend"] or "").lower() == "drop":
            reasons.append("price dropped this edition")
        if not reasons:
            continue
        lo = c.get("last_ordered")
        opps.append({"product_name": c["product_name"], "distributor": c["wholesaler"],
                     "size": c.get("unit_volume"), "upc": c["un"],
                     "last_ordered": str(lo)[:10] if lo else None, "times_ordered": c.get("times"),
                     "effective_case_price": eff, "frontline_case_price": fl,
                     "why_now": reasons})
    opps.sort(key=lambda x: (x["frontline_case_price"] or 0) - (x["effective_case_price"] or 0), reverse=True)
    return {"lapsed_count": len(cand), "opportunity_count": len(opps), "opportunities": opps[:25],
            "note": (f"{len(opps)} item(s) you used to order are attractive again now."
                     if opps else "Nothing you've stopped ordering is on a deal right now.")}


# --------------------------------------------------------------------------
# Shared basket (cart / favorites / list) loading + edition-correct pricing.
# Every cart/list analysis tool routes through these so they agree on (a) what
# "current" means and (b) that lists work exactly like the cart.
# --------------------------------------------------------------------------

def _load_basket(args, ctx):
    """Load the user's CART, FAVORITES, or a named LIST as a uniform item list.
    Each item: product_name, wholesaler, upc, unit_volume, qty_cases, qty_units.
    Returns (source, items) or (None, None) if not signed in."""
    uid = ctx.get("user_id")
    if not uid:
        return None, None
    source = (args.get("source") or "cart").lower()
    from backend.pg import get_pg
    items = []
    with get_pg() as pg:
        if source in ("favorites", "favourites", "watchlist", "wishlist", "wish list"):
            source = "favorites"
            rows = pg.execute(
                "SELECT product_name, wholesaler, upc, unit_volume FROM watchlist WHERE user_id=%s", (uid,)).fetchall()
            items = [{**dict(r), "qty_cases": 1, "qty_units": 0} for r in rows]
        elif source in ("list", "lists"):
            source = "list"
            ln = (args.get("list_name") or "").strip()
            if ln:
                rows = pg.execute(
                    "SELECT li.product_name, li.wholesaler, li.upc, li.unit_volume FROM list_items li "
                    "JOIN lists l ON li.list_id=l.id WHERE l.user_id=%s AND lower(l.name)=lower(%s)", (uid, ln)).fetchall()
            else:
                rows = pg.execute(
                    "SELECT li.product_name, li.wholesaler, li.upc, li.unit_volume FROM list_items li "
                    "JOIN lists l ON li.list_id=l.id WHERE l.user_id=%s", (uid,)).fetchall()
            items = [{**dict(r), "qty_cases": 1, "qty_units": 0} for r in rows]
        else:
            source = "cart"
            rows = pg.execute(
                "SELECT product_name, wholesaler, upc, unit_volume, qty_cases, qty_units FROM cart_items "
                "WHERE user_id=%s AND COALESCE(saved_for_later,0)=0", (uid,)).fetchall()
            items = [dict(r) for r in rows]
    return source, items


def _eff_windows(con, upcs):
    """Prev / current / next effective-case prices for a set of normalized UPCs,
    all on CANONICAL editions (never bare MAX(edition), which lets a pre-loaded
    NEXT month masquerade as current). Returns (cur, prev_rows, next_rows, next_loaded):
      cur[(w, un)]        = current-edition effective (latest edition <= this month)
      prev_rows[(w, un)]  = [(pname_lower, unit_volume, eff), ...] for the edition
                            immediately BEFORE current (this month's movement)
      next_rows[(w, un)]  = same shape, for the REAL next-month edition
      next_loaded         = whether next month's sheet is published yet."""
    cym = _pricing.current_yyyy_mm()
    nym = _pricing.next_yyyy_mm()
    cur, prev_rows, next_rows = {}, {}, {}
    try:
        next_loaded = bool(con.execute(
            "SELECT 1 FROM cpl_enriched WHERE edition = ? LIMIT 1", [nym]).fetchone())
    except Exception:
        next_loaded = False
    if not upcs:
        return cur, prev_rows, next_rows, next_loaded

    def _eff(v):
        try:
            x = float(v)
            return None if x != x else x
        except (TypeError, ValueError):
            return None

    ph = ", ".join("?" for _ in upcs)
    try:
        df = con.execute(
            "WITH cur AS (SELECT wholesaler, "
            "COALESCE(MAX(CASE WHEN edition <= ? THEN edition END), MAX(edition)) ed "
            "FROM cpl_enriched GROUP BY wholesaler) "
            "SELECT LTRIM(CAST(c.upc AS VARCHAR),'0') un, c.wholesaler w, c.effective_case_price eff "
            "FROM cpl_enriched c JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed "
            f"WHERE LTRIM(CAST(c.upc AS VARCHAR),'0') IN ({ph}) AND c.effective_case_price IS NOT NULL",
            [cym] + upcs).fetchdf()
        for _, r in df.iterrows():
            e = _eff(r["eff"])
            if e is not None:
                cur[(r["w"], str(r["un"]))] = e
        pdf = con.execute(
            "WITH cur AS (SELECT wholesaler, "
            "COALESCE(MAX(CASE WHEN edition <= ? THEN edition END), MAX(edition)) ed "
            "FROM cpl_enriched GROUP BY wholesaler), "
            "prv AS (SELECT c.wholesaler, MAX(c.edition) ed FROM cpl_enriched c "
            "JOIN cur ON c.wholesaler=cur.wholesaler WHERE c.edition < cur.ed GROUP BY c.wholesaler) "
            "SELECT LTRIM(CAST(c.upc AS VARCHAR),'0') un, c.wholesaler w, c.product_name pn, "
            "c.unit_volume uv, c.effective_case_price eff "
            "FROM cpl_enriched c JOIN prv ON c.wholesaler=prv.wholesaler AND c.edition=prv.ed "
            f"WHERE LTRIM(CAST(c.upc AS VARCHAR),'0') IN ({ph}) AND c.effective_case_price IS NOT NULL",
            [cym] + upcs).fetchdf()
        for _, r in pdf.iterrows():
            e = _eff(r["eff"])
            if e is not None:
                prev_rows.setdefault((r["w"], str(r["un"])), []).append(
                    ((r["pn"] or "").strip().lower(), (r["uv"] or "").strip(), round(e, 2)))
        ndf = con.execute(
            "SELECT LTRIM(CAST(upc AS VARCHAR),'0') un, wholesaler w, product_name pn, unit_volume uv, "
            "effective_case_price eff FROM cpl_enriched "
            f"WHERE edition = ? AND LTRIM(CAST(upc AS VARCHAR),'0') IN ({ph}) "
            "AND effective_case_price IS NOT NULL", [nym] + upcs).fetchdf()
        for _, r in ndf.iterrows():
            e = _eff(r["eff"])
            if e is not None:
                next_rows.setdefault((r["w"], str(r["un"])), []).append(
                    ((r["pn"] or "").strip().lower(), (r["uv"] or "").strip(), round(e, 2)))
    except Exception:
        pass
    return cur, prev_rows, next_rows, next_loaded


def _match_eff(rows_map, w, un, pname, uvol, cur):
    """Best effective price for an exact line from a prev/next rows-map. Match the
    SAME UPC on product name + size; when a UPC maps to several SKUs (sizes /
    vintages), pick the price CLOSEST to the current one (the same SKU continuing)
    rather than a sibling listing."""
    cand = rows_map.get((w, un))
    if not cand:
        return None
    pl = (pname or "").strip().lower()
    uv = (uvol or "").strip()

    def _closest(rs):
        if cur is None:
            return rs[0][2]
        return min(rs, key=lambda r: abs(r[2] - cur))[2]
    exact = [r for r in cand if r[0] == pl and r[1] == uv]
    if exact:
        return _closest(exact)
    byname = [r for r in cand if r[0] == pl]
    if byname:
        return _closest(byname)
    return _closest(cand) if len(cand) == 1 else None


def _t_analyze_cart(con, args, ctx):
    """Deep analysis of the user's CART, FAVORITES, or a LIST: per item, compare
    its effective case price against every distributor carrying the SAME UPC and
    flag where another distributor is cheaper, with per-case and quantity-weighted
    savings + a total. Grounds 'is anyone cheaper / should I swap distributors'."""
    source, items = _load_basket(args, ctx)
    if source is None:
        return {"error": "user not signed in"}
    if not items:
        return {"source": source, "item_count": 0, "note": f"Your {source} is empty."}

    def _norm(u):
        return str(u or "").lstrip("0")
    upcs = sorted({_norm(it["upc"]) for it in items if _norm(it["upc"])})
    # Canonical prev / current / next effective prices (shared edition logic).
    pricing, prev_rows, next_rows, next_edition_loaded = _eff_windows(con, upcs)
    by_upc, disc_map, pack_map, front_map = {}, {}, {}, {}
    for (w, un), e in pricing.items():
        by_upc.setdefault(un, []).append((w, round(e, 2)))
    # Discount tiers + pack size for the SAME current edition (separate small query;
    # _eff_windows only returns prices).
    if upcs:
        ph = ", ".join("?" for _ in upcs)
        cym = _pricing.current_yyyy_mm()
        try:
            df = con.execute(
                "WITH latest AS (SELECT wholesaler, "
                "COALESCE(MAX(CASE WHEN edition <= ? THEN edition END), MAX(edition)) ed "
                "FROM cpl_enriched GROUP BY wholesaler) "
                "SELECT LTRIM(CAST(c.upc AS VARCHAR),'0') un, c.wholesaler w, c.unit_qty uq, "
                "c.frontline_case_price fl, "
                "c.discount_1_qty d1q, c.discount_1_amt d1a, c.discount_2_qty d2q, c.discount_2_amt d2a, "
                "c.discount_3_qty d3q, c.discount_3_amt d3a, c.discount_4_qty d4q, c.discount_4_amt d4a, "
                "c.discount_5_qty d5q, c.discount_5_amt d5a "
                "FROM cpl_enriched c JOIN latest l ON c.wholesaler=l.wholesaler AND c.edition=l.ed "
                f"WHERE LTRIM(CAST(c.upc AS VARCHAR),'0') IN ({ph})", [cym] + upcs).fetchdf()
            for _, r in df.iterrows():
                un = str(r["un"]); w = r["w"]
                try:
                    pk = float(r["uq"])
                    pack_map[(w, un)] = 0.0 if pk != pk else pk
                except (TypeError, ValueError):
                    pack_map[(w, un)] = 0.0
                try:
                    fv = float(r["fl"])
                    if fv == fv:
                        front_map[(w, un)] = fv
                except (TypeError, ValueError):
                    pass
                dts = []
                for j in (1, 2, 3, 4, 5):
                    try:
                        amt = float(r[f"d{j}a"])
                    except (TypeError, ValueError):
                        continue
                    if amt != amt or amt <= 0:
                        continue
                    qs = str(r[f"d{j}q"]) if r[f"d{j}q"] is not None else ""
                    mnum = re.search(r"[0-9]+(?:\.[0-9]+)?", qs)
                    if not mnum:
                        continue
                    qn = float(mnum.group(0))
                    if qn <= 0:
                        continue
                    dts.append((qn, _rip.normalize_unit(qs) or "case", round(amt, 2)))
                if dts:
                    disc_map[(w, un)] = sorted(dts, key=lambda t: t[0])
        except Exception:
            pass

    out_items, total_save, cheaper_count = [], 0.0, 0
    buy_now_total, wait_total, buy_now_n, wait_n = 0.0, 0.0, 0, 0
    cur_total, opt_total, list_total = 0.0, 0.0, 0.0
    price_increase_warnings, disc_upgrades, price_moves = [], [], []
    for it in items:
        un = _norm(it["upc"])
        cur_eff = pricing.get((it["wholesaler"], un))
        alts = sorted(by_upc.get(un, []), key=lambda x: x[1])
        qty = (it.get("qty_cases") or 0) or 1
        qcs = it.get("qty_cases") or 0
        qbt = it.get("qty_units") or 0
        size = it.get("unit_volume") or None
        # Human label so two same-named lines (e.g. Absolut Vodka 80 1.75L vs 750mL)
        # are distinguishable, and cases vs bottles is explicit.
        _qparts = []
        if qcs:
            _qparts.append(f"{int(qcs) if float(qcs).is_integer() else qcs} cs")
        if qbt:
            _qparts.append(f"{int(qbt) if float(qbt).is_integer() else qbt} btl")
        qty_label = " + ".join(_qparts) or "1 cs"
        entry = {"product_name": it.get("product_name"), "current_distributor": it.get("wholesaler"),
                 "size": size,
                 "current_effective_case": round(cur_eff, 2) if cur_eff is not None else None,
                 "qty_cases": it.get("qty_cases"), "qty_units": qbt or None,
                 "qty_label": qty_label, "upc": un or None,
                 "also_at": [w for (w, _e) in alts if w != it.get("wholesaler")]}
        # List (frontline) price for the "you saved $X vs list" headline.
        fl = front_map.get((it["wholesaler"], un))
        if fl is not None:
            entry["frontline_case"] = round(fl, 2)
            if cur_eff is not None and fl > cur_eff + 0.01:
                entry["saved_vs_list_per_case"] = round(fl - cur_eff, 2)
                entry["saved_vs_list_for_qty"] = round((fl - cur_eff) * qty, 2)
        if cur_eff is not None:
            cur_total += cur_eff * qty
            opt_total += (min(cur_eff, alts[0][1]) if alts else cur_eff) * qty
            list_total += (fl if fl is not None else cur_eff) * qty
        if alts and cur_eff is not None and alts[0][1] < cur_eff - 0.01 and alts[0][0] != it.get("wholesaler"):
            save = round(cur_eff - alts[0][1], 2)
            entry.update({"cheaper_distributor": alts[0][0], "cheaper_effective_case": alts[0][1],
                          "savings_per_case": save, "savings_for_qty": round(save * qty, 2)})
            total_save += save * qty
            cheaper_count += 1
        # This-month movement: how did THIS line's price change vs last edition?
        # Always useful — especially early in a month before next month is published.
        prv = _match_eff(prev_rows, it["wholesaler"], un, it.get("product_name"), it.get("unit_volume"), cur_eff)
        if cur_eff is not None and prv is not None and abs(prv - cur_eff) >= 0.01:
            mv = round(cur_eff - prv, 2)
            entry["last_month_effective_case"] = round(prv, 2)
            entry["changed_this_month_per_case"] = mv
            entry["moved"] = "dropped" if mv < 0 else "rose"
            price_moves.append({
                "product_name": it.get("product_name"), "distributor": it.get("wholesaler"),
                "size": size, "last_month": round(prv, 2), "now": round(cur_eff, 2),
                "change_per_case": mv, "direction": "dropped" if mv < 0 else "rose"})
        # Timing: is THIS month best, or is next month cheaper? (same UPC+distributor)
        nxt = _match_eff(next_rows, it["wholesaler"], un, it.get("product_name"), it.get("unit_volume"), cur_eff)
        if cur_eff is not None:
            entry["next_month_effective_case"] = round(nxt, 2) if nxt is not None else None
            if nxt is None and not next_edition_loaded:
                # Next month's prices aren't published yet — we genuinely can't advise.
                entry["timing"] = "HOLD"; entry["timing_reason"] = "next month's sheet not published yet"
            elif nxt is None:
                entry["timing"] = "BUY NOW"; entry["timing_reason"] = "not on next month's sheet — may be gone"
            elif nxt > cur_eff + 0.01:
                d = round(nxt - cur_eff, 2)
                entry["timing"] = "BUY NOW"; entry["price_rises_next_month_per_case"] = d
                entry["lock_in_savings_for_qty"] = round(d * qty, 2)
                buy_now_total += d * qty; buy_now_n += 1
                price_increase_warnings.append({
                    "product_name": it.get("product_name"), "distributor": it.get("wholesaler"),
                    "size": size, "now": round(cur_eff, 2), "next_month": round(nxt, 2),
                    "increase_per_case": d, "extra_cost_for_qty": round(d * qty, 2)})
            elif nxt < cur_eff - 0.01:
                d = round(cur_eff - nxt, 2)
                entry["timing"] = "WAIT"; entry["price_drops_next_month_per_case"] = d
                entry["save_by_waiting_for_qty"] = round(d * qty, 2)
                wait_total += d * qty; wait_n += 1
            else:
                entry["timing"] = "HOLD (same next month)"
        # CPL discount-tier upgrade: a deeper per-product discount tier exists at a
        # higher qty than the buyer currently has (effective assumes the best tier,
        # so this flags what they must BUY to actually realise it).
        dts = disc_map.get((it["wholesaler"], un))
        if dts:
            pk = pack_map.get((it["wholesaler"], un), 0.0)
            for (qn, unit, amt) in dts:
                have = (qty * pk) if (unit == "bottle" and pk) else qty
                if have < qn:
                    need = qn - have
                    up = {"buy_qty": qn, "unit": "bottles" if unit == "bottle" else "cases",
                          "more_needed": round(need, 1),
                          "more_cases_equiv": round(need / pk, 1) if (unit == "bottle" and pk) else round(need, 1),
                          "discount_per_case": amt}
                    entry["discount_tier_upgrade"] = up
                    disc_upgrades.append({"product_name": it.get("product_name"),
                                          "distributor": it.get("wholesaler"), "size": size, **up})
                    break
        out_items.append(entry)

    # RIP situation across the item set (works for cart AND lists/favorites).
    # rip_status = EVERY rebate code carried (so we can explain "you're on code X,
    # currently $Y, top tier reached"); rip_upgrades = just the ones with a
    # reachable next tier (the actionable buy-more wins).
    rip_status, rip_upgrades = [], []
    try:
        rip_status = _rip_tier_plan(con, items)
        rip_upgrades = [t for t in rip_status if t.get("next_tier")]
    except Exception:
        pass

    # Duplicate / double-add guard: the SAME UPC on more than one line — usually an
    # accidental double-add, or the same product sitting at two distributors (pick
    # one). Flag so the buyer doesn't over-order before sending.
    upc_lines: dict = {}
    for it in items:
        u = _norm(it["upc"])
        if u:
            upc_lines.setdefault(u, []).append(it)
    duplicates = []
    for u, its in upc_lines.items():
        if len(its) > 1:
            duplicates.append({
                "upc": u,
                "product_names": sorted({i.get("product_name") for i in its if i.get("product_name")}),
                "distributors": sorted({i.get("wholesaler") for i in its if i.get("wholesaler")}),
                "line_count": len(its),
                "total_cases": sum((i.get("qty_cases") or 0) for i in its)})

    cart_ws = sorted({(it.get("wholesaler") or "") for it in items if it.get("wholesaler")})
    # Combo opportunities: cart products that are also part of a bundle.
    combos = []
    if upcs and cart_ws:
        uph = ", ".join("?" for _ in upcs)
        wph = ", ".join("?" for _ in cart_ws)
        try:
            cdf = con.execute(
                "WITH latest AS (SELECT wholesaler, "
                "COALESCE(MAX(CASE WHEN edition <= ? THEN edition END), MAX(edition)) ed "
                "FROM combo GROUP BY wholesaler) "
                "SELECT cb.wholesaler, CAST(cb.combo_code AS VARCHAR) combo_code, "
                "ANY_VALUE(cb.combo_pack_price) pack_price, ANY_VALUE(cb.total_savings) savings "
                "FROM combo cb JOIN latest l ON cb.wholesaler=l.wholesaler AND cb.edition=l.ed "
                f"WHERE LTRIM(CAST(cb.upc AS VARCHAR),'0') IN ({uph}) AND LOWER(cb.wholesaler) IN ({wph}) "
                "GROUP BY 1, 2 ORDER BY savings DESC NULLS LAST LIMIT 10",
                [_pricing.current_yyyy_mm()] + upcs + [w.lower() for w in cart_ws]).fetchdf()
            for _, r in cdf.iterrows():
                combos.append({"distributor": r["wholesaler"], "combo_code": r["combo_code"],
                               "pack_price": _num(r["pack_price"]), "total_savings": _num(r["savings"])})
        except Exception:
            pass

    # Expiring / closeout: cart lines on a closeout or a dated deal ending <=14 days.
    expiring = []
    if upcs and cart_ws:
        uph = ", ".join("?" for _ in upcs)
        wph = ", ".join("?" for _ in cart_ws)
        try:
            edf = con.execute(
                "WITH latest AS (SELECT wholesaler, "
                "COALESCE(MAX(CASE WHEN edition <= ? THEN edition END), MAX(edition)) ed "
                "FROM cpl GROUP BY wholesaler) "
                "SELECT DISTINCT c.wholesaler, c.product_name, c.closeout_permit AS co, "
                "CAST(c.to_date AS DATE) AS t, date_diff('day', CURRENT_DATE, CAST(c.to_date AS DATE)) AS ends_in "
                "FROM cpl c JOIN latest l ON c.wholesaler=l.wholesaler AND c.edition=l.ed "
                f"WHERE LTRIM(CAST(c.upc AS VARCHAR),'0') IN ({uph}) AND LOWER(c.wholesaler) IN ({wph}) "
                "AND ((c.closeout_permit IS NOT NULL AND CAST(c.closeout_permit AS VARCHAR) NOT IN ('', '0', 'None', 'nan')) "
                "OR (c.from_date IS NOT NULL AND c.to_date IS NOT NULL "
                "AND NOT (EXTRACT(day FROM CAST(c.from_date AS DATE))=1 AND CAST(c.to_date AS DATE)=(date_trunc('month', CAST(c.to_date AS DATE)) + INTERVAL 1 MONTH - INTERVAL 1 DAY)) "
                "AND CAST(c.to_date AS DATE) BETWEEN CURRENT_DATE AND CURRENT_DATE + 14))",
                [_pricing.current_yyyy_mm()] + upcs + [w.lower() for w in cart_ws]).fetchdf()
            for _, r in edf.iterrows():
                co = r["co"]
                is_co = co is not None and str(co).strip() not in ("", "0", "None", "nan")
                ends = int(r["ends_in"]) if (r["ends_in"] == r["ends_in"] and r["ends_in"] is not None) else None
                expiring.append({"product_name": r["product_name"], "distributor": r["wholesaler"],
                                 "closeout": bool(is_co), "ends_in_days": ends,
                                 "reason": "Closeout — buy before it's gone" if is_co
                                           else (f"Dated deal ends in {ends} day(s)" if ends is not None else "Dated deal ending soon")})
        except Exception:
            pass

    opportunities = (cheaper_count + buy_now_n + len(rip_upgrades) + len(disc_upgrades)
                     + len(combos) + len(expiring))
    drops_now = [m for m in price_moves if m["direction"] == "dropped"]
    rises_now = [m for m in price_moves if m["direction"] == "rose"]
    return {"source": source, "item_count": len(items),
            # Totals are TRUE effective (list − CPL discounts − best RIP), the same
            # number the catalog/cart show.
            "summary": {"current_effective_total": round(cur_total, 2),
                        "optimized_effective_total": round(opt_total, 2),
                        "distributor_savings": round(cur_total - opt_total, 2),
                        # The headline the buyer feels: list (frontline) total vs what
                        # they actually pay after CPL discounts + best RIP.
                        "list_total": round(list_total, 2),
                        "saved_vs_list": round(list_total - cur_total, 2),
                        "opportunities": opportunities,
                        "fully_optimized": opportunities == 0,
                        # So the UI can say "next month not published yet" instead of
                        # implying every line is a BUY NOW.
                        "next_month_published": bool(next_edition_loaded)},
            "cheaper_distributor": {"count": cheaper_count, "total_savings": round(total_save, 2)},
            "timing": {"buy_now_count": buy_now_n, "wait_count": wait_n,
                       "buy_now_lock_in_total": round(buy_now_total, 2),
                       "wait_savings_total": round(wait_total, 2),
                       "next_month_published": bool(next_edition_loaded)},
            # This-month price movement vs last edition — always useful, and the only
            # forward signal early in a month before next month's sheet lands.
            "price_movement": {"dropped": drops_now, "rose": rises_now},
            "price_increase_warnings": price_increase_warnings,
            "rip_status": rip_status,
            "rip_tier_upgrades": rip_upgrades,
            "discount_tier_upgrades": disc_upgrades,
            "duplicate_lines": duplicates,
            "combo_opportunities": combos,
            "expiring_or_closeout": expiring,
            "items": out_items}


def _t_optimize_cart(con, args, ctx):
    """ORDER OPTIMIZER: read the user's CART, FAVORITES, or a LIST and produce the
    cheapest sourcing plan — per line find the distributor with the lowest effective
    case price for the same UPC, group the wins into (from -> to) distributor swaps,
    and total current vs optimized cost. Generalistic (price-only) now; POS-ready:
    the scoring will later weight optional velocity / on_hand / shelf_price signals
    that are simply absent today."""
    source, items = _load_basket(args, ctx)
    if source is None:
        return {"error": "user not signed in"}
    if not items:
        return {"source": source, "item_count": 0, "note": f"Your {source} is empty — nothing to optimize."}

    def _norm(u):
        return str(u or "").lstrip("0")
    upcs = sorted({_norm(it["upc"]) for it in items if _norm(it["upc"])})
    # Cross-distributor compare on the canonical CURRENT edition (mirrors the
    # catalog). We need product_name per (w, upc), which _eff_windows doesn't carry,
    # so query directly — but with the same current-edition rule.
    pricing, by_upc = {}, {}
    if upcs:
        ph = ", ".join("?" for _ in upcs)
        try:
            df = con.execute(
                "WITH latest AS (SELECT wholesaler, "
                "COALESCE(MAX(CASE WHEN edition <= ? THEN edition END), MAX(edition)) ed "
                "FROM cpl_enriched GROUP BY wholesaler) "
                "SELECT LTRIM(CAST(c.upc AS VARCHAR),'0') un, c.wholesaler, c.product_name, c.effective_case_price eff "
                "FROM cpl_enriched c JOIN latest l ON c.wholesaler=l.wholesaler AND c.edition=l.ed "
                f"WHERE LTRIM(CAST(c.upc AS VARCHAR),'0') IN ({ph}) AND c.effective_case_price IS NOT NULL "
                "AND c.effective_case_price > 0", [_pricing.current_yyyy_mm()] + upcs).fetchdf()
            for _, r in df.iterrows():
                un = str(r["un"])
                try:
                    eff = float(r["eff"])
                except (TypeError, ValueError):
                    continue
                if eff != eff:
                    continue
                pricing[(r["wholesaler"], un)] = eff
                by_upc.setdefault(un, []).append((r["wholesaler"], round(eff, 2), r["product_name"]))
        except Exception:
            pass

    swaps, by_item, cur_total, opt_total = {}, [], 0.0, 0.0
    for it in items:
        un = _norm(it["upc"])
        qty = (it.get("qty_cases") or 0) or 1
        cur_eff = pricing.get((it["wholesaler"], un))
        alts = sorted(by_upc.get(un, []), key=lambda x: x[1])
        cheapest = alts[0] if alts else None
        if cur_eff is not None:
            cur_total += cur_eff * qty
        rec = None
        if (cheapest and cur_eff is not None and cheapest[0] != it["wholesaler"]
                and cheapest[1] < cur_eff - 0.01):
            save = round((cur_eff - cheapest[1]) * qty, 2)
            opt_total += cheapest[1] * qty
            b = swaps.setdefault((it["wholesaler"], cheapest[0]),
                                 {"from": it["wholesaler"], "to": cheapest[0], "items": [], "savings": 0.0})
            b["items"].append({"product_name": it["product_name"], "to_product": cheapest[2],
                               "qty_cases": qty, "savings": save})
            b["savings"] += save
            rec = {"swap_to": cheapest[0], "to_effective_case": cheapest[1], "savings_for_qty": save}
        elif cur_eff is not None:
            opt_total += cur_eff * qty
        by_item.append({"product_name": it.get("product_name"), "current_distributor": it.get("wholesaler"),
                        "current_effective_case": round(cur_eff, 2) if cur_eff is not None else None,
                        "qty_cases": qty, "recommendation": rec})
    swap_list = sorted(swaps.values(), key=lambda b: b["savings"], reverse=True)
    for b in swap_list:
        b["savings"] = round(b["savings"], 2)
    return {"source": source, "item_count": len(items),
            "current_total": round(cur_total, 2), "optimized_total": round(opt_total, 2),
            "total_savings": round(cur_total - opt_total, 2),
            "recommended_swaps": swap_list, "by_item": by_item,
            "note": ("Apply each with perform_action(type=swap_distributor, from_distributor, to_distributor)."
                     if swap_list else f"Your {source} is already at the cheapest distributor pricing.")}


def _t_cart_timing(con, args, ctx):
    """BUY-NOW-vs-WAIT sweep of the user's CART, FAVORITES, or a LIST: per line
    compare the canonical current edition's effective case price to the REAL next
    month's edition and flag BUY NOW (price rises next month, or the item drops off
    next month's sheet) vs WAIT (price falls next month), with the $ impact for the
    line's quantity. If next month isn't published yet, says so instead of guessing."""
    source, items = _load_basket(args, ctx)
    if source is None:
        return {"error": "user not signed in"}
    if not items:
        return {"source": source, "item_count": 0, "note": f"Your {source} is empty."}

    def _norm(u):
        return str(u or "").lstrip("0")
    upcs = sorted({_norm(it["upc"]) for it in items if _norm(it["upc"])})
    cur_map, _prev_rows, next_rows, next_loaded = _eff_windows(con, upcs)

    buy_now, wait, stable, unknown, bn_total, w_total = [], [], [], [], 0.0, 0.0
    for it in items:
        un = _norm(it["upc"])
        cur = cur_map.get((it["wholesaler"], un))
        nxt = _match_eff(next_rows, it["wholesaler"], un, it.get("product_name"), it.get("unit_volume"), cur)
        qty = (it.get("qty_cases") or 0) or 1
        e = {"product_name": it.get("product_name"), "distributor": it.get("wholesaler"), "qty_cases": qty,
             "now_effective": round(cur, 2) if cur is not None else None,
             "next_effective": round(nxt, 2) if nxt is not None else None}
        if cur is None:
            stable.append(e); continue
        if nxt is None and not next_loaded:
            e["action"] = "HOLD"; e["reason"] = "next month's sheet not published yet"
            unknown.append(e); continue
        if nxt is None:
            e["action"] = "BUY NOW"; e["reason"] = "not on next month's sheet — may be gone"
            buy_now.append(e); continue
        d = round(nxt - cur, 2)
        if d > 0.01:
            e["action"] = "BUY NOW"; e["increase_per_case"] = d; e["at_risk_for_qty"] = round(d * qty, 2)
            bn_total += d * qty; buy_now.append(e)
        elif d < -0.01:
            e["action"] = "WAIT"; e["drop_per_case"] = round(-d, 2); e["save_by_waiting_for_qty"] = round(-d * qty, 2)
            w_total += -d * qty; wait.append(e)
        else:
            e["action"] = "HOLD (same next month)"; stable.append(e)
    return {"source": source, "item_count": len(items),
            "next_month_published": bool(next_loaded),
            "buy_now": sorted(buy_now, key=lambda x: x.get("at_risk_for_qty", 0), reverse=True),
            "wait": sorted(wait, key=lambda x: x.get("save_by_waiting_for_qty", 0), reverse=True),
            "stable_count": len(stable), "unknown_count": len(unknown),
            "buy_now_total_at_risk": round(bn_total, 2),
            "wait_total_potential_savings": round(w_total, 2),
            "note": ("BUY NOW = rises or vanishes next edition; WAIT = drops next edition."
                     if next_loaded else "Next month's sheet isn't published yet — timing is provisional.")}


def _rip_tier_plan(con, items):
    """Sum case/bottle quantity per RIP code across a set of cart/list items and
    return, per code, the tier reached + the next tier (more needed + extra
    rebate). Shared by the cart RIP-tier maximizer and the smart cart/list
    analysis so both work on any item set (cart, favorites, or a list)."""
    def _norm(u):
        return str(u or "").lstrip("0")
    upcs = sorted({_norm(it["upc"]) for it in items if _norm(it.get("upc"))})
    meta = {}   # (wholesaler, un) -> (rip_code, pack)
    if upcs:
        ph = ", ".join("?" for _ in upcs)
        try:
            df = con.execute(
                "WITH latest AS (SELECT wholesaler, "
                "COALESCE(MAX(CASE WHEN edition <= ? THEN edition END), MAX(edition)) ed "
                "FROM cpl_enriched GROUP BY wholesaler) "
                "SELECT c.wholesaler, LTRIM(CAST(c.upc AS VARCHAR),'0') un, CAST(c.rip_code AS VARCHAR) rc, c.unit_qty uq "
                "FROM cpl_enriched c JOIN latest l ON c.wholesaler=l.wholesaler AND c.edition=l.ed "
                f"WHERE LTRIM(CAST(c.upc AS VARCHAR),'0') IN ({ph})", [_pricing.current_yyyy_mm()] + upcs).fetchdf()
            for _, r in df.iterrows():
                rc = str(r["rc"]).strip() if r["rc"] is not None else ""
                try:
                    pack = float(r["uq"])
                    pack = 0.0 if pack != pack else pack
                except (TypeError, ValueError):
                    pack = 0.0
                meta[(r["wholesaler"], str(r["un"]))] = (rc, pack)
        except Exception:
            pass

    groups = {}   # (wholesaler, code) -> {cases, bottles, products:set}
    for it in items:
        rc, pack = meta.get((it["wholesaler"], _norm(it["upc"])), ("", 0.0))
        if not rc or rc.lower() in ("", "0", "none", "nan"):
            continue
        cases = (it.get("qty_cases") or 0)
        bottles = cases * pack + (it.get("qty_units") or 0)
        g = groups.setdefault((it["wholesaler"], rc), {"cases": 0.0, "bottles": 0.0, "products": set()})
        g["cases"] += cases
        g["bottles"] += bottles
        if it.get("product_name"):
            g["products"].add(it["product_name"])

    out = []
    for (ws, code), g in groups.items():
        _desc, tiers = _rip_tiers_for(con, code, ws)
        if not tiers:
            continue
        # cases-equivalent sort so the ladder is in ascending commitment order
        meta_pack = next((p for (_w, _u), (_rc, p) in meta.items() if _rc == code and p), 0.0)
        tiers_sorted = sorted(tiers, key=lambda t: (t["qty"] / meta_pack if (meta_pack and _rip.normalize_unit(t.get("unit")) == "bottle") else t["qty"]))
        reached_amt, next_tier = 0.0, None
        for t in tiers_sorted:
            is_btl = _rip.normalize_unit(t.get("unit")) == "bottle"
            have = g["bottles"] if is_btl else g["cases"]
            if have >= t["qty"]:
                reached_amt = max(reached_amt, t["amount"])
            elif next_tier is None:
                need = t["qty"] - have
                next_tier = {"buy_qty": t["qty"], "unit": "bottles" if is_btl else "cases",
                             "more_needed": round(need, 1),
                             "more_cases_equiv": round(need / meta_pack, 1) if (is_btl and meta_pack) else round(need, 1),
                             "rebate": round(t["amount"], 2),
                             "extra_rebate_vs_current": round(t["amount"] - reached_amt, 2)}
        out.append({"rip_code": code, "distributor": ws,
                    "in_cart_cases": round(g["cases"], 1), "in_cart_bottles": round(g["bottles"], 1),
                    "current_rebate": round(reached_amt, 2) or 0,
                    "next_tier": next_tier,
                    "case_mix_in_cart": sorted(g["products"])[:8]})
    out.sort(key=lambda x: (x["next_tier"] or {}).get("extra_rebate_vs_current", 0), reverse=True)
    return out


def _t_cart_rip_tiers(con, args, ctx):
    """RIP tier maximizer for the user's CART, FAVORITES, or a LIST: sum the case
    (and bottle) quantity per RIP code across the Case Mix, find the tier currently
    reached and the NEXT tier, and report how many MORE cases/bottles unlock it and
    the extra rebate."""
    source, items = _load_basket(args, ctx)
    if source is None:
        return {"error": "user not signed in"}
    if not items:
        return {"source": source, "item_count": 0, "note": f"Your {source} is empty."}
    out = _rip_tier_plan(con, items)
    actionable = [o for o in out if o["next_tier"]]
    return {"source": source, "item_count": len(items), "rip_codes_in_cart": len(out), "tiers": out,
            "note": (f"{len(actionable)} rebate(s) have a reachable next tier — buy a few more to unlock extra $."
                     if actionable else "No reachable next tier — you're at the top of each rebate you carry.")}


def _t_edition_changes(con, args, ctx):
    """EDITION-DROP DIGEST — "what changed for me this month". Diffs the latest CPL
    edition vs the prior one: new items, new/lost discounts, new closeouts (from
    item_lifecycle) and the biggest effective price drops/increases (from
    price_changes). focus options:
      'all'                      — everything in the edition (default)
      'mine' / 'me'              — the user's WHOLE footprint: cart + favorites +
                                   lists + recently-ordered products (the personal
                                   "what changed for me" digest)
      'favorites' / 'cart' / 'lists' (+ optional list_name) — one source only."""
    focus = (args.get("focus") or "all").lower().strip()
    cap = min(int(args.get("limit") or 8), 25)
    focus_upcs = None
    _personal = {"favorites", "favourites", "watchlist", "wishlist", "cart",
                 "list", "lists", "mine", "me", "everything", "all mine"}
    if focus in _personal:
        uid = ctx.get("user_id")
        if not uid:
            return {"error": "user not signed in"}
        from backend.pg import get_pg
        want_cart = focus in ("cart", "mine", "me", "everything", "all mine")
        want_fav = focus in ("favorites", "favourites", "watchlist", "wishlist", "mine", "me", "everything", "all mine")
        want_list = focus in ("list", "lists", "mine", "me", "everything", "all mine")
        want_orders = focus in ("mine", "me", "everything", "all mine")
        upcs: set = set()
        with get_pg() as pg:
            if want_cart:
                for r in pg.execute("SELECT upc FROM cart_items WHERE user_id=%s AND COALESCE(saved_for_later,0)=0", (uid,)).fetchall():
                    if r.get("upc"):
                        upcs.add(str(r["upc"]).lstrip("0"))
            if want_fav:
                for r in pg.execute("SELECT upc FROM watchlist WHERE user_id=%s", (uid,)).fetchall():
                    if r.get("upc"):
                        upcs.add(str(r["upc"]).lstrip("0"))
            if want_list:
                ln = (args.get("list_name") or "").strip()
                if ln and focus in ("list", "lists"):
                    lrows = pg.execute(
                        "SELECT li.upc FROM list_items li JOIN lists l ON li.list_id=l.id "
                        "WHERE l.user_id=%s AND lower(l.name)=lower(%s)", (uid, ln)).fetchall()
                else:
                    lrows = pg.execute(
                        "SELECT li.upc FROM list_items li JOIN lists l ON li.list_id=l.id WHERE l.user_id=%s", (uid,)).fetchall()
                for r in lrows:
                    if r.get("upc"):
                        upcs.add(str(r["upc"]).lstrip("0"))
            if want_orders:
                for r in pg.execute(
                    "SELECT ol.upc FROM order_lines ol JOIN orders o ON o.id=ol.order_id "
                    "WHERE o.user_id=%s ORDER BY o.created_at DESC LIMIT 1000", (uid,)).fetchall():
                    if r.get("upc"):
                        upcs.add(str(r["upc"]).lstrip("0"))
        # Canonical label for the response.
        focus = ("mine" if focus in ("mine", "me", "everything", "all mine")
                 else "favorites" if focus in ("favorites", "favourites", "watchlist", "wishlist")
                 else "lists" if focus in ("list", "lists") else focus)
        focus_upcs = {u for u in upcs if u}
        if not focus_upcs:
            where = "cart, favorites, lists or orders" if focus == "mine" else f"your {focus}"
            return {"focus": focus, "focus_item_count": 0, "note": f"Nothing in {where} yet — nothing to focus on."}
    ed_row = con.execute("SELECT MAX(edition) FROM item_lifecycle").fetchone()
    ed = ed_row[0] if ed_row else None
    if not ed:
        return {"note": "No edition-change data available."}

    def _fc(col="upc"):
        if focus_upcs is None:
            return "", []
        if not focus_upcs:
            return "AND 1=0", []
        ph = ", ".join("?" for _ in focus_upcs)
        return f"AND LTRIM(CAST({col} AS VARCHAR),'0') IN ({ph})", list(focus_upcs)

    fc, fp = _fc()
    counts = {}
    for (et,) in con.execute(f"SELECT event_type FROM item_lifecycle WHERE edition=? {fc}", [ed] + fp).fetchall():
        counts[et] = counts.get(et, 0) + 1

    def _clean_rows(df):
        return _json_safe(df.to_dict(orient="records"))

    def _sample(et):
        return _clean_rows(con.execute(
            "SELECT wholesaler, product_name, CAST(upc AS VARCHAR) upc, unit_volume, product_type, curr_price "
            f"FROM item_lifecycle WHERE edition=? AND event_type=? {fc} LIMIT {cap}", [ed, et] + fp).fetchdf())

    fc2, fp2 = _fc()
    drops = _clean_rows(con.execute(
        "SELECT wholesaler, product_name, CAST(upc AS VARCHAR) upc, unit_volume, "
        "prev_effective_case_price AS prev, effective_case_price AS now, effective_delta AS delta, effective_delta_pct AS pct "
        f"FROM price_changes WHERE edition=? AND effective_delta < -0.01 {fc2} ORDER BY effective_delta ASC LIMIT {cap}",
        [ed] + fp2).fetchdf())
    ups = _clean_rows(con.execute(
        "SELECT wholesaler, product_name, CAST(upc AS VARCHAR) upc, unit_volume, "
        "prev_effective_case_price AS prev, effective_case_price AS now, effective_delta AS delta, effective_delta_pct AS pct "
        f"FROM price_changes WHERE edition=? AND effective_delta > 0.01 {fc2} ORDER BY effective_delta DESC LIMIT {cap}",
        [ed] + fp2).fetchdf())
    n_up = con.execute(f"SELECT COUNT(*) FROM price_changes WHERE edition=? AND effective_delta > 0.01 {fc2}", [ed] + fp2).fetchone()[0]
    n_down = con.execute(f"SELECT COUNT(*) FROM price_changes WHERE edition=? AND effective_delta < -0.01 {fc2}", [ed] + fp2).fetchone()[0]

    return {"edition": ed, "focus": focus,
            "focus_item_count": (len(focus_upcs) if focus_upcs is not None else None),
            "summary": {"new_items": counts.get("new_item", 0), "new_discounts": counts.get("new_discount", 0),
                        "lost_discounts": counts.get("lost_discount", 0), "new_closeouts": counts.get("new_clearance", 0),
                        "price_increases": int(n_up), "price_drops": int(n_down)},
            "top_price_drops": drops, "top_price_increases": ups,
            "new_items": _sample("new_item"), "new_discounts": _sample("new_discount"),
            "lost_discounts": _sample("lost_discount"), "new_closeouts": _sample("new_clearance"),
            "note": ("Latest-edition changes across your products (cart, favorites, lists & recent orders)."
                     if focus == "mine"
                     else f"Latest-edition changes affecting your {focus}." if focus_upcs is not None
                     else "Latest-edition changes.")}


_CTX_TOOLS = {
    "find_deals": (_t_find_deals, "Promotions: products on deal. Args: kind (time_sensitive|discount|clearance), limit. Shown as cards."),
    "price_movers": (_t_price_movers, "Products whose effective price changes next month. Args: direction (drop|increase), limit. Shown as cards."),
    "get_cart": (_t_get_cart, "The signed-in user's current cart items + quantities."),
    "get_favorites": (_t_get_favorites, "The signed-in user's favorited products."),
    "get_lists": (_t_get_lists, "The signed-in user's saved lists and item counts."),
    "get_orders": (_t_get_orders, "The signed-in user's 10 most recent orders (headers only)."),
    "get_sales_reps": (_t_get_sales_reps, "The user's sales reps + contact (name, distributor, email, phone). Use to show who to follow up with after an order, look up a rep's phone/email, or before messaging a rep."),
    "cart_rep_status": (_t_cart_rep_status, "ORDER-READINESS: per distributor in the cart, is a sales rep assigned (and who)? Plus existing reps + ready_to_submit. ALWAYS call before submit_order — a distributor with no rep won't be emailed. For gaps, assign (perform_action assign_rep) or create a rep (perform_action create_rep)."),
    "order_history": (_t_order_history, "REORDER / ORDER HISTORY: past orders WITH line items + a 'frequently ordered' rollup. Use for 'reorder my last order', 'same as last month', 'what do I usually buy/order', 'show my order history'. Pass order_id for one order. To re-add an order to the cart, then call perform_action(type=reorder, order_id=<id>) after confirming."),
    "lapsed_items": (_t_lapsed_items, "WIN-BACK: products the user ORDERED before but not recently, flagged when attractive again NOW (on a CPL discount, has a RIP rebate, or price dropped this edition). Use for 'what have I stopped buying', 'win-back opportunities', 'anything I used to order worth grabbing'. Lead with the why-now reason + current effective price; offer to add to cart."),
    "analyze_cart": (_t_analyze_cart, "SMART, COMPREHENSIVE analysis of the user's cart / favorites / a list (source: cart|favorites|list, optional list_name) — the one-stop 'analyze my cart/list' report. Returns ALL of: summary (current vs optimized EFFECTIVE total [list − discounts − best RIP] + total savings); cheaper_distributor (same UPC cheaper elsewhere); timing (this vs next month → BUY NOW / WAIT, or HOLD if next month isn't published yet); price_movement (how each line changed vs LAST month — dropped/rose — always useful, the only forward signal before next month's sheet lands); price_increase_warnings (lines rising next month); rip_tier_upgrades (buy more to unlock the next rebate, cart+lists); discount_tier_upgrades (deeper CPL discount at a higher qty); duplicate_lines (the SAME UPC on multiple lines — likely a double-add to fix before ordering); combo_opportunities; expiring_or_closeout (time-sensitive ending soon / closeouts). Use for 'analyze my cart', 'analyze my list(s)/wishlist', 'is anyone cheaper', 'buy now or wait', 'am I near a tier'."),
    "optimize_cart": (_t_optimize_cart, "ORDER OPTIMIZER for the user's cart / favorites / a list (source: cart|favorites|list): the cheapest sourcing PLAN — per line picks the lowest effective-price distributor for that UPC, groups the wins into (from->to) distributor swaps with $ saved, and gives current vs optimized total. Use for 'optimize my cart/list', 'make my order cheaper', 'cheapest way to buy this'. Present current vs optimized total + the grouped swaps, then offer to apply each via perform_action(type=swap_distributor)."),
    "cart_timing": (_t_cart_timing, "BUY-NOW-vs-WAIT sweep of the user's cart / favorites / a list (source: cart|favorites|list): per line compares the current edition's effective price to the REAL next edition's and flags BUY NOW (rises or drops off next month) vs WAIT (falls next month), with $ impact + totals. If next month isn't published yet it says so (HOLD) instead of guessing. Use for 'should I buy now or wait', 'scan my cart/list for timing', 'what's going up next month'."),
    "cart_rip_tiers": (_t_cart_rip_tiers, "RIP tier maximizer for the user's cart / favorites / a list (source: cart|favorites|list): sums the case/bottle quantity per RIP code (the Case Mix), shows the tier reached and the NEXT tier, and how many MORE cases/bottles unlock it + the extra rebate. Use for 'am I close to any rebate tiers', 'how do I hit the next RIP tier', 'maximize my rebates'."),
    "edition_changes": (_t_edition_changes, "EDITION-DROP DIGEST — 'what changed for ME this month'. Diffs the latest CPL edition vs prior: counts + samples of new items, new/lost discounts, new closeouts, and the biggest effective price drops/increases. focus='mine' = the user's WHOLE footprint (cart + favorites + lists + recently-ordered products) — USE THIS for 'what changed for me', 'what's new for my brands', 'anything I should know this month'. Also focus='all' (default), 'favorites', 'cart', or 'lists' (+ list_name). Lead with what affects the buyer: price drops on their items, new RIP/discounts, then increases to act on. Offer to act (add to cart, analyze)."),
}


def _tool_specs() -> list:
    specs = []
    common_props = {
        "match": {"type": "string"}, "category": {"type": "string"},
        "distributor": {"type": "string"}, "has_rip": {"type": "boolean"},
        "has_discount": {"type": "boolean"}, "price_min": {"type": "number"},
        "price_max": {"type": "number"},
        "order_by": {"type": "string", "enum": ["cheapest", "expensive"]},
        "limit": {"type": "number"},
        "rip_code": {"type": "string", "description": "A specific RIP rebate code (for rip_lookup)."},
        "month": {"type": "string", "description": "Target month / edition for rip_lookup, e.g. 'May', 'May 2026', or '2026-05'. Pass whenever the user names a month so a rebate that existed then but has since expired is still found. Omit for the current month."},
        "months": {"type": "number", "description": "For price_timeline: how many recent editions/months to include (default 12, max 36)."},
        "sizes": {"type": "array", "items": {"type": "string"},
                  "description": "Restrict to specific bottle sizes the buyer named, e.g. ['1.75L','750mL']. Bare numbers work ('1.75','750'). ALWAYS set this when the user specifies a size — do not return other sizes."},
        "region": {"type": "string", "description": "Region / origin hint (california, napa, sonoma, bordeaux, tuscany, italy, france, spain, kentucky, scotland, mexico, ...). Use this for ANY geography query instead of putting the place name in `match` — `match='california'` wrongly matches ABSOLUT CALIFORNIA. Auto-narrows product_type (california -> Wine, kentucky -> Spirits)."},
        "varietal": {"type": "string", "description": "Varietal / style hint (cabernet, pinot noir, chardonnay, prosecco, ipa, bourbon, single malt, reposado, ...). Use instead of `match` for grape/style queries; stacks with region ('California cabernets')."},
        "price_trend": {"type": "string", "enum": ["increase", "drop"], "description": "Narrow to products whose price is going UP ('increase') or DOWN ('drop') in the latest edition. Combine with region/varietal/category, e.g. 'California wines going up' = region=california + price_trend=increase."},
    }
    for name, (_fn, desc) in _DATA_TOOLS.items():
        specs.append({"name": name, "description": desc,
                      "input_schema": {"type": "object", "properties": common_props}})
    # Context tools (deals + the signed-in user's cart/favorites/lists/orders).
    ctx_props = {**common_props,
                 "kind": {"type": "string", "enum": ["time_sensitive", "discount", "clearance"]},
                 "direction": {"type": "string", "enum": ["drop", "increase"]},
                 "source": {"type": "string", "enum": ["cart", "favorites", "list"],
                            "description": "Which basket to analyze for cart tools (analyze_cart, optimize_cart, cart_timing, cart_rip_tiers). 'favorites' = wishlist/watchlist. Defaults to cart."},
                 "focus": {"type": "string", "enum": ["all", "mine", "favorites", "cart", "lists"],
                           "description": "edition_changes scope. 'mine' = the user's whole footprint (cart+favorites+lists+recent orders) — use for 'what changed for me'."},
                 "order_id": {"type": "integer", "description": "order_history: fetch one specific past order by id."},
                 "lapsed_days": {"type": "integer", "description": "lapsed_items: how many days since last order counts as 'lapsed' (default 45)."},
                 "list_name": {"type": "string", "description": "When source='list' (or focus='lists'), the list to target (omit for all of the user's lists)."}}
    for name, (_fn, desc) in _CTX_TOOLS.items():
        specs.append({"name": name, "description": desc,
                      "input_schema": {"type": "object", "properties": ctx_props}})
    # Action tools
    specs.append({
        "name": "perform_action",
        "description": ("Perform a user action: add_to_cart, update_quantity, add_to_favorites, add_to_list, "
                        "remove_from_cart, swap_distributor. Resolves the product(s) by `match`+`which` (use "
                        "which='all' with remove_from_cart to remove every matching cart line). To add/act on an ENTIRE "
                        "RIP Case Mix (e.g. 'add all the case mix to cart', 'add all these'), pass "
                        "`rip_code`=<the code> (optionally `distributor`) — it resolves EVERY product sharing "
                        "that code. swap_distributor REPLACES the user's cart items from `from_distributor` "
                        "with the SAME products (matched by UPC) at `to_distributor`, preserving quantities — "
                        "pass `rip_code` to limit it to one Case Mix, else it swaps every line from that "
                        "distributor. Use for 'swap/replace/move <X> to <distributor>'. "
                        "submit_order SENDS the active cart as orders (one per sales rep) and EMAILS each rep. "
                        "It is irreversible from chat — ONLY call it after (a) you have run the pre-send review "
                        "(analyze_cart) and surfaced any mistakes, and (b) the user has explicitly confirmed "
                        "they want to send. Use for 'send/submit/place my order', 'email this to my rep'. "
                        "message_rep emails a free-text question/message to a sales rep (rep_id from "
                        "get_sales_reps, message=<text>) — use for 'ask my Fedway rep if X is in stock', "
                        "'tell my rep ...'; confirm the recipient + message first. set_order_note attaches a "
                        "header note (order_note) to the order for a distributor — use for 'add a note to my "
                        "Fedway order: deliver after 2pm', 'note on this order: ...'. It rides on the PO when sent. "
                        "assign_rep sets an EXISTING sales rep (distributor + rep_id) on that distributor's cart "
                        "lines. create_rep creates a NEW rep (rep_name + rep_email + rep_phone + distributor) and "
                        "assigns them — use when a distributor has no rep and none on file fits; then submit_order."),
        "input_schema": {"type": "object", "properties": {
            "type": {"type": "string", "enum": list(_ACTION_TYPES)},
            "match": {"type": "string"},
            "which": {"type": "string", "enum": ["cheapest", "most_expensive", "first", "all"]},
            "rip_code": {"type": "string", "description": "Scope add/swap to this RIP code's Case Mix."},
            "from_distributor": {"type": "string", "description": "swap_distributor: distributor to move OUT of."},
            "to_distributor": {"type": "string", "description": "swap_distributor: distributor to move INTO."},
            "category": {"type": "string"}, "distributor": {"type": "string"},
            "has_rip": {"type": "boolean"}, "has_discount": {"type": "boolean"},
            "cases": {"type": "number"}, "bottles": {"type": "number"},
            "order_id": {"type": "integer", "description": "reorder: the past order to copy back into the cart."},
            "rep_id": {"type": "integer", "description": "message_rep: the sales rep (from get_sales_reps) to email."},
            "message": {"type": "string", "description": "message_rep: the message/question to email the rep."},
            "order_note": {"type": "string", "description": "set_order_note: header note for the order at `distributor` (rides on the PO when sent)."},
            "rep_name": {"type": "string", "description": "create_rep: new sales rep's name."},
            "rep_email": {"type": "string", "description": "create_rep: new sales rep's email (so the order can be emailed)."},
            "rep_phone": {"type": "string", "description": "create_rep: new sales rep's phone."},
            "list_name": {"type": "string"},
        }, "required": ["type"]},
    })
    # Drive the on-screen view (navigate + filter the page on the left) instead
    # of dumping product lists in the chat.
    specs.append({
        "name": "show_on_screen",
        "description": ("Show results on the SCREEN (the page to the left of the chat) instead of listing them "
                        "in chat. Use for any 'show me / find / list / filter' request that a page can display. "
                        "Pick the best route and filters; reply with a ONE-LINE confirmation."),
        "input_schema": {"type": "object", "properties": {
            "route": {"type": "string", "enum": list(_SCREEN_ROUTES.keys())},
            "q": {"type": "string", "description": "Free-text search (brand/product keywords). Use ONLY for brand or product name. Do NOT put country/region/origin words here (use `region` instead) — passing 'California' as q matches ABSOLUT CALIFORNIA cans, not California wines."},
            "categories": {"type": "array", "items": {"type": "string"}},
            "distributors": {"type": "array", "items": {"type": "string"}},
            "sizes": {"type": "array", "items": {"type": "string"}},
            "region": {"type": "string", "description": "Region / origin / geography filter. Pass a canonical region key (california, napa, sonoma, oregon, washington, bordeaux, burgundy, tuscany, piedmont, rioja, champagne, italy, france, spain, argentina, chile, australia, new zealand, germany, portugal, kentucky, scotland, ireland, japan, mexico) or a natural phrase the backend resolves (e.g. 'tuscan', 'bourbon', 'californian'). The backend filters by product-name tokens + enrichment description and AUTO-NARROWS to the implied product_type (e.g. region=california auto-applies product_type=Wine). USE THIS for any 'wines from X', 'X reds', 'X bourbons', 'X whiskies' question — do NOT pass the geography as q."},
            "varietal": {"type": "string", "description": "Varietal / style / sub-type filter (grape variety, spirit sub-type, beer style, production method). Pass a canonical key or a natural phrase. Coverage: wine reds (cabernet, merlot, pinot noir, syrah, malbec, zinfandel, sangiovese, nebbiolo, tempranillo, grenache, red blend), wine whites (chardonnay, sauvignon blanc, pinot grigio, riesling, viognier, white blend), rose + sparkling (rose, prosecco, cava, sparkling, blanc de blancs, blanc de noirs, brut nature, late harvest), wine styles (old vine, reserva, gran reserva, biodynamic, organic wine, natural wine, orange wine), whiskey (whiskey, bourbon, rye, tennessee whiskey, wheated bourbon, scotch, single malt, islay scotch, speyside scotch, highland scotch, irish whiskey, japanese whisky, canadian whisky), spirit production (single barrel, small batch, cask strength, bottled in bond), agave (tequila, blanco, reposado, anejo, extra anejo, cristalino, mezcal), other spirits (vodka, gin, navy strength gin, rum, overproof rum, brandy, cognac, armagnac, liqueur, amaro, aperitif, vermouth, bitter), beer (ipa, double ipa, hazy ipa, session ipa, lager, stout, imperial stout, sour, wheat beer, saison, kolsch, belgian), other (hard cider). Natural phrasings work: 'cabernets', 'islay', 'hazy', 'wheated', 'farmhouse ale', 'overproof', 'small batches', 'orange wines', 'amaro'. Stacks with region — 'California cabernets' = region=california + varietal=cabernet; 'Islay single malts' = varietal=islay scotch. Auto-narrows product_type (varietal=ipa -> Beer; varietal=cristalino -> Spirits; varietal=hard cider -> Cider). NEVER put grape names or sub-styles in q."},
            "has_rip": {"type": "boolean"}, "has_discount": {"type": "boolean"},
            "price_min": {"type": "number"}, "price_max": {"type": "number"},
            "sort": {"type": "string", "enum": ["product_name", "frontline_case_price", "effective_case_price"]},
            "order": {"type": "string", "enum": ["asc", "desc"]},
            "group_by_rip": {"type": "boolean", "description": "Catalog only: group products into Case-Mix RIP clusters with tier ladders + Add-All-to-Cart. Use for 'show RIP / Case Mix' requests."},
            "price_trend": {"type": "string", "enum": ["increase", "drop"], "description": "Catalog only: narrow to products whose price is going UP ('increase') or DOWN ('drop') in the latest edition. Use for 'only show prices going up / rising / increasing' or 'prices dropping / falling'. Stays on the catalog and filters in place."},
            "window": {"type": "string", "enum": ["partial", "full"], "description": "Time-Sensitive route only: 'partial' = deals that do NOT start on the 1st and end on the last day of the month (true short-window deals); 'full' = full-calendar-month promos."},
            "label": {"type": "string", "description": "Short human label of what's being shown."},
        }, "required": ["route"]},
    })
    return specs


def _rip_case_mix_products(con, code, ws=None, limit=80) -> list:
    """Every product sharing a RIP code (the Case Mix) as cart-ready dicts. The
    case mix is defined by the RIP sheet's UPCs for the code, joined to the latest
    CPL edition for prices — so 'add all the case mix' adds ALL members, not just
    the one the name search happened to resolve."""
    cym = _current_ym()
    # RIP codes are recycled across editions, so the Case Mix is ONLY the UPCs that
    # carry this code in the LATEST edition the code appears in (per distributor) —
    # never every edition <= now, which would mix in last month's different product.
    cond = "CAST(rip_code AS VARCHAR) = ?"
    sub = [str(code)]
    if ws:
        cond += " AND wholesaler = ?"
        sub.append(ws)
    pr = sub + sub
    try:
        df = con.execute(
            f"WITH cur AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched WHERE edition<='{cym}' GROUP BY wholesaler), "
            f"ripupc AS (SELECT DISTINCT wholesaler, LTRIM(CAST(upc AS VARCHAR),'0') un FROM rip "
            f"WHERE {cond} AND edition = (SELECT MAX(edition) FROM rip WHERE {cond} AND edition<='{cym}') "
            "  AND upc IS NOT NULL "
            "  AND CAST(upc AS VARCHAR) NOT IN ('', '0', 'None', 'nan') "
            "  AND LTRIM(CAST(upc AS VARCHAR), '0') NOT IN ('', 'None', 'nan')) "
            "SELECT DISTINCT c.product_name, c.wholesaler, CAST(c.upc AS VARCHAR) AS upc, c.unit_volume, "
            "c.unit_qty, c.vintage, c.effective_case_price, c.frontline_case_price "
            "FROM cpl_enriched c JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed "
            "JOIN ripupc r ON r.wholesaler=c.wholesaler AND r.un=LTRIM(CAST(c.upc AS VARCHAR),'0') "
            f"WHERE c.product_name IS NOT NULL "
            "  AND c.upc IS NOT NULL "
            "  AND LTRIM(CAST(c.upc AS VARCHAR), '0') NOT IN ('', 'None', 'nan') "
            f"ORDER BY c.product_name LIMIT {int(limit)}", pr).fetchdf()
        return df.to_dict(orient="records")
    except Exception:
        return []


def _do_action(con, args, actions_out) -> dict:
    atype = args.get("type")
    if atype not in _ACTION_TYPES:
        return {"error": "unknown action"}
    # Distributor swap: replace cart items from one distributor with the same
    # products (by UPC) at another. Carries no products — the frontend calls the
    # /api/cart/swap-distributor endpoint, which resolves equivalents + edits the
    # user's cart server-side. Optional rip_code scopes it to one Case Mix.
    if atype == "swap_distributor":
        frm = (args.get("from_distributor") or args.get("distributor") or "").strip()
        to = (args.get("to_distributor") or "").strip()
        code = str(args.get("rip_code") or "").strip()
        code = code if code not in ("", "0", "None", "nan") else None
        action = {"type": "swap_distributor", "cases": 0, "bottles": 0, "list_name": None,
                  "products": [], "from_distributor": frm or None, "to_distributor": to or None,
                  "rip_code": code,
                  "note": None if (frm and to) else "Need both a from- and a to-distributor to swap."}
        actions_out.append(action)
        return {"swap": {"from": frm, "to": to, "rip_code": code}}
    # Submit order: turn the active cart into orders (one per sales rep) and EMAIL
    # each rep. The frontend calls POST /api/cart/send after a confirmation dialog
    # — never sent without the buyer's explicit OK. Carries no products.
    if atype == "submit_order":
        action = {"type": "submit_order", "cases": 0, "bottles": 0, "list_name": None,
                  "products": [], "note": None}
        actions_out.append(action)
        return {"submit_order": True,
                "note": "Will email the order to your sales rep(s) after you confirm."}
    # Reorder: copy a past order's lines back into the cart. The frontend calls
    # POST /api/cart/reorder with the order_id after a confirmation dialog.
    if atype == "reorder":
        try:
            oid = int(args.get("order_id"))
        except (TypeError, ValueError):
            oid = None
        action = {"type": "reorder", "cases": 0, "bottles": 0, "list_name": None,
                  "products": [], "order_id": oid,
                  "note": None if oid else "Need an order_id to reorder."}
        actions_out.append(action)
        return {"reorder": {"order_id": oid}}
    # Message a sales rep by email. The frontend POSTs the message to
    # /api/sales-reps/{id}/message after a confirmation dialog.
    if atype == "message_rep":
        try:
            rid = int(args.get("rep_id"))
        except (TypeError, ValueError):
            rid = None
        msg = (args.get("message") or "").strip()
        action = {"type": "message_rep", "cases": 0, "bottles": 0, "list_name": None,
                  "products": [], "rep_id": rid, "message": msg or None,
                  "note": None if (rid and msg) else "Need a rep and a message to send."}
        actions_out.append(action)
        return {"message_rep": {"rep_id": rid, "has_message": bool(msg)}}
    # Order note: a per-distributor header note that rides along on the order when
    # sent. The frontend POSTs it to /api/cart/group-note.
    if atype == "set_order_note":
        dist = (args.get("distributor") or "").strip()
        text = (args.get("order_note") or args.get("message") or "").strip()
        action = {"type": "set_order_note", "cases": 0, "bottles": 0, "list_name": None,
                  "products": [], "distributor": dist or None, "order_note": text,
                  "note": None if (dist and text) else "Need a distributor and note text."}
        actions_out.append(action)
        return {"set_order_note": {"distributor": dist, "has_text": bool(text)}}
    # Assign an existing sales rep to a distributor's cart lines (so the order can
    # be emailed). Frontend calls POST /api/cart/assign-rep.
    if atype == "assign_rep":
        dist = (args.get("distributor") or "").strip()
        try:
            rid = int(args.get("rep_id"))
        except (TypeError, ValueError):
            rid = None
        action = {"type": "assign_rep", "cases": 0, "bottles": 0, "list_name": None,
                  "products": [], "distributor": dist or None, "rep_id": rid,
                  "note": None if (dist and rid) else "Need a distributor and rep_id to assign."}
        actions_out.append(action)
        return {"assign_rep": {"distributor": dist, "rep_id": rid}}
    # Create a NEW sales rep (name + email + phone) and assign them to the
    # distributor's cart lines. Frontend creates via /api/sales-reps then assigns.
    if atype == "create_rep":
        dist = (args.get("distributor") or "").strip()
        rname = (args.get("rep_name") or "").strip()
        remail = (args.get("rep_email") or "").strip()
        rphone = (args.get("rep_phone") or "").strip()
        action = {"type": "create_rep", "cases": 0, "bottles": 0, "list_name": None,
                  "products": [], "distributor": dist or None,
                  "rep_name": rname or None, "rep_email": remail or None, "rep_phone": rphone or None,
                  "note": None if (rname and dist) else "Need at least a rep name and distributor."}
        actions_out.append(action)
        return {"create_rep": {"distributor": dist, "name": rname, "has_email": bool(remail)}}
    which = args.get("which") if args.get("which") in ("cheapest", "most_expensive", "first", "all") else "first"
    cap = 10 if which == "all" else 1
    view = {
        "categories": [args["category"]] if args.get("category") else [],
        "divisions": [args["distributor"]] if args.get("distributor") else [],
        "hasRip": args.get("has_rip"), "hasDiscount": args.get("has_discount"),
    }
    # Whole-Case-Mix action: a rip_code resolves EVERY member, not just one name.
    rip_code = str(args.get("rip_code") or "").strip()
    if rip_code and rip_code not in ("0", "None", "nan"):
        prods = _rip_case_mix_products(con, rip_code, args.get("distributor"))
    else:
        prods = _resolve_products(con, view, args.get("match") or "", which, cap)
    cases = int(args["cases"]) if isinstance(args.get("cases"), (int, float)) else 0
    bottles = int(args["bottles"]) if isinstance(args.get("bottles"), (int, float)) else 0
    if atype in ("add_to_cart", "update_quantity") and cases == 0 and bottles == 0:
        cases = 1
    action = {
        "type": atype, "cases": cases, "bottles": bottles,
        "list_name": (str(args.get("list_name")).strip() or None) if args.get("list_name") else None,
        "products": prods, "note": None if prods else "No matching product found.",
    }
    actions_out.append(action)
    return {"resolved": [p["product_name"] for p in prods], "count": len(prods),
            "cases": cases, "bottles": bottles}


_SCREEN_ROUTES = {
    "catalog": "/catalog", "time_sensitive": "/time-sensitive", "major_discounts": "/major-discounts",
    "price_drops": "/price-drops", "price_increases": "/price-increases", "clearance": "/clearance",
    "combos": "/combos", "new_items": "/new-items", "favorites": "/watchlist", "lists": "/lists",
    "orders": "/orders", "cart": "/cart",
}

# Pages whose grid filters in place by a ?q= search term/UPC. A UPC typed on one
# of these stays on the page (filters it); elsewhere it falls back to the catalog.
_Q_FILTER_PATHS = {"/catalog", "/price-increases", "/price-drops", "/time-sensitive", "/major-discounts"}

# Per-screen scope: each page's assistant only helps with THAT page's subject.
# Keyed by the page label the frontend sends. Catalog is the broad browse view;
# the rest are narrow. Unknown pages fall back to the general scope.
_PAGE_SCOPE = {
    "Catalog": "the product catalog — searching/filtering products, prices, per-product price breakdowns, RIP rebates, comparing distributors, and the deals on those products",
    "Price Increases": "products whose price went UP in the latest edition versus the prior one — finding, sorting, filtering and explaining those increases (and price detail on those products)",
    "Price Drops": "products whose price went DOWN in the latest edition versus the prior one — finding, sorting, filtering and explaining those drops (and price detail on those products)",
    "Time-Sensitive Deals": "deals that end on a specific date soon (time-sensitive promotions) and the products on them",
    "Major Discounts": "the biggest case discounts and the products on them",
    "Combos": "combo / bundle deals and their products",
    "New Items": "products newly added in this edition",
    "Favorites": "the products the user has saved to Favorites",
    "Lists": "the user's saved product lists and their items",
    "Orders": "the user's draft and past orders",
    "Cart": "the user's current cart and its items",
    "Dashboard": "the dashboard overview and its highlights",
    "RIP Products": "products that carry RIP rebates and their Case-Mix groupings",
}


_CATEGORY_CACHE: dict = {}


def _known_categories() -> dict:
    """Canonical product_type values keyed by UPPER() for case-insensitive
    lookup. In this data the catalog's 'category' is a BROAD product type
    (Spirits, Wine, Beer, Cider, Seltzer, RTD, Sparkling, Vermouth, ...) — there
    is no 'Tequila'/'Vodka'/'IPA'/'Chardonnay' category; those are subtypes that
    live inside a category and are only findable by NAME. Cached for the process
    lifetime (categories don't change between editions in practice)."""
    if not _CATEGORY_CACHE:
        try:
            with get_duckdb() as con:
                rows = con.execute(
                    "SELECT DISTINCT product_type FROM cpl_enriched "
                    "WHERE product_type IS NOT NULL").fetchall()
            for (pt,) in rows:
                if pt:
                    _CATEGORY_CACHE[str(pt).upper()] = str(pt)
        except Exception:
            pass
    return _CATEGORY_CACHE


def _split_categories(values: list) -> tuple[list, list]:
    """Split requested category values into (real categories, leftover terms).
    A value that matches a known product_type (case-insensitively) is a real
    category; anything else (e.g. 'tequila') is a subtype the grid can't filter
    by, so we hand it back to be folded into the free-text search instead."""
    known = _known_categories()
    cats, leftover = [], []
    for c in values:
        s = str(c).strip()
        if not s:
            continue
        canon = known.get(s.upper())
        if canon:
            cats.append(canon)
        else:
            leftover.append(s)
    return cats, leftover


def _build_screen(args: dict, page_path: str | None = None,
                  page_query: str | None = None) -> dict:
    """Turn a show_on_screen tool call into a navigable path (+ catalog filters
    encoded as query params the pages already read) and a short label.

    STRICT no-leave: the docked assistant is scoped to its page and must NEVER
    navigate the user away from it. When we know the current page (page_path is
    set — i.e. the side-panel assistant), we IGNORE the model's chosen route and
    pin the screen to the current page, carrying only the filters that page can
    apply (the catalog takes the full filter set; the other grid pages take the
    free-text ?q, and Time-Sensitive also takes ?window). page_path is only
    omitted on the standalone Celar page, which is a full navigator."""
    from urllib.parse import urlencode, parse_qs
    route = (args.get("route") or "catalog").lower()
    model_base = _SCREEN_ROUTES.get(route, "/catalog")
    base = page_path if (page_path and page_path.startswith("/")) else model_base
    q: dict = {}
    search_terms: list = []
    if args.get("q"):
        search_terms.append(str(args["q"]).strip())
    # Follow-up composition: when already on the catalog and this call only
    # REFINES (e.g. 'only show prices going up') without naming a new scope,
    # carry forward the current scoping filters so 'California wines' then
    # 'only show prices going up' stays California. Naming a new scope replaces.
    sets_scope = bool(args.get("q") or args.get("region") or args.get("varietal")
                      or args.get("categories") or args.get("distributors"))
    if base == "/catalog" and page_query and not sets_scope:
        prior = parse_qs(page_query.lstrip("?"))
        for k in ("region", "varietal", "categories", "divisions", "sizes",
                  "hasRip", "hasDiscount", "priceMin", "priceMax", "q",
                  "group_by_rip"):
            if prior.get(k):
                q[k] = prior[k][0]
    if base == "/catalog":
        if isinstance(args.get("categories"), list) and args["categories"]:
            # Smart category handling: keep real product-type categories, but
            # fold subtypes the catalog can't filter by (tequila, vodka, IPA,
            # chardonnay, ...) into the free-text search so the grid actually
            # returns rows instead of "0 results".
            cats, leftover = _split_categories(args["categories"])
            if cats:
                q["categories"] = ",".join(cats)
            search_terms.extend(leftover)
        if isinstance(args.get("distributors"), list) and args["distributors"]:
            q["divisions"] = ",".join(str(d) for d in args["distributors"])
        if isinstance(args.get("sizes"), list) and args["sizes"]:
            q["sizes"] = ",".join(str(s) for s in args["sizes"])
        if args.get("has_rip") is True:
            q["hasRip"] = "1"
        if args.get("has_discount") is True:
            q["hasDiscount"] = "1"
        if isinstance(args.get("price_min"), (int, float)):
            q["priceMin"] = str(args["price_min"])
        if isinstance(args.get("price_max"), (int, float)):
            q["priceMax"] = str(args["price_max"])
        if args.get("sort") in ("product_name", "frontline_case_price", "effective_case_price"):
            q["sort"] = args["sort"]
        if args.get("order") in ("asc", "desc"):
            q["order"] = args["order"]
        if args.get("group_by_rip") is True:
            q["group_by_rip"] = "1"   # group products into Case-Mix RIP clusters
        # 'prices going up / down' -> the catalog's price-trend filter. The
        # grid reads ?price_increase=1 / ?price_drop=1 and narrows in place,
        # so the user stays on the catalog instead of jumping to another page.
        pt = (args.get("price_trend") or "").lower()
        if pt in ("increase", "up", "rising", "rise"):
            q["price_increase"] = "1"
            q.pop("price_drop", None)
        elif pt in ("drop", "down", "decrease", "falling", "fall"):
            q["price_drop"] = "1"
            q.pop("price_increase", None)
    # Semantic hints — region + varietal — apply to ANY route. Today only
    # /catalog actually consumes them server-side (via region_semantics /
    # varietal_semantics), but the URL carries them on other routes too so
    # those pages can adopt the same filters in a follow-up without changing
    # the assistant. The frontend Catalog page reads ?region= and ?varietal=
    # straight through to the API.
    if isinstance(args.get("region"), str) and args["region"].strip():
        q["region"] = args["region"].strip()
    if isinstance(args.get("varietal"), str) and args["varietal"].strip():
        q["varietal"] = args["varietal"].strip()
    # Time-Sensitive: 'partial' = deals NOT spanning a full calendar month.
    if base == "/time-sensitive" and args.get("window") in ("partial", "full"):
        q["window"] = args["window"]
    # Free-text search: the model's q plus any subtype terms we folded out of the
    # category filter (e.g. 'tequila'). Joined into one ?q the grid resolves
    # against product name/brand/description.
    terms = [t for t in search_terms if t]
    if terms:
        q["q"] = " ".join(dict.fromkeys(terms))   # de-dupe, preserve order
    path = base + ("?" + urlencode(q) if q else "")
    return {"path": path, "label": (args.get("label") or "your request").strip()}


_SYSTEM = (
    "You are Celar AI Assistant for an independent US liquor store, working inside a wholesale "
    "pricing app. In docked mode you sit in a side panel next to the DATA GRID (the page); in "
    "standalone mode (the /celar page) there is no grid — the chat is the only view. The runtime "
    "tells you which mode you're in via an extra system block. "
    "SCOPE — strict: you ONLY help with THIS app's wholesale (NJ ABC) pricing data and directly "
    "related buying research — products, case/bottle prices, CPL discounts, RIP rebates, deals, "
    "distributors, price comparisons, price history/trends, and buy decisions based on that data. "
    "You are NOT a general-purpose chatbot. If asked anything outside this scope (general knowledge, "
    "current events, coding, math puzzles, personal/medical/legal advice, other businesses, jokes, "
    "chit-chat) decline in ONE short sentence and steer back, e.g. \"I can only help with your catalog "
    "pricing, deals and RIP rebates — what would you like to look up?\" Do not answer off-topic "
    "questions even if you know the answer, and never invent catalog data. "
    "SELF-VERIFY before you assert. Every number (price, rebate, savings, tier qty, count) and every "
    "definitive claim ('exclusive to X', 'not carried by Y', 'the cheapest', 'the only', 'no RIP', 'the best "
    "tier') MUST come from a tool result you actually called THIS turn — never from memory, the product name, "
    "or assumption. Rules: (1) cross-distributor / carry / exclusivity claims require a UPC-resolved tool "
    "(compare_distributors or rip_lookup) — a name not matching another distributor is NOT evidence it isn't "
    "carried. (2) 'best/only tier' or rebate totals require the full tier ladder from rip_lookup/deal_360. "
    "(3) if you didn't call the tool, don't make the claim — call it or say you need to check. (4) sanity-check "
    "results before quoting: skip rows where a rebate exceeds the case price or a same-product gap looks like "
    "bad data, and never headline an absurd figure. When unsure, hedge and verify rather than state. "
    "PRICE PRECISION — never quote a RANGE when the buyer is on a specific item/size. State the EXACT "
    "frontline case price (BEFORE rebate) AND the EXACT effective case price (AFTER the best RIP rebate) "
    "for that one SKU, e.g. 'Absolut Vodka 80 1.75L (Fedway): $242.94/cs frontline -> $154.54/cs after the "
    "best RIP'. Always give the before-RIP and after-RIP number as two precise figures, not '$87-$154'. A "
    "range is only acceptable when you are deliberately summarising several DIFFERENT SKUs and you also "
    "list each one's exact pair. SIZE SPECIFICITY — when the buyer names size(s) (1.75L, 750mL, 1L, etc.), "
    "answer ONLY those sizes: filter to them and ignore unrequested sizes, variety packs, cans, and "
    "flavoured variants unless they ask. If a requested size isn't carried, say so plainly. Match the size "
    "they typed (treat '1.75', '1.75L', '1.75 L' the same; '750', '750ml', '750mL' the same). "
    "Your PRIMARY job (DOCKED MODE only) is to surface value in the grid next to the chat. DEFAULT TO "
    "THE GRID in docked mode: for ANY request that can be shown as a filtered/sorted list of products "
    "or deals — find, show, list, cheapest, on discount, with RIP, under $X, by category/distributor/"
    "size, ending soon, dropping next month — ALWAYS call show_on_screen (pick the route + filters) and "
    "reply with ONLY a one-line confirmation that ends by offering more help, e.g. 'Showing wine under "
    "$150 with a RIP rebate on the page. Anything else I can help with?'. Never list those products in "
    "chat in docked mode. The goal on EVERY screen is: show the data on the main screen first, then "
    "ask how else you can help. (In standalone mode this rule is OVERRIDDEN — see the standalone "
    "addendum below.) "
    "CATEGORIES are BROAD product types only: Spirits, Wine, Beer, Cider, Seltzer, RTD, Sparkling, "
    "Vermouth, Malt, Tea, FAB, Non-Alc (and a few more). SUBTYPES like tequila, vodka, chardonnay, "
    "cabernet, prosecco, IPA, lager are NOT categories — never put them in the categories filter "
    "(it returns 0 results). Search them as free text instead: show_on_screen(q='tequila', "
    "sort=effective_case_price, order=asc). The search looks inside the product name AND the enriched "
    "description/category, so the subtype is found even when the name doesn't spell it out. "
    "REGION / ORIGIN: for ANY query about geography — 'California wines', 'Napa cabs', 'Bordeaux reds', "
    "'Italian wine', 'bourbon', 'scotch single malt', 'Mexican tequila' — you MUST use the `region` arg "
    "on show_on_screen. NEVER pass the geography word in `q`. Doing so matches stray substrings (e.g. "
    "q='California' surfaces ABSOLUT CALIFORNIA CANS, which is a flavoured vodka, not a California wine). "
    "Accepted region keys include: california, napa, sonoma, oregon, washington, bordeaux, burgundy, "
    "tuscany, piedmont, rioja, champagne, italy, france, spain, argentina, chile, australia, new zealand, "
    "germany, portugal, kentucky, scotland, ireland, japan, mexico. Natural phrasings like 'tuscan', "
    "'bourbon', 'californian', 'bordeaux reds' resolve automatically — pass them verbatim. The region "
    "filter auto-narrows product_type when implied (region=california means Wine; region=kentucky means "
    "Spirits). "
    "VARIETAL / STYLE: for ANY query mentioning a grape variety, spirit sub-type or beer style — "
    "'cabernet', 'pinot noir', 'chardonnay', 'IPAs', 'bourbon', 'single malt', 'reposado tequila', "
    "'prosecco', 'merlot' — use the `varietal` arg. NEVER put grape names or spirit styles in q. "
    "Combine with region to stack: 'California cabernets' is region=california + varietal=cabernet; "
    "'Italian reds' is region=italy + varietal='red blend' (or omit varietal for any Italian red); "
    "'Kentucky bourbon' is region=kentucky + varietal=bourbon (already implied by region, varietal "
    "adds robustness). The varietal filter also auto-narrows product_type (varietal=ipa -> Beer, "
    "varietal=reposado -> Spirits, varietal=prosecco -> Sparkling). "
    "Reserve q ONLY for brand or producer name when no region/varietal exists for it (e.g. q='caymus' "
    "to find Caymus brand, q='sutter home' to find Sutter Home). If a user query maps to a known "
    "region or varietal, use those slots; q is the last resort. "
    "SEMANTIC SEARCH (long tail): for descriptive natural-language queries that DON'T map cleanly to "
    "the region or varietal vocabularies — 'biodynamic Burgundy', 'small-producer natural orange wine', "
    "'rare cask-strength bourbons', 'elegant cool-climate pinots', 'high-altitude napa cabs from "
    "specific producers' — call the semantic_search tool with q=<the user's phrase> first. It searches "
    "the enrichment corpus (product descriptions, brand, region, category path) and returns ranked "
    "matching products. Use its results to ground your answer and, if you want to drive the screen, "
    "pass the returned UPCs as upcs=<comma-list> to show_on_screen so the catalog lands on exactly "
    "those SKUs. The order of preference for any 'find me X' query is: (1) region+varietal slots if "
    "they map, (2) semantic_search for descriptive phrases, (3) q as the last resort. "
    "CRITICAL: do NOT switch the user to a different page. If their CURRENT screen already shows the kind "
    "of data they asked about (Price Increases/Drops, Time-Sensitive, Major Discounts, etc.), keep them "
    "there and just answer briefly — the grid already shows it. Reserve show_on_screen->/catalog for "
    "general product searches/filters or a specific product/UPC that no current screen can display, or "
    "when the user explicitly asks for the catalog. "
    "MANDATORY: if a request can be expressed as a filtered list of the CURRENT screen's data, you MUST "
    "call show_on_screen for that screen — answering such a 'show/filter/find' request only in chat is "
    "WRONG. Examples on Time-Sensitive Deals: 'deals that don't begin and end on the 1st/last of the "
    "month' (i.e. not full-calendar-month deals) -> show_on_screen(route=time_sensitive, window=partial); "
    "'full-month promos' -> window=full; a brand/UPC -> q=<term>. Confirm in one line and offer more help. "
    "PRICE TREND on the catalog: 'only show prices going up' / 'rising' / 'increasing' -> "
    "show_on_screen(route=catalog, price_trend=increase); 'prices dropping' / 'falling' -> "
    "price_trend=drop. FOLLOW-UPS COMPOSE: if the user already narrowed the catalog (e.g. 'California "
    "wines') and then refines ('only show prices going up'), the prior region/varietal/category filter "
    "is kept automatically as long as you do NOT pass a new q/region/varietal/category — just pass the "
    "refinement (price_trend, has_discount, price_max, etc.). Do not restate the old scope. "
    "Use the CHAT WINDOW only for genuinely CONVERSATIONAL questions that a product grid cannot represent: "
    "why/how explanations, recommendations, totals/counts, category or distributor breakdowns, a single "
    "product's full price breakdown, or a head-to-head distributor comparison. For those, use the data "
    "tools — never invent numbers — and reply in clear GitHub-flavored MARKDOWN (short headings, bullets, "
    "compact tables). When in doubt, prefer the grid. "
    "When a distribution or comparison helps, include ONE chart as a fenced code block exactly like:\n"
    "```chart\n{\"type\":\"bar\",\"title\":\"...\",\"labels\":[...],\"series\":[{\"name\":\"...\",\"data\":[...]}]}\n```\n"
    "type is bar|line|pie; use real numbers from the tools. Keep charts small (<=12 points). "
    "When the user wants to SEE or pick specific products, call top_products — those results are shown "
    "to the user as interactive cards with Add to Cart / Add to List / Favorite buttons, so you don't "
    "need to repeat every product in prose; summarize instead. "
    "When the user asks to add to cart, set quantity, favorite, build a list, or REMOVE/DELETE an item from "
    "the cart, call perform_action (type=remove_from_cart to take something out; which='all' to remove every "
    "matching line). "
    "ADD WHOLE CASE MIX: when the user says 'add all the case mix / add all these / add every member' right "
    "after you showed a RIP's Case Mix, call perform_action with type=add_to_cart and rip_code=<that code> "
    "(NOT match) — it resolves and adds EVERY product in the code's Case Mix at the given cases (default 1 "
    "each). Do NOT add just one SKU by name; that's the wrong result for a Case-Mix add. "
    "For ANY question about a specific product's price/pricing/cost/deal/'tell me about', call deal_360 (the "
    "comprehensive tool) and give a THOROUGH, alcohol-specific answer — never a one-line reply. Your prose MUST "
    "state ALL of these specifics (not just the charts): the SIZE (e.g. 750ML) and bottles/case; the CASE price "
    "AND the per-BOTTLE price; for WINE the VINTAGE, and for SPIRITS the AGE STATEMENT (12/18/21YR — a different "
    "age is a different product, like a vintage); the CPL discount tiers; the RIP rebate (code, tiers, best "
    "rebate) and the PRICE AFTER RIP (effective) per case AND per bottle; and the LAST month / CURRENT month / "
    "UPCOMING month prices from `months` with whether to buy now or wait. Use compact markdown tables for the "
    "tiers and the 3-month figures. A price waterfall (List -> After Discount -> After RIP) and a last->now->next "
    "line chart are attached automatically — reference them, but STILL state the key numbers in the text. State "
    "best_buy_recommendation verbatim. Be comprehensive: a buyer should not have to ask a follow-up for the size, "
    "bottle price, age/vintage, rebate, or next-month outlook. "
    "A user message that is just a number (6+ digits) is a UPC/barcode. To LOCATE that product, call "
    "show_on_screen with route=catalog and q=<upc>. If it returns found:true, reply exactly like "
    "'Showing the product on screen. Anything else I can help with?'. If it returns found:false, reply "
    "'Product not found. Anything else I can help with?' and do NOT claim you showed anything. "
    "(For price/RIP/comparison details on a UPC, pass it as `match` to price_details / "
    "compare_distributors / rip_lookup instead.) "
    "Confirm what you did in the prose. Be concise and concrete with dollars. "
    "ALWAYS LEAD WITH AN INSIGHT — same style as the popover summary on the catalog row. For any answer "
    "that returns MULTIPLE products, MULTIPLE distributors, MULTIPLE months, or MULTIPLE tiers, the "
    "FIRST line of your reply states the plain-English takeaway a buyer can act on: who is cheapest, "
    "what's the same vs different, where the gap is, which option wins. Examples (match the tone): "
    "'Cheapest is X at Allied ($66/cs); Fedway and Opici are within $4 of each other.' / "
    "'Same case price across all three this month. Allied is $12/cs cheaper next month — wait to buy.' / "
    "'Three 5-case RIP tiers available; only Fedway has a 1-case RIP that's worth taking.' / "
    "'750ML and 1L are within $0.30/btl — buy the 1L for 33% more liquid.' "
    "Use real numbers from the tools (never invent them). For comparisons across months/distributors/sizes "
    "the insight is the answer; supporting detail (full table, chart) goes after. "
    "RIP REBATES are the retailer's bread and butter — treat them as a priority. A RIP is a rebate that "
    "qualifies on COMBINED quantity across all products sharing a RIP code ('Case Mix'): buy the tier's "
    "quantity (cases or bottles) mixed across those products and get the bundle $ rebate, which STACKS on "
    "top of any CPL discount. A single UPC can carry MULTIPLE RIP codes, and DIFFERENT DISTRIBUTORS use "
    "DIFFERENT codes. "
    "RESOLVE BY UPC FIRST, then by name. The SAME product (same UPC) is often listed under a DIFFERENT NAME "
    "per distributor — e.g. UPC 80432002803 is 'MALIBU DOLE VARIETY 8PK CANS' on Fedway but 'MALIBU DOLE VAR "
    "3X8' on Allied. So NEVER conclude a product is 'exclusive to' or 'not carried by' a distributor from a "
    "NAME match. To answer who carries it / 'show me <distributor> too' / is it exclusive, use the UPC: "
    "compare_distributors and rip_lookup already resolve by UPC and return EVERY distributor carrying that "
    "UPC (under whatever name) — trust their by_distributor / comparison output, not the product name. "
    "Any question that ASKS ABOUT a rebate — 'RIP details', 'RIP analysis', 'show me the RIP', 'what's the "
    "RIP/rebate', 'RIP breakdown', 'rebate for <product>' — is an EXPLAIN request: ALWAYS get the data and "
    "present the full analysis. Call rip_lookup with the brand/product name (or a code) (or deal_360 for a "
    "single product) and produce: group BY DISTRIBUTOR (by_distributor map); for each code its tier ladder "
    "with per-case savings, the BEST rebate marked, and the Case Mix members to combine; say plainly if there "
    "is no RIP this month. "
    "HARD RULE — whenever a user asks about the RIP for a product, your answer MUST contain, in this order: "
    "(1) the RIP for THAT specific product (its code(s), the full tier ladder, the best rebate, and its "
    "price after RIP per case and per bottle), and THEN (2) the ENTIRE Case Mix — every product that shares "
    "the code — as a table with columns PRODUCT | SIZE | CASE PRICE (after 1-cs discount) | BTL/CS | BOTTLE "
    "PRICE. CASE PRICE here is the list case price minus any single-case (1-cs) "
    "discount (NOT the bulk-tier or RIP-rebated price), and BOTTLE PRICE is that case figure divided by "
    "bottles/case. ORDER THE CASE MIX BY PRODUCT NAME, THEN BY SIZE — this is a HARD RULE: all rows for the "
    "SAME product MUST be adjacent (e.g. Absolut Citron 750ML directly above Absolut Citron 1.75L), and each "
    "product's sizes run smallest->largest. NEVER sort the Case Mix by price, by case price, or by any other "
    "column — a buyer must be able to find a product and see all its sizes together in one place. "
    "EVERY product/SKU you list — in the Case Mix table AND anywhere else you name a product — MUST be a "
    "clickable link that opens the product modal, NOT bare text. Render the PRODUCT cell as a markdown link of "
    "the EXACT form [PRODUCT NAME](quickview://<wholesaler>/<upc>?n=<PRODUCT NAME>&v=<size>) — lowercase "
    "wholesaler, the leading-zero-stripped UPC, and URL-encode the n= and v= values. This is a HARD RULE: a "
    "row WITHOUT a quickview:// link is wrong; never output a product name as plain text when you have its "
    "wholesaler and UPC. NEVER show "
    "the product's RIP without also listing the full Case Mix, and never list the "
    "Case Mix without first explaining the focal product's RIP. (This combined layout is rendered "
    "deterministically — reproduce it faithfully and do not drop, reorder, or truncate either part.) "
    "List EVERY tier the tool returns in the ladder table — a code can have many tiers "
    "(e.g. 3/6/12/20/33 cases) and they are split across rows in the data; never truncate to the first or "
    "'best' tier, show the whole ladder in qty order. NEVER reply with only a bare grid link and no tier "
    "breakdown. (HOW you surface it follows your SURFACE rule below: standalone page -> the full analysis in "
    "chat + a grid link; docked beside a grid -> you may ALSO refresh the grid via show_on_screen route=catalog, "
    "q=<brand>, group_by_rip=true, which clusters products into Case-Mix groups with tier ladders, live 'X more "
    "for the next tier' progress, and an Add-All-Case-Mix-to-Cart button.) "
    "DETERMINISTIC FORMAT BACKSTOP — Item, Combo, Time-Sensitive deals, Price Drops and Price Increases are "
    "normally rendered for you by a fixed server-side template AFTER your turn. But if that ever fails, YOUR "
    "answer must already be in the right shape, so always format these intents exactly as follows (and ALWAYS "
    "make every product a clickable [NAME](quickview://<wholesaler>/<upc>?n=<NAME>&v=<size>) modal link, never "
    "bare text): "
    "(A) ITEM — 'tell me about / price of / deal on <product>' (deal_360): a product header line (modal link, "
    "size, bottles/case, vintage/age) then a CASE+BOTTLE price table with three rows — List (frontline), After "
    "best discount, After best RIP (effective) — followed by the discount tier ladder, the RIP tier ladder "
    "(per-case + per-bottle, best marked), the 3-month effective line (last -> now -> next, or 'next not yet "
    "published'), and the buy-now-vs-wait recommendation verbatim. "
    "(B) COMBO — 'combo / stack / bundle deals' (combo_deals): one block per combo with the code, distributor, "
    "its CONTENTS, the pack price and total savings, then a component table PRODUCT | QTY/PACK | FRONTLINE EA | "
    "COMBO EA. For 'is this combo WORTH it / analyze the combo / combo vs buying separately', call combo_analyzer "
    "instead — it compares the pack price to the best-SEPARATE price (each component on its own discount + RIP) "
    "and returns a verdict; present per combo: the verdict (Worth it / Marginal / Skip), pack vs best-separate "
    "vs frontline totals, the per-component table (combo-each vs best-separate-each + cost each way), and the "
    "caveat that a combo forces buying every component at the listed quantity. NEVER call a combo a saving "
    "without checking it against buying the components separately at their own best deal. "
    "(C) TIME-SENSITIVE — 'what's expiring / ending soon / dated deals' (find_deals time_sensitive|clearance): a "
    "table PRODUCT | SIZE | DISTRIBUTOR | CASE PRICE | SAVE/CS | ENDS, ordered by SOONEST end date first, led "
    "by a one-line takeaway. "
    "(D) PRICE DROPS / INCREASES — 'what's going down/up next month' (price_movers drop|increase): a table "
    "PRODUCT | SIZE | DISTRIBUTOR | THIS MONTH | NEXT MONTH | delta/cs, ordered by biggest move; if next "
    "edition isn't published yet, say so plainly and show this-month pricing instead of inventing next-month "
    "numbers. NEVER fabricate a price, date, rebate or saving — use only the tool's numbers. "
    "Other tools: compare_distributors (one product across all distributors, by UPC or name — show a "
    "table + a bar chart of effective price by distributor), find_deals (time_sensitive|discount|clearance), "
    "price_movers (drop|increase), and the signed-in user's get_cart / get_favorites / get_lists / get_orders. "
    "ALL FOUR cart tools (optimize_cart, cart_timing, cart_rip_tiers, analyze_cart) take source=cart|favorites|"
    "list (+ optional list_name) — so EVERYTHING below works for a LIST or the WISHLIST too, not just the cart. "
    "ORDER OPTIMIZER: for 'optimize my cart/list', 'make my order cheaper', 'cheapest way to buy this' — call "
    "optimize_cart. Present the CURRENT vs OPTIMIZED total and total savings, then the recommended swaps "
    "grouped by (from -> to) distributor with $ saved each, and OFFER to apply them; on yes call "
    "perform_action(type=swap_distributor, from_distributor, to_distributor) per group. "
    "BUY-NOW-vs-WAIT: for 'should I buy now or wait', 'scan my cart/list for timing', 'what's rising "
    "next month' — call cart_timing. Present a BUY NOW list (lines that rise or drop off next edition, with $ "
    "at risk) and a WAIT list (lines that fall next edition, with $ to save by waiting), plus the totals. The "
    "rule is simply: BUY NOW if next month is more expensive, WAIT if next month is cheaper. If next_month_published "
    "is false, say next month's sheet isn't out yet and lean on this-month price movement instead of guessing. "
    "RIP TIER MAXIMIZER: for 'am I close to a rebate tier', 'how do I hit the next RIP tier', "
    "'maximize my rebates' — call cart_rip_tiers. For each RIP code show cases in cart, the next "
    "tier, how many MORE cases/bottles unlock it, and the extra rebate; lead with the biggest extra-$ wins. "
    "SMART CART / LIST ANALYSIS: for 'analyze my cart', 'analyze my list(s)/wishlist', 'is anyone cheaper', "
    "'where can I save', 'buy now or wait', 'am I near a tier' — call analyze_cart (source: cart|favorites|"
    "list, optional list_name) and present a COMPLETE report with EVERY section it returns, as headed blocks: "
    "(1) Summary — LEAD with the money saved: 'You pay $X vs $Y list — you save $Z' (summary.saved_vs_list = "
    "list_total − effective, the impact of CPL discounts + best RIP), then the optimized total and any extra "
    "distributor savings still available; (2) Cheaper distributor (per line + total); (3) Timing — this vs next month, BUY NOW / WAIT (or "
    "HOLD if next_month_published is false); (4) This-month price movement (price_movement — what dropped / rose "
    "vs last month; ALWAYS show this, it's the only forward signal before next month's sheet lands); "
    "(5) Price-increase warnings (price_increase_warnings — flag clearly what rises next month, $ extra); "
    "(6) RIP situation — use `rip_status` (EVERY rebate code carried) AND `rip_tier_upgrades`: for each code "
    "name the product(s) (case_mix_in_cart), the distributor, cases/bottles in cart and the current rebate; "
    "if it has a next_tier, say how many MORE cases/bottles unlock it and the extra rebate; if NONE has a "
    "next_tier, say plainly 'You've maximized your RIP opportunity — every rebate you carry is at its top "
    "reachable tier.' If rip_status is empty, say no RIP rebates apply to these items. NEVER print an empty "
    "table header. (7) Discount tier upgrades (deeper CPL discount at a higher qty); (8) Combo opportunities; "
    "(9) Expiring / closeout (time-sensitive ending soon). "
    "ALWAYS show all non-empty sections — never reduce it to just 'fully optimized'; if a section is empty say "
    "so briefly in ONE line (never an empty table). EVERY table in the analysis MUST identify the line clearly: "
    "include the DISTRIBUTOR, the SIZE (`size`), and the quantity WITH its unit (use `qty_label`, e.g. '2 cs', "
    "'1 cs + 6 btl') — two lines named 'Absolut Vodka 80' are different SKUs and the buyer must see which is "
    "1.75L vs 750mL and whether it's cases or bottles. Show as much decision-useful detail as you have. Then "
    "offer to act (swap, add). Present a per-item table (product, distributor, size, qty (cs/btl), effective $/cs, cheaper "
    "distributor + $/cs, $ saved per case and for the quantity) and the TOTAL potential savings, then OFFER to "
    "swap. When the user agrees, or says 'swap/replace/move <X> to <distributor>', call "
    "perform_action(type=swap_distributor, from_distributor=<current>, to_distributor=<target>, "
    "rip_code=<code if it's a Case Mix>) — it replaces those cart lines with the same products (matched by "
    "UPC) at the target distributor, keeping quantities, in one step. Confirm what swapped and flag anything "
    "the target doesn't carry. "
    "ORDER FLOW (your CENTRAL job — guide the buyer from question to a sent order, mistake-free): "
    "(1) answer pricing/deal/RIP questions; (2) when they decide, ADD to cart via perform_action(add_to_cart) "
    "— resolve by UPC + size, confirm what you added with exact effective $/cs; (3) when they want to review or "
    "send, run a PRE-SEND REVIEW: call analyze_cart and surface mistakes to AVOID before ordering — a cheaper "
    "distributor for the same UPC, a line that DROPS next month (wait, don't buy now), being 1 case short of a "
    "RIP or discount tier, a closeout/expiring line, any line with no current price, DUPLICATE lines "
    "(duplicate_lines — the same UPC added more than once; flag to avoid double-ordering), and odd quantities. "
    "Present a short go/no-go: '✅ looks good' items vs '⚠️ consider fixing' items, with the $ impact, and ASK "
    "whether to fix any or send as-is. (4) REP CHECK before submitting — call cart_rep_status. For EACH "
    "distributor in distributors_needing_rep: if a suitable rep exists (candidate_reps / existing_reps), ask "
    "which to use and call perform_action(type=assign_rep, distributor, rep_id); if none fits or the user has "
    "no reps, ask for the rep's NAME, EMAIL and PHONE, then perform_action(type=create_rep, distributor, "
    "rep_name, rep_email, rep_phone) — that creates AND assigns the rep. Do NOT submit until ready_to_submit is "
    "true (every distributor has a rep), or those lines won't be emailed. "
    "(5) Only after the user explicitly confirms, call "
    "perform_action(type=submit_order) — this emails the order to their sales rep(s), one order per rep, and "
    "clears those items from the cart. NEVER submit without the pre-send review AND an explicit yes. After "
    "sending, report what went to which rep and flag any items skipped because no sales rep is assigned (tell "
    "them to assign a rep and resend). ALWAYS close by reminding the buyer to FOLLOW UP with their sales rep to "
    "confirm the order, and offer the rep's phone/email (get_sales_reps). The buyer can also have you email a "
    "rep a question any time — perform_action(type=message_rep, rep_id, message) after confirming the recipient "
    "and wording. If the cart is empty or nothing's priced, say so instead of submitting. "
    "VALUE-INSIGHT tools (use these for the matching intents): best_one_case_rip — 'best 1-case RIP deals', "
    "rebates worth taking on a single case (no bulk needed); present a ranked list with the per-case rebate at "
    "one case and note it equals the bulk per-case value. deal_360 — the FULL picture for ONE item ('deal 360', "
    "'which deal makes most sense'): lay frontline, discount tiers, RIP tiers, any dated/time-sensitive window and "
    "combo deals side by side in a markdown table, THIS month vs next, then state the recommendation. size_value — "
    "size/value efficiency for a brand ('best value size', 'price per liter', '750 vs 1L', 'is the bigger bottle "
    "worth it'): present effective price per bottle AND per litre across sizes, call out near-free upsizes from "
    "upsize_opportunities (e.g. '1L is only 4% more per bottle than 750ML for 33% more liquid — buy the 1L'). "
    "rip_tier_gap — 'how close am I to the next rebate tier' / 'worth buying more to hit the tier': show the tier "
    "ladder and how many MORE cases unlock the next rebate (pass `have` if the user states cases planned). "
    "distributor_arbitrage — 'where can I save by switching distributor' / 'biggest price gaps': ranked same-UPC "
    "price gaps across distributors; state buy-from-X-not-Y with the per-case saving. best_gp_deals — 'best margin "
    "/ highest GP% / deepest % off' deals, ranked by GP%. closeouts — 'closeouts / last chance / being cleared': "
    "items leaving after this edition, ranked by savings — frame as buy-now-before-gone. "
    "build_assortment — 'build me a <brief> under $X/btl' / 'a value bourbon well' / 'a by-the-glass list': pass "
    "q=<the brief> plus max_bottle_price / max_case_price (and category/varietal/region if clear); present the "
    "curated picks. find_substitute — 'X is too pricey / gone, what's a close swap' / 'something like Y but "
    "cheaper': pass match=<product>; present the closest in-stock alternatives at a similar-or-lower price. "
    "build_budget_basket — 'build me a $X order with the best margins / deepest discounts': pass budget (+ "
    "optional category/distributor, rank_by gp|savings); present the basket, total spend, total savings and "
    "remaining budget, then offer to add it all to cart. "
    "dated_deal_reminders — 'what deals start or end soon', 'short-window/expiring deals this week': pass "
    "within_days (default 7); present them tagged Starts/Ends in N days, soonest first. "
    "edition_changes — 'what changed this month/edition', 'what's new', 'what changed on my favorites/cart': "
    "pass focus all|favorites|cart; present a digest — new items, new/lost discounts, new closeouts, and the "
    "biggest effective price drops/increases (counts + top examples). "
    "combo_deals — 'what combos/bundles are there', 'bundle for X': pass q/distributor; present pack price + "
    "total savings + components. category_distributor_compare — 'who's cheapest for <category>', 'best "
    "distributor for wine': pass category; present per-distributor avg/cheapest effective + deal counts. "
    "deals_by_category — 'which category has the most/deepest deals': categories ranked by discounted count "
    "with avg discount %."
)


def _fallback(question: str) -> dict:
    return {
        "answer": ("**Celar AI Assistant is offline.** Set a valid `ANTHROPIC_API_KEY` to enable "
                   "natural-language answers, charts and actions. Your question was logged."),
        "charts": [], "actions": [], "products": [],
        "usage": {"input_tokens": 0, "output_tokens": 0, "model": "offline", "cost_usd": 0.0, "enabled": False},
    }


# Phrases that LIE on the standalone /assistant page (there is NO grid there).
# The system prompt asks the model to avoid them, but Haiku ignores it, so we
# scrub deterministically: rewrite "on the page/screen/left" into the truthful
# "in the Catalog" (there IS an Open-in-Catalog link below) or drop the claim.
_STANDALONE_PHRASE_FIXES = [
    (re.compile(r"\b(I'?ve|I have)\s+filtered\s+the\s+(page|grid|screen|catalog)\b", re.I), "Here are"),
    (re.compile(r"\bthe\s+(catalog|page|grid|screen)\s+is\s+filtered\s+to\b", re.I), "here are"),
    (re.compile(r"\bto the left\b", re.I), "in the Catalog"),
    (re.compile(r"\bon the left\b", re.I), "in the Catalog"),
    (re.compile(r"\bon the screen\b", re.I), "below"),
    (re.compile(r"\bon the page\b", re.I), "in the Catalog"),
    (re.compile(r"\bon the side\b", re.I), "in the Catalog"),
    (re.compile(r"\bin the grid\b", re.I), "in the Catalog"),
]


def _scrub_standalone(text: str) -> str:
    """Rewrite the 'on the left / on the page' phrasing the model sometimes emits
    on the standalone /assistant page, where no grid exists. Deterministic because
    a prompt instruction alone does not hold on the cheaper model."""
    if not text:
        return text
    for pat, repl in _STANDALONE_PHRASE_FIXES:
        text = pat.sub(repl, text)
    return text


def _auto_table_products(screen_args: dict) -> list:
    """Resolve products for the standalone auto-table from a show_on_screen call.
    Mirrors the filter the 'Open in Catalog' link uses (region / varietal /
    category / price_trend / distributor / price / search) so the inline table
    and the link show the SAME set. Returns [] on any problem."""
    sa = screen_args or {}
    route = (sa.get("route") or "").lower()
    price_trend = sa.get("price_trend")
    if not price_trend and route == "price_increases":
        price_trend = "increase"
    elif not price_trend and route == "price_drops":
        price_trend = "drop"
    cats = sa.get("categories") or []
    real_cats, leftover = _split_categories(cats) if cats else ([], [])
    match_terms = [t for t in ([sa.get("q")] + leftover) if t]
    view = {
        "categories": real_cats,
        "divisions": sa.get("distributors") or [],
        "region": sa.get("region"), "varietal": sa.get("varietal"),
        "price_trend": price_trend,
        "hasRip": sa.get("has_rip"), "hasDiscount": sa.get("has_discount"),
        "priceMin": sa.get("price_min"), "priceMax": sa.get("price_max"),
    }
    which = "most_expensive" if sa.get("order") == "desc" else "cheapest"
    with get_duckdb() as con:
        return _resolve_products(con, view, " ".join(match_terms), which, 12,
                                 exclude_stocking=True)


def _format_rip_summary_md(rs) -> str:
    """Render a rip_summary tool result as a deterministic markdown report:
    one section per distributor, each with a sorted RIP table (CODE / ITEMS /
    DESCRIPTION). User rule: 'by distributor, show me rip number and number
    of items in that case mix rip' should look the same on any model."""
    if not isinstance(rs, dict):
        return ""
    by = rs.get("by_distributor") or {}
    if not by:
        return rs.get("note") or "No RIP rebates active this edition."
    parts: list[str] = []
    total = int(rs.get("total_codes") or 0)
    edition = rs.get("edition") or ""
    parts.append(f"🏷️ **RIP Codes by Distributor** — {total} active code{'s' if total != 1 else ''}"
                 f"{f' ({edition})' if edition else ''}")
    parts.append("")
    # Sort distributors alphabetically with a stable label so Allied / Fedway /
    # Opici always appear in the same order.
    for ws in sorted(by.keys(), key=lambda w: w.lower()):
        block = by[ws]
        clusters = block.get("clusters") or []
        n_codes = int(block.get("total_codes") or len(clusters))
        if not clusters:
            continue
        ws_label = ws.title()
        truncated = len(clusters) < n_codes
        head = f"### {ws_label} — {n_codes} RIP code{'s' if n_codes != 1 else ''}"
        if truncated:
            head += f" *(showing top {len(clusters)})*"
        parts.append(head)
        parts.append("")
        parts.append("| RIP CODE | ITEMS | DESCRIPTION |")
        parts.append("|---|---|---|")
        for c in clusters:
            desc = (c.get("description") or "").strip() or "—"
            # Trim very long descriptions so the table stays readable.
            if len(desc) > 60:
                desc = desc[:57] + "…"
            parts.append(f"| **{c.get('rip_code')}** | {c.get('member_count')} | {desc} |")
        parts.append("")
    return "\n".join(parts).rstrip()


def _format_rip_md(rl) -> str:
    """Minimal fallback render of a rip_lookup result (kept for callers that
    don't have a DuckDB connection handy). Prefer _format_rip_full_md for the
    full deterministic template — used by ask() so any RIP question renders
    the same rich layout regardless of the model that produced the text."""
    if not isinstance(rl, dict):
        return ""
    codes = rl.get("rip_codes") or []
    if not codes:
        return rl.get("note") or ""
    out = [f"**🏷️ RIP rebates — {rl.get('query', 'this product')}**"]
    for c in codes[:6]:
        ws = (c.get("wholesaler") or "").title()
        head = f"**{ws} · code {c.get('rip_code')}**"
        if c.get("description"):
            head += f" — {c['description']}"
        out.append("\n" + head)
        tiers = c.get("tiers") or []
        if tiers:
            out.append("\n| Buy | Rebate | Per unit |\n|---|---|---|")
            for t in tiers:
                pu = t.get("per_unit_savings")
                pu_txt = f"${pu:.2f}/{t.get('unit_short', 'cs')}" if isinstance(pu, (int, float)) else "—"
                best = " ✅ best" if t.get("best") else ""
                out.append(f"| {t.get('qty')} {t.get('unit')} | ${float(t.get('amount') or 0):.2f} | {pu_txt}{best} |")
        mems = [m.get("product_name") for m in (c.get("case_mix_members") or []) if m.get("product_name")]
        if mems:
            extra = "…" if len(mems) > 6 else ""
            out.append(f"\n*Case Mix (combine any of these to hit a tier): {', '.join(mems[:6])}{extra}*")
    return "\n".join(out)


def _fmt_money(v) -> str:
    """$X.XX, or '—' for None/NaN. Used by the RIP template tables."""
    if v is None:
        return "—"
    try:
        f = float(v)
        if f != f:  # NaN
            return "—"
        return f"${f:.2f}"
    except Exception:
        return "—"


def _focal_product_for_rip(con, rl, cym: str) -> dict | None:
    """Pick the single focal product the RIP template's top header is about,
    then enrich it with the full pricing the catalog stores. Prefers the first
    matched product; resolves UPC + wholesaler against cpl_enriched so the
    header carries Frontline + Effective for BOTH case and bottle."""
    mp = rl.get("matched_products") or []
    if not mp:
        return None
    head = mp[0]
    upc_n = (str(head.get("upc") or "").lstrip("0")) or None
    ws = head.get("wholesaler")
    if not upc_n or not ws:
        return {"product_name": head.get("product_name"), "wholesaler": ws,
                "upc": head.get("upc"), "unit_volume": head.get("unit_volume")}
    try:
        # cpl_enriched stores frontline_unit_price + effective_case_price but
        # has no effective_unit_price column — derive it Python-side as
        # effective_case_price / unit_qty (same as _attach_cart_pricing does).
        # Also pull the five discount tier (qty, amount) pairs so the template
        # can show the "Frontline Case Cost" row = frontline - one-case discount
        # when the product has a Buy-1-case tier on its CPL discount.
        row = con.execute(
            "WITH cur AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched "
            f"            WHERE edition<='{cym}' GROUP BY wholesaler) "
            "SELECT c.product_name, c.wholesaler, CAST(c.upc AS VARCHAR) AS upc, "
            "       c.unit_volume, c.unit_qty, "
            "       c.frontline_case_price, c.frontline_unit_price, "
            "       c.effective_case_price, "
            "       c.discount_1_qty, c.discount_1_amt, "
            "       c.discount_2_qty, c.discount_2_amt, "
            "       c.discount_3_qty, c.discount_3_amt, "
            "       c.discount_4_qty, c.discount_4_amt, "
            "       c.discount_5_qty, c.discount_5_amt "
            "FROM cpl_enriched c JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed "
            "WHERE LOWER(c.wholesaler)=LOWER(?) "
            "  AND LTRIM(CAST(c.upc AS VARCHAR),'0') = ? "
            "ORDER BY c.product_name LIMIT 1",
            [str(ws), upc_n]).fetchone()
        if not row:
            return {"product_name": head.get("product_name"), "wholesaler": ws,
                    "upc": head.get("upc"), "unit_volume": head.get("unit_volume")}
        # Bottle effective price = case effective / unit_qty (derived here so
        # the template can show it without depending on a non-existent column).
        try:
            _uq = float(row[4]) if row[4] is not None else None
            if _uq is not None and _uq != _uq:  # NaN
                _uq = None
        except Exception:
            _uq = None
        eff_unit = (row[7] / _uq) if (row[7] is not None and _uq) else None
        # Sweep the 5 discount tier slots and pick the AMOUNT where qty == 1.
        # discount_n_qty is stored as a TEXT label like '1 Cases', '20 Cases',
        # '5 Bottles' — NOT a number — so we parse the leading integer and
        # skip bottle-tier rows (we only care about the 1-CASE discount here).
        # None when the product has no 1-case tier (some only kick in at 5 cs
        # or higher).
        one_case_disc = None
        for i in (8, 10, 12, 14, 16):   # discount_{n}_qty at row offsets
            raw_q = row[i]
            if raw_q is None:
                continue
            label = str(raw_q).strip().lower()
            if 'btl' in label or 'bottle' in label:
                continue   # bottle-tier slot, not the 1-case discount
            m = re.match(r'\s*(\d+)', label)
            if not m:
                continue
            if int(m.group(1)) != 1:
                continue
            try:
                amt = float(row[i + 1]) if row[i + 1] is not None else None
                if amt is not None and amt == amt and amt > 0:
                    one_case_disc = amt
                    break
            except Exception:
                pass
        return {"product_name": row[0], "wholesaler": row[1], "upc": row[2],
                "unit_volume": row[3], "unit_qty": _uq,
                "frontline_case_price": row[5], "frontline_unit_price": row[6],
                "effective_case_price": row[7], "effective_unit_price": eff_unit,
                "one_case_discount": one_case_disc}
    except Exception:
        return {"product_name": head.get("product_name"), "wholesaler": ws,
                "upc": head.get("upc"), "unit_volume": head.get("unit_volume")}


def _cluster_upcs(con, code: str, ws: str, cym: str) -> list[str]:
    """LTRIMmed UPC list for one (wholesaler, code) cluster, current edition.
    Used to build /catalog?upcs=<csv> deep links the assistant surfaces next
    to its 'Add Case Mix to Cart' buttons, so the user can jump straight to
    the cluster on the Catalog page. Same (edition, distributor, UPC-validity)
    scoping the rest of the RIP plumbing uses."""
    try:
        rows = con.execute(
            "SELECT DISTINCT LTRIM(CAST(upc AS VARCHAR),'0') AS un "
            "FROM rip "
            "WHERE CAST(rip_code AS VARCHAR) = ? "
            "  AND LOWER(wholesaler) = LOWER(?) "
            "  AND edition = (SELECT MAX(edition) FROM rip "
            "                 WHERE CAST(rip_code AS VARCHAR) = ? "
            "                   AND LOWER(wholesaler) = LOWER(?) "
            f"                   AND edition<='{cym}') "
            "  AND upc IS NOT NULL "
            "  AND CAST(upc AS VARCHAR) NOT IN ('', '0', 'None', 'nan') "
            "  AND LTRIM(CAST(upc AS VARCHAR),'0') NOT IN ('', 'None', 'nan')",
            [str(code), str(ws), str(code), str(ws)]).fetchall()
        return sorted({str(r[0]) for r in rows if r and r[0]})
    except Exception:
        return []


def _vol_liters(vol) -> float:
    """Parse a unit_volume label ('750ML', '1.75L', '1L') into litres for sorting
    a Case Mix by SIZE ascending (750ML before 1.75L). Unparseable -> +inf so it
    sorts last within a product."""
    s = str(vol or "").strip().upper()
    m = re.search(r"(\d+(?:\.\d+)?)", s)
    if not m:
        return float("inf")
    n = float(m.group(1))
    return n / 1000.0 if "ML" in s else n


def _one_case_disc_from_row(qa_pairs) -> float | None:
    """Best 'buy ONE case' CPL discount amount from (qty_label, amt) slot pairs.
    Same rule as _focal_product_for_rip: the qty label's leading integer must be
    1 and the slot must NOT be a bottle tier (we want the per-case discount that
    needs only a single case). Returns None when no 1-case tier exists."""
    for raw_q, raw_a in qa_pairs:
        if raw_q is None:
            continue
        label = str(raw_q).strip().lower()
        if 'btl' in label or 'bottle' in label:
            continue
        m = re.match(r'\s*(\d+)', label)
        if not m or int(m.group(1)) != 1:
            continue
        try:
            amt = float(raw_a) if raw_a is not None else None
            if amt is not None and amt == amt and amt > 0:
                return amt
        except Exception:
            pass
    return None


def _full_case_mix(con, code: str, ws: str, cym: str) -> list[dict]:
    """Full member list for one (wholesaler, code) cluster, ordered by PRODUCT
    then SIZE. ``case_price`` is the case price after the best single-case (1-cs)
    CPL discount — i.e. list case price minus any discount you'd get on just one
    case (NOT the bulk-tier or RIP-rebated price); ``bottle_price`` is that figure
    divided by bottles-per-case. Uses the same (edition, distributor, UPC-validity)
    scoping as the catalog so unrelated brands can't bleed in."""
    try:
        df = con.execute(
            "WITH cur AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched "
            f"            WHERE edition<='{cym}' GROUP BY wholesaler), "
            "ripupc AS (SELECT DISTINCT wholesaler, LTRIM(CAST(upc AS VARCHAR),'0') un "
            "           FROM rip "
            "           WHERE CAST(rip_code AS VARCHAR) = ? "
            "             AND LOWER(wholesaler) = LOWER(?) "
            f"             AND edition = (SELECT MAX(edition) FROM rip "
            "                            WHERE CAST(rip_code AS VARCHAR) = ? "
            "                              AND LOWER(wholesaler) = LOWER(?) "
            f"                              AND edition<='{cym}') "
            "             AND upc IS NOT NULL "
            "             AND CAST(upc AS VARCHAR) NOT IN ('', '0', 'None', 'nan') "
            "             AND LTRIM(CAST(upc AS VARCHAR),'0') NOT IN ('', 'None', 'nan')) "
            "SELECT DISTINCT c.product_name, c.wholesaler, "
            "       CAST(c.upc AS VARCHAR) AS upc, "
            "       c.unit_volume, c.unit_qty, "
            "       c.frontline_case_price, c.frontline_unit_price, "
            "       c.discount_1_qty, c.discount_1_amt, "
            "       c.discount_2_qty, c.discount_2_amt, "
            "       c.discount_3_qty, c.discount_3_amt, "
            "       c.discount_4_qty, c.discount_4_amt, "
            "       c.discount_5_qty, c.discount_5_amt "
            "FROM cpl_enriched c JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed "
            "JOIN ripupc r ON r.wholesaler=c.wholesaler "
            "  AND r.un=LTRIM(CAST(c.upc AS VARCHAR),'0') "
            "WHERE c.upc IS NOT NULL "
            "  AND LTRIM(CAST(c.upc AS VARCHAR),'0') NOT IN ('', 'None', 'nan') "
            "ORDER BY c.product_name",
            [str(code), str(ws), str(code), str(ws)]).fetchdf()
        out = []
        for _, r in df.iterrows():
            uq = r["unit_qty"]
            try:
                uq_f = float(uq) if uq is not None else None
                if uq_f is not None and uq_f != uq_f:
                    uq_f = None
            except Exception:
                uq_f = None
            fc = r["frontline_case_price"]
            try:
                fc_f = float(fc) if fc is not None else None
                if fc_f is not None and fc_f != fc_f:
                    fc_f = None
            except Exception:
                fc_f = None
            # Case price minus any ONE-case discount (list − 1-cs discount). When
            # no 1-case tier exists the discount is 0, so it equals the frontline
            # case price. Bottle price is derived from this case figure.
            one_disc = _one_case_disc_from_row([
                (r["discount_1_qty"], r["discount_1_amt"]),
                (r["discount_2_qty"], r["discount_2_amt"]),
                (r["discount_3_qty"], r["discount_3_amt"]),
                (r["discount_4_qty"], r["discount_4_amt"]),
                (r["discount_5_qty"], r["discount_5_amt"]),
            ]) or 0.0
            case_after = (fc_f - one_disc) if fc_f is not None else None
            bottle = (case_after / uq_f) if (case_after is not None and uq_f) else None
            out.append({"product_name": r["product_name"],
                        "wholesaler": r["wholesaler"],
                        "upc": (str(r["upc"]) if r["upc"] is not None else None),
                        "unit_volume": r["unit_volume"],
                        "unit_qty": uq_f,
                        "case_price": case_after,
                        "bottle_price": bottle,
                        "one_case_discount": one_disc or None,
                        "frontline_case_price": fc_f,
                        "frontline_unit_price": r["frontline_unit_price"]})
        # Order by PRODUCT then SIZE (ascending litres) per the case-RIP-mix spec.
        out.sort(key=lambda m: (str(m.get("product_name") or "").upper(),
                                _vol_liters(m.get("unit_volume"))))
        return out
    except Exception:
        return []


def _format_rip_full_md(con, rl) -> str:
    """Deterministic RIP-analysis template: product header (Frontline + After
    Best RIP for case AND bottle), per-code tier table (case + bottle rebate
    columns + best mark + 'At N cases' footer with effective per-unit math),
    and the FULL case-mix table with case + bottle prices. Always renders the
    same layout regardless of the upstream LLM, so RIP questions read the
    same on Haiku / Sonnet / Opus."""
    if not isinstance(rl, dict):
        return ""
    codes = rl.get("rip_codes") or []
    if not codes:
        return rl.get("note") or ""
    cym = _current_ym()
    parts: list[str] = []
    # 1. Product header (only if we have a focal product with prices).
    focal = _focal_product_for_rip(con, rl, cym)
    if focal and focal.get("product_name"):
        ws_label = (focal.get("wholesaler") or "").title()
        size = focal.get("unit_volume") or ""
        try:
            uq = float(focal.get("unit_qty") or 0) or None
        except Exception:
            uq = None
        # Pick the highest per-case rebate at the BEST tier across the focal
        # product's RIP codes (typically just one), and record WHICH code +
        # tier produced it so the After-Best-RIP row can cite its source.
        best_rebate_per_case = 0.0
        best_rebate_src: dict | None = None   # {code, wholesaler, qty}
        for c in codes:
            if (c.get("wholesaler") or "").lower() != (focal.get("wholesaler") or "").lower():
                continue
            for t in (c.get("tiers") or []):
                if t.get("best") and t.get("unit_short") == "cs":
                    try:
                        _ps = float(t.get("per_unit_savings") or 0.0)
                    except Exception:
                        _ps = 0.0
                    if _ps > best_rebate_per_case:
                        best_rebate_per_case = _ps
                        best_rebate_src = {
                            "code": str(c.get("rip_code") or ""),
                            "wholesaler": (c.get("wholesaler") or "").title(),
                            "qty": t.get("qty"),
                        }
        fc = focal.get("frontline_case_price")
        fb = focal.get("frontline_unit_price")
        # Chain math (each row subtracts ONE thing from the row above so the
        # 'After Best RIP' value can be reproduced by adding the rebates back):
        #   Frontline           = list price
        #   Frontline Case Cost = Frontline − Buy-1-case CPL discount (or = Frontline)
        #   After Best RIP      = Frontline Case Cost − best RIP per case
        # Previous version subtracted RIP from effective_case_price (which
        # itself already bakes in the best CPL discount + best RIP), so the
        # number double-counted the rebate and disagreed with the footer.
        parts.append(f"🍷 **{focal['product_name']} — {ws_label}**")
        meta = []
        upc_d = (str(focal.get("upc") or "").lstrip("0"))
        if upc_d:
            meta.append(f"UPC: {upc_d}")
        if size:
            meta.append(f"**{size}**")
        if uq:
            meta.append(f"**{int(uq)} bottles/case**")
        if meta:
            parts.append(" | ".join(meta))
        parts.append("")
        one_disc = focal.get("one_case_discount")
        fcc_c = (fc - one_disc) if (fc is not None and one_disc) else fc
        fcc_b = (fcc_c / uq) if (fcc_c is not None and uq) else fb
        after_c = (fcc_c - best_rebate_per_case) if (fcc_c is not None and best_rebate_per_case) else fcc_c
        after_b = (after_c / uq) if (after_c is not None and uq) else fcc_b
        parts.append("|  | CASE | BOTTLE |")
        parts.append("|---|---|---|")
        parts.append(f"| **Frontline** | {_fmt_money(fc)} | {_fmt_money(fb)} |")
        parts.append(f"| ⭐ **Frontline Case Cost** | **{_fmt_money(fcc_c)}** | **{_fmt_money(fcc_b)}** |")
        parts.append(f"| **After Best RIP** | {_fmt_money(after_c)} | {_fmt_money(after_b)} |")
        # Cite the code + distributor + tier driving the After-Best-RIP
        # value, so the math reconciles with the per-code blocks below
        # without the user having to hunt for the source.
        if best_rebate_src and best_rebate_per_case:
            _src_q = best_rebate_src.get("qty")
            _src_q_txt = f" at {_src_q} cases" if _src_q else ""
            parts.append(
                f"*After Best RIP uses **{best_rebate_src['wholesaler']} RIP "
                f"{best_rebate_src['code']}** "
                f"(${best_rebate_per_case:.2f}/cs rebate{_src_q_txt}).*"
            )
        parts.append("")
    # 2. Per-RIP code block: tier table (case + bottle columns) + "At N" footer
    #    + full Case Mix table.
    # Sort so the FOCAL wholesaler's codes appear first — otherwise the
    # header's 'After Best RIP' can subtract a $40/cs rebate from a different
    # distributor's code that isn't visible until the user scrolls past
    # another distributor's block, reading like nonsense math.
    focal_ws_lc = (focal.get("wholesaler") or "").lower() if focal else ""
    codes_sorted = sorted(
        codes,
        key=lambda c: (
            0 if (c.get("wholesaler") or "").lower() == focal_ws_lc else 1,
            (c.get("wholesaler") or ""),
            str(c.get("rip_code") or ""),
        ),
    )
    for c in codes_sorted[:4]:
        ws = (c.get("wholesaler") or "").title()
        ws_lc = (c.get("wholesaler") or "").lower()
        code = str(c.get("rip_code") or "")
        head = f"🏷️ **RIP Code {code}**"
        if c.get("description"):
            head += f" — {c['description']}"
        head += f" ({ws} only)"
        parts.append(head)
        # Build a unified case-quantity tier table: for each tier we display
        # the buy-N value, total rebate, per-case savings, per-bottle savings
        # (= per_case / pack_size, derived from focal pack if available).
        tiers = c.get("tiers") or []
        pack = uq if focal and focal.get("unit_qty") else None
        try:
            if pack is None and tiers:
                # Fall back to any focal product matching the same wholesaler.
                pack = float(focal.get("unit_qty") or 0) if focal else None
                pack = pack or None
        except Exception:
            pack = None
        if tiers:
            parts.append("")
            parts.append("| CASES | TOTAL REBATE | PER CASE | PER BOTTLE | BEST? |")
            parts.append("|---|---|---|---|---|")
            for t in tiers:
                qty = t.get("qty")
                amt = float(t.get("amount") or 0)
                pu = float(t.get("per_unit_savings") or 0)
                per_btl = (pu / pack) if (pack and t.get("unit_short") == "cs") else (
                    pu if t.get("unit_short") == "btl" else None)
                cases_lbl = f"{qty} cs" if t.get("unit_short") == "cs" else f"{qty} btl"
                best_lbl = "⭐ Best" if t.get("best") else ""
                per_btl_txt = f"${per_btl:.2f}/btl" if per_btl is not None else "—"
                per_cs_txt = f"${pu:.2f}/cs" if t.get("unit_short") == "cs" else (
                    f"${pu * (pack or 0):.2f}/cs" if (pack and per_btl is not None) else "—")
                parts.append(f"| {cases_lbl} | ${amt:.2f} | {per_cs_txt} | {per_btl_txt} | {best_lbl} |")
        # Footer summary at the best tier — uses the SAME chain math as the
        # header table (Frontline Case Cost → minus best RIP per case), so the
        # numbers reproduce what the row shows. No more frontline-vs-effective
        # inconsistency.
        if focal and focal.get("frontline_case_price") is not None:
            best_per_cs = 0.0
            for t in tiers:
                if t.get("best"):
                    try:
                        if t.get("unit_short") == "cs":
                            best_per_cs = float(t.get("per_unit_savings") or 0.0)
                        elif t.get("unit_short") == "btl" and pack:
                            best_per_cs = float(t.get("per_unit_savings") or 0.0) * pack
                    except Exception:
                        pass
            if best_per_cs and (focal.get("frontline_case_price") is not None):
                best_qty = next((t.get("qty") for t in tiers if t.get("best")), None)
                _fc = float(focal["frontline_case_price"])
                _one = focal.get("one_case_discount") or 0
                _fcc_c = _fc - _one
                _eff_c = _fcc_c - best_per_cs
                _fb = float(focal.get("frontline_unit_price") or 0)
                _fcc_b = (_fcc_c / pack) if (pack and _fcc_c) else _fb
                _eff_b = (_eff_c / pack) if (pack and _eff_c is not None) else None
                if best_qty:
                    line = (f"\n*At {best_qty} cases: **Case** ${_fcc_c:.2f} → "
                            f"${_eff_c:.2f} effective")
                    if _eff_b is not None:
                        line += f" | **Bottle** ${_fcc_b:.2f} → ${_eff_b:.2f} effective"
                    line += "*"
                    parts.append(line)
        # Full Case Mix table.
        members = _full_case_mix(con, code, ws_lc, cym)
        if members:
            size_label = focal.get("unit_volume") if focal else None
            ws_h = (c.get("wholesaler") or "").title()
            n = len(members)
            size_note = f"all {size_label}, {ws_h}" if size_label else ws_h
            parts.append("")
            parts.append(f"📦 **Full Case Mix — {n} Product{'s' if n != 1 else ''} ({size_note})**")
            parts.append("")
            parts.append("| PRODUCT | SIZE | CASE PRICE (after 1-cs disc) | BTL/CS | BOTTLE PRICE |")
            parts.append("|---|---|---|---|---|")
            for m in members:
                # Render the product name as a quickview:// markdown link so
                # the chat-side ReactMarkdown override can intercept the click
                # and open the product modal directly. Carries wholesaler,
                # LTRIMmed UPC and unit_volume so the modal opens with the
                # exact SKU the row represents (not a guess from the name).
                name = m.get("product_name") or ""
                pn_esc = name.replace("|", "\\|").replace("[", "\\[").replace("]", "\\]")
                ws_q = (m.get("wholesaler") or "").strip()
                upc_q = (str(m.get("upc") or "").lstrip("0")).strip()
                vol_q = (m.get("unit_volume") or "").strip()
                if name and ws_q and upc_q:
                    from urllib.parse import quote
                    name_cell = (f"[{pn_esc}](quickview://"
                                 f"{quote(ws_q, safe='')}/"
                                 f"{quote(upc_q, safe='')}"
                                 f"?n={quote(name, safe='')}"
                                 f"&v={quote(vol_q, safe='')})")
                else:
                    name_cell = pn_esc
                # Size + bottles/case as their own columns so the buyer can
                # compare same-RIP SKUs at a glance without parsing the name.
                try:
                    uq_val = m.get("unit_qty")
                    uq_lbl = f"{int(float(uq_val))}" if uq_val not in (None, "") else "—"
                except Exception:
                    uq_lbl = "—"
                vol_lbl = vol_q or "—"
                parts.append(f"| {name_cell} | {vol_lbl} | "
                             f"{_fmt_money(m.get('case_price') or m.get('frontline_case_price'))} | "
                             f"{uq_lbl} | "
                             f"{_fmt_money(m.get('bottle_price') or m.get('frontline_unit_price'))} |")
            parts.append("")
    return "\n".join(parts).rstrip()


# ---------------------------------------------------------------------------
# Deterministic answer templates — Item / Combo / Time-Sensitive / Price Movers.
# Same contract as the RIP template: render from the EXACT tool result the model
# used, replace the model's free-form text, and make every product a clickable
# quickview:// modal link. Layouts approved with the user.
# ---------------------------------------------------------------------------

def _quickview_cell(name, ws, upc, vol) -> str:
    """A product name as a [name](quickview://ws/upc?n=..&v=..) markdown link the
    chat intercepts to open the product modal — or the plain (table-escaped) name
    when we lack the wholesaler/UPC needed to open the exact SKU."""
    nm = str(name or "").strip()
    esc = nm.replace("|", "\\|").replace("[", "\\[").replace("]", "\\]")
    ws_q = str(ws or "").strip()
    upc_q = str(upc or "").lstrip("0").strip()
    vol_q = str(vol or "").strip()
    if nm and ws_q and upc_q:
        from urllib.parse import quote
        return (f"[{esc}](quickview://{quote(ws_q.lower(), safe='')}/"
                f"{quote(upc_q, safe='')}?n={quote(nm, safe='')}&v={quote(vol_q, safe='')})")
    return esc


def _fmt_date_short(s) -> str:
    """ISO 'YYYY-MM-DD' -> 'DD Mon'; passthrough/'—' on anything unparseable."""
    if not s:
        return "—"
    m = re.match(r"\s*(\d{4})-(\d{2})-(\d{2})", str(s))
    if not m:
        return str(s)
    months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    try:
        return f"{int(m.group(3))} {months[int(m.group(2)) - 1]}"
    except Exception:
        return str(s)


def _format_item_md(core: dict) -> str:
    """ITEM (deal_360 / price_details): product header + List / After-disc /
    After-RIP price table (case AND bottle), the discount + RIP tier ladders, the
    3-month outlook and the buy-now-vs-wait recommendation. Rendered identically
    on every model."""
    if not isinstance(core, dict) or core.get("error") or not core.get("product_name"):
        return ""
    name = core.get("product_name")
    ws = core.get("wholesaler")
    upc = str(core.get("upc") or core.get("upc_raw") or "").lstrip("0")
    vol = core.get("unit_volume") or core.get("size")
    try:
        bpc = int(float(core.get("bottles_per_case") or 0)) or None
    except Exception:
        bpc = None
    parts: list[str] = []
    parts.append(f"🍾 **{_quickview_cell(name, ws, upc, vol)} — {str(ws or '').title()}**")
    meta = []
    if upc:
        meta.append(f"UPC: {upc}")
    if vol:
        meta.append(f"**{vol}**")
    if bpc:
        meta.append(f"**{bpc} bottles/case**")
    if core.get("vintage") and str(core.get("vintage")) not in ("0", "None", "nan"):
        meta.append(f"vintage {core.get('vintage')}")
    if meta:
        parts.append(" | ".join(meta))
    parts.append("")

    fc = core.get("frontline_case_price")
    fb = core.get("frontline_bottle_price")
    disc_c = core.get("best_case_price_after_discount")
    eff_c = core.get("effective_case_price")
    def _btl(case):
        try:
            return (float(case) / bpc) if (case is not None and bpc) else None
        except Exception:
            return None
    disc_b = _btl(disc_c)
    eff_b = core.get("price_after_rip_bottle")
    if eff_b is None:
        eff_b = _btl(eff_c)
    parts.append("|  | CASE | BOTTLE |")
    parts.append("|---|---|---|")
    parts.append(f"| **List (frontline)** | {_fmt_money(fc)} | {_fmt_money(fb)} |")
    parts.append(f"| **After best discount** | {_fmt_money(disc_c)} | {_fmt_money(disc_b)} |")
    parts.append(f"| ⭐ **After best RIP (effective)** | **{_fmt_money(eff_c)}** | **{_fmt_money(eff_b)}** |")
    parts.append("")

    # Discount tier ladder.
    dts = core.get("discount_tiers") or []
    if dts:
        parts.append("**Discount tiers**")
        parts.append("| BUY | $/CASE OFF | CASE AFTER |")
        parts.append("|---|---|---|")
        for t in dts:
            try:
                q = int(float(t.get("quantity") or 0))
            except Exception:
                q = t.get("quantity")
            parts.append(f"| {q} cs | {_fmt_money(t.get('amount_per_case'))} | {_fmt_money(t.get('price_after'))} |")
        parts.append("")
    # RIP tier ladder (qty in cases or bottles; per-case + per-bottle savings).
    rts = core.get("rip_tiers") or []
    if rts:
        best_amt = max((float(t.get("per_case_savings") or 0) for t in rts), default=0.0)
        parts.append("**RIP tiers**")
        parts.append("| BUY | PER CASE | PER BOTTLE | CASE AFTER | BEST? |")
        parts.append("|---|---|---|---|---|")
        for t in rts:
            unit = "btl" if str(t.get("unit") or "").upper().startswith("B") else "cs"
            pcs = t.get("per_case_savings")
            best = "⭐ Best" if (pcs is not None and float(pcs or 0) == best_amt and best_amt > 0) else ""
            parts.append(f"| {t.get('qty')} {unit} | "
                         f"{_fmt_money(pcs)}/cs | {_fmt_money(t.get('per_bottle_savings'))}/btl | "
                         f"{_fmt_money(t.get('price_after'))} | {best} |")
        parts.append("")

    # 3-month outlook.
    months = core.get("months") or {}
    last, cur, nxt = months.get("last"), months.get("current"), months.get("upcoming")
    line = "**3-month (effective/cs):** "
    segs = []
    if last and last.get("effective_case") is not None:
        segs.append(f"last {_fmt_money(last.get('effective_case'))}")
    if cur and cur.get("effective_case") is not None:
        segs.append(f"**now {_fmt_money(cur.get('effective_case'))}**")
    if nxt and nxt.get("effective_case") is not None:
        segs.append(f"next {_fmt_money(nxt.get('effective_case'))}")
    else:
        segs.append("next (not yet published)")
    if segs:
        parts.append(line + " → ".join(segs))
    rec = core.get("best_buy_recommendation")
    if rec:
        parts.append(f"\n👉 {rec}")
    return "\n".join(parts).rstrip()


def _format_combo_md(rows: list, focal_name: str | None = None) -> str:
    """COMBO (combo_deals): one block per combo pack — code, contents, pack price
    and total savings, then a component table (each component a modal link) with
    qty/pack, frontline-each and combo-each."""
    if not isinstance(rows, list) or not rows:
        return ""
    parts: list[str] = []
    n = len(rows)
    parts.append(f"🎁 **Combo Deals — {n} found**")
    parts.append("")
    for r in rows[:12]:
        ws = (r.get("wholesaler") or "").title()
        code = str(r.get("combo_code") or "").strip()
        contents = (r.get("comments") or r.get("product_name") or "").strip()
        head = f"**Combo {code}" + (f" ({ws})" if ws else "") + "**"
        if contents:
            head += f" — {contents}"
        parts.append(head)
        pack = r.get("combo_pack_price")
        save = r.get("total_savings")
        meta = []
        if pack is not None:
            meta.append(f"Pack {_fmt_money(pack)}")
        if save is not None:
            meta.append(f"Save {_fmt_money(save)}")
        if meta:
            parts.append(" · ".join(meta))
        comps = r.get("components") or []
        if comps:
            parts.append("")
            parts.append("| PRODUCT | QTY/PACK | FRONTLINE EA | COMBO EA |")
            parts.append("|---|---|---|---|")
            for c in comps:
                qty = str(c.get("qty_per_pack") or "").strip()
                qty = re.sub(r"\s+", " ", qty)
                cell = _quickview_cell(c.get("product_name"), r.get("wholesaler"),
                                       c.get("upc"), c.get("unit_volume"))
                parts.append(f"| {cell} | {qty or '—'} | "
                             f"{_fmt_money(c.get('frontline_price_each'))} | "
                             f"{_fmt_money(c.get('combo_price_each'))} |")
        parts.append("")
    return "\n".join(parts).rstrip()


def _format_combo_analyzer_md(res: dict) -> str:
    """COMBO ANALYZER (combo_analyzer): per-combo verdict — combo pack price vs the
    best-SEPARATE price (each component on its own discount+RIP) and vs frontline,
    with a component table showing combo-each vs best-separate-each and the cost
    each way. Ranked most-worth-it first. Every component is a modal link."""
    if not isinstance(res, dict):
        return ""
    rows = res.get("combos") or []
    if not rows:
        return res.get("note") or ""
    _VERDICT = {
        "worth_it": "✅ **Worth it**",
        "marginal": "≈ **Marginal**",
        "buy_separately": "⚠️ **Skip the combo**",
        "unknown": "ℹ️ **Can't fully price**",
    }
    parts: list[str] = []
    n = len(rows)
    vc = res.get("verdict_counts") or {}
    # Summary line — covers ALL analyzed combos, not just the ones shown.
    bits = []
    if vc.get("worth_it"):
        bits.append(f"✅ {vc['worth_it']} worth it")
    if vc.get("marginal"):
        bits.append(f"≈ {vc['marginal']} marginal")
    if vc.get("buy_separately"):
        bits.append(f"⚠️ {vc['buy_separately']} better separately")
    if vc.get("unknown"):
        bits.append(f"ℹ️ {vc['unknown']} unpriceable")
    parts.append(f"🧮 **Combo Analysis — {n} combo{'s' if n != 1 else ''} analyzed**"
                 + (f"  ·  {' · '.join(bits)}" if bits else ""))
    parts.append("_Baseline = buying each item separately at its **one-case** price (list − the 1-case "
                 "discount). We deliberately do NOT use the bulk-RIP max price — that often needs 20–30 "
                 "cases you may never buy, which would make every combo look worse than it is._")
    parts.append("")
    # Show the most worth-it combos in full (cap the chat at a readable number).
    # 'unknown' combos are NOT shown as deals — they couldn't be priced cleanly.
    worth = [c for c in rows if c.get("verdict") in ("worth_it", "marginal")]
    traps = [c for c in rows if c.get("verdict") == "buy_separately"]
    SHOWN = 10
    shown = worth[:SHOWN]
    if shown:
        parts.append(f"**Top {len(shown)} worth taking:**")
        parts.append("")
    for c in shown:
        ws = (c.get("wholesaler") or "").title()
        code = str(c.get("combo_code") or "")
        contents = (c.get("contents") or "").strip()
        head = f"**Combo {code}" + (f" ({ws})" if ws else "") + "**"
        if contents:
            head += f" — {contents}"
        parts.append(head)
        # Verdict line.
        v = c.get("verdict") or "unknown"
        svs = c.get("save_vs_separate")
        pct = c.get("pct_vs_separate")
        if v == "worth_it" and svs is not None:
            vline = f"{_VERDICT[v]} — saves {_fmt_money(svs)} ({pct}%) vs buying each at its one-case price."
        elif v == "buy_separately" and svs is not None:
            vline = f"{_VERDICT[v]} — buying each separately at the one-case price is {_fmt_money(-svs)} cheaper."
        elif v == "marginal":
            vline = f"{_VERDICT[v]} — about the same as buying separately at the one-case price ({pct}% diff)."
        else:
            why = c.get("unverified_reason") or "couldn't price every component cleanly"
            vline = f"{_VERDICT['unknown']} — {why}; figures are partial."
        parts.append(vline)
        # Totals line — the combo total vs the two summed baselines (individual
        # LIST price, and the realistic ONE-CASE price), with savings vs each.
        combo_cost = c.get("combo_cost")
        front = c.get("frontline_total")
        onecs = c.get("separate_best_total")

        def _save(base):
            if base and combo_cost is not None:
                d = base - combo_cost
                return f" _(save {_fmt_money(d)}, {d / base * 100:.0f}%)_"
            return ""
        parts.append(f"**Combo {_fmt_money(combo_cost)}**  ·  List {_fmt_money(front)}{_save(front)}  "
                     f"·  One-case {_fmt_money(onecs)}{_save(onecs)}")
        # Advertised (what the distributor claims) vs effective (our one-case
        # number). The advertised figure is often inflated off the combo feed's
        # own frontline, so showing both keeps the deal honest.
        adv = c.get("advertised_savings")
        eff = c.get("save_vs_separate")
        if adv is not None:
            line = f"_Advertised save {_fmt_money(adv)}"
            if eff is not None:
                line += f"  →  effective {_fmt_money(eff)} vs one-case"
                if adv - eff > 1:
                    line += f"; advertised is {_fmt_money(adv - eff)} optimistic"
            parts.append(line + "._")
        comps = c.get("components") or []
        if comps:
            parts.append("")
            parts.append("| COMPONENT | QTY | COMBO EA | COMBO | LIST | 1-CS DISC |")
            parts.append("|---|---|---|---|---|---|")
            for comp in comps:
                cell = _quickview_cell(comp.get("product_name"), ws, comp.get("upc"), comp.get("unit_volume"))
                cases = comp.get("cases")
                qty_lbl = f"{int(round(cases))} cs" if (cases is not None and abs(cases - round(cases)) < 0.01) \
                    else (f"{cases:.1f} cs" if cases is not None else "—")
                # Combo each carries its actual unit (bottle vs case) — the figure
                # the buyer scans to see the per-unit deal.
                u = comp.get("price_unit")
                suf = "/btl" if u == "bottle" else ("/cs" if u == "case" else "")
                ce = comp.get("combo_each")
                ce_txt = (_fmt_money(ce) + suf) if (ce is not None and u in ("bottle", "case")) else (
                    f"{_fmt_money(ce)} *(unit?)*" if ce is not None else "—")
                onecs_mark = "" if comp.get("has_separate_deal") else " *(=list)*"
                parts.append(f"| {cell} | {qty_lbl} | {ce_txt} | "
                             f"{_fmt_money(comp.get('combo_cost'))} | "
                             f"{_fmt_money(comp.get('frontline_cost'))} | "
                             f"{_fmt_money(comp.get('best_separate_cost'))}{onecs_mark} |")
            # TOTAL row — the three baselines added together.
            parts.append(f"| **Total** |  | | **{_fmt_money(combo_cost)}** | "
                         f"**{_fmt_money(front)}** | **{_fmt_money(onecs)}** |")
        parts.append("_⚠️ A combo forces you to buy EVERY component at the listed quantity._"
                     + ("  Some components couldn't be priced cleanly (variety/special pack or not on the "
                        "current sheet), so totals are partial." if c.get("any_component_missing_price") else ""))
        parts.append("")
    if len(worth) > len(shown):
        parts.append(f"_…and {len(worth) - len(shown)} more worth taking — filter by brand or distributor to narrow._")
        parts.append("")
    # Compact "traps" section — combos that LOOK like deals but lose to buying
    # the components separately at their own discount/RIP. Biggest miss first.
    if traps:
        parts.append(f"**⚠️ Skip these {min(len(traps), 8)} — cheaper at the one-case price:**")
        for c in traps[:8]:
            ws = (c.get("wholesaler") or "").title()
            sep = c.get("save_vs_separate")
            cheaper = _fmt_money(-sep) if sep is not None else "—"
            contents = (c.get("contents") or "").strip()
            contents = (contents[:70] + "…") if len(contents) > 70 else contents
            parts.append(f"- **{c.get('combo_code')}** ({ws}) — {cheaper} cheaper separately (1-cs)"
                         + (f" · {contents}" if contents else ""))
        if len(traps) > 8:
            parts.append(f"- _…and {len(traps) - 8} more not worth it._")
    return "\n".join(parts).rstrip()


def _format_time_sensitive_md(rows: list) -> str:
    """TIME-SENSITIVE (find_deals time_sensitive / closeout): a table of dated
    deals ordered by SOONEST end date, each product a modal link, with case price,
    $ saved per case and the end date."""
    if not isinstance(rows, list) or not rows:
        return ""
    def _end(r):
        return str(r.get("ends") or r.get("to_date") or "9999-99-99")
    ordered = sorted(rows, key=_end)
    parts: list[str] = []
    n = len(ordered)
    top = ordered[0]
    lead = None
    if top.get("total_savings_per_case") is not None:
        lead = (f"Soonest: {top.get('product_name')} saves "
                f"{_fmt_money(top.get('total_savings_per_case'))}/cs, ends {_fmt_date_short(_end(top))}.")
    parts.append(f"⏳ **Time-Sensitive Deals — {n} ending soon**")
    if lead:
        parts.append(lead)
    parts.append("")
    parts.append("| PRODUCT | SIZE | DISTRIBUTOR | CASE PRICE | SAVE/CS | ENDS |")
    parts.append("|---|---|---|---|---|---|")
    for r in ordered[:20]:
        cell = _quickview_cell(r.get("product_name"), r.get("wholesaler"), r.get("upc"), r.get("unit_volume"))
        case = r.get("effective_case_price")
        if case is None:
            case = r.get("frontline_case_price")
        parts.append(f"| {cell} | {r.get('unit_volume') or '—'} | "
                     f"{str(r.get('wholesaler') or '').title()} | {_fmt_money(case)} | "
                     f"{_fmt_money(r.get('total_savings_per_case'))} | {_fmt_date_short(_end(r))} |")
    return "\n".join(parts).rstrip()


def _format_movers_md(con, rows: list, direction: str) -> str:
    """PRICE DROPS / INCREASE (price_movers): a table of products moving next
    edition, ordered by biggest delta. Looks up each row's next-month effective
    price (the mover tool returns only this-month fields) so the table can show
    THIS vs NEXT and the per-case delta. Each product is a modal link."""
    if not isinstance(rows, list) or not rows:
        return ""
    up = direction == "increase"
    cym = _current_ym()
    # Batch the next-edition effective price for every (wholesaler, upc) in one go.
    nxt: dict = {}
    keys = sorted({(r.get("wholesaler"), str(r.get("upc") or "").lstrip("0"))
                   for r in rows if r.get("wholesaler") and str(r.get("upc") or "").lstrip("0")})
    if keys:
        try:
            ph = ", ".join(f"($w{i}, $u{i})" for i in range(len(keys)))
            kp: dict = {}
            for i, (w, u) in enumerate(keys):
                kp[f"w{i}"], kp[f"u{i}"] = w, u
            df = con.execute(
                "WITH nx AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched "
                f"           WHERE edition > '{cym}' GROUP BY wholesaler) "
                "SELECT c.wholesaler ws, LTRIM(CAST(c.upc AS VARCHAR),'0') un, "
                "       MIN(c.effective_case_price) eff "
                "FROM cpl_enriched c JOIN nx ON c.wholesaler=nx.wholesaler AND c.edition=nx.ed "
                f"WHERE (c.wholesaler, LTRIM(CAST(c.upc AS VARCHAR),'0')) IN ({ph}) "
                "GROUP BY 1,2", kp).fetchdf()
            for _, r in df.iterrows():
                nxt[(r["ws"], r["un"])] = _num(r["eff"])
        except Exception:
            pass

    enriched = []
    for r in rows:
        this_c = r.get("effective_case_price")
        if this_c is None:
            this_c = r.get("frontline_case_price")
        nc = nxt.get((r.get("wholesaler"), str(r.get("upc") or "").lstrip("0")))
        delta = (float(nc) - float(this_c)) if (nc is not None and this_c is not None) else None
        enriched.append((r, this_c, nc, delta))
    # Biggest movement first (absolute delta); rows without a next price sink.
    enriched.sort(key=lambda e: (e[3] is None, -abs(e[3]) if e[3] is not None else 0))

    parts: list[str] = []
    n = len(enriched)
    head = "📈" if up else "📉"
    word = "Increases" if up else "Drops"
    parts.append(f"{head} **Price {word} — {n} item{'s' if n != 1 else ''} "
                 f"{'rising' if up else 'falling'} next month**")
    if not nxt:
        parts.append("*Next edition isn't published yet — showing this-month pricing; deltas appear once it lands.*")
    parts.append("")
    parts.append("| PRODUCT | SIZE | DISTRIBUTOR | THIS MONTH | NEXT MONTH | Δ/CS |")
    parts.append("|---|---|---|---|---|---|")
    for r, this_c, nc, delta in enriched[:25]:
        cell = _quickview_cell(r.get("product_name"), r.get("wholesaler"), r.get("upc"), r.get("unit_volume"))
        dtxt = "—" if delta is None else (f"+{_fmt_money(delta)}" if delta > 0 else _fmt_money(delta))
        parts.append(f"| {cell} | {r.get('unit_volume') or '—'} | "
                     f"{str(r.get('wholesaler') or '').title()} | {_fmt_money(this_c)} | "
                     f"{_fmt_money(nc)} | {dtxt} |")
    return "\n".join(parts).rstrip()


def ask(question: str, history: list | None = None, user: dict | None = None,
        page: str | None = None, page_path: str | None = None,
        page_query: str | None = None) -> dict:
    question = (question or "").strip()
    if not question:
        return {"answer": "Ask me anything about your catalog — pricing, deals, distributors, or say "
                          "‘add 2 cases of the cheapest prosecco to my cart’.",
                "charts": [], "actions": [], "products": [],
                "usage": {"input_tokens": 0, "output_tokens": 0, "model": "none", "cost_usd": 0.0, "enabled": enabled()}}

    # Deterministic UPC fast-path: a message that is essentially just a barcode
    # (with no price/compare/RIP intent) ALWAYS locates the product on the main
    # screen — no model call, so it can't get answered in chat by mistake, and
    # it works even when the AI is offline. Detail intents fall through to the
    # model (which uses price_details / compare_distributors / rip_lookup).
    _nospace = re.sub(r"[\s\-]", "", question)
    _upc_m = re.search(r"\d{11,14}", _nospace)
    _detail_kw = ("price", "cost", "compare", "rip", "rebate", "tier", "breakdown",
                  "history", "margin", "detail", "waterfall", "best buy", "vs ")
    if _upc_m and not any(k in question.lower() for k in _detail_kw):
        upc = _upc_m.group(0)
        try:
            with get_duckdb() as con:
                hit = _resolve_products(con, {}, upc, "first", 1)
        except Exception:
            hit = []
        zero = {"input_tokens": 0, "output_tokens": 0, "model": "rule", "cost_usd": 0.0, "enabled": enabled()}
        # Stay on the current page when it filters by ?q; otherwise use the catalog.
        base = page_path if (page_path in _Q_FILTER_PATHS) else "/catalog"
        if hit:
            here = " here" if base != "/catalog" or page == "Catalog" else " in the catalog"
            return {"answer": f"Showing **{hit[0].get('product_name')}**{here}. Anything else I can help with?",
                    "charts": [], "actions": [], "products": [],
                    "screen": {"path": f"{base}?q={upc}", "label": hit[0].get("product_name") or upc},
                    "usage": zero}
        return {"answer": f"Product not found for UPC {upc}. Anything else I can help with?",
                "charts": [], "actions": [], "products": [], "screen": None, "usage": zero}

    # Deterministic "add the WHOLE case mix to cart" fast-path. A weaker model
    # (Haiku) won't reliably pass rip_code to perform_action — it falls back to a
    # name lookup per SKU that misses 15 of 16 — so when the user clearly wants the
    # entire Case Mix added, resolve the RIP code from the message (or the most
    # recent assistant turn) and add every member ourselves, no model call needed.
    _ql = question.lower()
    _add_all = (bool(re.search(r"\badd\b", _ql)) and
                bool(re.search(r"\b(case\s*mix|all of (these|them)|all these|all members|all the skus|every (sku|member|item))\b", _ql)))
    if _add_all:
        code = None
        m = re.search(r"\b(?:rip\s*(?:code)?\s*[:#]?\s*)?(\d{5,6})\b", question)
        if m:
            code = m.group(1)
        if not code and history:
            for msg in reversed(history):
                if (msg or {}).get("role") == "assistant":
                    mm = (re.search(r"\bcode\s*`?(\d{5,6})`?", str(msg.get("content") or ""))
                          or re.search(r"\bRIP\s*`?(\d{5,6})`?", str(msg.get("content") or "")))
                    if mm:
                        code = mm.group(1)
                        break
        if code:
            cases = 1
            qm = re.search(r"(\d+)\s*(?:case|cs)\b", _ql) or re.search(r"\bqty\s*(\d+)", _ql)
            if qm:
                try:
                    cases = max(1, int(qm.group(1)))
                except ValueError:
                    cases = 1
            try:
                with get_duckdb() as con:
                    mix = _rip_case_mix_products(con, code)
            except Exception:
                mix = []
            if mix:
                products, seen = [], set()
                for p in mix:
                    key = (p.get("wholesaler"), str(p.get("upc") or ""), p.get("product_name"))
                    if key in seen:
                        continue
                    seen.add(key)
                    products.append({k: p.get(k) for k in
                                     ("product_name", "wholesaler", "upc", "unit_volume", "unit_qty",
                                      "vintage", "effective_case_price", "frontline_case_price")})
                action = {"type": "add_to_cart", "cases": cases, "bottles": 0,
                          "list_name": None, "products": products, "note": None}
                zero = {"input_tokens": 0, "output_tokens": 0, "model": "rule", "cost_usd": 0.0, "enabled": enabled()}
                return _json_safe({
                    "answer": f"Added all **{len(products)} Case-Mix products** (RIP {code}) to your cart at "
                              f"{cases} case{'s' if cases != 1 else ''} each. Anything else I can help with?",
                    "charts": [], "actions": [action], "products": products[:24], "screen": None,
                    "usage": zero,
                })

    client = _client_or_none()
    if client is None:
        return _fallback(question)

    ctx = {"user_id": (user or {}).get("id")}

    # Route to the cheapest capable model, and prompt-cache the (large) system +
    # tools block so the agentic loop doesn't re-bill it every turn.
    from backend.model_router import choose_model
    # Standalone /assistant page has no grid: it must produce real summaries and
    # tables, which needs stronger instruction-following. Route its analytical /
    # listing questions to Sonnet; docked mode keeps the cheap Haiku-first split.
    model = choose_model(question, standalone=(not page_path))
    tools = _tool_specs()
    if tools:
        tools[-1] = {**tools[-1], "cache_control": {"type": "ephemeral"}}
    # Cache the big static system block; append a small dynamic page hint so the
    # model prioritizes tools relevant to the screen the user is on.
    system_blocks = [{"type": "text", "text": _SYSTEM, "cache_control": {"type": "ephemeral"}}]
    # CORE RULE — the defining behaviour difference between the two surfaces the
    # assistant runs on. Everything else defers to this.
    system_blocks.append({"type": "text", "text":
        "CORE RULE — adapt to WHERE you are running (the SCREEN/STANDALONE block below says which):\n"
        "(A) DOCKED beside a data grid (you are on a page screen): your primary job is to REFRESH THAT GRID. "
        "For any show / find / filter / sort / 'with RIP' / 'on deal' / price-trend request, call show_on_screen "
        "so the grid updates in place (a one-line confirmation in chat is enough). Use chat prose only for "
        "genuinely conversational questions (why/how, totals & counts, one product's full breakdown, a "
        "head-to-head comparison, a RIP tier explanation).\n"
        "(B) STANDALONE chat page (no grid anywhere beside you): present the INFO & ANALYSIS in the chat FIRST "
        "— call the data tools and show prose + compact tables + charts + product cards grounded in real rows — "
        "and THEN add a link to open the relevant data grid. NEVER reply with only a grid link or a bare "
        "one-liner here; the analysis is the answer, the grid link is a follow-up."})
    if page:
        scope = _PAGE_SCOPE.get(page)
        if scope:
            system_blocks.append({"type": "text", "text":
                f"SCREEN SCOPE — you are DOCKED beside the '{page}' data grid and are SCOPED TO IT ONLY. "
                f"Help only with: {scope}. Stay on this screen — do NOT navigate away. Per the CORE RULE, for "
                f"any show/find/filter/sort request REFRESH this grid by calling show_on_screen (even if it "
                f"already shows similar data) so the buyer sees the updated result, with a one-line chat "
                f"confirmation. If the user "
                f"asks about something that belongs to a DIFFERENT screen (e.g. a general catalog search, "
                f"orders, favorites) say in one line that it's handled on that other screen and offer to "
                f"help within '{page}' instead — do not answer the off-screen request or switch pages. "
                f"(You may still use price_details / rip_lookup / compare_distributors for detail on a "
                f"product shown on THIS screen.)"})
        else:
            system_blocks.append({"type": "text", "text":
                f"The user is on the '{page}' screen. Stay here and keep answers relevant to it; do not "
                f"navigate away unless they explicitly ask."})
    if not page_path:
        # Standalone Celar Assistant page (no grid on the side). The default
        # "one-line confirmation" rule assumes the filtered grid is visible
        # next to the chat — here it isn't, so the user gets a thin reply.
        # Override: still call show_on_screen so a hyperlink is surfaced, but
        # ALSO answer in prose with a real summary (top 3-5 items, counts,
        # price range) so the chat is useful even before the user clicks
        # through. Use the matching data tool first (top_products / find_deals
        # / price_movers / etc.) to ground the summary in actual rows — never
        # invent numbers.
        system_blocks.append({"type": "text", "text":
            "STANDALONE ASSISTANT PAGE: the user is on the dedicated /celar "
            "page with NO grid visible anywhere — not to the left, not on the "
            "page, not on the screen. The chat IS the only view. "
            "BANNED PHRASES (do NOT use any of these on this page): 'on the "
            "left', 'to the left', 'on the page', 'on the screen', 'on the "
            "side', 'in the grid', 'the catalog is filtered to', 'I've "
            "filtered the page', 'showing X on Y'. They are LIES on this "
            "page because no such surface exists. "
            "For show-on-screen-style requests (find/show/list/cheapest/etc.) "
            "you MUST: (1) call the relevant data tool (top_products, "
            "find_deals, price_movers, deal_360, compare_distributors, "
            "rip_lookup) to get real numbers; (2) call show_on_screen so the "
            "user gets a hyperlink to the filtered Catalog page; (3) reply "
            "with a concise PROSE summary of the picks. DO NOT hand-format the "
            "products as a markdown table — the app AUTOMATICALLY renders the "
            "returned products as an interactive table (clickable names that open "
            "the product modal + a this->next pricing sparkline per row), so a "
            "markdown table would just duplicate it. Just summarize the top picks "
            "in words (e.g. 'Found N matches — the cheapest is X at $Y/cs; Z also "
            "stands out') and let the table show the detail. Phrase as 'Found N "
            "matches. Top picks:' or 'Here are the cheapest X:' — NEVER 'Showing "
            "X on [anything]'. Surface the hyperlink as 'Open full list in "
            "Catalog ->' at the end. End with one offer to help further. "
            "SEMANTIC FILTERS on the data tools: top_products, price_movers and "
            "find_deals now accept region= and varietal= (same vocabulary as "
            "show_on_screen) and price_trend=increase|drop. For ANY geography or "
            "grape/style query you MUST pass region=/varietal= (NOT match=, which "
            "matches stray substrings like ABSOLUT CALIFORNIA). For 'prices going "
            "up/down', pass price_trend, optionally with region/category, e.g. "
            "'California wines going up' -> top_products(region=california, "
            "price_trend=increase) or price_movers(region=california, "
            "direction=increase). This returns the RIGHT products for the inline "
            "table instead of unrelated spirits."})
    messages = _history_messages(history) + [{"role": "user", "content": question}]
    total_in = total_out = 0
    final_text = ""
    actions_out: list = []
    products_out: list = []
    seen_products: set = set()
    price_detail_result: dict | None = None
    timeline_result: dict | None = None   # last price_timeline result (for the deterministic line chart)
    rip_lookup_result: dict | None = None  # last rip_lookup result the model used (for the deterministic RIP template)
    # Tool results the model used this turn, for the other deterministic templates
    # (Item / Combo / Time-Sensitive / Price Movers). Each is captured below as the
    # model calls the backing tool, then rendered + substituted after the turn.
    item_result: dict | None = None         # deal_360 / price_details
    combo_result: list | None = None         # combo_deals
    combo_analyzer_result: dict | None = None  # combo_analyzer
    time_sensitive_result: list | None = None  # find_deals(time_sensitive|closeout)
    movers_result: tuple | None = None       # (rows, direction) from price_movers
    screen_out: dict | None = None
    screen_args: dict | None = None   # last show_on_screen filters (for the standalone auto-table)
    # RIP clusters touched by any rip_lookup call this turn. Each entry is
    # {code, wholesaler, label, member_count}; the frontend renders one "Add
    # Case Mix to Cart" button per cluster, which calls /api/cart/add-by-rip
    # to resolve the full member list server-side and add it as ONE batch.
    rip_clusters_out: list = []
    rip_clusters_seen: set = set()

    def _collect(items):
        # Accumulate any product dicts a tool surfaced so the UI can render them
        # as actionable cards (Add to Cart / List / Favorite). Deduped.
        for p in (items or []):
            if not isinstance(p, dict) or not p.get("product_name"):
                continue
            key = (p.get("wholesaler"), str(p.get("upc") or ""), p.get("product_name"), p.get("unit_volume"))
            if key in seen_products:
                continue
            seen_products.add(key)
            products_out.append({k: p.get(k) for k in
                                 ("product_name", "wholesaler", "upc", "unit_volume", "unit_qty",
                                  "vintage", "effective_case_price", "frontline_case_price")})

    with get_duckdb() as con:
        for _ in range(_MAX_TURNS):
            try:
                resp = client.messages.create(
                    model=model, max_tokens=1500, system=system_blocks, tools=tools, messages=messages,
                )
            except Exception as e:
                out = _fallback(question)
                out["answer"] = f"_AI call failed ({type(e).__name__})._ " + out["answer"]
                return out
            total_in += getattr(resp.usage, "input_tokens", 0) or 0
            total_out += getattr(resp.usage, "output_tokens", 0) or 0

            if resp.stop_reason == "tool_use":
                # Reconstruct the assistant turn (text + tool_use blocks) to send back.
                asst_content = []
                for b in resp.content:
                    if getattr(b, "type", "") == "text":
                        asst_content.append({"type": "text", "text": b.text})
                    elif getattr(b, "type", "") == "tool_use":
                        asst_content.append({"type": "tool_use", "id": b.id, "name": b.name, "input": b.input})
                messages.append({"role": "assistant", "content": asst_content})
                results = []
                for b in resp.content:
                    if getattr(b, "type", "") != "tool_use":
                        continue
                    # Normalise any distributor name the model passes ("Allied
                    # Beverage" -> "allied") so every tool filters on the slug the
                    # catalog stores, not a label that matches nothing.
                    if isinstance(getattr(b, "input", None), dict):
                        for _dk in ("distributor", "from_distributor", "to_distributor"):
                            _dv = b.input.get(_dk)
                            if _dv:
                                _slug = _resolve_distributor(_dv)
                                if _slug:
                                    b.input[_dk] = _slug
                        if isinstance(b.input.get("distributors"), list):
                            b.input["distributors"] = [
                                (_resolve_distributor(d) or d) for d in b.input["distributors"]]
                    if b.name == "show_on_screen":
                        si = b.input or {}
                        screen_args = si
                        sc = _build_screen(si, page_path, page_query)
                        # If the request targets a specific UPC, verify it exists
                        # so we can say "showing it" vs "product not found" (and
                        # not navigate to an empty screen on a bad barcode).
                        q = (si.get("q") or "").strip()
                        compact = re.sub(r"[\s\-]", "", q)
                        if compact.isdigit() and len(compact) >= 6:
                            try:
                                hit = _resolve_products(con, {}, q, "first", 1)
                            except Exception:
                                hit = []
                            if hit:
                                screen_out = sc
                                out = {"ok": True, "found": True, "path": sc["path"],
                                       "product": hit[0].get("product_name")}
                            else:
                                out = {"ok": False, "found": False,
                                       "message": f"No product found for UPC {q}."}
                        else:
                            screen_out = sc
                            out = {"ok": True, "path": sc["path"]}
                    elif b.name == "perform_action":
                        try:
                            out = _do_action(con, b.input or {}, actions_out)
                            if actions_out:   # surface the acted-on products as cards
                                _collect(actions_out[-1].get("products"))
                        except Exception as e:
                            out = {"error": f"{type(e).__name__}"}
                    elif b.name in _CTX_TOOLS:
                        try:
                            out = _CTX_TOOLS[b.name][0](con, b.input or {}, ctx)
                        except Exception as e:
                            out = {"error": f"{type(e).__name__}"}
                        if isinstance(out, list):   # find_deals / price_movers -> cards
                            _collect(out)
                        # Capture for the deterministic templates (rendered after
                        # the turn): time-sensitive deals and price movers.
                        if (b.name == "find_deals" and isinstance(out, list) and out
                                and str((b.input or {}).get("kind") or "").lower()
                                    in ("time_sensitive", "time-sensitive", "ending", "expiring",
                                        "clearance", "closeout")):
                            time_sensitive_result = out
                        if b.name == "price_movers" and isinstance(out, list):
                            _dir = (b.input or {}).get("direction") or (b.input or {}).get("price_trend") or "drop"
                            _dir = "increase" if str(_dir).lower() in ("increase", "up", "rising", "rise") else "drop"
                            movers_result = (out, _dir)
                    elif b.name in _DATA_TOOLS:
                        try:
                            out = _DATA_TOOLS[b.name][0](con, b.input or {})
                        except Exception as e:
                            out = {"error": f"{type(e).__name__}"}
                        # top_products / price_history surface concrete products.
                        if isinstance(out, list):
                            _collect(out)
                        elif isinstance(out, dict) and out.get("product") and b.name != "price_timeline":
                            _collect([{**out, "product_name": out.get("product")}])
                        # compare_distributors -> each distributor row as a card;
                        # find_substitute -> each alternative as a card.
                        if isinstance(out, dict) and isinstance(out.get("comparison"), list):
                            _collect(out["comparison"])
                        if isinstance(out, dict) and isinstance(out.get("alternatives"), list):
                            _collect(out["alternatives"])
                        if isinstance(out, dict) and isinstance(out.get("basket"), list):
                            _collect(out["basket"])
                        if b.name in ("price_details", "deal_360") and isinstance(out, dict) and not out.get("error"):
                            price_detail_result = out
                            # deal_360 is richer (months/combo/ts) — prefer it for
                            # the Item template; a bare price_details still renders.
                            if item_result is None or b.name == "deal_360":
                                item_result = out
                            _collect([out])   # also show the product as a card
                        if b.name == "combo_deals" and isinstance(out, list) and out:
                            combo_result = out
                        if b.name == "combo_analyzer" and isinstance(out, dict) and (out.get("combos")):
                            combo_analyzer_result = out
                        if b.name == "price_timeline" and isinstance(out, dict) and not out.get("error"):
                            timeline_result = out   # deterministic line chart attached below
                        # RIP clusters: surface one entry per (wholesaler, code)
                        # so the frontend can render two action buttons per
                        # cluster — "Add Case Mix to Cart" and a deep link
                        # that opens the same cluster in the Catalog page.
                        if (b.name == "rip_lookup" and isinstance(out, dict)
                                and not out.get("error")):
                            # Keep the richest rip_lookup result the model used this
                            # turn so the deterministic RIP template can render from
                            # the EXACT data the model saw — no fragile re-extraction
                            # of a search term from the question (which silently
                            # produced empty output on combo/follow-up phrasings and
                            # let the model's free-form table stand). Prefer a result
                            # that actually carries rip_codes.
                            if (rip_lookup_result is None
                                    or (out.get("rip_codes") and not rip_lookup_result.get("rip_codes"))):
                                rip_lookup_result = out
                            for rc in out.get("rip_codes") or []:
                                code = (rc.get("rip_code") or "").strip()
                                ws_c = (rc.get("wholesaler") or "").strip()
                                if not code or not ws_c:
                                    continue
                                # Skip malformed multi-code rows: some source
                                # RIP sheets jam two codes into one cell
                                # ("10209 50017"), which never resolves
                                # against the canonical rip_code column and
                                # produces empty Add-to-Cart / Open-in-Catalog
                                # results. The legitimate single-code clusters
                                # (10209, 50017) appear as their own rows.
                                if any(ch.isspace() for ch in code):
                                    continue
                                # Skip clusters with zero members — the buttons
                                # would resolve to empty either way and just
                                # waste the user's attention.
                                if int(rc.get("member_count") or 0) <= 0:
                                    continue
                                key = (ws_c.lower(), code)
                                if key in rip_clusters_seen:
                                    continue
                                rip_clusters_seen.add(key)
                                # Deep link PINS to the cluster's exact member
                                # UPCs (?upcs=<csv> + wholesaler), so the grid
                                # shows precisely the Case Mix the chat lists —
                                # NOT a rip_code+group_by_rip filter, which fans
                                # a UPC out across every code it carries and could
                                # land the buyer on a DIFFERENT (e.g. combo/stack)
                                # cluster than the button promised. Bounded at 120
                                # UPCs (URL stays < ~2KB); a larger cluster falls
                                # back to the exact-code filter WITHOUT group_by_rip
                                # so the fan-out still can't relabel rows.
                                from urllib.parse import quote as _quote
                                _ws_q = _quote(ws_c.lower(), safe='')
                                try:
                                    _members = _rip_case_mix_products(con, code, ws_c)
                                except Exception:
                                    _members = []
                                _upcs = sorted({
                                    str(m.get("upc") or "").lstrip("0")
                                    for m in _members
                                    if str(m.get("upc") or "").lstrip("0")
                                })
                                if _upcs and len(_upcs) <= 120:
                                    catalog_url = (
                                        f"/catalog?wholesaler={_ws_q}"
                                        f"&upcs={_quote(','.join(_upcs), safe=',')}"
                                    )
                                else:
                                    catalog_url = (
                                        f"/catalog?wholesaler={_ws_q}"
                                        f"&rip_code={_quote(code, safe='')}"
                                    )
                                rip_clusters_out.append({
                                    "rip_code": code,
                                    "wholesaler": ws_c,
                                    "label": f"{ws_c} RIP {code}",
                                    "member_count": int(rc.get("member_count") or 0),
                                    "description": rc.get("description"),
                                    "catalog_url": catalog_url,
                                })
                    else:
                        out = {"error": "unknown tool"}
                    results.append({"type": "tool_result", "tool_use_id": b.id,
                                    "content": json.dumps(out, default=str)[:6000]})
                messages.append({"role": "user", "content": results})
                continue

            final_text = "".join(getattr(b, "text", "") for b in resp.content if getattr(b, "type", "") == "text")
            break

    charts = _extract_charts(final_text)
    # Deterministically attach the alcohol-retail price visuals when a price
    # breakdown was fetched, so they always appear (not model-dependent).
    charts = _price_charts(price_detail_result) + _timeline_charts(timeline_result) + charts
    answer = _strip_charts(final_text) or "Done."
    if not page_path:
        # Standalone page: no grid exists, so strip any "on the left/screen/page"
        # phrasing the model emitted regardless of the prompt instruction.
        answer = _scrub_standalone(answer)
        # AUTO-TABLE: on the standalone page the model often just drives a screen
        # (confirmation + link) and forgets to fetch products, so the user has to
        # ask "show in table". If it drove a catalog-style screen but surfaced no
        # products, populate the inline table deterministically from the SAME
        # filters the link uses, so the table always appears without being asked.
        if screen_out is not None and not products_out and screen_args is not None:
            try:
                _collect(_auto_table_products(screen_args))   # deduped into products_out
            except Exception:
                pass  # never fail the answer over the auto-table
        # (Standalone-only RIP fallback removed — replaced by the unconditional
        # RIP template below, which fires for any RIP question regardless of
        # mode so the layout is identical on Haiku / Sonnet / Opus.)
    # RIP TEMPLATE — for any rebate-related question, REPLACE the model's text
    # with the deterministic rich template (product header → tier table with
    # case+bottle columns → "At N cases" effective summary → full Case Mix
    # table). User rule: "make this as a fixed template; show irrespective of
    # model". The model's text is dropped because Haiku / Sonnet / Opus all
    # vary in layout and accuracy. The frontend's per-cluster Add-to-Cart
    # buttons (rip_clusters) keep working since they read structured fields,
    # not the answer text.
    _ql = question.lower()
    # Fire the deterministic RIP template when the question is about rebates OR
    # the model actually called rip_lookup this turn (covers combo/stack and
    # follow-up phrasings like "explain the combo code" that never contain the
    # word "rip" but still resolved a Case Mix the model tabulated free-form).
    _model_used_rip = isinstance(rip_lookup_result, dict) and bool(rip_lookup_result.get("rip_codes"))
    _tmpl_fired = False   # set once any deterministic template replaces the answer
    if _model_used_rip or any(k in _ql for k in ("rip", "rebate")):
        # SUMMARY intent: "by distributor show rip codes and case-mix sizes",
        # "how many products per rip", "list every rip per distributor". The
        # rollup template lists every (wholesaler, rip_code) with its SKU
        # count instead of focusing on one focal product.
        summary_intent = any(p in _ql for p in (
            "by distributor", "per distributor", "by wholesaler", "per wholesaler",
            "every rip", "all rips", "all rip codes", "list rip", "list of rip",
            "rip codes and", "rip number and number", "rip count", "case mix size",
            "items per rip", "products per rip", "size per rip",
        ))
        # Optional one-distributor filter the model may have typed in words.
        dist_filter = None
        for w in ("allied", "fedway", "opici"):
            if w in _ql:
                dist_filter = w
                break
        import logging as _logging
        _rip_log = _logging.getLogger("assistant.rip_template")
        if summary_intent:
            try:
                with get_duckdb() as _con:
                    _rs = _t_rip_summary(_con, {"distributor": dist_filter})
                _md = _format_rip_summary_md(_rs)
                if _md:
                    answer = _md
                    _tmpl_fired = True
                    _rip_log.info("RIP summary template fired (chars=%d)", len(_md))
                else:
                    _rip_log.info("RIP summary template produced empty output (dist=%s)", dist_filter)
            except Exception:
                _rip_log.exception("RIP summary template raised")
        else:
            try:
                # PREFER the rip_lookup result the model actually used this turn:
                # it already resolved the focal product + codes from the model's own
                # (smarter) interpretation of the question. Rendering from it makes
                # the template fire reliably — the old path RE-EXTRACTED a term from
                # the raw question and re-ran rip_lookup, which silently produced
                # nothing on combo/follow-up phrasings and let the model's free-form
                # table stand. Only re-extract + re-lookup when the model did NOT
                # call rip_lookup this turn.
                _rl = (rip_lookup_result
                       if (isinstance(rip_lookup_result, dict) and rip_lookup_result.get("rip_codes"))
                       else None)
                term = None
                if _rl is None:
                    term = (screen_args or {}).get("q") if screen_args else None
                    if not term:
                        m = re.search(r"\b(?:for|of|about|on)\s+(.+)$", question, re.I)
                        term = (m.group(1) if m else "").strip()
                        term = re.sub(r"\b(rip|rebate|details?|analysis|code|tiers?|mix|bottle|prices?)\b",
                                      " ", term, flags=re.I).strip()
                    if not term:
                        # Last-ditch: strip stop words from the whole question.
                        term = re.sub(r"\b(show|me|products?|the|and|for|of|about|on|in|with|rip|rebate|mix|case|bottle|prices?|details?)\b",
                                      " ", _ql).strip()
                _rip_log.info("RIP template trigger: question=%r reused_model_lookup=%s term=%r",
                              question, _rl is not None, term)
                with get_duckdb() as _con:
                    if _rl is None and term:
                        _rl = _t_rip_lookup(_con, {"match": term})
                    _md = _format_rip_full_md(_con, _rl) if _rl else ""
                _codes = (_rl or {}).get("rip_codes") or []
                _mp = (_rl or {}).get("matched_products") or []
                if _md:
                    answer = _md
                    _tmpl_fired = True
                    _rip_log.info("RIP template fired: reused=%s term=%r matched=%d codes=%d chars=%d",
                                  _rl is rip_lookup_result, term, len(_mp), len(_codes), len(_md))
                else:
                    _rip_log.warning("RIP template produced empty output: term=%r matched=%d codes=%d note=%r",
                                     term, len(_mp), len(_codes), (_rl or {}).get("note"))
            except Exception:
                _rip_log.exception("RIP template raised for question=%r", question)

    # OTHER deterministic templates — Item / Combo / Time-Sensitive / Price
    # Movers. Each renders from the tool result the model used this turn and
    # REPLACES the model's free-form text, exactly like RIP. Precedence (only one
    # fires): RIP (above, intent-gated) > Item > Combo > Time-Sensitive > Movers.
    # If a template raises or yields nothing, the model's own text stands and the
    # prompt's backstop instructions keep that answer on-format.
    if not _tmpl_fired:
        import logging as _logging2
        _tlog = _logging2.getLogger("assistant.det_template")
        try:
            if isinstance(item_result, dict) and not item_result.get("error") and item_result.get("product_name"):
                _md = _format_item_md(item_result)
                if _md:
                    answer = _md
                    _tmpl_fired = True
                    _tlog.info("Item template fired (chars=%d)", len(_md))
            if not _tmpl_fired and isinstance(combo_analyzer_result, dict) and combo_analyzer_result.get("combos"):
                _md = _format_combo_analyzer_md(combo_analyzer_result)
                if _md:
                    answer = _md
                    _tmpl_fired = True
                    _tlog.info("Combo analyzer template fired (chars=%d)", len(_md))
            if not _tmpl_fired and isinstance(combo_result, list) and combo_result:
                _md = _format_combo_md(combo_result)
                if _md:
                    answer = _md
                    _tmpl_fired = True
                    _tlog.info("Combo template fired (chars=%d)", len(_md))
            if not _tmpl_fired and isinstance(time_sensitive_result, list) and time_sensitive_result:
                _md = _format_time_sensitive_md(time_sensitive_result)
                if _md:
                    answer = _md
                    _tmpl_fired = True
                    _tlog.info("Time-sensitive template fired (chars=%d)", len(_md))
            if not _tmpl_fired and isinstance(movers_result, tuple) and movers_result[0]:
                with get_duckdb() as _con:
                    _md = _format_movers_md(_con, movers_result[0], movers_result[1])
                if _md:
                    answer = _md
                    _tmpl_fired = True
                    _tlog.info("Movers template fired (%s, chars=%d)", movers_result[1], len(_md))
        except Exception:
            _tlog.exception("deterministic template raised for question=%r", question)
    # Multi-product answers (3+ products) get enriched with tier ladders so
    # the frontend can render a side-by-side comparison table, and a Catalog
    # deep-link is built by exact UPCs so "Open in Catalog ->" lands on the
    # same set the chat shows. Cap at 12 rows — that's all the table is sized
    # for; the user can hit the Catalog hyperlink for the full set.
    products_final = products_out[:24]
    if products_final:
        # Enrich EVERY surfaced product with its discount/RIP tiers + next-month
        # tiers so any tabular product view renders the rich interactive format
        # (clickable name -> modal + this->next pricing sparkline), not just the
        # 3+ comparison table.
        try:
            from backend.ai_catalog_query import _enrich_products_with_tiers
            with get_duckdb() as _con:
                _enrich_products_with_tiers(_con, products_final)
        except Exception:
            pass  # never fail the answer over enrichment
        if len(products_final) >= 3 and screen_out is None:
            # Normalise UPCs and drop blanks/zeros — a product missing a UPC
            # would otherwise put a stray empty string in the comma-separated
            # list and the catalog filter would think the user wanted an
            # empty UPC. Sort + dedupe so the link is deterministic.
            upcs = sorted({
                str(p.get("upc")).lstrip("0")
                for p in products_final
                if p.get("upc") and str(p.get("upc")).strip("0").strip()
            })
            if upcs:
                upc_csv = ",".join(upcs)
                screen_out = {
                    "path": f"/catalog?upcs={upc_csv}",
                    "label": f"these {len(products_final)} products in Catalog",
                }
        products_final = products_final[:12]
    return _json_safe({
        "answer": answer,
        "charts": charts,
        "actions": actions_out,
        "products": products_final,
        "rip_clusters": rip_clusters_out,
        "screen": screen_out,
        "usage": {"input_tokens": total_in, "output_tokens": total_out,
                  "model": model, "cost_usd": _cost_usd(model, total_in, total_out), "enabled": True},
    })


def _json_safe(v):
    """Coerce numpy/pandas scalars and NaN/Inf into plain JSON-serializable
    Python values. Product fields flow straight from pandas .to_dict(), so they
    can be numpy.int64 (e.g. unit_qty) which FastAPI's JSON encoder can't
    serialize — that surfaced as a 500 on any answer that returned product cards.
    Recurses through dicts/lists so the whole response is safe."""
    import math
    if isinstance(v, dict):
        return {k: _json_safe(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_json_safe(x) for x in v]
    if v is None or isinstance(v, (bool, str)):
        return v
    # numpy / pandas scalars expose .item() -> native Python scalar.
    if hasattr(v, "item") and not isinstance(v, (int, float)):
        try:
            v = v.item()
        except Exception:
            return str(v)
    if isinstance(v, float):
        return v if math.isfinite(v) else None
    if isinstance(v, int):
        return v
    return str(v)


def _num(v):
    try:
        f = float(v)
        return round(f, 2) if f == f else None  # drop NaN
    except (TypeError, ValueError):
        return None


def _price_charts(pd: dict | None) -> list:
    """Build the price waterfall + 3-month history charts from a price_details
    result, so every price question gets the alcohol-retail visuals."""
    if not pd:
        return []
    out = []
    fr = _num(pd.get("frontline_case_price"))
    bd = _num(pd.get("best_case_price_after_discount"))
    eff = _num(pd.get("effective_case_price"))
    labels, vals = [], []
    if fr is not None:
        labels.append("List"); vals.append(fr)
    if bd is not None and (fr is None or abs(bd - fr) > 0.001):
        labels.append("After Discount"); vals.append(bd)
    if eff is not None:
        labels.append("After RIP / Effective"); vals.append(eff)
    if len(vals) >= 2:
        out.append({"type": "bar", "title": f"Price waterfall — {pd.get('product_name')} ($/case)",
                    "labels": labels, "series": [{"name": "$/case", "data": vals}]})
    hist = pd.get("price_history_3mo") or []
    labels_h = [str(r.get("edition")) for r in hist]
    list_h = [_num(r.get("frontline_case_price")) or 0 for r in hist]
    eff_h = [_num(r.get("effective_case_price")) or 0 for r in hist]
    # Extend the trend into NEXT month when we know it, so the line shows
    # last → current → upcoming (the buyer's "should I wait?" picture).
    if (pd.get("next_edition") and _num(pd.get("next_month_case_effective")) is not None
            and (not labels_h or str(pd.get("next_edition")) != labels_h[-1])):
        labels_h = labels_h + [str(pd.get("next_edition"))]
        eff_h = eff_h + [_num(pd.get("next_month_case_effective"))]
        list_h = list_h + [eff_h[-1]]   # no separate next-month list; mirror effective
    if len(labels_h) >= 2:
        out.append({"type": "line", "title": "Price trend ($/case): last → now → next",
                    "labels": labels_h,
                    "series": [
                        {"name": "List", "data": list_h},
                        {"name": "Effective (after RIP)", "data": eff_h},
                    ]})
    return out


def _timeline_charts(tl: dict | None) -> list:
    """Line chart of effective $/case per edition, one series per distributor,
    from a price_timeline result. Carries values forward across gaps so a missing
    month doesn't read as a $0 dip (the renderer coalesces missing points to 0)."""
    if not tl or not tl.get("distributors"):
        return []
    eds = sorted({t["edition"] for d in tl["distributors"]
                  for t in d.get("timeline", [])})[-12:]
    if len(eds) < 2:
        return []
    series = []
    for d in tl["distributors"]:
        m = {t["edition"]: t.get("effective_case_price") for t in d.get("timeline", [])}
        known = [m[e] for e in eds if m.get(e) is not None]
        if not known:
            continue
        backfill = known[0]
        data, last = [], None
        for e in eds:
            v = m.get(e)
            if v is None:
                v = last if last is not None else backfill
            else:
                last = v
            data.append(v)
        series.append({"name": str(d["wholesaler"]).title(), "data": data})
    if not series:
        return []
    return [{"type": "line",
             "title": f"Effective $/case over months: {tl.get('product')}",
             "labels": eds, "series": series}]


def _extract_charts(text: str) -> list:
    """Pull ```chart fenced JSON blocks out of the answer."""
    charts = []
    if not text:
        return charts
    parts = text.split("```chart")
    for seg in parts[1:]:
        end = seg.find("```")
        if end == -1:
            continue
        body = seg[:end].strip()
        try:
            spec = json.loads(body)
            if isinstance(spec, dict) and spec.get("type") in ("bar", "line", "pie"):
                charts.append(spec)
        except Exception:
            continue
    return charts


def _strip_charts(text: str) -> str:
    if not text:
        return text
    out, rest = [], text
    while "```chart" in rest:
        before, _, after = rest.partition("```chart")
        out.append(before)
        _body, _, rest = after.partition("```")
    out.append(rest)
    return "".join(out).strip()
