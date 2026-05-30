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


_DATA_TOOLS = {
    "category_breakdown": (_t_category_breakdown, "Product counts and average case price per category (current edition)."),
    "distributor_breakdown": (_t_distributor_breakdown, "Per-distributor product counts, avg case price, and #with RIP/discount."),
    "deal_counts": (_t_deal_counts, "Totals: products, #with RIP, #with discount, #closeouts."),
    "top_products": (_t_top_products, "Resolve matching products. Args: match, category, distributor, has_rip, has_discount, price_min, price_max, order_by(cheapest|expensive), limit."),
    "price_history": (_t_price_history, "Price history across editions for the product matching `match`."),
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


_SYSTEM = (
    "You are Celar AI Assistant for an independent US liquor store, working inside a wholesale "
    "pricing app. Answer questions about the catalog (pricing, deals, RIP rebates, distributors, "
    "categories) using the data tools — never invent numbers; call tools to get them. Then reply in "
    "clear GitHub-flavored MARKDOWN: short headings, bullet lists, and compact tables where useful. "
    "When a distribution or comparison helps, include ONE chart as a fenced code block exactly like:\n"
    "```chart\n{\"type\":\"bar\",\"title\":\"...\",\"labels\":[...],\"series\":[{\"name\":\"...\",\"data\":[...]}]}\n```\n"
    "type is bar|line|pie; use real numbers from the tools. Keep charts small (<=12 points). "
    "When the user wants to SEE or pick specific products, call top_products — those results are shown "
    "to the user as interactive cards with Add to Cart / Add to List / Favorite buttons, so you don't "
    "need to repeat every product in prose; summarize instead. "
    "When the user asks to add to cart, set quantity, favorite, or build a list, call perform_action. "
    "Confirm what you did in the prose. Be concise and concrete with dollars."
)


def _fallback(question: str) -> dict:
    return {
        "answer": ("**Celar AI Assistant is offline.** Set a valid `ANTHROPIC_API_KEY` to enable "
                   "natural-language answers, charts and actions. Your question was logged."),
        "charts": [], "actions": [], "products": [],
        "usage": {"input_tokens": 0, "output_tokens": 0, "model": "offline", "cost_usd": 0.0, "enabled": False},
    }


def ask(question: str, history: list | None = None) -> dict:
    question = (question or "").strip()
    if not question:
        return {"answer": "Ask me anything about your catalog — pricing, deals, distributors, or say "
                          "‘add 2 cases of the cheapest prosecco to my cart’.",
                "charts": [], "actions": [], "products": [],
                "usage": {"input_tokens": 0, "output_tokens": 0, "model": "none", "cost_usd": 0.0, "enabled": enabled()}}

    client = _client_or_none()
    if client is None:
        return _fallback(question)

    # Route to the cheapest capable model, and prompt-cache the (large) system +
    # tools block so the agentic loop doesn't re-bill it every turn.
    from backend.model_router import choose_model
    model = choose_model(question)
    tools = _tool_specs()
    if tools:
        tools[-1] = {**tools[-1], "cache_control": {"type": "ephemeral"}}
    system_blocks = [{"type": "text", "text": _SYSTEM, "cache_control": {"type": "ephemeral"}}]
    messages = _history_messages(history) + [{"role": "user", "content": question}]
    total_in = total_out = 0
    final_text = ""
    actions_out: list = []
    products_out: list = []
    seen_products: set = set()

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
                    if b.name == "perform_action":
                        out = _do_action(con, b.input or {}, actions_out)
                        # Surface the acted-on products as cards too.
                        if actions_out:
                            _collect(actions_out[-1].get("products"))
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
                    else:
                        out = {"error": "unknown tool"}
                    results.append({"type": "tool_result", "tool_use_id": b.id,
                                    "content": json.dumps(out, default=str)[:6000]})
                messages.append({"role": "user", "content": results})
                continue

            final_text = "".join(getattr(b, "text", "") for b in resp.content if getattr(b, "type", "") == "text")
            break

    charts = _extract_charts(final_text)
    answer = _strip_charts(final_text) or "Done."
    return {
        "answer": answer,
        "charts": charts,
        "actions": actions_out,
        "products": products_out[:24],
        "usage": {"input_tokens": total_in, "output_tokens": total_out,
                  "model": model, "cost_usd": _cost_usd(model, total_in, total_out), "enabled": True},
    }


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
