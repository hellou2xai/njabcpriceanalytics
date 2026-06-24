"""Pre-generate short AI blurbs for the Price Drops / Price Increases pages.

For every product whose frontline case price moved up or down in a given
edition, ask Claude for a two-sentence read of the change: is it a real
move versus history, and what should a NJ store owner do about it (buy now,
hold, watch for rebound, switch supplier).

Off automatically when ANTHROPIC_API_KEY is not set.
"""
from __future__ import annotations
import os
import threading

from backend.db import get_duckdb
from backend.pg import get_pg
from backend.pricing_cache import get_pricing_path
from backend import llm_client

_BLURB_VERSION = "v1"
_MODEL = os.getenv("CELR_BLURB_AI_MODEL", os.getenv("CELR_SEARCH_AI_MODEL", "claude-sonnet-4-6"))
_MAX_PER_RUN = int(os.getenv("CELR_MOVER_BLURB_MAX_PER_RUN", "200"))
_HISTORY_EDITIONS = int(os.getenv("CELR_BLURB_HISTORY", "5"))

_lock = threading.Lock()
_run_token: dict[str, str | None] = {"down": None, "up": None}


_SYSTEM = (
    "You write short, useful price-change notes for an independent New Jersey "
    "liquor store owner. Given a product, the size of its frontline case "
    "price move this edition (was, now, delta dollars, delta percent), its "
    "recent price history, and any current discount or RIP context, reply "
    "with EXACTLY ONE OR TWO short sentences (max 40 words total). Lead with "
    "whether this is a meaningful move versus the product's recent history "
    "(not a small wobble); then the action: buy now if a drop is unusually "
    "deep or a rise is likely sticky; hold or switch supplier if a drop is "
    "small and a competitor is cheaper; watch for rebound. Use concrete "
    "dollars and percents. No emojis, no fluff, no greeting, no markdown. "
    "Plain prose only. Avoid em-dashes and en-dashes."
)


def _fmt_ym(edition) -> str:
    s = str(edition or "").strip()
    try:
        y, m = s.split("-")[:2]
        months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        return f"{months[int(m) - 1]} {y}"
    except Exception:
        return s


def _candidates(direction: str, limit: int = 500) -> list[dict]:
    """Movers in the latest edition per wholesaler that don't yet have a
    current-version blurb. Each candidate carries its recent price history."""
    if direction not in ("up", "down"):
        return []
    with get_duckdb() as con:
        rows = con.execute("""
            WITH latest AS (
              SELECT wholesaler, MAX(edition) AS ed FROM price_changes GROUP BY wholesaler
            )
            SELECT pc.wholesaler, pc.edition, pc.product_name,
                   pc.case_price, pc.prev_case_price, pc.case_delta, pc.case_delta_pct,
                   c.upc AS upc, c.brand AS brand, c.unit_volume AS unit_volume,
                   c.unit_qty AS unit_qty, c.effective_case_price AS effective_case_price,
                   c.has_rip AS has_rip, c.has_discount AS has_discount
            FROM price_changes pc
            JOIN latest l ON l.wholesaler = pc.wholesaler AND l.ed = pc.edition
            LEFT JOIN cpl_enriched c
              ON c.wholesaler = pc.wholesaler AND c.edition = pc.edition AND c.product_name = pc.product_name
            WHERE pc.direction = $d
              AND c.upc IS NOT NULL AND c.upc <> ''
              AND pc.case_delta_pct IS NOT NULL
            ORDER BY ABS(pc.case_delta_pct) DESC NULLS LAST
            LIMIT $lim
        """, {"d": direction, "lim": int(limit) * 3}).fetchdf()

        cand_pairs = {(r["wholesaler"], str(r["upc"]).strip()) for _, r in rows.iterrows()}
        hist_df = None
        if cand_pairs:
            pairs_sql = ", ".join(f"($pw{i}, $pu{i})" for i in range(len(cand_pairs)))
            pair_params = {}
            for i, (w, u) in enumerate(cand_pairs):
                pair_params[f"pw{i}"], pair_params[f"pu{i}"] = w, u
            hist_df = con.execute(f"""
                SELECT wholesaler, upc, edition, frontline_case_price, effective_case_price
                FROM cpl_enriched
                WHERE (wholesaler, upc) IN ({pairs_sql})
                ORDER BY wholesaler, upc, edition
            """, pair_params).fetchdf()

    hist_map: dict = {}
    if hist_df is not None:
        for _, r in hist_df.iterrows():
            key = (r["wholesaler"], str(r["upc"]).strip())
            hist_map.setdefault(key, []).append({
                "edition": r["edition"],
                "frontline": float(r["frontline_case_price"]) if r["frontline_case_price"] == r["frontline_case_price"] and r["frontline_case_price"] is not None else None,
                "effective": float(r["effective_case_price"]) if r["effective_case_price"] == r["effective_case_price"] and r["effective_case_price"] is not None else None,
            })

    have: set = set()
    try:
        with get_pg() as pg:
            cur = pg.execute(
                "SELECT wholesaler, LTRIM(upc, '0') AS un, edition FROM ai_mover_blurbs WHERE direction = %s AND version = %s",
                (direction, _BLURB_VERSION),
            )
            for r in cur.fetchall():
                have.add((r["wholesaler"], r["un"], r["edition"]))
    except Exception:
        have = set()

    out: list[dict] = []
    for _, r in rows.iterrows():
        u_raw = str(r["upc"]) if r["upc"] is not None else ""
        u_norm = u_raw.lstrip("0")
        if (r["wholesaler"], u_norm, r["edition"]) in have:
            continue
        ws_upc_hist = hist_map.get((r["wholesaler"], u_raw.strip()), [])
        before, next_mo = [], None
        try:
            idx = next(i for i, e in enumerate(ws_upc_hist) if e["edition"] == r["edition"])
            before = ws_upc_hist[max(0, idx - _HISTORY_EDITIONS):idx]
            next_mo = ws_upc_hist[idx + 1] if idx + 1 < len(ws_upc_hist) else None
        except StopIteration:
            before = ws_upc_hist[-_HISTORY_EDITIONS:]
        out.append({
            "wholesaler": r["wholesaler"], "edition": r["edition"], "upc": u_raw,
            "product_name": r["product_name"], "brand": r.get("brand"),
            "unit_volume": r.get("unit_volume"), "unit_qty": r.get("unit_qty"),
            "case_price": r.get("case_price"), "prev_case_price": r.get("prev_case_price"),
            "case_delta": r.get("case_delta"), "case_delta_pct": r.get("case_delta_pct"),
            "effective_case_price": r.get("effective_case_price"),
            "has_rip": bool(r.get("has_rip")), "has_discount": bool(r.get("has_discount")),
            "history": before, "next_month": next_mo,
        })
        if len(out) >= int(limit):
            break
    return out


