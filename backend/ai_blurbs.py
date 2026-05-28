"""Pre-generate short, context-aware AI blurbs for Time-Sensitive Deals.

Run after each pricing-cache rebuild. For products in the time-sensitive list of
the current (or next) edition that don't yet have a CURRENT-VERSION blurb, ask
Claude for a 2-sentence pitch a retailer can read in 5 seconds. The prompt
includes the product's RECENT PRICE HISTORY (last few editions, frontline +
effective) and what its price is doing NEXT MONTH (deal continues, returns to
list, drops further, gone), so the AI calls out the real "buy now vs wait"
decision instead of restating the discount.

Off automatically when ANTHROPIC_API_KEY is not set.
"""
from __future__ import annotations
import os
import threading
from datetime import date as _date

from backend.db import get_duckdb
from backend.pg import get_pg
from backend.pricing_cache import get_pricing_path

# Bump this when the prompt changes; the generator regenerates anything not yet
# on the current version.
_BLURB_VERSION = "v2"

_MODEL = os.getenv("CELR_BLURB_AI_MODEL", os.getenv("CELR_SEARCH_AI_MODEL", "claude-sonnet-4-6"))
_MAX_PER_RUN = int(os.getenv("CELR_BLURB_MAX_PER_RUN", "200"))
_HISTORY_EDITIONS = int(os.getenv("CELR_BLURB_HISTORY", "5"))  # editions before current

_lock = threading.Lock()
_run_token: str | None = None


def _client_or_none():
    if not os.getenv("ANTHROPIC_API_KEY"):
        return None
    try:
        import anthropic
        return anthropic.Anthropic()
    except Exception:
        return None


_SYSTEM = (
    "You write short, useful sales notes for an independent New Jersey liquor "
    "store owner browsing a wholesale deal sheet. Given the product, its "
    "current discounted pricing, its recent price history (last few editions, "
    "frontline + effective per case), and what is happening NEXT MONTH, reply "
    "with EXACTLY ONE OR TWO short sentences (max 40 words total). Order: "
    "(1) call out whether this is a real drop versus its recent history (not "
    "just a routine discount); (2) tell the buyer the next move based on the "
    "next-month outlook: BUY NOW if the price goes back up or the deal ends, "
    "HOLD if it drops further next month, or stock up if it is rare. "
    "Use concrete dollars. No emojis, no fluff, no greeting, no markdown. "
    "Plain prose only. Avoid em-dashes and en-dashes."
)


