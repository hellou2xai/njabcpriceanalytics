"""
Alerts API: alert generation, retrieval, management.

Covers: Section 10 Alert Engine. Pricing reads run on DuckDB; the alerts
themselves are stored per user in Postgres.
"""

import json
from fastapi import APIRouter, Query, Depends
from typing import Optional

from backend.db import get_duckdb, read_parquet
from backend.pg import get_pg
from backend.auth import get_current_user

router = APIRouter(prefix="/api/alerts", tags=["alerts"])


@router.get("")
def get_alerts(
    unread_only: bool = False,
    limit: int = Query(50, ge=1, le=1000),
    user: dict = Depends(get_current_user),
):
    """Get alert events."""
    where = "user_id = %s"
    if unread_only:
        where += " AND read = 0"
    with get_pg() as con:
        rows = con.execute(
            f"SELECT * FROM alerts WHERE {where} ORDER BY priority DESC, created_at DESC LIMIT %s",
            (user["id"], limit)
        ).fetchall()
    return [dict(r) for r in rows]


@router.get("/unread-count")
def get_unread_count(user: dict = Depends(get_current_user)):
    with get_pg() as con:
        count = con.execute(
            "SELECT count(*) AS n FROM alerts WHERE user_id = %s AND read = 0", (user["id"],)
        ).fetchone()["n"]
    return {"unread": count}


@router.put("/{alert_id}/read")
def mark_alert_read(alert_id: int, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        con.execute("UPDATE alerts SET read = 1 WHERE id = %s AND user_id = %s", (alert_id, user["id"]))
    return {"status": "read"}


@router.put("/mark-all-read")
def mark_all_read(user: dict = Depends(get_current_user)):
    with get_pg() as con:
        con.execute("UPDATE alerts SET read = 1 WHERE user_id = %s AND read = 0", (user["id"],))
    return {"status": "all_read"}


@router.post("/generate")
def generate_alerts(edition: Optional[str] = None, user: dict = Depends(get_current_user)):
    """
    Generate alerts from latest data.

    Alert Rules:
      1. New clearance (priority 100)
      2. Target price hit (priority 90)
      3. Discount changed (priority 70)
      4. New discount (priority 60)
      5. Price drop >= 5% (priority 50)
      6. Price increase >= 5% (priority 30)
    """
    alerts_created = 0

    with get_pg() as pg_con, get_duckdb() as con:
        lifecycle = read_parquet(con, "item_lifecycle")
        changes = read_parquet(con, "price_changes")

        # Determine edition
        if not edition:
            edition = con.execute(
                f"SELECT MAX(edition) FROM {changes}"
            ).fetchone()[0]

        # 1. New clearance items
        clearances = con.execute(f"""
            SELECT wholesaler, product_name, edition
            FROM {lifecycle}
            WHERE event_type = 'new_clearance' AND edition = $edition
        """, {"edition": edition}).fetchdf()

        for _, row in clearances.iterrows():
            _insert_alert(pg_con, user["id"], "new_clearance", row["product_name"],
                         row["wholesaler"], edition,
                         f"NEW CLEARANCE: {row['product_name']} is now on clearance",
                         100)
            alerts_created += 1

        # 2. Target price hits
        watchlist = pg_con.execute(
            "SELECT * FROM watchlist WHERE user_id = %s AND target_price IS NOT NULL",
            (user["id"],)
        ).fetchall()

        if watchlist:
            enriched = read_parquet(con, "cpl_enriched")
            for item in watchlist:
                hit = con.execute(f"""
                    SELECT frontline_case_price FROM {enriched}
                    WHERE wholesaler = $ws AND product_name = $pn
                      AND edition = $edition
                      AND frontline_case_price <= $target
                    LIMIT 1
                """, {
                    "ws": item["wholesaler"], "pn": item["product_name"],
                    "edition": edition, "target": item["target_price"]
                }).fetchone()

                if hit:
                    _insert_alert(pg_con, user["id"], "target_price_hit", item["product_name"],
                                 item["wholesaler"], edition,
                                 f"TARGET HIT: {item['product_name']} dropped to ${hit[0]} (target: ${item['target_price']})",
                                 90)
                    alerts_created += 1

        # 3. New discounts
        new_discounts = con.execute(f"""
            SELECT wholesaler, product_name, edition, curr_discount
            FROM {lifecycle}
            WHERE event_type = 'new_discount' AND edition = $edition
            LIMIT 100
        """, {"edition": edition}).fetchdf()

        for _, row in new_discounts.iterrows():
            _insert_alert(pg_con, user["id"], "new_discount", row["product_name"],
                         row["wholesaler"], edition,
                         f"NEW DISCOUNT: {row['product_name']} - ${row['curr_discount']} off",
                         60)
            alerts_created += 1

        # 4. Significant price drops
        drops = con.execute(f"""
            SELECT wholesaler, product_name, edition, case_delta_pct, case_price
            FROM {changes}
            WHERE edition = $edition AND direction = 'down' AND case_delta_pct <= -5
            ORDER BY case_delta_pct ASC
            LIMIT 50
        """, {"edition": edition}).fetchdf()

        for _, row in drops.iterrows():
            _insert_alert(pg_con, user["id"], "price_drop", row["product_name"],
                         row["wholesaler"], edition,
                         f"PRICE DROP: {row['product_name']} down {row['case_delta_pct']}% to ${row['case_price']}",
                         50)
            alerts_created += 1

        # 5. Significant price increases
        increases = con.execute(f"""
            SELECT wholesaler, product_name, edition, case_delta_pct, case_price
            FROM {changes}
            WHERE edition = $edition AND direction = 'up' AND case_delta_pct >= 5
            ORDER BY case_delta_pct DESC
            LIMIT 50
        """, {"edition": edition}).fetchdf()

        for _, row in increases.iterrows():
            _insert_alert(pg_con, user["id"], "price_increase", row["product_name"],
                         row["wholesaler"], edition,
                         f"PRICE UP: {row['product_name']} up {row['case_delta_pct']}% to ${row['case_price']}",
                         30)
            alerts_created += 1

    return {"alerts_created": alerts_created, "edition": edition}


def _insert_alert(con, user_id, alert_type, product_name, wholesaler, edition, message, priority):
    """Insert alert if this user doesn't already have one for this item/edition/type."""
    existing = con.execute(
        """SELECT id FROM alerts
           WHERE user_id = %s AND alert_type = %s AND product_name = %s AND wholesaler = %s AND edition = %s""",
        (user_id, alert_type, product_name, wholesaler, edition)
    ).fetchone()

    if not existing:
        con.execute(
            """INSERT INTO alerts (user_id, alert_type, product_name, wholesaler, edition, message, priority)
               VALUES (%s, %s, %s, %s, %s, %s, %s)""",
            (user_id, alert_type, product_name, wholesaler, edition, message, priority)
        )
