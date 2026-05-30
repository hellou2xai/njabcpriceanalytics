"""CELR Catalog MCP server — exposes the pricing catalog as Model Context
Protocol tools so any MCP client (Claude Desktop, the in-app assistant, other
agents) can query and act on the same data through one standard interface.

This is the shared tool layer behind the in-app Celar AI Assistant: the tool
HANDLERS here are the single source of truth; the in-app assistant
(backend/assistant.py) calls the same underlying query helpers, and external
clients reach them over MCP.

Run standalone (stdio transport, e.g. for Claude Desktop):
    python -m backend.mcp_server

Tools
  read:   search_products, product_detail, price_history,
          category_breakdown, distributor_breakdown, deal_summary
  action: add_to_cart, add_to_list, add_to_favorites
          (require user_email; resolve the product, then write to Postgres)
"""
from __future__ import annotations

from typing import Optional

from backend.db import get_duckdb
from backend.ai_catalog_query import _resolve_products, _current_ym
from backend import assistant as _eng

try:
    from mcp.server.fastmcp import FastMCP
except Exception as e:  # pragma: no cover - only when mcp isn't installed
    FastMCP = None
    _IMPORT_ERR = e

mcp = FastMCP("celr-catalog") if FastMCP else None


# --------------------------- read tools ---------------------------

def _search(query: str, category: str, distributor: str, has_rip: bool,
            has_discount: bool, order_by: str, limit: int) -> list:
    view = {
        "categories": [category] if category else [],
        "divisions": [distributor] if distributor else [],
        "hasRip": has_rip or None, "hasDiscount": has_discount or None,
    }
    which = {"cheapest": "cheapest", "expensive": "most_expensive"}.get(order_by, "first")
    with get_duckdb() as con:
        return _resolve_products(con, view, query, which, min(max(int(limit), 1), 50))


def _lookup_user_id(user_email: str) -> Optional[int]:
    from backend.pg import get_pg
    if not user_email:
        return None
    with get_pg() as con:
        row = con.execute("SELECT id FROM users WHERE email = %s", (user_email,)).fetchone()
        return row["id"] if row else None


def _resolve_one(match: str, category: str = "", distributor: str = "", which: str = "first"):
    view = {"categories": [category] if category else [],
            "divisions": [distributor] if distributor else []}
    with get_duckdb() as con:
        prods = _resolve_products(con, view, match, which, 1)
    return prods[0] if prods else None


