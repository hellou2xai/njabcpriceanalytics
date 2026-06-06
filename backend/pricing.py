"""Canonical pricing module — single source of truth for tier construction,
RIP / discount stacking, next-month lookups, vintage / pack-size keys, and
best-deal ranking.

ABSOLUTE RULE (see backend/FOUNDATION.md): every backend caller — catalog
router, deals router, assistant tools, MCP server — reads pricing math
FROM here. They do not re-implement it. If a formula changes, it changes
ONLY in this file (or in `nj_abc_parser/derive.py` for columns precomputed
into the parquet) so every surface picks the change up automatically.

What lives here
---------------
- Edition + key helpers (date strings, pack-size key, vintage normaliser).
- `attach_tiers(con, records)` — the per-product CPL + RIP tier ladder
  the modal and the catalog grid expand into sub-rows.
- `best_disc_at(disc_tiers, cases, pack)` — pure function, the rule for
  "highest qualifying CPL tier at N cases".
- `attach_next_month_prices(con, src, records)` — next-month case price
  and the "Better Price" verdict (Same / This Month / Next Month).
- `attach_next_tiers(con, records)` — the next-edition tier ladder for
  the same SKU.
- `rank_best_deals(con, kind, ...)` — single ranker behind every
  "what's the best deal" question. Drops 100%-off stocking deals by
  default (see `min_effective_pct_of_frontline`).

What does NOT live here
-----------------------
- RIP-unit math (`is_bottle_unit`, `rip_per_case`, etc.): those live in
  `backend.rip_utils` and `pricing.py` re-uses them so the rules stay in
  one place.
- Column formulas precomputed into the parquet (`effective_case_price`,
  `total_savings_per_case`, `price_trend`, ...): those live in
  `nj_abc_parser/derive.py` and are READ from `cpl_enriched`, never
  recomputed.
- HTTP handlers: the routers stay where they are; they just call into
  this module.
"""
from __future__ import annotations

import json
import math
import re
from datetime import date, datetime
from typing import Optional

try:
    from zoneinfo import ZoneInfo
    _EASTERN = ZoneInfo("America/New_York")
except Exception:  # pragma: no cover - zoneinfo always present on 3.9+
    _EASTERN = None

from backend.db import read_parquet
from backend.rip_utils import (
    is_bottle_unit as _is_bottle_unit,
    rip_per_case as _rip_per_case,
    rip_bundle_cost as _rip_bundle_cost,
    normalize_unit as _norm_unit,
)


# ---------------------------------------------------------------------------
# Edition + identity keys (mirrors of catalog.py's helpers, kept in sync).
# These previously lived in backend/routers/catalog.py; they are duplicated
# in ai_catalog_query.py too (see FOUNDATION section 7). Moving them here
# is the long-term home; existing callers still import from catalog.py via
# re-export.
# ---------------------------------------------------------------------------

def eastern_today() -> date:
    """Today's date in US Eastern time. New Jersey ABC operates on ET, but the
    server clock runs UTC — which rolls to the next day (and, at a month boundary,
    the next MONTH) several hours early. Anchoring every edition/date calc here
    keeps 'current month' correct in the evening ET. Handles EST/EDT automatically."""
    if _EASTERN is not None:
        return datetime.now(_EASTERN).date()
    return date.today()


def current_yyyy_mm() -> str:
    """Edition string for today's month in ET (e.g. '2026-05')."""
    t = eastern_today()
    return f"{t.year:04d}-{t.month:02d}"


def next_yyyy_mm() -> str:
    """Edition string for next month in ET (e.g. '2026-06')."""
    t = eastern_today()
    y, m = t.year, t.month
    if m == 12:
        y, m = y + 1, 1
    else:
        m += 1
    return f"{y:04d}-{m:02d}"


def vintage_norm_sql(col: str = "vintage") -> str:
    """SQL expression standardising a raw vintage to a 4-digit string or NULL.
    Rules: 4-digit kept; '2023.0' trimmed to '2023'; 2-digit -> 20XX (<=30) else
    19XX; 'NA'/'NV'/blank/junk -> NULL. Matches `_norm_vintage` (Python mirror)."""
    return (
        "CASE "
        f"WHEN {col} IS NULL OR {col} = '' THEN NULL "
        f"WHEN UPPER({col}) IN ('NA','N/A','NONE','NV') THEN NULL "
        f"WHEN regexp_matches({col}, '^[0-9]{{4}}$') THEN {col} "
        f"WHEN regexp_matches({col}, '^[0-9]{{4}}\\.0+$') THEN substr({col}, 1, 4) "
        f"WHEN regexp_matches({col}, '^[0-9]{{2}}$') THEN "
        f"CASE WHEN CAST({col} AS INTEGER) <= 30 THEN '20' || {col} ELSE '19' || {col} END "
        "ELSE NULL END"
    )


def clean_vintage(v):
    """Normalise a fetched vintage_norm cell to a plain string or None."""
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    return str(v)


_VN_RE_4 = re.compile(r"^[0-9]{4}$")
_VN_RE_40 = re.compile(r"^([0-9]{4})\.0+$")
_VN_RE_2 = re.compile(r"^[0-9]{2}$")


def uq_key(v) -> str:
    """Normalise a raw unit_qty cell for cross-edition lookup keys.

    A bottle-pack count of "12", "12.0", 12.0, " 12 ", and the integer 12 must
    all collapse to the same string so a 12-pack May listing matches the
    12-pack June listing. Distinct pack sizes (6 vs 12) remain distinct (e.g.
    DE TOREN FUSION V UPC 816053000375 ships as a 12-pack 2019 and a 6-pack
    2020 in the same edition — different SKU). NaN / None / blank -> ''.
    """
    if v is None:
        return ""
    if isinstance(v, float):
        if v != v:  # NaN
            return ""
        try:
            return str(int(v)) if float(v).is_integer() else str(v)
        except (TypeError, ValueError, OverflowError):
            return ""
    try:
        s = str(v).strip()
        if not s:
            return ""
        return str(int(float(s)))
    except (TypeError, ValueError):
        return str(v).strip()


def norm_vintage(v) -> Optional[str]:
    """Return a 4-digit vintage string ('2019') or None for NV / blank / junk.
    Python mirror of vintage_norm_sql so dict-key joins match what DuckDB
    computes inside the query."""
    if v is None:
        return None
    if isinstance(v, float):
        if math.isnan(v):
            return None
        v = str(int(v)) if v.is_integer() else str(v)
    s = str(v).strip()
    if not s or s.upper() in ("NA", "N/A", "NONE", "NV"):
        return None
    if _VN_RE_4.match(s):
        return s
    m = _VN_RE_40.match(s)
    if m:
        return m.group(1)
    if _VN_RE_2.match(s):
        n = int(s)
        return ("20" if n <= 30 else "19") + s
    return None


# ---------------------------------------------------------------------------
# Pure function: best applicable CPL discount at N cases.
# Extracted from the closure inside `_attach_discount_rip_tiers` so it can
# be unit-tested in isolation and reused by callers that already have the
# discount list but want to ask "what's the saving at X cases?".
# ---------------------------------------------------------------------------

# Full-window predicate, Python mirror of derive.py's SQL CASE. A discount
# or RIP whose window is partial-month is a TIME-SENSITIVE deal — the
# foundation excludes those from effective_case_price; this helper tags the
# corresponding tier in the modal/popover ladder so the UI can render them
# distinctly (greyed / "TS" badge / etc.).
def is_time_sensitive_window(from_date, to_date) -> bool:
    """True when the (from_date, to_date) range is partial-month. Mirrors
    backend.routers.deals._window_is_time_sensitive: NULL on either side =
    NOT time-sensitive (evergreen). Both present and from.day==1, to ==
    LAST_DAY(to) = NOT time-sensitive (full month or span of months). Else
    time-sensitive."""
    from datetime import date as _d
    import calendar as _cal

    def _p(v):
        if v is None:
            return None
        if hasattr(v, 'year') and hasattr(v, 'month'):  # date / Timestamp / datetime
            try:
                return _d(v.year, v.month, v.day)
            except Exception:
                pass
        try:
            return _d.fromisoformat(str(v)[:10])
        except (TypeError, ValueError):
            return None
    f, t = _p(from_date), _p(to_date)
    if f is None or t is None:
        return False
    return not (f.day == 1 and t.day == _cal.monthrange(t.year, t.month)[1])


def _to_date(v):
    """Parse a date-ish value (ISO string / date / Timestamp) to a datetime.date,
    or None. Shared by window_status and the live-RIP overlay."""
    if v is None:
        return None
    if isinstance(v, float) and v != v:  # NaN
        return None
    if hasattr(v, "year") and hasattr(v, "month") and hasattr(v, "day"):
        try:
            return date(v.year, v.month, v.day)
        except Exception:
            pass
    try:
        return date.fromisoformat(str(v)[:10])
    except (TypeError, ValueError):
        return None


