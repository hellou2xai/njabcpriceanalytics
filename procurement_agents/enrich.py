"""Proposal enrichment: the explainability layer.

After the gate, every surviving line is enriched with the full WHY before a
human sees it:
- the Scout's reason + rationale (joined back from the scout report),
- RIP analysis: rebate earned at this quantity + the next tier and what it
  costs to reach (reusing the assistant's rip_tier_gap tool),
- buy-now-vs-later timing: this edition's price vs next/previous edition,
- demand context from the POS feed (units/day, on hand, days of cover).

All deterministic code - no model calls, no token cost.
"""

from backend.assistant import tool_registry
from backend.db import get_duckdb

from .pos_signals import _velocity_rows


def _norm(upc) -> str:
    return str(upc or "").strip().lstrip("0")


def _timing_rows(pairs: set[tuple[str, str]]) -> dict:
    """{(norm_upc, wholesaler): price-trajectory row} from the catalog."""
    upcs = sorted({p[0] for p in pairs if p[0]})
    wss = sorted({p[1] for p in pairs})
    if not upcs or not wss:
        return {}
    phu = ",".join("?" * len(upcs))
    phw = ",".join("?" * len(wss))
    with get_duckdb() as con:
        rows = con.execute(f"""
            SELECT LTRIM(CAST(upc AS VARCHAR),'0') un, wholesaler,
                   effective_case_price, next_effective_case_price,
                   prev_effective_case_price, has_closeout
            FROM cpl_enriched
            WHERE edition = (SELECT MAX(edition) FROM cpl_enriched)
              AND LTRIM(CAST(upc AS VARCHAR),'0') IN ({phu})
              AND wholesaler IN ({phw})
            QUALIFY ROW_NUMBER() OVER (
                PARTITION BY LTRIM(CAST(upc AS VARCHAR),'0'), wholesaler
                ORDER BY effective_case_price) = 1
        """, upcs + wss).fetchall()
    cols = ["un", "wholesaler", "now", "next", "prev", "closeout"]
    return {(r[0], r[1]): dict(zip(cols, r)) for r in rows}


def _timing(t: dict | None, cases: int) -> dict | None:
    """Plain-language buy-now-vs-wait verdict for one line."""
    if not t:
        return None
    now = float(t["now"] or 0)
    nxt = float(t["next"]) if t["next"] is not None else None
    prv = float(t["prev"]) if t["prev"] is not None else None
    out = {"price_now": round(now, 2),
           "price_next_month": round(nxt, 2) if nxt is not None else None,
           "price_last_month": round(prv, 2) if prv is not None else None}
    if t.get("closeout"):
        out |= {"verdict": "buy_now",
                "explain": "Closeout - being cleared this edition; not expected next month."}
    elif nxt is None:
        moved = ""
        if prv is not None and abs(now - prv) > 0.5:
            d = now - prv
            moved = (f" Price {'rose' if d > 0 else 'dropped'} "
                     f"${abs(d):,.2f}/cs since last month.")
        out |= {"verdict": "no_forecast",
                "explain": f"Next month's price book isn't published yet.{moved}"}
    elif nxt > now + 0.5:
        out |= {"verdict": "buy_now",
                "explain": f"Rises to ${nxt:,.2f}/cs next month "
                           f"(+${nxt - now:,.2f}); buying {cases} cs now saves "
                           f"${(nxt - now) * cases:,.0f}."}
    elif nxt < now - 0.5:
        out |= {"verdict": "wait",
                "explain": f"Drops to ${nxt:,.2f}/cs next month; waiting would "
                           f"save ${(now - nxt) * cases:,.0f} on {cases} cs."}
    else:
        out |= {"verdict": "neutral", "explain": "Same price next month."}
    return out


def _rip_analysis(con, rip_fn, rip_code, cases: int) -> dict | None:
    """Rebate earned at this quantity + the next tier, via rip_tier_gap."""
    try:
        r = rip_fn(con, {"rip_code": str(rip_code), "have": cases})
        if not isinstance(r, dict) or r.get("error"):
            return None
        ladder = r.get("tier_ladder") or []
        achieved = [t for t in ladder if (t.get("more_needed") or 0) <= 0]
        top = achieved[-1] if achieved else None
        return {
            "rip_code": str(rip_code),
            "description": r.get("description"),
            "earned_rebate": top["rebate"] if top else None,
            "earned_per_case": top["per_case"] if top else None,
            "next_tier": r.get("next_tier"),
            "note": r.get("note"),
        }
    except Exception:
        return None


def _all_sources(upcs: list[str]) -> dict[str, list[dict]]:
    """{norm_upc: every distributor's current price}, cheapest first."""
    upcs = sorted({u for u in upcs if u})
    if not upcs:
        return {}
    ph = ",".join("?" * len(upcs))
    with get_duckdb() as con:
        rows = con.execute(f"""
            SELECT LTRIM(CAST(upc AS VARCHAR),'0') un, wholesaler,
                   MIN(effective_case_price) eff
            FROM cpl_enriched
            WHERE edition = (SELECT MAX(edition) FROM cpl_enriched)
              AND LTRIM(CAST(upc AS VARCHAR),'0') IN ({ph})
            GROUP BY 1, 2 ORDER BY 1, eff
        """, upcs).fetchall()
    out: dict[str, list] = {}
    for un, ws, eff in rows:
        out.setdefault(un, []).append({"wholesaler": ws, "effective_case_price": round(float(eff), 2)})
    return out


