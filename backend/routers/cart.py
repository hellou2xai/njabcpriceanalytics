"""Cart API — one server-side cart per user.

Items group by their assigned sales rep. On add, the rep is auto-assigned when
the product's distributor has exactly one rep; otherwise it's left empty and the
user picks it in the cart (a distributor can have several reps). saved_for_later=1
parks an item in the "Save for later" section below the active cart. The
"send to all reps" step (turns each rep group into a submitted order) is added in
the Phase 3 order cutover.
"""
import re
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from backend.pg import get_pg
from backend.db import get_duckdb, NOW_UTC
from backend.auth import get_current_user
from backend.enrichment_join import attach_enrichment_image, attach_sku_mapping

router = APIRouter(prefix="/api/cart", tags=["cart"])


class CartItemIn(BaseModel):
    product_name: str
    wholesaler: str
    upc: Optional[str] = None
    unit_volume: Optional[str] = None
    combo_code: Optional[str] = None
    qty_cases: int = 0
    qty_units: int = 0
    # Optional batch tagging. When the same product is added under DIFFERENT
    # batch_ids it produces SEPARATE cart rows (per the user rule that two
    # sends must not mix). Single-product adds leave these NULL and keep the
    # original upsert-merge behaviour.
    batch_id: Optional[str] = None
    batch_label: Optional[str] = None
    batch_source: Optional[str] = None   # 'catalog_rip' | 'ai_rip' | 'manual' | ...


class CartBatchIn(BaseModel):
    """One server-side send of N items as a single labelled batch. The router
    generates a batch_id, stamps every item, and inserts them atomically so
    they show up together in the cart and can never be partially attributed."""
    batch_label: str
    batch_source: str
    items: list[CartItemIn]


class CartItemPatch(BaseModel):
    qty_cases: Optional[int] = None
    qty_units: Optional[int] = None
    sales_rep_id: Optional[int] = None
    saved_for_later: Optional[bool] = None
    notes: Optional[str] = None
    retail_price: Optional[float] = None
    # Chosen RIP program for the line (one UPC can sit under several rebates
    # that don't stack). Explicit null/'' resets to the default program.
    rip_choice: Optional[str] = None


class AssignRepIn(BaseModel):
    wholesaler: str
    sales_rep_id: Optional[int] = None


class ReorderIn(BaseModel):
    order_id: int


class FromListIn(BaseModel):
    list_id: int
    item_ids: Optional[list[int]] = None  # None/empty = every item in the list


class GroupNoteIn(BaseModel):
    wholesaler: str
    note: str = ""


class FromComboIn(BaseModel):
    wholesaler: str
    combo_code: str
    qty: int = 1   # how many of the bundle to add (multiplies each component's cases)


class SwapDistributorIn(BaseModel):
    from_distributor: str
    to_distributor: str
    rip_code: Optional[str] = None        # limit the swap to one RIP code's case mix
    upcs: Optional[list[str]] = None       # or to a specific set of (normalized) UPCs


class AddByRipIn(BaseModel):
    """Send every product in a (wholesaler, rip_code) Case Mix to the cart as
    one labelled batch. Used by the AI assistant's per-cluster button so the
    full member list is resolved server-side (the AI only ever sees the first
    25 in its tool output)."""
    wholesaler: str
    rip_code: str
    qty_cases_per_item: int = 0   # 0 = add at zero, let the user step them up


class SwitchDistributorIn(BaseModel):
    """Move ONE existing line to another distributor IN PLACE (same line, new
    house), keeping its quantity. The target must carry the same SKU."""
    wholesaler: str


def _default_rep_for(con, user_id: int, wholesaler: str):
    """Return the rep id when the distributor has exactly one rep, else None."""
    reps = con.execute(
        "SELECT id FROM sales_reps WHERE user_id=%s AND distributor=%s", (user_id, wholesaler)
    ).fetchall()
    return reps[0]["id"] if len(reps) == 1 else None


def _insert_cart_item(con, user_id, item: dict, rep_id):
    # Conflict key matches idx_cart_user_item_batch (db.py migration). Two rows
    # with the same product but different batch_ids stay separate; identical
    # batch_id rows merge their quantities (idempotent re-add within a batch);
    # NULL-batch rows still upsert into the single "no batch" slot per product.
    con.execute(
        f"""INSERT INTO cart_items
              (user_id, product_name, wholesaler, upc, unit_volume, combo_code,
               qty_cases, qty_units, sales_rep_id, saved_for_later,
               batch_id, batch_label, batch_source, rip_choice)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,0,%s,%s,%s,%s)
            ON CONFLICT (user_id, product_name, wholesaler, unit_volume,
                         COALESCE(batch_id, '')) DO UPDATE SET
              qty_cases = cart_items.qty_cases + EXCLUDED.qty_cases,
              qty_units = cart_items.qty_units + EXCLUDED.qty_units,
              rip_choice = COALESCE(EXCLUDED.rip_choice, cart_items.rip_choice),
              saved_for_later = 0,
              updated_at = {NOW_UTC}""",
        (user_id, item["product_name"], item["wholesaler"], item.get("upc"),
         item.get("unit_volume"), item.get("combo_code"),
         item.get("qty_cases", 0) or 0, item.get("qty_units", 0) or 0, rep_id,
         item.get("batch_id"), item.get("batch_label"), item.get("batch_source"),
         item.get("rip_choice")),
    )


def _attach_cart_pricing(dcon, items):
    """Enrich cart items with current-edition catalogue pricing + discount/RIP
    tiers, so the cart shows the same deal info as the catalogue and the user can
    adjust quantities to hit a tier before sending."""
    if not items:
        return
    import math as _m
    from backend.db import read_parquet
    from backend.routers.catalog import _attach_discount_rip_tiers
    src = read_parquet(dcon, "cpl_enriched")
    norms = sorted({str(it.get("upc") or "").lstrip("0") for it in items if it.get("upc")})
    pmap = {}   # full key (wholesaler, upc, name, volume) -> catalogue row
    nmap = {}   # (wholesaler, upc, name) -> row: a barcode can map to several products,
    umap = {}   # (wholesaler, upc) -> row: last-resort match on barcode alone
    if norms:
        ph = ", ".join(f"$p{i}" for i in range(len(norms)))
        prm = {f"p{i}": u for i, u in enumerate(norms)}
        try:
            df = dcon.execute(f"""
                WITH latest AS (SELECT wholesaler, MAX(edition) AS ed FROM {src} GROUP BY wholesaler)
                SELECT e.wholesaler AS w, LTRIM(e.upc,'0') AS un, e.product_name AS pn, e.unit_volume AS uv,
                       e.frontline_case_price AS fcp, e.frontline_unit_price AS fup,
                       e.effective_case_price AS ecp, e.unit_qty AS uq, e.unit_type AS ut,
                       e.vintage AS vtg,
                       e.has_discount AS hd, e.has_rip AS hr, e.has_closeout AS hc,
                       e.discount_pct AS dp, e.total_savings_per_case AS ts,
                       CAST(e.rip_code AS VARCHAR) AS rc,
                       e.edition AS ed,
                       e.discount_1_qty AS d1q, e.discount_1_amt AS d1a,
                       e.discount_2_qty AS d2q, e.discount_2_amt AS d2a,
                       e.discount_3_qty AS d3q, e.discount_3_amt AS d3a,
                       e.discount_4_qty AS d4q, e.discount_4_amt AS d4a,
                       e.discount_5_qty AS d5q, e.discount_5_amt AS d5a
                FROM {src} e JOIN latest l ON e.wholesaler=l.wholesaler AND e.edition=l.ed
                WHERE e.upc_norm IN ({ph})
            """, prm).fetchdf()
            for _, r in df.iterrows():
                pmap[(r["w"], str(r["un"]), r["pn"] or "", r["uv"] or "")] = r
                nmap.setdefault((r["w"], str(r["un"]), r["pn"] or ""), r)
                # Barcode-alone fallback ONLY for real barcodes: a placeholder
                # ('' after lstrip, short stubs) is shared by thousands of
                # rows, so this map would price a line off a RANDOM product.
                if len(str(r["un"])) >= 8:
                    umap.setdefault((r["w"], str(r["un"])), r)
        except Exception:
            pmap = {}; nmap = {}; umap = {}

    def cl(v):
        if v is None or (isinstance(v, float) and _m.isnan(v)):
            return None
        return float(v) if isinstance(v, (int, float)) else v

    for it in items:
        un = str(it.get("upc") or "").lstrip("0")
        r = pmap.get((it["wholesaler"], un, it.get("product_name") or "", it.get("unit_volume") or ""))
        if r is None:
            r = nmap.get((it["wholesaler"], un, it.get("product_name") or ""))  # name match, any size
        if r is None:
            r = umap.get((it["wholesaler"], un))   # last resort: barcode alone
        if r is not None:
            it["frontline_case_price"] = cl(r["fcp"])
            it["frontline_unit_price"] = cl(r["fup"])
            # Fields attach_tiers needs to build the discount/RIP ladder (edition
            # for the RIP-sheet join, the per-tier discount columns, and the
            # cluster code). Without these the cart tiers come back empty.
            it["edition"] = r["ed"]
            for i in range(1, 6):
                it[f"discount_{i}_qty"] = r.get(f"d{i}q")
                it[f"discount_{i}_amt"] = cl(r.get(f"d{i}a"))
            ecp = cl(r["ecp"])
            it["effective_case_price"] = ecp
            try:                                  # unit_qty (bottles/case) is stored as text
                uq = float(r["uq"])
                uq = None if _m.isnan(uq) else uq
            except Exception:
                uq = None
            it["unit_qty"] = uq
            vtg = r.get("vtg")
            if vtg is None or (isinstance(vtg, float) and _m.isnan(vtg)):
                it["vintage"] = None
            else:
                vs = str(vtg).strip()
                it["vintage"] = vs if vs and vs.lower() not in ("none", "nan", "0", "") else None
            it["unit_type"] = r.get("ut")   # container (bottle/can/keg) for the UI
            it["effective_unit_price"] = round(ecp / uq, 2) if (ecp and uq) else cl(r["fup"])
            it["has_discount"] = bool(r["hd"])
            it["has_rip"] = bool(r["hr"])
            it["has_closeout"] = bool(r["hc"])
            it["discount_pct"] = cl(r["dp"])
            it["total_savings_per_case"] = cl(r["ts"])
            # rip_code: surface the RIP this line belongs to so the cart UI can
            # group lines that share a rebate. Empty / sentinel values become None.
            rc = r.get("rc")
            if rc is None or (isinstance(rc, float) and _m.isnan(rc)):
                it["rip_code"] = None
            else:
                rc_s = str(rc).strip()
                it["rip_code"] = rc_s if rc_s and rc_s.lower() not in ("none", "nan", "0", "") else None
    # Every item MUST carry an `edition` key: pricing._lookup_rips reads
    # rec["edition"] directly, so a single unmatched line (no catalogue row, so
    # no edition set above) raised KeyError and aborted the WHOLE tier pass —
    # silently emptying tiers for every line after it. Default the unmatched.
    for it in items:
        it.setdefault("edition", None)
    try:
        _attach_discount_rip_tiers(dcon, items)  # adds a `tiers` list per item
    except Exception:
        pass
    try:
        _attach_combo_pricing(dcon, items)        # bundle pricing must never break the cart
    except Exception:
        pass


