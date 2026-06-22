"""
Banville Wine Merchants — wholesaler config.

Files: "BANVILLE*.xlsx" — e.g. "BANVILLE_NJ JUNE 2026 PRICE POSTING.xlsx"
       (edition from the filename month name + 4-digit year).
Sheets: Terms & Conditions, CPL, RIP, COMBO, BEER MIX and MATCH.
Notes:
  - Standard NJ ABC eCPL template (header row 6; 3 discount tiers, 2 RIP tiers).
    BEST price filled (no post_process). Types WINE / DISTILLED SPIRITS / BEER.
  - The JULY export omits the CPL header row (data starts row 6, no labels) but
    keeps the standard ABC column ORDER, so cpl_assume_standard_order maps the
    columns positionally when no header is found. The June file has a header and
    parses normally.
"""

CONFIG = {
    "slug": "banville",
    "name": "Banville Wine",
    "header_row_hint": 6,
    "discount_tiers": 3,
    "rip_tiers": 2,
    "product_type_map": {
        "WINE": "Wine",
        "STILL WINE": "Wine",
        "SPARKLING": "Sparkling",
        "SPARKLING WINE": "Sparkling",
        "VERMOUTH": "Vermouth",
        "SAKE": "Sake",
        "LIQUOR": "Spirits",
        "SPIRITS": "Spirits",
        "DISTILLED SPIRITS": "Spirits",
        "BEER": "Beer",
        "CIDER": "Cider",
        "READY TO DRINK COCKTAILS": "RTD",
        "RTD": "RTD",
    },
    "skip_sheets": ["terms"],
    "file_pattern": "BANVILLE*.xlsx",
    "cpl_assume_standard_order": True,
}
