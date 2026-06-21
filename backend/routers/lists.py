"""Lists API — multiple named product lists per user (evolves Order Analysis).

A list is a reusable, named collection of products. Users add products from
anywhere, then select items (checkbox / right-click) to send into the Cart or
delete them. Lists persist server-side per user.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from backend.pg import get_pg
from backend.db import get_duckdb, NOW_UTC
from backend.auth import get_current_user
from backend.enrichment_join import attach_enrichment_image, attach_sku_mapping

router = APIRouter(prefix="/api/lists", tags=["lists"])


class ListIn(BaseModel):
    name: str


class ListItemIn(BaseModel):
    product_name: str
    wholesaler: str
    upc: Optional[str] = None
    unit_volume: Optional[str] = None
    combo_code: Optional[str] = None
    notes: Optional[str] = None
    list_id: Optional[int] = None  # used by the "add to list" convenience endpoint


class MoveIn(BaseModel):
    item_ids: list[int]


def _owned(con, list_id: int, user_id: int):
    row = con.execute("SELECT id FROM lists WHERE id=%s AND user_id=%s", (list_id, user_id)).fetchone()
    if not row:
        raise HTTPException(404, "List not found")


@router.get("")
def list_lists(user: dict = Depends(get_current_user)):
    """All of the user's lists with item counts."""
    with get_pg() as con:
        rows = con.execute(
            """SELECT l.id, l.name, l.created_at, l.updated_at,
                      (SELECT count(*) FROM list_items li WHERE li.list_id = l.id) AS item_count
               FROM lists l WHERE l.user_id = %s ORDER BY l.created_at""",
            (user["id"],),
        ).fetchall()
    return [dict(r) for r in rows]


@router.post("")
def create_list(body: ListIn, user: dict = Depends(get_current_user)):
    name = (body.name or "").strip() or "Untitled list"
    with get_pg() as con:
        row = con.execute(
            "INSERT INTO lists (user_id, name) VALUES (%s, %s) RETURNING id, name, created_at, updated_at",
            (user["id"], name),
        ).fetchone()
    return dict(row)


