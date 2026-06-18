"""
Fedway Associates, Inc — wholesaler config.

Files: "Fedway Associates {Year}-{MM} CPL.xlsx"
Sheets: TERMS and CONDITIONS, CPL, RIP, COMBO, BEER MIX and MATCH
Notes:
  - Standard 3 discount tiers (but often sparse — many items have no discounts)
  - Header row at row 5
  - Product types: Spirits (capitalized differently from Allied)
  - Has TERMS sheet (skip it)
  - Some items have $40,000 case price (single-bottle luxury items)
  - COMBO sheet quirk: the "Individual Products in Combo Pack" column carries
    internal item codes (e.g. "19240"), not names; and the "Comments" column
    carries the from_date echoed back as a timestamp ("2026-06-01 00:00:00").
    `_post_process_combo` below repairs both at ingest time using the CPL we
    just parsed (UPC join for real names, synthesised "qty x name / ..."
    bundle description into comments).
"""
import pandas as pd


def _post_process_combo(parser, sheets):
    """Repair Fedway's COMBO sheet against the CPL we just parsed.

    Three fixes, all driven by data already present in the same workbook:

    1. ``product_name`` — Fedway writes an item code here. Substitute the real
       product name from the CPL, joined by UPC. Falls through to the original
       value if no CPL row exists (so we never blank a row).
    2. ``comments`` — Fedway echoes the ``from_date`` here. Anything that
       parses as a date in the first ten characters is dropped to NULL.
    3. ``comments`` (synthesised) — once null, build a deterministic bundle
       description ("qty x name / ...") from the repaired components so the
       parquet itself carries a usable title for every downstream consumer.
       Skipped when the source still carries a real comment (other wholesalers
       are unaffected — this hook only runs for Fedway).
    """
    combo = sheets.get("combo")
    cpl = sheets.get("cpl")
    if combo is None or len(combo) == 0:
        return sheets

    # 1) Real product names via CPL UPC join.
    if cpl is not None and len(cpl) > 0:
        cpl_names = (
            cpl[cpl["product_name"].notna() & (cpl["product_name"] != "")]
            .drop_duplicates(subset=["upc"])
            .set_index("upc")["product_name"]
        )
        real = combo["upc"].map(cpl_names)
        combo["product_name"] = real.where(real.notna(), combo["product_name"])

    # 2) Date-poisoned comments → NULL. Fedway always writes the from_date here
    #    so we expect this to fire on every row, but be precise: only drop
    #    values whose first ten characters parse as a date.
    def _is_date_like(v):
        if not isinstance(v, str) or len(v) < 10:
            return False
        return pd.notna(pd.to_datetime(v[:10], errors="coerce"))

    mask_date = combo["comments"].apply(_is_date_like)
    if mask_date.any():
        combo.loc[mask_date, "comments"] = None

    # 3) Synthesise bundle description from components for combos that now have
    #    no comments. Group by combo_code, build "qty x name / ...", then
    #    broadcast back to every row of that combo (downstream readers pick
    #    the first non-null comment per combo).
    def _synth(grp):
        parts, seen = [], set()
        for _, r in grp.iterrows():
            name = r.get("product_name")
            qty = r.get("qty_per_pack")
            if not isinstance(name, str) or not name.strip():
                continue
            sig = (qty, name)
            if sig in seen:
                continue
            seen.add(sig)
            parts.append(f"{qty} x {name}" if qty else name)
        return " / ".join(parts) if parts else None

    null_mask = combo["comments"].isna() | (combo["comments"] == "")
    if null_mask.any():
        codes_to_fix = combo.loc[null_mask, "combo_code"].unique()
        for code in codes_to_fix:
            rows = combo[combo["combo_code"] == code]
            desc = _synth(rows)
            if desc:
                combo.loc[combo["combo_code"] == code, "comments"] = desc

    sheets["combo"] = combo
    return sheets


CONFIG = {
    "slug": "fedway",
    "name": "Fedway Associates",
    "header_row_hint": 5,
    "discount_tiers": 3,
    "rip_tiers": 2,
    "product_type_map": {
        "SPIRITS": "Spirits",
        "WINE": "Wine",
        "BEER": "Beer",
        "LIQUOR": "Spirits",
        "CANS & COCKTAILS": "RTD",
        "MALT PRODUCTS": "Malt",
        "COMBO PACKS": "Combo",
    },
    "skip_sheets": ["terms"],
    "file_pattern": "Fedway Associates*CPL*.xlsx",
    "post_process": _post_process_combo,
    # Fedway carries its internal item number in an unnamed CPL column right of
    # the last labelled header (column Z), one per product. Capture it as
    # dist_item_no so every Fedway product can show its item number.
    "cpl_dist_item_after_headers": True,
}