def _candidates(limit: int = 500) -> list[dict]:
    """Time-sensitive products in the current/next edition that don't yet have a
    current-version blurb. Each candidate carries its price history + next-month
    snapshot so the AI prompt is genuinely informed."""
    t = _date.today()
    current_ym = f"{t.year:04d}-{t.month:02d}"
    with get_duckdb() as con:
        eds_df = con.execute(
            "SELECT wholesaler, "
            "COALESCE(MAX(CASE WHEN edition <= $c THEN edition END), MAX(edition)) AS cur_ed, "
            "MIN(CASE WHEN edition > $c THEN edition END) AS next_ed "
            "FROM cpl_enriched GROUP BY wholesaler",
            {"c": current_ym},
        ).fetchdf()
        conds, params, idx = [], {}, 0
        for _, row in eds_df.iterrows():
            for ed in (row["cur_ed"], row["next_ed"]):
                if ed is None or (isinstance(ed, float) and ed != ed):
                    continue
                conds.append(f"(wholesaler = $w{idx} AND edition = $e{idx})")
                params[f"w{idx}"], params[f"e{idx}"] = row["wholesaler"], ed
                idx += 1
        if not conds:
            return []
        rows = con.execute(f"""
            SELECT wholesaler, edition, upc, product_name, unit_volume, unit_qty,
                   frontline_case_price, effective_case_price, total_savings_per_case,
                   discount_pct, has_rip, has_closeout, from_date, to_date,
                   date_diff('day', CURRENT_DATE, CAST(to_date AS DATE)) AS dte
            FROM cpl_enriched
            WHERE from_date IS NOT NULL AND to_date IS NOT NULL
              AND CAST(to_date AS DATE) >= CURRENT_DATE
              AND upc IS NOT NULL AND upc <> ''
              AND total_savings_per_case IS NOT NULL AND total_savings_per_case > 0
              AND NOT (EXTRACT(day FROM CAST(from_date AS DATE)) = 1
                       AND CAST(to_date AS DATE) = (date_trunc('month', CAST(to_date AS DATE)) + INTERVAL 1 MONTH - INTERVAL 1 DAY))
              AND ({' OR '.join(conds)})
            ORDER BY total_savings_per_case DESC NULLS LAST
            LIMIT {int(limit) * 3}
        """, params).fetchdf()

        # One pass to build history per (wholesaler, upc) for products in the
        # candidate set, ordered oldest to newest. Cheap: ~tens of thousands of
        # rows total. We do it here while the DuckDB connection is open.
        cand_pairs = {(r["wholesaler"], str(r["upc"]).strip()) for _, r in rows.iterrows()}
        if cand_pairs:
            pairs_sql = ", ".join(f"($pw{i}, $pu{i})" for i in range(len(cand_pairs)))
            pair_params = {}
            for i, (w, u) in enumerate(cand_pairs):
                pair_params[f"pw{i}"], pair_params[f"pu{i}"] = w, u
            hist_df = con.execute(f"""
                SELECT wholesaler, upc, edition,
                       frontline_case_price, effective_case_price, has_discount, has_rip
                FROM cpl_enriched
                WHERE (wholesaler, upc) IN ({pairs_sql})
                ORDER BY wholesaler, upc, edition
            """, pair_params).fetchdf()
        else:
            hist_df = None

    # Build history map keyed by (wholesaler, upc) -> ordered list of edition snapshots.
    hist_map: dict = {}
    if hist_df is not None:
        for _, r in hist_df.iterrows():
            key = (r["wholesaler"], str(r["upc"]).strip())
            hist_map.setdefault(key, []).append({
                "edition": r["edition"],
                "frontline": float(r["frontline_case_price"]) if r["frontline_case_price"] == r["frontline_case_price"] and r["frontline_case_price"] is not None else None,
                "effective": float(r["effective_case_price"]) if r["effective_case_price"] == r["effective_case_price"] and r["effective_case_price"] is not None else None,
                "has_discount": bool(r["has_discount"]),
                "has_rip": bool(r["has_rip"]),
            })

    # Exclude products that already have a CURRENT-VERSION blurb in Postgres.
    have: set = set()
    try:
        with get_pg() as pg:
            cur = pg.execute(
                "SELECT wholesaler, LTRIM(upc, '0') AS un, edition FROM ai_deal_blurbs WHERE version = %s",
                (_BLURB_VERSION,),
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
        # Slice history: up to _HISTORY_EDITIONS prior + the next edition (if any).
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
            "product_name": r["product_name"], "unit_volume": r.get("unit_volume"),
            "unit_qty": r.get("unit_qty"),
            "frontline_case_price": r.get("frontline_case_price"),
            "effective_case_price": r.get("effective_case_price"),
            "total_savings_per_case": r.get("total_savings_per_case"),
            "discount_pct": r.get("discount_pct"),
            "has_rip": bool(r.get("has_rip")), "has_closeout": bool(r.get("has_closeout")),
            "from_date": r.get("from_date"), "to_date": r.get("to_date"),
            "dte": r.get("dte"),
            "history": before,
            "next_month": next_mo,
        })
        if len(out) >= int(limit):
            break
    return out


def _fmt_ym(edition) -> str:
    """Render an edition string like '2026-05' as 'May 2026'."""
    s = str(edition or "").strip()
    try:
        y, m = s.split("-")[:2]
        months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        return f"{months[int(m) - 1]} {y}"
    except Exception:
        return s


