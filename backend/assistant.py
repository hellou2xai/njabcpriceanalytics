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
from backend import rip_utils as _rip   # canonical case/bottle RIP unit math

_ACTION_TYPES =("add_to_cart", "update_quantity", "add_to_favorites", "add_to_list", "swap_distributor")
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
    """(description, [tiers]) for a RIP code. A code's FULL tier ladder is split
    across MULTIPLE rip rows — each row holds up to 4 tier slots, and a code spans
    several UPCs/rows — so we read ALL rows for the code in its latest edition and
    UNION their tiers. (Reading a single row dropped tiers such as the
    '3 Cases -> $108' rung on Anteel code 100027.) Tiers are deduped by
    (unit, qty, amount) and sorted by rebate amount."""
    cym = _current_ym()
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
            "SELECT rip_description, rip_unit_1, rip_qty_1, rip_amt_1, rip_unit_2, rip_qty_2, rip_amt_2, "
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
        for j in range(1, 5):
            amt, qty, unit = r.get(f"rip_amt_{j}"), r.get(f"rip_qty_{j}"), r.get(f"rip_unit_{j}")
            try:
                a, q = float(amt), float(qty)
            except (TypeError, ValueError):
                continue
            if a != a or q != q or a <= 0 or q <= 0:
                continue
            u = str(unit) if unit and str(unit) != "nan" else "Cases"
            key = (u, int(q), round(a, 2))
            if key in seen:
                continue
            seen.add(key)
            tiers.append({"qty": int(q), "unit": u, "amount": round(a, 2)})
    tiers.sort(key=lambda t: t["amount"])
    return desc, tiers


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
                "WHERE CAST(rip_code AS VARCHAR)=? AND edition<=?) "
                "SELECT ANY_VALUE(c.unit_qty) FROM cpl_enriched c JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed "
                "JOIN ripupc r ON r.wholesaler=c.wholesaler AND r.un=LTRIM(CAST(c.upc AS VARCHAR),'0')",
                [cym, str(code), cym]).fetchone()
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


def _t_analyze_cart(con, args, ctx):
    """Deep analysis of the user's CART, FAVORITES, or a LIST: per item, compare
    its effective case price against every distributor carrying the SAME UPC and
    flag where another distributor is cheaper, with per-case and quantity-weighted
    savings + a total. Grounds 'is anyone cheaper / should I swap distributors'."""
    uid = ctx.get("user_id")
    if not uid:
        return {"error": "user not signed in"}
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
    if not items:
        return {"source": source, "item_count": 0, "note": f"Your {source} is empty."}

    def _norm(u):
        return str(u or "").lstrip("0")
    upcs = sorted({_norm(it["upc"]) for it in items if _norm(it["upc"])})
    pricing, by_upc = {}, {}
    if upcs:
        ph = ", ".join("?" for _ in upcs)
        try:
            df = con.execute(
                "WITH latest AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched GROUP BY wholesaler) "
                "SELECT LTRIM(CAST(c.upc AS VARCHAR),'0') un, c.wholesaler, c.product_name, c.effective_case_price eff "
                "FROM cpl_enriched c JOIN latest l ON c.wholesaler=l.wholesaler AND c.edition=l.ed "
                f"WHERE LTRIM(CAST(c.upc AS VARCHAR),'0') IN ({ph}) AND c.effective_case_price IS NOT NULL", upcs).fetchdf()
            for _, r in df.iterrows():
                un = str(r["un"])
                try:
                    eff = float(r["eff"])
                except (TypeError, ValueError):
                    continue
                if eff != eff:
                    continue
                pricing[(r["wholesaler"], un)] = eff
                by_upc.setdefault(un, []).append((r["wholesaler"], round(eff, 2)))
        except Exception:
            pass

    out_items, total_save, cheaper_count = [], 0.0, 0
    for it in items:
        un = _norm(it["upc"])
        cur_eff = pricing.get((it["wholesaler"], un))
        alts = sorted(by_upc.get(un, []), key=lambda x: x[1])
        qty = (it.get("qty_cases") or 0) or 1
        entry = {"product_name": it.get("product_name"), "current_distributor": it.get("wholesaler"),
                 "current_effective_case": round(cur_eff, 2) if cur_eff is not None else None,
                 "qty_cases": it.get("qty_cases"), "upc": un or None,
                 "also_at": [w for (w, _e) in alts if w != it.get("wholesaler")]}
        if alts and cur_eff is not None and alts[0][1] < cur_eff - 0.01 and alts[0][0] != it.get("wholesaler"):
            save = round(cur_eff - alts[0][1], 2)
            entry.update({"cheaper_distributor": alts[0][0], "cheaper_effective_case": alts[0][1],
                          "savings_per_case": save, "savings_for_qty": round(save * qty, 2)})
            total_save += save * qty
            cheaper_count += 1
        out_items.append(entry)
    return {"source": source, "item_count": len(items),
            "cheaper_elsewhere_count": cheaper_count,
            "total_potential_savings": round(total_save, 2),
            "items": out_items}


