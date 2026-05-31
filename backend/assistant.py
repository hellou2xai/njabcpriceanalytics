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
    _history_messages, enabled,
)

_ACTION_TYPES = ("add_to_cart", "update_quantity", "add_to_favorites", "add_to_list")
_MAX_TURNS = 6


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
    }
    which = {"cheapest": "cheapest", "expensive": "most_expensive"}.get(args.get("order_by"), "cheapest")
    cap = min(int(args.get("limit") or 10), 25)
    prods = _resolve_products(con, view, args.get("match") or "", which, cap)
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


def _rip_tiers_for(con, code, ws=None):
    """(description, [tiers]) for a RIP code from the rip sheet. ws optional."""
    where = ["CAST(rip_code AS VARCHAR) = ?"]
    params = [str(code)]
    if ws:
        where.append("wholesaler = ?")
        params.append(ws)
    try:
        df = con.execute(
            "SELECT rip_description, rip_unit_1, rip_qty_1, rip_amt_1, rip_unit_2, rip_qty_2, rip_amt_2, "
            "rip_unit_3, rip_qty_3, rip_amt_3, rip_unit_4, rip_qty_4, rip_amt_4 "
            f"FROM rip WHERE {' AND '.join(where)} LIMIT 1", params).fetchdf()
    except Exception:
        return None, []
    if df.empty:
        return None, []
    r = df.iloc[0]
    tiers = []
    for j in range(1, 5):
        amt, qty, unit = r.get(f"rip_amt_{j}"), r.get(f"rip_qty_{j}"), r.get(f"rip_unit_{j}")
        try:
            a, q = float(amt), float(qty)
        except (TypeError, ValueError):
            continue
        if a == a and q == q and a > 0 and q > 0:
            tiers.append({"qty": int(q), "unit": (str(unit) if unit and str(unit) != "nan" else "Cases"), "amount": round(a, 2)})
    desc = r.get("rip_description")
    return (str(desc) if desc is not None and str(desc) != "nan" else None), tiers


