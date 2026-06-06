"""What's New for You — the personalized monthly digest.

Aggregates the user's TRACKED set (Favorites + Cart + Lists) and, for the current
edition, surfaces what changed vs the prior edition plus a savings tally. Every
number is reused from the existing engines — deal_compare (month-over-month RIP /
discount / price classification), analyze_lines (the cart savings analyzer),
_attach_cart_pricing (canonical tiers + prices) and attach_price_3mo (the
two-line sparkline). No new pricing math lives here; this router only personalizes
and arranges.
"""
from fastapi import APIRouter, Depends

from backend.pg import get_pg
from backend.db import get_duckdb, read_parquet
from backend.auth import get_current_user
from backend.enrichment_join import attach_enrichment_image, attach_sku_mapping
from backend import pricing as _pricing
from backend import deal_compare as _dc
from backend.routers.cart import _attach_cart_pricing, analyze_lines, _fnum

router = APIRouter(prefix="/api/whats-new", tags=["digest"])

SECTION_CAP = 14
_MON = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']


def _fmt_range(a, b) -> str:
    import re
    def f(d):
        if not d:
            return ''
        m = re.match(r'(\d{4})-(\d{1,2})-(\d{1,2})', str(d))
        return f"{_MON[int(m.group(2))]} {int(m.group(3))}" if m else str(d)
    fa, fb = f(a), f(b)
    return f"{fa}–{fb}" if fa and fb else (fa or fb)


def _tracked(uid: int) -> list[dict]:
    """Everything the user tracks — Favorites + Cart + Lists — deduped by
    (wholesaler, upc, name, size), tagged with where it came from."""
    out: dict = {}
    with get_pg() as con:
        def pull(src: str, sql: str):
            for r in con.execute(sql, (uid,)).fetchall():
                d = dict(r)
                key = (d.get("wholesaler"), str(d.get("upc") or ""),
                       d.get("product_name") or "", d.get("unit_volume") or "")
                e = out.setdefault(key, {
                    "wholesaler": d.get("wholesaler"), "upc": d.get("upc"),
                    "product_name": d.get("product_name"), "unit_volume": d.get("unit_volume"),
                    "sources": set(), "target_price": None,
                })
                e["sources"].add(src)
                if d.get("target_price") is not None:
                    e["target_price"] = float(d["target_price"])
        pull("favorite", "SELECT upc, product_name, wholesaler, unit_volume, target_price "
                         "FROM watchlist WHERE user_id=%s")
        pull("cart", "SELECT upc, product_name, wholesaler, unit_volume "
                     "FROM cart_items WHERE user_id=%s AND COALESCE(saved_for_later,0)=0")
        pull("list", "SELECT li.upc, li.product_name, li.wholesaler, li.unit_volume "
                     "FROM list_items li JOIN lists l ON li.list_id=l.id WHERE l.user_id=%s")
    return list(out.values())


def _card(p: dict, detail: str, amount, intent: str) -> dict:
    """Trim an enriched product to the fields the digest card needs (incl.
    price_3mo so the same two-line sparkline renders)."""
    return {
        "product_name": p.get("product_name"), "wholesaler": p.get("wholesaler"),
        "upc": p.get("upc"), "unit_volume": p.get("unit_volume"),
        "unit_qty": p.get("unit_qty"), "vintage": p.get("vintage"),
        "abg_sku": p.get("abg_sku"), "image_url": p.get("image_url"),
        "frontline_case_price": _fnum(p.get("frontline_case_price")),
        "effective_case_price": _fnum(p.get("effective_case_price")),
        "has_rip": bool(p.get("has_rip")), "has_discount": bool(p.get("has_discount")),
        "rip_code": p.get("rip_code"),
        "price_3mo": p.get("price_3mo"),
        "sources": sorted(p.get("sources") or []),
        "change_detail": detail, "change_amount": amount, "intent": intent,
    }