def _explain_steps(l: dict, sc: dict | None, pos: dict | None,
                   sources: list[dict], timing: dict | None,
                   rip: dict | None, unit_retail: float | None) -> list[dict]:
    """The per-product decision trail: every step the pipeline took for THIS
    line, in plain language with the actual numbers. Deterministic templating
    over journalled data - never model prose - so it is auditable."""
    steps = []

    # 1. Why the Scout flagged it. (reason/rationale live on the SCOUT
    # candidate, not the gate line - read them from sc.)
    why = ((sc or {}).get("reason_code") or l.get("reason_code")
           or "opportunity").replace("_", " ")
    bits = []
    if pos:
        if pos.get("units_per_day"):
            bits.append(f"sells {pos['units_per_day']}/day at the register")
        if pos.get("on_hand_units") is not None:
            bits.append(f"{pos['on_hand_units']} units on hand")
        if pos.get("days_of_cover") is not None:
            bits.append(f"~{pos['days_of_cover']} days of stock left")
    evidence = ("Store data: " + ", ".join(bits) + ". ") if bits else ""
    steps.append({"title": f"1. Spotted by the Deal Scout ({why})",
                  "text": evidence + ((sc or {}).get("rationale")
                                      or l.get("scout_rationale")
                                      or "Flagged as a buying opportunity this edition.")})

    # 2. How the source was chosen.
    if len(sources) > 1:
        listing = "; ".join(f"{s['wholesaler']} ${s['effective_case_price']:,.2f}/cs"
                            for s in sources)
        steps.append({"title": f"2. Compared {len(sources)} sources",
                      "text": f"Current prices: {listing}. Chose "
                              f"{l['chosen_wholesaler']}. "
                              + (l.get("sourcing_note") or "")})
    else:
        steps.append({"title": "2. Single source",
                      "text": f"Only {l['chosen_wholesaler']} lists this item "
                              f"this edition, at ${l['effective_case_price']:,.2f}/cs. "
                              + (l.get("sourcing_note") or "")})

    # 3. What the Money Gate verified.
    gate_txt = (f"Price re-verified against the live price book: "
                f"${l['effective_case_price']:,.2f}/case after discounts and rebates.")
    if unit_retail and l.get("bottles_per_case") and l.get("gp_pct") is not None:
        retail_case = unit_retail * l["bottles_per_case"]
        gate_txt += (f" Margin check: store sells at ${unit_retail:,.2f}/bottle x "
                     f"{l['bottles_per_case']}/case = ${retail_case:,.2f} retail "
                     f"vs ${l['effective_case_price']:,.2f} cost -> "
                     f"{round(l['gp_pct'] * 100)}% gross profit (floor passed).")
    steps.append({"title": "3. Verified by the Money Gate", "text": gate_txt})

    # 4. Rebate (RIP) analysis.
    if rip:
        rip_txt = ""
        if rip.get("earned_rebate"):
            rip_txt = (f"At {l['cases']} case(s) this earns the "
                       f"${rip['earned_rebate']:,.2f} rebate "
                       f"(${rip['earned_per_case']:,.2f}/case) on RIP {rip['rip_code']}. ")
        nt = rip.get("next_tier")
        if nt:
            rip_txt += (f"Next tier: buy {nt.get('more_needed', '?')} more "
                        f"{nt.get('unit', 'cases')} for the ${nt.get('rebate', 0):,.2f} rebate.")
        steps.append({"title": "4. Rebate analysis",
                      "text": rip_txt or rip.get("note") or "RIP attached; see tier ladder."})
    else:
        steps.append({"title": "4. Rebate analysis",
                      "text": "No RIP rebate on this item this edition."})

    # 5. Buy now vs wait.
    if timing:
        steps.append({"title": "5. Timing", "text": timing["explain"]})
    return steps


def build_proposal(store_id: int, kept: list[dict], scout_report: dict) -> list[dict]:
    """Kept gate lines -> fully-explained proposal lines, each carrying its
    step-by-step decision trail."""
    scout_by = {_norm(c.get("upc")): c
                for c in (scout_report or {}).get("candidates", [])}
    pos_by = {_norm(r["upc"]): r for r in _velocity_rows(store_id, limit=5000)}
    timing = _timing_rows({(_norm(l["upc"]), l["chosen_wholesaler"]) for l in kept})
    sources = _all_sources([_norm(l["upc"]) for l in kept])
    data_tools, _ = tool_registry()
    rip_fn = data_tools["rip_tier_gap"][0]

    lines = []
    with get_duckdb() as con:
        for l in kept:
            un = _norm(l["upc"])
            sc = scout_by.get(un)
            pos = pos_by.get(un)
            rip = (_rip_analysis(con, rip_fn, l["rip_code"], l["cases"])
                   if l.get("rip_code") else None)
            tim = _timing(timing.get((un, l["chosen_wholesaler"])), l["cases"])
            src = sources.get(un, [])
            pos_slim = ({"units_per_day": pos.get("units_per_day"),
                         "on_hand_units": pos.get("on_hand_units"),
                         "days_of_cover": pos.get("days_of_cover"),
                         "unit_retail": pos.get("unit_retail")} if pos else None)
            lines.append({
                **l,
                "reason_code": (sc or {}).get("reason_code"),
                "scout_rationale": (sc or {}).get("rationale"),
                "rip": rip,
                "timing": tim,
                "pos": pos_slim,
                "all_sources": src,
                "explain_steps": _explain_steps(
                    l, sc, pos_slim, src, tim, rip,
                    (pos or {}).get("unit_retail")),
                "staged": False,
            })
    return lines
