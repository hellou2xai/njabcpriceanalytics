"""
Wine Enterprises LLC — wholesaler config.

Files: "Wine Enterprises_*.xlsx" — e.g. "Wine Enterprises_June.xlsx".
       The filename has the MONTH but NO YEAR, so the ETL takes the year from
       the file's SUBMISSION DATE (see registry.edition_year_from_submission)
       and keeps the filename's month (June vs July).
Sheets: TERMS and CONDITIONS, CPL, RIP, COMBO, BEER MIX and MATCH.
Notes:
  - Standard NJ ABC eCPL template (header row 6, verbose RIP headers).
  - Small importer (a few dozen SKUs). BEST price is filled, so no
    best-from-frontline fix. Product types: Wine, Distilled Spirits.
  - NOTE: the dated rows in the "June" file carry MAY validity windows and the
    "July" file carries JULY windows (both submitted 06/22/2026). Edition is
    assigned from the filename month as usual; the per-row windows are ingested
    as-is and the time-sensitive logic handles their validity.
"""

CONFIG = {
    "slug": "wine_enterprises",
    "name": "Wine Enterprises",
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
    "file_pattern": "Wine Enterprises*.xlsx",
}
