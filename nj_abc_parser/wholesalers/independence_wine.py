"""
Independence Wine & Spirits (IWS) — wholesaler config.

Files: "INDEPENDENCE WINE*.xlsx" — e.g. "INDEPENDENCE WINE_06 June NJ - IWS.xlsx".
       The filename has the MONTH but no year, so the ETL takes the year from the
       SUBMISSION DATE.
Sheets: standard 5-sheet NJ ABC eCPL workbook.
Notes:
  - Standard NJ ABC eCPL template (header row 6). Wine importer; BEST filled.
"""

CONFIG = {
    "slug": "independence_wine",
    "name": "Independence Wine",
    "header_row_hint": 6,
    "discount_tiers": 3,
    "rip_tiers": 2,
    "product_type_map": {
        "WINE": "Wine",
        "STILL WINE": "Wine",
        "SPARKLING": "Sparkling",
        "VERMOUTH": "Vermouth",
        "SAKE": "Sake",
        "LIQUOR": "Spirits",
        "SPIRITS": "Spirits",
        "DISTILLED SPIRITS": "Spirits",
        "BEER": "Beer",
        "CIDER": "Cider",
        "RTD": "RTD",
    },
    "skip_sheets": ["terms"],
    "file_pattern": "INDEPENDENCE WINE*.xlsx",
}
