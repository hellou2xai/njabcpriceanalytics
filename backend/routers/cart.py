"""Cart API — one server-side cart per user.

Items group by their assigned sales rep. On add, the rep is auto-assigned when
the product's distributor has exactly one rep; otherwise it's left empty and the
user picks it in the cart (a distributor can have several reps). saved_for_later=1
parks an item in the "Save for later" section below the active cart. The
"send to all reps" step (turns each rep group into a submitted order) is added in
the Phase 3 order cutover.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from backend.pg import get_pg
from backend.db import get_duckdb, NOW_UTC
from backend.auth import get_current_user
from backend.enrichment_join import attach_enrichment_image

router = APIRouter(prefix="/api/cart", tags=["cart"])


class CartItemIn(BaseModel):
    product_name: str
    wholesaler: str
    upc: Optional[str] = None
    unit_volume: Optional[str] = None
    combo_code: Optional[str] = None
    qty_cases: int = 0
    qty_units: int = 0


class CartItemPatch(BaseModel):
    qty_cases: Optional[int] = None
    qty_units: Optional[int] = None
    sales_rep_id: Optional[int] = None
    saved_for_later: Optional[bool] = None
    notes: Optional[str] = None
    retail_price: Optional[float] = None


class AssignRepIn(BaseModel):
    wholesaler: str
    sales_rep_id: Optional[int] = None


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


def _default_rep_for(con, user_id: int, wholesaler: str):
    """Return the rep id when the distributor has exactly one rep, else None."""
    reps = con.execute(
        "SELECT id FROM sales_reps WHERE user_id=%s AND distributor=%s", (user_id, wholesaler)
    ).fetchall()
    return reps[0]["id"] if len(reps) == 1 else None


def _insert_cart_item(con, user_id, item: dict, rep_id):
    con.execute(
        f"""INSERT INTO cart_items
              (user_id, product_name, wholesaler, upc, unit_volume, combo_code,
               qty_cases, qty_units, sales_rep_id, saved_for_later)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,0)
            ON CONFLICT (user_id, product_name, wholesaler, unit_volume) DO UPDATE SET
              qty_cases = cart_items.qty_cases + EXCLUDED.qty_cases,
              qty_units = cart_items.qty_units + EXCLUDED.qty_units,
              saved_for_later = 0,
              updated_at = {NOW_UTC}""",
        (user_id, item["product_name"], item["wholesaler"], item.get("upc"),
         item.get("unit_volume"), item.get("combo_code"),
         item.get("qty_cases", 0) or 0, item.get("qty_units", 0) or 0, rep_id),
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
                       e.effective_case_price AS ecp, e.unit_qty AS uq,
                       e.has_discount AS hd, e.has_rip AS hr,
                       e.discount_pct AS dp, e.total_savings_per_case AS ts,
                       CAST(e.rip_code AS VARCHAR) AS rc
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
            ecp = cl(r["ecp"])
            it["effective_case_price"] = ecp
            try:                                  # unit_qty (bottles/case) is stored as text
                uq = float(r["uq"])
                uq = None if _m.isnan(uq) else uq
            except Exception:
                uq = None
            it["unit_qty"] = uq
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


@router.post("")
def add_to_cart(body: CartItemIn, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        rep_id = _default_rep_for(con, user["id"], body.wholesaler)
        _insert_cart_item(con, user["id"], body.model_dump(), rep_id)
    return {"status": "added"}


@router.put("/{item_id}")
def update_cart_item(item_id: int, body: CartItemPatch, user: dict = Depends(get_current_user)):
    fields, params = [], []
    data = body.model_dump(exclude_unset=True)
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
