"""Audit combo component matching: where does the item WE matched differ from
the item the COMBO SHEET lists, and does our calculated savings match the sheet?

Writes analysis/combo_item_match_audit.xlsx with sheets:
  - Item Mismatches : one row per combo component whose matched catalog item does
                      NOT agree (by brand/name) with the sheet line, or that we
                      could not resolve at all.
  - Savings Check   : one row per combo — sheet (advertised) savings vs our
                      calculated savings, with match flag + variance.
  - All Components   : every resolved component (sheet item vs matched item).

Run:  python analysis/combo_item_match_audit.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import backend.cache_util as cu                                   # noqa: E402
from backend.routers.deals import get_combos, _combo_name_sim    # noqa: E402

EDITIONS = ["2026-06", "2026-07"]
NAME_OK = 0.6          # brand-aware name similarity below this = different item
PRICE_TOL = 0.03       # sheet vs matched frontline within 3% = price agrees


def _norm_upc(u) -> str:
    return str(u or "").lstrip("0")


def _is_code_name(s) -> bool:
    """A combo-feed product_name that is really a numeric/brand-reg CODE (Fedway,
    Opici), so a name mismatch against it is the SHEET's fault, not ours."""
    s = re.sub(r"[^a-z0-9]", "", str(s or "").lower())
    return bool(s) and sum(ch.isdigit() for ch in s) / len(s) > 0.6


def _classify(matched_name, nsim, price_ok, sheet_bad) -> str:
    """sheet_bad = the sheet's product_name is unreliable (a numeric code, or a
    placeholder label Fedway repeats across many combos), so a name mismatch is
    the SHEET's fault — price is then the only thing that can confirm our match."""
    if matched_name is None:
        return "UNRESOLVED (no catalog match)"
    if nsim is not None and nsim >= NAME_OK:
        return "ok"
    if sheet_bad:
        return ("OK (sheet name unreliable; price confirms our match)" if price_ok
                else "REVIEW (sheet name unreliable AND price differs)")
    if price_ok is False:
        return "WRONG ITEM (name AND price differ)"
    return "REVIEW (name differs; price agrees)"


