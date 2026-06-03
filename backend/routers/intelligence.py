"""
Decision Intelligence API â€” buy signals, buy sheet, missed opportunities, order scorecard.

Covers: Â§4.2 Buy Intelligence, Â§9 Decision Intelligence, Â§10 Alerts
"""

import os
import json
from fastapi import APIRouter, Query, Depends
from typing import Optional

from backend.db import get_duckdb, read_parquet
from backend.pg import get_pg
from backend.auth import get_current_user
from backend.enrichment_join import attach_enrichment_image

router = APIRouter(prefix="/api/intelligence", tags=["intelligence"])


@router.get("/buy-signals")
def get_buy_signals(
    wholesaler: Optional[str] = None,
    edition: Optional[str] = None,
    limit: int = Query(50, ge=1, le=50000),
):
    """
    Buy signals per product â€” Â§4.2, Â§9.1

    Logic:
      LAST_CHANCE â€” has closeout permit
      STRONG_BUY  â€” at period low AND has discount
      BUY_NOW     â€” new discount this edition OR price dropped >5%
      GOOD_BUY    â€” has discount, stable or small drop
      HOLD        â€” stable price, no discount
      DEFER       â€” price rising OR at period high
    """
    with get_duckdb() as con:
        enriched = read_parquet(con, "cpl_enriched")
        changes = read_parquet(con, "price_changes")
        lifecycle = read_parquet(con, "item_lifecycle")

        where = ["1=1"]
        params = {}
        if wholesaler:
            where.append("e.wholesaler = $wholesaler")
            params["wholesaler"] = wholesaler
        if edition:
            where.append("e.edition = $edition")
            params["edition"] = edition
        else:
            where.append(f"e.edition = (SELECT MAX(edition) FROM {enriched}" +
                        (f" WHERE wholesaler = $wholesaler" if wholesaler else "") + ")")

        w = " AND ".join(where)

        df = con.execute(f"""
            SELECT
                e.wholesaler,
                e.edition,
                e.upc,
                e.product_name,
                e.product_type,
                e.unit_volume,
                e.frontline_case_price,
                e.best_case_price,
                e.effective_case_price,
                e.discount_pct,
                e.total_savings_per_case,
                e.has_discount,
                e.has_rip,
                e.has_closeout,
                p.case_delta_pct,
                p.direction,
                p.prev_case_price,
                CASE
                    WHEN e.has_closeout THEN 'LAST_CHANCE'
                    WHEN e.has_discount AND p.direction = 'down' AND p.case_delta_pct <= -5
                        THEN 'STRONG_BUY'
                    WHEN p.direction = 'down' AND p.case_delta_pct <= -5
                        THEN 'BUY_NOW'
                    WHEN e.has_discount AND (p.direction = 'down' OR p.direction = 'stable')
                        THEN 'GOOD_BUY'
                    WHEN p.direction = 'up' AND p.case_delta_pct >= 5
                        THEN 'DEFER'
                    ELSE 'HOLD'
                END AS signal,
                CASE
                    WHEN e.has_closeout THEN 'Clearance item - buy before discontinued'
                    WHEN e.has_discount AND p.direction = 'down' AND p.case_delta_pct <= -5
                        THEN 'Price dropped ' || COALESCE(CAST(p.case_delta_pct AS VARCHAR), '?') || '% AND has discount of $' || COALESCE(CAST(round(e.total_savings_per_case,2) AS VARCHAR),'0')
                    WHEN p.direction = 'down' AND p.case_delta_pct <= -5
                        THEN 'Significant price drop of ' || COALESCE(CAST(p.case_delta_pct AS VARCHAR), '?') || '%'
                    WHEN e.has_discount AND (p.direction = 'down' OR p.direction = 'stable')
                        THEN 'Active discount saving $' || COALESCE(CAST(round(e.total_savings_per_case,2) AS VARCHAR),'0') || ' per case'
                    WHEN p.direction = 'up' AND p.case_delta_pct >= 5
                        THEN 'Price rising - up ' || COALESCE(CAST(p.case_delta_pct AS VARCHAR), '?') || '% from last period'
                    ELSE 'Stable price, no active deals'
                END AS reason
            FROM {enriched} e
            LEFT JOIN {changes} p
                ON e.wholesaler = p.wholesaler
                AND e.edition = p.edition
                AND e.product_name = p.product_name
                AND e.unit_volume = p.unit_volume
            WHERE {w}
            ORDER BY
                CASE
                    WHEN e.has_closeout THEN 1
                    WHEN e.has_discount AND p.direction = 'down' AND p.case_delta_pct <= -5 THEN 2
                    WHEN p.direction = 'down' AND p.case_delta_pct <= -5 THEN 3
                    WHEN e.has_discount THEN 4
                    WHEN p.direction = 'up' AND p.case_delta_pct >= 5 THEN 6
                    ELSE 5
                END,
                e.total_savings_per_case DESC NULLS LAST
            LIMIT $limit
        """, {**params, "limit": limit}).fetchdf()

        records = df.to_dict(orient="records")
        attach_enrichment_image(con, records)
        return records


