"""
High Grade Beverage — wholesaler config.

Files: "ECPL Randolph {Month} {Year}.xlsx", "eCPL {Month} {Year}.xlsx"
Sheets: Terms & Conditions, CPL, RIP, COMBO, BEER MIX and MATCH
Notes:
  - Standard 3 discount tiers
  - Header row at row 5
  - Product types: CRAFT BEER primarily
  - Some items missing UPC codes
  - Sometimes missing best_unit_price (has unit_price computed differently)
  - Terms sheet named "Terms & Conditions" (different from others)
  - Two file naming patterns
"""

CONFIG = {
    "slug": "high_grade",
    "name": "High Grade Beverage",
    "header_row_hint": 5,
    "discount_tiers": 3,
    "rip_tiers": 2,
    "product_type_map": {
        "CRAFT BEER": "Beer",
        "BEER": "Beer",
        "IMPORT BEER": "Beer",
        "DOMESTIC BEER": "Beer",
        "WINE": "Wine",
        "SPIRITS": "Spirits",
        "LIQUOR": "Spirits",
        "THC": "THC",
        "CIDER": "Cider",
        "FAB'S": "FAB",
        "SELTZER": "Seltzer",
        "NON ALC": "Non-Alc",
        "TEA'S": "Tea",
        "WINTER SEASONA": "Seasonal",
        "SUMMER SEASONA": "Seasonal",
    },
    "skip_sheets": ["terms"],
    "file_pattern": ["ECPL*Randolph*.xlsx", "eCPL*.xlsx"],
}