def _iso(v) -> Optional[str]:
    """Render a date-ish value as 'YYYY-MM-DD' or None."""
    d = _to_date(v)
    return d.isoformat() if d else None


def window_status(from_date, to_date, ref_date=None) -> dict:
    """Classify a RIP / discount validity window relative to a reference date.

    Returns ``{status, days_to_expire, starts_in}`` where status is one of:
      - 'evergreen'   : no window (null from/to); always applies
      - 'whole_month' : full calendar month(s); part of the always-on monthly
                        price (NOT time-sensitive)
      - 'active'      : dated window that CONTAINS ref_date (live right now)
      - 'upcoming'    : dated window that STARTS after ref_date
      - 'expired'     : dated window that ENDED before ref_date

    days_to_expire = (to_date - ref).days (negative once expired; None if no
    to_date). starts_in = (from_date - ref).days (>0 while upcoming; None if no
    from_date). ref_date defaults to today in US Eastern (matches edition math).
    """
    ref = _to_date(ref_date) or eastern_today()
    f, t = _to_date(from_date), _to_date(to_date)
    if f is None or t is None:
        return {"status": "evergreen", "days_to_expire": None, "starts_in": None}
    days_to_expire = (t - ref).days
    starts_in = (f - ref).days
    if not is_time_sensitive_window(from_date, to_date):
        status = "whole_month"
    elif ref < f:
        status = "upcoming"
    elif ref > t:
        status = "expired"
    else:
        status = "active"
    return {"status": status, "days_to_expire": days_to_expire, "starts_in": starts_in}


def best_disc_at(disc_tiers: list[dict], cases_bought: float, pack: float) -> float:
    """Highest-amount qualifying CPL discount at `cases_bought` cases, given
    pack size `pack` (bottles per case). CPL tiers are mutually exclusive —
    only the single highest tier the buyer clears applies.

    Qualification:
      - case-unit tier qualifies when cases_bought >= tier.qty
      - bottle-unit tier qualifies when cases_bought * pack >= tier.qty
    """
    best = 0.0
    bottles_bought = cases_bought * pack
    for d in disc_tiers:
        is_btl = _is_bottle_unit(d["unit"])
        threshold = float(d["qty"])
        ok = (bottles_bought >= threshold) if is_btl else (cases_bought >= threshold)
        if ok and d["amount"] > best:
            best = d["amount"]
    return best


# ---------------------------------------------------------------------------
# attach_tiers — the master tier ladder builder. EXACT copy of what lived
# in routers/catalog.py:_attach_discount_rip_tiers; behaviour preserved.
# ---------------------------------------------------------------------------

def _gaps_from_windows(wins, today):
    """No-RIP day gaps BETWEEN dated windows. `wins` = list of (from, to) dates.
    Merges overlapping windows, returns [{from, to, days}] for gaps that aren't
    entirely past."""
    import datetime as _dt
    wins = sorted(set(w for w in wins if w[0] and w[1]))
    gaps = []
    if len(wins) <= 1:
        return gaps
    merged = [wins[0]]
    for f, t in wins[1:]:
        if f <= merged[-1][1] + _dt.timedelta(days=1):
            merged[-1] = (merged[-1][0], max(merged[-1][1], t))
        else:
            merged.append((f, t))
    for i in range(len(merged) - 1):
        gstart = merged[i][1] + _dt.timedelta(days=1)
        gend = merged[i + 1][0] - _dt.timedelta(days=1)
        if gend >= gstart and gend >= today:
            gaps.append({"from": gstart.isoformat(), "to": gend.isoformat(), "days": (gend - gstart).days + 1})
    return gaps


def attach_rip_gaps(con, records) -> None:
    """Set rec['rip_gaps'] = no-RIP windows BETWEEN a product's dated RIP windows
    (matched by UPC across ALL codes, using each UPC's latest edition). For
    surfaces that don't run attach_tiers (e.g. the lists page). No-op on empty."""
    for rec in records:
        rec.setdefault("rip_gaps", [])
    if not records:
        return
    rip_src = read_parquet(con, "rip")
    ws_l = sorted({r["wholesaler"] for r in records if r.get("wholesaler")})
    un_l = sorted({str(r.get("upc") or "").lstrip("0") for r in records
                   if r.get("upc") and str(r.get("upc")).lstrip("0")})
    if not ws_l or not un_l:
        return
    try:
        prm = {}
        pw = ", ".join(f"$w{i}" for i in range(len(ws_l)))
        pu = ", ".join(f"$u{i}" for i in range(len(un_l)))
        for i, v in enumerate(ws_l): prm[f"w{i}"] = v
        for i, v in enumerate(un_l): prm[f"u{i}"] = v
        df = con.execute(f"""
            WITH w AS (
              SELECT wholesaler, edition, LTRIM(CAST(upc AS VARCHAR), '0') AS un,
                     from_date, to_date,
                     MAX(edition) OVER (PARTITION BY wholesaler, LTRIM(CAST(upc AS VARCHAR), '0')) AS led
              FROM {rip_src}
              WHERE wholesaler IN ({pw}) AND LTRIM(CAST(upc AS VARCHAR), '0') IN ({pu})
                AND from_date IS NOT NULL AND to_date IS NOT NULL
                AND (rip_amt_1 > 0 OR rip_amt_2 > 0 OR rip_amt_3 > 0 OR rip_amt_4 > 0)
            )
            SELECT wholesaler, un, from_date, to_date FROM w WHERE edition = led
        """, prm).fetchdf()
    except Exception:
        return
    wins: dict = {}
    for _, r in df.iterrows():
        wf, wt = _to_date(r["from_date"]), _to_date(r["to_date"])
        if wf and wt:
            wins.setdefault((r["wholesaler"], str(r["un"])), []).append((wf, wt))
    # Also union in partial-QD windows (sub-month cpl rows that beat the
    # full-month price): a RIP gap covered by a QD is NOT a trap.
    try:
        craw = read_parquet(con, "cpl")
        df2 = con.execute(f"""
            SELECT wholesaler, LTRIM(CAST(upc AS VARCHAR), '0') AS un, from_date, to_date
            FROM {craw}
            WHERE wholesaler IN ({pw}) AND LTRIM(CAST(upc AS VARCHAR), '0') IN ({pu})
              AND from_date IS NOT NULL AND to_date IS NOT NULL
              AND CAST(to_date AS DATE) >= CURRENT_DATE
              AND best_case_price IS NOT NULL AND frontline_case_price IS NOT NULL
              AND best_case_price < frontline_case_price - 0.005
              AND NOT (EXTRACT(day FROM CAST(from_date AS DATE)) = 1
                       AND CAST(to_date AS DATE) = (date_trunc('month', CAST(to_date AS DATE)) + INTERVAL 1 MONTH - INTERVAL 1 DAY))
        """, prm).fetchdf()
        for _, r in df2.iterrows():
            wf, wt = _to_date(r["from_date"]), _to_date(r["to_date"])
            if wf and wt:
                wins.setdefault((r["wholesaler"], str(r["un"])), []).append((wf, wt))
    except Exception:
        pass
    today = eastern_today()
    for rec in records:
        key = (rec.get("wholesaler"), str(rec.get("upc") or "").lstrip("0"))
        rec["rip_gaps"] = _gaps_from_windows(wins.get(key, []), today)


