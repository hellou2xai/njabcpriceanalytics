"""AI catalog assistant — turn a natural-language question into catalog filters.

The "Test For Font Catalog" page has a chat panel on the right. A retailer types a
question ("show me wine under $150 with a RIP rebate", "cheapest tequila at Allied",
"what's dropping in price next month") and Claude maps it to the SAME knobs the
catalog already supports (free-text query, category, distributor, size, price
range, has-RIP / has-discount / in-combo flags, price trend, sort). The page then
re-runs its normal search with those filters, so the screen output depends on the
answer.

Real data only: the valid distributor slugs and product categories are read from
the live cache so the model can only pick values that exist. Tokens + dollar cost
of every call are returned so the UI can show what each answer cost.

Activates when ANTHROPIC_API_KEY is set; otherwise a deterministic keyword
fallback keeps the feature working (no tokens, no cost).
"""
from __future__ import annotations

import os
import re

from backend.db import get_duckdb

_MODEL = os.getenv("CELR_CATALOG_AI_MODEL", os.getenv("CELR_SEARCH_AI_MODEL", "claude-sonnet-4-6"))

# USD per 1,000,000 tokens. Matched by substring against the model id; falls back
# to Sonnet pricing for anything unrecognised so cost is never reported as $0
# for a real call.
_PRICING = {
    "opus":   (15.0, 75.0),
    "sonnet": (3.0, 15.0),
    "haiku":  (1.0, 5.0),
}


def _price_for(model: str) -> tuple[float, float]:
    m = (model or "").lower()
    for key, rates in _PRICING.items():
        if key in m:
            return rates
    return _PRICING["sonnet"]


def _cost_usd(model: str, input_tokens: int, output_tokens: int) -> float:
    in_rate, out_rate = _price_for(model)
    return round(input_tokens / 1_000_000 * in_rate + output_tokens / 1_000_000 * out_rate, 6)


def _client_or_none():
    if not os.getenv("ANTHROPIC_API_KEY"):
        return None
    try:
        import anthropic
        return anthropic.Anthropic()
    except Exception:
        return None


def enabled() -> bool:
    return _client_or_none() is not None


def _facets() -> tuple[list[str], list[str], list[str]]:
    """(distributor slugs, product categories, top sizes) from the live cache."""
    try:
        with get_duckdb() as con:
            dists = [r[0] for r in con.execute(
                "SELECT DISTINCT wholesaler FROM cpl_enriched WHERE wholesaler IS NOT NULL ORDER BY 1"
            ).fetchall()]
            cats = [r[0] for r in con.execute(
                "SELECT product_type FROM cpl_enriched WHERE product_type IS NOT NULL "
                "GROUP BY product_type ORDER BY COUNT(*) DESC LIMIT 20"
            ).fetchall()]
            sizes = [r[0] for r in con.execute(
                "SELECT unit_volume FROM cpl_enriched WHERE unit_volume IS NOT NULL "
                "GROUP BY unit_volume ORDER BY COUNT(*) DESC LIMIT 25"
            ).fetchall()]
        return dists, cats, sizes
    except Exception:
        return (["allied", "fedway", "opici", "high_grade", "peerless"],
                ["Wine", "Spirits", "Beer", "RTD", "Sparkling", "Cider"], ["750ML", "1L", "1.75L"])


def _empty_filters() -> dict:
    return {
        "hasRip": None, "hasDiscount": None, "inCombo": False,
        "priceTrend": None, "divisions": [], "categories": [],
        "brands": [], "sizes": [], "priceMin": None, "priceMax": None,
    }


