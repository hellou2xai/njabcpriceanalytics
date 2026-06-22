"""
Admin-only endpoints (visibility for the owner).

Access is restricted by require_admin (email in ADMIN_EMAILS). For now that is
the owner; set ADMIN_EMAILS on the server to add more.
"""

import re
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query

from backend.pg import get_pg
from backend.auth import require_admin, _is_admin

router = APIRouter(prefix="/api/admin", tags=["admin"])


# ---- User Closeout Flags (Compare Prices "X" flags, reviewed manually) ----

_CLOSEOUT_STATUSES = ("open", "reviewed", "actioned", "dismissed")


@router.get("/closeout-flags")
def admin_closeout_flags(status: Optional[str] = None, user: dict = Depends(require_admin)):
    """Every user's closeout flags for the review form, newest first, joined to
    the flagging user's email. Optional ?status= filter."""
    where, params = "", []
    if status and status in _CLOSEOUT_STATUSES:
        where = "WHERE f.status = %s"
        params.append(status)
    with get_pg() as con:
        rows = con.execute(
            f"""SELECT f.id, f.user_id, u.email AS user_email, f.product_name,
                       f.wholesaler, f.upc, f.unit_volume, f.note, f.status, f.created_at
                FROM closeout_flags f LEFT JOIN users u ON u.id = f.user_id
                {where}
                ORDER BY (f.status = 'open') DESC, f.created_at DESC""",
            params).fetchall()
        counts = con.execute(
            "SELECT status, COUNT(*) n FROM closeout_flags GROUP BY status").fetchall()
    return {"flags": [dict(r) for r in rows],
            "counts": {c["status"]: c["n"] for c in counts}}


@router.put("/closeout-flags/{flag_id}/status")
def admin_set_closeout_status(flag_id: int, status: str = Body(..., embed=True),
                              user: dict = Depends(require_admin)):
    """Move a flag through the review workflow (open -> reviewed/actioned/dismissed)."""
    if status not in _CLOSEOUT_STATUSES:
        raise HTTPException(status_code=400, detail=f"status must be one of {_CLOSEOUT_STATUSES}")
    with get_pg() as con:
        con.execute("UPDATE closeout_flags SET status = %s WHERE id = %s", (status, flag_id))
    return {"status": "updated", "new_status": status}


@router.delete("/closeout-flags/{flag_id}")
def admin_delete_closeout_flag(flag_id: int, user: dict = Depends(require_admin)):
    with get_pg() as con:
        con.execute("DELETE FROM closeout_flags WHERE id = %s", (flag_id,))
    return {"status": "deleted"}


@router.get("/stats")
def stats(user: dict = Depends(require_admin)):
    """High-level counts across the user-data tables."""
    counts = {}
    with get_pg() as con:
        for table in ("users", "feedback", "orders", "order_lines", "stores", "user_notes", "watchlist"):
            n = con.execute(f"SELECT count(*) AS n FROM {table}").fetchone()["n"]
            counts[table] = n
        # Feedback split by kind for a quick read.
        kinds = con.execute(
            "SELECT COALESCE(kind, 'unspecified') AS kind, count(*) AS n "
            "FROM feedback GROUP BY COALESCE(kind, 'unspecified') ORDER BY n DESC"
        ).fetchall()
    return {"counts": counts, "feedback_by_kind": [dict(k) for k in kinds]}