def attach_tiers(con, records, ref_date=None) -> None:
    """Attach a ``tiers`` list (CPL discount tiers + stacked RIP tiers) to each
    record, mirroring what the catalog table renders as expandable sub-rows.
    Shared by /search (include_tiers), /new-items, the product modal, and the
    product-breakdown chart. No-op on an empty list.

    Each record needs at minimum: wholesaler, edition, upc, unit_qty,
    frontline_case_price, frontline_unit_price, discount_{1..5}_qty/amt, and
    optionally rip_code / rip_group_code.

    ``ref_date`` (ISO string or date; defaults to today in ET) is the date each
    tier's validity window is classified against — every emitted tier carries
    ``from_date``, ``to_date``, ``window_status`` and ``days_to_expire`` so the
    UI can badge Active now / Starts DD MMM / Expires in N days. The reference
    date does NOT change which tiers are listed; it only annotates them.

    Side effect: mutates `records[i]["tiers"]` in place.
    """
    if not records:
        return
    rip_src = read_parquet(con, "rip")

    # Some wholesalers (Fedway) pack multiple RIP codes into one CPL cell
    # separated by whitespace, e.g. "10604 120001". derive.py UNNESTs the same
    # field so the precomputed effective_case_price already accounts for both
    # codes; the tier ladder must do the same so the modal/popover doesn't
    # silently drop the half of the RIP that's stored under the second code.
    def _split_codes(rc) -> list[str]:
        if rc is None:
            return []
        s = str(rc).strip()
        if not s or s in ("None", "nan", "0"):
            return []
        # Split on whitespace; drop blanks; preserve order; dedupe.
        out, seen = [], set()
        for part in s.split():
            p = part.strip()
            if not p or p in ("0", "None", "nan"):
                continue
            if p not in seen:
                seen.add(p)
                out.append(p)
        return out

    # Collect rip lookup keys for this page in one query. We include BOTH the
    # CPL row's own rip_code AND the rip_group_code (the cluster membership
    # when group_by_rip fans a UPC across multiple RIPs). They can differ -
    # the CPL row may reference RIP B while the cluster on the page is RIP A
    # - and the tier sub-rows are expected to follow the cluster, not the CPL
    # side. When fan-out isn't in effect, both codes are usually the same and
    # de-duplication keeps the IN-list short.
    # We collect (code, ws, ed, upc) triples instead of (code, ws, ed) because
    # the canonical rule is: a RIP applies to a product ONLY when the RIP
    # sheet has a row explicitly pairing this product's UPC with that code.
    # Code-level fallback (matching any UPC under the code) is no longer
    # valid — same rule derive.py uses.
    keys = []
    for rec in records:
        for fld in ("rip_code", "rip_group_code"):
            for code in _split_codes(rec.get(fld)):
                keys.append((code, rec["wholesaler"], rec["edition"]))
    uniq_codes = sorted({k[0] for k in keys})
    uniq_ws = sorted({k[1] for k in keys})
    uniq_ed = sorted({k[2] for k in keys})
    rip_full: dict = {}    # (code, ws, ed, upc) -> [tiers]  (the only valid match)
    rip_wins: dict = {}    # (ws, ed, upc_norm) -> [(from_date, to_date)] for gap detection
    if uniq_codes:
        # Pull all RIP rows matching any (code, ws, ed) on this page, then split
        # into per-UPC and code-level buckets so we can fall back when a
        # wholesaler anchors the RIP to a stub UPC.
        rp = {}
        ph_codes = ", ".join(f"$rc_{i}" for i in range(len(uniq_codes)))
        ph_ws = ", ".join(f"$ws_{i}" for i in range(len(uniq_ws)))
        ph_ed = ", ".join(f"$ed_{i}" for i in range(len(uniq_ed)))
        for i, v in enumerate(uniq_codes):
            rp[f"rc_{i}"] = v
        for i, v in enumerate(uniq_ws):
            rp[f"ws_{i}"] = v
        for i, v in enumerate(uniq_ed):
            rp[f"ed_{i}"] = v
        rip_rows = con.execute(f"""
            SELECT rip_code, wholesaler, edition, upc, rip_description,
                   from_date, to_date,
                   rip_unit_1, rip_qty_1, rip_amt_1,
                   rip_unit_2, rip_qty_2, rip_amt_2,
                   rip_unit_3, rip_qty_3, rip_amt_3,
                   rip_unit_4, rip_qty_4, rip_amt_4
            FROM {rip_src}
            WHERE rip_code IN ({ph_codes})
              AND wholesaler IN ({ph_ws})
              AND edition IN ({ph_ed})
        """, rp).fetchdf()
        for _, r in rip_rows.iterrows():
            # Time-sensitive flag for THIS RIP source row, attached to every
            # tier it produces. The buyer sees the tier in the ladder either
            # way, but the UI can render it distinctly. derive.py excludes
            # these from best_rip_amt so they don't pollute effective price.
            rip_ts = is_time_sensitive_window(r.get("from_date"), r.get("to_date"))
            rip_win = window_status(r.get("from_date"), r.get("to_date"), ref_date)
            rip_from = _iso(r.get("from_date"))
            rip_to = _iso(r.get("to_date"))
            tiers_here = []
            for j in range(1, 5):
                amt = r.get(f"rip_amt_{j}")
                qty = r.get(f"rip_qty_{j}")
                unit = r.get(f"rip_unit_{j}")
                try:
                    af = float(amt) if amt is not None else 0.0
                    qf = float(qty) if qty is not None else 0.0
                except (TypeError, ValueError):
                    continue
                if math.isnan(af) or math.isnan(qf) or af <= 0 or qf <= 0:
                    continue
                tiers_here.append({
                    "qty": int(qf),
                    "unit": str(unit) if unit else "Cases",
                    "amount": af,
                    "description": str(r.get("rip_description") or "") or None,
                    "is_time_sensitive": rip_ts,
                    "from_date": rip_from,
                    "to_date": rip_to,
                    "window_status": rip_win["status"],
                    "days_to_expire": rip_win["days_to_expire"],
                })
            if not tiers_here:
                continue
            upc_key = (str(r["rip_code"]), r["wholesaler"], r["edition"], str(r.get("upc") or ""))
            rip_full.setdefault(upc_key, []).extend(tiers_here)

    # Partial-window QUANTITY DISCOUNTS. A dated promo lives as a SEPARATE
    # sub-month row in the RAW cpl (with its own best_case_price = the BEST QD
    # for those dates); the enriched cache keeps only the full-month row, so the
    # partial QD is invisible here. We pull each sub-month row and surface its
    # best_case_price as ONE partial tier (only the best QD applies on a date —
    # never stacked), flagged time-sensitive with the date window.
    part_rows: dict = {}   # (ws, ed, upc_norm) -> [raw partial rows]
    p_ws = sorted({r["wholesaler"] for r in records if r.get("wholesaler")})
    p_ed = sorted({r["edition"] for r in records if r.get("edition")})
    p_un = sorted({str(r.get("upc") or "").lstrip("0") for r in records if r.get("upc") and str(r.get("upc")).lstrip("0")})
    if p_ws and p_ed and p_un:
        try:
            craw = read_parquet(con, "cpl")
            pp = {}
            ph_pw = ", ".join(f"$pw{i}" for i in range(len(p_ws)))
            ph_pe = ", ".join(f"$pe{i}" for i in range(len(p_ed)))
            ph_pu = ", ".join(f"$pu{i}" for i in range(len(p_un)))
            for i, v in enumerate(p_ws): pp[f"pw{i}"] = v
            for i, v in enumerate(p_ed): pp[f"pe{i}"] = v
            for i, v in enumerate(p_un): pp[f"pu{i}"] = v
            prows = con.execute(f"""
                SELECT wholesaler, edition, LTRIM(CAST(upc AS VARCHAR), '0') AS un,
                       CAST(from_date AS DATE) AS from_date, CAST(to_date AS DATE) AS to_date,
                       frontline_case_price AS fcp, best_case_price AS bcp,
                       discount_1_qty AS d1q, discount_1_amt AS d1a,
                       discount_2_qty AS d2q, discount_2_amt AS d2a,
                       discount_3_qty AS d3q, discount_3_amt AS d3a,
                       discount_4_qty AS d4q, discount_4_amt AS d4a,
                       discount_5_qty AS d5q, discount_5_amt AS d5a
                FROM {craw}
                WHERE wholesaler IN ({ph_pw}) AND edition IN ({ph_pe})
                  AND LTRIM(CAST(upc AS VARCHAR), '0') IN ({ph_pu})
                  AND from_date IS NOT NULL AND to_date IS NOT NULL
                  AND NOT (EXTRACT(day FROM CAST(from_date AS DATE)) = 1
                           AND CAST(to_date AS DATE) = (date_trunc('month', CAST(to_date AS DATE)) + INTERVAL 1 MONTH - INTERVAL 1 DAY))
            """, pp).fetchdf()
            for _, r in prows.iterrows():
                part_rows.setdefault((r["wholesaler"], r["edition"], str(r["un"])), []).append(r)
        except Exception:
            part_rows = {}

    # Which discount QTYs appear in a FULL-calendar-month raw cpl row, per UPC.
    # The enriched cache can mark a discount evergreen even when the raw cpl only
    # has that qty in a PARTIAL window (dedup bug → prod Remy "Buy 10" looked
    # full-month). Knowing the truly-full-month qtys lets us flag the rest as
    # partial from the authoritative raw windows.
    full_qty: dict = {}
    if p_ws and p_ed and p_un:
        try:
            craw = read_parquet(con, "cpl")
            fq = con.execute(f"""
                SELECT wholesaler, edition, LTRIM(CAST(upc AS VARCHAR), '0') AS un,
                       discount_1_qty AS d1q, discount_1_amt AS d1a,
                       discount_2_qty AS d2q, discount_2_amt AS d2a,
                       discount_3_qty AS d3q, discount_3_amt AS d3a,
                       discount_4_qty AS d4q, discount_4_amt AS d4a,
                       discount_5_qty AS d5q, discount_5_amt AS d5a
                FROM {craw}
                WHERE wholesaler IN ({ph_pw}) AND edition IN ({ph_pe})
                  AND LTRIM(CAST(upc AS VARCHAR), '0') IN ({ph_pu})
                  AND (from_date IS NULL OR to_date IS NULL
                       OR (EXTRACT(day FROM CAST(from_date AS DATE)) = 1
                           AND CAST(to_date AS DATE) = (date_trunc('month', CAST(to_date AS DATE)) + INTERVAL 1 MONTH - INTERVAL 1 DAY)))
            """, pp).fetchdf()
            for _, r in fq.iterrows():
                s = full_qty.setdefault((r["wholesaler"], r["edition"], str(r["un"])), set())
                for j in range(1, 6):
                    a = r.get(f"d{j}a")
                    try:
                        af = float(a) if a is not None else 0.0
                    except (TypeError, ValueError):
                        af = 0.0
                    if af <= 0 or math.isnan(af):
                        continue
                    mm = re.match(r"^\s*(\d+(?:\.\d+)?)", str(r.get(f"d{j}q") or ""))
                    if mm:
                        s.add(int(float(mm.group(1))))
        except Exception:
            full_qty = {}

    # All RIP windows + TIERS per UPC across EVERY code. The cpl row's rip_code
    # names only ONE code, but the SAME product UPC can be listed under several
    # codes — Remy's Buy-1-cs RIP is code 112263 (Jun 1-8) AND code 112264
    # (Jun 11-30). A strict by-code lookup only ever sees the row's own code, so
    # the "next RIP date" window (a different code that ALSO lists this UPC) was
    # invisible in the tier ladder. Matching by UPC surfaces every layer and is
    # still canonical — every tier returned EXPLICITLY lists this product's UPC
    # (no code-level fallback). Used both for gap detection (rip_wins) and to
    # feed the ladder every window (rip_by_upc).
    rip_by_upc: dict = {}  # (ws, ed, upc_norm) -> [tiers]  (all codes listing this UPC)
    g_ws = sorted({rec["wholesaler"] for rec in records if rec.get("wholesaler")})
    g_ed = sorted({rec["edition"] for rec in records if rec.get("edition")})
    g_un = sorted({str(rec.get("upc") or "").lstrip("0") for rec in records
                   if rec.get("upc") and str(rec.get("upc")).lstrip("0")})
    if g_ws and g_ed and g_un:
        try:
            gp = {}
            gw = ", ".join(f"$gw{i}" for i in range(len(g_ws)))
            ge = ", ".join(f"$ge{i}" for i in range(len(g_ed)))
            gu = ", ".join(f"$gu{i}" for i in range(len(g_un)))
            for i, v in enumerate(g_ws): gp[f"gw{i}"] = v
            for i, v in enumerate(g_ed): gp[f"ge{i}"] = v
            for i, v in enumerate(g_un): gp[f"gu{i}"] = v
            gwins = con.execute(f"""
                SELECT wholesaler, edition, LTRIM(CAST(upc AS VARCHAR), '0') AS un,
                       rip_description, from_date, to_date,
                       rip_unit_1, rip_qty_1, rip_amt_1,
                       rip_unit_2, rip_qty_2, rip_amt_2,
                       rip_unit_3, rip_qty_3, rip_amt_3,
                       rip_unit_4, rip_qty_4, rip_amt_4
                FROM {rip_src}
                WHERE wholesaler IN ({gw}) AND edition IN ({ge})
                  AND LTRIM(CAST(upc AS VARCHAR), '0') IN ({gu})
                  AND from_date IS NOT NULL AND to_date IS NOT NULL
                  AND (rip_amt_1 > 0 OR rip_amt_2 > 0 OR rip_amt_3 > 0 OR rip_amt_4 > 0)
            """, gp).fetchdf()
            for _, r in gwins.iterrows():
                wf, wt = _to_date(r["from_date"]), _to_date(r["to_date"])
                ukey = (r["wholesaler"], r["edition"], str(r["un"]))
                if wf and wt:
                    rip_wins.setdefault(ukey, []).append((wf, wt))
                # Build the tier dicts for this window (same shape as rip_full).
                u_ts = is_time_sensitive_window(r.get("from_date"), r.get("to_date"))
                u_win = window_status(r.get("from_date"), r.get("to_date"), ref_date)
                u_from = _iso(r.get("from_date"))
                u_to = _iso(r.get("to_date"))
                for j in range(1, 5):
                    amt = r.get(f"rip_amt_{j}")
                    qty = r.get(f"rip_qty_{j}")
                    unit = r.get(f"rip_unit_{j}")
                    try:
                        af = float(amt) if amt is not None else 0.0
                        qf = float(qty) if qty is not None else 0.0
                    except (TypeError, ValueError):
                        continue
                    if math.isnan(af) or math.isnan(qf) or af <= 0 or qf <= 0:
                        continue
                    rip_by_upc.setdefault(ukey, []).append({
                        "qty": int(qf),
                        "unit": str(unit) if unit else "Cases",
                        "amount": af,
                        "description": str(r.get("rip_description") or "") or None,
                        "is_time_sensitive": u_ts,
                        "from_date": u_from,
                        "to_date": u_to,
                        "window_status": u_win["status"],
                        "days_to_expire": u_win["days_to_expire"],
                    })
        except Exception:
            pass

    def _lookup_rips(rec):
        # Prefer the CLUSTER's code (rip_group_code) when present, so a row
        # fanned out under RIP A shows RIP A's tiers even if its CPL-side
        # rip_code points at RIP B. Fall back to the CPL rip_code so non-
        # fanout views keep working unchanged. Both fields are split on
        # whitespace so a multi-code cell like "10604 120001" looks up each
        # code separately — same as derive.py.
        candidates: list[str] = []
        for fld in ("rip_group_code", "rip_code"):
            for code in _split_codes(rec.get(fld)):
                if code not in candidates:
                    candidates.append(code)
        # Strict (code, ws, ed, upc) lookup ONLY. Codes whose RIP sheet doesn't
        # explicitly list this product's UPC contribute nothing — code-level
        # fallback was removed per the canonical rule.
        out: list[dict] = []
        ws, ed = rec["wholesaler"], rec["edition"]
        upc = str(rec.get("upc") or "")
        for rc in candidates:
            upc_key = (rc, ws, ed, upc)
            if upc_key in rip_full:
                out.extend(rip_full[upc_key])
        # ALSO pull every RIP window this UPC is listed under across ALL codes,
        # so a "next RIP date" living under a DIFFERENT code (Remy: Buy-1-cs RIP
        # under 112263 Jun 1-8 AND 112264 Jun 11-30) shows as its own layer. This
        # is still canonical — these rows EXPLICITLY list this UPC. Exact-window
        # duplicates with the code lookup collapse in the dedup below.
        out.extend(rip_by_upc.get((ws, ed, str(upc).lstrip("0")), []))
        return out

    def _uq(rec) -> float:
        """Bottles per case (for per-bottle pricing). Defaults to 1."""
        try:
            n = float(rec.get("unit_qty") or 0)
            return n if n > 0 else 1.0
        except (TypeError, ValueError):
            return 1.0

    def _btl_after(price_after, uq) -> Optional[float]:
        return round(price_after / uq, 2) if (price_after is not None and uq > 0) else None

    for rec in records:
        cp = float(rec.get("frontline_case_price") or 0)
        uq = _uq(rec)
        # The CPL row's own (from_date, to_date) determines whether THIS row's
        # discount tiers are time-sensitive. derive.py excludes those from
        # effective_case_price + has_discount + total_savings_per_case; here
        # we still surface them in the ladder so the buyer sees the promo
        # exists, but tagged so the UI can render them distinctly.
        cpl_ts = is_time_sensitive_window(rec.get("from_date"), rec.get("to_date"))
        cpl_win = window_status(rec.get("from_date"), rec.get("to_date"), ref_date)
        cpl_from = _iso(rec.get("from_date"))
        cpl_to = _iso(rec.get("to_date"))
        # CPL discount tiers
        disc = []
        for i in range(1, 6):
            amt = rec.get(f"discount_{i}_amt")
            if amt is None or (isinstance(amt, float) and math.isnan(amt)) or amt <= 0:
                continue
            qty_raw = rec.get(f"discount_{i}_qty")
            m = re.match(r"^\s*(\d+(?:\.\d+)?)\s*(.*)$", str(qty_raw or ""))
            if not m:
                continue
            try:
                qty_n = int(float(m.group(1)))
            except (TypeError, ValueError):
                continue
            # Route the tail through the shared normalizer so allied's 'Cases',
            # fedway's bare numerics, opici's lowercase 'bottle' all collapse
            # uniformly. Anything unrecognised defaults to Cases - matching
            # every wholesaler whose discount qty column omits the unit text
            # (fedway, high_grade, peerless).
            unit = "Bottles" if _norm_unit(m.group(2) or "") == "bottle" else "Cases"
            amt_f = float(amt)
            disc.append({
                "source": "discount",
                "qty": qty_n,
                "unit": unit,
                "amount": amt_f,
                "save_per_case": amt_f,
                "price_after": round(cp - amt_f, 2) if cp > 0 else None,
                "btl_price_after": _btl_after(round(cp - amt_f, 2) if cp > 0 else None, uq),
                "save_per_bottle": round(amt_f / uq, 2) if uq > 0 else None,
                "roi_pct": round(amt_f / cp * 100, 2) if cp > 0 else 0.0,
                "is_time_sensitive": cpl_ts,
                "from_date": cpl_from,
                "to_date": cpl_to,
                "window_status": cpl_win["status"],
                "days_to_expire": cpl_win["days_to_expire"],
            })

        # Partial-window QD tiers from the raw sub-month rows (see batch above).
        # Each sub-month row contributes its BEST quantity discount (the qty with
        # the largest amount, priced at the row's best_case_price — only the best
        # QD applies on a date, never stacked), flagged time-sensitive with the
        # date window so the UI shows it as a PARTIAL QD.
        un_key = str(rec.get("upc") or "").lstrip("0")
        for pr in part_rows.get((rec["wholesaler"], rec["edition"], un_key), []):
            # Best discount tier on this sub-month row.
            best_qty, best_amt, best_unit = None, 0.0, "Cases"
            for j in range(1, 6):
                a = pr.get(f"d{j}a")
                if a is None or (isinstance(a, float) and math.isnan(a)) or a <= 0:
                    continue
                mm = re.match(r"^\s*(\d+(?:\.\d+)?)\s*(.*)$", str(pr.get(f"d{j}q") or ""))
                if not mm:
                    continue
                if float(a) > best_amt:
                    best_amt = float(a)
                    best_qty = int(float(mm.group(1)))
                    best_unit = "Bottles" if _norm_unit(mm.group(2) or "") == "bottle" else "Cases"
            if not best_qty or best_amt <= 0:
                continue
            p_front = float(pr["fcp"]) if pr["fcp"] is not None and not (isinstance(pr["fcp"], float) and math.isnan(pr["fcp"])) else cp
            p_best = (float(pr["bcp"]) if pr["bcp"] is not None and not (isinstance(pr["bcp"], float) and math.isnan(pr["bcp"]))
                      else round(p_front - best_amt, 2))
            if p_best is None or p_best >= p_front - 0.005:
                continue
            # Skip if a full-month tier at this qty already beats it.
            if any(d["qty"] == best_qty and (d["unit"] or "").lower() == best_unit.lower()
                   and (d.get("price_after") or 1e9) <= p_best + 0.005 for d in disc):
                continue
            p_win = window_status(pr["from_date"], pr["to_date"], ref_date)
            disc.append({
                "source": "discount", "qty": best_qty, "unit": best_unit,
                "amount": round(p_front - p_best, 2), "save_per_case": round(p_front - p_best, 2),
                "price_after": round(p_best, 2),
                "btl_price_after": _btl_after(round(p_best, 2), uq),
                "save_per_bottle": round((p_front - p_best) / uq, 2) if uq > 0 else None,
                "roi_pct": round((p_front - p_best) / p_front * 100, 2) if p_front > 0 else 0.0,
                "is_time_sensitive": True,
                "from_date": _iso(pr["from_date"]), "to_date": _iso(pr["to_date"]),
                "window_status": p_win["status"], "days_to_expire": p_win["days_to_expire"],
            })
        disc.sort(key=lambda d: d["qty"])

        # RIP tiers. Show EVERY distinct RIP layer. A single qty can be offered
        # in SEVERAL dated windows — Remy's Buy-1-cs RIP runs Jun 1-8 AND
        # Jun 11-30 (with a QD-covered gap between). Collapsing them to one tier
        # per (qty, unit) hid the later window — the buyer never saw the "next
        # RIP date". So dedupe ONLY EXACT-duplicate windows: same qty + unit AND
        # same from/to dates (genuine RIP-sheet dupes, e.g. a SKU matching two
        # codes that both list the same window), keeping the highest amount.
        # Distinct windows — and an evergreen tier vs a dated one — all survive.
        rips_raw = _lookup_rips(rec)
        by_win: dict = {}
        for t in rips_raw:
            wk = (t["qty"], (t["unit"] or "").lower(),
                  _iso(t.get("from_date")), _iso(t.get("to_date")))
            cur = by_win.get(wk)
            if cur is None or float(t["amount"]) > float(cur["amount"]):
                by_win[wk] = t
        rips = []
        for t in by_win.values():
            is_bottle = _is_bottle_unit(t["unit"])
            rip_per_case_v = round(_rip_per_case(t["amount"], t["qty"], t["unit"], uq), 2)
            # Case-equivalent of the RIP qty so we can look up the best stackable
            # discount. For a case RIP that's t.qty cases; for a bottle RIP it's
            # t.qty / pack cases (whole-pack purchase).
            if is_bottle:
                eq_cases = (float(t["qty"]) / uq) if uq > 0 else 0.0
            else:
                eq_cases = float(t["qty"])
            disc_at_qty = best_disc_at(disc, eq_cases, uq)
            combined_save = round(rip_per_case_v + disc_at_qty, 2)
            up_price = float(rec.get("frontline_unit_price") or 0)
            bundle_cost = _rip_bundle_cost(t["qty"], t["unit"], cp, up_price)
            rips.append({
                "source": "rip",
                "qty": t["qty"],
                "unit": t["unit"],
                "amount": t["amount"],
                "save_per_case": combined_save,
                "rip_only_save_per_case": rip_per_case_v,
                "stacked_disc_per_case": disc_at_qty,
                "price_after": round(cp - combined_save, 2) if cp > 0 else None,
                "btl_price_after": _btl_after(round(cp - combined_save, 2) if cp > 0 else None, uq),
                "save_per_bottle": round(combined_save / uq, 2) if uq > 0 else None,
                "roi_pct": round(combined_save / cp * 100, 2) if cp > 0 else 0.0,
                "rip_only_roi_pct": round(t["amount"] / bundle_cost * 100, 2) if bundle_cost > 0 else 0.0,
                "description": t.get("description"),
                # RIP-source-row's window classification (carried through from
                # the source-row scan above). True = this RIP code's validity
                # is partial-month, so derive.py excluded it from best_rip_amt
                # / effective_case_price. The buyer still sees it in the
                # ladder, distinctly rendered.
                "is_time_sensitive": bool(t.get("is_time_sensitive", False)),
                # Validity window + status relative to ref_date, so the UI can
                # badge Active now / Starts DD MMM / Expires in N days.
                "from_date": t.get("from_date"),
                "to_date": t.get("to_date"),
                "window_status": t.get("window_status"),
                "days_to_expire": t.get("days_to_expire"),
            })
        # qty first, then by window start so a qty's earliest window leads and
        # its later ("next RIP date") window follows directly beneath it.
        rips.sort(key=lambda x: (x["qty"], str(x.get("from_date") or "")))
        rec["tiers"] = disc + rips

        # Deal gaps: days where NO dated deal is active — gaps in the UNION of
        # this product's RIP windows AND its partial-QD windows. A RIP gap that's
        # covered by a partial QD (e.g. Remy: RIP Jun 1-8/11-30 + QD Jun 9-10) is
        # NOT a trap, so it must not be flagged. Only true no-deal runs warn.
        _gk = (rec["wholesaler"], rec["edition"], str(rec.get("upc") or "").lstrip("0"))
        _wins = list(rip_wins.get(_gk, []))
        # Full dated-deal timeline (ALL windows, not the deduped tiers) for the
        # clickable timing popover. RIP windows share the best-RIP price; partial
        # QD windows use their own best_case_price.
        deal_windows = []
        seen_w = set()
        _rip_best = min((t for t in rips if t.get("price_after") is not None),
                        key=lambda t: t["price_after"], default=None)
        rip_price = _rip_best["price_after"] if _rip_best else None
        for (wf, wt) in rip_wins.get(_gk, []):
            k = ("RIP", wf, wt)
            if k in seen_w:
                continue
            seen_w.add(k)
            deal_windows.append({"kind": "RIP", "from": wf.isoformat(), "to": wt.isoformat(),
                                 "qty": _rip_best["qty"] if _rip_best else None,
                                 "unit": _rip_best["unit"] if _rip_best else None,
                                 "eff": rip_price,
                                 "save": round(cp - rip_price, 2) if (rip_price is not None and cp) else None})
        for pr in part_rows.get(_gk, []):
            try:
                _fcp = float(pr["fcp"]); _bcp = float(pr["bcp"])
            except (TypeError, ValueError, KeyError):
                _fcp = _bcp = None
            if _fcp is not None and _bcp is not None and _bcp < _fcp - 0.005:
                pf, pt = _to_date(pr["from_date"]), _to_date(pr["to_date"])
                if pf and pt:
                    _wins.append((pf, pt))
                    k = ("QD", pf, pt)
                    if k not in seen_w:
                        seen_w.add(k)
                        # Best discount tier on this sub-month row → its qty/unit.
                        _bq, _ba, _bu = None, 0.0, "Cases"
                        for _j in range(1, 6):
                            _a = pr.get(f"d{_j}a")
                            if _a is None or (isinstance(_a, float) and math.isnan(_a)) or _a <= 0:
                                continue
                            _mm = re.match(r"^\s*(\d+(?:\.\d+)?)\s*(.*)$", str(pr.get(f"d{_j}q") or ""))
                            if _mm and float(_a) > _ba:
                                _ba = float(_a); _bq = int(float(_mm.group(1)))
                                _bu = "Bottles" if _norm_unit(_mm.group(2) or "") == "bottle" else "Cases"
                        deal_windows.append({"kind": "QD", "from": pf.isoformat(), "to": pt.isoformat(),
                                             "qty": _bq, "unit": _bu,
                                             "eff": round(_bcp, 2), "save": round(_fcp - _bcp, 2)})
        deal_windows.sort(key=lambda x: x["from"])
        rec["deal_windows"] = deal_windows
        rec["rip_gaps"] = _gaps_from_windows(_wins, eastern_today())

        # Reconcile inline DISCOUNT tiers with the AUTHORITATIVE raw-cpl windows.
        # The enriched cache can mark a discount evergreen even though the raw cpl
        # only has that qty in a PARTIAL window (dedup bug → prod Remy "Buy 10"
        # showed no partial flag while the header timing badge did). If a qty has
        # a partial QD window AND is NOT in any full-calendar-month raw row, stamp
        # the partial window onto the tier so the inline flag matches the truth.
        _uk = str(rec.get("upc") or "").lstrip("0")
        _fq = full_qty.get((rec["wholesaler"], rec["edition"], _uk), set())
        _qdw = {int(w["qty"]): w for w in deal_windows
                if w.get("kind") == "QD" and w.get("qty") is not None}
        if _qdw:
            for t in rec["tiers"]:
                if t.get("source") != "discount" or t.get("is_time_sensitive"):
                    continue
                try:
                    tq = int(t.get("qty"))
                except (TypeError, ValueError):
                    continue
                w = _qdw.get(tq)
                if w and tq not in _fq:
                    ws_ = window_status(w["from"], w["to"], ref_date)
                    t["is_time_sensitive"] = True
                    t["from_date"] = w["from"]
                    t["to_date"] = w["to"]
                    t["window_status"] = ws_["status"]
                    t["days_to_expire"] = ws_["days_to_expire"]