def main() -> None:
    comp_rows: list[dict] = []      # every resolved component
    mismatch_rows: list[dict] = []  # wrong-item or unresolved components
    savings_rows: list[dict] = []   # per-combo savings check

    # Pre-pass: a combo-sheet product_name reused across MANY combos is a Fedway
    # placeholder label (e.g. 'WOODFORD DOUBLE OAK W/BARREL' on every '0' line),
    # not a real item name — flag those so a name mismatch against them is the
    # SHEET's fault, not ours. (Cache persists across the two passes — no clear.)
    from collections import defaultdict
    cu.clear()
    name_to_codes: dict = defaultdict(set)
    for ed in EDITIONS:
        for c in get_combos(edition=ed, limit=100000):
            for comp in (c.get("components") or []):
                nm = comp.get("feed_product_name") or comp.get("product_name")
                if nm:
                    name_to_codes[nm].add((c["wholesaler"], str(c["combo_code"])))
    placeholder_names = {nm for nm, codes in name_to_codes.items() if len(codes) >= 4}

    for ed in EDITIONS:
        combos = get_combos(edition=ed, limit=100000)
        for c in combos:
            if c.get("is_volume_ladder"):
                continue
            ws = c["wholesaler"]
            code = str(c["combo_code"])
            e = c.get("economics") or {}
            verdict = e.get("verdict")
            adv = e.get("advertised_savings")
            ours = e.get("save_vs_frontline")
            ours_sep = e.get("save_vs_separate")

            # ---- savings check (per combo) ----
            if adv is not None and ours is not None:
                var = round(ours - adv, 2)
                sav_match = abs(var) <= max(1.0, abs(adv) * PRICE_TOL)
            else:
                var = None
                sav_match = None
            savings_rows.append({
                "month": ed, "distributor": ws, "combo_code": code,
                "verdict": verdict,
                "sheet_savings": adv,
                "our_savings_vs_frontline": ours,
                "our_savings_vs_separate": ours_sep,
                "savings_match": ("YES" if sav_match else ("NO" if sav_match is False else "N/A")),
                "variance": var,
                "components_total": e.get("components_total"),
                "components_priced": e.get("components_priced"),
                "unverified_reason": e.get("unverified_reason"),
                "comments": c.get("comments"),
            })

            # ---- per-component item match ----
            resolved = e.get("components") or []
            # keys of resolved feed lines, to find which feed lines went unresolved
            resolved_keys = set()
            for comp in resolved:
                sheet_name = comp.get("sheet_name")
                sheet_upc = _norm_upc(comp.get("sheet_upc"))
                sheet_qty = str(comp.get("sheet_qty") or "")
                resolved_keys.add((sheet_name, sheet_upc, sheet_qty))
                matched_name = comp.get("product_name")
                matched_upc = _norm_upc(comp.get("upc"))
                sheet_fe = comp.get("sheet_frontline_each")
                our_fe = comp.get("best_separate_each")  # our frontline-ish per unit
                nsim = round(_combo_name_sim(sheet_name, matched_name), 3)
                # price agreement: sheet per-unit frontline vs our resolved per-unit
                price_ok = None
                if sheet_fe and our_fe:
                    price_ok = abs(our_fe - sheet_fe) / sheet_fe <= PRICE_TOL
                upc_same = (sheet_upc == matched_upc) if sheet_upc else None
                item_ok = nsim >= NAME_OK
                sheet_bad = _is_code_name(sheet_name) or (sheet_name in placeholder_names)
                cause = _classify(matched_name, nsim, price_ok, sheet_bad)
                row = {
                    "month": ed, "distributor": ws, "combo_code": code,
                    "sheet_item": sheet_name, "sheet_upc": comp.get("sheet_upc"),
                    "sheet_qty": comp.get("sheet_qty"),
                    "sheet_frontline_each": sheet_fe,
                    "matched_item": matched_name, "matched_upc": matched_upc,
                    "matched_vintage": comp.get("vintage"),
                    "matched_bottles_per_case": comp.get("bottles_per_case"),
                    "our_frontline_each": (round(our_fe, 2) if our_fe is not None else None),
                    "name_similarity": nsim,
                    "upc_same": upc_same,
                    "price_agrees": price_ok,
                    "sheet_name_unreliable": sheet_bad,
                    "item_match": "YES" if item_ok else "NO",
                    "assessment": cause,
                }
                comp_rows.append(row)
                if not item_ok:
                    mismatch_rows.append(dict(row, status=cause))

            # feed lines that resolved to nothing
            for comp in (c.get("components") or []):
                key = (comp.get("feed_product_name") or comp.get("product_name"),
                       _norm_upc(comp.get("upc")), str(comp.get("qty_per_pack") or ""))
                if key in resolved_keys:
                    continue
                mismatch_rows.append({
                    "month": ed, "distributor": ws, "combo_code": code,
                    "sheet_item": comp.get("feed_product_name") or comp.get("product_name"),
                    "sheet_upc": comp.get("upc"), "sheet_qty": comp.get("qty_per_pack"),
                    "sheet_frontline_each": comp.get("frontline_price_each"),
                    "matched_item": None, "matched_upc": None, "matched_vintage": None,
                    "matched_bottles_per_case": None, "our_frontline_each": None,
                    "name_similarity": None, "upc_same": None, "price_agrees": None,
                    "sheet_name_unreliable": (_is_code_name(comp.get("feed_product_name") or comp.get("product_name"))
                                              or ((comp.get("feed_product_name") or comp.get("product_name")) in placeholder_names)),
                    "item_match": "NO", "assessment": "UNRESOLVED (no catalog match)",
                    "status": "UNRESOLVED (no catalog match)",
                })

    df_mismatch = pd.DataFrame(mismatch_rows)
    df_sav = pd.DataFrame(savings_rows)
    df_all = pd.DataFrame(comp_rows)

    # order: mismatches by month, distributor, combo
    for df in (df_mismatch, df_sav, df_all):
        if not df.empty:
            df.sort_values([c for c in ("month", "distributor", "combo_code") if c in df.columns],
                           inplace=True, kind="stable")

    out = ROOT / "analysis" / "combo_item_match_audit.xlsx"
    with pd.ExcelWriter(out, engine="openpyxl") as xl:
        (df_mismatch if not df_mismatch.empty else pd.DataFrame([{"note": "no item mismatches"}])
         ).to_excel(xl, sheet_name="Item Mismatches", index=False)
        df_sav.to_excel(xl, sheet_name="Savings Check", index=False)
        df_all.to_excel(xl, sheet_name="All Components", index=False)
        # autosize columns
        for ws_name, df in (("Item Mismatches", df_mismatch), ("Savings Check", df_sav), ("All Components", df_all)):
            sh = xl.book[ws_name]
            for col in sh.columns:
                width = max((len(str(c.value)) for c in col if c.value is not None), default=10)
                sh.column_dimensions[col[0].column_letter].width = min(width + 2, 48)

    # console summary
    print(f"wrote {out}")
    print("  item-mismatch rows by assessment:")
    if not df_mismatch.empty:
        for cause, n in df_mismatch["status"].value_counts().items():
            print(f"     {n:>4}  {cause}")
    sav_no = int((df_sav["savings_match"] == "NO").sum())
    sav_yes = int((df_sav["savings_match"] == "YES").sum())
    print(f"  savings check   : {sav_yes} match, {sav_no} mismatch, "
          f"{int((df_sav['savings_match']=='N/A').sum())} n/a (unknown)")


if __name__ == "__main__":
    main()
