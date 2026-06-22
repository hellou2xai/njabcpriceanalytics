"""
Wilson Daniels — wholesaler config.

Files: "WILSON DANIELS*.xlsx" — e.g. "WILSON DANIELS_NJ-eCPL-JUN 2026.xlsx"
       (edition from the filename month name + 4-digit year).
Sheets: TERMS and CONDITIONS, CPL, RIP, COMBO.
Notes:
  - Standard NJ ABC eCPL template (header row 6; 3 discount tiers, 2 RIP tiers).
  - Wine importer (~4.2k SKUs). BEST price filled, so no post_process.
    Product types: WINE, SPIRITS, NA.
"""

CONFIG = {
    "slug": "wilson_daniels",
    "name": "Wilson Daniels",
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
        "NA": None,
        "N/A": None,
    },
    "skip_sheets": ["terms"],
    "file_pattern": "WILSON DANIELS*.xlsx",
}
