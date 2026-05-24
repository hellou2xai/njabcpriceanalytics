"""
Fedway Associates, Inc — wholesaler config.

Files: "Fedway Associates {Year}-{MM} CPL.xlsx"
Sheets: TERMS and CONDITIONS, CPL, RIP, COMBO, BEER MIX and MATCH
Notes:
  - Standard 3 discount tiers (but often sparse — many items have no discounts)
  - Header row at row 5
  - Product types: Spirits (capitalized differently from Allied)
  - Has TERMS sheet (skip it)
  - Some items have $40,000 case price (single-bottle luxury items)
"""

CONFIG = {
    "slug": "fedway",
    "name": "Fedway Associates",
    "header_row_hint": 5,
    "discount_tiers": 3,
    "rip_tiers": 2,
    "product_type_map": {
        "SPIRITS": "Spirits",
        "WINE": "Wine",
        "BEER": "Beer",
        "LIQUOR": "Spirits",
        "CANS & COCKTAILS": "RTD",
        "MALT PRODUCTS": "Malt",
        "COMBO PACKS": "Combo",
    },
    "skip_sheets": ["terms"],
    "file_pattern": "Fedway Associates*CPL*.xlsx",
}