@router.put("/{list_id}")
def rename_list(list_id: int, body: ListIn, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        _owned(con, list_id, user["id"])
        con.execute(
            f"UPDATE lists SET name=%s, updated_at={NOW_UTC} WHERE id=%s",
            ((body.name or "").strip() or "Untitled list", list_id),
        )
    return {"status": "renamed"}


@router.delete("/{list_id}")
def delete_list(list_id: int, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        con.execute("DELETE FROM lists WHERE id=%s AND user_id=%s", (list_id, user["id"]))
    return {"status": "deleted"}


@router.get("/{list_id}/analyze")
def analyze_list(list_id: int, user: dict = Depends(get_current_user)):
    """Analyze a saved list for savings — same engine as the cart. A list has no
    quantities (it's a wishlist), so every line is treated as qty 0: the result
    reads as 'what you could save if you order these' (entry-tier nudges +
    case-mix qualification across the list)."""
    from backend.routers.cart import analyze_lines
    with get_pg() as con:
        _owned(con, list_id, user["id"])
        items = [dict(r) for r in con.execute(
            "SELECT * FROM list_items WHERE list_id=%s ORDER BY created_at DESC", (list_id,)
        ).fetchall()]
    for it in items:
        it.setdefault("qty_cases", 0)
        it.setdefault("qty_units", 0)
    return analyze_lines(items)


@router.get("/{list_id}")
def get_list(list_id: int, user: dict = Depends(get_current_user)):
    """One list with its items, each carrying a Go-UPC image_url for thumbnails
    and a rip_code lookup from the latest CPL so the UI can sub-group lines by
    RIP rebate (same as the cart). rip_code stays None for items not on RIP."""
    with get_pg() as con:
        lst = con.execute(
            "SELECT id, name, created_at, updated_at FROM lists WHERE id=%s AND user_id=%s",
            (list_id, user["id"]),
        ).fetchone()
        if not lst:
            raise HTTPException(404, "List not found")
        items = [dict(r) for r in con.execute(
            "SELECT * FROM list_items WHERE list_id=%s ORDER BY created_at DESC", (list_id,)
        ).fetchall()]
    if items:
        from backend import pricing as _pricing
        with get_duckdb() as dcon:
            attach_enrichment_image(dcon, items)
            attach_sku_mapping(dcon, items)
            _attach_rip_code_for_list_items(dcon, items)
            try:
                # Full deal tiers (same canonical attach the cart uses) so the
                # Lists UI can show each line's RIP PROGRAMS and let the buyer
                # pick one (rip_choice) before the line ever reaches the cart.
                from backend.routers.cart import _attach_cart_pricing
                _attach_cart_pricing(dcon, items)
            except Exception:
                pass
            try:
                # Cross-distributor offer grid (UPC + name fallback) so each list
                # line gets the same inline "change distributor" picker as the cart.
                from backend.routers.cart import _attach_comparison
                _attach_comparison(dcon, items)
            except Exception:
                pass
            try:
                _pricing.attach_rip_gaps(dcon, items)   # no-RIP "avoid these days" windows
            except Exception:
                pass
    for it in items:
        it.setdefault("comparison", [])
    return {**dict(lst), "items": items}


class ListItemPatch(BaseModel):
    notes: Optional[str] = None
    # Chosen RIP program for the line; null/'' resets to the default.
    rip_choice: Optional[str] = None


class SwitchDistributorIn(BaseModel):
    """Move ONE list item to another distributor that carries the SAME product."""
    wholesaler: str


@router.post("/{list_id}/items/{item_id}/switch-distributor")
def switch_list_item_distributor(list_id: int, item_id: int, body: SwitchDistributorIn,
                                 user: dict = Depends(get_current_user)):
    """Switch a list line to another distributor IN PLACE, resolving the SAME item
    at the target (UPC grid + name fallback, shared with the cart). rip_choice is
    cleared — RIP codes are per (distributor, edition). Returns the refreshed list."""
    target = (body.wholesaler or "").strip()
    if not target:
        raise HTTPException(400, "wholesaler is required")
    with get_pg() as con:
        _owned(con, list_id, user["id"])
        row = con.execute(
            "SELECT id, product_name, wholesaler, upc, unit_volume "
            "FROM list_items WHERE id=%s AND list_id=%s", (item_id, list_id)).fetchone()
    if not row:
        raise HTTPException(404, "Item not found")
    line = dict(row)
    if line["wholesaler"].lower() == target.lower():
        return {"status": "noop"}

    from backend.routers.cart import _resolve_switch_target, _dist_label
    with get_duckdb() as dcon:
        tgt = _resolve_switch_target(dcon, line["wholesaler"], line.get("upc"),
                                     line.get("unit_volume"), line.get("product_name"), target)
    if not tgt:
        raise HTTPException(
            409, f"{_dist_label(target)} does not carry this product in the compared edition")
    tgt_name, tgt_upc, tgt_uv = tgt[0], (tgt[1] or line.get("upc")), (tgt[2] or line.get("unit_volume"))

    with get_pg() as con:
        # The list unique key is (list_id, product_name, wholesaler, unit_volume).
        # If the target row already exists, drop this line; else rewrite in place.
        existing = con.execute(
            "SELECT id FROM list_items WHERE list_id=%s AND product_name=%s AND wholesaler=%s "
            "AND COALESCE(unit_volume,'')=%s AND id<>%s",
            (list_id, tgt_name, target, tgt_uv or "", item_id)).fetchone()
        if existing:
            con.execute("DELETE FROM list_items WHERE id=%s AND list_id=%s", (item_id, list_id))
        else:
            con.execute(
                "UPDATE list_items SET wholesaler=%s, product_name=%s, upc=%s, "
                "unit_volume=%s, rip_choice=NULL WHERE id=%s AND list_id=%s",
                (target, tgt_name, tgt_upc, tgt_uv, item_id, list_id))
        con.execute(f"UPDATE lists SET updated_at={NOW_UTC} WHERE id=%s", (list_id,))
    return get_list(list_id, user)


@router.put("/{list_id}/items/{item_id}")
def update_list_item(list_id: int, item_id: int, body: ListItemPatch,
                     user: dict = Depends(get_current_user)):
    fields, params = [], []
    data = body.model_dump(exclude_unset=True)
    if "rip_choice" in data:
        rc = (data.pop("rip_choice") or "").strip()
        fields.append("rip_choice=%s")
        params.append(rc or None)
    if "notes" in data:
        fields.append("notes=%s")
        params.append(data["notes"])
    if not fields:
        return {"status": "noop"}
    params.extend([item_id, list_id])
    with get_pg() as con:
        _owned(con, list_id, user["id"])
        con.execute(
            f"UPDATE list_items SET {', '.join(fields)} WHERE id=%s AND list_id=%s",
            params)
        con.execute(f"UPDATE lists SET updated_at={NOW_UTC} WHERE id=%s", (list_id,))
    return {"status": "updated"}


def _attach_rip_code_for_list_items(dcon, items):
    """Best-effort: attach rip_code AND catalogue pricing (frontline/effective,
    pack size, unit type) from the latest CPL edition per UPC, so the Lists UI
    can sub-group by RIP and show the same price columns the cart shows (user
    request: lists were "name only", too little data to act on). Reads
    precomputed columns only. Failures here must never break the page."""
    from backend.db import read_parquet
    from backend.routers.cart import _cur_ed
    import math as _m

    def _clean(v):
        if v is None or (isinstance(v, float) and _m.isnan(v)):
            return None
        return v

    try:
        norms = sorted({str(it.get("upc") or "").lstrip("0") for it in items if it.get("upc")})
        if not norms:
            for it in items:
                it["rip_code"] = None
            return
        src = read_parquet(dcon, "cpl_enriched")
        ph = ", ".join(f"$p{i}" for i in range(len(norms)))
        prm = {f"p{i}": u for i, u in enumerate(norms)}
        df = dcon.execute(f"""
            WITH latest AS (SELECT wholesaler, {_cur_ed()} AS ed FROM {src} GROUP BY wholesaler)
            SELECT e.wholesaler AS w, LTRIM(e.upc,'0') AS un, CAST(e.rip_code AS VARCHAR) AS rc,
                   e.unit_volume AS uv, e.unit_qty AS uq, e.unit_type AS ut,
                   e.frontline_case_price AS fc, e.frontline_unit_price AS fu,
                   e.effective_case_price AS ec, e.total_savings_per_case AS sv
            FROM {src} e JOIN latest l ON e.wholesaler=l.wholesaler AND e.edition=l.ed
            WHERE e.upc_norm IN ({ph})
        """, prm).fetchdf()
        lookup = {}
        price_by_size = {}
        price_any = {}
        for _, r in df.iterrows():
            rc = r["rc"]
            if rc is not None and not (isinstance(rc, float) and _m.isnan(rc)):
                rc_s = str(rc).strip()
                if rc_s and rc_s.lower() not in ("none", "nan", "0"):
                    lookup[(r["w"], str(r["un"]))] = rc_s
            rec = {
                "unit_qty": _clean(r["uq"]), "unit_type": _clean(r["ut"]),
                "frontline_case_price": _clean(r["fc"]), "frontline_unit_price": _clean(r["fu"]),
                "effective_case_price": _clean(r["ec"]), "total_savings_per_case": _clean(r["sv"]),
            }
            key_any = (r["w"], str(r["un"]))
            price_any.setdefault(key_any, rec)
            uv = str(_clean(r["uv"]) or "").strip().lower()
            if uv:
                price_by_size[(r["w"], str(r["un"]), uv)] = rec
        for it in items:
            un = str(it.get("upc") or "").lstrip("0")
            it["rip_code"] = lookup.get((it.get("wholesaler"), un))
            # Exact (wholesaler, UPC, size) match first; UPC-only fallback so a
            # size-string drift still prices the line rather than blanking it.
            uv = str(it.get("unit_volume") or "").strip().lower()
            rec = price_by_size.get((it.get("wholesaler"), un, uv)) or price_any.get((it.get("wholesaler"), un))
            if rec:
                it.update(rec)
                ec, uq = rec.get("effective_case_price"), rec.get("unit_qty")
                try:
                    uqn = float(uq) if uq is not None else None
                except (TypeError, ValueError):
                    uqn = None
                it["effective_unit_price"] = (
                    round(ec / uqn, 2) if (ec is not None and uqn and uqn > 0) else None
                )
    except Exception:
        for it in items:
            it.setdefault("rip_code", None)


@router.post("/{list_id}/items")
def add_item(list_id: int, body: ListItemIn, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        _owned(con, list_id, user["id"])
        con.execute(
            """INSERT INTO list_items
                 (list_id, product_name, wholesaler, upc, unit_volume, combo_code, notes)
               VALUES (%s,%s,%s,%s,%s,%s,%s)
               ON CONFLICT (list_id, product_name, wholesaler, unit_volume) DO NOTHING""",
            (list_id, body.product_name, body.wholesaler, body.upc,
             body.unit_volume, body.combo_code, body.notes),
        )
        con.execute(f"UPDATE lists SET updated_at={NOW_UTC} WHERE id=%s", (list_id,))
    return {"status": "added"}


@router.delete("/{list_id}/items/{item_id}")
def remove_item(list_id: int, item_id: int, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        _owned(con, list_id, user["id"])
        con.execute("DELETE FROM list_items WHERE id=%s AND list_id=%s", (item_id, list_id))
    return {"status": "removed"}


@router.post("/{list_id}/items/delete")
def remove_items(list_id: int, body: MoveIn, user: dict = Depends(get_current_user)):
    """Bulk-delete selected items (checkbox selection)."""
    if not body.item_ids:
        return {"status": "removed", "count": 0}
    with get_pg() as con:
        _owned(con, list_id, user["id"])
        ph = ", ".join(["%s"] * len(body.item_ids))
        con.execute(
            f"DELETE FROM list_items WHERE list_id=%s AND id IN ({ph})",
            (list_id, *body.item_ids),
        )
    return {"status": "removed", "count": len(body.item_ids)}
