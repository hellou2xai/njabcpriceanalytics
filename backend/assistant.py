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
# Canonical pricing helpers — every "best deal" / tier / ranking question
# must read from here, not from inline SQL. See backend/FOUNDATION.md.
from backend import pricing as _pricing

_ACTION_TYPES = ("add_to_cart", "update_quantity", "add_to_favorites", "add_to_list")
_MAX_TURNS = 6
# Stocking-deal floor used by the "best deals" ranker by default. A row whose
# effective_case_price is below this fraction of frontline (e.g. a 100%-off
# free-with-purchase rebate at $0/cs) is excluded from the ranking — those
# are real data points but they dominate naive savings-DESC sorts and aren't
# what a buyer means by "best deal in the catalog". Override via the tool
# arg `include_stocking_deals=True` when the user explicitly asks.
_STOCKING_FLOOR_PCT = 0.10


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


def _t_best_one_case_rip(con, args):
    """Best 'buy just ONE case' RIP rebates: rebates whose per-case value buying a
    single case is essentially the same as buying in bulk (e.g. 30 cases), so a
    small buyer isn't penalised. Ranked by the per-case rebate at one case."""
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

    # First pass: keep rows that genuinely qualify as a 1-case rebate, with the
    # computed numbers, so we can rank before doing any (costlier) name lookups.
    cands = []
    for _, row in df.iterrows():
        cts = []   # (qty, amount, per_case) for CASE-unit tiers only
        for j in (1, 2, 3, 4):
            u, q, a = row.get(f"u{j}"), row.get(f"q{j}"), row.get(f"a{j}")
            try:
                q, a = float(q), float(a)
            except (TypeError, ValueError):
                continue
            if q != q or a != a or q <= 0 or a <= 0:
                continue
            if u and "case" in str(u).lower():
                cts.append((q, a, a / q))
        if not cts:
            continue
        ones = [pc for (q, _a, pc) in cts if q <= 1]   # rebate available buying 1 case
        if not ones:
            continue
        rebate_at_1 = max(ones)
        best_pc = max(pc for (_q, _a, pc) in cts)
        # "no significant difference between 1 case and 30 cases" => the single-case
        # per-case rebate is within ~10% of the best per-case rebate at any quantity.
        if best_pc <= 0 or rebate_at_1 < 0.9 * best_pc:
            continue
        cands.append((rebate_at_1, best_pc, row))
    cands.sort(key=lambda c: c[0], reverse=True)

    deals, seen, name_cache, name_lookups = [], set(), {}, 0
    for rebate_at_1, best_pc, row in cands:
        if len(deals) >= cap:
            break
        pname = row.get("product_name")
        upc = row.get("un")
        eff = _num(row.get("effective_case_price"))
        fr = _num(row.get("frontline_case_price"))
        unit_volume = row.get("unit_volume")
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
            if not pname:
                continue
        # Sanity guard: a per-case rebate can't exceed the case price itself — if
        # it does, the rebate row is bad data or mis-joined, so drop it rather
        # than show a nonsensical "$1,000 rebate on an $80 case".
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
    cases the buyer already plans, show the rebate tier ladder, how many MORE
    cases reach each tier, the incremental rebate for stretching, and the next
    tier to aim for."""
    code = str(args.get("rip_code") or "").strip()
    match = (args.get("match") or "").strip()
    try:
        have = float(args.get("have") if args.get("have") is not None else args.get("current_cases") or 0)
    except (TypeError, ValueError):
        have = 0.0
    ws = None
    members = []
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

    case_tiers = sorted(
        [t for t in tiers if "case" in (str(t.get("unit") or "")).lower()],
        key=lambda t: t["qty"])
    ladder, prev_qty, prev_amt, next_tier = [], 0, 0.0, None
    for t in case_tiers:
        q, a = t["qty"], t["amount"]
        need = max(0.0, q - have)
        ladder.append({
            "buy_cases": q, "rebate": round(a, 2), "per_case": round(a / q, 2) if q else None,
            "more_cases_needed": int(need),
            "extra_cases_vs_prev_tier": int(q - prev_qty),
            "extra_rebate_vs_prev_tier": round(a - prev_amt, 2),
        })
        if next_tier is None and have < q:
            next_tier = {"buy_cases": q, "rebate": round(a, 2), "more_cases_needed": int(need)}
        prev_qty, prev_amt = q, a
    if not case_tiers:
        note = "This rebate has no case-based tier (it's bottle-based) — see rip_lookup for the bottle ladder."
    elif next_tier:
        note = (f"With {have:.0f} case(s) planned, buy {next_tier['more_cases_needed']} more "
                f"to unlock the ${next_tier['rebate']:.2f} rebate.")
    else:
        note = f"With {have:.0f} case(s) you're already at the top tier."
    return {"rip_code": code, "wholesaler": ws, "description": desc, "cases_planned": have,
            "tier_ladder": ladder, "next_tier": next_tier,
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


_DATA_TOOLS = {
    "category_breakdown": (_t_category_breakdown, "Product counts and average case price per category (current edition)."),
    "rip_lookup": (_t_rip_lookup, "RIP rebate lookup by brand/product NAME (e.g. 'sutter home') or by a RIP code. A UPC can have MULTIPLE codes and codes differ BY DISTRIBUTOR; returns matched products (each with all its codes), a by_distributor code map, and per-code tiers + description + product count. Use for any 'what RIP / rebate / RIP code' question."),
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
}


# --------------------------- context tools (deals + user data) ---------------
# These take (con, args, ctx); ctx carries user_id for user-specific reads.

def _t_find_deals(con, args, ctx):
    """Deals by kind. Delegates to pricing.rank_best_deals so the ranking
    is the canonical one every surface uses. Stocking-deal floor applies to
    'discount' and 'clearance' kinds (overridable via include_stocking_deals).
    'time_sensitive' doesn't apply the floor because dated promos are
    naturally narrow."""
    kind_raw = (args.get("kind") or "discount").lower()
    limit = int(args.get("limit") or 10)
    include_stocking = bool(args.get("include_stocking_deals"))
    if kind_raw in ("clearance", "closeout"):
        return _pricing.rank_best_deals(
            con, kind="closeout",
            min_effective_pct_of_frontline=None if include_stocking else _STOCKING_FLOOR_PCT,
            limit=limit,
        )
    if kind_raw in ("time_sensitive", "time-sensitive", "ending", "expiring"):
        return _pricing.rank_best_deals(con, kind="time_sensitive", limit=limit)
    # Default: biggest savings.
    return _pricing.rank_best_deals(
        con, kind="savings",
        min_effective_pct_of_frontline=None if include_stocking else _STOCKING_FLOOR_PCT,
        limit=limit,
    )


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
    "To EXPLAIN rebates (what codes, tiers, best rebate, which products to mix), call rip_lookup with the "
    "brand/product name (or a code) and answer in chat: group BY DISTRIBUTOR (by_distributor map); for "
    "each code show its tier ladder with per-case savings, mark the BEST rebate, and list the Case Mix "
    "members the buyer can combine; say plainly if there is no RIP this month. "
    "To SHOW the rebate products on the grid so the buyer can ACT, call show_on_screen with route=catalog, "
    "q=<brand>, group_by_rip=true — the catalog then clusters products into Case-Mix groups with tier "
    "ladders, live 'X more for the next tier' progress, and an Add-All-Case-Mix-to-Cart button. "
    "Other tools: compare_distributors (one product across all distributors, by UPC or name — show a "
    "table + a bar chart of effective price by distributor), find_deals (time_sensitive|discount|clearance), "
    "price_movers (drop|increase), and the signed-in user's get_cart / get_favorites / get_lists / get_orders. "
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
    "items leaving after this edition, ranked by savings — frame as buy-now-before-gone."
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
            "with the actual DATA inline in the chat — a concise markdown "
            "summary AND, when 3+ products are returned, a short comparison "
            "table (product, distributor, size, vintage, frontline /cs, "
            "effective /cs, savings). Phrase results as 'Found N matches. "
            "Top picks:' or 'Here are the cheapest X:' — NEVER as 'Showing "
            "X on [anything]'. Surface the hyperlink as 'Open full list in "
            "Catalog ->' at the end. End with one offer to help further."})
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
                        if b.name in ("price_details", "deal_360") and isinstance(out, dict) and not out.get("error"):
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
