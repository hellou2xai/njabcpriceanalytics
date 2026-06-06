"""Central deal-comparison engine (the "Deal Radar").

Single source of truth for per-(product, edition) deal economics, reused by the
assistant tools, cart / order analysis and alerts so product-vs-product and
month-vs-month comparisons always agree.

It uses the PRECOMPUTED cpl_enriched columns so the numbers match every other
surface in the app:
  - best RIP rebate / case   = rip_savings
  - best case discount       = frontline_case_price - best_case_price
  - net price                = effective_case_price (= best_case_price - rip_savings)
  - combo membership         = combo_code present
  - closeout                 = has_closeout
Editions are per-wholesaler (RIP codes + deals are edition+distributor specific).

`deal_compare(con, products)` enriches a list of product dicts (each needs
`wholesaler` + `upc`) IN PLACE with prior/current/next economics, month-over-month
change flags, and a best-time-to-buy summary, then returns the list.
"""
from __future__ import annotations

from backend.ai_catalog_query import _current_ym

_MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
           "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def month_label(ed: str | None) -> str | None:
    """'2026-05' -> 'May'."""
    if not ed:
        return None
    try:
        _, m = str(ed).split("-")[:2]
        return _MONTHS[int(m)]
    except Exception:
        return str(ed)


def _upc_norm(u) -> str:
    return str(u if u is not None else "").lstrip("0")


def classify(prior, now) -> str:
    """gained / lost / up / down / same / none for a non-negative savings metric."""
    p = prior or 0.0
    n = now or 0.0
    if p <= 0 and n <= 0:
        return "none"
    if p <= 0 < n:
        return "gained"
    if n <= 0 < p:
        return "lost"
    if n > p + 0.005:
        return "up"
    if n < p - 0.005:
        return "down"
    return "same"


def editions_by_wholesaler(con, cym: str | None = None) -> dict:
    """{wholesaler: {'prior', 'current', 'next'}} editions around `cym`."""
    cym = cym or _current_ym()
    rows = con.execute(
        "SELECT wholesaler, edition FROM cpl_enriched GROUP BY 1, 2"
    ).fetchall()
    byws: dict = {}
    for ws, ed in rows:
        byws.setdefault(ws, []).append(ed)
    out: dict = {}
    for ws, eds in byws.items():
        eds = sorted(e for e in eds if e)
        cur = max((e for e in eds if e <= cym), default=None)
        if cur is None:
            continue
        i = eds.index(cur)
        out[ws] = {
            "prior": eds[i - 1] if i - 1 >= 0 else None,
            "current": cur,
            "next": eds[i + 1] if i + 1 < len(eds) else None,
        }
    return out


def deal_compare(con, products: list[dict], cap: int = 60) -> list[dict]:
    """Enrich `products` (in place) with month-over-month deal economics."""
    if not products:
        return products
    cym = _current_ym()
    eds = editions_by_wholesaler(con, cym)
    subset = products[:cap]
    keys: dict = {}            # (ws, upc_norm) -> [product dicts]
    want_eds: set = set()
    for p in subset:
        ws = p.get("wholesaler")
        un = _upc_norm(p.get("upc"))
        if not ws or not un or ws not in eds:
            continue
        keys.setdefault((ws, un), []).append(p)
        for k in ("prior", "current", "next"):
            if eds[ws][k]:
                want_eds.add(eds[ws][k])
    if not keys:
        return products
    ws_list = sorted({k[0] for k in keys})
    un_list = sorted({k[1] for k in keys})
    ed_list = sorted(want_eds)
    ph = lambda xs: ", ".join("?" for _ in xs)  # noqa: E731
    df = con.execute(f"""
        SELECT wholesaler, edition, LTRIM(CAST(upc AS VARCHAR), '0') AS un,
               MAX(rip_savings) AS rip,
               MAX(frontline_case_price - best_case_price) AS casedisc,
               MIN(effective_case_price) AS eff,
               MAX(CASE WHEN combo_code IS NOT NULL
                         AND CAST(combo_code AS VARCHAR) NOT IN ('', '0', 'None', 'nan')
                        THEN 1 ELSE 0 END) AS in_combo,
               MAX(CASE WHEN has_closeout THEN 1 ELSE 0 END) AS closeout
        FROM cpl_enriched
        WHERE wholesaler IN ({ph(ws_list)})
          AND edition IN ({ph(ed_list)})
          AND LTRIM(CAST(upc AS VARCHAR), '0') IN ({ph(un_list)})
        GROUP BY 1, 2, 3
    """, ws_list + ed_list + un_list).fetchdf()

    idx: dict = {}
    for r in df.itertuples(index=False):
        idx[(r.wholesaler, r.edition, r.un)] = r

    def m(ws, ed, un, field):
        r = idx.get((ws, ed, un))
        if r is None:
            return None
        v = getattr(r, field)
        return None if (v is None or v != v) else float(v)

    for (ws, un), plist in keys.items():
        e = eds[ws]
        pri, cur, nxt = e["prior"], e["current"], e["next"]
        rip_now, rip_pri = m(ws, cur, un, "rip") or 0.0, m(ws, pri, un, "rip") or 0.0
        dc_now, dc_pri = m(ws, cur, un, "casedisc") or 0.0, m(ws, pri, un, "casedisc") or 0.0
        cb_now, cb_pri = m(ws, cur, un, "in_combo") or 0.0, m(ws, pri, un, "in_combo") or 0.0
        eff_cur = m(ws, cur, un, "eff")
        eff_pri = m(ws, pri, un, "eff") if pri else None
        eff_nxt = m(ws, nxt, un, "eff") if nxt else None
        # Best time to buy: cheapest NET price between now and next edition.
        if eff_cur is not None and eff_nxt is not None and eff_nxt < eff_cur - 0.005:
            best_window = f"wait → {month_label(nxt)}"
            best_saving = round(eff_cur - eff_nxt, 2)
        elif eff_cur is not None and eff_nxt is not None and eff_cur < eff_nxt - 0.005:
            best_window = "now"
            best_saving = round(eff_nxt - eff_cur, 2)
        else:
            best_window = "now" if eff_cur is not None else None
            best_saving = None
        for p in plist:
            p["rip_now"] = round(rip_now, 2)
            p["rip_prior"] = round(rip_pri, 2)
            p["rip_change"] = classify(rip_pri, rip_now)
            p["casedisc_now"] = round(dc_now, 2)
            p["casedisc_prior"] = round(dc_pri, 2)
            p["disc_change"] = classify(dc_pri, dc_now)
            p["combo_now"] = bool(cb_now)
            p["combo_prior"] = bool(cb_pri)
            p["combo_change"] = classify(cb_pri, cb_now)
            p["prior_edition"] = pri
            p["current_edition"] = cur
            p["next_edition"] = nxt
            # Effective (what you actually PAY) per edition — so callers can
            # compare the real price month-over-month, not "savings off list"
            # (a frontline drop must not read as 'less savings').
            p["eff_cur"] = round(eff_cur, 2) if eff_cur is not None else None
            p["eff_prior"] = round(eff_pri, 2) if eff_pri is not None else None
            p["best_buy_window"] = best_window
            p["best_buy_saving"] = best_saving
    return products
