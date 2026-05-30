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


_DATA_TOOLS = {
    "category_breakdown": (_t_category_breakdown, "Product counts and average case price per category (current edition)."),
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


def _build_screen(args: dict) -> dict:
    """Turn a show_on_screen tool call into a navigable path (+ catalog filters
    encoded as query params the pages already read) and a short label."""
    from urllib.parse import urlencode
    route = (args.get("route") or "catalog").lower()
    base = _SCREEN_ROUTES.get(route, "/catalog")
    q: dict = {}
    if args.get("q"):
        q["q"] = args["q"]
    if base == "/catalog":
        if isinstance(args.get("categories"), list) and args["categories"]:
            q["categories"] = ",".join(str(c) for c in args["categories"])
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
    path = base + ("?" + urlencode(q) if q else "")
    return {"path": path, "label": (args.get("label") or "your request").strip()}


_SYSTEM = (
    "You are Celar AI Assistant for an independent US liquor store, working inside a wholesale "
    "pricing app. You sit in a side panel; the PAGE is to your left. "
    "DECIDE FIRST: if the user wants to SEE/find/list/filter products or deals that a page can show, call "
    "show_on_screen (pick the route + filters) and reply with ONLY a one-line confirmation like "
    "'Showing wine under $150 with a RIP rebate on the left.' — do NOT list the products in chat. "
    "Use the chat window to ANSWER only things a screen can't show: analysis, comparisons, totals, "
    "explanations, price breakdowns, recommendations. For those, use the data tools — never invent "
    "numbers — and reply in clear GitHub-flavored MARKDOWN: short headings, bullet lists, compact tables. "
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
    "Confirm what you did in the prose. Be concise and concrete with dollars. "
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


def ask(question: str, history: list | None = None, user: dict | None = None, page: str | None = None) -> dict:
    question = (question or "").strip()
    if not question:
        return {"answer": "Ask me anything about your catalog — pricing, deals, distributors, or say "
                          "‘add 2 cases of the cheapest prosecco to my cart’.",
                "charts": [], "actions": [], "products": [],
                "usage": {"input_tokens": 0, "output_tokens": 0, "model": "none", "cost_usd": 0.0, "enabled": enabled()}}

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
        system_blocks.append({"type": "text", "text":
            f"The user is currently on the '{page}' screen — prioritize tools and answers relevant to it."})
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
                        screen_out = _build_screen(b.input or {})
                        out = {"ok": True, "path": screen_out["path"]}
                    elif b.name == "perform_action":
                        out = _do_action(con, b.input or {}, actions_out)
                        # Surface the acted-on products as cards too.
                        if actions_out:
                            _collect(actions_out[-1].get("products"))
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
    return {
        "answer": answer,
        "charts": charts,
        "actions": actions_out,
        "products": products_out[:24],
        "screen": screen_out,
        "usage": {"input_tokens": total_in, "output_tokens": total_out,
                  "model": model, "cost_usd": _cost_usd(model, total_in, total_out), "enabled": True},
    }


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
