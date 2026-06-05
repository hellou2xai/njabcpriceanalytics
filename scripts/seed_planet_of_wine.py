"""Seed the 'Planet of Wine' demo store with 24 months of dummy POS history.

Creates (idempotently):
- the POS tables (via init_user_db),
- a 'Planet of Wine' store under OWNER_EMAIL,
- ~400 SKUs sampled from the live catalog with 24 months of daily sales
  plus an on-hand inventory snapshot, loaded through the same ingest
  contract a real POS feed will use.

Run from the repo root:
    python scripts/seed_planet_of_wine.py
Re-running regenerates the same history (fixed seed) and upserts in place.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.db import init_user_db
from backend.pg import get_pg
from pos_feed.dummy import generate_history
from pos_feed.ingest import ingest_inventory, ingest_sales

OWNER_EMAIL = "sambit.tripathy@gmail.com"
STORE_NAME = "Planet of Wine"
SEED = 42
SKU_COUNT = 400
MONTHS = 24
SOURCE = "dummy"


def get_or_create_store() -> tuple[int, int]:
    with get_pg() as pg:
        user = pg.execute("SELECT id FROM users WHERE email=%s", (OWNER_EMAIL,)).fetchone()
        if not user:
            raise SystemExit(f"user {OWNER_EMAIL} not found")
        uid = user["id"]
        store = pg.execute(
            "SELECT id FROM stores WHERE user_id=%s AND name=%s",
            (uid, STORE_NAME)).fetchone()
        if store:
            return store["id"], uid
        row = pg.execute(
            "INSERT INTO stores (user_id, name, street, city, state, postal_code, country, notes) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
            (uid, STORE_NAME, "123 Washington St", "Hoboken", "NJ", "07030",
             "US", "Demo store: synthetic POS feed (pos_feed/dummy.py).")).fetchone()
        return row["id"], uid


def main():
    print("ensuring schema...")
    init_user_db()
    store_id, user_id = get_or_create_store()
    print(f"store '{STORE_NAME}' id={store_id} (user {user_id})")

    print(f"generating {MONTHS} months for ~{SKU_COUNT} SKUs (seed={SEED})...")
    sales, inventory = generate_history(seed=SEED, sku_count=SKU_COUNT, months=MONTHS)
    print(f"  {len(sales):,} sales rows, {len(inventory):,} inventory rows")

    # A regenerated history may produce fewer (date, upc) rows than the last
    # run, and the upsert alone would leave the extras behind. Purge this
    # store's dummy rows first so each seed run is a clean replacement.
    print("purging previous dummy rows...")
    with get_pg() as pg:
        pg.execute("DELETE FROM pos_sales_daily WHERE store_id=%s AND source=%s",
                   (store_id, SOURCE))
        pg.execute("DELETE FROM pos_inventory WHERE store_id=%s AND source=%s",
                   (store_id, SOURCE))

    print("ingesting...")
    n_s = ingest_sales(store_id, user_id, sales, SOURCE)
    n_i = ingest_inventory(store_id, user_id, inventory, SOURCE)
    print(f"  ingested {n_s:,} sales + {n_i:,} inventory rows")

    # Verification readout
    with get_pg() as pg:
        rng = pg.execute(
            "SELECT MIN(business_date) lo, MAX(business_date) hi, "
            "COUNT(*) n, SUM(units_sold) units, ROUND(SUM(net_revenue)::numeric, 0) rev "
            "FROM pos_sales_daily WHERE store_id=%s", (store_id,)).fetchone()
        print(f"\nsales: {rng['n']:,} rows, {rng['lo']} .. {rng['hi']}, "
              f"{rng['units']:,} units, ${rng['rev']:,} revenue")
        print("\ntop 5 sellers (last 90 days):")
        for r in pg.execute(
            "SELECT product_name, category, SUM(units_sold) u "
            "FROM pos_sales_daily WHERE store_id=%s "
            "AND business_date >= TO_CHAR(NOW() - INTERVAL '90 days', 'YYYY-MM-DD') "
            "GROUP BY 1,2 ORDER BY u DESC LIMIT 5", (store_id,)).fetchall():
            print(f"  {r['u']:>5}  {r['category']:<10} {r['product_name'][:60]}")
        print("\nrevenue by month (last 6):")
        for r in pg.execute(
            "SELECT SUBSTR(business_date,1,7) ym, ROUND(SUM(net_revenue)::numeric,0) rev "
            "FROM pos_sales_daily WHERE store_id=%s GROUP BY 1 ORDER BY 1 DESC LIMIT 6",
            (store_id,)).fetchall():
            print(f"  {r['ym']}  ${r['rev']:>10,}")


if __name__ == "__main__":
    main()