def _tool(dists: list[str], cats: list[str], sizes: list[str]) -> dict:
    return {
        "name": "set_catalog_view",
        "description": "Filter and sort the wholesale liquor catalog to answer the user's question.",
        "input_schema": {
            "type": "object",
            "properties": {
                "answer": {"type": "string", "description": "One or two short sentences telling the buyer what the catalog is now showing and why. Plain prose, no markdown."},
                "q": {"type": "string", "description": "Free-text search terms: brand or product keywords (e.g. 'tequila anejo', 'caymus'). Empty string if none."},
                "categories": {"type": "array", "items": {"type": "string", "enum": cats}, "description": "Product categories to include."},
                "distributors": {"type": "array", "items": {"type": "string", "enum": dists}, "description": "Distributor slugs to include."},
                "sizes": {"type": "array", "items": {"type": "string", "enum": sizes}, "description": "Bottle sizes to include."},
                "has_rip": {"type": "boolean", "description": "True to show only products with a RIP rebate."},
                "has_discount": {"type": "boolean", "description": "True to show only products with a case discount."},
                "in_combo": {"type": "boolean", "description": "True to show only products in a combo/bundle."},
                "price_trend": {"type": "string", "enum": ["drop", "increase"], "description": "'drop' = effective price falls next month; 'increase' = rises next month."},
                "price_min": {"type": "number", "description": "Minimum frontline case price in dollars."},
                "price_max": {"type": "number", "description": "Maximum frontline case price in dollars."},
                "sort": {"type": "string", "enum": ["product_name", "frontline_case_price", "effective_case_price"]},
                "order": {"type": "string", "enum": ["asc", "desc"], "description": "Use 'asc' with effective_case_price for 'cheapest', 'desc' for 'most expensive' or 'biggest'."},
            },
            "required": ["answer"],
        },
    }


_SYSTEM = (
    "You are a buying assistant for an independent US liquor store, embedded in a wholesale "
    "catalog screen. Translate the buyer's question into catalog filters by calling the "
    "set_catalog_view tool. Only use category/distributor/size values from the provided enums. "
    "Put brand names or product keywords in `q`. For 'cheapest' sort by effective_case_price asc; "
    "for 'best deal' / 'biggest discount' prefer has_discount or has_rip and sort effective_case_price asc. "
    "Map 'on sale'/'discount' to has_discount, 'rebate'/'RIP' to has_rip, 'bundle'/'combo' to in_combo, "
    "'cheaper next month' to price_trend drop, 'going up' to price_trend increase. Always fill `answer` "
    "with a short, concrete sentence describing what the screen now shows. If the question is vague, make a "
    "reasonable choice and say so in `answer`."
)


def _to_filters(args: dict) -> dict:
    f = _empty_filters()
    if isinstance(args.get("categories"), list):
        f["categories"] = [str(c) for c in args["categories"]]
    if isinstance(args.get("distributors"), list):
        f["divisions"] = [str(d) for d in args["distributors"]]
    if isinstance(args.get("sizes"), list):
        f["sizes"] = [str(s) for s in args["sizes"]]
    if isinstance(args.get("has_rip"), bool):
        f["hasRip"] = args["has_rip"]
    if isinstance(args.get("has_discount"), bool):
        f["hasDiscount"] = args["has_discount"]
    if args.get("in_combo") is True:
        f["inCombo"] = True
    if args.get("price_trend") in ("drop", "increase"):
        f["priceTrend"] = args["price_trend"]
    if isinstance(args.get("price_min"), (int, float)):
        f["priceMin"] = float(args["price_min"])
    if isinstance(args.get("price_max"), (int, float)):
        f["priceMax"] = float(args["price_max"])
    return f