@router.get("/buy-sheet")
def get_buy_sheet(wholesaler: Optional[str] = None, edition: Optional[str] = None):
    """
    Comprehensive buy sheet â€” Â§9.1

    Groups items by signal urgency with market summary.
    """
    signals = get_buy_signals(wholesaler=wholesaler, edition=edition, limit=500)

    sections = {
        "LAST_CHANCE": [],
        "STRONG_BUY": [],
        "BUY_NOW": [],
        "GOOD_BUY": [],
        "HOLD": [],
        "DEFER": [],
    }

    for item in signals:
        sig = item.get("signal", "HOLD")
        if sig in sections:
            sections[sig].append(item)

    # Market summary
    total = len(signals)
    drops = sum(1 for s in signals if s.get("direction") == "down")
    increases = sum(1 for s in signals if s.get("direction") == "up")
    stable = total - drops - increases

    market_direction = "stable"
    if drops > increases * 1.5:
        market_direction = "falling"
    elif increases > drops * 1.5:
        market_direction = "rising"

    return {
        "market_summary": {
            "direction": market_direction,
            "total_items": total,
            "price_drops": drops,
            "price_increases": increases,
            "stable": stable,
            "total_savings_pool": round(sum(
                s.get("total_savings_per_case", 0) or 0 for s in signals if s.get("has_discount")
            ), 2),
        },
        "sections": {k: v for k, v in sections.items() if v},
        "section_counts": {k: len(v) for k, v in sections.items()},
    }


@router.get("/missed-opportunities")
def get_missed_opportunities(
    wholesaler: Optional[str] = None,
    edition: Optional[str] = None,
    limit: int = Query(50, ge=1, le=50000),
    user: dict = Depends(get_current_user),
):
    """Items with deals NOT in user's watchlist â€” Â§9.3"""
    with get_pg() as sqlite_con:
        watchlist_items = sqlite_con.execute(
            "SELECT product_name, wholesaler FROM watchlist WHERE user_id = %s", (user["id"],)
        ).fetchall()

    watched = {(r["product_name"], r["wholesaler"]) for r in watchlist_items}

    with get_duckdb() as con:
        enriched = read_parquet(con, "cpl_enriched")

        where = ["(has_discount = true OR has_closeout = true OR has_rip = true)"]
        params = {}
        if wholesaler:
            where.append("wholesaler = $wholesaler")
            params["wholesaler"] = wholesaler
        if edition:
            where.append("edition = $edition")
            params["edition"] = edition
        else:
            where.append(f"edition = (SELECT MAX(edition) FROM {enriched}" +
                        (f" WHERE wholesaler = $wholesaler" if wholesaler else "") + ")")

        w = " AND ".join(where)
        df = con.execute(f"""
            SELECT wholesaler, edition, upc, product_name, product_type,
                   unit_volume, frontline_case_price, effective_case_price,
                   discount_pct, total_savings_per_case,
                   has_discount, has_rip, has_closeout
            FROM {enriched}
            WHERE {w}
            ORDER BY total_savings_per_case DESC NULLS LAST
            LIMIT $limit
        """, {**params, "limit": limit}).fetchdf()

        items = df.to_dict(orient="records")
        # Filter out items already on watchlist
        missed = [i for i in items if (i["product_name"], i["wholesaler"]) not in watched]
        attach_enrichment_image(con, missed)

        return {
            "total_opportunities": len(missed),
            "total_savings_missed": round(sum(i.get("total_savings_per_case", 0) or 0 for i in missed), 2),
            "clearance_count": sum(1 for i in missed if i.get("has_closeout")),
            "items": missed,
        }


@router.get("/order-scorecard/{order_id}")
def get_order_scorecard(order_id: int, user: dict = Depends(get_current_user)):
    """Grade an order 0-100 â€” Â§9.2"""
    with get_pg() as sqlite_con:
        order = sqlite_con.execute(
            "SELECT * FROM orders WHERE id = %s AND user_id = %s", (order_id, user["id"])
        ).fetchone()
        if not order:
            return {"error": "Order not found"}
        lines = sqlite_con.execute(
            "SELECT * FROM order_lines WHERE order_id = %s", (order_id,)
        ).fetchall()

    if not lines:
        return {"order_id": order_id, "grade": "F", "score": 0, "recommendations": ["Add items to your order"]}

    with get_duckdb() as con:
        enriched = read_parquet(con, "cpl_enriched")

        # Get latest edition data for ordered items
        product_names = [l["product_name"] for l in lines]
        wholesalers = [l["wholesaler"] for l in lines]

        # Fetch enrichment data for ordered items
        placeholders = ",".join(f"('{pn}','{ws}')" for pn, ws in zip(product_names, wholesalers))
        items_df = con.execute(f"""
            SELECT product_name, wholesaler, product_type, has_discount, has_closeout,
                   discount_pct, total_savings_per_case
            FROM {enriched}
            WHERE edition = (SELECT MAX(edition) FROM {enriched})
              AND (product_name, wholesaler) IN ({placeholders})
        """).fetchdf()

    # Score components
    discount_capture = 0
    category_diversity = 0
    clearance_urgency = 100
    price_timing = 50

    if not items_df.empty:
        discounted = items_df["has_discount"].sum()
        discount_capture = min(100, int((discounted / len(items_df)) * 100))

        unique_types = items_df["product_type"].nunique()
        category_diversity = min(100, unique_types * 25)

        clearance_items = items_df["has_closeout"].sum()
        clearance_urgency = 100 if clearance_items > 0 else 60

    total_score = int(
        discount_capture * 0.35 +
        category_diversity * 0.20 +
        clearance_urgency * 0.20 +
        price_timing * 0.25
    )

    grade = "A" if total_score >= 90 else "B" if total_score >= 75 else "C" if total_score >= 60 else "D" if total_score >= 40 else "F"

    recommendations = []
    if discount_capture < 50:
        recommendations.append("Consider adding more discounted items to capture available savings")
    if category_diversity < 50:
        recommendations.append("Diversify across more product categories")

    return {
        "order_id": order_id,
        "score": total_score,
        "grade": grade,
        "metrics": {
            "discount_capture": discount_capture,
            "category_diversity": category_diversity,
            "clearance_urgency": clearance_urgency,
            "price_timing": price_timing,
        },
        "recommendations": recommendations,
    }
