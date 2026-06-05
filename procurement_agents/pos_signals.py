"""POS-signal tools: the store's own sell-through, joined to the live catalog.

These are NEW tools (nothing in backend.assistant reads pos_* tables). Each
fn(args, ctx) needs ctx['store_id']. Every result row carries the catalog
join (cheapest wholesaler + effective case price + bottles/case) so the scout
can reason about buying without a second lookup.
"""

from datetime import date, timedelta

from backend.db import get_duckdb
from backend.pg import get_pg


def _cutoff(days: int) -> str:
    return (date.today() - timedelta(days=days)).isoformat()


def _catalog_join(upcs: list[str]) -> dict[str, dict]:
    """Cheapest current source per UPC from the latest edition."""
    if not upcs:
        return {}
    with get_duckdb() as con:
        ph = ",".join("?" * len(upcs))
        rows = con.execute(f"""
            SELECT upc, ARG_MIN(wholesaler, effective_case_price) wholesaler,
                   MIN(effective_case_price) effective_case_price,
                   ARG_MIN(frontline_case_price, effective_case_price) frontline_case_price,
                   ARG_MIN(unit_qty, effective_case_price) bottles_per_case,
                   BOOL_OR(has_rip) has_rip, BOOL_OR(has_discount) has_discount
            FROM cpl_enriched
            WHERE edition = (SELECT MAX(edition) FROM cpl_enriched) AND upc IN ({ph})
            GROUP BY upc""", upcs).fetchall()
    cols = ["upc", "wholesaler", "effective_case_price", "frontline_case_price",
            "bottles_per_case", "has_rip", "has_discount"]
    return {r[0]: dict(zip(cols, r)) for r in rows}


def _velocity_rows(store_id: int, days: int = 90, category: str | None = None,
                   limit: int = 500) -> list[dict]:
    with get_pg() as pg:
        q = ("SELECT s.upc, MAX(s.product_name) product_name, MAX(s.category) category, "
             "SUM(s.units_sold)::float / %s units_per_day, "
             "MAX(s.unit_retail) unit_retail, MAX(i.on_hand_units) on_hand_units "
             "FROM pos_sales_daily s "
             "LEFT JOIN pos_inventory i ON i.store_id = s.store_id AND i.upc = s.upc "
             "AND i.as_of_date = (SELECT MAX(as_of_date) FROM pos_inventory WHERE store_id = s.store_id) "
             "WHERE s.store_id = %s AND s.business_date >= %s ")
        params = [days, store_id, _cutoff(days)]
        if category:
            q += "AND s.category ILIKE %s "
            params.append(category)
        q += "GROUP BY s.upc ORDER BY units_per_day DESC LIMIT %s"
        params.append(limit)
        rows = [dict(r) for r in pg.execute(q, params).fetchall()]
    for r in rows:
        upd = r["units_per_day"] or 0
        oh = r["on_hand_units"]
        r["units_per_day"] = round(upd, 2)
        r["days_of_cover"] = round(oh / upd, 1) if (oh is not None and upd > 0) else None
    return rows


def pos_velocity(args: dict, ctx: dict):
    rows = _velocity_rows(ctx["store_id"], category=args.get("category"),
                          limit=min(int(args.get("limit") or 40), 200))
    cat = _catalog_join([r["upc"] for r in rows])
    return [{**r, **cat.get(r["upc"], {"wholesaler": None})} for r in rows]


def pos_low_stock(args: dict, ctx: dict):
    threshold = float(args.get("days_threshold") or 14)
    rows = [r for r in _velocity_rows(ctx["store_id"], limit=500)
            if r["days_of_cover"] is not None and r["days_of_cover"] <= threshold]
    rows = rows[: min(int(args.get("limit") or 40), 100)]
    cat = _catalog_join([r["upc"] for r in rows])
    return [{**r, **cat.get(r["upc"], {"wholesaler": None})} for r in rows]


def pos_lapsed(args: dict, ctx: dict):
    days = int(args.get("lapsed_days") or 60)
    with get_pg() as pg:
        rows = [dict(r) for r in pg.execute(
            "WITH hist AS (SELECT upc, MAX(product_name) product_name, "
            "  MAX(category) category, MAX(business_date) last_sale, "
            "  SUM(units_sold) lifetime_units FROM pos_sales_daily "
            "  WHERE store_id=%s GROUP BY upc) "
            "SELECT * FROM hist WHERE last_sale < %s "
            "AND lifetime_units >= 20 ORDER BY lifetime_units DESC LIMIT %s",
            (ctx["store_id"], _cutoff(days), min(int(args.get("limit") or 30), 100))).fetchall()]
    cat = _catalog_join([r["upc"] for r in rows])
    # still_available tells the scout whether a win-back is even buyable now
    return [{**r, "still_available": r["upc"] in cat, **cat.get(r["upc"], {})}
            for r in rows]


SPECS = {
    "pos_velocity": (pos_velocity, {
        "name": "pos_velocity",
        "description": "The store's own POS sell-through (last 90 days): top movers "
                       "with units_per_day, retail price, on-hand units and days_of_cover, "
                       "each joined to the cheapest current wholesale source "
                       "(wholesaler, effective_case_price, bottles_per_case, has_rip). "
                       "Use to ground EVERY quantity decision in actual demand.",
        "input_schema": {"type": "object", "properties": {
            "category": {"type": "string"},
            "limit": {"type": "number", "description": "default 40, max 200"}}},
    }),
    "pos_low_stock": (pos_low_stock, {
        "name": "pos_low_stock",
        "description": "REORDER URGENCY: items selling now with days_of_cover at or "
                       "below the threshold (default 14 days). These run out first; "
                       "they are the strongest candidates. Joined to cheapest source.",
        "input_schema": {"type": "object", "properties": {
            "days_threshold": {"type": "number"},
            "limit": {"type": "number"}}},
    }),
    "pos_lapsed": (pos_lapsed, {
        "name": "pos_lapsed",
        "description": "WIN-BACK from the till: items the store SOLD steadily before "
                       "but not in the last N days (default 60) - delisted or forgotten. "
                       "still_available=false means no current wholesale source exists.",
        "input_schema": {"type": "object", "properties": {
            "lapsed_days": {"type": "number"},
            "limit": {"type": "number"}}},
    }),
}
