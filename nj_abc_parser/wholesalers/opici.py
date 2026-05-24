"""
Opici Family Distributing — wholesaler config.

Files: "2026 {Month} Price File.xlsx"
Sheets: Template, CPL, RIP, COMBO
Notes:
  - 5 discount tiers (most wholesalers have 3)
  - Header row at row 4 (no column-letter row, 3 metadata rows)
  - RIP has 4 tiers (most have 2)
  - Unit quantity as string ("12" not 12)
  - Has "Template" sheet (skip it)
  - Wholesaler name in row 1: "OPICI FAMILY DISTRIBUTING"
"""

CONFIG = {
    "slug": "opici",
    "name": "Opici Family Distributing",
    "header_row_hint": 4,
    "discount_tiers": 5,
    "rip_tiers": 4,
    "product_type_map": {
        "WINE": "Wine",
        "SPIRITS": "Spirits",
        "LIQUOR": "Spirits",
        "BEER": "Beer",
        "SPARKLING": "Sparkling",
        "HEMP": "Hemp",
        "WINE OVER": "Wine",
        "VERMOUTH": "Vermouth",
    },
    "skip_sheets": ["template"],
    "file_pattern": "2026*Price File*.xlsx",
}
