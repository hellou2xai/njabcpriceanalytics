"""
Kramer Beverage Co. — wholesaler config.

Files: "Kramer*.xlsx" — e.g. "Kramer_June_2026 ecpl amend 5-18.xlsx"
       Future loads: keep "Kramer" + month name + 4-digit year in the filename
       (edition is parsed from the filename, e.g. "Kramer July 2026 eCPL.xlsx").
Sheets: TERMS and CONDITIONS, CPL, RIP, COMBO, BEER MIX and MATCH
Notes:
  - Standard NJ ABC template, header row at row 6
  - 3 discount tiers, 2 RIP tiers
  - Primarily a beer distributor (domestic/craft/import) + RTD/FMB/cider
  - Unit types lowercase ("keg", "can", "bottle", "pet")
"""

CONFIG = {
    "slug": "kramer",
    "name": "Kramer Beverage Co.",
    "header_row_hint": 6,
    "discount_tiers": 3,
    "rip_tiers": 2,
    "product_type_map": {
        "BEER DOMESTIC": "Beer",
        "BEER CRAFT": "Beer",
        "BEER IMPORT": "Beer",
        "BEER": "Beer",
        "APPLE CIDER": "Cider",
        "CIDER": "Cider",
        "WINE STILL": "Wine",
        "WINE": "Wine",
        "WINE SPARKLING": "Sparkling",
        "SPARKLING": "Sparkling",
        "LIQUOR": "Spirits",
        "SPIRITS": "Spirits",
        "DISTILLED SPIRITS": "Spirits",
        "READY TO DRINK COCKTAILS": "RTD",
        "FLAVORED MALT BEVERAGE": "FAB",
        "HEMP THC": "Hemp",
        "HEMP": "Hemp",
    },
    "skip_sheets": ["terms"],
    "file_pattern": "Kramer*.xlsx",
}
