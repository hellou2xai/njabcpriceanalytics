"""
Michael Skurnik Wines — wholesaler config.

Files: "MICHAEL SKURNIK*.xlsx" — e.g. "MICHAEL SKURNIK_June 2026 CPL FINAL.xlsx"
       (edition from the filename month name + 4-digit year).
Sheets: standard 5-sheet NJ ABC eCPL workbook.
Notes:
  - Standard NJ ABC eCPL template (header row 6). Large importer (~7k SKUs).
    Types WINE/SPIRITS/SAKE/SPECWINE/CIDER; BEST filled.
"""

CONFIG = {
    "slug": "michael_skurnik",
    "name": "Michael Skurnik",
    "header_row_hint": 6,
    "discount_tiers": 3,
    "rip_tiers": 2,
    "product_type_map": {
        "WINE": "Wine",
        "SPECWINE": "Wine",
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
    "file_pattern": "MICHAEL SKURNIK*.xlsx",
}
