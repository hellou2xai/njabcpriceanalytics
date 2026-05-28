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
    """Time-sensitive products in the current or next edition that need a blurb."""
    t = _date.today()
    current_ym = f"{t.year:04d}-{t.month:02d}"
    with get_duckdb() as con:
        rows = con.execute(
            """
            WITH eds AS (
              SELECT wholesaler,
                     COALESCE(MAX(CASE WHEN edition <= $c THEN edition END), MAX(edition)) AS cur_ed,
                     MIN(CASE WHEN edition > $c THEN edition END) AS next_ed
              FROM cpl_enriched GROUP BY wholesaler
            ),
            pairs AS (
              SELECT wholesaler, cur_ed AS ed FROM eds WHERE cur_ed IS NOT NULL
              UNION ALL
              SELECT wholesaler, next_ed AS ed FROM eds WHERE next_ed IS NOT NULL
            ),
            cand AS (
              SELECT c.wholesaler, c.edition, c.upc, c.product_name, c.unit_volume, c.unit_qty,
                     c.frontline_case_price, c.effective_case_price, c.total_savings_per_case,
                     c.discount_pct, c.has_rip, c.has_closeout, c.from_date, c.to_date,
                     date_diff('day', CURRENT_DATE, CAST(c.to_date AS DATE)) AS dte
              FROM cpl_enriched c JOIN pairs p ON c.wholesaler = p.wholesaler AND c.edition = p.ed
              WHERE c.from_date IS NOT NULL AND c.to_date IS NOT NULL
                AND CAST(c.to_date AS DATE) >= CURRENT_DATE
                AND c.upc IS NOT NULL AND c.upc <> ''
                AND NOT (EXTRACT(day FROM CAST(c.from_date AS DATE)) = 1
                         AND CAST(c.to_date AS DATE) = (date_trunc('month', CAST(c.to_date AS DATE)) + INTERVAL 1 MONTH - INTERVAL 1 DAY))
                AND c.total_savings_per_case IS NOT NULL AND c.total_savings_per_case > 0
            )
            SELECT cand.* FROM cand
            LEFT JOIN ai_deal_blurbs b
              ON b.wholesaler = cand.wholesaler AND b.upc = cand.upc AND b.edition = cand.edition
            WHERE b.blurb IS NULL
            ORDER BY cand.total_savings_per_case DESC NULLS LAST
            LIMIT $lim
            """,
            {"c": current_ym, "lim": limit},
        ).fetchdf()
    return rows.to_dict("records")


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
