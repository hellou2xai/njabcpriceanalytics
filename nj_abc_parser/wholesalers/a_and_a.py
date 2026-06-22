"""
A & A Products — wholesaler config.

Files: "A & A*.xlsx" — e.g. "A & A_Products_June.xlsx". The filename has the
       MONTH but no year, so the ETL takes the year from the SUBMISSION DATE.
Sheets: standard 5-sheet NJ ABC eCPL workbook.
Notes:
  - Standard NJ ABC eCPL template (header row 6). Mostly Distilled Spirits +
    Wine, some Beer/Cider/Variety Pack; BEST filled.
"""

CONFIG = {
    "slug": "a_and_a",
    "name": "A & A Products",
    "header_row_hint": 6,
    "discount_tiers": 3,
    "rip_tiers": 2,
    "product_type_map": {
        "WINE": "Wine",
        "STILL WINE": "Wine",
        "SPARKLING": "Sparkling",
        "VERMOUTH": "Vermouth",
        "SAKE": "Sake",
        "LIQUOR": "Spirits",
        "SPIRITS": "Spirits",
        "DISTILLED SPIRITS": "Spirits",
        "BEER": "Beer",
        "CIDER": "Cider",
        "RTD": "RTD",
        "READY TO DRINK COCKTAILS": "RTD",
    },
    "skip_sheets": ["terms"],
    "file_pattern": "A & A*.xlsx",
}
