"""Synthetic POS feed generator.

Samples real SKUs from the live catalog (latest cpl_enriched edition) and
simulates daily sell-through with the patterns the procurement agents need to
learn from later:

- velocity tiers (a few A-items carry the store, a long C-tail),
- weekday shape (Fri/Sat peaks), monthly seasonality (Dec spike, dry January,
  summer lift for beer/RTD/rose),
- holiday spikes (Dec 23/24/31, Jul 3, Thanksgiving eve),
- occasional stockout stretches (zero sales for 3-10 days),
- SKU lifecycle: some items introduced mid-history, some delisted (these are
  what lapsed-item detection should later catch).

Everything is driven by random.Random(seed) so a reseed reproduces the exact
same history.
"""

import math
from datetime import date, timedelta
from random import Random

from backend.db import get_duckdb

# Wine-forward mix for a store literally called Planet of Wine.
CATEGORY_WEIGHTS = {
    "Wine": 0.50, "Spirits": 0.25, "Beer": 0.08, "Sparkling": 0.08,
    "RTD": 0.04, "Cider": 0.02, "Vermouth": 0.03,
}
# Retail markup over the wholesale bottle price, by category.
MARKUP = {"Wine": 1.45, "Spirits": 1.35, "Beer": 1.30, "Sparkling": 1.45,
          "RTD": 1.35, "Cider": 1.32, "Vermouth": 1.40}
WEEKDAY = [0.70, 0.75, 0.85, 1.00, 1.60, 1.80, 0.90]  # Mon..Sun
MONTH = {1: 0.75, 2: 0.85, 3: 0.95, 4: 1.00, 5: 1.05, 6: 1.05,
         7: 1.10, 8: 1.05, 9: 1.00, 10: 1.05, 11: 1.20, 12: 1.55}
SUMMER_CATS = {"Beer", "RTD", "Cider"}        # extra July/August lift
FESTIVE_CATS = {"Sparkling", "Spirits"}        # extra November/December lift


def _poisson(rng: Random, lam: float) -> int:
    """Knuth's algorithm; fine for the small lambdas we use."""
    if lam <= 0:
        return 0
    l, k, p = math.exp(-lam), 0, 1.0
    while True:
        k += 1
        p *= rng.random()
        if p <= l:
            return k - 1


def _retail(unit_price: float, category: str, rng: Random) -> float:
    """Wholesale bottle price -> shelf price with a .99 ending."""
    base = unit_price * MARKUP.get(category, 1.38) * rng.uniform(0.97, 1.06)
    return max(round(base) - 0.01, 0.99)


def _thanksgiving_eve(year: int) -> date:
    """Wednesday before the 4th Thursday of November."""
    d = date(year, 11, 1)
    d += timedelta(days=(3 - d.weekday()) % 7)   # first Thursday
    return d + timedelta(weeks=3, days=-1)


def sample_skus(rng: Random, count: int) -> list[dict]:
    """Pick `count` real UPCs from the latest edition, weighted by category.
    One row per UPC (cheapest wholesaler's price as the cost basis)."""
    with get_duckdb() as con:
        rows = con.execute("""
            SELECT upc, ANY_VALUE(product_name) product_name,
                   ANY_VALUE(product_type) category,
                   MIN(frontline_unit_price) unit_price
            FROM cpl_enriched
            WHERE edition = (SELECT MAX(edition) FROM cpl_enriched)
              AND frontline_unit_price > 1
              AND product_type IN ('Wine','Spirits','Beer','Sparkling',
                                   'RTD','Cider','Vermouth')
            GROUP BY upc
        """).fetchall()
    by_cat: dict[str, list] = {}
    for upc, name, cat, price in rows:
        by_cat.setdefault(cat, []).append((upc, name, cat, float(price)))
    picked = []
    for cat, weight in CATEGORY_WEIGHTS.items():
        pool = by_cat.get(cat, [])
        take = min(round(count * weight), len(pool))
        picked += rng.sample(pool, take)
    skus = []
    for upc, name, cat, price in picked:
        retail = _retail(price, cat, rng)
        # Velocity tier: lognormal gives a few fast movers + a long tail,
        # damped by price so a $25 bottle can be an A-item but a $1,000
        # cognac moves single digits a month. Targets roughly $1.5M/yr
        # across ~400 SKUs, which is a plausible single-store volume.
        base_daily = min(rng.lognormvariate(-1.6, 1.0), 6.0)
        price_damp = min(max((25.0 / max(retail, 5.0)) ** 0.6, 0.02), 1.5)
        skus.append({
            "upc": upc, "product_name": name, "category": cat,
            "unit_retail": retail,
            "base_daily": base_daily * price_damp,
        })
    return skus


