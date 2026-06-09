"""
Kramer Beverage Co. — wholesaler config.

Files: "Kramer*.xlsx" — e.g. "Kramer_June_2026 ecpl amend 5-18.xlsx"
       Future loads: keep "Kramer" + month name + 4-digit year in the filename
       (edition is parsed from the filename, e.g. "Kramer July 2026 eCPL.xlsx").
Sheets: TERMS and CONDITIONS, CPL, RIP, COMBO, BEER MIX and MATCH
Notes:
  - Standard NJ ABC template, header row at row 6
  - 3 discount tiers, 2 RIP tiers
  - Primarily a beer distributor (domestic/craft/import) + RTD/FMB/cider
  - Unit types lowercase ("keg", "can", "bottle", "pet")
  - UNIQUE QUANTITY-DISCOUNT FORMAT: unlike every other distributor (which packs
    a SKU's tiers into the discount_1..5 COLUMNS of one CPL line), Kramer lists
    each tier on its OWN line — same UPC/size/window repeated, one discount per
    row, discount_2..5 always blank. Left as-is, derive.py collapses those
    sibling lines to one row and keeps a single tier, so the ladder showed 1 of
    N tiers and best/effective came off the wrong line. The `post_process` hook
    below consolidates each SKU's per-line tiers (across rows AND columns) into
    the canonical one-row-per-SKU-per-window shape the rest of the pipeline
    expects, and recomputes best_case_price as frontline minus the deepest
    discount IN THAT window (Kramer's source repeats the global best on every
    line, which is wrong once the windows are separated).
"""
import logging
import re

logger = logging.getLogger("nj_abc_parser")


def _qty_lead_int(s) -> int:
    """Leading integer of a discount-qty string ('50 cases' -> 50). Big sentinel
    when unparseable, so it sorts last."""
    m = re.match(r"^\s*(\d+(?:\.\d+)?)", str(s if s is not None else ""))
    return int(float(m.group(1))) if m else 10**9


def _consolidate_cpl_tiers(parser, result):
    """Fold Kramer's one-tier-per-line CPL into one row per (SKU + validity
    window) with the tiers in discount_1..5 and a per-window best_case_price.

    Grouping includes product_name + window so we never merge two products that
    share a keg UPC, nor merge a dated promo into the full-month line."""
    import pandas as pd

    df = result.get("cpl")
    if df is None or getattr(df, "empty", True):
        return result

    key_cols = ["upc", "product_name", "unit_volume", "unit_qty",
                "vintage", "from_date", "to_date"]
    for k in key_cols:
        if k not in df.columns:
            df[k] = None

    out_rows = []
    merged_groups = 0
    for _, grp in df.groupby(key_cols, dropna=False, sort=False):
        base = grp.iloc[0].to_dict()
        if len(grp) > 1:
            merged_groups += 1
        # gather every eligible tier across ALL rows and ALL discount columns
        tiers: dict[tuple, tuple] = {}
        for _, r in grp.iterrows():
            for i in range(1, 6):
                q = r.get(f"discount_{i}_qty")
                a = r.get(f"discount_{i}_amt")
                try:
                    af = float(a)
                except (TypeError, ValueError):
                    continue
                if af != af or af <= 0:  # NaN or non-positive
                    continue
                qs = str(q).strip() if q is not None else ""
                tiers[(qs, round(af, 4))] = (_qty_lead_int(qs), qs, af)
        # rebuild the discount columns
        for i in range(1, 6):
            base[f"discount_{i}_qty"] = None
            base[f"discount_{i}_amt"] = None
        tier_list = sorted(tiers.values(), key=lambda t: (t[0], t[2]))
        if tier_list:
            # 5 columns only: keep the reachable low-qty tiers plus the single
            # deepest so the best deal is always visible. best_case_price below
            # still reflects the true deepest across ALL tiers.
            if len(tier_list) > 5:
                deepest = max(tier_list, key=lambda t: t[2])
                chosen = sorted(set(tier_list[:4] + [deepest]), key=lambda t: (t[0], t[2]))
                logger.info(
                    "[kramer] %s: %d QD tiers exceed 5 columns; kept low-qty + "
                    "deepest (best_case_price still uses the true deepest)",
                    base.get("product_name"), len(tier_list))
            else:
                chosen = tier_list
            for idx, (_, qs, af) in enumerate(chosen[:5], start=1):
                base[f"discount_{idx}_qty"] = qs
                base[f"discount_{idx}_amt"] = af
            # per-window best = frontline minus the deepest discount in THIS window
            try:
                fcp = float(base.get("frontline_case_price"))
            except (TypeError, ValueError):
                fcp = None
            max_amt = max(t[2] for t in tier_list)
            if fcp is not None and max_amt > 0:
                best = round(fcp - max_amt, 2)
                base["best_case_price"] = best
                try:
                    fup = float(base.get("frontline_unit_price"))
                except (TypeError, ValueError):
                    fup = None
                if fcp > 0 and fup is not None:
                    base["best_unit_price"] = round(best * (fup / fcp), 2)
        out_rows.append(base)

    new_df = pd.DataFrame(out_rows, columns=list(df.columns))
    logger.info("[kramer] CPL consolidated %d -> %d rows (%d multi-line SKUs merged)",
                len(df), len(new_df), merged_groups)
    result["cpl"] = new_df.reset_index(drop=True)
    return result


CONFIG = {
    "slug": "kramer",
    "name": "Kramer Beverage Co.",
    "header_row_hint": 6,
    "discount_tiers": 3,
    "rip_tiers": 2,
    "post_process": _consolidate_cpl_tiers,
    "product_type_map": {
        "BEER DOMESTIC": "Beer",
        "BEER CRAFT": "Beer",
        "BEER IMPORT": "Beer",
        "BEER": "Beer",
        "APPLE CIDER": "Cider",
        "CIDER": "Cider",
        "WINE STILL": "Wine",
        "WINE": "Wine",
        "WINE SPARKLING": "Sparkling",
        "SPARKLING": "Sparkling",
        "LIQUOR": "Spirits",
        "SPIRITS": "Spirits",
        "DISTILLED SPIRITS": "Spirits",
        "READY TO DRINK COCKTAILS": "RTD",
        "FLAVORED MALT BEVERAGE": "FAB",
        "HEMP THC": "Hemp",
        "HEMP": "Hemp",
    },
    "skip_sheets": ["terms"],
    "file_pattern": "Kramer*.xlsx",
}
