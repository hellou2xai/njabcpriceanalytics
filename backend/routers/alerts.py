"""
Alerts API: a smart, auto-generated alert digest per user.

Instead of one row per product, alerts are organised into a small set of
CATEGORIES, each a single roll-up with a count and the top items in its
payload. Two intents:
  - opportunity ("don't miss this")
  - risk        ("don't make a mistake")

Generation is idempotent and meant to run automatically (on app load and when
the Alerts page opens); there is no manual button. Pricing reads run on the
DuckDB cache; alerts are stored per user in Postgres.
"""

import json
import os
from datetime import date, datetime
from zoneinfo import ZoneInfo
from fastapi import APIRouter, Depends, HTTPException, Request

from backend.db import get_duckdb, read_parquet
from backend.pg import get_pg
from backend.auth import get_current_user

router = APIRouter(prefix="/api/alerts", tags=["alerts"])


@router.get("")
def get_alerts(unread_only: bool = False, user: dict = Depends(get_current_user)):
    """All alert roll-ups for the user, highest priority first."""
    where = "user_id = %s"
    if unread_only:
        where += " AND read = 0"
    with get_pg() as con:
        rows = con.execute(
            f"SELECT * FROM alerts WHERE {where} ORDER BY priority DESC, created_at DESC",
            (user["id"],),
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        try:
            d["payload"] = json.loads(d.get("payload") or "{}")
        except (TypeError, ValueError):
            d["payload"] = {}
        out.append(d)
    return out


@router.get("/unread-count")
def get_unread_count(user: dict = Depends(get_current_user)):
    with get_pg() as con:
        count = con.execute(
            "SELECT count(*) AS n FROM alerts WHERE user_id = %s AND read = 0", (user["id"],)
        ).fetchone()["n"]
    return {"unread": count}


@router.put("/{alert_id}/read")
def mark_alert_read(alert_id: int, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        con.execute("UPDATE alerts SET read = 1 WHERE id = %s AND user_id = %s", (alert_id, user["id"]))
    return {"status": "read"}


@router.put("/mark-all-read")
def mark_all_read(user: dict = Depends(get_current_user)):
    with get_pg() as con:
        con.execute("UPDATE alerts SET read = 1 WHERE user_id = %s AND read = 0", (user["id"],))
    return {"status": "all_read"}


# ---- generation helpers -------------------------------------------------

def _current_ym() -> str:
    t = date.today()
    return f"{t.year:04d}-{t.month:02d}"


def _cur_editions(con, src, current_ym):
    """Latest edition on-or-before this month, per wholesaler."""
    df = con.execute(
        f"""SELECT wholesaler,
                   COALESCE(MAX(CASE WHEN edition <= $c THEN edition END), MAX(edition)) AS ed
            FROM {src} GROUP BY wholesaler""",
        {"c": current_ym},
    ).fetchdf()
    return {r["wholesaler"]: r["ed"] for _, r in df.iterrows()}


def _ed_clause(eds, params):
    """Build a (wholesaler,edition) OR-filter from a {ws: ed} map."""
    conds = []
    for i, (ws, ed) in enumerate(eds.items()):
        conds.append(f"(wholesaler = $ew{i} AND edition = $ee{i})")
        params[f"ew{i}"] = ws
        params[f"ee{i}"] = ed
    return "(" + " OR ".join(conds) + ")" if conds else "1=0"


def _money(v):
    try:
        return f"${float(v):,.2f}"
    except (TypeError, ValueError):
        return "-"


def _rollup(pg, user_id, ym, category, intent, message, items, priority):
    """Upsert one category roll-up (delete when empty). Relies on the partial
    unique index idx_alerts_rollup so concurrent generates can't duplicate a
    category. The read flag is preserved on update; a new month (different
    edition) is a fresh, unread row."""
    count = len(items)
    if count == 0:
        pg.execute(
            "DELETE FROM alerts WHERE user_id = %s AND alert_type = %s AND edition = %s AND product_name IS NULL",
            (user_id, category, ym),
        )
        return 0
    payload = json.dumps({"intent": intent, "count": count, "items": items[:10]})
    pg.execute(
        """INSERT INTO alerts (user_id, alert_type, edition, message, priority, payload, read)
           VALUES (%s, %s, %s, %s, %s, %s, 0)
           ON CONFLICT (user_id, alert_type, edition) WHERE product_name IS NULL
           DO UPDATE SET message = EXCLUDED.message, payload = EXCLUDED.payload, priority = EXCLUDED.priority""",
        (user_id, category, ym, message, priority, payload),
    )
    return count


def _generate_for_user(uid, ym):
    """Rebuild one user's alert digest from the latest data. Idempotent."""
    with get_pg() as pg, get_duckdb() as con:
        # Clear legacy per-item alerts (old engine; they carry a product_name)
        # and any stale-month roll-ups, so only this month's digest remains.
        pg.execute(
            "DELETE FROM alerts WHERE user_id = %s AND (product_name IS NOT NULL OR edition <> %s)",
            (uid, ym),
        )
        enriched = read_parquet(con, "cpl_enriched")
        changes = read_parquet(con, "price_changes")
        life = read_parquet(con, "item_lifecycle")
        combo = read_parquet(con, "combo")
        rip = read_parquet(con, "rip")

        eds = _cur_editions(con, enriched, ym)

        # Global current / previous edition, for "new this month" detection.
        all_eds = [r[0] for r in con.execute(f"SELECT DISTINCT edition FROM {enriched} ORDER BY edition").fetchall()]
        cur_ed = max([e for e in all_eds if e <= ym], default=(all_eds[-1] if all_eds else None))
        prev_ed = max([e for e in all_eds if cur_ed and e < cur_ed], default=None)

        def items_from(df, label_col, sub_fn):
            out = []
            for _, r in df.iterrows():
                out.append({"label": str(r[label_col]),
                            "wholesaler": str(r.get("wholesaler") or ""),
                            "detail": sub_fn(r)})
            return out

        # current/next edition keys for the month-over-month table
        pc_eds = [r[0] for r in con.execute(f"SELECT DISTINCT edition FROM {changes} ORDER BY edition").fetchall()]
        pc_cur = max([e for e in pc_eds if e <= ym], default=None)
        pc_next = min([e for e in pc_eds if e > ym], default=None)

        # ---------- OPPORTUNITIES ----------

        # Time-sensitive deals ending within 7 days
        try:
            df = con.execute(f"""
                SELECT wholesaler, product_name, total_savings_per_case,
                       CAST(to_date AS DATE) AS to_date,
                       date_diff('day', CURRENT_DATE, CAST(to_date AS DATE)) AS dte
                FROM {enriched}
                WHERE from_date IS NOT NULL AND to_date IS NOT NULL
                  AND CAST(to_date AS DATE) >= CURRENT_DATE
                  AND CAST(to_date AS DATE) <= CURRENT_DATE + INTERVAL 7 DAY
                  AND NOT (EXTRACT(day FROM CAST(from_date AS DATE)) = 1
                           AND CAST(to_date AS DATE) = (date_trunc('month', CAST(to_date AS DATE)) + INTERVAL 1 MONTH - INTERVAL 1 DAY))
                  AND edition >= $ym
                ORDER BY to_date ASC, total_savings_per_case DESC NULLS LAST
            """, {"ym": ym}).fetchdf()
            its = items_from(df, "product_name", lambda r: (
                f"ends in {int(r['dte'])} day{'s' if int(r['dte']) != 1 else ''}"
                + (f" · save {_money(r['total_savings_per_case'])}/cs" if r['total_savings_per_case'] and r['total_savings_per_case'] == r['total_savings_per_case'] else "")))
            _rollup(pg, uid, ym, "expiring", "opportunity",
                    f"{len(its)} deal{'s' if len(its) != 1 else ''} end within 7 days", its, 95)
        except Exception:
            pass

        # RIP rebates that are NEW this edition (a rebate that wasn't there last
        # month is the one you might miss; the full RIP list lives on RIP Products).
        try:
            if cur_ed and prev_ed:
                df = con.execute(f"""
                    SELECT c.wholesaler, c.product_name, c.rip_savings
                    FROM {enriched} c
                    WHERE c.edition = $cur AND c.has_rip = true AND c.rip_savings > 0
                      AND NOT EXISTS (
                          SELECT 1 FROM {enriched} p
                          WHERE p.wholesaler = c.wholesaler AND p.upc = c.upc
                            AND p.unit_volume IS NOT DISTINCT FROM c.unit_volume
                            AND p.edition = $prev AND p.has_rip = true)
                    ORDER BY c.rip_savings DESC
                """, {"cur": cur_ed, "prev": prev_ed}).fetchdf()
            else:
                p = {}
                clause = _ed_clause(eds, p)
                df = con.execute(f"""SELECT wholesaler, product_name, rip_savings FROM {enriched}
                    WHERE {clause} AND has_rip = true AND rip_savings > 0 ORDER BY rip_savings DESC""", p).fetchdf()
            its = items_from(df, "product_name", lambda r: f"rebate {_money(r['rip_savings'])}/cs")
            _rollup(pg, uid, ym, "rip", "opportunity",
                    f"{len(its)} new RIP rebate{'s' if len(its) != 1 else ''} this month", its, 80)
        except Exception:
            pass

        # Combo bundles
        try:
            combo_cur = con.execute(
                f"SELECT COALESCE(MAX(CASE WHEN edition <= $c THEN edition END), MAX(edition)) FROM {combo}",
                {"c": ym}).fetchone()[0]
            combo_prev = con.execute(
                f"SELECT MAX(edition) FROM {combo} WHERE edition < $e", {"e": combo_cur}).fetchone()[0]
            new_clause = (
                "AND combo_code NOT IN (SELECT DISTINCT combo_code FROM " + combo + " WHERE edition = $pe)"
                if combo_prev else "")
            df = con.execute(f"""
                SELECT combo_code, ANY_VALUE(wholesaler) AS wholesaler,
                       ANY_VALUE(product_name) AS product_name, SUM(total_savings) AS sv
                FROM {combo}
                WHERE edition = $e AND total_savings > 0 {new_clause}
                GROUP BY combo_code
                ORDER BY sv DESC
            """, {"e": combo_cur, "pe": combo_prev}).fetchdf()
            its = items_from(df, "product_name", lambda r: f"bundle saves {_money(r['sv'])}")
            label = "new combo bundle" if combo_prev else "combo bundle"
            _rollup(pg, uid, ym, "combo", "opportunity",
                    f"{len(its)} {label}{'s' if len(its) != 1 else ''} this month", its, 70)
        except Exception:
            pass

        # Clearance / closeouts
        try:
            p = {}
            clause = _ed_clause(eds, p)
            df = con.execute(f"""
                SELECT wholesaler, product_name, total_savings_per_case
                FROM {enriched}
                WHERE {clause} AND has_closeout = true
                ORDER BY total_savings_per_case DESC NULLS LAST
            """, p).fetchdf()
            its = items_from(df, "product_name", lambda r: "on clearance")
            _rollup(pg, uid, ym, "clearance", "opportunity",
                    f"{len(its)} clearance / closeout item{'s' if len(its) != 1 else ''}", its, 65)
        except Exception:
            pass

        # Price drops (this month vs last)
        try:
            if pc_cur:
                df = con.execute(f"""
                    SELECT wholesaler, product_name, case_delta_pct, case_price
                    FROM {changes}
                    WHERE edition = $e AND direction = 'down' AND case_delta_pct <= -5
                      AND case_delta_pct >= -70 AND prev_case_price >= 10 AND case_price >= 10
                    ORDER BY case_delta_pct ASC
                """, {"e": pc_cur}).fetchdf()
                its = items_from(df, "product_name", lambda r: f"down {abs(float(r['case_delta_pct'])):.0f}% to {_money(r['case_price'])}/cs")
                _rollup(pg, uid, ym, "price_drop", "opportunity",
                        f"{len(its)} product{'s' if len(its) != 1 else ''} dropped 5%+ this month", its, 75)
        except Exception:
            pass

        # Target price hits (personalised, from the watchlist)
        try:
            wl = pg.execute(
                "SELECT product_name, wholesaler, target_price FROM watchlist WHERE user_id = %s AND target_price IS NOT NULL",
                (uid,)).fetchall()
            hits = []
            for it in wl:
                ed = eds.get(it["wholesaler"])
                if not ed:
                    continue
                row = con.execute(f"""
                    SELECT frontline_case_price FROM {enriched}
                    WHERE wholesaler = $ws AND product_name = $pn AND edition = $e
                      AND frontline_case_price <= $t LIMIT 1
                """, {"ws": it["wholesaler"], "pn": it["product_name"], "e": ed, "t": it["target_price"]}).fetchone()
                if row:
                    hits.append({"label": it["product_name"], "wholesaler": it["wholesaler"],
                                 "detail": f"now {_money(row[0])}/cs (target {_money(it['target_price'])})"})
            _rollup(pg, uid, ym, "target_hit", "opportunity",
                    f"{len(hits)} favorite{'s' if len(hits) != 1 else ''} hit your target price", hits, 90)
        except Exception:
            pass

        # ---------- WATCH-OUTS ----------

        # Draft-order checks (the "don't make a mistake" one)
        try:
            order_items = _order_checks(pg, con, enriched, rip, eds, uid)
            _rollup(pg, uid, ym, "order_check", "risk",
                    f"{len(order_items)} thing{'s' if len(order_items) != 1 else ''} to fix in your draft orders", order_items, 100)
        except Exception:
            pass

        # Buy now: cheaper this month than next (don't wait)
        try:
            if pc_next:
                df = con.execute(f"""
                    SELECT wholesaler, product_name, case_delta_pct, case_price
                    FROM {changes}
                    WHERE edition = $e AND direction = 'up' AND case_delta_pct >= 5
                      AND case_delta_pct <= 70 AND prev_case_price >= 10 AND case_price >= 10
                    ORDER BY case_delta_pct DESC
                """, {"e": pc_next}).fetchdf()
                its = items_from(df, "product_name", lambda r: f"up {float(r['case_delta_pct']):.0f}% next month — buy now")
                _rollup(pg, uid, ym, "buy_now", "risk",
                        f"{len(its)} item{'s' if len(its) != 1 else ''} get more expensive next month", its, 60)
        except Exception:
            pass

        # Wait: cheaper next month (don't buy now)
        try:
            if pc_next:
                df = con.execute(f"""
                    SELECT wholesaler, product_name, case_delta_pct, case_price
                    FROM {changes}
                    WHERE edition = $e AND direction = 'down' AND case_delta_pct <= -5
                      AND case_delta_pct >= -70 AND prev_case_price >= 10 AND case_price >= 10
                    ORDER BY case_delta_pct ASC
                """, {"e": pc_next}).fetchdf()
                its = items_from(df, "product_name", lambda r: f"drops {abs(float(r['case_delta_pct'])):.0f}% next month — consider waiting")
                _rollup(pg, uid, ym, "wait", "risk",
                        f"{len(its)} item{'s' if len(its) != 1 else ''} are cheaper next month", its, 55)
        except Exception:
            pass

        # Lost discounts (a deal you may be assuming is still there)
        try:
            if pc_cur:
                df = con.execute(f"""
                    SELECT wholesaler, product_name
                    FROM {life}
                    WHERE event_type = 'lost_discount' AND edition = $e
                """, {"e": pc_cur}).fetchdf()
                its = items_from(df, "product_name", lambda r: "discount ended since last month")
                _rollup(pg, uid, ym, "lost_deal", "risk",
                        f"{len(its)} product{'s' if len(its) != 1 else ''} lost a discount", its, 50)
        except Exception:
            pass

        # Price increases (heads up before reordering)
        try:
            if pc_cur:
                df = con.execute(f"""
                    SELECT wholesaler, product_name, case_delta_pct, case_price
                    FROM {changes}
                    WHERE edition = $e AND direction = 'up' AND case_delta_pct >= 5
                      AND case_delta_pct <= 70 AND prev_case_price >= 10 AND case_price >= 10
                    ORDER BY case_delta_pct DESC
                """, {"e": pc_cur}).fetchdf()
                its = items_from(df, "product_name", lambda r: f"up {float(r['case_delta_pct']):.0f}% to {_money(r['case_price'])}/cs")
                _rollup(pg, uid, ym, "price_increase", "risk",
                        f"{len(its)} product{'s' if len(its) != 1 else ''} went up 5%+ this month", its, 45)
        except Exception:
            pass

    # (no return; this builds the digest for one user in place)


@router.post("/generate")
def generate_alerts(user: dict = Depends(get_current_user)):
    """Rebuild the signed-in user's alert digest. Idempotent. Runs automatically
    on app load and when the Alerts page opens (no manual button)."""
    ym = _current_ym()
    _generate_for_user(user["id"], ym)
    return {"status": "generated", "edition": ym}


def regenerate_all() -> int:
    """Rebuild the digest for every user. Used by the nightly refresh."""
    ym = _current_ym()
    with get_pg() as con:
        uids = [r["id"] for r in con.execute("SELECT id FROM users").fetchall()]
    for uid in uids:
        try:
            _generate_for_user(uid, ym)
        except Exception:
            pass
    return len(uids)


@router.post("/regenerate-all")
def regenerate_all_endpoint(request: Request, force: bool = False):
    """Nightly refresh for ALL users. Protected by the CRON_SECRET header (not a
    user session) so a scheduler can call it. By default it only does work during
    the midnight hour in US Eastern time (so a scheduler can fire on both
    candidate UTC times and the right one runs, DST included); pass ?force=true
    to run on demand."""
    secret = os.getenv("CRON_SECRET")
    if not secret or request.headers.get("X-Cron-Secret") != secret:
        raise HTTPException(status_code=403, detail="Forbidden")
    et_hour = datetime.now(ZoneInfo("America/New_York")).hour
    if not force and et_hour != 0:
        return {"skipped": True, "reason": f"Eastern hour is {et_hour}, not midnight"}
    n = regenerate_all()
    return {"status": "regenerated", "users": n}


def _order_checks(pg, con, enriched, rip, eds, uid):
    """For products in the user's DRAFT orders: flag a line that is a couple of
    cases short of a bigger RIP tier (missing a rebate) or cheaper elsewhere."""
    lines = pg.execute(
        """SELECT ol.product_name, ol.wholesaler, ol.upc, COALESCE(ol.qty_cases, 0) AS qc
           FROM order_lines ol JOIN orders o ON o.id = ol.order_id
           WHERE o.user_id = %s AND o.status = 'draft'""",
        (uid,)).fetchall()
    out = []
    for ln in lines:
        pn, ws, upc, qc = ln["product_name"], ln["wholesaler"], ln["upc"], int(ln["qc"] or 0)
        ed = eds.get(ws)
        if not ed:
            continue
        cur = con.execute(f"""
            SELECT effective_case_price, rip_code FROM {enriched}
            WHERE wholesaler = $ws AND product_name = $pn AND edition = $e LIMIT 1
        """, {"ws": ws, "pn": pn, "e": ed}).fetchone()
        if not cur:
            continue
        cur_eff = cur[0]

        # (a) short of the next RIP tier (case-unit tiers only)
        rc = cur[1]
        if rc and str(rc) not in ("None", "nan", "0", "") and qc > 0:
            try:
                rr = con.execute(f"""
                    SELECT rip_unit_1, rip_qty_1, rip_amt_1, rip_unit_2, rip_qty_2, rip_amt_2,
                           rip_unit_3, rip_qty_3, rip_amt_3, rip_unit_4, rip_qty_4, rip_amt_4
                    FROM {rip}
                    WHERE rip_code = $rc AND wholesaler = $ws AND edition = $e
                      AND (upc = $u OR $u IS NULL) LIMIT 1
                """, {"rc": str(rc), "ws": ws, "e": ed, "u": str(upc) if upc else None}).fetchone()
                best = None
                if rr:
                    for j in range(0, 12, 3):
                        unit, q, amt = rr[j], rr[j + 1], rr[j + 2]
                        try:
                            q = int(float(q)); amt = float(amt)
                        except (TypeError, ValueError):
                            continue
                        if amt <= 0 or q <= 0:
                            continue
                        if str(unit or "").lower().startswith("case") or str(unit or "").lower() in ("c", "cs", "cases"):
                            if qc < q <= qc + 2 and (best is None or q < best[0]):
                                best = (q, amt)
                if best:
                    need = best[0] - qc
                    out.append({"label": pn, "wholesaler": ws,
                                "detail": f"add {need} more case{'s' if need != 1 else ''} to unlock a {_money(best[1])} rebate"})
                    continue
            except Exception:
                pass

        # (b) cheaper at another distributor (same barcode, current edition)
        if upc and cur_eff:
            try:
                p = {"unorm": str(upc).lstrip("0"), "ws": ws, "cut": float(cur_eff) * 0.95}
                clause = _ed_clause(eds, p)
                alt = con.execute(f"""
                    SELECT wholesaler, effective_case_price FROM {enriched}
                    WHERE {clause} AND LTRIM(upc, '0') = $unorm AND wholesaler <> $ws
                      AND effective_case_price > 0 AND effective_case_price < $cut
                    ORDER BY effective_case_price ASC LIMIT 1
                """, p).fetchone()
                if alt:
                    out.append({"label": pn, "wholesaler": ws,
                                "detail": f"cheaper at {alt[0]}: {_money(alt[1])}/cs vs {_money(cur_eff)}/cs"})
            except Exception:
                pass
    return out
