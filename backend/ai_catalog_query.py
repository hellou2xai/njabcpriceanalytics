"""AI catalog assistant — natural-language filtering AND actions.

The "Test For Font Catalog" page has a chat panel on the right. A retailer types
(or speaks) a request and Claude does one of two things, via a single tool call:

  1. Filters/sorts the catalog (the SCREEN view): "show me wine under $150 with a
     RIP rebate", "cheapest tequila at Allied".
  2. Performs an ACTION a human would: add to cart, update quantity, add to
     favorites, or add to a list — "add 2 cases of Patron Silver to my cart",
     "save the cheapest cabernet to favorites", "make a list called Holiday Picks
     with 5 sparkling wines".

Token-optimized by design: ONE tool-use round-trip. The model never sees catalog
rows — it returns filter knobs + an action plan with a product `match`, and the
BACKEND resolves the concrete products from DuckDB (real data) so the frontend can
execute deterministically against the cart / watchlist / lists APIs.

Activates when ANTHROPIC_API_KEY is set; otherwise a deterministic keyword
fallback keeps filtering working (no tokens, no cost). Every call reports input/
output tokens, the model, and the USD cost.
"""
from __future__ import annotations

import math
import os
import re
from datetime import date

from backend.db import get_duckdb

_MODEL = os.getenv("CELR_CATALOG_AI_MODEL", os.getenv("CELR_SEARCH_AI_MODEL", "claude-sonnet-4-6"))

# USD per 1,000,000 tokens, matched by substring against the model id.
_PRICING = {"opus": (15.0, 75.0), "sonnet": (3.0, 15.0), "haiku": (1.0, 5.0)}

_ACTION_TYPES = ("add_to_cart", "update_quantity", "add_to_favorites", "add_to_list")


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


def _current_ym() -> str:
    t = date.today()
    return f"{t.year:04d}-{t.month:02d}"


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
        "description": "Filter/sort the wholesale liquor catalog and optionally perform actions (cart, favorites, lists) to fulfil the buyer's request.",
        "input_schema": {
            "type": "object",
            "properties": {
                "answer": {"type": "string", "description": "One or two short sentences confirming what you did. Plain prose, no markdown."},
                "q": {"type": "string", "description": "Free-text search terms: brand or product keywords. Empty string if none."},
                "categories": {"type": "array", "items": {"type": "string", "enum": cats}},
                "distributors": {"type": "array", "items": {"type": "string", "enum": dists}},
                "sizes": {"type": "array", "items": {"type": "string", "enum": sizes}},
                "has_rip": {"type": "boolean"},
                "has_discount": {"type": "boolean"},
                "in_combo": {"type": "boolean"},
                "price_trend": {"type": "string", "enum": ["drop", "increase"]},
                "price_min": {"type": "number"},
                "price_max": {"type": "number"},
                "sort": {"type": "string", "enum": ["product_name", "frontline_case_price", "effective_case_price"]},
                "order": {"type": "string", "enum": ["asc", "desc"]},
                "actions": {
                    "type": "array",
                    "description": "Actions to perform when the buyer asks to DO something (add to cart, set quantity, favorite, add to a list). Leave empty for pure browse/filter requests.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "type": {"type": "string", "enum": list(_ACTION_TYPES)},
                            "match": {"type": "string", "description": "Product brand/keywords identifying which product(s) to act on (e.g. 'patron silver', 'caymus cabernet')."},
                            "which": {"type": "string", "enum": ["cheapest", "most_expensive", "first", "all"], "description": "Which matches to act on. 'all' acts on up to 10 matches. Default 'first'."},
                            "cases": {"type": "number", "description": "Case quantity for add_to_cart / update_quantity."},
                            "bottles": {"type": "number", "description": "Bottle quantity for add_to_cart / update_quantity."},
                            "list_name": {"type": "string", "description": "Target list name for add_to_list (created if missing)."},
                        },
                        "required": ["type"],
                    },
                },
            },
            "required": ["answer"],
        },
    }