def _t_optimize_cart(con, args, ctx):
    """ORDER OPTIMIZER: read the user's cart and produce the cheapest sourcing
    plan — per line find the distributor with the lowest effective case price for
    the same UPC, group the wins into (from -> to) distributor swaps, and total
    current vs optimized cost. Generalistic (price-only) now; POS-ready: the
    scoring will later weight optional velocity / on_hand / shelf_price signals
    that are simply absent today."""
    uid = ctx.get("user_id")
    if not uid:
        return {"error": "user not signed in"}
    from backend.pg import get_pg
    with get_pg() as pg:
        rows = pg.execute(
            "SELECT product_name, wholesaler, upc, unit_volume, qty_cases, qty_units FROM cart_items "
            "WHERE user_id=%s AND COALESCE(saved_for_later,0)=0", (uid,)).fetchall()
    items = [dict(r) for r in rows]
    if not items:
        return {"item_count": 0, "note": "Your cart is empty — nothing to optimize."}

    def _norm(u):
        return str(u or "").lstrip("0")
    upcs = sorted({_norm(it["upc"]) for it in items if _norm(it["upc"])})
    pricing, by_upc = {}, {}
    if upcs:
        ph = ", ".join("?" for _ in upcs)
        try:
            df = con.execute(
                "WITH latest AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched GROUP BY wholesaler) "
                "SELECT LTRIM(CAST(c.upc AS VARCHAR),'0') un, c.wholesaler, c.product_name, c.effective_case_price eff "
                "FROM cpl_enriched c JOIN latest l ON c.wholesaler=l.wholesaler AND c.edition=l.ed "
                f"WHERE LTRIM(CAST(c.upc AS VARCHAR),'0') IN ({ph}) AND c.effective_case_price IS NOT NULL "
                "AND c.effective_case_price > 0", upcs).fetchdf()
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
    return {"item_count": len(items),
            "current_total": round(cur_total, 2), "optimized_total": round(opt_total, 2),
            "total_savings": round(cur_total - opt_total, 2),
            "recommended_swaps": swap_list, "by_item": by_item,
            "note": ("Apply each with perform_action(type=swap_distributor, from_distributor, to_distributor)."
                     if swap_list else "Your cart is already at the cheapest distributor pricing.")}


def _t_cart_timing(con, args, ctx):
    """BUY-NOW-vs-WAIT sweep of the user's cart: per line compare this edition's
    effective case price to next edition's (next_effective_case_price) and flag
    BUY NOW (price rises next month, or the item drops off next month's sheet) vs
    WAIT (price falls next month), with the $ impact for the line's quantity."""
    uid = ctx.get("user_id")
    if not uid:
        return {"error": "user not signed in"}
    from backend.pg import get_pg
    with get_pg() as pg:
        rows = pg.execute(
            "SELECT product_name, wholesaler, upc, qty_cases FROM cart_items "
            "WHERE user_id=%s AND COALESCE(saved_for_later,0)=0", (uid,)).fetchall()
    items = [dict(r) for r in rows]
    if not items:
        return {"item_count": 0, "note": "Your cart is empty."}

    def _norm(u):
        return str(u or "").lstrip("0")

    def _fl(v):
        try:
            x = float(v)
            return None if x != x else x
        except (TypeError, ValueError):
            return None
    info = {}
    upcs = sorted({_norm(it["upc"]) for it in items if _norm(it["upc"])})
    if upcs:
        ph = ", ".join("?" for _ in upcs)
        try:
            df = con.execute(
                "WITH latest AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched GROUP BY wholesaler) "
                "SELECT c.wholesaler, LTRIM(CAST(c.upc AS VARCHAR),'0') un, c.effective_case_price eff, "
                "c.next_effective_case_price nxt "
                "FROM cpl_enriched c JOIN latest l ON c.wholesaler=l.wholesaler AND c.edition=l.ed "
                f"WHERE LTRIM(CAST(c.upc AS VARCHAR),'0') IN ({ph})", upcs).fetchdf()
            for _, r in df.iterrows():
                info[(r["wholesaler"], str(r["un"]))] = (_fl(r["eff"]), _fl(r["nxt"]))
        except Exception:
            pass

    buy_now, wait, stable, bn_total, w_total = [], [], [], 0.0, 0.0
    for it in items:
        cur, nxt = info.get((it["wholesaler"], _norm(it["upc"])), (None, None))
        qty = (it.get("qty_cases") or 0) or 1
        e = {"product_name": it.get("product_name"), "distributor": it.get("wholesaler"), "qty_cases": qty,
             "now_effective": round(cur, 2) if cur is not None else None,
             "next_effective": round(nxt, 2) if nxt is not None else None}
        if cur is None:
            stable.append(e); continue
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
    return {"item_count": len(items),
            "buy_now": sorted(buy_now, key=lambda x: x.get("at_risk_for_qty", 0), reverse=True),
            "wait": sorted(wait, key=lambda x: x.get("save_by_waiting_for_qty", 0), reverse=True),
            "stable_count": len(stable),
            "buy_now_total_at_risk": round(bn_total, 2),
            "wait_total_potential_savings": round(w_total, 2),
            "note": "BUY NOW = rises or vanishes next edition; WAIT = drops next edition."}


