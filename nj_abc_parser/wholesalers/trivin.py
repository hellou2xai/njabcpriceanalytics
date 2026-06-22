"""
Trivin (Trinchero / imports) — wholesaler config.

Files: "TRIVIN*.xlsx" — e.g. "TRIVIN_NJ CPL June - 5.15.2026.xlsx"
       (edition from the filename month name + 4-digit year).
Sheets: TERMS and CONDITIONS, CPL, RIP, COMBO, BEER MIX and MATCH.
Notes:
  - Standard NJ ABC eCPL template (header row 6; 3 discount tiers, 2 RIP tiers).
  - QUIRK: leaves BEST price blank on no-discount rows (~30%) -> best-from-
    frontline post_process so effective_case_price isn't 0.
  - GRANULAR product types (Red Wine, White Wine, Rose, Tequila, Bourbon, ...);
    the map normalizes them to the canonical labels.
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
    "slug": "trivin",
    "name": "Trivin",
    "header_row_hint": 6,
    "discount_tiers": 3,
    "rip_tiers": 2,
    "product_type_map": {
        # Wine (still / fortified / flavored all roll up to Wine)
        "RED WINE": "Wine", "WHITE WINE": "Wine", "ROSE": "Wine",
        "FLAVORED WINE": "Wine", "DESSERT WINE": "Wine", "SANGRIA": "Wine",
        "PORT": "Wine", "SHERRY": "Wine", "WINE": "Wine",
        # Sparkling
        "SPARKLING": "Sparkling", "SPARKLING ROSE": "Sparkling", "SEMI SPARKLING": "Sparkling",
        # Spirits (all distilled categories)
        "LIQUEUR": "Spirits", "LIQUOR": "Spirits", "BRANDY": "Spirits", "GIN": "Spirits",
        "WHISKEY IRISH": "Spirits", "WHISKY JAPANESE": "Spirits", "WHISKY CANADIAN": "Spirits",
        "RUM": "Spirits", "BOURBON": "Spirits", "SCOTCH": "Spirits", "VODKA": "Spirits",
        "COGNAC": "Spirits", "CACHACA": "Spirits", "GRAPPA": "Spirits", "MEZCAL": "Spirits",
        "TEQUILA": "Spirits", "POITIN": "Spirits", "BITTERS": "Spirits",
        "VERMOUTH": "Vermouth", "SAKE": "Sake", "BEER": "Beer", "CIDER": "Cider",
        "READY TO DRINK": "RTD", "RTD": "RTD",
        "N/A": None, "#N/A": None,
    },
    "skip_sheets": ["terms"],
    "file_pattern": "TRIVIN*.xlsx",
    "post_process": _fill_best_from_frontline,
}
