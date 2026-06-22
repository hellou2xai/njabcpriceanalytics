"""
Winebow, Inc. — wholesaler config.

Files: "winebow_*.xlsx" — e.g. "winebow_June 2026 Current Price List.xlsx"
       (edition parsed from the filename's month name + 4-digit year).
Sheets: Terms & Conditions, CPL, RIP, COMBO, BEER-MIX & MATCH.
Notes:
  - Standard NJ ABC eCPL template — header auto-detected at row 5, 3 discount
    tiers, 2 RIP tiers (the base-parser defaults), so no layout overrides.
  - A wine/spirits importer. Product types arrive as Wine / Liquor / Cider /
    Sake / BarGoods; the map below normalizes them to the canonical labels.
  - BEST CASE/UNIT PRICE is always filled (best = frontline on no-discount
    rows), so — unlike Other Brothers — no best-from-frontline post_process is
    needed (verified: 0 blank/zero best_case rows).
"""

CONFIG = {
    "slug": "winebow",
    "name": "Winebow",
    "discount_tiers": 3,
    "rip_tiers": 2,
    "product_type_map": {
        "WINE": "Wine",
        "STILL WINE": "Wine",
        "WINE STILL": "Wine",
        "SPARKLING": "Sparkling",
        "SPARKLING WINE": "Sparkling",
        "WINE SPARKLING": "Sparkling",
        "VERMOUTH": "Vermouth",
        "SAKE": "Sake",
        "LIQUOR": "Spirits",
        "SPIRITS": "Spirits",
        "DISTILLED SPIRITS": "Spirits",
        "CORDIAL": "Spirits",
        "CORDIALS": "Spirits",
        "BEER": "Beer",
        "CIDER": "Cider",
        "READY TO DRINK COCKTAILS": "RTD",
        "RTD": "RTD",
        "FLAVORED MALT BEVERAGE": "FAB",
        "BARGOODS": "Bar Goods",
        "BAR GOODS": "Bar Goods",
        "NON-ALCOHOLIC": "Non-Alcoholic",
        "NON ALCOHOLIC": "Non-Alcoholic",
    },
    "skip_sheets": ["terms"],
    "file_pattern": "winebow*.xlsx",
}
