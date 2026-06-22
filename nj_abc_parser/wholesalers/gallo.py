"""
E. & J. Gallo Winery — wholesaler config.

Files: "GALLO_*.xlsx" — e.g. "GALLO_JUNE 2026 ABC SUBMISSION 5.13.xlsx"
       (edition parsed from the filename's month name + 4-digit year).
Sheets: TERMS and CONDITIONS, CPL, RIP, COMBO, BEER MIX and MATCH.
Notes:
  - Standard NJ ABC eCPL template — header auto-detected at row 6, 3 discount
    tiers, 2 RIP tiers (base-parser defaults).
  - QUIRK: Gallo leaves the PRODUCT TYPE column BLANK for every row, so its
    products carry no category (no category facet). Nothing to map; the
    product_type_map below is only a safety net should they start populating it.
  - Short RIP codes (e.g. "R2"). BEST CASE/UNIT PRICE is always filled
    (best = frontline on no-discount rows), so no best-from-frontline fix.
"""

CONFIG = {
    "slug": "gallo",
    "name": "E. & J. Gallo Winery",
    "header_row_hint": 6,
    "discount_tiers": 3,
    "rip_tiers": 2,
    "product_type_map": {
        "WINE": "Wine",
        "STILL WINE": "Wine",
        "SPARKLING": "Sparkling",
        "SPARKLING WINE": "Sparkling",
        "VERMOUTH": "Vermouth",
        "LIQUOR": "Spirits",
        "SPIRITS": "Spirits",
        "DISTILLED SPIRITS": "Spirits",
        "BEER": "Beer",
        "CIDER": "Cider",
        "READY TO DRINK COCKTAILS": "RTD",
        "RTD": "RTD",
        "FLAVORED MALT BEVERAGE": "FAB",
    },
    "skip_sheets": ["terms"],
    "file_pattern": "GALLO*.xlsx",
}