def _t_rip_lookup(con, args):
    """RIP rebate lookup by brand/product NAME or a RIP code.

    Handles the real-data facts that (a) the SAME UPC can qualify under MULTIPLE
    RIP codes, and (b) different DISTRIBUTORS use different codes — by reading the
    full set of codes per (distributor, UPC) from the RIP sheet, not just the one
    code on the catalog row. Returns matched products (each with all its codes),
    a by-distributor code map, and per-code tiers + description + product count."""
    cym = _current_ym()
    code = str(args.get("rip_code") or "").strip()
    match = (args.get("match") or "").strip()

    def _code_detail(rc, ws=None):
        desc, tiers = _rip_tiers_for(con, rc, ws)
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
        members, member_count = [], 0
        try:
            w2 = ["CAST(rip_code AS VARCHAR) = ?"]
            pr: list = [str(rc)]
            if ws:
                w2.append("wholesaler = ?")
                pr.append(ws)
            df = con.execute(
                f"WITH cur AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched WHERE edition<='{cym}' GROUP BY wholesaler), "
                f"ripupc AS (SELECT DISTINCT wholesaler, LTRIM(CAST(upc AS VARCHAR),'0') un FROM rip "
                f"WHERE {' AND '.join(w2)} AND edition<='{cym}') "
                "SELECT DISTINCT c.product_name, c.unit_volume, c.frontline_case_price, c.effective_case_price "
                "FROM cpl_enriched c JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed "
                "JOIN ripupc r ON r.wholesaler=c.wholesaler AND r.un=LTRIM(CAST(c.upc AS VARCHAR),'0') "
                "ORDER BY c.frontline_case_price NULLS LAST LIMIT 25", pr).fetchdf()
            for _, m in df.iterrows():
                cp = m["frontline_case_price"]
                members.append({"product_name": m["product_name"], "unit_volume": m["unit_volume"],
                                "case_price": float(cp) if cp is not None and cp == cp else None})
            member_count = len(members)
        except Exception:
            pass
        return {"rip_code": rc, "wholesaler": ws, "description": desc, "tiers": tiers,
                "best_rebate": best_amt or None, "member_count": member_count,
                "member_count_note": "25+ (showing first 25)" if member_count == 25 else None,
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
        for i, t in enumerate(t for t in re.split(r"\s+", match) if t):
            params[f"m{i}"] = f"%{t}%"
            where.append(f"(UPPER(c.product_name) LIKE UPPER(${'m'+str(i)}) OR UPPER(COALESCE(c.brand,'')) LIKE UPPER(${'m'+str(i)}))")
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
            rr = con.execute(
                "SELECT DISTINCT wholesaler, LTRIM(CAST(upc AS VARCHAR),'0') AS un, CAST(rip_code AS VARCHAR) AS rip_code "
                f"FROM rip WHERE edition <= '{cym}' "
                "AND CAST(rip_code AS VARCHAR) NOT IN ('', '0', 'None', 'nan') "
                f"AND (wholesaler, LTRIM(CAST(upc AS VARCHAR),'0')) IN ({ph})", kp).fetchdf()
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

    code_details = [_code_detail(c, ws) for c, ws in sorted(all_codes)[:15]]
    note = None
    if not all_codes:
        note = f"Found {len(matched)} product(s) matching '{match}', but none have a RIP rebate this month."
    return {"query": match, "matched_count": len(matched), "matched_products": matched[:25],
            "by_distributor": {k: sorted(v) for k, v in by_dist.items()}, "rip_codes": code_details, "note": note}


_DATA_TOOLS = {
    "category_breakdown": (_t_category_breakdown, "Product counts and average case price per category (current edition)."),
    "rip_lookup": (_t_rip_lookup, "RIP rebate lookup by brand/product NAME (e.g. 'sutter home') or by a RIP code. A UPC can have MULTIPLE codes and codes differ BY DISTRIBUTOR; returns matched products (each with all its codes), a by_distributor code map, and per-code tiers + description + product count. Use for any 'what RIP / rebate / RIP code' question."),
    "compare_distributors": (_t_compare_distributors, "Side-by-side price comparison of ONE product across all distributors carrying it. `match` = UPC or product name (UPC is resolved). Returns each distributor's case/effective price + savings; shown as a table and the rows as add-to-cart cards."),
    "distributor_breakdown": (_t_distributor_breakdown, "Per-distributor product counts, avg case price, and #with RIP/discount."),
    "deal_counts": (_t_deal_counts, "Totals: products, #with RIP, #with discount, #closeouts."),
    "top_products": (_t_top_products, "Resolve matching products. Args: match, category, distributor, has_rip, has_discount, price_min, price_max, order_by(cheapest|expensive), limit."),
    "price_history": (_t_price_history, "Price history across editions for the product matching `match`."),
    "price_details": (_t_price_details, "FULL price breakdown for ONE product (call this for any 'price'/'pricing'/'cost'/'deal' question about a specific product): frontline case & bottle price, discount tiers, RIP tiers, effective price, bottles/case, 3-month history."),
}


# --------------------------- context tools (deals + user data) ---------------
# These take (con, args, ctx); ctx carries user_id for user-specific reads.

def _t_find_deals(con, args, ctx):
    kind = (args.get("kind") or "discount").lower()
    cap = min(int(args.get("limit") or 10), 25)
    cym = _current_ym()
    base = (f"WITH cur AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched "
            f"WHERE edition<='{cym}' GROUP BY wholesaler) "
            "SELECT c.product_name, c.wholesaler, c.upc, c.unit_volume, c.unit_qty, c.vintage, "
            "c.effective_case_price, c.frontline_case_price, c.total_savings_per_case "
            "FROM cpl_enriched c JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed WHERE ")
    if kind in ("clearance", "closeout"):
        cond = "c.has_closeout = true ORDER BY c.total_savings_per_case DESC NULLS LAST"
    elif kind in ("time_sensitive", "time-sensitive", "ending", "expiring"):
        cond = "c.to_date IS NOT NULL AND CAST(c.to_date AS DATE) >= CURRENT_DATE ORDER BY CAST(c.to_date AS DATE) ASC"
    else:
        cond = "c.has_discount = true ORDER BY c.total_savings_per_case DESC NULLS LAST"
    try:
        return con.execute(base + cond + f" LIMIT {cap}").fetchdf().to_dict(orient="records")
    except Exception as e:
        return {"error": f"{type(e).__name__}"}


def _t_price_movers(con, args, ctx):
    direction = (args.get("direction") or "drop").lower()
    trend = "drop" if direction in ("drop", "down", "falling", "decrease") else "increase"
    cap = min(int(args.get("limit") or 10), 25)
    cym = _current_ym()
    try:
        return con.execute(
            f"WITH cur AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched WHERE edition<='{cym}' GROUP BY wholesaler) "
            "SELECT c.product_name, c.wholesaler, c.upc, c.unit_volume, c.unit_qty, c.vintage, "
            "c.effective_case_price, c.frontline_case_price FROM cpl_enriched c "
            "JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed "
            f"WHERE c.price_trend = ? LIMIT {cap}", [trend]).fetchdf().to_dict(orient="records")
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


_CTX_TOOLS = {
    "find_deals": (_t_find_deals, "Promotions: products on deal. Args: kind (time_sensitive|discount|clearance), limit. Shown as cards."),
    "price_movers": (_t_price_movers, "Products whose effective price changes next month. Args: direction (drop|increase), limit. Shown as cards."),
    "get_cart": (_t_get_cart, "The signed-in user's current cart items + quantities."),
    "get_favorites": (_t_get_favorites, "The signed-in user's favorited products."),
    "get_lists": (_t_get_lists, "The signed-in user's saved lists and item counts."),
    "get_orders": (_t_get_orders, "The signed-in user's 10 most recent orders."),
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
    }
    for name, (_fn, desc) in _DATA_TOOLS.items():
        specs.append({"name": name, "description": desc,
                      "input_schema": {"type": "object", "properties": common_props}})
    # Context tools (deals + the signed-in user's cart/favorites/lists/orders).
    ctx_props = {**common_props,
                 "kind": {"type": "string", "enum": ["time_sensitive", "discount", "clearance"]},
                 "direction": {"type": "string", "enum": ["drop", "increase"]}}
    for name, (_fn, desc) in _CTX_TOOLS.items():
        specs.append({"name": name, "description": desc,
                      "input_schema": {"type": "object", "properties": ctx_props}})
    # Action tools
    specs.append({
        "name": "perform_action",
        "description": "Perform a user action: add_to_cart, update_quantity, add_to_favorites, add_to_list. Resolves the product(s) by `match`+`which`.",
        "input_schema": {"type": "object", "properties": {
            "type": {"type": "string", "enum": list(_ACTION_TYPES)},
            "match": {"type": "string"},
            "which": {"type": "string", "enum": ["cheapest", "most_expensive", "first", "all"]},
            "category": {"type": "string"}, "distributor": {"type": "string"},
            "has_rip": {"type": "boolean"}, "has_discount": {"type": "boolean"},
            "cases": {"type": "number"}, "bottles": {"type": "number"},
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
            "q": {"type": "string", "description": "Free-text search (brand/product keywords)."},
            "categories": {"type": "array", "items": {"type": "string"}},
            "distributors": {"type": "array", "items": {"type": "string"}},
            "sizes": {"type": "array", "items": {"type": "string"}},
            "has_rip": {"type": "boolean"}, "has_discount": {"type": "boolean"},
            "price_min": {"type": "number"}, "price_max": {"type": "number"},
            "sort": {"type": "string", "enum": ["product_name", "frontline_case_price", "effective_case_price"]},
            "order": {"type": "string", "enum": ["asc", "desc"]},
            "group_by_rip": {"type": "boolean", "description": "Catalog only: group products into Case-Mix RIP clusters with tier ladders + Add-All-to-Cart. Use for 'show RIP / Case Mix' requests."},
            "window": {"type": "string", "enum": ["partial", "full"], "description": "Time-Sensitive route only: 'partial' = deals that do NOT start on the 1st and end on the last day of the month (true short-window deals); 'full' = full-calendar-month promos."},
            "label": {"type": "string", "description": "Short human label of what's being shown."},
        }, "required": ["route"]},
    })
    return specs


def _do_action(con, args, actions_out) -> dict:
    atype = args.get("type")
    if atype not in _ACTION_TYPES:
        return {"error": "unknown action"}
    which = args.get("which") if args.get("which") in ("cheapest", "most_expensive", "first", "all") else "first"
    cap = 10 if which == "all" else 1
    view = {
        "categories": [args["category"]] if args.get("category") else [],
        "divisions": [args["distributor"]] if args.get("distributor") else [],
        "hasRip": args.get("has_rip"), "hasDiscount": args.get("has_discount"),
    }
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


def _build_screen(args: dict, page_path: str | None = None) -> dict:
    """Turn a show_on_screen tool call into a navigable path (+ catalog filters
    encoded as query params the pages already read) and a short label.

    STRICT no-leave: the docked assistant is scoped to its page and must NEVER
    navigate the user away from it. When we know the current page (page_path is
    set — i.e. the side-panel assistant), we IGNORE the model's chosen route and
    pin the screen to the current page, carrying only the filters that page can
    apply (the catalog takes the full filter set; the other grid pages take the
    free-text ?q, and Time-Sensitive also takes ?window). page_path is only
    omitted on the standalone Celar page, which is a full navigator."""
    from urllib.parse import urlencode
    route = (args.get("route") or "catalog").lower()
    model_base = _SCREEN_ROUTES.get(route, "/catalog")
    base = page_path if (page_path and page_path.startswith("/")) else model_base
    q: dict = {}
    search_terms: list = []
    if args.get("q"):
        search_terms.append(str(args["q"]).strip())
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
    "pricing app. You sit in a side panel; the DATA GRID (the page) is to your left. "
    "SCOPE — strict: you ONLY help with THIS app's wholesale (NJ ABC) pricing data and directly "
    "related buying research — products, case/bottle prices, CPL discounts, RIP rebates, deals, "
    "distributors, price comparisons, price history/trends, and buy decisions based on that data. "
    "You are NOT a general-purpose chatbot. If asked anything outside this scope (general knowledge, "
    "current events, coding, math puzzles, personal/medical/legal advice, other businesses, jokes, "
    "chit-chat) decline in ONE short sentence and steer back, e.g. \"I can only help with your catalog "
    "pricing, deals and RIP rebates — what would you like to look up?\" Do not answer off-topic "
    "questions even if you know the answer, and never invent catalog data. "
    "Your PRIMARY job is to surface value in that grid. DEFAULT TO THE GRID: for ANY request that can be "
    "shown as a filtered/sorted list of products or deals — find, show, list, cheapest, on discount, "
    "with RIP, under $X, by category/distributor/size, ending soon, dropping next month — ALWAYS call "
    "show_on_screen (pick the route + filters) and reply with ONLY a one-line confirmation that ends by "
    "offering more help, e.g. 'Showing wine under $150 with a RIP rebate on the left. Anything else I can "
    "help with?'. Never list those products in chat. The goal on EVERY screen is: show the data on the "
    "main screen first, then ask how else you can help. "
    "CATEGORIES are BROAD product types only: Spirits, Wine, Beer, Cider, Seltzer, RTD, Sparkling, "
    "Vermouth, Malt, Tea, FAB, Non-Alc (and a few more). SUBTYPES like tequila, vodka, bourbon, rum, "
    "gin, scotch, chardonnay, cabernet, prosecco, IPA, lager are NOT categories — never put them in the "
    "categories filter (it returns 0 results). Search them as free text instead: show_on_screen(q='tequila', "
    "sort=effective_case_price, order=asc). The search looks inside the product name AND the enriched "
    "description/category, so the subtype is found even when the name doesn't spell it out. "
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
    "When the user asks to add to cart, set quantity, favorite, or build a list, call perform_action. "
    "For ANY question about a specific product's price/pricing/cost/deal, call price_details and present, "
    "in this order: frontline case price AND per-bottle price (with bottles/case), discount tiers, RIP tiers, "
    "and the effective price — use a compact markdown table for the tiers. State the best_buy_recommendation "
    "verbatim as plain English (buy now vs wait). A price waterfall and a 3-month history chart are attached "
    "automatically, so reference them rather than re-listing the numbers. "
    "A user message that is just a number (6+ digits) is a UPC/barcode. To LOCATE that product, call "
    "show_on_screen with route=catalog and q=<upc>. If it returns found:true, reply exactly like "
    "'Showing the product on screen. Anything else I can help with?'. If it returns found:false, reply "
    "'Product not found. Anything else I can help with?' and do NOT claim you showed anything. "
    "(For price/RIP/comparison details on a UPC, pass it as `match` to price_details / "
    "compare_distributors / rip_lookup instead.) "
    "Confirm what you did in the prose. Be concise and concrete with dollars. "
    "RIP REBATES are the retailer's bread and butter — treat them as a priority. A RIP is a rebate that "
    "qualifies on COMBINED quantity across all products sharing a RIP code ('Case Mix'): buy the tier's "
    "quantity (cases or bottles) mixed across those products and get the bundle $ rebate, which STACKS on "
    "top of any CPL discount. A single UPC can carry MULTIPLE RIP codes, and DIFFERENT DISTRIBUTORS use "
    "DIFFERENT codes. "
    "To EXPLAIN rebates (what codes, tiers, best rebate, which products to mix), call rip_lookup with the "
    "brand/product name (or a code) and answer in chat: group BY DISTRIBUTOR (by_distributor map); for "
    "each code show its tier ladder with per-case savings, mark the BEST rebate, and list the Case Mix "
    "members the buyer can combine; say plainly if there is no RIP this month. "
    "To SHOW the rebate products on the grid so the buyer can ACT, call show_on_screen with route=catalog, "
    "q=<brand>, group_by_rip=true — the catalog then clusters products into Case-Mix groups with tier "
    "ladders, live 'X more for the next tier' progress, and an Add-All-Case-Mix-to-Cart button. "
    "Other tools: compare_distributors (one product across all distributors, by UPC or name — show a "
    "table + a bar chart of effective price by distributor), find_deals (time_sensitive|discount|clearance), "
    "price_movers (drop|increase), and the signed-in user's get_cart / get_favorites / get_lists / get_orders."
)