def _attach_combo_pricing(dcon, items):
    """Price bundle lines at the combo price ONLY while the whole combo is still in
    the cart. When a member is removed the remaining lines fall back to their regular
    (individual discount/RIP) price and lose the combo flag; re-adding the member
    restores combo pricing. Sets it['combo_intact'] for every combo line."""
    import math as _m
    from backend.db import read_parquet

    combo_lines = [it for it in items
                   if it.get("combo_code") and str(it.get("combo_code")) not in ("", "0")]
    for it in combo_lines:
        it["combo_intact"] = False
    if not combo_lines:
        return

    codes = sorted({str(it["combo_code"]) for it in combo_lines})
    combo_src = read_parquet(dcon, "combo")
    members: dict[tuple, set] = {}                 # (wholesaler, code) -> {component upcs}
    price: dict[tuple, tuple] = {}                 # (wholesaler, code, upc) -> (combo_each, frontline_each)
    try:
        ph = ", ".join(f"$c{i}" for i in range(len(codes)))
        prm = {f"c{i}": c for i, c in enumerate(codes)}
        df = dcon.execute(f"""
            WITH latest AS (SELECT wholesaler, combo_code, MAX(edition) AS ed
                            FROM {combo_src} GROUP BY wholesaler, combo_code)
            SELECT DISTINCT c.wholesaler AS w, CAST(c.combo_code AS VARCHAR) AS cc,
                   LTRIM(c.upc,'0') AS un, c.combo_price_each AS cpe, c.frontline_price_each AS fpe
            FROM {combo_src} c JOIN latest l
              ON c.wholesaler=l.wholesaler AND c.combo_code=l.combo_code AND c.edition=l.ed
            WHERE CAST(c.combo_code AS VARCHAR) IN ({ph}) AND c.upc IS NOT NULL
        """, prm).fetchdf()
        for _, r in df.iterrows():
            key = (r["w"], str(r["cc"]))
            members.setdefault(key, set()).add(str(r["un"]))
            price[(r["w"], str(r["cc"]), str(r["un"]))] = (r["cpe"], r["fpe"])
    except Exception:
        return

    # A combo is intact when every component barcode is present in the cart.
    cart_upcs: dict[tuple, set] = {}
    for it in combo_lines:
        key = (it["wholesaler"], str(it["combo_code"]))
        cart_upcs.setdefault(key, set()).add(str(it.get("upc") or "").lstrip("0"))

    def num(v):
        try:
            f = float(v)
            return None if _m.isnan(f) else f
        except Exception:
            return None

    for it in combo_lines:
        key = (it["wholesaler"], str(it["combo_code"]))
        comp = members.get(key)
        if not comp or not comp.issubset(cart_upcs.get(key, set())):
            continue  # broken (or unknown) combo: keep the individual price, no sticker
        un = str(it.get("upc") or "").lstrip("0")
        pr = price.get((key[0], key[1], un))
        if not pr:
            continue
        cpe, fpe = num(pr[0]), num(pr[1])
        uq, fcp = it.get("unit_qty"), it.get("frontline_case_price")
        combo_case = None
        if cpe is not None and uq:                       # combo_price_each is per bottle
            combo_case = round(cpe * uq, 2)
        elif cpe is not None and fpe and fcp:            # fall back to the combo discount ratio
            combo_case = round(fcp * (cpe / fpe), 2)
        if combo_case is None:
            continue
        it["combo_intact"] = True
        it["effective_case_price"] = combo_case
        if cpe is not None:
            it["effective_unit_price"] = cpe
        if fcp is not None:
            it["total_savings_per_case"] = round(fcp - combo_case, 2)
        it["tiers"] = []            # the bundle is the deal; don't also show tier rows
        it["has_discount"] = False
        it["has_rip"] = False


def _attach_combo_suggestion(dcon, items):
    """For a NORMAL line (not already a combo), surface a combo the product is a
    member of: the bundle's pack price + the sheet's own total_savings, and a
    'great' flag. The combo SHEET is the source of the savings (we never recompute
    it). Lets the buyer discover 'this item is in a combo that saves $X'."""
    from backend.db import read_parquet
    src = read_parquet(dcon, "combo")
    keys = sorted({(it.get("wholesaler"), it.get("edition"), str(it.get("upc") or "").lstrip("0"))
                   for it in items
                   if not (it.get("combo_code") and str(it.get("combo_code")) not in ("", "0"))
                   and it.get("wholesaler") and it.get("edition")
                   and len(str(it.get("upc") or "").lstrip("0")) >= 8})
    if not keys:
        return
    rowlits = ", ".join("(?, ?, ?)" for _ in keys)
    params = [x for k in keys for x in k]
    try:
        rows = dcon.execute(
            f"SELECT wholesaler ws, edition ed, LTRIM(CAST(upc AS VARCHAR),'0') un, "
            f"CAST(combo_code AS VARCHAR) code, MAX(combo_pack_price) pack, MAX(total_savings) sav, "
            f"ANY_VALUE(comments) cmt "
            f"FROM {src} "
            f"WHERE (wholesaler, edition, LTRIM(CAST(upc AS VARCHAR),'0')) IN ({rowlits}) "
            f"  AND CAST(combo_code AS VARCHAR) NOT IN ('', '0', 'None', 'nan') "
            f"GROUP BY 1, 2, 3, 4", params).fetchdf().to_dict("records")
    except Exception:
        return
    best: dict = {}
    for r in rows:
        sav, pack = r.get("sav"), r.get("pack")
        try:
            sav = float(sav)
        except (TypeError, ValueError):
            continue
        if sav <= 0:
            continue
        k = (r["ws"], r["ed"], r["un"])
        prev = best.get(k)
        if prev is None or sav > prev["savings"]:
            regular = (float(pack) if pack else 0.0) + sav
            pct = round(sav / regular * 100, 1) if regular > 0 else 0.0
            cmt = str(r.get("cmt") or "")
            cmt = re.sub(r"^\s*contains:\s*", "", cmt, flags=re.I).strip()
            best[k] = {"combo_code": r["code"],
                       "pack_price": round(float(pack), 2) if pack else None,
                       "savings": round(sav, 2), "pct": pct, "great": pct >= 10,
                       "label": cmt[:70] or None}
    for it in items:
        un = str(it.get("upc") or "").lstrip("0")
        sug = best.get((it.get("wholesaler"), it.get("edition"), un))
        if sug:
            it["combo_suggestion"] = sug


def _attach_size_swap(dcon, items):
    """If another SIZE of the same product (same CELR family, same distributor +
    edition) is cheaper PER LITRE, surface it — the buyer can swap if size-flexible.
    Uses the QD buy price (cash today), skips minis (<200ml), and only fires when
    a real retail size is meaningfully cheaper per litre."""
    from backend.db import read_parquet
    from backend.size_std import _to_ml
    e_src = read_parquet(dcon, "cpl_enriched")
    celr_src = read_parquet(dcon, "celr_products")
    lines = [(it.get("wholesaler"), it.get("edition"), str(it.get("upc") or "").lstrip("0"), it)
             for it in items
             if not (it.get("combo_code") and str(it.get("combo_code")) not in ("", "0"))
             and it.get("wholesaler") and it.get("edition")
             and len(str(it.get("upc") or "").lstrip("0")) >= 8]
    if not lines:
        return
    keys = sorted({(w, ed, un) for w, ed, un, _ in lines})
    rl = ", ".join("(?, ?, ?)" for _ in keys)
    try:
        cpn_rows = dcon.execute(
            f"SELECT ct.ws ws, ct.ed ed, ct.un un, c.cpn cpn "
            f"FROM (VALUES {rl}) ct(ws, ed, un) JOIN {celr_src} c ON c.upc_norm = ct.un",
            [x for k in keys for x in k]).fetchdf().to_dict("records")
    except Exception:
        return
    cpn_of = {(r["ws"], r["ed"], r["un"]): r["cpn"] for r in cpn_rows}
    cpns = sorted({(r["ws"], r["ed"], r["cpn"]) for r in cpn_rows})
    if not cpns:
        return
    rl2 = ", ".join("(?, ?, ?)" for _ in cpns)
    try:
        sib = dcon.execute(
            f"SELECT cp.ws ws, cp.ed ed, cp.cpn cpn, e.product_name pn, "
            f"LTRIM(CAST(e.upc AS VARCHAR),'0') un, e.unit_volume uv, e.unit_qty uq, "
            f"e.best_case_price bcp, e.frontline_case_price fcp "
            f"FROM (VALUES {rl2}) cp(ws, ed, cpn) JOIN {celr_src} c2 ON c2.cpn = cp.cpn "
            f"JOIN {e_src} e ON LTRIM(CAST(e.upc AS VARCHAR),'0') = c2.upc_norm "
            f"  AND e.wholesaler = cp.ws AND e.edition = cp.ed",
            [x for k in cpns for x in k]).fetchdf().to_dict("records")
    except Exception:
        return

    def _per_unit(uv, uq, bcp, fcp):
        ml, _f = _to_ml(uv or "")
        try:
            q = float(uq)
        except (TypeError, ValueError):
            return None
        if not ml or q <= 0 or ml < 200:        # skip minis (<200ml)
            return None
        bp = bcp if bcp else fcp
        try:
            bp = float(bp)
        except (TypeError, ValueError):
            return None
        if bp <= 0:
            return None
        per_btl = round(bp / q, 2)               # QD buy price per bottle
        return {"ml": ml, "per_btl": per_btl, "per_l": round(per_btl / (ml / 1000.0), 2)}

    pool: dict = {}
    for r in sib:
        pu = _per_unit(r["uv"], r["uq"], r["bcp"], r["fcp"])
        if pu is None:
            continue
        pool.setdefault((r["ws"], r["ed"], r["cpn"]), []).append(
            {"un": r["un"], "uv": r["uv"], **pu})
    for w, ed, un, it in lines:
        cpn = cpn_of.get((w, ed, un))
        sibs = pool.get((w, ed, cpn)) if cpn is not None else None
        if not sibs:
            continue
        mine = next((s for s in sibs if s["un"] == un), None)
        if not mine:
            continue
        # 1) UPGRADE: a meaningfully BIGGER bottle (>=20% more volume) that costs
        #    almost the SAME per bottle after QD (within 10%) — get more liquid for
        #    nearly the same money. Prefer the biggest such bottle.
        ups = [s for s in sibs if s["ml"] >= mine["ml"] * 1.2
               and s["per_btl"] <= mine["per_btl"] * 1.10 and s["un"] != un]
        if ups:
            b = max(ups, key=lambda s: s["ml"])
            it["size_swap"] = {
                "kind": "upgrade", "size": b["uv"], "upc": b["un"],
                "per_btl": b["per_btl"], "this_per_btl": mine["per_btl"],
                "per_l": b["per_l"], "this_per_l": mine["per_l"],
                "vol_pct": round((b["ml"] / mine["ml"] - 1) * 100),
            }
            continue
        # 2) cheaper PER LITRE (size-flexible buyers) — only if >=8% cheaper.
        cheapest = min(sibs, key=lambda s: s["per_l"])
        if cheapest["un"] == un or cheapest["per_l"] >= mine["per_l"] * 0.92:
            continue
        it["size_swap"] = {
            "kind": "cheaper_per_l", "size": cheapest["uv"], "upc": cheapest["un"],
            "per_l": cheapest["per_l"], "this_per_l": mine["per_l"],
            "pct": round((1 - cheapest["per_l"] / mine["per_l"]) * 100),
        }


