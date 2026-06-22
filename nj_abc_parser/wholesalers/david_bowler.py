"""
David Bowler Wine — wholesaler config.

Files: "DAVID BOWLER*.xlsx" — e.g. "DAVID BOWLER_NJ_CPL JUNE 2026.xlsx"
       (edition from the filename month name + 4-digit year).
Notes:
  - Standard NJ ABC eCPL CPL layout, but a BARE single-sheet workbook (only the
    CPL; no RIP/COMBO/TERMS tabs). The June sheet is even named "Sheet1" — the
    base parser's single-sheet fallback treats the lone sheet as the CPL.
  - Header auto-detected (June row 5, July row 6). BEST filled (no post_process).
    Types WINE / SPIRIT.
"""

CONFIG = {
    "slug": "david_bowler",
    "name": "David Bowler Wine",
    "discount_tiers": 3,
    "rip_tiers": 2,
    "product_type_map": {
        "WINE": "Wine",
        "STILL WINE": "Wine",
        "SPARKLING": "Sparkling",
        "SPARKLING WINE": "Sparkling",
        "VERMOUTH": "Vermouth",
        "SAKE": "Sake",
        "SPIRIT": "Spirits",
        "SPIRITS": "Spirits",
        "LIQUOR": "Spirits",
        "DISTILLED SPIRITS": "Spirits",
        "BEER": "Beer",
        "CIDER": "Cider",
        "RTD": "RTD",
    },
    "skip_sheets": ["terms"],
    "file_pattern": "DAVID BOWLER*.xlsx",
}