_SYSTEM = (
    "You are a buying assistant for an independent US liquor store, embedded in a wholesale "
    "catalog screen. Call set_catalog_view to (a) filter/sort the catalog and (b) perform actions "
    "the buyer asks for. Only use category/distributor/size values from the enums. Put brand/product "
    "keywords in `q` (for the screen) and in each action's `match` (to find the product to act on). "
    "Map: 'add to cart' -> add_to_cart (default 1 case if no qty given); 'set/change quantity' -> "
    "update_quantity; 'favorite'/'save'/'watch' -> add_to_favorites; 'make/add to a list' -> add_to_list "
    "with list_name. For 'cheapest' use which=cheapest; for 'add all ...' use which=all. Always set the "
    "view filters to reflect the products involved so the screen shows them, and write a short concrete "
    "`answer` describing what you did."
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


def _clean(v):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    return v


def _resolve_products(con, view: dict, match: str, which: str, cap: int,
                      exclude_stocking: bool = False) -> list[dict]:
    """Resolve concrete catalog products (current edition per wholesaler) matching
    `match` + the view filters, ordered by `which`. Real-data lookup so the
    frontend can act on exact (wholesaler, upc, unit_volume) rows.

    exclude_stocking: when True, drop $0/near-free 'free-with-purchase' rows
    (effective price below 10% of frontline) so a 100%-off liquidation doesn't
    masquerade as the cheapest product. Single-product lookups leave it False."""
    where = ["1=1"]
    if exclude_stocking:
        where.append("(c.frontline_case_price IS NULL OR c.frontline_case_price <= 0 "
                     "OR c.effective_case_price IS NULL "
                     "OR c.effective_case_price >= c.frontline_case_price * 0.10)")
    params = {"cym": _current_ym()}
    # A mostly-numeric match of 6+ digits is a UPC/barcode, not a name — match it
    # against the upc column (leading zeros normalised) instead of the name, so
    # "812147022384" resolves the product. Otherwise AND the name/brand tokens.
    _compact = re.sub(r"[\s\-]", "", (match or ""))
    if _compact.isdigit() and len(_compact) >= 6:
        params["upc_n"] = _compact.lstrip("0") or _compact
        params["upc_raw"] = f"%{_compact}%"
        where.append("(LTRIM(CAST(c.upc AS VARCHAR), '0') = $upc_n OR CAST(c.upc AS VARCHAR) LIKE $upc_raw)")
    else:
        for i, t in enumerate(t for t in re.split(r"\s+", (match or "").strip()) if t):
            params[f"m{i}"] = f"%{t}%"
            where.append(f"(UPPER(c.product_name) LIKE UPPER(${'m'+str(i)}) OR UPPER(COALESCE(c.brand,'')) LIKE UPPER(${'m'+str(i)}))")
    for i, cat in enumerate(view.get("categories") or []):
        params[f"cat{i}"] = cat
    if view.get("categories"):
        where.append("c.product_type IN (" + ", ".join(f"$cat{i}" for i in range(len(view['categories']))) + ")")
    for i, d in enumerate(view.get("divisions") or []):
        params[f"d{i}"] = d
    if view.get("divisions"):
        where.append("c.wholesaler IN (" + ", ".join(f"$d{i}" for i in range(len(view['divisions']))) + ")")
    if view.get("priceMin") is not None:
        params["pmin"] = view["priceMin"]; where.append("c.frontline_case_price >= $pmin")
    if view.get("priceMax") is not None:
        params["pmax"] = view["priceMax"]; where.append("c.frontline_case_price <= $pmax")
    if view.get("hasRip"):
        where.append("c.has_rip = true")
    if view.get("hasDiscount"):
        where.append("c.has_discount = true")
    order = {
        "cheapest": "c.effective_case_price ASC NULLS LAST",
        "most_expensive": "c.effective_case_price DESC NULLS LAST",
        "first": "c.product_name ASC",
    }.get(which, "c.product_name ASC")
    sql = f"""
        WITH cur AS (
          SELECT wholesaler, COALESCE(MAX(CASE WHEN edition <= $cym THEN edition END), MAX(edition)) AS ed
          FROM cpl_enriched GROUP BY wholesaler
        )
        SELECT c.product_name, c.wholesaler, c.upc, c.unit_volume, c.unit_qty, c.vintage,
               c.effective_case_price, c.frontline_case_price
        FROM cpl_enriched c JOIN cur ON c.wholesaler = cur.wholesaler AND c.edition = cur.ed
        WHERE {' AND '.join(where)}
        ORDER BY {order}
        LIMIT {int(cap)}
    """
    try:
        rows = con.execute(sql, params).fetchdf()
    except Exception:
        return []
    out = []
    for _, r in rows.iterrows():
        out.append({
            "product_name": _clean(r["product_name"]),
            "wholesaler": _clean(r["wholesaler"]),
            "upc": None if _clean(r["upc"]) is None else str(r["upc"]),
            "unit_volume": _clean(r["unit_volume"]),
            "unit_qty": None if _clean(r["unit_qty"]) is None else str(r["unit_qty"]),
            "vintage": None if _clean(r["vintage"]) is None else str(r["vintage"]),
            "effective_case_price": (float(r["effective_case_price"])
                                     if _clean(r["effective_case_price"]) is not None else None),
            "frontline_case_price": (float(r["frontline_case_price"])
                                     if _clean(r["frontline_case_price"]) is not None else None),
        })
    return out


def _enrich_products_with_tiers(con, products: list[dict]) -> None:
    """Attach CPL discount + RIP tier ladders to resolved products in place.

    The slim shape returned by `_resolve_products` is enough to render cards
    but the comparison-table view (3+ products) wants the full decision pack:
    every discount tier and every RIP tier per row. This re-fetches the
    matching `cpl_enriched` rows (one query, bulk) and runs the canonical
    `pricing.attach_tiers` helper so the math is identical to the modal.

    Adds `tiers` (combined, sorted), `discount_tiers`, `rip_tiers` and
    `edition` to each product dict. Quietly no-ops on empty input or query
    failure — the chat never breaks if enrichment fails."""
    if not products:
        return
    from backend import pricing
    # Pull the full row for each (wholesaler, upc, unit_volume, vintage, unit_qty)
    # tuple. We use the current edition per wholesaler so the tiers we attach
    # are the ones the user actually sees on the page.
    cym = _current_ym()
    ws_set = sorted({p.get("wholesaler") for p in products if p.get("wholesaler")})
    upc_set = sorted({str(p.get("upc") or "") for p in products if p.get("upc")})
    if not ws_set or not upc_set:
        return
    ws_ph = ", ".join(f"$ws_{i}" for i in range(len(ws_set)))
    upc_ph = ", ".join(f"$u_{i}" for i in range(len(upc_set)))
    params = {"cym": cym}
    for i, v in enumerate(ws_set):
        params[f"ws_{i}"] = v
    for i, v in enumerate(upc_set):
        params[f"u_{i}"] = v
    try:
        rows = con.execute(f"""
            WITH cur AS (
              SELECT wholesaler, COALESCE(MAX(CASE WHEN edition <= $cym THEN edition END),
                                          MAX(edition)) AS ed
              FROM cpl_enriched GROUP BY wholesaler
            )
            SELECT c.* FROM cpl_enriched c
            JOIN cur ON c.wholesaler = cur.wholesaler AND c.edition = cur.ed
            WHERE c.wholesaler IN ({ws_ph})
              AND c.upc IN ({upc_ph})
        """, params).fetchdf().to_dict(orient="records")
    except Exception:
        return
    # Index by (wholesaler, upc, unit_volume, unit_qty) for stable matching;
    # fall back to (wholesaler, upc, unit_volume) when unit_qty isn't in
    # the resolved dict.
    idx_full: dict = {}
    idx_vol: dict = {}
    idx_upc: dict = {}
    for r in rows:
        ws = r.get("wholesaler"); upc = str(r.get("upc") or "")
        vol = r.get("unit_volume") or ""; uq = str(r.get("unit_qty") or "")
        idx_full[(ws, upc, vol, uq)] = r
        idx_vol.setdefault((ws, upc, vol), r)
        idx_upc.setdefault((ws, upc), r)
    # Attach tiers on the row dicts first (one batched call), then copy the
    # tier arrays back onto the slim product dicts.
    pricing.attach_tiers(con, rows)
    for p in products:
        ws = p.get("wholesaler"); upc = str(p.get("upc") or "")
        vol = p.get("unit_volume") or ""; uq = str(p.get("unit_qty") or "")
        match = (idx_full.get((ws, upc, vol, uq))
                 or idx_vol.get((ws, upc, vol))
                 or idx_upc.get((ws, upc)))
        if not match:
            p.setdefault("tiers", [])
            p.setdefault("discount_tiers", [])
            p.setdefault("rip_tiers", [])
            continue
        tiers = match.get("tiers") or []
        p["tiers"] = tiers
        p["discount_tiers"] = [t for t in tiers if t.get("source") == "discount"]
        p["rip_tiers"] = [t for t in tiers if t.get("source") == "rip"]
        p["edition"] = match.get("edition")


def _resolve_actions(raw_actions: list, view: dict, default_match: str) -> list[dict]:
    if not raw_actions:
        return []
    out: list[dict] = []
    with get_duckdb() as con:
        for a in raw_actions[:8]:
            atype = a.get("type")
            if atype not in _ACTION_TYPES:
                continue
            which = a.get("which") if a.get("which") in ("cheapest", "most_expensive", "first", "all") else "first"
            cap = 10 if which == "all" else 1
            match = (a.get("match") or default_match or "").strip()
            prods = _resolve_products(con, view, match, which, cap)
            cases = int(a["cases"]) if isinstance(a.get("cases"), (int, float)) else 0
            bottles = int(a["bottles"]) if isinstance(a.get("bottles"), (int, float)) else 0
            if atype in ("add_to_cart", "update_quantity") and cases == 0 and bottles == 0:
                cases = 1  # sensible default when the buyer didn't say a number
            out.append({
                "type": atype,
                "cases": cases,
                "bottles": bottles,
                "list_name": (str(a.get("list_name")).strip() or None) if a.get("list_name") else None,
                "products": prods,
                "note": None if prods else "No matching product found in the current catalog.",
            })
    return out


def _fallback(question: str) -> dict:
    """Deterministic keyword mapping when the AI is unavailable. No tokens.
    Actions need real understanding, so the fallback only filters (no actions)."""
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
    q_terms = re.sub(r"[^a-z0-9 ]", " ", ql)
    stop = set("show me the all with under over less than more for at on in of to and a an "
               "products product catalog cheapest cheap discount discounts deal deals sale "
               "rip rebate combo bundle next month price prices drop increase add cart favorite "
               "favorites list".split())
    q = " ".join(w for w in q_terms.split() if w not in stop and not w.isdigit())
    return {"answer": "AI is offline, so I matched your question with keyword rules (filtering only — "
                      "actions like add-to-cart need the AI). Set ANTHROPIC_API_KEY for full features.",
            "q": q.strip(), "filters": f, "sort": sort, "order": order, "actions": [],
            "usage": {"input_tokens": 0, "output_tokens": 0, "model": "keyword-fallback",
                      "cost_usd": 0.0, "enabled": False}}


def _history_messages(history: list | None) -> list:
    """Sanitise prior turns into Claude message dicts for multi-turn memory.
    Accepts [{role:'user'|'assistant', content:str}, ...]; keeps the last ~10."""
    out: list = []
    for h in (history or [])[-6:]:
        role = h.get("role") if isinstance(h, dict) else None
        content = h.get("content") if isinstance(h, dict) else None
        if role in ("user", "assistant") and isinstance(content, str) and content.strip():
            out.append({"role": role, "content": content.strip()[:4000]})
    return out


def answer_question(question: str, history: list | None = None) -> dict:
    """Map a NL question to catalog filters + actions + a short answer + usage.
    `history` carries prior turns so the assistant remembers the conversation."""
    question = (question or "").strip()
    if not question:
        return {"answer": "Ask me what you're looking for — e.g. 'add 2 cases of the cheapest tequila to my cart'.",
                "q": "", "filters": _empty_filters(), "sort": "product_name", "order": "asc", "actions": [],
                "usage": {"input_tokens": 0, "output_tokens": 0, "model": "none", "cost_usd": 0.0, "enabled": enabled()}}

    client = _client_or_none()
    if client is None:
        return _fallback(question)

    dists, cats, sizes = _facets()
    # Catalog filter extraction is a simple single-tool task -> always Haiku
    # (cheapest). Prompt-cache the system + tool so the repeated boilerplate
    # isn't re-billed at full rate on every question.
    from backend.model_router import HAIKU
    model = HAIKU
    tool = _tool(dists, cats, sizes)
    tool["cache_control"] = {"type": "ephemeral"}
    try:
        msg = client.messages.create(
            model=model,
            max_tokens=700,
            system=[{"type": "text", "text": _SYSTEM, "cache_control": {"type": "ephemeral"}}],
            tools=[tool],
            tool_choice={"type": "tool", "name": "set_catalog_view"},
            messages=_history_messages(history) + [{"role": "user", "content": question}],
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

    filters = _to_filters(args)
    actions = _resolve_actions(args.get("actions") or [], filters, str(args.get("q") or ""))

    in_tok = getattr(msg.usage, "input_tokens", 0) or 0
    out_tok = getattr(msg.usage, "output_tokens", 0) or 0
    return {
        "answer": str(args.get("answer") or "Updated the catalog to match your question.").strip(),
        "q": str(args.get("q") or "").strip(),
        "filters": filters,
        "sort": args.get("sort") if args.get("sort") in ("product_name", "frontline_case_price", "effective_case_price") else "product_name",
        "order": args.get("order") if args.get("order") in ("asc", "desc") else "asc",
        "actions": actions,
        "usage": {
            "input_tokens": in_tok,
            "output_tokens": out_tok,
            "model": model,
            "cost_usd": _cost_usd(model, in_tok, out_tok),
            "enabled": True,
        },
    }
