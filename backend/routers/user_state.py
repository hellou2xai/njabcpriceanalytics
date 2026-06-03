"""
User State API â€” watchlist, orders, notes, ratings, sales reps.

Covers: Â§4 Tracking List, Â§5 Named Orders, Â§3.5 Notes, Â§3.6 Ratings, Â§13 Sales Reps
"""

import json
import math
from datetime import date
from fastapi import APIRouter, Query, Body, Depends, HTTPException, Response
from pydantic import BaseModel
from typing import Optional

from backend.db import get_duckdb, read_parquet, NOW_UTC
from backend.enrichment_join import attach_enrichment_image, attach_sku_mapping
from backend.pg import get_pg
from backend.auth import get_current_user
from backend.rip_utils import is_bottle_unit, rip_per_case
from backend import pricing as _pricing
from backend import mailer
from backend.po_pdf import build_po_pdf, build_po_html

# Distributor slug -> display name. Kept local (and small) to avoid importing the
# catalog router here; mirrors catalog.DISTRIBUTOR_NAMES and the frontend map.
DISTRIBUTOR_NAMES = {
    "allied": "Allied", "fedway": "Fedway", "high_grade": "Highgrade",
    "opici": "Opici", "peerless": "Peerless",
}


def _num(v):
    """Coerce DuckDB/pandas/numpy numerics to a JSON-safe float (or None)."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if f != f else f  # drop NaN


def _enrich_order_lines(lines: list[dict], ref_date: Optional[str] = None) -> list[dict]:
    """Attach current-edition pricing (case cost, category, brand, RIP tiers,
    closeout flag) to raw order_lines so the Order Detail page can show and
    total them. Lines that no longer match a current product are left as-is.

    ``ref_date`` (ISO YYYY-MM-DD, default today) is the date each line's RIP
    windows are classified against — the order's needed-by date when set. A RIP
    that has expired (or not yet started) by ref_date is tagged on its tier and
    excluded from ``best_rip_save`` so the order's headline savings reflect what
    the buyer would actually get on that date."""
    if not lines:
        return lines
    with get_duckdb() as con:
        src = read_parquet(con, "cpl_enriched")
        t = date.today()
        current_ym = f"{t.year:04d}-{t.month:02d}"
        eds = con.execute(
            f"SELECT wholesaler, COALESCE(MAX(CASE WHEN edition <= $c THEN edition END), MAX(edition)) AS ed "
            f"FROM {src} GROUP BY wholesaler",
            {"c": current_ym},
        ).fetchdf()
        ed_map = dict(zip(eds["wholesaler"], eds["ed"]))

        ws_list = sorted({l["wholesaler"] for l in lines if l.get("wholesaler")})
        if not ws_list:
            return lines
        upcs = sorted({str(l["upc"]) for l in lines if l.get("upc")})
        names = sorted({l["product_name"] for l in lines if l.get("product_name")})

        params = {f"w{i}": w for i, w in enumerate(ws_list)}
        ws_ph = ", ".join(f"$w{i}" for i in range(len(ws_list)))
        conds = []
        if upcs:
            conds.append("upc IN (" + ", ".join(f"$u{i}" for i in range(len(upcs))) + ")")
            params.update({f"u{i}": u for i, u in enumerate(upcs)})
        if names:
            conds.append("product_name IN (" + ", ".join(f"$n{i}" for i in range(len(names))) + ")")
            params.update({f"n{i}": n for i, n in enumerate(names)})
        cond_sql = (" AND (" + " OR ".join(conds) + ")") if conds else ""

        rows = con.execute(f"""
            SELECT wholesaler, edition, upc, product_name, unit_volume, unit_qty,
                   product_type, brand, frontline_case_price, frontline_unit_price,
                   has_rip, has_closeout, rip_savings, rip_code
            FROM {src}
            WHERE wholesaler IN ({ws_ph}){cond_sql}
        """, params).fetchdf()

        by_upc, by_name, by_full = {}, {}, {}
        for _, r in rows.iterrows():
            if r["edition"] != ed_map.get(r["wholesaler"]):
                continue
            rec = {
                "wholesaler": r["wholesaler"],
                "upc": None if r["upc"] is None or (isinstance(r["upc"], float) and r["upc"] != r["upc"]) else str(r["upc"]),
                "product_name": r["product_name"],
                "unit_volume": r["unit_volume"],
                "unit_qty": r["unit_qty"],
                "product_type": r["product_type"],
                "brand": None if (isinstance(r["brand"], float) and r["brand"] != r["brand"]) else r["brand"],
                "case_cost": _num(r["frontline_case_price"]),
                "btl_cost": _num(r["frontline_unit_price"]),
                "has_rip": bool(r["has_rip"]),
                "has_closeout": bool(r["has_closeout"]),
                "rip_savings": _num(r["rip_savings"]),
                "rip_code": None if r["rip_code"] is None or str(r["rip_code"]) in ("nan", "None") else str(r["rip_code"]),
            }
            ws, up, nm, vol = rec["wholesaler"], rec["upc"] or "", rec["product_name"], rec["unit_volume"]
            # product_name + upc is the reliable identity (one UPC can be reused
            # for several products, e.g. MACALLAN DBL CSK 12Y vs LUNAR20 4P).
            by_full[(ws, nm, up, vol)] = rec
            by_full.setdefault((ws, nm, up), rec)
            by_name[(ws, nm, vol)] = rec
            by_name.setdefault((ws, nm), rec)
            by_upc[(ws, up, vol)] = rec
            by_upc.setdefault((ws, up), rec)

        # RIP tiers (case-unit) for the matched rip_codes. A CPL cell can pack
        # several codes ("240002 250002") — split them so each matches its own
        # RIP-sheet rows (same rule as pricing.attach_tiers / derive.py).
        codes = sorted({
            c for rec in by_full.values()
            for c in _pricing._split_rip_codes(rec.get("rip_code"))
        })
        rip_tier_map: dict = {}
        if codes:
            rip_src = read_parquet(con, "rip")
            rp = {f"rc{i}": c for i, c in enumerate(codes)}
            rp.update({f"rw{i}": w for i, w in enumerate(ws_list)})
            cph = ", ".join(f"$rc{i}" for i in range(len(codes)))
            rwph = ", ".join(f"$rw{i}" for i in range(len(ws_list)))
            rdf = con.execute(f"""
                SELECT rip_code, wholesaler, edition, from_date, to_date,
                       rip_unit_1, rip_qty_1, rip_amt_1, rip_unit_2, rip_qty_2, rip_amt_2,
                       rip_unit_3, rip_qty_3, rip_amt_3, rip_unit_4, rip_qty_4, rip_amt_4
                FROM {rip_src}
                WHERE rip_code IN ({cph}) AND wholesaler IN ({rwph})
            """, rp).fetchdf()
            for _, r in rdf.iterrows():
                if r["edition"] != ed_map.get(r["wholesaler"]):
                    continue
                key = (str(r["rip_code"]), r["wholesaler"])
                bucket = rip_tier_map.setdefault(key, [])
                win = _pricing.window_status(r.get("from_date"), r.get("to_date"), ref_date)
                rfrom, rto = _pricing._iso(r.get("from_date")), _pricing._iso(r.get("to_date"))
                for j in range(1, 5):
                    af, qf = _num(r.get(f"rip_amt_{j}")), _num(r.get(f"rip_qty_{j}"))
                    unit = str(r.get(f"rip_unit_{j}") or "")
                    if not af or not qf or af <= 0 or qf <= 0:
                        continue
                    # Keep BOTH case- and bottle-unit tiers; convert to per-case
                    # later (needs the line's pack size). Storing raw avoids
                    # dropping bottle rebates as the old code did. Carry the
                    # window so the line can badge active/upcoming/expired vs
                    # the order's needed-by date.
                    bucket.append({
                        "qty": int(qf), "amount": af, "unit": unit,
                        "from_date": rfrom, "to_date": rto,
                        "window_status": win["status"], "days_to_expire": win["days_to_expire"],
                    })

        for l in lines:
            ws, up, nm, vol = l.get("wholesaler"), str(l["upc"]) if l.get("upc") else "", l.get("product_name"), l.get("unit_volume")
            rec = (by_full.get((ws, nm, up, vol)) or by_full.get((ws, nm, up))
                   or by_name.get((ws, nm, vol)) or by_name.get((ws, nm))
                   or by_upc.get((ws, up, vol)) or by_upc.get((ws, up)))
            if not rec:
                continue
            cc = rec["case_cost"] or 0.0
            l["case_cost"] = rec["case_cost"]
            l["btl_cost"] = rec["btl_cost"]
            l["category"] = rec["product_type"]
            l["brand"] = rec["brand"]
            l["size"] = rec["unit_volume"] or l.get("unit_volume")
            try:
                l["pack"] = int(float(rec["unit_qty"])) if rec["unit_qty"] is not None else None
            except (TypeError, ValueError):
                l["pack"] = None
            l["has_rip"] = rec["has_rip"]
            l["is_closeout"] = rec["has_closeout"]
            l["description"] = l.get("product_name")
            # Gather tiers across every code packed into this row's rip_code.
            raw_tiers = []
            for c in _pricing._split_rip_codes(rec.get("rip_code")):
                raw_tiers.extend(rip_tier_map.get((c, ws), []))
            pack = l["pack"] or 0  # bottles per case
            tiers = []
            seen = set()
            for t in sorted(raw_tiers, key=lambda x: x["qty"]):
                # Per-CASE savings (bottle tiers ×pack); order math is case-based.
                sv = round(rip_per_case(t["amount"], t["qty"], t["unit"], pack), 2)
                if sv <= 0:
                    continue
                # Express the threshold in cases. A "buy 6 bottles" tier on a
                # 6-pack is one case; round up so a partial case still qualifies.
                if is_bottle_unit(t["unit"]):
                    tier_cases = max(1, -(-t["qty"] // pack)) if pack > 0 else 1
                else:
                    tier_cases = t["qty"]
                # Window in the signature so two distinct date ranges at the
                # same (cases, savings) both survive — the buyer sees one badged
                # active and another upcoming/expired.
                sig = (tier_cases, sv, t.get("from_date"), t.get("to_date"))
                if sig in seen:
                    continue
                seen.add(sig)
                tiers.append({
                    "tier": f"{tier_cases}cs", "tier_cases": tier_cases, "save_amount": str(sv),
                    "case_price": str(round(cc - sv, 2)) if cc else None, "btl_price": None,
                    "from_date": t.get("from_date"), "to_date": t.get("to_date"),
                    "window_status": t.get("window_status"), "days_to_expire": t.get("days_to_expire"),
                })
            tiers.sort(key=lambda x: x["tier_cases"])
            l["rip_tiers"] = tiers
            # best_rip_save counts only tiers ACTIVE on ref_date (whole-month /
            # evergreen / active) — an expired or not-yet-started dated RIP must
            # not inflate the order's savings on the needed-by date. The
            # precomputed rip_savings is the whole-month best, always active.
            active_saves = [
                float(t["save_amount"]) for t in tiers
                if t.get("window_status") in (None, "whole_month", "evergreen", "active")
            ]
            best = max(active_saves + [rec["rip_savings"] or 0.0], default=0.0)
            l["best_rip_save"] = str(round(best, 2)) if best > 0 else None
    return lines

router = APIRouter(prefix="/api", tags=["user-state"])


def _audit(con, table_name: str, record_id: int, action: str,
           old_values: dict | None = None, new_values: dict | None = None):
    """Write an audit log entry â€” Â§14.1"""
    con.execute(
        """INSERT INTO audit_log (table_name, record_id, action, old_values, new_values)
           VALUES (%s, %s, %s, %s, %s)""",
        (table_name, record_id, action,
         json.dumps(old_values) if old_values else None,
         json.dumps(new_values) if new_values else None)
    )


# ---- Watchlist (Â§4) ----

class WatchlistItem(BaseModel):
    product_name: str
    wholesaler: str
    upc: Optional[str] = None
    unit_volume: Optional[str] = None
    target_price: Optional[float] = None
    notes: Optional[str] = None


@router.get("/watchlist")
def get_watchlist(user: dict = Depends(get_current_user)):
    with get_pg() as con:
        rows = con.execute(
            "SELECT * FROM watchlist WHERE user_id = %s ORDER BY created_at DESC", (user["id"],)
        ).fetchall()
    items = [dict(r) for r in rows]
    if items:
        with get_duckdb() as con:
            attach_enrichment_image(con, items)
            attach_sku_mapping(con, items)
    return items


@router.post("/watchlist")
def add_to_watchlist(item: WatchlistItem, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        cur = con.execute(
            """INSERT INTO watchlist (user_id, product_name, wholesaler, upc, unit_volume, target_price, notes)
               VALUES (%s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT(user_id, product_name, wholesaler, unit_volume) DO UPDATE SET
                   target_price = excluded.target_price,
                   notes = excluded.notes
               RETURNING id""",
            (user["id"], item.product_name, item.wholesaler, item.upc, item.unit_volume,
             item.target_price, item.notes)
        )
        _audit(con, "watchlist", cur.fetchone()["id"], "insert", new_values=item.model_dump())
        return {"status": "added"}


@router.delete("/watchlist/{item_id}")
def remove_from_watchlist(item_id: int, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        old = con.execute("SELECT * FROM watchlist WHERE id = %s AND user_id = %s", (item_id, user["id"])).fetchone()
        con.execute("DELETE FROM watchlist WHERE id = %s AND user_id = %s", (item_id, user["id"]))
        _audit(con, "watchlist", item_id, "delete", old_values=dict(old) if old else None)
    return {"status": "removed"}


@router.put("/watchlist/{item_id}/target-price")
def set_target_price(item_id: int, target_price: float = Body(...), user: dict = Depends(get_current_user)):
    with get_pg() as con:
        old = con.execute("SELECT target_price FROM watchlist WHERE id = %s AND user_id = %s", (item_id, user["id"])).fetchone()
        con.execute("UPDATE watchlist SET target_price = %s WHERE id = %s AND user_id = %s", (target_price, item_id, user["id"]))
        _audit(con, "watchlist", item_id, "update",
               old_values={"target_price": old["target_price"] if old else None},
               new_values={"target_price": target_price})
    return {"status": "updated"}


@router.put("/watchlist/{item_id}/notes")
def set_watchlist_notes(item_id: int, notes: str = Body(...), user: dict = Depends(get_current_user)):
    with get_pg() as con:
        old = con.execute("SELECT notes FROM watchlist WHERE id = %s AND user_id = %s", (item_id, user["id"])).fetchone()
        con.execute("UPDATE watchlist SET notes = %s WHERE id = %s AND user_id = %s", (notes, item_id, user["id"]))
        _audit(con, "watchlist", item_id, "update",
               old_values={"notes": old["notes"] if old else None},
               new_values={"notes": notes})
    return {"status": "updated"}


# ---- Orders (Â§5) ----

class OrderCreate(BaseModel):
    name: str
    notes: Optional[str] = None
    division: Optional[str] = None
    distributor: Optional[str] = None
    sales_rep_id: Optional[int] = None
    needed_by_date: Optional[str] = None   # ISO YYYY-MM-DD; null = price as today


class OrderLineCreate(BaseModel):
    product_name: str
    wholesaler: str
    upc: Optional[str] = None
    unit_volume: Optional[str] = None
    qty_cases: int = 0
    qty_units: int = 0
    selected_discount_tier: Optional[int] = None
    combo_code: Optional[str] = None


def _require_order(con, order_id: int, user_id: int):
    """Return the order row if it belongs to the user, else raise 404."""
    row = con.execute(
        "SELECT * FROM orders WHERE id = %s AND user_id = %s", (order_id, user_id)
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Order not found")
    return row


def _line_invoice(line: dict) -> float:
    """Gross line amount at list: case cost x cases + bottle cost x bottles."""
    return ((_num(line.get("case_cost")) or 0.0) * (line.get("qty_cases") or 0)
            + (_num(line.get("btl_cost")) or 0.0) * (line.get("qty_units") or 0))


def _attach_order_totals(con, order_rows: list) -> list[dict]:
    """Attach a `total` (invoice) to each order by pricing its lines in one pass."""
    result = [dict(r) for r in order_rows]
    ids = [o["id"] for o in result]
    if not ids:
        return result
    ph = ", ".join("%s" for _ in ids)
    lines = con.execute(f"SELECT * FROM order_lines WHERE order_id IN ({ph})", ids).fetchall()
    enriched = _enrich_order_lines([dict(l) for l in lines])
    totals: dict = {}
    for l in enriched:
        totals[l["order_id"]] = totals.get(l["order_id"], 0.0) + _line_invoice(l)
    for o in result:
        o["total"] = round(totals.get(o["id"], 0.0), 2)
    return result


@router.get("/orders")
def list_orders(status: Optional[str] = None, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        if status:
            rows = con.execute(
                "SELECT * FROM orders WHERE user_id = %s AND status = %s ORDER BY updated_at DESC",
                (user["id"], status)
            ).fetchall()
        else:
            rows = con.execute(
                "SELECT * FROM orders WHERE user_id = %s AND status != 'archived' ORDER BY updated_at DESC",
                (user["id"],)
            ).fetchall()
        result = _attach_order_totals(con, rows)
    return result


@router.get("/orders/plan")
def order_plan(status: Optional[str] = None, user: dict = Depends(get_current_user)):
    """Weekly-plan feed: the user's orders ordered by distributor then sales
    rep, each with its priced line items and total. `status` filters to one
    status; None or 'all' returns every non-archived order. The frontend groups
    these into a one-screen buy plan."""
    with get_pg() as con:
        if status and status != "all":
            rows = con.execute(
                "SELECT * FROM orders WHERE user_id = %s AND status = %s ORDER BY distributor, sales_rep_id, id",
                (user["id"], status)
            ).fetchall()
        else:
            rows = con.execute(
                "SELECT * FROM orders WHERE user_id = %s AND status != 'archived' ORDER BY distributor, sales_rep_id, id",
                (user["id"],)
            ).fetchall()
        ids = [r["id"] for r in rows]
        by_order: dict = {i: [] for i in ids}
        if ids:
            ph = ", ".join("%s" for _ in ids)
            lines = con.execute(f"SELECT * FROM order_lines WHERE order_id IN ({ph})", ids).fetchall()
            enriched = _enrich_order_lines([dict(l) for l in lines])
            for l in enriched:
                l["line_invoice"] = round(_line_invoice(l), 2)
                by_order.setdefault(l["order_id"], []).append(l)
        out = []
        for r in rows:
            d = dict(r)
            d["lines"] = by_order.get(r["id"], [])
            d["total"] = round(sum(l["line_invoice"] for l in d["lines"]), 2)
            out.append(d)
    return out


@router.post("/orders")
def create_order(order: OrderCreate, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        # One open (draft) order per distributor + sales rep. If one already
        # exists, return it instead of creating a duplicate.
        if order.distributor:
            existing = con.execute(
                """SELECT id FROM orders WHERE user_id = %s AND status = 'draft'
                   AND COALESCE(distributor, '') = COALESCE(%s, '')
                   AND COALESCE(sales_rep_id, 0) = COALESCE(%s, 0)""",
                (user["id"], order.distributor, order.sales_rep_id),
            ).fetchone()
            if existing:
                return {"id": existing["id"], "status": "exists"}
        cur = con.execute(
            "INSERT INTO orders (user_id, name, notes, division, distributor, sales_rep_id, needed_by_date) VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id",
            (user["id"], order.name, order.notes, order.division, order.distributor, order.sales_rep_id, order.needed_by_date)
        )
        order_id = cur.fetchone()["id"]
        _audit(con, "orders", order_id, "insert", new_values=order.model_dump())
    return {"id": order_id, "status": "created"}


@router.put("/orders/{order_id}/status")
def update_order_status(order_id: int, status: str = Body(...), user: dict = Depends(get_current_user)):
    with get_pg() as con:
        old = _require_order(con, order_id, user["id"])
        con.execute(
            f"UPDATE orders SET status = %s, updated_at = {NOW_UTC} WHERE id = %s AND user_id = %s",
            (status, order_id, user["id"])
        )
        _audit(con, "orders", order_id, "update",
               old_values={"status": old["status"]},
               new_values={"status": status})
    return {"status": "updated"}


class OrderUpdate(BaseModel):
    name: Optional[str] = None
    notes: Optional[str] = None
    division: Optional[str] = None
    distributor: Optional[str] = None
    sales_rep_id: Optional[int] = None
    needed_by_date: Optional[str] = None   # ISO YYYY-MM-DD; '' or null clears it


@router.put("/orders/{order_id}")
def update_order(order_id: int, patch: OrderUpdate, user: dict = Depends(get_current_user)):
    """Update an order's name, notes, or division (partial)."""
    with get_pg() as con:
        _require_order(con, order_id, user["id"])
        data = patch.model_dump(exclude_unset=True)
        if data:
            assignments = ", ".join(f"{k} = %s" for k in data)
            con.execute(
                f"UPDATE orders SET {assignments}, updated_at = {NOW_UTC} WHERE id = %s AND user_id = %s",
                list(data.values()) + [order_id, user["id"]],
            )
    return {"status": "updated"}


@router.post("/orders/{order_id}/lines")
def add_order_line(order_id: int, line: OrderLineCreate, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        order = _require_order(con, order_id, user["id"])
        if order["distributor"] and line.wholesaler and order["distributor"] != line.wholesaler:
            raise HTTPException(
                status_code=409,
                detail="This order is for a different distributor. Add this product to an order for its own distributor.",
            )
        cur = con.execute(
            """INSERT INTO order_lines (order_id, product_name, wholesaler, upc,
               unit_volume, qty_cases, qty_units, selected_discount_tier, combo_code)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id""",
            (order_id, line.product_name, line.wholesaler, line.upc,
             line.unit_volume, line.qty_cases, line.qty_units, line.selected_discount_tier, line.combo_code)
        )
        line_id = cur.fetchone()["id"]
        _audit(con, "order_lines", line_id, "insert", new_values=line.model_dump())
    return {"id": line_id, "status": "added"}


def _parse_case_qty(qty_per_pack) -> int:
    """'3 C' / '3 Cases' / '24 bottle' → leading integer (default 1)."""
    import re as _re
    if qty_per_pack is None:
        return 1
    m = _re.match(r"\s*(\d+)", str(qty_per_pack))
    return int(m.group(1)) if m else 1


@router.post("/orders/{order_id}/add-combo")
def add_combo_to_order(order_id: int, wholesaler: str = Body(...), combo_code: str = Body(...),
                       user: dict = Depends(get_current_user)):
    """Add EVERY product in a combo bundle to the order as separate lines, each
    tagged with combo_code so they're recognizable as one deal."""
    with get_pg() as con:
        order = _require_order(con, order_id, user["id"])
        if order["distributor"] and wholesaler and order["distributor"] != wholesaler:
            raise HTTPException(status_code=409, detail="This combo's distributor does not match this order's distributor.")
        # Pull the combo's components from the combo source (latest edition).
        with get_duckdb() as duck:
            src = read_parquet(duck, "combo")
            rows = duck.execute(f"""
                SELECT DISTINCT product_name, upc, qty_per_pack
                FROM {src}
                WHERE wholesaler = $ws AND combo_code = $code
                  AND product_name IS NOT NULL
            """, {"ws": wholesaler, "code": combo_code}).fetchdf()
        added = 0
        for _, r in rows.iterrows():
            pname = r["product_name"]
            if pname is None or (isinstance(pname, float) and pname != pname):
                continue
            upc = None if r["upc"] is None or (isinstance(r["upc"], float) and r["upc"] != r["upc"]) else str(r["upc"])
            cur = con.execute(
                """INSERT INTO order_lines (order_id, product_name, wholesaler, upc, qty_cases, combo_code)
                   VALUES (%s, %s, %s, %s, %s, %s) RETURNING id""",
                (order_id, str(pname), wholesaler, upc, _parse_case_qty(r["qty_per_pack"]), combo_code),
            )
            _audit(con, "order_lines", cur.fetchone()["id"], "insert",
                   new_values={"product_name": str(pname), "combo_code": combo_code})
            added += 1
    return {"added": added, "combo_code": combo_code}


@router.get("/orders/{order_id}")
def get_order_detail(order_id: int, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        order = _require_order(con, order_id, user["id"])
        lines = con.execute(
            "SELECT * FROM order_lines WHERE order_id = %s", (order_id,)
        ).fetchall()
    order_d = dict(order)
    enriched_lines = _enrich_order_lines([dict(l) for l in lines],
                                         ref_date=order_d.get("needed_by_date"))
    # Allied (ABG) SKU next to the UPC on Allied lines only.
    with get_duckdb() as dcon:
        attach_sku_mapping(dcon, enriched_lines)
    return {
        "order": order_d,
        "lines": enriched_lines,
    }


@router.delete("/orders/{order_id}")
def delete_order(order_id: int, user: dict = Depends(get_current_user)):
    """Delete an order and all of its lines."""
    with get_pg() as con:
        old = _require_order(con, order_id, user["id"])
        con.execute("DELETE FROM order_lines WHERE order_id = %s", (order_id,))
        con.execute("DELETE FROM orders WHERE id = %s AND user_id = %s", (order_id, user["id"]))
        _audit(con, "orders", order_id, "delete", old_values=dict(old))
    return {"status": "deleted"}


@router.delete("/orders/{order_id}/lines/{line_id}")
def remove_order_line(order_id: int, line_id: int, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        _require_order(con, order_id, user["id"])
        con.execute("DELETE FROM order_lines WHERE id = %s AND order_id = %s", (line_id, order_id))
    return {"status": "removed"}


class OrderLineUpdate(BaseModel):
    qty_cases: Optional[int] = None
    qty_units: Optional[int] = None
    selected_discount_tier: Optional[int] = None
    notes: Optional[str] = None
    retail_price: Optional[float] = None


@router.put("/orders/{order_id}/lines/{line_id}")
def update_order_line(order_id: int, line_id: int, patch: OrderLineUpdate, user: dict = Depends(get_current_user)):
    """Partial update: only fields present in the body change, so saving a note
    or retail price never resets the quantities."""
    with get_pg() as con:
        _require_order(con, order_id, user["id"])
        data = patch.model_dump(exclude_unset=True)
        if data:
            assignments = ", ".join(f"{k} = %s" for k in data)
            con.execute(
                f"UPDATE order_lines SET {assignments} WHERE id = %s AND order_id = %s",
                list(data.values()) + [line_id, order_id],
            )
    return {"status": "updated"}


@router.post("/orders/{order_id}/copy-watchlist")
def copy_watchlist_to_order(order_id: int, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        _require_order(con, order_id, user["id"])
        items = con.execute(
            "SELECT product_name, wholesaler, upc, unit_volume FROM watchlist WHERE user_id = %s",
            (user["id"],)
        ).fetchall()
        count = 0
        for item in items:
            existing = con.execute(
                "SELECT id FROM order_lines WHERE order_id=%s AND product_name=%s AND wholesaler=%s",
                (order_id, item["product_name"], item["wholesaler"])
            ).fetchone()
            if not existing:
                con.execute(
                    "INSERT INTO order_lines (order_id, product_name, wholesaler, upc, unit_volume) VALUES (%s,%s,%s,%s,%s)",
                    (order_id, item["product_name"], item["wholesaler"], item["upc"], item["unit_volume"])
                )
                count += 1
    return {"copied": count}


@router.post("/orders/{order_id}/clone")
def clone_order(order_id: int, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        order = _require_order(con, order_id, user["id"])
        cur = con.execute(
            "INSERT INTO orders (user_id, name, notes, division) VALUES (%s, %s, %s, %s) RETURNING id",
            (user["id"], f"Copy of {order['name']}", order["notes"], order["division"])
        )
        new_id = cur.fetchone()["id"]
        lines = con.execute("SELECT * FROM order_lines WHERE order_id = %s", (order_id,)).fetchall()
        for l in lines:
            con.execute(
                """INSERT INTO order_lines (order_id, product_name, wholesaler, upc,
                   unit_volume, qty_cases, qty_units, selected_discount_tier)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
                (new_id, l["product_name"], l["wholesaler"], l["upc"],
                 l["unit_volume"], l["qty_cases"], l["qty_units"], l["selected_discount_tier"])
            )
    return {"id": new_id, "status": "cloned"}


# ---- Purchase Order PDF + submit (Â§5) ----

def _gather_po(con, order: dict, user: dict, revision: int | None = None) -> tuple[dict, dict]:
    """Build the dict that po_pdf.build_po_pdf expects, plus the sales rep row.
    Returns (po_data, rep). One source of truth for both the preview and the
    emailed copy, so the rep gets exactly what the buyer saw. `revision` overrides
    the order's stored revision (used when previewing/sending a new revision)."""
    order_id = order["id"]
    rep = None
    if order.get("sales_rep_id"):
        rep = con.execute(
            "SELECT * FROM sales_reps WHERE id = %s AND user_id = %s",
            (order["sales_rep_id"], user["id"]),
        ).fetchone()
    rep = dict(rep) if rep else {}

    urow = con.execute(
        "SELECT full_name, email, phone FROM users WHERE id = %s", (user["id"],)
    ).fetchone()
    urow = dict(urow) if urow else {}
    store = con.execute(
        "SELECT name, formatted_address, phone, license_number FROM stores "
        "WHERE user_id = %s ORDER BY id LIMIT 1",
        (user["id"],),
    ).fetchone()
    store = dict(store) if store else {}

    raw_lines = con.execute(
        "SELECT * FROM order_lines WHERE order_id = %s ORDER BY id", (order_id,)
    ).fetchall()
    lines = _enrich_order_lines([dict(l) for l in raw_lines],
                                ref_date=order.get("needed_by_date"))

    pdf_lines, subtotal = [], 0.0
    for l in lines:
        amt = round(_line_invoice(l), 2)
        subtotal += amt
        rip_note = None
        if l.get("best_rip_save"):
            rip_note = f"RIP deal: save up to ${l['best_rip_save']}/case"
        pdf_lines.append({
            "description": l.get("product_name") or "",
            "upc": l.get("upc"),
            "size": l.get("size") or l.get("unit_volume"),
            "pack": l.get("pack"),
            "cases": l.get("qty_cases") or 0,
            "bottles": l.get("qty_units") or 0,
            "case_cost": _num(l.get("case_cost")),
            "line_total": amt,
            "rip_note": rip_note,
            # Surface rip_code + combo_code so the email + PDF can sub-group
            # lines that share a deal (combo bundle or RIP rebate), matching
            # the cart's grouping view.
            "rip_code": l.get("rip_code"),
            "combo_code": l.get("combo_code"),
        })
    # Sort: combos first (by code), then RIPs (by code), then everything else.
    # Combos take priority because they're hard requirements; lose a line and
    # the bundle price collapses. Within each group, lines keep insertion order.
    def _group_key(x):
        cc = x.get("combo_code")
        rc = x.get("rip_code")
        if cc:
            return (0, str(cc))
        if rc:
            return (1, str(rc))
        return (2, "")
    pdf_lines.sort(key=_group_key)

    buyer_name = store.get("name") or urow.get("full_name") or urow.get("email") or "Buyer"
    po_data = {
        "po_number": f"CELR-{order_id:05d}",
        "revision": revision if revision is not None else (order.get("revision") or 0),
        "date": date.today().isoformat(),
        "distributor": DISTRIBUTOR_NAMES.get(order.get("distributor"), order.get("distributor") or "—"),
        "division": order.get("division") or "",
        "order_name": order.get("name") or "",
        "notes": order.get("notes"),
        "vendor": {
            "name": DISTRIBUTOR_NAMES.get(order.get("distributor"), order.get("distributor") or "Distributor"),
            "rep_name": rep.get("name"),
            "rep_email": rep.get("email"),
            "rep_phone": rep.get("phone"),
        },
        "buyer": {
            "name": buyer_name,
            "address": store.get("formatted_address"),
            "license": store.get("license_number"),
            "phone": store.get("phone") or urow.get("phone"),
            "email": urow.get("email"),
        },
        "subtotal": round(subtotal, 2),
        "lines": pdf_lines,
    }
    return po_data, rep


@router.get("/orders/{order_id}/pdf")
def order_pdf(order_id: int, revision: Optional[int] = None, user: dict = Depends(get_current_user)):
    """Render the order as a Purchase Order PDF, inline (for the in-app preview).
    `revision` previews a specific revision number (defaults to the stored one)."""
    with get_pg() as con:
        order = dict(_require_order(con, order_id, user["id"]))
        po_data, _rep = _gather_po(con, order, user, revision=revision)
    pdf = build_po_pdf(po_data)
    return Response(
        content=pdf, media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{po_data["po_number"]}.pdf"'},
    )


class SubmitOrderIn(BaseModel):
    # New revision number to send as. Defaults to the next revision (current + 1).
    revision: Optional[int] = None
    # On a revision (the order was submitted before), also email a cancellation
    # of the previous revision to the rep.
    send_cancellation: bool = True


@router.post("/orders/{order_id}/reopen")
def reopen_order(order_id: int, user: dict = Depends(get_current_user)):
    """Bring a submitted order back to draft so it can be edited and re-submitted
    as a new revision. The revision number is left as-is until re-submit."""
    with get_pg() as con:
        order = dict(_require_order(con, order_id, user["id"]))
        con.execute(
            f"UPDATE orders SET status = 'draft', updated_at = {NOW_UTC} WHERE id = %s AND user_id = %s",
            (order_id, user["id"]),
        )
        _audit(con, "orders", order_id, "update",
               old_values={"status": order.get("status")},
               new_values={"status": "draft"})
    return {"status": "draft", "revision": order.get("revision") or 0}


@router.post("/orders/{order_id}/submit")
def submit_order(order_id: int, body: SubmitOrderIn = Body(default=SubmitOrderIn()),
                 user: dict = Depends(get_current_user)):
    """Submit (or re-submit) an order and email the PO to its sales rep. On a
    re-submit it bumps the revision (the buyer may override it) and, by default,
    first emails a cancellation of the prior revision. The buyer is set as
    reply-to. Returns what actually happened so the UI can be honest."""
    with get_pg() as con:
        order = dict(_require_order(con, order_id, user["id"]))
        prior_revision = order.get("revision") or 0
        is_revision = prior_revision >= 1
        new_revision = body.revision if body.revision and body.revision > 0 else prior_revision + 1

        po_data, rep = _gather_po(con, order, user, revision=new_revision)
        pdf = build_po_pdf(po_data)

        rep_email = (rep.get("email") or "").strip()
        can_email = bool(rep_email and mailer.MAIL_ENABLED)
        emailed = False
        cancelled = False
        if can_email:
            if is_revision and body.send_cancellation:
                cancelled = mailer.send_po_cancellation(
                    rep_email,
                    po_number=po_data["po_number"],
                    prior_revision=prior_revision,
                    new_revision=new_revision,
                    buyer_name=po_data["buyer"]["name"],
                    distributor=po_data["distributor"],
                    rep_name=rep.get("name"),
                    reply_to=po_data["buyer"].get("email"),
                )
            emailed = mailer.send_purchase_order(
                rep_email,
                po_number=po_data["po_number"],
                order_name=po_data["order_name"],
                buyer_name=po_data["buyer"]["name"],
                distributor=po_data["distributor"],
                pdf_bytes=pdf,
                order_html=build_po_html(po_data),
                rep_name=rep.get("name"),
                reply_to=po_data["buyer"].get("email"),
            )

        con.execute(
            f"UPDATE orders SET status = 'submitted', revision = %s, updated_at = {NOW_UTC} "
            "WHERE id = %s AND user_id = %s",
            (new_revision, order_id, user["id"]),
        )
        _audit(con, "orders", order_id, "update",
               old_values={"status": order.get("status"), "revision": prior_revision},
               new_values={"status": "submitted", "revision": new_revision, "emailed_to": rep_email or None})

    reason = None
    if not rep_email:
        reason = "no_rep_email"
    elif not mailer.MAIL_ENABLED:
        reason = "email_disabled"
    return {
        "status": "submitted",
        "emailed": emailed,
        "cancelled": cancelled,
        "to": rep_email or None,
        "rep_name": rep.get("name"),
        "revision": new_revision,
        "is_revision": is_revision,
        "reason": reason,
    }


# ---- Notes (Â§3.5) ----

class NoteCreate(BaseModel):
    note: str
    # Optional: a standalone sticky note leaves product_name/wholesaler null.
    product_name: Optional[str] = None
    wholesaler: Optional[str] = None
    title: Optional[str] = None
    color: Optional[str] = None


class NoteUpdate(BaseModel):
    note: Optional[str] = None
    title: Optional[str] = None
    color: Optional[str] = None


@router.get("/notes")
def list_notes(user: dict = Depends(get_current_user)):
    """List every active note across all products (newest first) for the
    My Notes dashboard item and the Notes screen."""
    with get_pg() as con:
        rows = con.execute(
            "SELECT * FROM user_notes WHERE user_id = %s AND deleted = 0 ORDER BY created_at DESC",
            (user["id"],)
        ).fetchall()
    return [dict(r) for r in rows]


@router.get("/notes/standalone")
def list_standalone_notes(user: dict = Depends(get_current_user)):
    """Standalone sticky notes (not attached to a product), newest first."""
    with get_pg() as con:
        rows = con.execute(
            "SELECT * FROM user_notes WHERE user_id = %s AND deleted = 0 "
            "AND product_name IS NULL ORDER BY created_at DESC",
            (user["id"],)
        ).fetchall()
    return [dict(r) for r in rows]


@router.get("/notes/all")
def list_all_notes(user: dict = Depends(get_current_user)):
    """Every note the user has left, anywhere: product notes, watchlist notes,
    order notes, and per-line order notes. One consolidated feed, newest first,
    each tagged with its source and a link target."""
    uid = user["id"]
    out = []
    with get_pg() as con:
        for r in con.execute(
            "SELECT id, product_name, wholesaler, note, created_at FROM user_notes "
            "WHERE user_id = %s AND deleted = 0 AND product_name IS NOT NULL", (uid,)
        ).fetchall():
            out.append({"source": "product", "id": r["id"], "note": r["note"],
                        "product_name": r["product_name"], "wholesaler": r["wholesaler"],
                        "order_id": None, "title": r["product_name"], "created_at": r["created_at"]})
        for r in con.execute(
            "SELECT id, product_name, wholesaler, notes, created_at FROM watchlist "
            "WHERE user_id = %s AND notes IS NOT NULL AND TRIM(notes) != ''", (uid,)
        ).fetchall():
            out.append({"source": "watchlist", "id": r["id"], "note": r["notes"],
                        "product_name": r["product_name"], "wholesaler": r["wholesaler"],
                        "order_id": None, "title": r["product_name"], "created_at": r["created_at"]})
        for r in con.execute(
            "SELECT id, name, notes, updated_at FROM orders "
            "WHERE user_id = %s AND notes IS NOT NULL AND TRIM(notes) != ''", (uid,)
        ).fetchall():
            out.append({"source": "order", "id": r["id"], "note": r["notes"],
                        "product_name": None, "wholesaler": None,
                        "order_id": r["id"], "title": r["name"], "created_at": r["updated_at"]})
        for r in con.execute(
            "SELECT ol.id, ol.product_name, ol.wholesaler, ol.notes, ol.order_id, "
            "o.name AS order_name, ol.created_at FROM order_lines ol "
            "JOIN orders o ON o.id = ol.order_id "
            "WHERE o.user_id = %s AND ol.notes IS NOT NULL AND TRIM(ol.notes) != ''", (uid,)
        ).fetchall():
            out.append({"source": "order_line", "id": r["id"], "note": r["notes"],
                        "product_name": r["product_name"], "wholesaler": r["wholesaler"],
                        "order_id": r["order_id"],
                        "title": f'{r["product_name"]} (in {r["order_name"]})',
                        "created_at": r["created_at"]})
    out.sort(key=lambda x: x["created_at"] or "", reverse=True)
    return out


@router.get("/notes/{wholesaler}/{product_name:path}")
def get_notes(wholesaler: str, product_name: str, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        rows = con.execute(
            "SELECT * FROM user_notes WHERE user_id = %s AND wholesaler = %s AND product_name = %s AND deleted = 0 ORDER BY created_at DESC",
            (user["id"], wholesaler, product_name)
        ).fetchall()
    return [dict(r) for r in rows]


@router.post("/notes")
def add_note(note: NoteCreate, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        cur = con.execute(
            "INSERT INTO user_notes (user_id, product_name, wholesaler, note, title, color) "
            "VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
            (user["id"], note.product_name, note.wholesaler, note.note, note.title, note.color)
        )
        note_id = cur.fetchone()["id"]
        _audit(con, "user_notes", note_id, "insert", new_values=note.model_dump())
    return {"id": note_id, "status": "created"}


@router.put("/notes/{note_id}")
def update_note(note_id: int, patch: NoteUpdate, user: dict = Depends(get_current_user)):
    """Edit a note's text, title or colour (partial update)."""
    with get_pg() as con:
        old = con.execute(
            "SELECT * FROM user_notes WHERE id = %s AND user_id = %s AND deleted = 0",
            (note_id, user["id"]),
        ).fetchone()
        if not old:
            raise HTTPException(status_code=404, detail="Note not found")
        data = patch.model_dump(exclude_unset=True)
        if data:
            assignments = ", ".join(f"{k} = %s" for k in data)
            con.execute(
                f"UPDATE user_notes SET {assignments}, updated_at = {NOW_UTC} "
                "WHERE id = %s AND user_id = %s",
                list(data.values()) + [note_id, user["id"]],
            )
            _audit(con, "user_notes", note_id, "update", new_values=data)
    return {"status": "updated"}


@router.delete("/notes/{note_id}")
def delete_note(note_id: int, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        old = con.execute("SELECT * FROM user_notes WHERE id = %s AND user_id = %s", (note_id, user["id"])).fetchone()
        con.execute(
            f"UPDATE user_notes SET deleted = 1, updated_at = {NOW_UTC} WHERE id = %s AND user_id = %s",
            (note_id, user["id"])
        )
        _audit(con, "user_notes", note_id, "soft_delete", old_values=dict(old) if old else None)
    return {"status": "soft_deleted"}


# ---- Ratings (Â§3.6) ----

class RatingCreate(BaseModel):
    product_name: str
    wholesaler: str
    edition: str
    rating: int  # -1 or 1


@router.post("/ratings")
def add_rating(r: RatingCreate, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        con.execute(
            """INSERT INTO user_ratings (user_id, product_name, wholesaler, edition, rating)
               VALUES (%s, %s, %s, %s, %s)
               ON CONFLICT(user_id, product_name, wholesaler, edition) DO UPDATE SET rating = excluded.rating""",
            (user["id"], r.product_name, r.wholesaler, r.edition, r.rating)
        )
    return {"status": "rated"}


# ---- Sales Reps (Â§13) ----

class SalesRepCreate(BaseModel):
    name: str
    division: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    distributor: Optional[str] = None


@router.get("/sales-reps")
def list_sales_reps(user: dict = Depends(get_current_user)):
    with get_pg() as con:
        rows = con.execute("SELECT * FROM sales_reps WHERE user_id = %s ORDER BY name", (user["id"],)).fetchall()
    return [dict(r) for r in rows]


class RepMessageIn(BaseModel):
    message: str


@router.post("/sales-reps/{rep_id}/message")
def message_sales_rep(rep_id: int, body: RepMessageIn, user: dict = Depends(get_current_user)):
    """Email a free-text message/question to one of the user's sales reps. Reply-to
    is the user so the rep can answer directly; the user is cc'd a copy. Powers
    'ask my Fedway rep if X is in stock' from the assistant."""
    msg = (body.message or "").strip()
    if not msg:
        return {"sent": False, "error": "Empty message."}
    with get_pg() as con:
        rep = con.execute(
            "SELECT name, email, distributor FROM sales_reps WHERE id = %s AND user_id = %s",
            (rep_id, user["id"])).fetchone()
    if not rep:
        return {"sent": False, "error": "Sales rep not found."}
    if not rep.get("email"):
        return {"sent": False, "error": f"No email on file for {rep['name']} — add one in Sales Reps."}
    from backend import mailer
    buyer = user.get("full_name") or user.get("name") or user.get("email") or "A CELR buyer"
    safe = msg.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\n", "<br>")
    html = mailer._layout(
        f"Message from {buyer}",
        f"<p>{safe}</p><p style='color:#888;font-size:13px'>Sent via CELR. Reply directly to reach {buyer}.</p>")
    ok = mailer._send(rep["email"], f"Question from {buyer}", html,
                      reply_to=user.get("email"), cc=[user["email"]] if user.get("email") else None)
    return {"sent": bool(ok), "rep_name": rep["name"], "to": rep["email"]}


@router.post("/sales-reps")
def add_sales_rep(rep: SalesRepCreate, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        cur = con.execute(
            "INSERT INTO sales_reps (user_id, name, division, email, phone, distributor) VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
            (user["id"], rep.name, rep.division, rep.email, rep.phone, rep.distributor)
        )
        rep_id = cur.fetchone()["id"]
    return {"id": rep_id, "status": "created"}


class SalesRepUpdate(BaseModel):
    name: Optional[str] = None
    division: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    distributor: Optional[str] = None


@router.put("/sales-reps/{rep_id}")
def update_sales_rep(rep_id: int, rep: SalesRepUpdate, user: dict = Depends(get_current_user)):
    fields, vals = [], []
    if rep.name is not None and rep.name.strip():
        fields.append("name = %s"); vals.append(rep.name.strip())
    for col in ("division", "email", "phone", "distributor"):
        v = getattr(rep, col)
        if v is not None:
            fields.append(f"{col} = %s"); vals.append(v.strip() or None)
    if not fields:
        return {"status": "noop"}
    vals.extend([rep_id, user["id"]])
    with get_pg() as con:
        con.execute(f"UPDATE sales_reps SET {', '.join(fields)} WHERE id = %s AND user_id = %s", vals)
    return {"status": "updated"}


@router.delete("/sales-reps/{rep_id}")
def delete_sales_rep(rep_id: int, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        con.execute("DELETE FROM sales_reps WHERE id = %s AND user_id = %s", (rep_id, user["id"]))
    return {"status": "deleted"}


# ---- Divisions (master data; each belongs to a distributor) ----

class DivisionCreate(BaseModel):
    name: str
    distributor: Optional[str] = None


@router.get("/divisions")
def list_divisions(user: dict = Depends(get_current_user)):
    with get_pg() as con:
        rows = con.execute("SELECT * FROM divisions WHERE user_id = %s ORDER BY name", (user["id"],)).fetchall()
    return [dict(r) for r in rows]


@router.post("/divisions")
def add_division(d: DivisionCreate, user: dict = Depends(get_current_user)):
    if not d.name.strip():
        raise HTTPException(status_code=422, detail="Division name is required")
    with get_pg() as con:
        cur = con.execute(
            "INSERT INTO divisions (user_id, name, distributor) VALUES (%s, %s, %s) RETURNING id",
            (user["id"], d.name.strip(), (d.distributor or None)),
        )
        did = cur.fetchone()["id"]
    return {"id": did, "status": "created"}


@router.delete("/divisions/{division_id}")
def delete_division(division_id: int, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        con.execute("DELETE FROM divisions WHERE id = %s AND user_id = %s", (division_id, user["id"]))
    return {"status": "deleted"}
