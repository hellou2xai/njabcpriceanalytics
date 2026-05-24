"""
Peerless Beverage Company — wholesaler config.

Files: "Peerless Beverage Co. {Month} {Year} CPL.xlsx"
Sheets: TERMS and CONDITIONS, CPL, RIP, COMBO, BEER MIX and MATCH
Notes:
  - Standard 3 discount tiers
  - Header row at row 5
  - Product types: Beer (note: primarily a beer distributor)
  - ABV as percentage string ("4.10%") not numeric
  - Unit quantity as mixed format ("2 12-Packs", "24")
  - Has TERMS sheet (skip it)
"""

CONFIG = {
    "slug": "peerless",
    "name": "Peerless Beverage Co.",
    "header_row_hint": 5,
    "discount_tiers": 3,
    "rip_tiers": 2,
    "product_type_map": {
        "BEER": "Beer",
        "CRAFT BEER": "Beer",
        "WINE": "Wine",
        "SPIRITS": "Spirits",
        "LIQUOR": "Spirits",
        "DISTILLED SPIRITS": "Spirits",
        "CIDER": "Cider",
    },
    "skip_sheets": ["terms"],
    "file_pattern": "Peerless Beverage*CPL*.xlsx",
}