if mcp:
    @mcp.tool()
    def search_products(query: str = "", category: str = "", distributor: str = "",
                        has_rip: bool = False, has_discount: bool = False,
                        order_by: str = "cheapest", limit: int = 10) -> list:
        """Find catalog products. Filters: query (brand/keywords), category
        (Wine/Spirits/Beer/...), distributor slug, has_rip, has_discount.
        order_by: cheapest|expensive. Returns product rows with prices."""
        return _search(query, category, distributor, has_rip, has_discount, order_by, limit)

    @mcp.tool()
    def product_detail(match: str) -> dict:
        """Full pricing for the product best matching `match`."""
        p = _resolve_one(match)
        return p or {"error": "no product matched"}

    @mcp.tool()
    def price_history(match: str) -> dict:
        """Price history across editions for the product matching `match`."""
        with get_duckdb() as con:
            return _eng._t_price_history(con, {"match": match})

    @mcp.tool()
    def price_details(match: str) -> dict:
        """Full alcohol-retail price breakdown for one product: frontline case &
        bottle price, discount tiers, RIP tiers, effective price, bottles/case,
        3-month history, and a plain-English buy-now-vs-next-month recommendation."""
        with get_duckdb() as con:
            return _eng._t_price_details(con, {"match": match})

    @mcp.tool()
    def category_breakdown() -> list:
        """Product counts and average case price per category (current edition)."""
        with get_duckdb() as con:
            return _eng._t_category_breakdown(con, {})

    @mcp.tool()
    def distributor_breakdown() -> list:
        """Per-distributor product counts, avg case price, #with RIP/discount."""
        with get_duckdb() as con:
            return _eng._t_distributor_breakdown(con, {})

    @mcp.tool()
    def deal_summary() -> dict:
        """Totals: products, #with RIP, #with discount, #closeouts."""
        with get_duckdb() as con:
            return _eng._t_deal_counts(con, {})

    @mcp.tool()
    def compare_distributors(match: str) -> dict:
        """Side-by-side comparison of ONE product across all distributors that
        carry it. `match` may be a UPC or a product name (UPC is resolved)."""
        with get_duckdb() as con:
            return _eng._t_compare_distributors(con, {"match": match})

    @mcp.tool()
    def find_deals(kind: str = "discount", limit: int = 10) -> list:
        """Products on deal. kind: time_sensitive | discount | clearance."""
        with get_duckdb() as con:
            return _eng._t_find_deals(con, {"kind": kind, "limit": limit}, {})

    # --------------------------- action tools ---------------------------

    @mcp.tool()
    def add_to_cart(user_email: str, match: str, cases: int = 1, bottles: int = 0,
                    category: str = "", distributor: str = "") -> dict:
        """Add the product matching `match` to a user's cart (by email)."""
        from backend.pg import get_pg
        uid = _lookup_user_id(user_email)
        if uid is None:
            return {"error": "unknown user_email"}
        p = _resolve_one(match, category, distributor, "cheapest")
        if not p:
            return {"error": "no product matched"}
        with get_pg() as con:
            con.execute(
                """INSERT INTO cart_items (user_id, product_name, wholesaler, upc, unit_volume, qty_cases, qty_units)
                   VALUES (%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (user_id, product_name, wholesaler, unit_volume)
                   DO UPDATE SET qty_cases = EXCLUDED.qty_cases, qty_units = EXCLUDED.qty_units""",
                (uid, p["product_name"], p["wholesaler"], p.get("upc"), p.get("unit_volume"),
                 int(cases), int(bottles)))
        return {"added": p["product_name"], "cases": int(cases), "bottles": int(bottles)}

    @mcp.tool()
    def add_to_favorites(user_email: str, match: str, category: str = "", distributor: str = "") -> dict:
        """Add the matching product to a user's favorites/watchlist."""
        from backend.pg import get_pg
        uid = _lookup_user_id(user_email)
        if uid is None:
            return {"error": "unknown user_email"}
        p = _resolve_one(match, category, distributor)
        if not p:
            return {"error": "no product matched"}
        with get_pg() as con:
            con.execute(
                """INSERT INTO watchlist (user_id, product_name, wholesaler, upc, unit_volume)
                   VALUES (%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                (uid, p["product_name"], p["wholesaler"], p.get("upc"), p.get("unit_volume")))
        return {"favorited": p["product_name"]}

    @mcp.tool()
    def add_to_list(user_email: str, list_name: str, match: str,
                    category: str = "", distributor: str = "") -> dict:
        """Add the matching product to a named list (created if missing)."""
        from backend.pg import get_pg
        uid = _lookup_user_id(user_email)
        if uid is None:
            return {"error": "unknown user_email"}
        p = _resolve_one(match, category, distributor)
        if not p:
            return {"error": "no product matched"}
        with get_pg() as con:
            row = con.execute("SELECT id FROM lists WHERE user_id=%s AND lower(name)=lower(%s)",
                              (uid, list_name)).fetchone()
            list_id = row["id"] if row else con.execute(
                "INSERT INTO lists (user_id, name) VALUES (%s,%s) RETURNING id", (uid, list_name)).fetchone()["id"]
            con.execute(
                """INSERT INTO list_items (list_id, product_name, wholesaler, upc, unit_volume)
                   VALUES (%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                (list_id, p["product_name"], p["wholesaler"], p.get("upc"), p.get("unit_volume")))
        return {"added_to_list": list_name, "product": p["product_name"]}


def main():
    if mcp is None:
        raise SystemExit(f"mcp SDK not available: {_IMPORT_ERR}")
    mcp.run()


if __name__ == "__main__":
    main()