def _attach_wait_reason(dcon, items):
    """Explain WHY next month is better/worse for a buy-or-wait line, split into
    the two drivers the buyer thinks in: the BUY PRICE (after the 1-case QD =
    best_case_price) and the RIP rebate. Attaches it['wait_reason'] like
    "$15/cs bigger RIP" or "$10/cs lower buy price · $5/cs bigger RIP"."""
    from backend.db import read_parquet
    src = read_parquet(dcon, "cpl_enriched")
    need = set()
    for it in items:
        if not it.get("best_buy_window"):
            continue
        un = str(it.get("upc") or "").lstrip("0")
        ws = it.get("wholesaler")
        if not (ws and un and len(un) >= 8):
            continue
        for ed in (it.get("current_edition"), it.get("next_edition")):
            if ed:
                need.add((ws, ed, un))
    if not need:
        return
    keys = sorted(need)
    rl = ", ".join("(?, ?, ?)" for _ in keys)
    try:
        rows = dcon.execute(
            f"SELECT wholesaler ws, edition ed, LTRIM(CAST(upc AS VARCHAR),'0') un, "
            f"MAX(frontline_case_price) front, MIN(best_case_price) best, "
            f"MIN(effective_case_price) eff "
            f"FROM {src} WHERE (wholesaler, edition, LTRIM(CAST(upc AS VARCHAR),'0')) IN ({rl}) "
            f"GROUP BY 1, 2, 3", [x for k in keys for x in k]).fetchdf().to_dict("records")
    except Exception:
        return
    idx = {(r["ws"], r["ed"], r["un"]): r for r in rows}

    def _parts(r):
        front = r.get("front") or 0.0
        best = r.get("best") if r.get("best") else front       # buy price (after QD)
        eff = r.get("eff") if r.get("eff") is not None else best
        return float(best), float(best - eff)                  # (buy_price, rip)

    for it in items:
        w = it.get("best_buy_window")
        if not w:
            continue
        un = str(it.get("upc") or "").lstrip("0")
        ws = it.get("wholesaler")
        cur = idx.get((ws, it.get("current_edition"), un))
        nxt = idx.get((ws, it.get("next_edition"), un))
        if not cur or not nxt:
            continue
        buy_c, rip_c = _parts(cur)
        buy_n, rip_n = _parts(nxt)
        wait = w.lower().startswith("wait")
        parts = []
        if wait:                                    # next month is BETTER
            if buy_c - buy_n > 0.5:
                parts.append(f"${buy_c - buy_n:.0f}/cs lower buy price")
            if rip_n - rip_c > 0.5:
                parts.append(f"${rip_n - rip_c:.0f}/cs bigger RIP")
        else:                                       # next month is WORSE (buy now)
            if buy_n - buy_c > 0.5:
                parts.append(f"${buy_n - buy_c:.0f}/cs higher buy price")
            if rip_c - rip_n > 0.5:
                parts.append(f"${rip_c - rip_n:.0f}/cs smaller RIP")
        if parts:
            it["wait_reason"] = " · ".join(parts)


@router.get("")
def get_cart(user: dict = Depends(get_current_user)):
    """All cart items (active + saved-for-later) with image, rep name, catalogue
    pricing + deal tiers, the per-distributor comparison (incl each distributor's
    RIP), a stacked suggestion list per line, and per-distributor header notes."""
    return _load_enriched_cart(user)


def _fnum(v):
    """float-or-None (drops NaN)."""
    import math as _m
    try:
        f = float(v)
        return None if _m.isnan(f) else f
    except (TypeError, ValueError):
        return None


