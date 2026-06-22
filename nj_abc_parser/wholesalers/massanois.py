"""
Massanois Imports — wholesaler config.

Files: "*Massanois*.xlsx" — e.g. "202606 Massanois-NJABC-eCPL-Upload File- June
       2026.xlsx" (edition from the month name + 4-digit year in the name).
Sheets: standard 5-sheet NJ ABC eCPL workbook.
Notes:
  - Standard NJ ABC eCPL template (header row 6). Wine/Spirits/Sake; BEST filled.
"""

CONFIG = {
    "slug": "massanois",
    "name": "Massanois",
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
        "RTD": "RTD",
    },
    "skip_sheets": ["terms"],
    "file_pattern": "*Massanois*.xlsx",
}