def _fallback(question: str) -> dict:
    """Deterministic keyword mapping used when the AI is unavailable. No tokens."""
    ql = (question or "").lower()
    f = _empty_filters()
    sort, order = "product_name", "asc"
    if "rip" in ql or "rebate" in ql:
        f["hasRip"] = True
    if "discount" in ql or "on sale" in ql or "sale" in ql or "deal" in ql:
        f["hasDiscount"] = True
    if "combo" in ql or "bundle" in ql:
        f["inCombo"] = True
    if "drop" in ql or "cheaper next" in ql or "falling" in ql:
        f["priceTrend"] = "drop"
    elif "increase" in ql or "going up" in ql or "rising" in ql:
        f["priceTrend"] = "increase"
    cat_map = {"wine": "Wine", "spirit": "Spirits", "whiskey": "Spirits", "whisky": "Spirits",
               "tequila": "Spirits", "vodka": "Spirits", "beer": "Beer", "seltzer": "RTD",
               "sparkling": "Sparkling", "champagne": "Sparkling", "cider": "Cider"}
    for kw, cat in cat_map.items():
        if kw in ql and cat not in f["categories"]:
            f["categories"].append(cat)
    for slug in ("allied", "fedway", "opici", "peerless"):
        if slug in ql:
            f["divisions"].append(slug)
    if "high grade" in ql or "high_grade" in ql or "highgrade" in ql:
        f["divisions"].append("high_grade")
    m = re.search(r"under \$?(\d+(?:\.\d+)?)", ql) or re.search(r"less than \$?(\d+(?:\.\d+)?)", ql)
    if m:
        f["priceMax"] = float(m.group(1))
    m2 = re.search(r"over \$?(\d+(?:\.\d+)?)", ql) or re.search(r"above \$?(\d+(?:\.\d+)?)", ql)
    if m2:
        f["priceMin"] = float(m2.group(1))
    if "cheap" in ql or "lowest" in ql or "least expensive" in ql:
        sort, order = "effective_case_price", "asc"
    elif "expensive" in ql or "highest" in ql or "premium" in ql:
        sort, order = "effective_case_price", "desc"
    # Leftover words become the free-text query (strip the structured keywords).
    q_terms = re.sub(r"[^a-z0-9 ]", " ", ql)
    stop = set("show me the all with under over less than more for at on in of to and a an "
               "products product catalog cheapest cheap discount discounts deal deals sale "
               "rip rebate combo bundle next month price prices drop increase".split())
    q = " ".join(w for w in q_terms.split() if w not in stop and not w.isdigit())
    answer = "AI is offline, so I matched your question with keyword rules. " \
             "Set ANTHROPIC_API_KEY for full natural-language understanding."
    return {"answer": answer, "q": q.strip(), "filters": f, "sort": sort, "order": order,
            "usage": {"input_tokens": 0, "output_tokens": 0, "model": "keyword-fallback",
                      "cost_usd": 0.0, "enabled": False}}


def answer_question(question: str) -> dict:
    """Map a NL question to catalog filters + a short answer + token/cost usage."""
    question = (question or "").strip()
    if not question:
        return {"answer": "Ask me what you're looking for — e.g. 'wine under $150 with a RIP rebate'.",
                "q": "", "filters": _empty_filters(), "sort": "product_name", "order": "asc",
                "usage": {"input_tokens": 0, "output_tokens": 0, "model": "none", "cost_usd": 0.0, "enabled": enabled()}}

    client = _client_or_none()
    if client is None:
        return _fallback(question)

    dists, cats, sizes = _facets()
    tool = _tool(dists, cats, sizes)
    try:
        msg = client.messages.create(
            model=_MODEL,
            max_tokens=600,
            system=_SYSTEM,
            tools=[tool],
            tool_choice={"type": "tool", "name": "set_catalog_view"},
            messages=[{"role": "user", "content": question}],
        )
    except Exception as e:
        out = _fallback(question)
        out["answer"] = f"AI call failed ({type(e).__name__}); used keyword matching instead. " + out["answer"]
        return out

    args = {}
    for block in msg.content or []:
        if getattr(block, "type", None) == "tool_use" and getattr(block, "name", "") == "set_catalog_view":
            args = block.input or {}
            break

    in_tok = getattr(msg.usage, "input_tokens", 0) or 0
    out_tok = getattr(msg.usage, "output_tokens", 0) or 0
    return {
        "answer": str(args.get("answer") or "Updated the catalog to match your question.").strip(),
        "q": str(args.get("q") or "").strip(),
        "filters": _to_filters(args),
        "sort": args.get("sort") if args.get("sort") in ("product_name", "frontline_case_price", "effective_case_price") else "product_name",
        "order": args.get("order") if args.get("order") in ("asc", "desc") else "asc",
        "usage": {
            "input_tokens": in_tok,
            "output_tokens": out_tok,
            "model": _MODEL,
            "cost_usd": _cost_usd(_MODEL, in_tok, out_tok),
            "enabled": True,
        },
    }