def _case_tiers(item: dict, kind: str) -> list[dict]:
    """The case-unit tiers of one kind ('discount'|'rip') for a cart line, sorted
    by qty. Bottle-unit tiers are skipped (the analyzer nudges on whole cases).
    Reads the canonical `tiers` attached by _attach_cart_pricing — no new math."""
    out = []
    try:
        pack = float(item.get("unit_qty") or 0)
    except (TypeError, ValueError):
        pack = 0.0
    for t in (item.get("tiers") or []):
        if t.get("source") != kind:
            continue
        u = str(t.get("unit", "")).lower()
        if u.startswith("bottle") or u.startswith("btl"):
            # A bottle-unit tier is case-equivalent ONLY when the item is sold
            # 1 bottle per case (e.g. Remy) — then "Buy 1 bottle" IS "Buy 1
            # case". For true multipacks the per-case math is ambiguous, so we
            # still skip those (the per-case nudge wouldn't be meaningful).
            if pack != 1:
                continue
        try:
            q = int(t["qty"])
        except (TypeError, ValueError):
            continue
        # Case-credit model (FOUNDATION): a half-case SKU's printed tier qty
        # is QUALIFYING cases; the cart counts PHYSICAL cases, so the nudge
        # threshold is qty/credit ("buy 2 cs to reach the 1-cs RIP").
        # save_per_case arrives already credit-scaled from attach_tiers.
        try:
            _cc = float(t.get("case_credit") or 1.0)
        except (TypeError, ValueError):
            _cc = 1.0
        if 0 < _cc != 1.0:
            q = int(-(-q // _cc))  # ceil(q / credit)
        out.append({
            "qty": q,
            "case_credit": t.get("case_credit"),
            "credit": _fnum(t.get("case_credit")) or 1.0,
            # REAL physical buy-in (half-case rule applied): thresholds in
            # _next_tier and the better-RIP comparison use this, so a
            # half-case SKU's "2 case" tier nudges at 4 physical cases.
            "qty_phys": int(round(_fnum(t.get("qualified_cases")) or q)),
            "code": str(t.get("code") or "") or None,
            "save": _fnum(t.get("save_per_case")) or 0.0,
            # For a RIP tier the canonical `save_per_case` STACKS the quantity
            # discount, so carry the split so the UI can show "QD $A + RIP $B".
            "rip_save": _fnum(t.get("rip_only_save_per_case")) or 0.0,
            "qd_save": _fnum(t.get("stacked_disc_per_case")) or 0.0,
            "price_after": _fnum(t.get("price_after")),
            "amount": _fnum(t.get("amount")) or 0.0,
            "roi": _fnum(t.get("roi_pct")) or 0.0,
            "window_status": t.get("window_status"),
            "days_to_expire": t.get("days_to_expire"),
            "is_time_sensitive": bool(t.get("is_time_sensitive")),
            "from_date": t.get("from_date"),
            "to_date": t.get("to_date"),
            "description": t.get("description"),
        })
    out.sort(key=lambda x: x["qty"])
    return out


def _next_tier(tiers: list[dict], cases: float):
    """Best save you already get at `cases` PHYSICAL cases, and the next
    deeper tier above it. Thresholds use qty_phys (half-case rule applied)."""
    def thr(t):
        return t.get("qty_phys") or t["qty"]
    cur_save = 0.0
    for t in tiers:
        if thr(t) <= max(cases, 0):
            cur_save = max(cur_save, t["save"])
    nxt = next((t for t in tiers if thr(t) > cases and t["save"] > cur_save + 0.005), None)
    return cur_save, nxt


def _mix_rip_codes(dcon, src, items) -> set:
    """Which (wholesaler, rip_code) in the cart are CASE-MIX rebates — i.e. the
    code spans >1 distinct product, so cases are pooled ACROSS items to hit a
    tier (vs a single-item RIP, handled per line)."""
    codes = sorted({str(it["rip_code"]) for it in items if it.get("rip_code")})
    if not codes:
        return set()
    ph = ", ".join(f"$c{i}" for i in range(len(codes)))
    prm = {f"c{i}": c for i, c in enumerate(codes)}
    try:
        df = dcon.execute(f"""
            WITH latest AS (SELECT wholesaler, MAX(edition) AS ed FROM {src} GROUP BY wholesaler)
            SELECT e.wholesaler AS w, CAST(e.rip_code AS VARCHAR) AS rc,
                   COUNT(DISTINCT LTRIM(CAST(e.upc AS VARCHAR), '0')) AS n
            FROM {src} e JOIN latest l ON e.wholesaler = l.wholesaler AND e.edition = l.ed
            WHERE CAST(e.rip_code AS VARCHAR) IN ({ph})
            GROUP BY 1, 2
        """, prm).fetchdf()
    except Exception:
        return set()
    return {(r["w"], str(r["rc"])) for _, r in df.iterrows() if int(r["n"]) > 1}


def _cross_distributor(dcon, src, items) -> dict:
    """Map normalized UPC -> [(wholesaler, unit_volume, effective_case_price)] in
    each wholesaler's latest edition, so we can spot the same item cheaper at the
    other house."""
    norms = sorted({str(it.get("upc") or "").lstrip("0") for it in items if it.get("upc")})
    norms = [u for u in norms if u]
    if not norms:
        return {}
    ph = ", ".join(f"$u{i}" for i in range(len(norms)))
    prm = {f"u{i}": u for i, u in enumerate(norms)}
    try:
        df = dcon.execute(f"""
            WITH latest AS (SELECT wholesaler, MAX(edition) AS ed FROM {src} GROUP BY wholesaler)
            SELECT e.wholesaler AS w, LTRIM(CAST(e.upc AS VARCHAR), '0') AS un,
                   e.unit_volume AS uv, e.effective_case_price AS ecp, e.product_name AS pn
            FROM {src} e JOIN latest l ON e.wholesaler = l.wholesaler AND e.edition = l.ed
            WHERE LTRIM(CAST(e.upc AS VARCHAR), '0') IN ({ph})
        """, prm).fetchdf()
    except Exception:
        return {}
    out: dict = {}
    for _, r in df.iterrows():
        out.setdefault(str(r["un"]), []).append({
            "w": r["w"], "uv": r["uv"] or "", "ecp": _fnum(r["ecp"]), "pn": r["pn"] or "",
        })
    return out


def _norm_prod_name(s: str) -> str:
    """Brand-aware name key for cross-distributor matching when no usable barcode
    exists. Uppercase, drop size/pack tokens (1.75L, 750ML, 6PK, 12P, OZ, CANS…)
    and punctuation, collapse spaces. Two houses that name the SAME bottle slightly
    differently still won't collide unless the cleaned names are identical, so this
    only ever links clearly-the-same products (we never silently weld two SKUs)."""
    s = re.sub(r"[^A-Z0-9 ]", " ", (s or "").upper())
    s = re.sub(r"\b\d+(?:\.\d+)?\s?(?:ML|L|LTR|LITER|LITRE|OZ|PK|P|CT|CANS?|BTLS?|BTL|GAL)\b", " ", s)
    s = re.sub(r"\b(?:GIFT|GFT|VAP|W|WITH|AND)\b", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _comparison_row(m: dict, rank: int, n_dist: int) -> dict:
    """Shape a cpl_enriched row into the same comparison-grid record the
    precomputed offer_grid emits, so the picker UI is source-agnostic."""
    front = _fnum(m.get("fcp")); after = _fnum(m.get("bcp")); eff = _fnum(m.get("ecp"))
    return {
        "wholesaler": m.get("w"), "product_name": m.get("pn"),
        "display_name": m.get("pn"), "unit_volume": m.get("uv"),
        "upc": m.get("upc"), "upc_norm": m.get("un"),
        "frontline_case_price": front, "after_qd_case_price": after,
        "effective_case_price": eff,
        "has_rip": bool(m.get("hr")), "has_discount": bool(m.get("hd")),
        "rip_code": (str(m["rc"]) if m.get("rc") not in (None, "", "0") else None),
        "net_rank": rank, "is_cheapest_net": (rank == 0 and eff is not None),
        "n_distributors": n_dist, "_by_name": True,
    }


def _vtg_key(v) -> str:
    """Normalize a vintage to a comparable token; NV/blank collapse to ''."""
    s = str(v or "").strip().lower()
    return "" if s in ("", "none", "nan", "0", "nv") else s


def _ident_key(name, unit_volume, unit_qty, vintage) -> tuple:
    """Full no-barcode identity: product + bottle size + pack size + vintage. The
    user's rule — when there's no UPC to trust, ALL of these must agree, so a 6P
    never matches a 3P and a '17 never matches a '20."""
    try:
        uq = str(int(float(unit_qty))) if unit_qty not in (None, "") else ""
    except Exception:
        uq = str(unit_qty or "")
    return (_norm_prod_name(name), str(unit_volume or "").strip().upper(), uq, _vtg_key(vintage))


def _attach_comparison_by_name(dcon, items):
    """Fallback cross-distributor grid for lines with NO usable barcode (combos,
    placeholder UPCs). Matches the SAME item at other houses by the FULL identity —
    product name + bottle size + pack size (unit_qty) + vintage — in each house's
    latest edition. Conservative on purpose: every dimension must agree, so we never
    weld a 6P to a 3P, a 750ML to a 1.75L, or a '17 to a '20."""
    from backend.db import read_parquet
    src = read_parquet(dcon, "cpl_enriched")
    targets = [it for it in items
               if (it.get("product_name") and it.get("wholesaler") and not it.get("comparison"))]
    if not targets:
        return
    # One broad pull per distinct brand token keeps this cheap even for many lines.
    tokens = sorted({_norm_prod_name(it["product_name"]).split(" ")[0]
                     for it in targets if _norm_prod_name(it["product_name"])})
    tokens = [t for t in tokens if len(t) >= 3]
    if not tokens:
        return
    like = " OR ".join("UPPER(e.product_name) LIKE ?" for _ in tokens)
    prm = [f"%{t}%" for t in tokens]
    try:
        df = dcon.execute(f"""
            WITH latest AS (SELECT wholesaler, MAX(edition) AS ed FROM {src} GROUP BY wholesaler)
            SELECT e.wholesaler AS w, e.product_name AS pn, e.unit_volume AS uv,
                   e.unit_qty AS uq, e.vintage AS vtg,
                   LTRIM(CAST(e.upc AS VARCHAR),'0') AS un, CAST(e.upc AS VARCHAR) AS upc,
                   e.frontline_case_price AS fcp, e.best_case_price AS bcp,
                   e.effective_case_price AS ecp, e.has_rip AS hr, e.has_discount AS hd,
                   CAST(e.rip_code AS VARCHAR) AS rc
            FROM {src} e JOIN latest l ON e.wholesaler=l.wholesaler AND e.edition=l.ed
            WHERE {like}
        """, prm).fetchdf().to_dict("records")
    except Exception:
        return
    # Bucket candidates by the full identity; best (lowest net) per distributor.
    buckets: dict = {}
    for r in df:
        key = _ident_key(r["pn"], r["uv"], r["uq"], r["vtg"])
        buckets.setdefault(key, {})
        cur = buckets[key].get(r["w"])
        if cur is None or (_fnum(r["ecp"]) or 1e9) < (_fnum(cur["ecp"]) or 1e9):
            buckets[key][r["w"]] = r
    # The line's OWN pack/vintage come from its exact catalog row (its stored name
    # is the exact catalogue name), not from _attach_cart_pricing — that only
    # enriches UPC-bearing lines, and these are precisely the UPC-less ones.
    selfrow: dict = {}
    for r in df:
        selfrow.setdefault((r["w"], r["pn"], str(r["uv"] or "")), r)
    for it in targets:
        me = selfrow.get((it["wholesaler"], it["product_name"], str(it.get("unit_volume") or "")))
        uq = me["uq"] if me else it.get("unit_qty")
        vtg = me["vtg"] if me else it.get("vintage")
        key = _ident_key(it["product_name"], it.get("unit_volume"), uq, vtg)
        houses = buckets.get(key)
        if not houses or it["wholesaler"] not in houses or len(houses) < 2:
            continue
        members = sorted(houses.values(), key=lambda m: (_fnum(m["ecp"]) is None, _fnum(m["ecp"]) or 1e9))
        it["comparison"] = [_comparison_row(m, i, len(members)) for i, m in enumerate(members)]


def _dedup_comparison(grid, it):
    """Collapse the offer grid to ONE row per distributor. A shared/placeholder
    barcode welds several products (Absolut flavors) under one cpn, and Fedway
    repeats rows, so the raw grid lists a house many times. Per house keep the row
    that matches THIS line's identity (product+size+pack+vintage); absent a match,
    the cheapest. Re-rank so the picker shows unique houses + a correct cheapest."""
    want = _ident_key(it.get("product_name"), it.get("unit_volume"),
                      it.get("unit_qty"), it.get("vintage"))
    best: dict = {}
    for g in grid:
        ws = g.get("wholesaler")
        gk = _ident_key(g.get("product_name"), g.get("unit_volume"),
                        g.get("unit_qty"), g.get("vintage"))
        match = (gk == want)
        net = _fnum(g.get("effective_case_price"))
        cur = best.get(ws)
        if cur is None:
            best[ws] = (g, match, net); continue
        _, cmatch, cnet = cur
        # Prefer an identity match; otherwise the lower net price.
        if (match and not cmatch) or (match == cmatch and (net or 1e9) < (cnet or 1e9)):
            best[ws] = (g, match, net)
    rows = [g for g, _, _ in best.values()]
    rows.sort(key=lambda g: (_fnum(g.get("effective_case_price")) is None,
                             _fnum(g.get("effective_case_price")) or 1e9))
    for i, g in enumerate(rows):
        g["net_rank"] = i
        g["is_cheapest_net"] = (i == 0 and _fnum(g.get("effective_case_price")) is not None)
        g["n_distributors"] = len(rows)
    return rows


def _attach_comparison(dcon, items):
    """Attach it['comparison'] — every distributor that carries the SAME item with
    its net/case price + RIP flag — used by the inline distributor picker in the
    cart AND lists. UPC-driven via the precomputed offer_grid; falls back to a
    name+size match across houses when the line has no usable barcode. Requires
    `edition`/`unit_qty` (set by _attach_cart_pricing) on each item first."""
    from backend.precompute_offers import offer_grid
    for it in items:
        un = str(it.get("upc") or "").lstrip("0")
        ed = it.get("edition"); ws = it.get("wholesaler")
        if not (ed and ws and len(un) >= 8):
            continue
        try:
            grid = offer_grid(dcon, edition=ed, wholesaler=ws, upc_norm=un,
                              unit_qty=it.get("unit_qty"))
        except Exception:
            grid = []
        if grid and len({g.get("wholesaler") for g in grid}) >= 2:
            it["comparison"] = _dedup_comparison(grid, it)
    _attach_comparison_by_name(dcon, items)   # name fallback for the rest


def _resolve_switch_by_name(dcon, product_name: str, unit_volume, target: str,
                            unit_qty=None, vintage=None):
    """Find the target distributor's row for the SAME item by the FULL identity —
    product + bottle size + pack size + vintage (latest edition) — for switching a
    UPC-less line. Returns (product_name, upc, unit_volume) or None. Every dimension
    must agree, so we never switch onto a different pack/size/vintage."""
    from backend.db import read_parquet
    src = read_parquet(dcon, "cpl_enriched")
    tok = _norm_prod_name(product_name).split(" ")[0] if _norm_prod_name(product_name) else ""
    if len(tok) < 3:
        return None
    try:
        rows = dcon.execute(f"""
            WITH latest AS (SELECT MAX(edition) AS ed FROM {src} WHERE wholesaler=?)
            SELECT product_name, CAST(upc AS VARCHAR) upc, unit_volume, unit_qty, vintage,
                   effective_case_price ecp
            FROM {src} WHERE wholesaler=? AND edition=(SELECT ed FROM latest)
              AND UPPER(product_name) LIKE ?
        """, [target, target, f"%{tok}%"]).fetchdf().to_dict("records")
    except Exception:
        return None
    want = _ident_key(product_name, unit_volume, unit_qty, vintage)
    cands = [r for r in rows
             if _ident_key(r["product_name"], r["unit_volume"], r["unit_qty"], r["vintage"]) == want]
    if not cands:
        return None
    best = min(cands, key=lambda r: (_fnum(r["ecp"]) is None, _fnum(r["ecp"]) or 1e9))
    return (best["product_name"], best["upc"], best["unit_volume"])


def _resolve_switch_target(dcon, src_ws, upc, unit_volume, product_name, target):
    """Resolve the target distributor's row for the SAME item when switching a
    line in place. UPC-driven via the precomputed sku_offer grid; name+size
    fallback for UPC-less lines. Returns (product_name, upc, unit_volume) or None.
    Shared by the cart and the lists switch endpoints."""
    un = str(upc or "").lstrip("0")
    if len(un) >= 8:
        try:
            ident = dcon.execute(
                "SELECT edition, group_key FROM sku_offer WHERE wholesaler=? AND upc_norm=? "
                "ORDER BY (CASE WHEN COALESCE(unit_volume,'')=? THEN 0 ELSE 1 END), edition DESC LIMIT 1",
                [src_ws, un, unit_volume or ""]).fetchone()
        except Exception:
            ident = None
        if ident:
            ed, gk = ident
            tgt = dcon.execute(
                "SELECT product_name, upc, unit_volume FROM sku_offer "
                "WHERE edition=? AND group_key=? AND wholesaler=? LIMIT 1",
                [ed, gk, target]).fetchone()
            if tgt:
                return (tgt[0], tgt[1] or upc, tgt[2] or unit_volume)
    if product_name:
        # Derive the source line's pack + vintage from its own exact catalog row so
        # the name match enforces the full identity (product+size+pack+vintage).
        uq = vtg = None
        try:
            from backend.db import read_parquet
            s = read_parquet(dcon, "cpl_enriched")
            me = dcon.execute(
                f"WITH latest AS (SELECT MAX(edition) ed FROM {s} WHERE wholesaler=?) "
                f"SELECT unit_qty, vintage FROM {s} WHERE wholesaler=? AND product_name=? "
                f"AND COALESCE(unit_volume,'')=? AND edition=(SELECT ed FROM latest) LIMIT 1",
                [src_ws, src_ws, product_name, unit_volume or ""]).fetchone()
            if me:
                uq, vtg = me[0], me[1]
        except Exception:
            pass
        return _resolve_switch_by_name(dcon, product_name, unit_volume, target, uq, vtg)
    return None


@router.get("/analyze")
def analyze_cart(user: dict = Depends(get_current_user)):
    """Analyze the ACTIVE cart for savings (see analyze_lines)."""
    with get_pg() as con:
        items = [dict(r) for r in con.execute(
            "SELECT * FROM cart_items WHERE user_id=%s AND COALESCE(saved_for_later,0)=0 ORDER BY created_at",
            (user["id"],)).fetchall()]
    return analyze_lines(items)


def analyze_lines(items: list[dict]) -> dict:
    """'Analyze for Savings' engine over a set of order lines — each a dict with
    wholesaler / upc / unit_volume / product_name / qty_cases. Shared by the cart
    AND the lists page. Reuses the canonical pricing (discount/RIP tier ladder),
    next-month prices, and cross-distributor prices to surface tier-gap nudges,
    case-mix qualification, buy-before-a-rise, and distributor swaps — returning
    recommendations + headline totals. No new pricing math: every number comes
    from the same engines the catalog and cart already use."""
    if not items:
        return {"captured_total": 0.0, "opportunity_total": 0.0,
                "protection_total": 0.0, "line_count": 0, "recommendations": []}

    from backend.db import read_parquet
    from backend import pricing as _pricing
    with get_duckdb() as dcon:
        try:
            _attach_cart_pricing(dcon, items)        # canonical tiers + prices + rip_code
        except Exception:
            pass
        try:
            attach_sku_mapping(dcon, items)          # abg_sku (vendor item code)
        except Exception:
            pass
        src = read_parquet(dcon, "cpl_enriched")
        try:
            _pricing.attach_next_month_prices(dcon, src, items)
        except Exception:
            pass
        mix = _mix_rip_codes(dcon, src, items)
        cross = _cross_distributor(dcon, src, items)

    recs: list[dict] = []
    captured = 0.0

    # --- captured savings (what they're ALREADY saving vs list) ---
    for it in items:
        F, E = _fnum(it.get("frontline_case_price")), _fnum(it.get("effective_case_price"))
        C = int(it.get("qty_cases") or 0)
        if F and E and C > 0 and F > E:
            captured += (F - E) * C

    # --- per-line tier-gap (QD always; RIP only for single-item codes) ---
    for it in items:
        C = int(it.get("qty_cases") or 0)
        name = it.get("product_name") or "Item"
        is_mix = (it.get("wholesaler"), str(it.get("rip_code"))) in mix
        best = None     # (extra, payload)
        for kind in ("discount", "rip"):
            if kind == "rip" and is_mix:
                continue   # mix RIPs handled by the case-mix block below
            tiers = _case_tiers(it, kind)
            cur_save, nxt = _next_tier(tiers, C)
            if not nxt:
                continue
            # target in PHYSICAL cases (half-case rule applied) — the "Set to
            # N" button and the savings math must use the real buy-in.
            tgt = int(nxt.get("qty_phys") or nxt["qty"])
            extra = round(nxt["save"] * tgt - cur_save * C, 2)
            if extra <= 1.0:
                continue
            payload = {
                "type": "tier_gap", "kind": "qd" if kind == "discount" else "rip",
                "line_id": it.get("id"), "product_name": name, "upc": it.get("upc"), "abg_sku": it.get("abg_sku"),
                "wholesaler": it.get("wholesaler"), "unit_volume": it.get("unit_volume"),
                "unit_type": it.get("unit_type"),
                "unit_qty": it.get("unit_qty"), "vintage": it.get("vintage"),
                "current_cases": C, "target_qty": tgt, "add_cases": tgt - C,
                "new_case_price": nxt["price_after"], "save_per_case": round(nxt["save"], 2),
                # QD/RIP split of the (stacked) saving, so the row can explain it.
                "qd_save_per_case": round(nxt.get("qd_save", 0.0), 2),
                "rip_save_per_case": round(nxt.get("rip_save", 0.0), 2),
                "rebate_amount": round(nxt["amount"], 2), "roi_pct": nxt["roi"],
                "extra_savings": extra,
                "window_status": nxt["window_status"], "days_to_expire": nxt["days_to_expire"],
            }
            # Flag partial-month (time-sensitive) deals: the saving is only
            # realizable on these dates, so the optimizer must call it out.
            if nxt.get("is_time_sensitive") or nxt.get("window_status") in ("active", "upcoming", "expired"):
                payload["partial"] = {
                    "from_date": nxt.get("from_date"), "to_date": nxt.get("to_date"),
                    "window_status": nxt.get("window_status"),
                    "days_to_expire": nxt.get("days_to_expire"),
                    "time_sensitive": bool(nxt.get("is_time_sensitive")),
                }
            if best is None or extra > best[0]:
                best = (extra, payload)
        if best:
            recs.append(best[1])

    # --- better-RIP: the UPC sits under SEVERAL RIP programs (they don't
    # stack) and a different program pays more at a comparable quantity than
    # the line's current one. Surfaces the difference so the buyer can switch
    # the line's RIP (rip_choice) — e.g. Buehler: mix RIP pays $15 at 2cs,
    # the standalone Cabernet RIP pays $60 at the same 2cs. ---
    for it in items:
        by_code: dict = {}
        for t in _case_tiers(it, "rip"):
            c = t.get("code")
            if c:
                by_code.setdefault(c, []).append(t)
        if len(by_code) < 2:
            continue
        eff = (str(it.get("rip_choice") or "").strip()
               or str(it.get("rip_code") or "").strip())
        if eff not in by_code:
            eff = next(iter(by_code))
        C = int(it.get("qty_cases") or 0)

        def _phys(x):
            return x.get("qty_phys") or x["qty"]

        def _save_at(ts, qty):
            return max((x["save"] for x in ts if _phys(x) <= qty), default=0.0)

        best = None
        for code, ts in by_code.items():
            if code == eff:
                continue
            # Compare at the candidate's entry PHYSICAL buy-in (or the line's
            # current cases when already past it): equal commitment, different
            # payout. Half-case rule: thresholds are physical (qty_phys).
            target = max(min(_phys(x) for x in ts), C)
            mine = _save_at(by_code[eff], target)
            theirs = _save_at(ts, target)
            gain = round((theirs - mine) * target, 2)
            if theirs > mine + 0.005 and gain > 1.0 and (best is None or gain > best["extra_savings"]):
                ct = next(x for x in sorted(ts, key=_phys) if _phys(x) <= target)
                best = {
                    "type": "better_rip",
                    "line_id": it.get("id"), "product_name": it.get("product_name") or "Item",
                    "upc": it.get("upc"), "abg_sku": it.get("abg_sku"),
                    "wholesaler": it.get("wholesaler"), "unit_volume": it.get("unit_volume"),
                    "unit_type": it.get("unit_type"), "unit_qty": it.get("unit_qty"),
                    "current_rip_code": eff, "better_rip_code": code,
                    "target_qty": target,
                    "save_per_case_current": round(mine, 2),
                    "save_per_case_better": round(theirs, 2),
                    "extra_savings": gain,
                    "description": ct.get("description"),
                    "window_status": ct.get("window_status"),
                    "days_to_expire": ct.get("days_to_expire"),
                }
        if best:
            recs.append(best)

    # --- case-mix qualification (pool cases across items sharing a mix RIP) ---
    groups: dict = {}
    for it in items:
        key = (it.get("wholesaler"), str(it.get("rip_code")))
        if key in mix:
            groups.setdefault(key, []).append(it)
    for (ws, rc), grp in groups.items():
        # Case-credit model: each line's physical cases earn that SKU's
        # credit toward the mix tiers (a half-case qualifier counts 0.5 per
        # physical case), so the pool progress is in CASE CREDITS.
        def _line_credit(li):
            for t in _case_tiers(li, "rip"):
                cr = t.get("credit") or 1.0
                if cr != 1.0:
                    return cr
            return 1.0
        sum_cases = round(sum(
            int(it.get("qty_cases") or 0) * _line_credit(it) for it in grp), 2)
        credit_based = any(_line_credit(it) != 1.0 for it in grp)
        tier_map: dict = {}
        desc = None
        partial = None    # carry a partial-month window if the mix RIP has one
        for it in grp:
            for t in _case_tiers(it, "rip"):
                tier_map[t["qty"]] = max(tier_map.get(t["qty"], 0.0), t["save"])
                desc = desc or t.get("description")
                if partial is None and (t.get("is_time_sensitive")
                                        or t.get("window_status") in ("active", "upcoming", "expired")):
                    partial = {
                        "from_date": t.get("from_date"), "to_date": t.get("to_date"),
                        "window_status": t.get("window_status"),
                        "days_to_expire": t.get("days_to_expire"),
                        "time_sensitive": bool(t.get("is_time_sensitive")),
                    }
        tiers = [{"qty": q, "save": s} for q, s in sorted(tier_map.items())]
        cur_save, nxt = _next_tier(tiers, sum_cases)
        if not nxt:
            continue
        extra = round(nxt["save"] * nxt["qty"] - cur_save * sum_cases, 2)
        if extra <= 1.0:
            continue
        rec = {
            "type": "case_mix", "rip_code": rc, "wholesaler": ws, "description": desc,
            "members": [it.get("product_name") for it in grp],
            "line_ids": [it.get("id") for it in grp],
            "current_cases": sum_cases, "target_qty": nxt["qty"],
            "add_cases": round(nxt["qty"] - sum_cases, 2), "extra_savings": extra,
            # True when a half/quarter-case qualifier is in the pool — the
            # quantities above are CASE CREDITS, not physical cases.
            "credit_based": credit_based,
        }
        if partial:
            rec["partial"] = partial
        recs.append(rec)

    # --- buy-before-increase (next edition costs more) ---
    protection = 0.0
    for it in items:
        cur = _fnum(it.get("effective_case_price"))
        nxt = _fnum(it.get("next_effective_case_price")) or _fnum(it.get("next_case_price"))
        C = int(it.get("qty_cases") or 0)
        if cur and nxt and nxt > cur + 0.5:
            rise = round(nxt - cur, 2)
            total = round(rise * max(C, 1), 2)
            protection += total if C > 0 else 0.0
            recs.append({
                "type": "buy_before", "line_id": it.get("id"), "upc": it.get("upc"), "abg_sku": it.get("abg_sku"),
                "product_name": it.get("product_name"), "wholesaler": it.get("wholesaler"),
                "unit_volume": it.get("unit_volume"), "unit_type": it.get("unit_type"), "unit_qty": it.get("unit_qty"),
                "vintage": it.get("vintage"), "current_price": round(cur, 2),
                "next_price": round(nxt, 2), "rise_per_case": rise,
                "current_cases": C, "total_rise": total,
            })

    # --- cross-distributor swap (same UPC cheaper at the other house) ---
    swap_total = 0.0
    for it in items:
        un = str(it.get("upc") or "").lstrip("0")
        cur = _fnum(it.get("effective_case_price"))
        if not un or cur is None:
            continue
        cands = [c for c in cross.get(un, [])
                 if c["w"] != it.get("wholesaler") and c["ecp"] is not None
                 and (not it.get("unit_volume") or c["uv"] == it.get("unit_volume"))]
        if not cands:
            continue
        bestc = min(cands, key=lambda c: c["ecp"])
        if bestc["ecp"] < cur - 2.0:
            C = int(it.get("qty_cases") or 0)
            sv = round(cur - bestc["ecp"], 2)
            total = round(sv * max(C, 1), 2)
            swap_total += total if C > 0 else 0.0
            recs.append({
                "type": "swap", "line_id": it.get("id"), "upc": it.get("upc"), "abg_sku": it.get("abg_sku"),
                "product_name": it.get("product_name"), "unit_volume": it.get("unit_volume"),
                "unit_qty": it.get("unit_qty"), "vintage": it.get("vintage"),
                "from_wholesaler": it.get("wholesaler"), "to_wholesaler": bestc["w"],
                "current_price": round(cur, 2), "other_price": round(bestc["ecp"], 2),
                "save_per_case": sv, "current_cases": C, "total_savings": total,
                "extra_savings": total if C > 0 else 0.0,
            })

    opportunity = round(sum(r.get("extra_savings", 0.0) for r in recs
                            if r["type"] in ("tier_gap", "case_mix", "swap")), 2)
    # Sort: biggest dollar impact first.
    def _impact(r):
        return r.get("extra_savings", 0.0) or r.get("total_rise", 0.0) or 0.0
    recs.sort(key=_impact, reverse=True)
    return {
        "captured_total": round(captured, 2),
        "opportunity_total": opportunity,
        "protection_total": round(protection, 2),
        "line_count": len(items),
        "recommendations": recs,
    }


# ---------------------------------------------------------------------------
# Smart-cart suggestions: one normalized shape per actionable money-saver, plus
# the full per-distributor comparison (incl each distributor's own RIP) on every
# line. The frontend renders a STACKED list under each line and fires the
# `action` endpoint on Apply. All numbers come from analyze_lines (canonical
# pricing) + the precomputed sku_offer grid — no new math here.
# ---------------------------------------------------------------------------

def _dist_label(slug: str) -> str:
    return (slug or "").replace("_", " ").title() or "another distributor"


def _normalize_rec(rec: dict) -> list[tuple]:
    """Convert one analyze_lines recommendation into (line_id, suggestion) pairs.
    A suggestion is {kind, headline, delta_per_case, delta_total, expires_on,
    action}. `swap` is intentionally dropped — the richer alt_distributor
    suggestion (built from sku_offer, carrying every distributor's RIP) replaces
    it."""
    t = rec.get("type")
    out: list[tuple] = []
    if t == "tier_gap":
        is_qd = rec.get("kind") == "qd"
        lid = rec.get("line_id")
        exp = (rec.get("partial") or {}).get("to_date")
        out.append((lid, {
            "kind": "qd_tier" if is_qd else "rip_tier",
            "headline": (f"Buy {rec['target_qty']} cs to reach the "
                         f"${rec['new_case_price']:.2f} {'QD' if is_qd else 'RIP'} tier"),
            "detail": f"+${rec['save_per_case']:.2f}/cs vs your current quantity",
            "delta_per_case": rec.get("save_per_case"),
            "delta_total": rec.get("extra_savings", 0.0),
            "expires_on": exp,
            "action": {"endpoint": f"/api/cart/{lid}", "method": "PUT",
                       "payload": {"qty_cases": rec["target_qty"]}},
        }))
    elif t == "better_rip":
        lid = rec.get("line_id")
        out.append((lid, {
            "kind": "rip_program",
            "headline": (f"Switch to RIP {rec['better_rip_code']}: "
                         f"${rec['save_per_case_better']:.2f}/cs at {rec['target_qty']} cs"),
            "detail": f"your current RIP pays ${rec['save_per_case_current']:.2f}/cs here",
            "delta_per_case": round(rec["save_per_case_better"] - rec["save_per_case_current"], 2),
            "delta_total": rec.get("extra_savings", 0.0),
            "expires_on": None,
            "action": {"endpoint": f"/api/cart/{lid}", "method": "PUT",
                       "payload": {"rip_choice": rec["better_rip_code"]}},
        }))
    elif t == "case_mix":
        exp = (rec.get("partial") or {}).get("to_date")
        sug = {
            "kind": "case_mix",
            "headline": (f"Pool {rec['add_cases']} more cs across "
                         f"{len(rec.get('members') or [])} items for the next RIP tier"),
            "detail": rec.get("description"),
            "delta_per_case": None,
            "delta_total": rec.get("extra_savings", 0.0),
            "expires_on": exp,
            "action": None,           # cross-line; the buyer chooses which line to grow
            "line_ids": rec.get("line_ids"),
        }
        for lid in (rec.get("line_ids") or []):
            out.append((lid, dict(sug)))
    elif t == "buy_before":
        lid = rec.get("line_id")
        out.append((lid, {
            "kind": "buy_before",
            "headline": f"Price rises ${rec['rise_per_case']:.2f}/cs next month",
            "detail": f"buy now to lock ${rec['current_price']:.2f}/cs before ${rec['next_price']:.2f}",
            "delta_per_case": rec.get("rise_per_case"),
            "delta_total": rec.get("total_rise", 0.0),
            "expires_on": None,
            "action": None,           # informational protection, not a one-click change
        }))
    return out


def attach_line_suggestions(items: list[dict]) -> dict:
    """Price every line, attach `comparison` (full per-distributor grid incl RIP)
    and a ranked, stacked `suggestions` list to each, and return the cart-level
    roll-up totals. Reuses analyze_lines (canonical) + the precomputed sku_offer
    grid. Best-effort: never raises into the cart load."""
    for it in items:
        it.setdefault("suggestions", [])
        it.setdefault("comparison", [])
    if not items:
        return {"captured_total": 0.0, "opportunity_total": 0.0,
                "protection_total": 0.0, "recommendations": []}

    try:
        analysis = analyze_lines(items)   # prices items in place + returns recs
    except Exception:
        return {"captured_total": 0.0, "opportunity_total": 0.0,
                "protection_total": 0.0, "recommendations": []}

    by_id = {it.get("id"): it for it in items if it.get("id") is not None}
    per_line: dict = {lid: [] for lid in by_id}

    # 1) Normalize the analyze_lines recommendations into per-line suggestions.
    for rec in analysis.get("recommendations", []):
        if rec.get("type") == "swap":
            continue   # replaced by alt_distributor (richer, carries RIP)
        for lid, sug in _normalize_rec(rec):
            if lid in per_line:
                per_line[lid].append(sug)

    # 2) Per-line cross-distributor comparison (UPC grid + name fallback), plus an
    #    alt_distributor suggestion when a cheaper house carries the SAME item.
    with get_duckdb() as dcon:
        _attach_comparison(dcon, items)
        for it in items:
            ws = it.get("wholesaler")
            grid = it.get("comparison") or []
            if len(grid) < 2:
                continue
            cur = next((g for g in grid if g.get("wholesaler") == ws), None)
            cur_net = (_fnum(cur.get("effective_case_price")) if cur else None) \
                or _fnum(it.get("effective_case_price"))
            cheapest = grid[0]   # net_rank 0
            ch_net = _fnum(cheapest.get("effective_case_price"))
            # Plausibility floor: a "deal" more than ~50% cheaper across houses is
            # almost always a shared/mis-keyed barcode welding two different
            # products (e.g. Penfolds Bin 28 vs Bin 98 under one barcode + cpn),
            # not a real price gap (real cross-distributor diffs are frontline +
            # QD, rarely past ~30-50%). Still SHOW the comparison table so the
            # buyer can see both names; just don't push a one-click switch on it.
            plausible = (ch_net is not None and cur_net is not None
                         and ch_net >= cur_net * 0.5)
            if (cheapest.get("wholesaler") != ws and cur_net is not None
                    and ch_net is not None and ch_net < cur_net - 2.0 and plausible):
                C = int(it.get("qty_cases") or 0)
                dpc = round(cur_net - ch_net, 2)
                lid = it.get("id")
                per_line.setdefault(lid, []).append({
                    "kind": "alt_distributor",
                    "headline": (f"{_dist_label(cheapest.get('wholesaler'))} is "
                                 f"${dpc:.2f}/cs cheaper"),
                    "detail": (f"net ${ch_net:.2f}/cs vs ${cur_net:.2f}/cs"
                               + (" (incl. its RIP)" if cheapest.get("has_rip") else "")),
                    "delta_per_case": dpc,
                    "delta_total": round(dpc * max(C, 1), 2),
                    "expires_on": None,
                    "action": {"endpoint": f"/api/cart/{lid}/switch-distributor",
                               "method": "POST",
                               "payload": {"wholesaler": cheapest.get("wholesaler")}},
                })

    # 3) Rank each line's stack by dollar impact and stamp it on the item.
    for lid, sugs in per_line.items():
        sugs.sort(key=lambda s: s.get("delta_total") or 0.0, reverse=True)
        for i, s in enumerate(sugs):
            s["rank"] = i
        if lid in by_id:
            by_id[lid]["suggestions"] = sugs

    return {
        "captured_total": analysis.get("captured_total", 0.0),
        "opportunity_total": analysis.get("opportunity_total", 0.0),
        "protection_total": analysis.get("protection_total", 0.0),
        "recommendations": analysis.get("recommendations", []),
    }


def _load_enriched_cart(user: dict) -> dict:
    """Full cart payload: items with image, rep name, catalogue pricing + deal
    tiers, the per-distributor comparison, a stacked suggestion list per line,
    plus per-distributor header notes and the savings roll-up."""
    with get_pg() as con:
        items = [dict(r) for r in con.execute(
            "SELECT * FROM cart_items WHERE user_id=%s ORDER BY created_at", (user["id"],)
        ).fetchall()]
        reps = {r["id"]: dict(r) for r in con.execute(
            "SELECT id, name, distributor, division, email FROM sales_reps WHERE user_id=%s",
            (user["id"],),
        ).fetchall()}
        group_notes = {r["wholesaler"]: r["note"] for r in con.execute(
            "SELECT wholesaler, note FROM cart_group_notes WHERE user_id=%s", (user["id"],)
        ).fetchall()}
    summary = {"captured_total": 0.0, "opportunity_total": 0.0, "protection_total": 0.0}
    if items:
        with get_duckdb() as dcon:
            try:
                attach_enrichment_image(dcon, items)
                attach_sku_mapping(dcon, items)
            except Exception:
                pass
            try:
                _attach_cart_pricing(dcon, items)   # never let pricing break the cart load
            except Exception:
                pass
            try:
                # BUY-OR-WAIT timing: attach best_buy_window / best_buy_saving and
                # eff_cur/eff_prior per line — "wait → next month" when the effective
                # (net) price drops next edition, "buy now" (+how much it rises) when
                # it goes up. RIP is back-pocket-later, so timing compares the net.
                from backend.deal_compare import deal_compare
                deal_compare(dcon, items)
                # Explain the buy-or-wait driver (buy price vs RIP, next vs now).
                _attach_wait_reason(dcon, items)
            except Exception:
                pass
            try:
                # COMBO suggestion: if a normal line's product is a member of a
                # combo, surface the bundle + the sheet's own savings (great?).
                _attach_combo_suggestion(dcon, items)
            except Exception:
                pass
            try:
                # SIZE swap: another size of the same product cheaper per litre.
                _attach_size_swap(dcon, items)
            except Exception:
                pass
        try:
            roll = attach_line_suggestions(items)   # comparison + stacked suggestions
            summary = {k: roll.get(k, 0.0) for k in
                       ("captured_total", "opportunity_total", "protection_total")}
        except Exception:
            pass
    for it in items:
        rep = reps.get(it.get("sales_rep_id"))
        it["sales_rep_name"] = rep["name"] if rep else None
    return {"items": items, "group_notes": group_notes, "savings": summary}


@router.post("")
def add_to_cart(body: CartItemIn, user: dict = Depends(get_current_user)):
    """Add a product and return the freshly enriched cart (with per-line
    comparison + suggestions) so the UI shows savings the instant it lands —
    one round trip, no follow-up fetch."""
    with get_pg() as con:
        rep_id = _default_rep_for(con, user["id"], body.wholesaler)
        _insert_cart_item(con, user["id"], body.model_dump(), rep_id)
    return {"status": "added", "cart": _load_enriched_cart(user)}


@router.post("/add-batch")
def add_batch_to_cart(body: CartBatchIn, user: dict = Depends(get_current_user)):
    """Add N items to the cart as ONE labelled batch (e.g. a RIP Case Mix sent
    from the catalog or the AI). Every item is tagged with the same generated
    batch_id, so the cart page can show them as a single send and a later
    "send the same cluster again" produces a separate batch instead of mixing.

    Returns the generated batch_id so the caller can offer an immediate
    "undo this send" affordance if it wants to."""
    if not body.items:
        return {"status": "noop", "added": 0}
    batch_id = str(uuid.uuid4())
    with get_pg() as con:
        added = 0
        for item in body.items:
            payload = item.model_dump()
            payload["batch_id"] = batch_id
            payload["batch_label"] = body.batch_label
            payload["batch_source"] = body.batch_source
            rep_id = _default_rep_for(con, user["id"], payload["wholesaler"])
            _insert_cart_item(con, user["id"], payload, rep_id)
            added += 1
    return {"status": "added", "added": added, "batch_id": batch_id,
            "batch_label": body.batch_label, "batch_source": body.batch_source}


@router.post("/add-by-rip")
def add_by_rip(body: AddByRipIn, user: dict = Depends(get_current_user)):
    """Resolve a (wholesaler, rip_code) cluster's full SKU list against the
    catalog and add every member as ONE labelled batch. Same scoping the
    catalog uses (latest rip edition <= today, latest cpl edition <= today,
    blank/zero UPCs filtered), so the cart receives exactly the Case Mix the
    user sees on the page — no bleed-in from rogue blank UPCs."""
    from backend import pricing as _pricing
    cym = _pricing.current_yyyy_mm()
    ws = (body.wholesaler or "").strip()
    code = (body.rip_code or "").strip()
    if not ws or not code:
        raise HTTPException(400, "wholesaler and rip_code are required")
    with get_duckdb() as duck:
        rows = duck.execute(
            "WITH cur AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched "
            "             WHERE edition<=? GROUP BY wholesaler), "
            "ripupc AS (SELECT DISTINCT wholesaler, LTRIM(CAST(upc AS VARCHAR),'0') un "
            "           FROM rip "
            "           WHERE LOWER(wholesaler)=LOWER(?) "
            "             AND CAST(rip_code AS VARCHAR)=? "
            "             AND edition = (SELECT MAX(edition) FROM rip "
            "                            WHERE LOWER(wholesaler)=LOWER(?) "
            "                              AND CAST(rip_code AS VARCHAR)=? "
            "                              AND edition<=?) "
            "             AND upc IS NOT NULL "
            "             AND CAST(upc AS VARCHAR) NOT IN ('', '0', 'None', 'nan') "
            "             AND LTRIM(CAST(upc AS VARCHAR),'0') NOT IN ('', 'None', 'nan')) "
            "SELECT DISTINCT c.product_name, c.wholesaler, "
            "       CAST(c.upc AS VARCHAR) AS upc, c.unit_volume "
            "FROM cpl_enriched c "
            "JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed "
            "JOIN ripupc r ON r.wholesaler=c.wholesaler "
            "  AND r.un=LTRIM(CAST(c.upc AS VARCHAR),'0') "
            "WHERE c.upc IS NOT NULL "
            "  AND LTRIM(CAST(c.upc AS VARCHAR),'0') NOT IN ('', 'None', 'nan') "
            "ORDER BY c.product_name",
            [cym, ws, code, ws, code, cym]).fetchall()
    if not rows:
        return {"status": "noop", "added": 0, "batch_id": None,
                "message": f"No active members found for {ws} RIP {code}."}
    qc = max(0, int(body.qty_cases_per_item or 0))
    batch_id = str(uuid.uuid4())
    label = f"{ws} RIP {code}"
    with get_pg() as con:
        rep_id = _default_rep_for(con, user["id"], ws)
        added = 0
        for r in rows:
            _insert_cart_item(con, user["id"], {
                "product_name": r[0], "wholesaler": r[1], "upc": r[2],
                "unit_volume": r[3], "qty_cases": qc, "qty_units": 0,
                "batch_id": batch_id, "batch_label": label,
                "batch_source": "ai_rip",
            }, rep_id)
            added += 1
    return {"status": "added", "added": added, "batch_id": batch_id,
            "batch_label": label, "batch_source": "ai_rip"}


@router.delete("/batch/{batch_id}")
def remove_batch(batch_id: str, user: dict = Depends(get_current_user)):
    """Undo a batch send: remove every cart item tagged with this batch_id.
    Useful right after an Add-as-Batch click ('oops, wrong cluster')."""
    with get_pg() as con:
        r = con.execute(
            "DELETE FROM cart_items WHERE user_id=%s AND batch_id=%s",
            (user["id"], batch_id),
        )
        try:
            removed = int(r.rowcount or 0)
        except Exception:
            removed = 0
    return {"status": "removed", "removed": removed, "batch_id": batch_id}


@router.put("/{item_id}")
def update_cart_item(item_id: int, body: CartItemPatch, user: dict = Depends(get_current_user)):
    fields, params = [], []
    data = body.model_dump(exclude_unset=True)
    if "rip_choice" in data:
        rc = (data.pop("rip_choice") or "").strip()
        fields.append("rip_choice=%s")
        params.append(rc or None)
    for col in ("qty_cases", "qty_units", "sales_rep_id", "notes", "retail_price"):
        if col in data:
            fields.append(f"{col}=%s")
            params.append(data[col])
    if "saved_for_later" in data:
        fields.append("saved_for_later=%s")
        params.append(1 if data["saved_for_later"] else 0)
    if not fields:
        return {"status": "noop"}
    fields.append(f"updated_at={NOW_UTC}")
    params.extend([item_id, user["id"]])
    with get_pg() as con:
        con.execute(f"UPDATE cart_items SET {', '.join(fields)} WHERE id=%s AND user_id=%s", params)
    return {"status": "updated"}


@router.post("/{item_id}/switch-distributor")
def switch_distributor_inline(item_id: int, body: SwitchDistributorIn,
                              user: dict = Depends(get_current_user)):
    """Move ONE line to another distributor IN PLACE (the same row, restyled to
    the target house), preserving its quantity. Resolves the SAME SKU at the
    target from the precomputed sku_offer grid (same edition, same identity), so
    it can only switch to a distributor that actually carries the product. Reps
    are per distributor, so the rep is re-assigned. If a line for the target house
    already exists (same product + batch), the quantities MERGE and this line is
    removed. Returns the freshly enriched cart so the line re-renders with the
    target's price and a fresh suggestion stack."""
    target = (body.wholesaler or "").strip()
    if not target:
        raise HTTPException(400, "wholesaler is required")

    with get_pg() as con:
        row = con.execute(
            "SELECT id, product_name, wholesaler, upc, unit_volume, combo_code, "
            "       qty_cases, qty_units, batch_id, saved_for_later "
            "FROM cart_items WHERE id=%s AND user_id=%s", (item_id, user["id"])
        ).fetchone()
    if not row:
        raise HTTPException(404, "Line not found")
    line = dict(row)
    if line["wholesaler"].lower() == target.lower():
        return {"status": "noop", "cart": _load_enriched_cart(user)}

    # Resolve the target distributor's matching offer for the SAME item — UPC grid
    # first, name+size fallback for UPC-less lines (combo / placeholder barcode).
    with get_duckdb() as dcon:
        tgt = _resolve_switch_target(dcon, line["wholesaler"], line.get("upc"),
                                     line.get("unit_volume"), line.get("product_name"), target)
    if not tgt:
        raise HTTPException(
            409, f"{_dist_label(target)} does not carry this product in the compared edition")
    tgt_name, tgt_upc, tgt_uv = tgt[0], (tgt[1] or line.get("upc")), (tgt[2] or line.get("unit_volume"))

    with get_pg() as con:
        rep_id = _default_rep_for(con, user["id"], target)
        # Does a line for the target house already exist (same product + batch)?
        # The unique key is (user, product_name, wholesaler, unit_volume, batch).
        existing = con.execute(
            "SELECT id, qty_cases, qty_units FROM cart_items "
            "WHERE user_id=%s AND product_name=%s AND wholesaler=%s "
            "AND COALESCE(unit_volume,'')=%s AND COALESCE(batch_id,'')=%s AND id<>%s",
            (user["id"], tgt_name, target, tgt_uv or "",
             line.get("batch_id") or "", item_id),
        ).fetchone()
        if existing:
            con.execute(
                f"UPDATE cart_items SET qty_cases=qty_cases+%s, qty_units=qty_units+%s, "
                f"saved_for_later=0, updated_at={NOW_UTC} WHERE id=%s AND user_id=%s",
                (line["qty_cases"] or 0, line["qty_units"] or 0,
                 existing["id"], user["id"]),
            )
            con.execute("DELETE FROM cart_items WHERE id=%s AND user_id=%s",
                        (item_id, user["id"]))
            new_id = existing["id"]
        else:
            # Rewrite the line in place. rip_choice is cleared: RIP codes are
            # per (distributor, edition), so the source pick can't carry over.
            con.execute(
                f"UPDATE cart_items SET wholesaler=%s, product_name=%s, upc=%s, "
                f"unit_volume=%s, sales_rep_id=%s, rip_choice=NULL, updated_at={NOW_UTC} "
                f"WHERE id=%s AND user_id=%s",
                (target, tgt_name, tgt_upc, tgt_uv, rep_id, item_id, user["id"]),
            )
            new_id = item_id

    return {"status": "switched", "line_id": new_id, "cart": _load_enriched_cart(user)}


@router.delete("/{item_id}")
def remove_cart_item(item_id: int, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        con.execute("DELETE FROM cart_items WHERE id=%s AND user_id=%s", (item_id, user["id"]))
    return {"status": "removed"}


@router.post("/swap-distributor")
def swap_distributor(body: SwapDistributorIn, user: dict = Depends(get_current_user)):
    """One-command distributor swap: for the user's active cart, replace items from
    one distributor with the SAME products (matched by UPC) at another distributor,
    preserving each line's quantities. Works for a whole RIP case mix (pass
    rip_code), a specific UPC set (pass upcs), or every item from the distributor
    (pass neither). Atomic per item: the new line is added, then the old removed.

    Matching is by NORMALIZED UPC — the same product is listed under different
    names per distributor, so this is the only reliable swap key."""
    frm = (body.from_distributor or "").strip()
    to = (body.to_distributor or "").strip()
    if not frm or not to:
        raise HTTPException(400, "from_distributor and to_distributor are required")
    if frm.lower() == to.lower():
        return {"swapped": [], "not_carried": [], "skipped_no_upc": [],
                "message": "Source and target distributor are the same — nothing to swap."}

    def _norm(u):
        return str(u or "").lstrip("0")

    # 1) Active cart lines from the FROM distributor.
    with get_pg() as con:
        rows = con.execute(
            "SELECT id, product_name, wholesaler, upc, unit_volume, qty_cases, qty_units "
            "FROM cart_items WHERE user_id=%s AND COALESCE(saved_for_later,0)=0 "
            "AND LOWER(wholesaler)=LOWER(%s)", (user["id"], frm)).fetchall()
    items = [dict(r) for r in rows]
    if not items:
        return {"swapped": [], "not_carried": [], "skipped_no_upc": [],
                "message": f"No active {frm} items in your cart to swap."}

    # Optional scope: a RIP code's case mix, or an explicit UPC set.
    limit_upcs = None
    if body.rip_code:
        # RIP codes are edition + distributor specific and get RECYCLED month to
        # month (e.g. Fedway 10265 was Jameson in April, Ricard in June). Scope the
        # case mix to the FROM-distributor's CURRENT rip edition only — never every
        # edition / every distributor, which would swap unrelated products.
        from backend import pricing as _pricing
        cym = _pricing.current_yyyy_mm()
        with get_duckdb() as dcon:
            ru = dcon.execute(
                "SELECT DISTINCT LTRIM(CAST(upc AS VARCHAR),'0') un FROM rip "
                "WHERE CAST(rip_code AS VARCHAR)=? AND LOWER(wholesaler)=LOWER(?) "
                "AND edition = (SELECT MAX(edition) FROM rip "
                "WHERE CAST(rip_code AS VARCHAR)=? AND LOWER(wholesaler)=LOWER(?) AND edition<=?)",
                [str(body.rip_code), frm, str(body.rip_code), frm, cym]).fetchall()
        limit_upcs = {str(r[0]) for r in ru if r[0]}
    elif body.upcs:
        limit_upcs = {_norm(u) for u in body.upcs}
    targets = [it for it in items if (limit_upcs is None or _norm(it["upc"]) in limit_upcs)]

    # 2) Resolve the TO-distributor equivalent for each UPC (latest edition).
    upcs = sorted({_norm(it["upc"]) for it in targets if _norm(it["upc"])})
    to_map: dict = {}
    if upcs:
        with get_duckdb() as dcon:
            ph = ", ".join("?" for _ in upcs)
            df = dcon.execute(
                "WITH latest AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched GROUP BY wholesaler) "
                "SELECT LTRIM(CAST(c.upc AS VARCHAR),'0') un, c.product_name, c.wholesaler, "
                "CAST(c.upc AS VARCHAR) upc, c.unit_volume "
                "FROM cpl_enriched c JOIN latest l ON c.wholesaler=l.wholesaler AND c.edition=l.ed "
                f"WHERE LOWER(c.wholesaler)=LOWER(?) AND LTRIM(CAST(c.upc AS VARCHAR),'0') IN ({ph})",
                [to] + upcs).fetchdf()
            for _, r in df.iterrows():
                to_map.setdefault(str(r["un"]), {
                    "product_name": r["product_name"], "wholesaler": r["wholesaler"],
                    "upc": str(r["upc"]), "unit_volume": r["unit_volume"]})

    # 3) Swap each matched line: add the equivalent (same qty), then drop the old.
    swapped, not_carried, no_upc = [], [], []
    with get_pg() as con:
        for it in targets:
            un = _norm(it["upc"])
            if not un:
                no_upc.append(it["product_name"]); continue
            tgt = to_map.get(un)
            if not tgt:
                not_carried.append(it["product_name"]); continue
            rep_id = _default_rep_for(con, user["id"], tgt["wholesaler"])
            _insert_cart_item(con, user["id"], {
                "product_name": tgt["product_name"], "wholesaler": tgt["wholesaler"],
                "upc": tgt["upc"], "unit_volume": tgt["unit_volume"],
                "qty_cases": it["qty_cases"], "qty_units": it["qty_units"],
            }, rep_id)
            con.execute("DELETE FROM cart_items WHERE id=%s AND user_id=%s", (it["id"], user["id"]))
            swapped.append({"from": it["product_name"], "to": tgt["product_name"]})

    parts = [f"Swapped {len(swapped)} item{'s' if len(swapped) != 1 else ''} from {frm} to {to}."]
    if not_carried:
        parts.append(f"{len(not_carried)} not carried by {to} (left as-is).")
    return {"swapped": swapped, "not_carried": not_carried, "skipped_no_upc": no_upc,
            "from_distributor": frm, "to_distributor": to, "message": " ".join(parts)}


@router.post("/clear")
def clear_cart(scope: str = "active", user: dict = Depends(get_current_user)):
    """Wipe the cart in one atomic call.

    scope='active'  -> only the active (non-saved-for-later) items.
    scope='saved'   -> only saved-for-later items.
    scope='all'     -> everything in the cart.
    Default is 'active' so the explicit "Clear all cart" button on the page
    doesn't surprise users by removing their save-for-later stash too."""
    with get_pg() as con:
        if scope == "all":
            r = con.execute(
                "DELETE FROM cart_items WHERE user_id=%s", (user["id"],)
            )
        elif scope == "saved":
            r = con.execute(
                "DELETE FROM cart_items WHERE user_id=%s AND saved_for_later=1",
                (user["id"],),
            )
        else:
            r = con.execute(
                "DELETE FROM cart_items WHERE user_id=%s AND saved_for_later=0",
                (user["id"],),
            )
        try:
            removed = int(r.rowcount or 0)
        except Exception:
            removed = 0
    return {"status": "cleared", "removed": removed, "scope": scope}


@router.post("/bulk-save-for-later")
def bulk_save_for_later(body: dict, user: dict = Depends(get_current_user)):
    """Flip saved_for_later on a list of cart line ids in one round-trip.

    body = {"ids": [...], "saved": true|false}
    Used by "Save all for later" / "Move all to cart" on a RIP group header
    so the user doesn't fire N individual PATCH calls."""
    ids = [int(x) for x in (body.get("ids") or []) if str(x).isdigit()]
    saved = 1 if body.get("saved") else 0
    if not ids:
        return {"status": "noop", "updated": 0}
    with get_pg() as con:
        ph = ", ".join(["%s"] * len(ids))
        con.execute(
            f"UPDATE cart_items SET saved_for_later=%s, updated_at={NOW_UTC} "
            f"WHERE user_id=%s AND id IN ({ph})",
            (saved, user["id"], *ids),
        )
    return {"status": "updated", "updated": len(ids), "saved": bool(saved)}


@router.post("/group-note")
def set_group_note(body: GroupNoteIn, user: dict = Depends(get_current_user)):
    """Save the per-distributor header note (becomes the order's notes on send)."""
    with get_pg() as con:
        con.execute(
            f"""INSERT INTO cart_group_notes (user_id, wholesaler, note)
                VALUES (%s,%s,%s)
                ON CONFLICT (user_id, wholesaler)
                DO UPDATE SET note=EXCLUDED.note, updated_at={NOW_UTC}""",
            (user["id"], body.wholesaler, body.note),
        )
    return {"status": "saved"}


@router.post("/assign-rep")
def assign_rep(body: AssignRepIn, user: dict = Depends(get_current_user)):
    """Set the sales rep for every ACTIVE item of one distributor (group rep)."""
    with get_pg() as con:
        con.execute(
            f"""UPDATE cart_items SET sales_rep_id=%s, updated_at={NOW_UTC}
                WHERE user_id=%s AND wholesaler=%s AND saved_for_later=0""",
            (body.sales_rep_id, user["id"], body.wholesaler),
        )
    return {"status": "assigned"}


@router.post("/from-list")
def add_from_list(body: FromListIn, user: dict = Depends(get_current_user)):
    """Move selected list items into the cart (the list keeps them; lists are
    reusable). Adds with qty 0 — the user sets quantities in the cart."""
    with get_pg() as con:
        own = con.execute(
            "SELECT 1 FROM lists WHERE id=%s AND user_id=%s", (body.list_id, user["id"])
        ).fetchone()
        if not own:
            raise HTTPException(404, "List not found")
        q = "SELECT * FROM list_items WHERE list_id=%s"
        params = [body.list_id]
        if body.item_ids:
            ph = ", ".join(["%s"] * len(body.item_ids))
            q += f" AND id IN ({ph})"
            params.extend(body.item_ids)
        rows = [dict(r) for r in con.execute(q, params).fetchall()]
        for it in rows:
            rep_id = _default_rep_for(con, user["id"], it["wholesaler"])
            _insert_cart_item(con, user["id"], it, rep_id)
    return {"status": "added", "count": len(rows)}


@router.post("/from-combo")
def add_from_combo(body: FromComboIn, user: dict = Depends(get_current_user)):
    """Add every product in a combo bundle to the cart as separate lines, each
    tagged with combo_code. They group under the combo's distributor/rep."""
    from backend.db import read_parquet
    try:
        from backend.routers.user_state import _parse_case_qty
    except Exception:
        _parse_case_qty = None

    with get_duckdb() as duck:
        src = read_parquet(duck, "combo")
        # Latest edition only, one row per component barcode: the combo source
        # repeats components across editions, which would otherwise double-add.
        rows = duck.execute(
            f"""WITH latest AS (
                  SELECT MAX(edition) AS ed FROM {src}
                  WHERE wholesaler = $ws AND combo_code = $code
                )
                SELECT product_name, ANY_VALUE(upc) AS upc, ANY_VALUE(qty_per_pack) AS qty_per_pack
                FROM {src}
                WHERE wholesaler = $ws AND combo_code = $code
                  AND product_name IS NOT NULL
                  AND edition = (SELECT ed FROM latest)
                GROUP BY product_name, LTRIM(COALESCE(upc,''),'0')""",
            {"ws": body.wholesaler, "code": body.combo_code},
        ).fetchdf()

    added = 0
    with get_pg() as con:
        rep_id = _default_rep_for(con, user["id"], body.wholesaler)
        for _, r in rows.iterrows():
            pname = r["product_name"]
            if pname is None or (isinstance(pname, float) and pname != pname):
                continue
            upc = None if r["upc"] is None or (isinstance(r["upc"], float) and r["upc"] != r["upc"]) else str(r["upc"])
            qc = _parse_case_qty(r["qty_per_pack"]) if _parse_case_qty else 1
            mult = max(1, body.qty)
            _insert_cart_item(con, user["id"], {
                "product_name": str(pname), "wholesaler": body.wholesaler,
                "upc": upc, "combo_code": body.combo_code,
                "qty_cases": (qc or 1) * mult, "qty_units": 0,
            }, rep_id)
            added += 1
    return {"status": "added", "added": added}


@router.post("/send")
def send_cart(user: dict = Depends(get_current_user)):
    """Turn the active cart into orders: one submitted order per sales rep (all
    of a rep's lines go together). Each order is emailed to its rep, then those
    items are removed from the cart. Items with no rep assigned are left behind
    and reported so the user can assign a rep and resend."""
    # Reuse the existing submit machinery (builds the PO + emails the rep).
    from backend.routers.user_state import submit_order, SubmitOrderIn

    with get_pg() as con:
        active = [dict(r) for r in con.execute(
            "SELECT * FROM cart_items WHERE user_id=%s AND saved_for_later=0 ORDER BY created_at",
            (user["id"],),
        ).fetchall()]
        group_notes = {r["wholesaler"]: r["note"] for r in con.execute(
            "SELECT wholesaler, note FROM cart_group_notes WHERE user_id=%s", (user["id"],)
        ).fetchall()}

    groups: dict[int, list] = {}
    no_rep = 0
    for it in active:
        rid = it.get("sales_rep_id")
        if not rid:
            no_rep += 1
            continue
        groups.setdefault(rid, []).append(it)

    results = []
    for rid, items in groups.items():
        distributor = items[0]["wholesaler"]
        with get_pg() as con:
            rep = con.execute(
                "SELECT name FROM sales_reps WHERE id=%s AND user_id=%s", (rid, user["id"])
            ).fetchone()
            rep_name = rep["name"] if rep else distributor
            oid = con.execute(
                "INSERT INTO orders (user_id, name, status, distributor, sales_rep_id, notes) "
                "VALUES (%s,%s,'draft',%s,%s,%s) RETURNING id",
                (user["id"], f"Cart order - {rep_name}", distributor, rid,
                 group_notes.get(distributor)),
            ).fetchone()["id"]
            for it in items:
                con.execute(
                    """INSERT INTO order_lines
                         (order_id, product_name, wholesaler, upc, unit_volume,
                          qty_cases, qty_units, combo_code, retail_price, notes)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (oid, it["product_name"], it["wholesaler"], it.get("upc"),
                     it.get("unit_volume"), it.get("qty_cases") or 0, it.get("qty_units") or 0,
                     it.get("combo_code"), it.get("retail_price"), it.get("notes")),
                )
        # Submit + email (own transaction inside submit_order).
        res = submit_order(oid, SubmitOrderIn(), user)
        # Remove the sent items from the cart.
        ids = [it["id"] for it in items]
        with get_pg() as con:
            ph = ", ".join(["%s"] * len(ids))
            con.execute(f"DELETE FROM cart_items WHERE user_id=%s AND id IN ({ph})", (user["id"], *ids))
        results.append({"order_id": oid, "rep_id": rid, "rep_name": rep_name,
                        "lines": len(items), "emailed": res.get("emailed"), "to": res.get("to")})

    return {"sent": len(results), "orders": results, "skipped_no_rep": no_rep}


@router.post("/reorder")
def reorder(body: ReorderIn, user: dict = Depends(get_current_user)):
    """Copy a past order's lines back into the active cart (re-resolving the sales
    rep by distributor), so 'reorder my last order' / 'same as last month' works in
    one step. Quantities are preserved; existing cart lines merge (qty adds)."""
    with get_pg() as con:
        owns = con.execute(
            "SELECT name FROM orders WHERE id=%s AND user_id=%s", (body.order_id, user["id"])).fetchone()
        if not owns:
            return {"added": 0, "error": "Order not found."}
        lines = [dict(r) for r in con.execute(
            "SELECT product_name, wholesaler, upc, unit_volume, combo_code, qty_cases, qty_units "
            "FROM order_lines WHERE order_id=%s", (body.order_id,)).fetchall()]
        added = 0
        for ln in lines:
            if not ln.get("product_name") or not ln.get("wholesaler"):
                continue
            rep_id = _default_rep_for(con, user["id"], ln["wholesaler"])
            _insert_cart_item(con, user["id"], {
                "product_name": ln["product_name"], "wholesaler": ln["wholesaler"],
                "upc": ln.get("upc"), "unit_volume": ln.get("unit_volume"),
                "combo_code": ln.get("combo_code"),
                "qty_cases": ln.get("qty_cases") or 0, "qty_units": ln.get("qty_units") or 0,
            }, rep_id)
            added += 1
    return {"added": added, "order_name": owns["name"]}
