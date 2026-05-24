"""
Allied Beverage Group LLC — wholesaler config.

Files: "Allied Beverage Group {Month} CPL {Year}.xlsx"
Sheets: CPL, RIP, COMBO, BEER MIX and MATCH
Notes:
  - Standard 3 discount tiers
  - Header row at row 5 (row 1 = column letters, rows 2-4 = metadata)
  - Product types: WINE, LIQUOR
  - 2 RIP tiers
  - RIP sheet has very wide column count (6951) but only 13 data columns
"""

CONFIG = {
    "slug": "allied",
    "name": "Allied Beverage Group",
    "header_row_hint": 5,
    "discount_tiers": 3,
    "rip_tiers": 2,
    "product_type_map": {
        "WINE": "Wine",
        "LIQUOR": "Spirits",
        "BEER": "Beer",
        "NON-ALC": "Non-Alc",
        "SPARKLING": "Sparkling",
        "VERMOUTH": "Vermouth",
    },
    "file_pattern": "Allied Beverage Group*CPL*.xlsx",
}
