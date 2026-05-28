"""Pre-generate short AI "why this is a deal" blurbs for Time-Sensitive Deals.

Run after each pricing-cache rebuild. For products in the time-sensitive list of
the current (or next) edition that don't yet have a blurb, ask Claude for a
2-sentence pitch a retailer can read in 5 seconds, and write it to
ai_deal_blurbs (Postgres). The Time-Sensitive Deals endpoint then joins this
table so the card shows the line instantly, no live AI cost on page open.

Off automatically when ANTHROPIC_API_KEY is not set.
"""
from __future__ import annotations
import os
import threading
from datetime import date as _date

from backend.db import get_duckdb
from backend.pg import get_pg
from backend.pricing_cache import get_pricing_path

_MODEL = os.getenv("CELR_BLURB_AI_MODEL", os.getenv("CELR_SEARCH_AI_MODEL", "claude-sonnet-4-6"))
_MAX_PER_RUN = int(os.getenv("CELR_BLURB_MAX_PER_RUN", "200"))
_lock = threading.Lock()
_run_token: str | None = None  # de-dupes background runs for the same cache version


def _client_or_none():
    if not os.getenv("ANTHROPIC_API_KEY"):
        return None
    try:
        import anthropic
        return anthropic.Anthropic()
    except Exception:
        return None


_SYSTEM = (
    "You write very short, useful sales notes for an independent New Jersey "
    "liquor store owner browsing a wholesale deal sheet. Given the product "
    "and its current discounted pricing, reply with EXACTLY ONE OR TWO short "
    "sentences (max 30 words total). Lead with WHY this is a good buy (size "
    "of saving, margin, scarcity), then the next move (buy now, hit the next "
    "tier, watch the expiry). No emojis, no fluff, no greeting, no markdown. "
    "Avoid em-dashes and en-dashes. Plain prose only."
)


def _candidates(limit: int = 500) -> list[dict]:
    """Time-sensitive products in the current/next edition that don't yet have
    a blurb. Mirrors the time_sensitive endpoint's SQL so we generate for the
    exact same set the user sees."""
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
            LIMIT {int(limit)}
        """, params).fetchdf()

    # Exclude products that already have a blurb in Postgres.
    have: set = set()
    try:
        with get_pg() as pg:
            cur = pg.execute("SELECT wholesaler, LTRIM(upc, '0'), edition FROM ai_deal_blurbs")
            for w, u, e in cur.fetchall():
                have.add((w, u, e))
    except Exception:
        have = set()

    out: list[dict] = []
    for _, r in rows.iterrows():
        u_raw = str(r["upc"]) if r["upc"] is not None else ""
        u_norm = u_raw.lstrip("0")
        if (r["wholesaler"], u_norm, r["edition"]) in have:
            continue
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
        })
    return out


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
        bits.append(f"List ${fr:.2f}/case, now ${eff:.2f}/case.")
    if save is not None:
        line = f"Save ${save:.2f}/case"
        if pct is not None:
            line += f" ({pct:.0f}% off)"
        bits.append(line + ".")
    if eff_btl is not None:
        bits.append(f"That works out to ${eff_btl:.2f}/bottle.")
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
    if row.get("has_closeout"): bits.append("Closeout, gone after this.")
    return " ".join(bits)


def _generate_one(client, row: dict) -> str | None:
    try:
        msg = client.messages.create(
            model=_MODEL,
            max_tokens=120,
            system=_SYSTEM,
            messages=[{"role": "user", "content": _prompt(row)}],
        )
        parts = []
        for block in msg.content or []:
            if getattr(block, "type", None) == "text":
                parts.append(block.text)
        text = " ".join(parts).strip()
        # Defensive: strip any dash characters the model slipped in (em/en dash).
        text = text.replace(chr(0x2014), ", ").replace(chr(0x2013), ", ")
        return text or None
    except Exception:
        return None


def _insert(rows: list[tuple[str, str, str, str]]) -> int:
    if not rows: return 0
    sql = """
        INSERT INTO ai_deal_blurbs (wholesaler, upc, edition, blurb)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT (wholesaler, upc, edition) DO NOTHING
    """
    n = 0
    with get_pg() as pg:
        for r in rows:
            try:
                pg.execute(sql, r)
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
            if n: print(f"[blurbs] generated {n} new AI deal blurbs")
        except Exception as e:
            print(f"[blurbs] background generation skipped: {e}")
    threading.Thread(target=_run, daemon=True).start()
