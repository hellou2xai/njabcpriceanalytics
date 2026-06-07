"""
Jersey Beverage Network LLC — wholesaler config.

Files: "JERSEY BEVERAGE*.xlsx" — e.g. "JERSEY BEVERAGE NETWORK LLC 06012026_June.xlsx"
       Future loads: keep "Jersey Beverage" + month name + 4-digit year in the
       filename (the MMDDYYYY blob also parses, but month name is safer).
Sheets: TERMS and CONDITIONS, CPL, RIP, COMBO, BEER MIX and MATCH
Notes:
  - Standard NJ ABC template, header row at row 6
  - 3 discount tiers, 2 RIP tiers
  - ~half the CPL rows have a BLANK UPC (internal Item Code instead) —
    kept as-is; derive layer tolerates them (no cross-source UPC links)
  - best_unit_price submitted as "$29.00" strings — handled by the
    currency-stripping coercion in base_parser
  - Rolling catalog: many rows are evergreen (to_date 12/31/2039),
    not month-scoped; duplicate trailing "Item Code" columns are unmapped
  - Beer-heavy craft/import book + RTD/seltzer/cider/non-alc
"""

def _backfill_rip_codes(parser, sheets):
    """Jersey Beverage leaves the CPL's RIP CODE column blank, but the RIP
    sheet explicitly lists every (code, UPC) pair. Backfill the CPL pointer
    so the derive layer's strict (code, UPC) join can attach the RIP.
    Multiple codes per UPC are space-joined (the Fedway multi-code
    convention, which derive already splits)."""
    cpl, rip = sheets.get("cpl"), sheets.get("rip")
    if cpl is None or rip is None:
        return None
    valid = rip[rip["upc"].notna() & (rip["upc"].astype(str).str.strip() != "")]
    code_by_upc = valid.groupby("upc")["rip_code"].apply(
        lambda s: " ".join(sorted({str(c).strip() for c in s if str(c).strip()}))
    )
    blank = cpl["rip_code"].isna() | (cpl["rip_code"].astype(str).str.strip() == "")
    cpl.loc[blank, "rip_code"] = cpl.loc[blank, "upc"].map(code_by_upc)
    return None


CONFIG = {
    "slug": "jersey_beverage",
    "name": "Jersey Beverage Network",
    "header_row_hint": 6,
    "discount_tiers": 3,
    "rip_tiers": 2,
    "product_type_map": {
        "CRAFT BEER": "Beer",
        "IMPORT BEER": "Beer",
        "AMERICAN BEER": "Beer",
        "BEER": "Beer",
        "FMB": "FAB",
        "WINE": "Wine",
        "SPIRITS": "Spirits",
        "LIQUOR": "Spirits",
        "RTD SPIRITS": "RTD",
        "SELTZER": "Seltzer",
        "HARD TEA": "Tea",
        "CIDER": "Cider",
        "HARD KOMBUCHA": "Kombucha",
        "HEMP": "Hemp",
        "NON-ALC BEER": "Non-Alc",
        "NON-ALC MIXERS": "Non-Alc",
        "COCKTAIL ADD": "Non-Alc",
        "WATER": "Non-Alc",
        "SODA": "Non-Alc",
        "ENERGY": "Non-Alc",
        "HYDRATION": "Non-Alc",
    },
    "skip_sheets": ["terms"],
    "file_pattern": ["JERSEY BEVERAGE*.xlsx", "Jersey Beverage*.xlsx"],
    "post_process": _backfill_rip_codes,
}