def _fallback(question: str) -> dict:
    return {
        "answer": ("**Celar AI Assistant is offline.** Set a valid `ANTHROPIC_API_KEY` to enable "
                   "natural-language answers, charts and actions. Your question was logged."),
        "charts": [], "actions": [], "products": [],
        "usage": {"input_tokens": 0, "output_tokens": 0, "model": "offline", "cost_usd": 0.0, "enabled": False},
    }


def ask(question: str, history: list | None = None, user: dict | None = None,
        page: str | None = None, page_path: str | None = None) -> dict:
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

    client = _client_or_none()
    if client is None:
        return _fallback(question)

    ctx = {"user_id": (user or {}).get("id")}

    # Route to the cheapest capable model, and prompt-cache the (large) system +
    # tools block so the agentic loop doesn't re-bill it every turn.
    from backend.model_router import choose_model
    model = choose_model(question)
    tools = _tool_specs()
    if tools:
        tools[-1] = {**tools[-1], "cache_control": {"type": "ephemeral"}}
    # Cache the big static system block; append a small dynamic page hint so the
    # model prioritizes tools relevant to the screen the user is on.
    system_blocks = [{"type": "text", "text": _SYSTEM, "cache_control": {"type": "ephemeral"}}]
    if page:
        scope = _PAGE_SCOPE.get(page)
        if scope:
            system_blocks.append({"type": "text", "text":
                f"SCREEN SCOPE — you are the assistant for the '{page}' screen and are SCOPED TO IT ONLY. "
                f"Help only with: {scope}. Stay on this screen — do NOT navigate away. If this screen "
                f"already shows what they asked, don't call show_on_screen; just answer briefly. If the user "
                f"asks about something that belongs to a DIFFERENT screen (e.g. a general catalog search, "
                f"orders, favorites) say in one line that it's handled on that other screen and offer to "
                f"help within '{page}' instead — do not answer the off-screen request or switch pages. "
                f"(You may still use price_details / rip_lookup / compare_distributors for detail on a "
                f"product shown on THIS screen.)"})
        else:
            system_blocks.append({"type": "text", "text":
                f"The user is on the '{page}' screen. Stay here and keep answers relevant to it; do not "
                f"navigate away unless they explicitly ask."})
    messages = _history_messages(history) + [{"role": "user", "content": question}]
    total_in = total_out = 0
    final_text = ""
    actions_out: list = []
    products_out: list = []
    seen_products: set = set()
    price_detail_result: dict | None = None
    screen_out: dict | None = None

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
                    if b.name == "show_on_screen":
                        si = b.input or {}
                        sc = _build_screen(si, page_path)
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
                    elif b.name in _DATA_TOOLS:
                        try:
                            out = _DATA_TOOLS[b.name][0](con, b.input or {})
                        except Exception as e:
                            out = {"error": f"{type(e).__name__}"}
                        # top_products / price_history surface concrete products.
                        if isinstance(out, list):
                            _collect(out)
                        elif isinstance(out, dict) and out.get("product"):
                            _collect([{**out, "product_name": out.get("product")}])
                        # compare_distributors -> each distributor row as a card.
                        if isinstance(out, dict) and isinstance(out.get("comparison"), list):
                            _collect(out["comparison"])
                        if b.name == "price_details" and isinstance(out, dict) and not out.get("error"):
                            price_detail_result = out
                            _collect([out])   # also show the product as a card
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
    charts = _price_charts(price_detail_result) + charts
    answer = _strip_charts(final_text) or "Done."
    return _json_safe({
        "answer": answer,
        "charts": charts,
        "actions": actions_out,
        "products": products_out[:24],
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
    if len(hist) >= 2:
        out.append({"type": "line", "title": "3-month price history ($/case)",
                    "labels": [str(r.get("edition")) for r in hist],
                    "series": [
                        {"name": "List", "data": [_num(r.get("frontline_case_price")) or 0 for r in hist]},
                        {"name": "Effective", "data": [_num(r.get("effective_case_price")) or 0 for r in hist]},
                    ]})
    return out


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
