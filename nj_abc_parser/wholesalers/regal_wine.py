"""
Regal Wine Imports — wholesaler config.

Files: "Regal*.xlsx" — e.g. "Regal_WIne_06-2026 NJ CPL June.xlsx"
       (edition parsed from the filename's month name + 4-digit year).
Sheets: TERMS and CONDITIONS, CPL, RIP, COMBO, BEER MIX and MATCH.
Notes:
  - Standard NJ ABC eCPL template (header row 6; 3 discount tiers, 2 RIP tiers).
    RIP headers are the verbose "RIP UNIT NO. 1" form (already in the map).
  - QUIRK: like Other Brothers, Regal leaves BEST CASE/UNIT PRICE blank on
    no-discount rows (~35%). The post_process falls best -> frontline so
    effective_case_price isn't 0 for them.
  - Product types arrive mixed-case ("Wine"/"wine"), plus a few stray values
    ("#N/A", "Cans", "Box"); the map normalizes (lookup is upper-cased).
"""


def _fill_best_from_frontline(parser, result):
    """Fall back best_case/unit_price -> frontline where Regal left it blank
    (no-discount products), so effective_case_price isn't 0 for them."""
    import pandas as pd
    df = result.get("cpl")
    if df is None or getattr(df, "empty", True):
        return result
    for best, front in (("best_case_price", "frontline_case_price"),
                        ("best_unit_price", "frontline_unit_price")):
        if best in df.columns and front in df.columns:
            b = pd.to_numeric(df[best], errors="coerce")
            f = pd.to_numeric(df[front], errors="coerce")
            need = b.isna() | (b <= 0)
            df.loc[need, best] = f[need]
    result["cpl"] = df
    return result


CONFIG = {
    "slug": "regal_wine",
    "name": "Regal Wine",
    "header_row_hint": 6,
    "discount_tiers": 3,
    "rip_tiers": 2,
    "product_type_map": {
        "WINE": "Wine",
        "STILL WINE": "Wine",
        "BOX": "Wine",
        "SPARKLING": "Sparkling",
        "SPARKLING WINE": "Sparkling",
        "VERMOUTH": "Vermouth",
        "SAKE": "Sake",
        "LIQUOR": "Spirits",
        "SPIRITS": "Spirits",
        "DISTILLED SPIRITS": "Spirits",
        "BEER": "Beer",
        "CANS": "Beer",
        "CIDER": "Cider",
        "READY TO DRINK COCKTAILS": "RTD",
        "RTD": "RTD",
        "FLAVORED MALT BEVERAGE": "FAB",
        "#N/A": None,
        "N/A": None,
    },
    "skip_sheets": ["terms"],
    "file_pattern": "Regal*.xlsx",
    "post_process": _fill_best_from_frontline,
}
