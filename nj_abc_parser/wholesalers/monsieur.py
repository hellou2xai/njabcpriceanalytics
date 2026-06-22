"""
Monsieur Touton Selection — wholesaler config.

Files: "MONSIEUR*.xlsx" — e.g. "MONSIEUR_NJABC-eCPL-0626.xlsx" where "0626" is
       MMYY (June 2026); the edition parser reads the MMYY token from the name
       (the submission date is the prior month, so it can't supply the month).
Sheets: TERMS and CONDITIONS, CPL, RIP, COMBO, BEER MIX and MATCH.
Notes:
  - Standard NJ ABC eCPL template (header row 6; 3 discount tiers, 2 RIP tiers).
  - Large wine importer (~13k SKUs). BEST price is filled, so no post_process.
    Product types: Wine, Liquor (-> Spirits), Other.
"""

CONFIG = {
    "slug": "monsieur",
    "name": "Monsieur Touton",
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
        "FLAVORED MALT BEVERAGE": "FAB",
    },
    "skip_sheets": ["terms"],
    "file_pattern": "MONSIEUR*.xlsx",
}
