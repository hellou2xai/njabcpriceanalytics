"""
M S Walker — wholesaler config.

Files: "M S WALKER*.xlsx" — e.g. "M S WALKER_NJ FINAL JUNE 2026 PRICING.xlsx"
       (edition from the filename month name + 4-digit year).
Sheets: standard NJ ABC eCPL workbook.
Notes:
  - Standard NJ ABC eCPL template (header row 6). Mixed-case types
    (Wine/WINE, Spirits/SPIRITS) normalized; "Intoxicating Hemp Beverage" passes
    through. A few no-discount rows leave BEST blank -> best-from-frontline.
"""


def _fill_best_from_frontline(parser, result):
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
    "slug": "ms_walker",
    "name": "M S Walker",
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
    },
    "skip_sheets": ["terms"],
    "file_pattern": "M S WALKER*.xlsx",
    "post_process": _fill_best_from_frontline,
}
