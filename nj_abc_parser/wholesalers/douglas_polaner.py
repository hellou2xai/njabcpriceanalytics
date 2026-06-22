"""
Douglas Polaner Selections — wholesaler config.

Files: "DOUGLAS POLANER*.xlsx" — e.g. "DOUGLAS POLANER_6.2026_nj price filing-eCPL
       file.xlsx" where "6.2026" is M.YYYY (June 2026); the edition parser reads
       that dotted token from the filename.
Sheets: standard 5-sheet NJ ABC eCPL workbook.
Notes:
  - Standard NJ ABC eCPL template (header row 6; 3 discount tiers, 2 RIP tiers).
    Mostly Wine. A handful of no-discount rows leave BEST blank -> best-from-
    frontline post_process so effective_case_price isn't 0.
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
    "slug": "douglas_polaner",
    "name": "Douglas Polaner",
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
        "RTD": "RTD",
    },
    "skip_sheets": ["terms"],
    "file_pattern": "DOUGLAS POLANER*.xlsx",
    "post_process": _fill_best_from_frontline,
}
