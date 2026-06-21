"""
Other Brothers Brands, LLC (DBA Grape2Glass) — wholesaler config.

Files: "Other Brothers*.xlsx" — e.g. "Other Brothers NJABC-eCPL-July 2026.xlsx"
       (edition parsed from the filename's month name + 4-digit year).
Sheets: TERMS and CONDITIONS, CPL, RIP, COMBO, BEER MIX and MATCH.
Notes:
  - Standard NJ ABC eCPL template, header row at row 6 (auto-detected).
  - A small wine-focused importer (e.g. Portuguese wines). Product types arrive
    already canonical ("Wine"); the map below is a safety net for variants.
"""
CONFIG = {
    "slug": "other_brothers",
    "name": "Other Brothers (Grape2Glass)",
    "header_row_hint": 6,
    "discount_tiers": 3,
    "rip_tiers": 2,
    "product_type_map": {
        "WINE": "Wine",
        "WINE STILL": "Wine",
        "STILL WINE": "Wine",
        "WINE SPARKLING": "Sparkling",
        "SPARKLING": "Sparkling",
        "SPARKLING WINE": "Sparkling",
        "VERMOUTH": "Vermouth",
        "LIQUOR": "Spirits",
        "SPIRITS": "Spirits",
        "DISTILLED SPIRITS": "Spirits",
        "BEER": "Beer",
        "CIDER": "Cider",
        "READY TO DRINK COCKTAILS": "RTD",
        "FLAVORED MALT BEVERAGE": "FAB",
    },
    "skip_sheets": ["terms"],
    "file_pattern": "Other Brothers*.xlsx",
}