# ---------------------------------------------------------------------------
# attach_live_rip: date-aware "live now" RIP overlay.
# ---------------------------------------------------------------------------

def _num(v) -> Optional[float]:
    """Coerce a possibly-NaN / string cell to float, or None."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if f != f else f


def _split_rip_codes(rc) -> list[str]:
    """Split a RIP-code cell ('10604 120001') into clean codes. Module-level
    twin of the splitter inside attach_tiers so attach_live_rip stays in sync."""
    if rc is None:
        return []
    s = str(rc).strip()
    if not s or s in ("None", "nan", "0"):
        return []
    out, seen = [], set()
    for part in s.split():
        p = part.strip()
        if not p or p in ("0", "None", "nan") or p in seen:
            continue
        seen.add(p)
        out.append(p)
    return out


# JSON schema for the rip_windows column (a JSON-array string; see derive.py).
# Parsed back to a list<struct> with from_json at query time.
_RIP_WINDOWS_JSON_SCHEMA = '[{"from_date":"VARCHAR","to_date":"VARCHAR","amt":"DOUBLE"}]'


def live_rip_amt_sql(windows_col: str, ref_sql: str) -> str:
    """SQL snippet: best per-case RIP rebate ACTIVE on the reference date.

    Reads the precomputed ``rip_windows`` column (derive.py) — a JSON-array
    STRING of {from_date, to_date, amt}, dates as ISO 'YYYY-MM-DD' strings
    (lexical compare == date compare). Stored as text so it round-trips through
    Postgres; parsed here with from_json. ``ref_sql`` is a string-typed SQL
    expression holding the reference date. Null window bounds = open-ended."""
    parsed = f"from_json({windows_col}, '{_RIP_WINDOWS_JSON_SCHEMA}')"
    return (
        f"COALESCE(list_max(list_transform(list_filter({parsed}, "
        f"w -> (w.from_date IS NULL OR {ref_sql} >= w.from_date) "
        f"AND (w.to_date IS NULL OR {ref_sql} <= w.to_date)), w -> w.amt)), 0)"
    )


def live_effective_sql(
    ref_sql: str,
    windows_col: str = "rip_windows",
    eff_col: str = "effective_case_price",
    rip_sav_col: str = "rip_savings",
) -> str:
    """SQL snippet for the date-aware 'live now' effective case price.

    base = month effective price + the full-window RIP already baked into it
    (``effective_case_price + rip_savings``); subtract the best rebate active on
    the reference date; floor at 0 and cap at the month price (the live price is
    never higher than what you'd pay anyway). Python mirror: ``attach_live_rip``.
    """
    amt = live_rip_amt_sql(windows_col, ref_sql)
    base = f"(COALESCE({eff_col}, 0) + COALESCE({rip_sav_col}, 0))"
    return f"LEAST({eff_col}, GREATEST(ROUND({base} - ({amt}), 2), 0))"


def _best_active_window_amt(rip_windows, ref: str) -> float:
    """Python mirror of live_rip_amt_sql: max amt over windows containing ref.

    ``rip_windows`` is the JSON-array string from the column (or already a
    parsed list/None, for robustness)."""
    if rip_windows is None:
        return 0.0
    if isinstance(rip_windows, str):
        s = rip_windows.strip()
        if not s or s == "[]":
            return 0.0
        try:
            rip_windows = json.loads(s)
        except (ValueError, TypeError):
            return 0.0
    best = 0.0
    for w in rip_windows:
        if not isinstance(w, dict):
            continue
        f = w.get("from_date")
        t = w.get("to_date")
        a = _num(w.get("amt")) or 0.0
        if (f is None or ref >= f) and (t is None or ref <= t) and a > best:
            best = a
    return best


def attach_live_rip(con, records, ref_date=None) -> None:
    """Overlay a DATE-AWARE 'live now' RIP price on each record.

    The precomputed ``effective_case_price`` bakes in only WHOLE-MONTH RIPs.
    This reads the record's precomputed ``rip_windows`` list (derive.py), picks
    the best rebate ACTIVE on ``ref_date`` (default today ET), and stamps:

      - live_rip_amt              best per-case RIP rebate active on ref_date
      - live_effective_case_price month price minus the EXTRA active rebate
      - live_better_than_month    True when the live price beats the month price

    Python mirror of ``live_effective_sql`` (the catalog grid computes the same
    value in SQL so it can SORT by it). The single source of windows is the
    ``rip_windows`` column; no query to the rip table. ``con`` is accepted for
    signature compatibility but unused. No-op on an empty list.
    """
    if not records:
        return
    ref = _iso(ref_date) or eastern_today().isoformat()
    for rec in records:
        # rip_windows is an internal precomputed column (a list of structs). Read
        # it, then drop it so it never reaches the JSON response (FastAPI can't
        # encode the numpy struct array, and the payload would be heavy anyway).
        wins = rec.pop("rip_windows", None)
        eff = _num(rec.get("effective_case_price"))
        if eff is None:
            rec["live_rip_amt"] = None
            rec["live_effective_case_price"] = None
            rec["live_better_than_month"] = False
            continue
        best = _best_active_window_amt(wins, ref)
        month_rip = _num(rec.get("rip_savings")) or 0.0
        base = eff + month_rip
        live = min(eff, max(0.0, round(base - best, 2)))
        rec["live_rip_amt"] = round(best, 2) if best > 0 else None
        rec["live_effective_case_price"] = live
        rec["live_better_than_month"] = live < eff - 0.005


# ---------------------------------------------------------------------------
# attach_next_month_prices — verbatim move from catalog.py
# ---------------------------------------------------------------------------

def attach_next_month_prices(con, src, records) -> None:
    """Annotate each record with next-month price + a 'Better Price' verdict.

    Looks up the same UPCs in next month's edition and sets next_case_price,
    next_effective_case_price, and better_month (Same / This Month / Next Month).
    Shared by /search and /new-items so both render the 'Better Price' column
    identically. No-op on an empty list."""
    if not records:
        return
    next_ym = next_yyyy_mm()
    upcs = sorted({str(r["upc"]) for r in records if r.get("upc")})
    if not upcs:
        return
    upc_ph = ", ".join(f"$u{i}" for i in range(len(upcs)))
    up_params = {f"u{i}": u for i, u in enumerate(upcs)}
    next_df = con.execute(f"""
        SELECT wholesaler, edition, upc, product_name, unit_volume, unit_qty, vintage,
               frontline_case_price AS next_case_price,
               effective_case_price AS next_effective_case_price
        FROM {src}
        WHERE edition = $next_ym
          AND upc IN ({upc_ph})
    """, {**up_params, "next_ym": next_ym}).fetchdf()
    # Key on (wholesaler, upc, product_name, unit_volume, unit_qty,
    # vintage_norm). A single UPC is reused in the source data for:
    #   - distinct products entirely (Allied has one UPC mapped to both
    #     MACALLAN DBL CSK 12Y and MACALLAN LUNAR20 4P),
    #   - the same wine across different vintages (2019 vs 2020),
    #   - the same product in different pack sizes (DE TOREN FUSION V
    #     UPC 816053000375 ships as a 12-pack 2019 AND a 6-pack 2020 in
    #     the same edition - different unit_qty, different SKU).
    # Without unit_qty in the key, a 12-pack May listing silently picks
    # up the 6-pack June price and the row's better_month + next-eff
    # sparkline land on a completely different SKU.
    next_map = {}
    for _, nr in next_df.iterrows():
        k = (
            nr["wholesaler"],
            str(nr["upc"]),
            nr.get("product_name") or "",
            nr.get("unit_volume") or "",
            uq_key(nr.get("unit_qty")),
            norm_vintage(nr.get("vintage")),
        )
        next_map[k] = nr
    for rec in records:
        key = (
            rec["wholesaler"],
            str(rec.get("upc") or ""),
            rec.get("product_name") or "",
            rec.get("unit_volume") or "",
            uq_key(rec.get("unit_qty")),
            norm_vintage(rec.get("vintage")),
        )
        nr = next_map.get(key)
        curr_eff = rec.get("effective_case_price")
        curr_front = rec.get("frontline_case_price")
        if nr is None:
            rec["next_case_price"] = None
            rec["next_effective_case_price"] = None
            rec["better_month"] = "Same" if curr_front else None
            continue
        n_eff = float(nr["next_effective_case_price"]) if not (
            isinstance(nr["next_effective_case_price"], float) and math.isnan(nr["next_effective_case_price"])
        ) else None
        n_front = float(nr["next_case_price"]) if not (
            isinstance(nr["next_case_price"], float) and math.isnan(nr["next_case_price"])
        ) else None
        rec["next_case_price"] = n_front
        rec["next_effective_case_price"] = n_eff
        a = curr_eff if curr_eff is not None else curr_front
        b = n_eff if n_eff is not None else n_front
        if a is None or b is None:
            rec["better_month"] = "Same"
        elif abs(a - b) < 0.005:
            rec["better_month"] = "Same"
        elif a < b:
            rec["better_month"] = "This Month"
        else:
            rec["better_month"] = "Next Month"


# ---------------------------------------------------------------------------
# attach_next_tiers — verbatim move from catalog.py
# ---------------------------------------------------------------------------

def attach_next_tiers(con, records) -> None:
    """Attach a ``next_tiers`` list per record: the same shape as ``tiers``
    but computed against the SAME UPC in next month's edition."""
    if not records:
        return
    next_ym = next_yyyy_mm()
    upcs = sorted({str(r["upc"]) for r in records if r.get("upc")})
    if not upcs:
        for r in records:
            r["next_tiers"] = []
        return
    src = read_parquet(con, "cpl_enriched")
    upc_ph = ", ".join(f"$u{i}" for i in range(len(upcs)))
    up_params = {f"u{i}": u for i, u in enumerate(upcs)}
    try:
        df = con.execute(f"""
            SELECT wholesaler, edition, upc, product_name, unit_volume, unit_qty, vintage,
                   frontline_case_price, frontline_unit_price,
                   discount_1_qty, discount_1_amt, discount_2_qty, discount_2_amt,
                   discount_3_qty, discount_3_amt, discount_4_qty, discount_4_amt,
                   discount_5_qty, discount_5_amt,
                   rip_code
            FROM {src}
            WHERE edition = $next_ym AND upc IN ({upc_ph})
        """, {**up_params, "next_ym": next_ym}).fetchdf()
    except Exception:
        for r in records:
            r["next_tiers"] = []
        return

    next_rows: list[dict] = []
    by_full: dict = {}
    by_name: dict = {}
    by_upc: dict = {}
    for _, nr in df.iterrows():
        d = dict(nr)
        next_rows.append(d)
        ws = d.get("wholesaler"); upc = str(d.get("upc") or "")
        nm = d.get("product_name") or ""; vol = d.get("unit_volume") or ""
        uq = uq_key(d.get("unit_qty"))
        vn = norm_vintage(d.get("vintage"))
        by_full[(ws, upc, nm, vol, uq, vn)] = d
        by_full.setdefault((ws, upc, nm, vol, uq), d)
        by_full.setdefault((ws, upc, nm, vol), d)
        by_full.setdefault((ws, upc, nm), d)
        by_name[(ws, nm, vol, uq, vn)] = d
        by_name.setdefault((ws, nm, vol, uq), d)
        by_name.setdefault((ws, nm, vol), d)
        by_name.setdefault((ws, nm), d)
        by_upc[(ws, upc, vol, uq, vn)] = d
        by_upc.setdefault((ws, upc, vol, uq), d)
        by_upc.setdefault((ws, upc, vol), d)
        by_upc.setdefault((ws, upc), d)

    # Reuse attach_tiers on the next-edition dicts; it sets
    # next_rows[i]["tiers"] in place using next-edition rip_code/edition.
    if next_rows:
        attach_tiers(con, next_rows)

    for rec in records:
        ws = rec.get("wholesaler"); upc = str(rec.get("upc") or "")
        nm = rec.get("product_name") or ""; vol = rec.get("unit_volume") or ""
        uq = uq_key(rec.get("unit_qty"))
        vn = norm_vintage(rec.get("vintage"))
        match = (by_full.get((ws, upc, nm, vol, uq, vn)) or by_full.get((ws, upc, nm, vol, uq))
                 or by_full.get((ws, upc, nm, vol)) or by_full.get((ws, upc, nm))
                 or by_name.get((ws, nm, vol, uq, vn)) or by_name.get((ws, nm, vol, uq))
                 or by_name.get((ws, nm, vol)) or by_name.get((ws, nm))
                 or by_upc.get((ws, upc, vol, uq, vn)) or by_upc.get((ws, upc, vol, uq))
                 or by_upc.get((ws, upc, vol))
                 or by_upc.get((ws, upc)))
        rec["next_tiers"] = match.get("tiers", []) if match else []


def attach_price_3mo(con, records) -> None:
    """Attach ``price_3mo`` to each record: an ordered (oldest->newest) list of
    up to 3 month-blocks for the last 3 EXISTING editions of the same SKU. Each
    block is::

        {edition, frontline, disc1_price, rip_price, tiers}

    where ``rip_price`` is that edition's ``effective_case_price`` (best RIP
    applied) and ``disc1_price`` is the case price after the best 1-case CPL
    discount with NO RIP (``frontline - best_disc_at(disc_tiers, 1, pack)``).
    Powers the two-line 3-month sparkline + its popover. NEVER invents a future
    month: only editions that exist are returned (1-3 blocks). No-op on []."""
    if not records:
        return
    upcs = sorted({str(r["upc"]) for r in records if r.get("upc")})
    if not upcs:
        for r in records:
            r["price_3mo"] = []
        return
    src = read_parquet(con, "cpl_enriched")
    cym = current_yyyy_mm()
    upc_ph = ", ".join(f"$u{i}" for i in range(len(upcs)))
    params = {f"u{i}": u for i, u in enumerate(upcs)}
    params["cym"] = cym
    try:
        df = con.execute(f"""
            WITH eds AS (
                SELECT wholesaler, edition,
                       ROW_NUMBER() OVER (PARTITION BY wholesaler ORDER BY edition DESC) AS rn
                FROM (SELECT DISTINCT wholesaler, edition FROM {src} WHERE edition <= $cym)
            )
            SELECT c.wholesaler, c.edition, c.upc, c.product_name, c.unit_volume, c.unit_qty, c.vintage,
                   c.frontline_case_price, c.frontline_unit_price, c.effective_case_price,
                   c.discount_1_qty, c.discount_1_amt, c.discount_2_qty, c.discount_2_amt,
                   c.discount_3_qty, c.discount_3_amt, c.discount_4_qty, c.discount_4_amt,
                   c.discount_5_qty, c.discount_5_amt, c.rip_code
            FROM {src} c
            JOIN eds ON c.wholesaler = eds.wholesaler AND c.edition = eds.edition AND eds.rn <= 3
            WHERE c.upc IN ({upc_ph})
        """, params).fetchdf()
    except Exception:
        for r in records:
            r["price_3mo"] = []
        return

    rows = [dict(nr) for _, nr in df.iterrows()]
    if rows:
        attach_tiers(con, rows)   # each edition row gets its own tier ladder

    # Group blocks by the full SKU identity, then index looser keys to it so a
    # record matches even when only name/upc/size are known (mirror of
    # attach_next_tiers' fallback chain).
    from collections import defaultdict
    groups: dict = defaultdict(list)
    for d in rows:
        ws = d.get("wholesaler"); upc = str(d.get("upc") or "")
        nm = d.get("product_name") or ""; vol = d.get("unit_volume") or ""
        uq = uq_key(d.get("unit_qty")); vn = norm_vintage(d.get("vintage"))
        pack = _num(d.get("unit_qty")) or 1.0
        front = _num(d.get("frontline_case_price"))
        disc_tiers = [t for t in (d.get("tiers") or []) if t.get("source") == "discount"]
        disc1 = best_disc_at(disc_tiers, 1.0, pack) if (front and disc_tiers) else 0.0
        groups[(ws, upc, nm, vol, uq, vn)].append({
            "edition": d.get("edition"),
            "frontline": front,
            "disc1_price": round(front - disc1, 2) if front is not None else None,
            "rip_price": _num(d.get("effective_case_price")),
            "tiers": d.get("tiers") or [],
        })

    def _keys(ws, upc, nm, vol, uq, vn):
        return [(ws, upc, nm, vol, uq, vn), (ws, upc, nm, vol, uq), (ws, upc, nm, vol),
                (ws, upc, nm), (ws, nm, vol, uq, vn), (ws, nm, vol, uq), (ws, nm, vol),
                (ws, nm), (ws, upc, vol, uq, vn), (ws, upc, vol, uq), (ws, upc, vol), (ws, upc)]

    index: dict = {}
    for full in groups:
        for k in _keys(*full):
            index.setdefault(k, full)

    for rec in records:
        ws = rec.get("wholesaler"); upc = str(rec.get("upc") or "")
        nm = rec.get("product_name") or ""; vol = rec.get("unit_volume") or ""
        uq = uq_key(rec.get("unit_qty")); vn = norm_vintage(rec.get("vintage"))
        blocks = []
        for k in _keys(ws, upc, nm, vol, uq, vn):
            full = index.get(k)
            if full:
                blocks = groups[full]
                break
        # Oldest -> newest, so the sparkline plots left (older) to right (newer).
        rec["price_3mo"] = sorted(blocks, key=lambda b: b.get("edition") or "")


# ---------------------------------------------------------------------------
# rank_best_deals — NEW. The single canonical "best deal" ranker.
#
# Replaces the ad-hoc rankings inside `_t_best_gp_deals`, `_t_find_deals`,
# and `_t_closeouts`. Every caller passes a `kind` selecting one of the
# documented rankings; nothing invents its own ORDER BY.
#
# Stocking-deal floor (`min_effective_pct_of_frontline`): the bug that
# crowned Beronia Rose #1 was a 100%-off free-with-purchase row dominating
# a `(frontline - effective) / frontline DESC` sort. Free-case rebates are
# valid data — they belong on the modal — they just shouldn't be ranked as
# "the best deal in the catalog". The floor filters those out.
# ---------------------------------------------------------------------------

_RANK_BASE_COLS = (
    "c.product_name, c.wholesaler, c.upc, c.unit_volume, c.unit_qty, c.vintage, "
    "c.frontline_case_price, c.effective_case_price, c.total_savings_per_case, "
    "c.has_discount, c.has_rip, c.has_closeout"
)


def rank_best_deals(
    con,
    kind: str,
    *,
    min_effective_pct_of_frontline: Optional[float] = None,
    category: Optional[str] = None,
    distributor: Optional[str] = None,
    limit: int = 25,
    as_of: Optional[str] = None,
) -> list[dict]:
    """Return the top-N best-deal rows for ONE consistent ranking definition.

    Args:
        kind: one of
          - 'gp_pct'         — biggest discount as % of list price
          - 'savings'        — biggest absolute $/case savings (CPL + RIP)
          - 'closeout'       — last-chance buys, ranked by savings
          - 'time_sensitive' — dated promos still active, ranked by expiry
        min_effective_pct_of_frontline: If set (e.g. 0.10), the WHERE clause
          also enforces `effective_case_price >= frontline_case_price * x`.
          This is the stocking-deal floor — a 100%-off liquidation row gets
          filtered out so the ranker doesn't crown it the "best deal". Pass
          None (or 0) to include those rows.
        category: optional product_type filter (case-insensitive).
        distributor: optional wholesaler filter (case-insensitive).
        limit: row cap, default 25, hard ceiling 100.

    Returns:
        list of dicts (canonical column shape). NEVER raises on data
        anomalies — returns [] on query failure so the chat surface stays
        responsive.
    """
    # Data-analysis tool: no artificial ranking ceiling (was 100). Only a
    # browser-safety backstop so a huge result set can't freeze a chat bubble.
    cap = min(max(int(limit), 1), 5000)
    cym = current_yyyy_mm()
    where = []
    params: list = [cym]
    order_by = ""

    if kind == "gp_pct":
        where += [
            "c.frontline_case_price IS NOT NULL",
            "c.frontline_case_price > 0",
            "c.effective_case_price IS NOT NULL",
            "c.effective_case_price < c.frontline_case_price",
        ]
        order_by = (
            "(c.frontline_case_price - c.effective_case_price) / c.frontline_case_price DESC, "
            "c.total_savings_per_case DESC NULLS LAST"
        )
    elif kind == "savings":
        where += [
            "c.has_discount = true",
            "c.total_savings_per_case IS NOT NULL",
            "c.total_savings_per_case > 0",
        ]
        order_by = "c.total_savings_per_case DESC NULLS LAST"
    elif kind == "closeout":
        where += ["c.has_closeout = true"]
        order_by = "c.total_savings_per_case DESC NULLS LAST"
    elif kind == "time_sensitive":
        # Dated promos still active on the reference date (default: today). We
        # don't apply the partial-month rule here (that's the deals router's
        # specialty for the page) - just "to_date on/after the reference date,
        # ordered by expiry". `as_of` lets a caller ask "active on date X".
        ref_expr = "CAST(? AS DATE)" if as_of else "CURRENT_DATE"
        where += [
            "c.to_date IS NOT NULL",
            f"CAST(c.to_date AS DATE) >= {ref_expr}",
        ]
        if as_of:
            params.append(as_of)
        order_by = (
            "CAST(c.to_date AS DATE) ASC, c.total_savings_per_case DESC NULLS LAST"
        )
    else:
        raise ValueError(
            f"rank_best_deals: unknown kind {kind!r}. "
            "Allowed: gp_pct | savings | closeout | time_sensitive"
        )

    if min_effective_pct_of_frontline is not None and min_effective_pct_of_frontline > 0:
        where.append(
            "c.effective_case_price >= c.frontline_case_price * ?"
        )
        params.append(float(min_effective_pct_of_frontline))

    if category:
        where.append("UPPER(c.product_type) = UPPER(?)")
        params.append(category)
    if distributor:
        where.append("LOWER(c.wholesaler) = LOWER(?)")
        params.append(distributor)

    extra = ""
    if kind == "time_sensitive":
        # Surface the expiry date so callers can format "ends YYYY-MM-DD".
        extra = ", CAST(c.to_date AS VARCHAR) AS ends"
    elif kind == "gp_pct":
        # Surface gp_pct so the chat doesn't have to recompute it.
        extra = (
            ", ROUND((c.frontline_case_price - c.effective_case_price) "
            "/ c.frontline_case_price * 100, 1) AS gp_pct"
        )
    elif kind == "closeout":
        extra = ", CAST(c.to_date AS VARCHAR) AS ends"

    sql = f"""
        WITH cur AS (
            SELECT wholesaler, MAX(edition) AS ed
            FROM cpl_enriched
            WHERE edition <= ?
            GROUP BY wholesaler
        )
        SELECT {_RANK_BASE_COLS}{extra}
        FROM cpl_enriched c
        JOIN cur ON c.wholesaler = cur.wholesaler AND c.edition = cur.ed
        WHERE {' AND '.join(where)}
        ORDER BY {order_by}
        LIMIT {cap}
    """
    try:
        return con.execute(sql, params).fetchdf().to_dict(orient="records")
    except Exception:
        return []
