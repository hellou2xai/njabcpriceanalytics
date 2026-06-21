"""
Other Brothers Brands, LLC (DBA Grape2Glass) — wholesaler config.

Files: "Other Brothers*.xlsx" — e.g. "Other Brothers NJABC-eCPL-July 2026.xlsx"
       (edition parsed from the filename's month name + 4-digit year).
Sheets: TERMS and CONDITIONS, CPL, RIP, COMBO, BEER MIX and MATCH.
Notes:
  - Standard NJ ABC eCPL template, header row at row 6 (auto-detected).
  - A small wine-focused importer (e.g. Portuguese wines). Product types arrive
    already canonical ("Wine"); the map below is a safety net for variants.
  - QUIRK: leaves BEST CASE/UNIT PRICE blank when a product has NO quantity
    discount (~36% of rows). Every other distributor fills best=frontline there.
    Left as-is, derive computes effective_case_price=0 for those products. The
    post_process below falls best -> frontline back when best is missing/0.
"""


def _fill_best_from_frontline(parser, result):
    """Fall back best_case/unit_price -> frontline where Other Brothers left it
    blank (no-discount products), so effective_case_price isn't 0 for them."""
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
    "slug": "other_brothers",
    "name": "Other Brothers (Grape2Glass)",
    "header_row_hint": 6,
    "discount_tiers": 3,
    "rip_tiers": 2,
    "product_type_map": {
        "WINE": "Wine",
        "WINE STILL": "Wine",
        "STILL WINE": "Wine",
        "WINE SPARKLING": "Sparkling",
        "SPARKLING": "Sparkling",
        "SPARKLING WINE": "Sparkling",
        "VERMOUTH": "Vermouth",
        "LIQUOR": "Spirits",
        "SPIRITS": "Spirits",
        "DISTILLED SPIRITS": "Spirits",
        "BEER": "Beer",
        "CIDER": "Cider",
        "READY TO DRINK COCKTAILS": "RTD",
        "FLAVORED MALT BEVERAGE": "FAB",
    },
    "skip_sheets": ["terms"],
    "file_pattern": "Other Brothers*.xlsx",
    "post_process": _fill_best_from_frontline,
}
