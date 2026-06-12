"""Cart API — one server-side cart per user.

Items group by their assigned sales rep. On add, the rep is auto-assigned when
the product's distributor has exactly one rep; otherwise it's left empty and the
user picks it in the cart (a distributor can have several reps). saved_for_later=1
parks an item in the "Save for later" section below the active cart. The
"send to all reps" step (turns each rep group into a submitted order) is added in
the Phase 3 order cutover.
"""
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
                       e.has_discount AS hd, e.has_rip AS hr,
                       e.discount_pct AS dp, e.total_savings_per_case AS ts,
                       CAST(e.rip_code AS VARCHAR) AS rc,
                       e.edition AS ed,
                       e.discount_1_qty AS d1q, e.discount_1_amt AS d1a,
                       e.discount_2_qty AS d2q, e.discount_2_amt AS d2a,
                       e.discount_3_qty AS d3q, e.discount_3_amt AS d3a,
                       e.discount_4_qty AS d4q, e.discount_4_amt AS d4a,
                       e.discount_5_qty AS d5q, e.discount_5_amt AS d5a
                FROM {src} e JOIN latest l ON e.wholesaler=l.wholesaler AND e.edition=l.ed
                WHERE LTRIM(e.upc,'0') IN ({ph})
            """, prm).fetchdf()
            for _, r in df.iterrows():
                pmap[(r["w"], str(r["un"]), r["pn"] or "", r["uv"] or "")] = r
                nmap.setdefault((r["w"], str(r["un"]), r["pn"] or ""), r)
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
            it["unit_type"] = r.get("ut")   # container (bottle/can/keg) for the UI
            it["effective_unit_price"] = round(ecp / uq, 2) if (ecp and uq) else cl(r["fup"])
            it["has_discount"] = bool(r["hd"])
            it["has_rip"] = bool(r["hr"])
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


@router.get("")
def get_cart(user: dict = Depends(get_current_user)):
    """All cart items (active + saved-for-later) with image, rep name, catalogue
    pricing + deal tiers, plus per-distributor header notes."""
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
    for it in items:
        rep = reps.get(it.get("sales_rep_id"))
        it["sales_rep_name"] = rep["name"] if rep else None
    return {"items": items, "group_notes": group_notes}


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
    """Best save you already get at `cases`, and the next deeper tier above it."""
    cur_save = 0.0
    for t in tiers:
        if t["qty"] <= max(cases, 0):
            cur_save = max(cur_save, t["save"])
    nxt = next((t for t in tiers if t["qty"] > cases and t["save"] > cur_save + 0.005), None)
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
            extra = round(nxt["save"] * nxt["qty"] - cur_save * C, 2)
            if extra <= 1.0:
                continue
            payload = {
                "type": "tier_gap", "kind": "qd" if kind == "discount" else "rip",
                "line_id": it.get("id"), "product_name": name, "upc": it.get("upc"), "abg_sku": it.get("abg_sku"),
                "wholesaler": it.get("wholesaler"), "unit_volume": it.get("unit_volume"),
                "unit_type": it.get("unit_type"),
                "unit_qty": it.get("unit_qty"), "vintage": it.get("vintage"),
                "current_cases": C, "target_qty": nxt["qty"], "add_cases": nxt["qty"] - C,
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

        def _save_at(ts, qty):
            return max((x["save"] for x in ts if x["qty"] <= qty), default=0.0)

        best = None
        for code, ts in by_code.items():
            if code == eff:
                continue
            # Compare at the candidate's entry quantity (or the line's current
            # cases when already past it): equal commitment, different payout.
            target = max(min(x["qty"] for x in ts), C)
            mine = _save_at(by_code[eff], target)
            theirs = _save_at(ts, target)
            gain = round((theirs - mine) * target, 2)
            if theirs > mine + 0.005 and gain > 1.0 and (best is None or gain > best["extra_savings"]):
                ct = next(x for x in sorted(ts, key=lambda x: x["qty"]) if x["qty"] <= target)
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
        sum_cases = sum(int(it.get("qty_cases") or 0) for it in grp)
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
            "add_cases": nxt["qty"] - sum_cases, "extra_savings": extra,
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


@router.post("")
def add_to_cart(body: CartItemIn, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        rep_id = _default_rep_for(con, user["id"], body.wholesaler)
        _insert_cart_item(con, user["id"], body.model_dump(), rep_id)
    return {"status": "added"}


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