def _t_cart_rip_tiers(con, args, ctx):
    """Cart-wide RIP tier maximizer: sum the cart's case (and bottle) quantity per
    RIP code across the Case Mix, find the tier currently reached and the NEXT
    tier, and report how many MORE cases/bottles unlock it and the extra rebate —
    cart-wide 'found money'."""
    uid = ctx.get("user_id")
    if not uid:
        return {"error": "user not signed in"}
    from backend.pg import get_pg
    with get_pg() as pg:
        rows = pg.execute(
            "SELECT product_name, wholesaler, upc, qty_cases, qty_units FROM cart_items "
            "WHERE user_id=%s AND COALESCE(saved_for_later,0)=0", (uid,)).fetchall()
    items = [dict(r) for r in rows]
    if not items:
        return {"item_count": 0, "note": "Your cart is empty."}

    def _norm(u):
        return str(u or "").lstrip("0")
    upcs = sorted({_norm(it["upc"]) for it in items if _norm(it["upc"])})
    meta = {}   # (wholesaler, un) -> (rip_code, pack)
    if upcs:
        ph = ", ".join("?" for _ in upcs)
        try:
            df = con.execute(
                "WITH latest AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched GROUP BY wholesaler) "
                "SELECT c.wholesaler, LTRIM(CAST(c.upc AS VARCHAR),'0') un, CAST(c.rip_code AS VARCHAR) rc, c.unit_qty uq "
                "FROM cpl_enriched c JOIN latest l ON c.wholesaler=l.wholesaler AND c.edition=l.ed "
                f"WHERE LTRIM(CAST(c.upc AS VARCHAR),'0') IN ({ph})", upcs).fetchdf()
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
    actionable = [o for o in out if o["next_tier"]]
    return {"item_count": len(items), "rip_codes_in_cart": len(out),
            "tiers": out,
            "note": (f"{len(actionable)} rebate(s) have a reachable next tier — buy a few more to unlock extra $."
                     if actionable else "No reachable next tier — you're at the top of each rebate you carry.")}


