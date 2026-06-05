"""The money gate. Code only, no LLM, no exceptions.

Every plan line is re-verified against the catalog and the store's data:
prices are REPLACED with the catalog's number (the model's copy is never
trusted for money), then the vetoes run. Vetoed lines are kept and surfaced -
showing what was rejected is half the trust story.
"""

from backend.assistant import _STOCKING_FLOOR_PCT
from backend.db import get_duckdb
from backend.pg import get_pg

from .config import MAX_CASES_PER_LINE, MIN_GP


def _norm(upc) -> str:
    """House UPC normalization: leading zeros stripped (matches the
    LTRIM(CAST(upc AS VARCHAR),'0') convention used across the backend).
    Joins between model output / POS rows / catalog must NEVER depend on a
    model echoing an identifier byte-for-byte."""
    return str(upc or "").strip().lstrip("0")


def _catalog_rows(lines: list[dict]) -> dict:
    """{(normalized_upc, wholesaler): catalog row} for the latest edition.
    The row carries the CANONICAL catalog upc, which replaces whatever the
    model wrote."""
    keys = {(_norm(l["upc"]), l["chosen_wholesaler"]) for l in lines}
    upcs = sorted({k[0] for k in keys if k[0]})
    wss = sorted({k[1] for k in keys})
    if not upcs or not wss:
        return {}
    phu = ",".join("?" * len(upcs))
    phw = ",".join("?" * len(wss))
    with get_duckdb() as con:
        rows = con.execute(f"""
            SELECT LTRIM(CAST(upc AS VARCHAR),'0') un, upc, wholesaler,
                   product_name, unit_volume, unit_qty,
                   frontline_case_price, effective_case_price
            FROM cpl_enriched
            WHERE edition = (SELECT MAX(edition) FROM cpl_enriched)
              AND LTRIM(CAST(upc AS VARCHAR),'0') IN ({phu})
              AND wholesaler IN ({phw})
            QUALIFY ROW_NUMBER() OVER (
                PARTITION BY LTRIM(CAST(upc AS VARCHAR),'0'), wholesaler
                ORDER BY effective_case_price) = 1
        """, upcs + wss).fetchall()
    cols = ["un", "upc", "wholesaler", "product_name", "unit_volume", "unit_qty",
            "frontline_case_price", "effective_case_price"]
    return {(r[0], r[2]): dict(zip(cols, r)) for r in rows}


def _store_retail(store_id: int, upcs: list[str]) -> dict[str, float]:
    """{normalized_upc: retail} from the POS feed."""
    if not upcs:
        return {}
    with get_pg() as pg:
        rows = pg.execute(
            "SELECT LTRIM(upc,'0') un, MAX(unit_retail) r FROM pos_sales_daily "
            "WHERE store_id=%s GROUP BY 1", (store_id,)).fetchall()
    wanted = {_norm(u) for u in upcs}
    return {r["un"]: float(r["r"]) for r in rows if r["r"] and r["un"] in wanted}


def _cart_upcs(user_id: int) -> set[str]:
    """UPCs the USER has in the active cart. A previous agent-proposal batch
    is excluded: stage_draft replaces it wholesale, so vetoing against it
    would block every re-run on its own output."""
    from .cart_stage import BATCH_SOURCE
    with get_pg() as pg:
        rows = pg.execute(
            "SELECT DISTINCT LTRIM(upc,'0') un FROM cart_items WHERE user_id=%s "
            "AND COALESCE(saved_for_later,0)=0 AND upc IS NOT NULL "
            "AND COALESCE(batch_source,'') <> %s", (user_id, BATCH_SOURCE)).fetchall()
    return {r["un"] for r in rows}


def apply_gate(user_id: int, store_id: int, lines: list[dict]) -> tuple[list, list]:
    """Returns (kept, vetoed). Kept lines gain catalog-verified fields:
    product_name, unit_volume, verified price, bottles/case, gp_pct."""
    catalog = _catalog_rows(lines)
    retail = _store_retail(store_id, [l["upc"] for l in lines])
    in_cart = _cart_upcs(user_id)
    seen: set[str] = set()
    kept, vetoed = [], []

    for line in lines:
        un, ws = _norm(line["upc"]), line["chosen_wholesaler"]
        cat = catalog.get((un, ws))
        if cat is None:
            vetoed.append({**line, "veto_reason": "unknown_product",
                           "veto_detail": f"no {ws} listing for {line['upc']} in the current edition"})
            continue
        if un in seen:
            vetoed.append({**line, "veto_reason": "duplicate_line",
                           "veto_detail": "UPC already proposed earlier in this plan"})
            continue
        seen.add(un)
        if un in in_cart:
            vetoed.append({**line, "veto_reason": "already_in_cart",
                           "veto_detail": "item is in the active cart"})
            continue
        # Money fields and identifiers both come from the CATALOG row from
        # here on; the model's copies are discarded.
        line["upc"] = cat["upc"]

        eff = float(cat["effective_case_price"] or 0)
        front = float(cat["frontline_case_price"] or 0)
        line["effective_case_price"] = eff  # never trust the model with money
        if front > 0 and eff < front * _STOCKING_FLOOR_PCT:
            vetoed.append({**line, "veto_reason": "stocking_floor",
                           "veto_detail": f"effective ${eff:.2f} is below "
                                          f"{int(_STOCKING_FLOOR_PCT*100)}% of frontline ${front:.2f}"})
            continue

        gp = None
        unit_retail = retail.get(un)
        bpc = int(cat["unit_qty"] or 0)
        if unit_retail and bpc and eff > 0:
            retail_case = unit_retail * bpc
            gp = (retail_case - eff) / retail_case
            if gp < MIN_GP:
                vetoed.append({**line, "veto_reason": "gp_floor",
                               "veto_detail": f"GP {gp:.0%} below the {MIN_GP:.0%} floor "
                                              f"(retail ${unit_retail:.2f} x {bpc}/cs vs ${eff:.2f})"})
                continue

        cases = max(1, min(int(line.get("cases") or 1), MAX_CASES_PER_LINE))
        kept.append({**line, "cases": cases,
                     "product_name": cat["product_name"],
                     "unit_volume": cat["unit_volume"],
                     "bottles_per_case": bpc or None,
                     "gp_pct": round(gp, 3) if gp is not None else None})
    return kept, vetoed