def _expiring_days(p: dict):
    """Smallest days-to-expire among this item's ACTIVE time-sensitive RIP tiers."""
    best = None
    for t in (p.get("tiers") or []):
        if t.get("source") != "rip" or t.get("window_status") != "active":
            continue
        d = t.get("days_to_expire")
        if d is None:
            continue
        if best is None or d < best:
            best = d
    return best


@router.get("")
def whats_new(user: dict = Depends(get_current_user)):
    tracked = _tracked(user["id"])
    empty = {"edition": None, "prev_edition": None, "next_edition": None,
             "tracked_count": 0,
             "savings": {"captured_total": 0.0, "opportunity_total": 0.0,
                         "protection_total": 0.0, "recommendations": []},
             "sections": {}}
    if not tracked:
        return empty

    # Enrich a working copy with current pricing + image + sparkline + the
    # month-over-month change classification (all reused engines).
    products = [{"wholesaler": t["wholesaler"], "upc": t["upc"],
                 "product_name": t["product_name"], "unit_volume": t["unit_volume"],
                 "target_price": t["target_price"], "sources": t["sources"]} for t in tracked]
    cur_ed = prev_ed = next_ed = None
    with get_duckdb() as con:
        try:
            _attach_cart_pricing(con, products)       # prices + rip_code + canonical tiers
        except Exception:
            pass
        try:
            attach_enrichment_image(con, products)    # image_url
        except Exception:
            pass
        try:
            attach_sku_mapping(con, products)         # abg_sku (vendor item code)
        except Exception:
            pass
        try:
            _pricing.attach_price_3mo(con, products)  # price_3mo for the sparkline
        except Exception:
            pass
        try:
            _dc.deal_compare(con, products)           # rip_change / best_buy_window / editions
        except Exception:
            pass
    for p in products:
        if p.get("current_edition"):
            cur_ed = cur_ed or p["current_edition"]
            prev_ed = prev_ed or p.get("prior_edition")
            next_ed = next_ed or p.get("next_edition")

    # Savings tally over the whole tracked set (cart analyzer; qty 0 ⇒ "what you
    # could save if you order these").
    sav_lines = [{"wholesaler": t["wholesaler"], "upc": t["upc"],
                  "product_name": t["product_name"], "unit_volume": t["unit_volume"],
                  "qty_cases": 0} for t in tracked]
    savings = analyze_lines(sav_lines)
    savings["recommendations"] = savings.get("recommendations", [])[:6]

    # Month-over-month context for each savings move: compare the EFFECTIVE price
    # you actually pay this edition vs the prior one (NOT savings-off-list — a
    # frontline/list drop must not read as "less savings" when the real price is
    # unchanged). Pulled from deal_compare's eff_cur/eff_prior already on
    # `products`; case-mix rows have no single product so stay un-tagged.
    chg: dict = {}
    for p in products:
        un = str(p.get("upc") or "").lstrip("0")
        if not un:
            continue
        chg[(p.get("wholesaler"), un)] = (_fnum(p.get("eff_cur")), _fnum(p.get("eff_prior")))
    for r in savings["recommendations"]:
        un = str(r.get("upc") or "").lstrip("0")
        pair = chg.get((r.get("wholesaler"), un)) if un else None
        if not pair:
            continue
        now, pri = pair          # effective price now, effective price last edition
        if now is None:
            continue
        if pri is None:
            r["mom"] = {"dir": "new", "delta": 0.0, "text": "new this edition"}
            continue
        delta = round(pri - now, 2)   # positive ⇒ cheaper this edition
        if delta > 0.005:
            r["mom"] = {"dir": "up", "delta": delta, "text": f"${delta:,.2f}/cs cheaper than last month"}
        elif delta < -0.005:
            r["mom"] = {"dir": "down", "delta": delta, "text": f"${abs(delta):,.2f}/cs pricier than last month"}
        else:
            r["mom"] = {"dir": "same", "delta": 0.0, "text": "same price as last month"}

    buy_before, price_relief, new_rips, deeper_rips, lost_rips, target_hits, expiring, partial = (
        [], [], [], [], [], [], [], [])
    for p in products:
        rc = p.get("rip_change")
        win, save = p.get("best_buy_window"), _fnum(p.get("best_buy_saving"))
        eff = _fnum(p.get("effective_case_price"))
        tgt = _fnum(p.get("target_price"))
        rip_now, rip_pri = _fnum(p.get("rip_now")) or 0, _fnum(p.get("rip_prior")) or 0

        if rc == "gained" and rip_now > 0:
            new_rips.append(_card(p, f"New RIP — save ${rip_now:,.2f}/cs", rip_now, "opportunity"))
        elif rc == "up" and rip_now - rip_pri > 0.005:
            deeper_rips.append(_card(p, f"RIP deepened +${rip_now - rip_pri:,.2f}/cs (now ${rip_now:,.2f})",
                                     rip_now - rip_pri, "opportunity"))
        elif rc == "lost" and rip_pri > 0:
            lost_rips.append(_card(p, f"RIP ended — was saving ${rip_pri:,.2f}/cs", rip_pri, "risk"))

        if win == "now" and save and save > 0.5:
            buy_before.append(_card(p, f"Price rises ${save:,.2f}/cs next month — lock in now", save, "risk"))
        elif win and str(win).startswith("wait") and save and save > 0.5:
            price_relief.append(_card(p, f"Drops ${save:,.2f}/cs next month — you can wait", save, "info"))

        if tgt is not None and eff is not None and eff <= tgt + 0.005:
            target_hits.append(_card(p, f"Hit your target — now ${eff:,.2f}/cs (target ${tgt:,.2f})",
                                     tgt - eff, "opportunity"))

        ed = _expiring_days(p)
        if ed is not None and ed <= 14:
            expiring.append(_card(p, f"RIP expires in {ed} day{'s' if ed != 1 else ''}", -ed, "risk"))

        # Partial-month (time-sensitive) QD/RIP — limited-date deals. The savings
        # analyzer favours the smallest tier, so a partial QD (e.g. Buy 10 cases,
        # Jun 9–10) would otherwise never be flagged. Surface it explicitly.
        pts = [t for t in (p.get("tiers") or []) if t.get("is_time_sensitive")]
        if pts:
            best = max(pts, key=lambda t: _fnum(t.get("save_per_case")) or 0.0)
            kind = "QD" if best.get("source") == "discount" else "RIP"
            pa = _fnum(best.get("price_after"))
            sv = _fnum(best.get("save_per_case")) or 0.0
            rng = _fmt_range(best.get("from_date"), best.get("to_date"))
            win = best.get("window_status")
            price_txt = f" → ${pa:,.2f}/cs" if pa is not None else ""
            un = str(best.get("unit") or "").lower()
            if best.get("qty") == 1 and un.endswith("s"):
                un = un[:-1]
            detail = (f"Partial {kind} · {rng}: buy {best.get('qty')} {un}{price_txt} (save ${sv:,.2f}/cs)")
            partial.append(_card(p, detail, sv, "risk" if win == "active" else "info"))

    def top(lst, reverse=True):
        return sorted(lst, key=lambda c: (c.get("change_amount") or 0), reverse=reverse)[:SECTION_CAP]

    sections = {
        "expiring": sorted(expiring, key=lambda c: (c.get("change_amount") or 0), reverse=True)[:SECTION_CAP],
        "partial": top(partial),
        "buy_before": top(buy_before),
        "new_rips": top(new_rips),
        "deeper_rips": top(deeper_rips),
        "target_hits": top(target_hits),
        "lost_rips": top(lost_rips),
        "price_relief": top(price_relief),
    }
    sections = {k: v for k, v in sections.items() if v}
    return {
        "edition": cur_ed, "prev_edition": prev_ed, "next_edition": next_ed,
        "tracked_count": len(tracked),
        "savings": savings,
        "sections": sections,
    }