def generate_history(seed: int, sku_count: int, months: int,
                     end: date | None = None) -> tuple[list[dict], list[dict]]:
    """Return (sales_rows, inventory_rows) in the ingest.py contract shapes."""
    rng = Random(seed)
    end = end or date.today()
    start = end - timedelta(days=months * 30)
    skus = sample_skus(rng, sku_count)

    spikes = {}
    for y in range(start.year, end.year + 1):
        for d, f in ((date(y, 12, 23), 2.0), (date(y, 12, 24), 2.3),
                     (date(y, 12, 31), 2.5), (date(y, 7, 3), 1.8),
                     (_thanksgiving_eve(y), 2.2)):
            spikes[d] = f

    sales: list[dict] = []
    for sku in skus:
        # Lifecycle: ~10% introduced mid-history, ~8% delisted before the end.
        live_from, live_to = start, end
        r = rng.random()
        if r < 0.10:
            live_from = start + timedelta(days=rng.randint(120, months * 30 - 90))
        elif r < 0.18:
            live_to = end - timedelta(days=rng.randint(60, 300))

        # Pre-plan stockout stretches: ~3% chance per month, 3-10 days each.
        stockouts = set()
        d = live_from
        while d < live_to:
            if rng.random() < 0.001:
                for k in range(rng.randint(3, 10)):
                    stockouts.add(d + timedelta(days=k))
            d += timedelta(days=1)

        cat = sku["category"]
        d = live_from
        while d <= live_to:
            if d in stockouts:
                d += timedelta(days=1)
                continue
            lam = sku["base_daily"] * WEEKDAY[d.weekday()] * MONTH[d.month]
            if cat in SUMMER_CATS and d.month in (7, 8):
                lam *= 1.30
            if cat in FESTIVE_CATS and d.month in (11, 12):
                lam *= 1.25
            lam *= spikes.get(d, 1.0)
            units = _poisson(rng, lam)
            if units:
                sales.append({
                    "business_date": d.isoformat(), "upc": sku["upc"],
                    "product_name": sku["product_name"], "category": cat,
                    "units_sold": units, "unit_retail": sku["unit_retail"],
                    "net_revenue": round(units * sku["unit_retail"], 2),
                })
            d += timedelta(days=1)

    # On-hand snapshot at the end date: roughly 1-5 weeks of cover for live
    # items, zero for anything delisted (so reorder logic sees real gaps).
    inventory: list[dict] = []
    last_90 = (end - timedelta(days=90)).isoformat()
    sold_recent: dict[str, int] = {}
    for r in sales:
        if r["business_date"] >= last_90:
            sold_recent[r["upc"]] = sold_recent.get(r["upc"], 0) + r["units_sold"]
    for sku in skus:
        daily = sold_recent.get(sku["upc"], 0) / 90.0
        on_hand = 0 if daily == 0 else max(int(daily * rng.uniform(7, 35)), 1)
        inventory.append({
            "as_of_date": end.isoformat(), "upc": sku["upc"],
            "product_name": sku["product_name"], "on_hand_units": on_hand,
        })
    return sales, inventory
