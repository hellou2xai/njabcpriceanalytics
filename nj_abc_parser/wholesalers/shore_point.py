"""
Shore Point Distributors — wholesaler config.

Files: "Shore Point*.xlsx" — e.g. "Shore Point eCPL June 2026.xlsx"
       Future loads: keep "Shore Point" + month name + 4-digit year in the
       filename (the raw "upload_June" name has no year, so the edition
       cannot be parsed — rename before dropping into Data/).
Sheets: TERMS and CONDITIONS, CPL, RIP, COMBO, BEER MIX and MATCH
Notes:
  - Standard NJ ABC template, header row at row 6
  - 3 discount tiers, 2 RIP tiers
  - Primarily beer + spirits; unit types uppercase ("BOTTLE", "CAN", "KEG")
  - COMBO / BEER MM sheets carry extra unheadered trailing columns
    (run dates, internal codes) — ignored by the header-mapped parser
"""

CONFIG = {
    "slug": "shore_point",
    "name": "Shore Point Distributors",
    "header_row_hint": 6,
    "discount_tiers": 3,
    "rip_tiers": 2,
    "product_type_map": {
        "BEER": "Beer",
        "DISTILLED SPIRITS": "Spirits",
        "SPIRITS": "Spirits",
        "LIQUOR": "Spirits",
        "WINE": "Wine",
        "CIDER": "Cider",
        "HEMP": "Hemp",
    },
    "skip_sheets": ["terms"],
    "file_pattern": "Shore Point*.xlsx",
}