_CTX_TOOLS = {
    "find_deals": (_t_find_deals, "Promotions: products on deal. Args: kind (time_sensitive|discount|clearance), limit. Shown as cards."),
    "price_movers": (_t_price_movers, "Products whose effective price changes next month. Args: direction (drop|increase), limit. Shown as cards."),
    "get_cart": (_t_get_cart, "The signed-in user's current cart items + quantities."),
    "get_favorites": (_t_get_favorites, "The signed-in user's favorited products."),
    "get_lists": (_t_get_lists, "The signed-in user's saved lists and item counts."),
    "get_orders": (_t_get_orders, "The signed-in user's 10 most recent orders."),
    "analyze_cart": (_t_analyze_cart, "DEEP analysis of the user's cart / favorites / a list (source: cart|favorites|list, optional list_name): per item it compares the effective case price to EVERY distributor carrying the same UPC and flags where another is cheaper, with per-case + quantity-weighted savings and a total. Use for 'analyze my cart/wishlist', 'is anyone cheaper', 'where can I save', 'should I swap distributors'. After it, offer to swap via perform_action(type=swap_distributor)."),
    "optimize_cart": (_t_optimize_cart, "ORDER OPTIMIZER for the user's cart: the cheapest sourcing PLAN — per line picks the lowest effective-price distributor for that UPC, groups the wins into (from->to) distributor swaps with $ saved, and gives current vs optimized cart total. Use for 'optimize my cart', 'make my order cheaper', 'cheapest way to buy this'. Present current vs optimized total + the grouped swaps, then offer to apply each via perform_action(type=swap_distributor)."),
    "cart_timing": (_t_cart_timing, "BUY-NOW-vs-WAIT sweep of the whole cart: per line compares this edition's effective price to next edition's and flags BUY NOW (rises or drops off next month) vs WAIT (falls next month), with the $ impact per line and totals. Use for 'should I buy now or wait', 'scan my cart for timing', 'what's going up next month'."),
    "cart_rip_tiers": (_t_cart_rip_tiers, "Cart-wide RIP tier maximizer: sums the cart's case/bottle quantity per RIP code (the Case Mix), shows the tier reached and the NEXT tier, and how many MORE cases/bottles unlock it + the extra rebate. Use for 'am I close to any rebate tiers', 'how do I hit the next RIP tier', 'maximize my rebates'."),
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
                 "direction": {"type": "string", "enum": ["drop", "increase"]}}
    for name, (_fn, desc) in _CTX_TOOLS.items():
        specs.append({"name": name, "description": desc,
                      "input_schema": {"type": "object", "properties": ctx_props}})
    # Action tools
    specs.append({
        "name": "perform_action",
        "description": ("Perform a user action: add_to_cart, update_quantity, add_to_favorites, add_to_list, "
                        "swap_distributor. Resolves the product(s) by `match`+`which`. To add/act on an ENTIRE "
                        "RIP Case Mix (e.g. 'add all the case mix to cart', 'add all these'), pass "
                        "`rip_code`=<the code> (optionally `distributor`) — it resolves EVERY product sharing "
                        "that code. swap_distributor REPLACES the user's cart items from `from_distributor` "
                        "with the SAME products (matched by UPC) at `to_distributor`, preserving quantities — "
                        "pass `rip_code` to limit it to one Case Mix, else it swaps every line from that "
                        "distributor. Use for 'swap/replace/move <X> to <distributor>'."),
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
    w2 = ["CAST(rip_code AS VARCHAR) = ?"]
    pr = [str(code)]
    if ws:
        w2.append("wholesaler = ?")
        pr.append(ws)
    try:
        df = con.execute(
            f"WITH cur AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched WHERE edition<='{cym}' GROUP BY wholesaler), "
            f"ripupc AS (SELECT DISTINCT wholesaler, LTRIM(CAST(upc AS VARCHAR),'0') un FROM rip "
            f"WHERE {' AND '.join(w2)} AND edition<='{cym}') "
            "SELECT DISTINCT c.product_name, c.wholesaler, CAST(c.upc AS VARCHAR) AS upc, c.unit_volume, "
            "c.unit_qty, c.vintage, c.effective_case_price, c.frontline_case_price "
            "FROM cpl_enriched c JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed "
            "JOIN ripupc r ON r.wholesaler=c.wholesaler AND r.un=LTRIM(CAST(c.upc AS VARCHAR),'0') "
            f"WHERE c.product_name IS NOT NULL ORDER BY c.product_name LIMIT {int(limit)}", pr).fetchdf()
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
    "When the user asks to add to cart, set quantity, favorite, or build a list, call perform_action. "
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
    "is no RIP this month. List EVERY tier the tool returns in the ladder table — a code can have many tiers "
    "(e.g. 3/6/12/20/33 cases) and they are split across rows in the data; never truncate to the first or "
    "'best' tier, show the whole ladder in qty order. NEVER reply with only a bare grid link and no tier "
    "breakdown. (HOW you surface it follows your SURFACE rule below: standalone page -> the full analysis in "
    "chat + a grid link; docked beside a grid -> you may ALSO refresh the grid via show_on_screen route=catalog, "
    "q=<brand>, group_by_rip=true, which clusters products into Case-Mix groups with tier ladders, live 'X more "
    "for the next tier' progress, and an Add-All-Case-Mix-to-Cart button.) "
    "Other tools: compare_distributors (one product across all distributors, by UPC or name — show a "
    "table + a bar chart of effective price by distributor), find_deals (time_sensitive|discount|clearance), "
    "price_movers (drop|increase), and the signed-in user's get_cart / get_favorites / get_lists / get_orders. "
    "ORDER OPTIMIZER: for 'optimize my cart', 'make my order cheaper', 'cheapest way to buy this' — call "
    "optimize_cart. Present the CURRENT vs OPTIMIZED cart total and total savings, then the recommended swaps "
    "grouped by (from -> to) distributor with $ saved each, and OFFER to apply them; on yes call "
    "perform_action(type=swap_distributor, from_distributor, to_distributor) per group. "
    "BUY-NOW-vs-WAIT (cart-wide): for 'should I buy now or wait', 'scan my cart for timing', 'what's rising "
    "next month' — call cart_timing. Present a BUY NOW list (lines that rise or drop off next edition, with $ "
    "at risk) and a WAIT list (lines that fall next edition, with $ to save by waiting), plus the totals. "
    "RIP TIER MAXIMIZER (cart-wide): for 'am I close to a rebate tier', 'how do I hit the next RIP tier', "
    "'maximize my rebates' — call cart_rip_tiers. For each RIP code in the cart show cases in cart, the next "
    "tier, how many MORE cases/bottles unlock it, and the extra rebate; lead with the biggest extra-$ wins. "
    "CART / LIST INSIGHTS + DISTRIBUTOR SWAP: for 'analyze my cart / wishlist / list', 'is anyone cheaper', "
    "'where can I save', 'should I switch distributors' — call analyze_cart (source: cart|favorites|list, "
    "optional list_name). Present a per-item table (product, current distributor + effective $/cs, cheaper "
    "distributor + $/cs, $ saved per case and for the quantity) and the TOTAL potential savings, then OFFER to "
    "swap. When the user agrees, or says 'swap/replace/move <X> to <distributor>', call "
    "perform_action(type=swap_distributor, from_distributor=<current>, to_distributor=<target>, "
    "rip_code=<code if it's a Case Mix>) — it replaces those cart lines with the same products (matched by "
    "UPC) at the target distributor, keeping quantities, in one step. Confirm what swapped and flag anything "
    "the target doesn't carry. "
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


def _format_rip_md(rl) -> str:
    """Render a rip_lookup result as a markdown RIP analysis (per distributor +
    code, the FULL tier ladder, best rebate marked, Case Mix members). Used as the
    standalone-page safety net so a rebate question always shows the tier ladder
    even when the model only drove the grid."""
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
            "with the actual DATA inline in the chat — a concise markdown "
            "summary AND, when 3+ products are returned, a short comparison "
            "table (product, distributor, size, vintage, frontline /cs, "
            "effective /cs, savings). Phrase results as 'Found N matches. "
            "Top picks:' or 'Here are the cheapest X:' — NEVER as 'Showing "
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
    screen_out: dict | None = None
    screen_args: dict | None = None   # last show_on_screen filters (for the standalone auto-table)

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
        # RIP NET: a rebate question on the standalone page must show the full tier
        # ladder, not just a link + product card. If the model didn't already put a
        # tier table in its reply, build one deterministically from rip_lookup so
        # the analysis always appears (the model often only drives the grid here).
        ql = question.lower()
        if any(k in ql for k in ("rip", "rebate")):
            has_ladder = ("| buy " in answer.lower()) or ("per unit" in answer.lower()) \
                or ("/cs" in answer.lower() and "tier" in answer.lower())
            if not has_ladder:
                term = (screen_args or {}).get("q") if screen_args else None
                if not term:
                    m = re.search(r"\b(?:for|of|about|on)\s+(.+)$", question, re.I)
                    term = (m.group(1) if m else "").strip()
                    term = re.sub(r"\b(rip|rebate|details?|analysis|code|tiers?)\b", " ", term, flags=re.I).strip()
                if term:
                    try:
                        with get_duckdb() as _con:
                            _rl = _t_rip_lookup(_con, {"match": term})
                        _md = _format_rip_md(_rl)
                        if _md:
                            answer = _md if (not answer or answer == "Done.") else answer.rstrip() + "\n\n" + _md
                    except Exception:
                        pass  # never fail the answer over the RIP net
    # Multi-product answers (3+ products) get enriched with tier ladders so
    # the frontend can render a side-by-side comparison table, and a Catalog
    # deep-link is built by exact UPCs so "Open in Catalog ->" lands on the
    # same set the chat shows. Cap at 12 rows — that's all the table is sized
    # for; the user can hit the Catalog hyperlink for the full set.
    products_final = products_out[:24]
    if len(products_final) >= 3:
        try:
            from backend.ai_catalog_query import _enrich_products_with_tiers
            with get_duckdb() as _con:
                _enrich_products_with_tiers(_con, products_final)
        except Exception:
            pass  # never fail the answer over enrichment
        if screen_out is None:
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