def _prompt(row: dict) -> str:
    fr = row.get("frontline_case_price")
    eff = row.get("effective_case_price")
    save = row.get("total_savings_per_case")
    pct = row.get("discount_pct")
    uq = int(row.get("unit_qty") or 0) if str(row.get("unit_qty") or "").strip().isdigit() else 0
    eff_btl = (eff / uq) if (eff and uq) else None

    bits = [
        f"Product: {row.get('product_name')} ({row.get('unit_volume') or 'size N/A'}).",
    ]
    if fr is not None and eff is not None:
        bits.append(f"List ${fr:.2f}/case, current ${eff:.2f}/case.")
    if save is not None:
        line = f"Saving ${save:.2f}/case"
        if pct is not None:
            line += f" ({pct:.0f}% off)"
        bits.append(line + ".")
    if eff_btl is not None:
        bits.append(f"Per bottle: ${eff_btl:.2f}.")
    dte = row.get("dte")
    if dte is not None:
        try:
            n = int(dte)
            if n <= 0: bits.append("Ends today.")
            elif n == 1: bits.append("Ends tomorrow.")
            else: bits.append(f"Ends in {n} days.")
        except Exception:
            pass
    if row.get("has_rip"): bits.append("A RIP rebate stacks on top.")
    if row.get("has_closeout"): bits.append("Closeout (gone after this).")

    # Recent history: list prior editions oldest to newest so the trend is read
    # left to right.
    history = row.get("history") or []
    if history:
        parts = []
        for h in history:
            tag = "deal" if (h.get("effective") is not None and h.get("frontline") is not None and h["effective"] < h["frontline"]) else "list"
            shown = h.get("effective") if h.get("effective") is not None else h.get("frontline")
            if shown is None: continue
            parts.append(f"{_fmt_ym(h['edition'])} ${shown:.2f}/cs ({tag})")
        if parts:
            bits.append("Recent history: " + "; ".join(parts) + ".")

    # Next-month context: tell the AI explicitly whether the price goes back up,
    # stays on deal, drops further, or the product disappears.
    nxt = row.get("next_month")
    if nxt is None:
        bits.append("Next month: this product is not on the next CPL (likely gone).")
    else:
        nxt_eff = nxt.get("effective") if nxt.get("effective") is not None else nxt.get("frontline")
        nxt_fr = nxt.get("frontline")
        cur_eff = eff
        if nxt_eff is not None and cur_eff is not None:
            if abs(nxt_eff - cur_eff) < 0.01:
                tag = "deal continues" if nxt.get("has_discount") or nxt.get("has_rip") else "price holds"
                bits.append(f"Next month: ${nxt_eff:.2f}/case ({tag}).")
            elif nxt_eff > cur_eff:
                diff = nxt_eff - cur_eff
                back_to_list = nxt_fr is not None and abs(nxt_eff - nxt_fr) < 0.01
                tag = "returns to list price" if back_to_list else "price rises"
                bits.append(f"Next month: ${nxt_eff:.2f}/case (${diff:.2f}/case higher, {tag}).")
            else:
                diff = cur_eff - nxt_eff
                bits.append(f"Next month: ${nxt_eff:.2f}/case (${diff:.2f}/case lower, deal deepens).")
        elif nxt_eff is not None:
            bits.append(f"Next month: ${nxt_eff:.2f}/case.")
    return " ".join(bits)


def _generate_one(client, row: dict) -> str | None:
    try:
        msg = client.messages.create(
            model=_MODEL,
            max_tokens=160,
            system=_SYSTEM,
            messages=[{"role": "user", "content": _prompt(row)}],
        )
        parts = []
        for block in msg.content or []:
            if getattr(block, "type", None) == "text":
                parts.append(block.text)
        text = " ".join(parts).strip()
        # Defensive: strip any dash characters the model slipped in.
        text = text.replace(chr(0x2014), ", ").replace(chr(0x2013), ", ")
        return text or None
    except Exception:
        return None


def _insert(rows: list[tuple[str, str, str, str]]) -> int:
    """UPSERT blurbs with the current version. On conflict, overwrite the blurb
    so older versions are naturally replaced by the new prompt's output."""
    if not rows: return 0
    sql = """
        INSERT INTO ai_deal_blurbs (wholesaler, upc, edition, blurb, version)
        VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT (wholesaler, upc, edition) DO UPDATE
        SET blurb = EXCLUDED.blurb,
            version = EXCLUDED.version
    """
    n = 0
    with get_pg() as pg:
        for r in rows:
            try:
                pg.execute(sql, (r[0], r[1], r[2], r[3], _BLURB_VERSION))
                n += 1
            except Exception:
                pass
    return n


def generate_blurbs_batch(limit: int | None = None) -> int:
    """Generate up to `limit` blurbs for products that need one. Returns count written."""
    client = _client_or_none()
    if client is None:
        return 0
    cap = limit if limit is not None else _MAX_PER_RUN
    cands = _candidates(limit=cap)
    written: list[tuple[str, str, str, str]] = []
    for row in cands:
        blurb = _generate_one(client, row)
        if not blurb:
            continue
        written.append((str(row["wholesaler"]), str(row["upc"]), str(row["edition"]), blurb))
        if len(written) >= cap: break
    return _insert(written)


def warm_blurbs_async():
    """Kick off blurb generation in the background, once per cache version."""
    global _run_token
    token = str(get_pricing_path())
    with _lock:
        if _run_token == token:
            return
        _run_token = token
    def _run():
        try:
            n = generate_blurbs_batch()
            if n: print(f"[blurbs] generated {n} new AI deal blurbs (version {_BLURB_VERSION})")
        except Exception as e:
            print(f"[blurbs] background generation skipped: {e}")
    threading.Thread(target=_run, daemon=True).start()
