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

import math
import re
from datetime import date
from typing import Optional

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

def current_yyyy_mm() -> str:
    """Edition string for today's month (e.g. '2026-05')."""
    t = date.today()
    return f"{t.year:04d}-{t.month:02d}"


def next_yyyy_mm() -> str:
    """Edition string for next month (e.g. '2026-06')."""
    t = date.today()
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

def attach_tiers(con, records) -> None:
    """Attach a ``tiers`` list (CPL discount tiers + stacked RIP tiers) to each
    record, mirroring what the catalog table renders as expandable sub-rows.
    Shared by /search (include_tiers), /new-items, the product modal, and the
    product-breakdown chart. No-op on an empty list.

    Each record needs at minimum: wholesaler, edition, upc, unit_qty,
    frontline_case_price, frontline_unit_price, discount_{1..5}_qty/amt, and
    optionally rip_code / rip_group_code.

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
    keys = []
    for rec in records:
        for fld in ("rip_code", "rip_group_code"):
            for code in _split_codes(rec.get(fld)):
                keys.append((code, rec["wholesaler"], rec["edition"]))
    uniq_codes = sorted({k[0] for k in keys})
    uniq_ws = sorted({k[1] for k in keys})
    uniq_ed = sorted({k[2] for k in keys})
    rip_full: dict = {}    # (code, ws, ed, upc) -> [tiers]
    rip_by_code: dict = {} # (code, ws, ed)    -> [tiers]  (fallback)
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
                })
            if not tiers_here:
                continue
            code_key = (str(r["rip_code"]), r["wholesaler"], r["edition"])
            rip_by_code.setdefault(code_key, []).extend(tiers_here)
            upc_key = (*code_key, str(r.get("upc") or ""))
            rip_full.setdefault(upc_key, []).extend(tiers_here)

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
        # Aggregate tiers across ALL matched codes (rather than returning the
        # first match) — derive.py takes MAX across codes for the precomputed
        # best_rip_amt, and the modal/popover should show every tier the buyer
        # could actually clear. Per-tier de-dup happens downstream.
        out: list[dict] = []
        ws, ed = rec["wholesaler"], rec["edition"]
        upc = str(rec.get("upc") or "")
        for rc in candidates:
            upc_key = (rc, ws, ed, upc)
            if upc_key in rip_full:
                out.extend(rip_full[upc_key])
                continue   # prefer per-UPC over code-level for the same code
            code_key = (rc, ws, ed)
            tiers = rip_by_code.get(code_key, [])
            if tiers:
                out.extend(tiers)
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
            })

        # RIP tiers (dedup by qty+unit+amount). RIPs STACK with the applicable
        # case discount (case-unit RIP) or with whatever case-equivalent
        # discount the bottle-unit RIP threshold also clears - buying 60 btl
        # at pack 12 means you've also bought 5 cs, so a 5cs-threshold case
        # discount applies on top of the bottle RIP.
        rips_raw = _lookup_rips(rec)
        seen = set()
        rips = []
        for t in rips_raw:
            sig = (t["qty"], t["unit"].lower(), round(t["amount"], 2))
            if sig in seen:
                continue
            seen.add(sig)
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
            })
        rips.sort(key=lambda x: x["qty"])
        rec["tiers"] = disc + rips


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
    cap = min(max(int(limit), 1), 100)
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
        # Dated promos still active. We don't apply the partial-month rule
        # here (that's the deals router's specialty for the page) - just
        # "has a to_date in the future, ordered by expiry".
        where += [
            "c.to_date IS NOT NULL",
            "CAST(c.to_date AS DATE) >= CURRENT_DATE",
        ]
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