def _prompt(row: dict, direction: str) -> str:
    prev = row.get("prev_case_price")
    now = row.get("case_price")
    delta = row.get("case_delta")
    deltapct = row.get("case_delta_pct")
    move_word = "drop" if direction == "down" else "rise"
    bits = [
        f"Product: {row.get('product_name')} ({row.get('unit_volume') or 'size N/A'}).",
        f"Latest edition: {_fmt_ym(row.get('edition'))}.",
    ]
    if prev is not None and now is not None:
        bits.append(f"Frontline case price: was ${prev:.2f}, now ${now:.2f} ({move_word}).")
    if delta is not None and deltapct is not None:
        sign = "+" if delta > 0 else ""
        bits.append(f"Change: {sign}${delta:.2f}/case ({deltapct:+.1f}%).")
    eff = row.get("effective_case_price")
    if eff is not None and now is not None and abs(eff - now) > 0.01:
        bits.append(f"After current discount, effective is ${eff:.2f}/case.")
    if row.get("has_rip"): bits.append("A RIP rebate also stacks.")
    if row.get("has_discount") and (eff is None or eff == now):
        bits.append("A discount is also live.")

    history = row.get("history") or []
    if history:
        parts = []
        for h in history:
            shown = h.get("frontline")
            if shown is None: continue
            parts.append(f"{_fmt_ym(h['edition'])} ${shown:.2f}/cs")
        if parts:
            bits.append("Recent frontline history: " + "; ".join(parts) + ".")

    nxt = row.get("next_month")
    if nxt is None:
        bits.append("Next month: product is not on the next CPL (likely gone).")
    else:
        nxt_fr = nxt.get("frontline")
        nxt_eff = nxt.get("effective")
        if nxt_fr is not None and now is not None:
            if abs(nxt_fr - now) < 0.01:
                bits.append("Next month: frontline price holds.")
            elif nxt_fr > now:
                bits.append(f"Next month: frontline rises further to ${nxt_fr:.2f}/case.")
            else:
                bits.append(f"Next month: frontline falls to ${nxt_fr:.2f}/case.")
        if nxt_eff is not None and now is not None and abs(nxt_eff - (nxt_fr or 0)) > 0.01:
            bits.append(f"Next-month effective: ${nxt_eff:.2f}/case (discount continues).")
    return " ".join(bits)


def _generate_one(row: dict, direction: str) -> str | None:
    try:
        comp = llm_client.complete(
            model=llm_client.MOVER_BLURB_MODEL, max_tokens=160, system=_SYSTEM,
            messages=[{"role": "user", "content": _prompt(row, direction)}],
            cache=True,
        )
        text = (comp.text or "").strip()
        text = text.replace(chr(0x2014), ", ").replace(chr(0x2013), ", ")
        return text or None
    except Exception:
        return None


def _insert(rows: list[tuple[str, str, str, str, str]]) -> int:
    if not rows: return 0
    sql = """
        INSERT INTO ai_mover_blurbs (wholesaler, upc, edition, direction, blurb, version)
        VALUES (%s, %s, %s, %s, %s, %s)
        ON CONFLICT (wholesaler, upc, edition, direction) DO UPDATE
        SET blurb = EXCLUDED.blurb, version = EXCLUDED.version
    """
    n = 0
    with get_pg() as pg:
        for r in rows:
            try:
                pg.execute(sql, (r[0], r[1], r[2], r[3], r[4], _BLURB_VERSION))
                n += 1
            except Exception:
                pass
    return n


def generate_mover_blurbs_batch(direction: str, limit: int | None = None) -> int:
    if not llm_client.enabled() or direction not in ("up", "down"):
        return 0
    cap = limit if limit is not None else _MAX_PER_RUN
    cands = _candidates(direction, limit=cap)
    written: list[tuple[str, str, str, str, str]] = []
    for row in cands:
        blurb = _generate_one(row, direction)
        if not blurb:
            continue
        written.append((str(row["wholesaler"]), str(row["upc"]), str(row["edition"]), direction, blurb))
        if len(written) >= cap: break
    return _insert(written)


def warm_mover_blurbs_async():
    """Kick off blurb generation for both directions, once per cache version."""
    token = str(get_pricing_path())
    def _run(direction: str):
        try:
            n = generate_mover_blurbs_batch(direction)
            if n: print(f"[mover-blurbs] {direction}: generated {n} new blurbs (version {_BLURB_VERSION})")
        except Exception as e:
            print(f"[mover-blurbs] {direction}: background generation skipped: {e}")
    for d in ("down", "up"):
        with _lock:
            if _run_token.get(d) == token:
                continue
            _run_token[d] = token
        threading.Thread(target=_run, args=(d,), daemon=True).start()