@router.get("/users")
def list_users(user: dict = Depends(require_admin)):
    """All users with activation state and per-user counts. is_admin is derived
    from the email allowlist (ADMIN_EMAILS), not stored."""
    with get_pg() as con:
        rows = con.execute(
            """SELECT u.id, u.email, u.full_name, u.phone, u.activated, u.tos_accepted_at, u.created_at,
                      (SELECT count(*) FROM orders o WHERE o.user_id = u.id) AS orders,
                      (SELECT count(*) FROM stores s WHERE s.user_id = u.id) AS stores
               FROM users u
               ORDER BY u.created_at DESC, u.id DESC"""
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["is_admin"] = _is_admin(d["email"])
        out.append(d)
    return out


@router.get("/users/{user_id}")
def user_detail(user_id: int, user: dict = Depends(require_admin)):
    """One user plus their orders, stores, notes, watchlist and feedback."""
    with get_pg() as con:
        u = con.execute(
            "SELECT id, email, full_name, phone, activated, tos_accepted_at, created_at FROM users WHERE id = %s",
            (user_id,)
        ).fetchone()
        if not u:
            raise HTTPException(status_code=404, detail="User not found")
        orders_ = con.execute(
            "SELECT id, name, status, distributor, created_at, updated_at FROM orders WHERE user_id = %s ORDER BY updated_at DESC",
            (user_id,)).fetchall()
        stores_ = con.execute(
            "SELECT id, name, formatted_address, phone FROM stores WHERE user_id = %s ORDER BY name", (user_id,)).fetchall()
        notes_ = con.execute(
            "SELECT id, product_name, wholesaler, note, created_at FROM user_notes WHERE user_id = %s AND deleted = 0 ORDER BY created_at DESC",
            (user_id,)).fetchall()
        wl = con.execute(
            "SELECT id, product_name, wholesaler, target_price FROM watchlist WHERE user_id = %s ORDER BY created_at DESC",
            (user_id,)).fetchall()
        fb = con.execute(
            "SELECT id, kind, message, page, created_at FROM feedback WHERE user_id = %s ORDER BY created_at DESC",
            (user_id,)).fetchall()
    d = dict(u)
    d["is_admin"] = _is_admin(d["email"])
    return {
        "user": d,
        "orders": [dict(r) for r in orders_],
        "stores": [dict(r) for r in stores_],
        "notes": [dict(r) for r in notes_],
        "watchlist": [dict(r) for r in wl],
        "feedback": [dict(r) for r in fb],
    }


_DETAIL_QUERIES = {
    "orders": "SELECT o.id, u.email AS user, o.name, o.distributor, o.status, o.created_at "
              "FROM orders o LEFT JOIN users u ON u.id = o.user_id ORDER BY o.created_at DESC LIMIT 1000",
    "order_lines": "SELECT ol.id, u.email AS user, ol.product_name, ol.wholesaler, ol.qty_cases, ol.qty_units "
                   "FROM order_lines ol LEFT JOIN orders o ON o.id = ol.order_id LEFT JOIN users u ON u.id = o.user_id "
                   "ORDER BY ol.id DESC LIMIT 1000",
    "stores": "SELECT s.id, u.email AS user, s.name, s.formatted_address, s.phone "
              "FROM stores s LEFT JOIN users u ON u.id = s.user_id ORDER BY s.name LIMIT 1000",
    "user_notes": "SELECT n.id, u.email AS user, n.product_name, n.wholesaler, n.note, n.created_at "
                  "FROM user_notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.deleted = 0 ORDER BY n.created_at DESC LIMIT 1000",
    "watchlist": "SELECT w.id, u.email AS user, w.product_name, w.wholesaler, w.target_price "
                 "FROM watchlist w LEFT JOIN users u ON u.id = w.user_id ORDER BY w.created_at DESC LIMIT 1000",
}


@router.get("/detail/{entity}")
def detail(entity: str, user: dict = Depends(require_admin)):
    """Rows for a stat-card drill-down (joined to the owning user's email)."""
    sql = _DETAIL_QUERIES.get(entity)
    if not sql:
        raise HTTPException(status_code=404, detail="Unknown entity")
    with get_pg() as con:
        rows = con.execute(sql).fetchall()
    return [dict(r) for r in rows]


@router.post("/users/{user_id}/activate")
def activate_user(user_id: int, user: dict = Depends(require_admin)):
    with get_pg() as con:
        con.execute("UPDATE users SET activated = 1 WHERE id = %s", (user_id,))
    return {"status": "activated"}


@router.post("/users/{user_id}/deactivate")
def deactivate_user(user_id: int, user: dict = Depends(require_admin)):
    if user_id == user["id"]:
        raise HTTPException(status_code=400, detail="You cannot deactivate your own account.")
    with get_pg() as con:
        con.execute("UPDATE users SET activated = 0 WHERE id = %s", (user_id,))
        con.execute("DELETE FROM auth_tokens WHERE user_id = %s", (user_id,))  # end their sessions
    return {"status": "deactivated"}


@router.delete("/users/{user_id}")
def delete_user(user_id: int, user: dict = Depends(require_admin)):
    """Delete a user and all of their data (cascades). Admins cannot be deleted
    here, and you cannot delete your own account."""
    if user_id == user["id"]:
        raise HTTPException(status_code=400, detail="You cannot delete your own account.")
    with get_pg() as con:
        target = con.execute("SELECT email FROM users WHERE id = %s", (user_id,)).fetchone()
        if not target:
            raise HTTPException(status_code=404, detail="User not found")
        if _is_admin(target["email"]):
            raise HTTPException(status_code=400, detail="Cannot delete an admin account.")
        con.execute("DELETE FROM users WHERE id = %s", (user_id,))
    return {"status": "deleted"}


@router.post("/reload-pricing")
def reload_pricing_admin(user: dict = Depends(require_admin)):
    """Rebuild the pricing cache from Postgres (use after a monthly ingestion).
    Mirrors the top-level endpoint so it is reachable from the admin page."""
    from backend.pricing_cache import build_pricing_cache, ALL_TABLES
    from backend.db import get_duckdb
    # force=True: always build a fresh file from the new data and republish the
    # pointer (don't adopt the existing stale one). Other workers pick up the
    # new file via the pointer within get_pricing_path's check interval.
    build_pricing_cache(force=True)
    # Re-warm the default Products grid memo (perf #2) against the new data.
    try:
        import threading
        from backend.routers.catalog import warm_catalog_grid
        threading.Thread(target=warm_catalog_grid, daemon=True).start()
    except Exception as e:
        print(f"[reload] catalog grid warm skipped: {e}")
    with get_duckdb() as con:
        counts = {t: con.execute(f"SELECT count(*) FROM {t}").fetchone()[0] for t in ALL_TABLES}
    return {"status": "reloaded", "counts": counts}


# --- Go-UPC enrichment backfill -------------------------------------------------
# Runs ON the server (which holds GO_UPC_API_KEY + the R2_* secrets, which aren't
# in a local checkout), in a background thread so the request returns at once.
# Poll /enrich-status; when done, POST /reload-pricing so the new rows surface.
import threading as _ethreading

_enrich_state = {"running": False, "total": 0, "msg": "", "started": None, "finished": None}
_enrich_lock = _ethreading.Lock()


def _run_enrich_bg(limit, refetch, workers, max_rps):
    # Core lives in backend/ (shipped in the image), NOT scripts/, which is in
    # .dockerignore and isn't present in the container.
    from types import SimpleNamespace
    from backend import enrich_backfill as eb
    try:
        if not getattr(eb.goupc, "GO_UPC_ENABLED", False):
            with _enrich_lock:
                _enrich_state["msg"] = "GO_UPC_API_KEY not set on this server"
            return
        todo = eb.compute_todo(refetch, limit)
        with _enrich_lock:
            _enrich_state.update(total=len(todo), msg=f"processing {len(todo)} UPCs")
        args = SimpleNamespace(workers=max(2, workers), max_rps=max_rps, retries=3)

        def emit(m):
            with _enrich_lock:
                _enrich_state["msg"] = str(m)
        eb.run_threaded(todo, args, emit)
        try:
            eb.close_pool()
        except Exception:
            pass
    except Exception as e:  # noqa: BLE001
        with _enrich_lock:
            _enrich_state["msg"] = f"failed: {type(e).__name__}: {e}"
    finally:
        import datetime as _dt2
        with _enrich_lock:
            _enrich_state["running"] = False
            _enrich_state["finished"] = _dt2.datetime.utcnow().isoformat()


@router.post("/enrich-missing")
def enrich_missing(limit: int = Body(0, embed=True),
                   refetch: Optional[str] = Body(None, embed=True),
                   workers: int = Body(6, embed=True),
                   max_rps: float = Body(8.0, embed=True),
                   user: dict = Depends(require_admin)):
    """Backfill Go-UPC enrichment (name/specs/image -> R2) for catalogue UPCs that
    don't have it yet, in a background thread on THIS server. Returns at once; poll
    /api/admin/enrich-status, then POST /api/admin/reload-pricing when done so the
    new rows surface. refetch in {null,'not_found','error','all'} to re-process
    those states too. Only one run at a time."""
    import datetime as _dt
    with _enrich_lock:
        if _enrich_state["running"]:
            return {"status": "already_running", **_enrich_state}
        _enrich_state.update(running=True, total=0, msg="starting",
                             started=_dt.datetime.utcnow().isoformat(), finished=None)
    _ethreading.Thread(target=_run_enrich_bg, args=(limit, refetch, workers, max_rps),
                       daemon=True).start()
    return {"status": "started"}


@router.get("/enrich-status")
def enrich_status(user: dict = Depends(require_admin)):
    """Progress of the Go-UPC backfill started by POST /api/admin/enrich-missing."""
    with _enrich_lock:
        return dict(_enrich_state)


@router.get("/ai-usage")
def ai_usage(
    from_date: Optional[str] = Query(None, description="YYYY-MM-DD inclusive"),
    to_date: Optional[str] = Query(None, description="YYYY-MM-DD inclusive"),
    user: dict = Depends(require_admin),
):
    """AI assistant usage rollup for admins: per-user question count, tokens and
    USD cost over a date range, plus overall totals and the most recent questions.
    Dates are matched against created_at (UTC text 'YYYY-MM-DD HH:MM:SS')."""
    where, params = [], []
    if from_date:
        where.append("created_at >= %s"); params.append(f"{from_date} 00:00:00")
    if to_date:
        where.append("created_at <= %s"); params.append(f"{to_date} 23:59:59")
    wc = (" WHERE " + " AND ".join(where)) if where else ""
    with get_pg() as con:
        per_user = con.execute(
            f"""SELECT COALESCE(user_email, '(anonymous)') AS user_email,
                       COUNT(*) AS questions,
                       COALESCE(SUM(input_tokens), 0) AS input_tokens,
                       COALESCE(SUM(output_tokens), 0) AS output_tokens,
                       COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens,
                       COALESCE(SUM(cost_usd), 0) AS cost_usd
                FROM ai_usage_log{wc}
                GROUP BY 1 ORDER BY cost_usd DESC""",
            params,
        ).fetchall()
        totals = con.execute(
            f"""SELECT COUNT(*) AS questions,
                       COALESCE(SUM(input_tokens), 0) AS input_tokens,
                       COALESCE(SUM(output_tokens), 0) AS output_tokens,
                       COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens,
                       COALESCE(SUM(cost_usd), 0) AS cost_usd
                FROM ai_usage_log{wc}""",
            params,
        ).fetchone()
        recent = con.execute(
            f"""SELECT created_at, COALESCE(user_email, '(anonymous)') AS user_email,
                       surface, question, model, input_tokens, output_tokens, cost_usd
                FROM ai_usage_log{wc}
                ORDER BY created_at DESC LIMIT 200""",
            params,
        ).fetchall()
    return {
        "per_user": [dict(r) for r in per_user],
        "totals": dict(totals) if totals else {},
        "recent": [dict(r) for r in recent],
    }


# ---- CELR Product Number curation (docs/CELR_PRODUCT_NUMBER_DESIGN.md) ----
# Manual merge/split of product families. Merges live in celr_family_aliases
# (cpn -> canonical) so the assignment script can never undo them; a split
# re-points the barcode at a freshly minted family. Changes reach the app on
# the next pricing-cache reload (the UI offers the existing reload button).

def _celr_cpn_from_q(q: str):
    m = re.fullmatch(r"(?i)\s*(?:celr[-\s]*)?0*(\d{1,9})\s*", q or "")
    return int(m.group(1)) if m else None


@router.get("/celr/families")
def celr_families(q: str = Query(""), limit: int = Query(50, ge=1, le=200),
                  user: dict = Depends(require_admin)):
    """Search the family registry: by CELR number (CELR-003873 or 3873) or by
    header name / brand text. Sorted biggest-family first so the most
    impactful groupings surface."""
    with get_pg() as con:
        cpn_q = _celr_cpn_from_q(q)
        if q and cpn_q is not None:
            wherec, params = "f.cpn = %s", [cpn_q]
        elif q:
            wherec, params = "(f.header_name ILIKE %s OR f.brand ILIKE %s)", [f"%{q}%", f"%{q}%"]
        else:
            wherec, params = "TRUE", []
        rows = con.execute(
            f"""SELECT f.cpn, f.header_name, f.brand, f.product_type,
                       a.canonical_cpn AS alias_of,
                       (SELECT count(*) FROM celr_product_upcs u WHERE u.cpn = f.cpn) AS upc_count
                FROM celr_families f
                LEFT JOIN celr_family_aliases a ON a.cpn = f.cpn
                WHERE {wherec}
                ORDER BY upc_count DESC, f.cpn
                LIMIT %s""",
            (*params, limit),
        ).fetchall()
    return [dict(r) for r in rows]


@router.get("/celr/family/{cpn}")
def celr_family_detail(cpn: int, user: dict = Depends(require_admin)):
    """One family with every member barcode and its current distributor
    listings (latest edition per wholesaler), so merge/split decisions are
    made against what the buyer actually sees."""
    with get_pg() as con:
        fam = con.execute("SELECT * FROM celr_families WHERE cpn=%s", (cpn,)).fetchone()
        if not fam:
            raise HTTPException(404, "Family not found")
        alias = con.execute(
            "SELECT canonical_cpn FROM celr_family_aliases WHERE cpn=%s", (cpn,)).fetchone()
        merged_in = [r["cpn"] for r in con.execute(
            "SELECT cpn FROM celr_family_aliases WHERE canonical_cpn=%s ORDER BY cpn", (cpn,)).fetchall()]
        upcs = [dict(r) for r in con.execute(
            "SELECT upc_norm FROM celr_product_upcs WHERE cpn=%s ORDER BY upc_norm", (cpn,)).fetchall()]
        listings: dict = {}
        if upcs:
            ph = ", ".join(["%s"] * len(upcs))
            try:
                rows = con.execute(
                    f"""WITH latest AS (
                            SELECT wholesaler, MAX(edition) AS ed
                            FROM cpl_enriched GROUP BY wholesaler)
                        SELECT DISTINCT LTRIM(CAST(e.upc AS VARCHAR), '0') AS un,
                               e.wholesaler, e.product_name, e.unit_volume, e.unit_qty
                        FROM cpl_enriched e
                        JOIN latest l ON e.wholesaler = l.wholesaler AND e.edition = l.ed
                        WHERE LTRIM(CAST(e.upc AS VARCHAR), '0') IN ({ph})""",
                    tuple(u["upc_norm"] for u in upcs),
                ).fetchall()
                for r in rows:
                    listings.setdefault(r["un"], []).append(
                        {"wholesaler": r["wholesaler"], "product_name": r["product_name"],
                         "unit_volume": r["unit_volume"], "unit_qty": r["unit_qty"]})
            except Exception:
                pass
        for u in upcs:
            u["listings"] = listings.get(u["upc_norm"], [])
    return {**dict(fam), "alias_of": alias["canonical_cpn"] if alias else None,
            "merged_in": merged_in, "upcs": upcs}


@router.post("/celr/merge")
def celr_merge(payload: dict = Body(...), user: dict = Depends(require_admin)):
    """Merge family FROM into family INTO (alias row; reversible). The target
    resolves through existing aliases so chains always end at a canonical."""
    try:
        src, dst = int(payload.get("from_cpn")), int(payload.get("into_cpn"))
    except (TypeError, ValueError):
        raise HTTPException(400, "from_cpn and into_cpn are required integers")
    with get_pg() as con:
        for c in (src, dst):
            if not con.execute("SELECT 1 FROM celr_families WHERE cpn=%s", (c,)).fetchone():
                raise HTTPException(404, f"Family {c} not found")
        seen = set()
        while dst not in seen:
            seen.add(dst)
            r = con.execute(
                "SELECT canonical_cpn FROM celr_family_aliases WHERE cpn=%s", (dst,)).fetchone()
            if not r:
                break
            dst = r["canonical_cpn"]
        if dst == src:
            raise HTTPException(400, "Merge would point a family at itself")
        con.execute(
            "INSERT INTO celr_family_aliases (cpn, canonical_cpn) VALUES (%s, %s) "
            "ON CONFLICT (cpn) DO UPDATE SET canonical_cpn = EXCLUDED.canonical_cpn",
            (src, dst))
        # anything previously merged INTO src follows it to the new canonical
        con.execute("UPDATE celr_family_aliases SET canonical_cpn=%s WHERE canonical_cpn=%s",
                    (dst, src))
    return {"status": "merged", "from_cpn": src, "into_cpn": dst,
            "note": "Reload the pricing cache to apply."}


@router.post("/celr/unmerge")
def celr_unmerge(payload: dict = Body(...), user: dict = Depends(require_admin)):
    try:
        cpn = int(payload.get("cpn"))
    except (TypeError, ValueError):
        raise HTTPException(400, "cpn is required")
    with get_pg() as con:
        n = con.execute("DELETE FROM celr_family_aliases WHERE cpn=%s RETURNING cpn", (cpn,)).fetchone()
        if not n:
            raise HTTPException(404, f"Family {cpn} is not merged into anything")
    return {"status": "unmerged", "cpn": cpn, "note": "Reload the pricing cache to apply."}


@router.post("/celr/split")
def celr_split(payload: dict = Body(...), user: dict = Depends(require_admin)):
    """Move ONE barcode out of its family into a freshly minted one (e.g. a
    reused barcode whose listings are genuinely different products)."""
    upc = re.sub(r"\D", "", str(payload.get("upc_norm") or "")).lstrip("0")
    if not upc:
        raise HTTPException(400, "upc_norm is required")
    header = str(payload.get("header_name") or "").strip()
    with get_pg() as con:
        cur = con.execute("SELECT cpn FROM celr_product_upcs WHERE upc_norm=%s", (upc,)).fetchone()
        if not cur:
            raise HTTPException(404, f"UPC {upc} is not in the registry")
        old = con.execute("SELECT header_name, brand, product_type FROM celr_families WHERE cpn=%s",
                          (cur["cpn"],)).fetchone()
        new_cpn = con.execute("SELECT COALESCE(MAX(cpn), 0) + 1 AS n FROM celr_families").fetchone()["n"]
        con.execute(
            "INSERT INTO celr_families (cpn, family_key, header_name, brand, product_type, created_at) "
            "VALUES (%s, %s, %s, %s, %s, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))",
            (new_cpn, f"manual|upc:{upc}", header or (old["header_name"] if old else f"UPC {upc}"),
             old["brand"] if old else None, old["product_type"] if old else None))
        con.execute("UPDATE celr_product_upcs SET cpn=%s WHERE upc_norm=%s", (new_cpn, upc))
    return {"status": "split", "upc_norm": upc, "from_cpn": cur["cpn"], "new_cpn": new_cpn,
            "celr_product_number": f"CELR-{new_cpn:06d}",
            "note": "Reload the pricing cache to apply."}
