"""
Agentic QA engine — deterministic variance scanner with root-cause drill-in.

Scans the NJ ABC price data (``cpl_enriched``) for price variance above a
threshold and AUTONOMOUSLY classifies a probable root cause for each finding,
with supporting evidence and a suggested fix. No LLM calls — pure SQL + rules.

Three detectors:
  (a) edition_price_moves  — month-over-month list/effective price moves per SKU
  (b) cross_distributor_gaps — same UPC priced very differently across distributors
  (c) calc_bugs            — impossible effective prices (derive.py join bug)

Each detector emits Findings (see ``run_scan`` docstring). The engine opens its
own DuckDB connection so it works identically from the API and the CLI.

IMPORTANT DuckDB caveat: correlated subqueries against read_parquet() do NOT
work, so values that depend on per-wholesaler state (the "current" edition) are
pre-computed in Python and passed as bind parameters.
"""

import math
from datetime import date, datetime
from typing import Optional

from backend.db import get_duckdb, read_parquet


# --- Module constants ------------------------------------------------------

VARIANCE_THRESHOLD = 0.05

# Product types that reuse a single UPC across vintages (a 2022 and a 2023
# bottling can share one UPC), so a raw price "jump" may just be a new vintage.
VINTAGE_SENSITIVE_TYPES = ("WINE", "SPARKLING", "VERMOUTH")

# Severity cut for a genuine, unexplained list-price move.
_GENUINE_HIGH_PCT = 0.25

ALL_CHECKS = ("edition_price_moves", "cross_distributor_gaps", "calc_bugs",
              "pack_size_mismatch", "vintage_placeholder_dupe")


# --- Reusable SQL snippet helpers ------------------------------------------

def normalized_upc_sql(col: str = "upc") -> str:
    """Leading-zero-stripped UPC, the cross-distributor match key."""
    return f"LTRIM({col}, '0')"


def vintage_norm_sql(col: str = "vintage") -> str:
    """Standardize a raw vintage to a 4-digit string or NULL.

    Copied verbatim (logic) from catalog._vintage_norm_sql: 4-digit kept;
    '2023.0' floats trimmed; 2-digit -> 20XX (<=30) else 19XX; 'NA'/'NV'/blank
    -> NULL (non-vintage).
    """
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


def valid_upc_sql(col: str = "upc") -> str:
    """Predicate (SQL boolean) for a usable, non-stub UPC.

    Valid = not null/''/'0', not all-zeros/nines/ones, not '999999%' prefix,
    LENGTH >= 8. Mirrors the stub-UPC filters used in catalog.
    """
    return (
        f"({col} IS NOT NULL AND {col} != '' AND {col} != '0' "
        f"AND NOT regexp_matches({col}, '^(0+|9+|1+)$') "
        f"AND NOT {col} LIKE '999999%' "
        f"AND LENGTH({col}) >= 8)"
    )


def is_vintage_sensitive_sql(col: str = "product_type") -> str:
    """SQL boolean: is this product_type one that reuses a UPC across vintages?"""
    types = ", ".join(f"'{t}'" for t in VINTAGE_SENSITIVE_TYPES)
    return f"UPPER({col}) IN ({types})"


# --- Helpers ---------------------------------------------------------------

def _clean(v):
    """Coerce a single value to a JSON-safe scalar (NaN/Timestamp -> None/str)."""
    if v is None:
        return None
    if isinstance(v, float) and math.isnan(v):
        return None
    if hasattr(v, "isoformat"):
        try:
            return v.isoformat()
        except Exception:
            return str(v)
    return v


def _clean_dict(d: dict) -> dict:
    return {k: _clean(v) for k, v in d.items()}


def _current_yyyy_mm() -> str:
    t = date.today()
    return f"{t.year:04d}-{t.month:02d}"


def _current_edition_map(con, src: str, wholesaler: Optional[str] = None) -> dict:
    """Pre-compute the "current" edition per wholesaler.

    Current = latest edition whose YYYY-MM is on-or-before today, else the max
    edition available. Done in a standalone query (NOT a correlated subquery)
    so the result can be passed back as bind params.
    """
    current_ym = _current_yyyy_mm()
    where = ""
    params = {"current_ym": current_ym}
    if wholesaler:
        where = "WHERE wholesaler = $ws"
        params["ws"] = wholesaler
    df = con.execute(f"""
        SELECT wholesaler,
               COALESCE(MAX(CASE WHEN edition <= $current_ym THEN edition END),
                        MAX(edition)) AS ed
        FROM {src}
        {where}
        GROUP BY wholesaler
    """, params).fetchdf()
    return dict(zip(df["wholesaler"], df["ed"]))


def _abs(x):
    try:
        return abs(float(x))
    except (TypeError, ValueError):
        return 0.0


# --- Detector (a): edition_price_moves -------------------------------------

def _detect_edition_price_moves(con, src, threshold, wholesaler, limit) -> list:
    """Month-over-month price moves per SKU, classified by drill-in."""
    params = {"threshold": float(threshold), "lim": int(limit)}
    ws_filter = ""
    if wholesaler:
        ws_filter = "AND wholesaler = $ws"
        params["ws"] = wholesaler

    # Partition by (wholesaler, normalized upc, unit_volume, numeric unit_qty)
    # and LAG to pull the previous edition's facts. Combo bundle rows are
    # excluded — the case price there is a bundle slot, not standalone retail.
    sql = f"""
        WITH ranked AS (
            SELECT
                wholesaler, edition, upc, product_name, product_type,
                unit_volume, unit_qty, vintage,
                frontline_case_price, effective_case_price, rip_savings,
                has_rip, has_discount,
                {valid_upc_sql('upc')} AS upc_valid,
                ({vintage_norm_sql('vintage')}) AS vintage_norm,
                LAG(frontline_case_price) OVER w AS prev_frontline,
                LAG(effective_case_price) OVER w AS prev_effective,
                LAG(({vintage_norm_sql('vintage')})) OVER w AS prev_vintage_norm,
                LAG(vintage) OVER w AS prev_vintage_raw,
                LAG(TRY_CAST(unit_qty AS DOUBLE)) OVER w AS prev_unit_qty_num,
                LAG(has_rip) OVER w AS prev_has_rip,
                LAG(has_discount) OVER w AS prev_has_discount,
                LAG(rip_savings) OVER w AS prev_rip_savings,
                LAG(edition) OVER w AS prev_edition
            FROM {src}
            WHERE (combo_code IS NULL OR combo_code = '' OR combo_code = '0')
              {ws_filter}
            WINDOW w AS (
                PARTITION BY wholesaler, {normalized_upc_sql('upc')},
                             unit_volume, TRY_CAST(unit_qty AS DOUBLE)
                ORDER BY edition
            )
        )
        SELECT *,
               (frontline_case_price - prev_frontline) AS front_delta,
               CASE WHEN prev_frontline > 0
                    THEN (frontline_case_price - prev_frontline) / prev_frontline
                    ELSE NULL END AS front_pct,
               CASE WHEN prev_effective > 0
                    THEN (effective_case_price - prev_effective) / prev_effective
                    ELSE NULL END AS eff_pct
        FROM ranked
        WHERE prev_frontline IS NOT NULL AND prev_frontline > 0
          AND ABS((frontline_case_price - prev_frontline) / prev_frontline) > $threshold
        ORDER BY ABS((frontline_case_price - prev_frontline) / prev_frontline) DESC
        LIMIT $lim
    """
    df = con.execute(sql, params).fetchdf()

    findings = []
    for _, r in df.iterrows():
        front_pct = _clean(r["front_pct"])
        eff_pct = _clean(r["eff_pct"])
        prev_front = _clean(r["prev_frontline"])
        curr_front = _clean(r["frontline_case_price"])
        prev_vin = _clean(r["prev_vintage_norm"])
        curr_vin = _clean(r["vintage_norm"])
        prev_qty = _clean(r["prev_unit_qty_num"])
        curr_qty = _clean(r["unit_qty"])
        upc_valid = bool(r["upc_valid"])
        is_vintage = str(r["product_type"] or "").upper() in VINTAGE_SENSITIVE_TYPES
        has_rip = _clean(r["has_rip"])
        prev_has_rip = _clean(r["prev_has_rip"])
        has_disc = _clean(r["has_discount"])
        prev_has_disc = _clean(r["prev_has_discount"])
        rip_sav = _clean(r["rip_savings"])
        prev_rip_sav = _clean(r["prev_rip_savings"])

        observed = _clean_dict({
            "prev_edition": r["prev_edition"],
            "curr_edition": r["edition"],
            "prev_frontline_case_price": prev_front,
            "curr_frontline_case_price": curr_front,
            "prev_effective_case_price": r["prev_effective"],
            "curr_effective_case_price": r["effective_case_price"],
        })

        # --- DRILL IN to classify root cause -----------------------------
        # Priority: invalid UPC > vintage swap > pack-size > promo > genuine.
        front_moved = front_pct is not None and abs(front_pct) > threshold
        eff_moved = eff_pct is not None and abs(eff_pct) > threshold
        promo_changed = (
            (has_rip is not None and prev_has_rip is not None and has_rip != prev_has_rip)
            or (has_disc is not None and prev_has_disc is not None and has_disc != prev_has_disc)
            or (_abs((rip_sav or 0) - (prev_rip_sav or 0)) > 0.01)
        )

        if not upc_valid:
            root_cause = "stub_or_invalid_upc"
            detail = (
                f"Price move sits on a placeholder/invalid UPC ('{_clean(r['upc'])}'), "
                "which the wholesaler reuses across products, so the move is unreliable."
            )
            fix = "Placeholder UPC; exclude from price tracking / fix source mapping."
            evidence = {"upc": _clean(r["upc"]), "upc_valid": False}
            severity = "low"
        elif is_vintage and prev_vin is not None and curr_vin is not None and prev_vin != curr_vin:
            root_cause = "vintage_change"
            detail = (
                f"Vintage-sensitive {r['product_type']}: vintage changed "
                f"{prev_vin} -> {curr_vin} under the same UPC, so this is a new "
                "product, not a list-price change."
            )
            fix = ("Different vintage under one UPC — treat as a distinct product; "
                   "key the timeline by UPC+vintage (already handled in "
                   "price-history/breakdown).")
            evidence = {"prev_vintage": prev_vin, "curr_vintage": curr_vin,
                        "prev_vintage_raw": _clean(r["prev_vintage_raw"]),
                        "curr_vintage_raw": _clean(r["vintage"])}
            severity = "medium"
        elif (prev_qty is not None and curr_qty is not None
              and _abs(prev_qty) != _abs(curr_qty)):
            root_cause = "pack_size_change"
            detail = (
                f"Case pack size changed from {prev_qty} to {curr_qty} units; the "
                "per-case price moved but the per-bottle price may not have."
            )
            fix = "Pack/case size changed; compare per-bottle, not per-case."
            evidence = {"prev_unit_qty": prev_qty, "curr_unit_qty": curr_qty}
            severity = "medium"
        elif (not front_moved) and (eff_moved or promo_changed):
            # Frontline barely moved but effective moved (or promo state flipped)
            root_cause = "promo_change"
            detail = (
                "List (frontline) price is effectively flat but the effective "
                "price moved due to a RIP/discount change."
            )
            fix = "Effective price moved due to a RIP/discount change, not list price."
            evidence = {
                "frontline_pct": round(front_pct, 4) if front_pct is not None else None,
                "effective_pct": round(eff_pct, 4) if eff_pct is not None else None,
                "prev_has_rip": prev_has_rip, "curr_has_rip": has_rip,
                "prev_has_discount": prev_has_disc, "curr_has_discount": has_disc,
                "prev_rip_savings": prev_rip_sav, "curr_rip_savings": rip_sav,
            }
            severity = "low"
        elif promo_changed and (front_pct is None or abs(front_pct) <= threshold):
            root_cause = "promo_change"
            detail = ("Effective price moved due to a RIP/discount change, not the "
                      "list price.")
            fix = "Effective price moved due to a RIP/discount change, not list price."
            evidence = {
                "prev_has_rip": prev_has_rip, "curr_has_rip": has_rip,
                "prev_has_discount": prev_has_disc, "curr_has_discount": has_disc,
                "prev_rip_savings": prev_rip_sav, "curr_rip_savings": rip_sav,
            }
            severity = "low"
        else:
            root_cause = "genuine_price_change"
            pct_abs = abs(front_pct) if front_pct is not None else 0.0
            severity = "high" if pct_abs > _GENUINE_HIGH_PCT else "medium"
            detail = (
                f"List price moved {front_pct * 100:+.1f}% "
                f"({prev_front} -> {curr_front}) with no structural explanation "
                "(same vintage, pack size, valid UPC, promo state)."
            )
            fix = ("No structural explanation; likely a real list-price change — "
                   "verify against source file.")
            evidence = {
                "frontline_pct": round(front_pct, 4) if front_pct is not None else None,
                "abs_front_delta": _clean(r["front_delta"]),
            }

        findings.append({
            "check": "edition_price_moves",
            "severity": severity,
            "wholesaler": _clean(r["wholesaler"]),
            "product_name": _clean(r["product_name"]),
            "upc": _clean(r["upc"]),
            "unit_volume": _clean(r["unit_volume"]),
            "vintage": curr_vin,
            "variance_pct": round(front_pct, 4) if front_pct is not None else None,
            "observed": observed,
            "root_cause": root_cause,
            "root_cause_detail": detail,
            "evidence": _clean_dict(evidence),
            "suggested_fix": fix,
        })
    return findings


# --- Detector (b): cross_distributor_gaps ----------------------------------

def _detect_cross_distributor_gaps(con, src, threshold, wholesaler, limit) -> list:
    """Same UPC priced very differently across two distributors (current ed)."""
    ed_map = _current_edition_map(con, src)
    # Restrict to a single wholesaler's pairs if asked.
    wholesalers = sorted(ed_map.keys())
    if wholesaler:
        if wholesaler not in ed_map:
            return []

    # Pre-compute ambiguous normalized-UPCs (one UPC -> >1 product within a
    # wholesaler+edition). Pass back as a temp set via a CTE per query instead.
    # We build one big UNION-free self-join across all current editions.
    # Edition-per-wholesaler is injected as bind params (pre-computed values).
    ed_pairs = []
    params = {"threshold": float(threshold), "lim": int(limit)}
    for i, ws in enumerate(wholesalers):
        params[f"ws_{i}"] = ws
        params[f"ed_{i}"] = ed_map[ws]
        ed_pairs.append(f"(wholesaler = $ws_{i} AND edition = $ed_{i})")
    current_filter = "(" + " OR ".join(ed_pairs) + ")"

    # Optional single-wholesaler restriction: at least one side must be it.
    side_filter = ""
    if wholesaler:
        params["focus_ws"] = wholesaler
        side_filter = "AND (a.wholesaler = $focus_ws OR b.wholesaler = $focus_ws)"

    sql = f"""
        WITH cur AS (
            SELECT
                wholesaler, edition, upc, product_name, product_type,
                unit_volume, unit_qty, vintage,
                effective_case_price, frontline_case_price,
                {normalized_upc_sql('upc')} AS upc_norm,
                ({vintage_norm_sql('vintage')}) AS vintage_norm,
                {is_vintage_sensitive_sql('product_type')} AS is_vintage
            FROM {src}
            WHERE {current_filter}
              AND {valid_upc_sql('upc')}
              AND (combo_code IS NULL OR combo_code = '' OR combo_code = '0')
              AND effective_case_price IS NOT NULL
        ),
        ambiguous AS (
            -- normalized UPC mapping to >1 distinct product within a
            -- wholesaler+edition -> unreliable key.
            SELECT wholesaler, upc_norm
            FROM cur
            GROUP BY wholesaler, upc_norm
            HAVING COUNT(DISTINCT product_name) > 1
        )
        SELECT
            a.wholesaler AS wholesaler_a, b.wholesaler AS wholesaler_b,
            a.edition AS edition_a, b.edition AS edition_b,
            a.upc_norm AS upc_norm, a.upc AS upc_a, b.upc AS upc_b,
            a.product_name AS product_name_a, b.product_name AS product_name_b,
            a.product_type AS product_type,
            a.unit_volume AS unit_volume_a, b.unit_volume AS unit_volume_b,
            a.unit_qty AS unit_qty_a, b.unit_qty AS unit_qty_b,
            a.vintage_norm AS vintage_a, b.vintage_norm AS vintage_b,
            a.is_vintage OR b.is_vintage AS is_vintage,
            a.effective_case_price AS eff_a, b.effective_case_price AS eff_b,
            (CASE WHEN amb_a.upc_norm IS NOT NULL OR amb_b.upc_norm IS NOT NULL
                  THEN TRUE ELSE FALSE END) AS is_ambiguous,
            (b.effective_case_price - a.effective_case_price) AS gap,
            CASE WHEN GREATEST(a.effective_case_price, b.effective_case_price) > 0
                 THEN (b.effective_case_price - a.effective_case_price)
                      / GREATEST(a.effective_case_price, b.effective_case_price)
                 ELSE 0 END AS gap_pct
        FROM cur a
        JOIN cur b
          ON a.upc_norm = b.upc_norm
         AND a.unit_volume IS NOT DISTINCT FROM b.unit_volume
         AND TRY_CAST(a.unit_qty AS DOUBLE) IS NOT DISTINCT FROM TRY_CAST(b.unit_qty AS DOUBLE)
         AND a.wholesaler < b.wholesaler
        LEFT JOIN ambiguous amb_a ON a.wholesaler = amb_a.wholesaler AND a.upc_norm = amb_a.upc_norm
        LEFT JOIN ambiguous amb_b ON b.wholesaler = amb_b.wholesaler AND b.upc_norm = amb_b.upc_norm
        WHERE ABS(CASE WHEN GREATEST(a.effective_case_price, b.effective_case_price) > 0
                       THEN (b.effective_case_price - a.effective_case_price)
                            / GREATEST(a.effective_case_price, b.effective_case_price)
                       ELSE 0 END) > $threshold
          {side_filter}
        ORDER BY ABS(CASE WHEN GREATEST(a.effective_case_price, b.effective_case_price) > 0
                          THEN (b.effective_case_price - a.effective_case_price)
                               / GREATEST(a.effective_case_price, b.effective_case_price)
                          ELSE 0 END) DESC
        LIMIT $lim
    """
    df = con.execute(sql, params).fetchdf()

    findings = []
    for _, r in df.iterrows():
        gap_pct = _clean(r["gap_pct"])
        is_vintage = bool(r["is_vintage"])
        vin_a = _clean(r["vintage_a"])
        vin_b = _clean(r["vintage_b"])
        is_ambiguous = bool(r["is_ambiguous"])
        qty_a = _clean(r["unit_qty_a"])
        qty_b = _clean(r["unit_qty_b"])
        vol_a = _clean(r["unit_volume_a"])
        vol_b = _clean(r["unit_volume_b"])

        observed = _clean_dict({
            "wholesaler_a": r["wholesaler_a"],
            "wholesaler_b": r["wholesaler_b"],
            "effective_case_price_a": r["eff_a"],
            "effective_case_price_b": r["eff_b"],
            "gap": r["gap"],
        })

        # --- DRILL IN -----------------------------------------------------
        # vintage mismatch is the highest-priority data issue (must NOT compare).
        vintage_diff = (vin_a is not None and vin_b is not None and vin_a != vin_b)
        if is_vintage and vintage_diff:
            root_cause = "vintage_mismatch"
            severity = "high"
            detail = (
                f"Same UPC but different vintage across distributors "
                f"({r['wholesaler_a']}={vin_a} vs {r['wholesaler_b']}={vin_b}) — "
                "these are different products and must not be compared."
            )
            fix = ("Same UPC, different vintage across distributors — exclude from "
                   "comparison; match on UPC+vintage.")
            evidence = {"vintage_a": vin_a, "vintage_b": vin_b,
                        "product_type": _clean(r["product_type"])}
        elif is_ambiguous:
            root_cause = "ambiguous_upc"
            severity = "high"
            detail = (
                "This normalized UPC maps to more than one distinct product within "
                "a distributor+edition, so the cross-distributor match is unreliable."
            )
            fix = ("UPC reused for multiple products; unreliable key — disambiguate "
                   "by name/size.")
            evidence = {
                "product_name_a": _clean(r["product_name_a"]),
                "product_name_b": _clean(r["product_name_b"]),
                "upc_a": _clean(r["upc_a"]), "upc_b": _clean(r["upc_b"]),
            }
        elif (qty_a is not None and qty_b is not None and _abs(qty_a) != _abs(qty_b)) \
                or (vol_a != vol_b):
            root_cause = "pack_or_volume_mismatch"
            severity = "medium"
            detail = (
                f"Comparing different pack/volume "
                f"(qty {qty_a} vs {qty_b}, volume {vol_a} vs {vol_b}); per-case "
                "prices are not comparable."
            )
            fix = "Comparing different pack/volume; normalize to per-bottle."
            evidence = {"unit_qty_a": qty_a, "unit_qty_b": qty_b,
                        "unit_volume_a": vol_a, "unit_volume_b": vol_b}
        else:
            root_cause = "genuine_arbitrage"
            severity = "low"
            detail = (
                f"Same product across distributors with a real "
                f"{abs(gap_pct) * 100:.1f}% effective-price difference — a buying "
                "opportunity, not a data issue."
            )
            fix = "Legit cross-distributor price difference — buying opportunity."
            evidence = {
                "cheaper": (r["wholesaler_a"] if _clean(r["eff_a"]) is not None
                            and _clean(r["eff_b"]) is not None
                            and r["eff_a"] < r["eff_b"] else r["wholesaler_b"]),
            }

        findings.append({
            "check": "cross_distributor_gaps",
            "severity": severity,
            "wholesaler": f"{_clean(r['wholesaler_a'])} vs {_clean(r['wholesaler_b'])}",
            "product_name": _clean(r["product_name_a"]),
            "upc": _clean(r["upc_a"]),
            "unit_volume": vol_a,
            "vintage": vin_a,
            "variance_pct": round(gap_pct, 4) if gap_pct is not None else None,
            "observed": observed,
            "root_cause": root_cause,
            "root_cause_detail": detail,
            "evidence": _clean_dict(evidence),
            "suggested_fix": fix,
        })
    return findings


# --- Detector (c): calc_bugs -----------------------------------------------

def _detect_calc_bugs(con, src, threshold, wholesaler, limit) -> list:
    """Impossible effective prices in the current edition (derive.py bug)."""
    ed_map = _current_edition_map(con, src, wholesaler)
    if not ed_map:
        return []
    params = {"lim": int(limit)}
    ed_pairs = []
    for i, (ws, ed) in enumerate(ed_map.items()):
        params[f"ws_{i}"] = ws
        params[f"ed_{i}"] = ed
        ed_pairs.append(f"(wholesaler = $ws_{i} AND edition = $ed_{i})")
    current_filter = "(" + " OR ".join(ed_pairs) + ")"

    sql = f"""
        SELECT
            wholesaler, edition, upc, product_name, product_type,
            unit_volume, unit_qty, vintage,
            frontline_case_price, effective_case_price, best_case_price,
            rip_savings,
            (effective_case_price - frontline_case_price) AS overage,
            ({vintage_norm_sql('vintage')}) AS vintage_norm
        FROM {src}
        WHERE {current_filter}
          AND effective_case_price IS NOT NULL
          AND (
              (frontline_case_price IS NOT NULL
               AND effective_case_price > frontline_case_price + 0.01)
              OR effective_case_price < 0
          )
        ORDER BY ABS(COALESCE(effective_case_price - frontline_case_price,
                              effective_case_price)) DESC
        LIMIT $lim
    """
    df = con.execute(sql, params).fetchdf()

    findings = []
    for _, r in df.iterrows():
        eff = _clean(r["effective_case_price"])
        front = _clean(r["frontline_case_price"])
        negative = eff is not None and eff < 0
        if front and front > 0 and eff is not None:
            variance_pct = round((eff - front) / front, 4)
        else:
            variance_pct = None

        if negative:
            detail = (
                f"Effective case price is negative ({eff}); discounts/RIP savings "
                "exceeded the list price, which is impossible."
            )
        else:
            detail = (
                f"Effective case price ({eff}) exceeds the frontline list price "
                f"({front}) — savings should never push the price up."
            )

        findings.append({
            "check": "calc_bugs",
            "severity": "high",
            "wholesaler": _clean(r["wholesaler"]),
            "product_name": _clean(r["product_name"]),
            "upc": _clean(r["upc"]),
            "unit_volume": _clean(r["unit_volume"]),
            "vintage": _clean(r["vintage_norm"]),
            "variance_pct": variance_pct,
            "observed": _clean_dict({
                "edition": r["edition"],
                "frontline_case_price": front,
                "effective_case_price": eff,
                "best_case_price": r["best_case_price"],
                "rip_savings": r["rip_savings"],
            }),
            "root_cause": "calculation_bug",
            "root_cause_detail": detail,
            "evidence": _clean_dict({
                "overage": r["overage"],
                "negative_effective": negative,
            }),
            "suggested_fix": ("Effective price computation produced an impossible "
                              "value — check RIP join dedup in derive.py."),
        })
    return findings


# --- Detector (d): pack_size_mismatch --------------------------------------

def _detect_pack_size_mismatch(con, src, threshold, wholesaler, limit) -> list:
    """SKUs whose NAME implies a multi-unit pack but whose unit_qty is 1.

    When the structured pack count (``unit_qty``) is 1, per-bottle price ==
    per-case price, so bottle-level pricing and comparisons are wrong/misleading
    (e.g. 'LONG DRINK GIN 12P' recorded as a single $47.90 unit while the sibling
    'LONG DRINK GIN 4X6P' correctly carries unit_qty=4).

    Detection (RE2 — no lookahead, so we anchor with word boundaries):
      - name has a pack token: <digits>[ ](PK|PACK|P)\\b  (12P, 6PK, 12PACK) —
        the \\b after P rejects proof strings like '100PR' / '80PF'.
      - or a multipack token: <digits>[ ]X[ ]<digits>  (6X4, 4X6P).
      - AND TRY_CAST(unit_qty AS DOUBLE) IS NULL or <= 1.
    Scans the current edition per wholesaler so a SKU is reported once.
    """
    ed_map = _current_edition_map(con, src, wholesaler)
    if not ed_map:
        return []
    params = {"lim": int(limit)}
    ed_pairs = []
    for i, (ws, ed) in enumerate(ed_map.items()):
        params[f"ws_{i}"] = ws
        params[f"ed_{i}"] = ed
        ed_pairs.append(f"(wholesaler = $ws_{i} AND edition = $ed_{i})")
    current_filter = "(" + " OR ".join(ed_pairs) + ")"

    pack_re = "(?i)[0-9]+ ?(PK|PACK|P)\\b"
    multi_re = "(?i)[0-9]+ ?X ?[0-9]+"

    sql = f"""
        WITH cur AS (
            SELECT wholesaler, edition, upc, product_name, product_type,
                   unit_volume, unit_qty,
                   frontline_case_price, frontline_unit_price,
                   TRY_CAST(unit_qty AS DOUBLE) AS qty_num,
                   regexp_extract(product_name, '{pack_re}', 0) AS pack_tok,
                   regexp_extract(product_name, '{multi_re}', 0) AS multi_tok
            FROM {src}
            WHERE {current_filter}
              AND (combo_code IS NULL OR combo_code = '' OR combo_code = '0')
        )
        SELECT * FROM cur
        WHERE (pack_tok <> '' OR multi_tok <> '')
          AND (qty_num IS NULL OR qty_num <= 1)
        ORDER BY product_name
        LIMIT $lim
    """
    df = con.execute(sql, params).fetchdf()

    findings = []
    for _, r in df.iterrows():
        token = (_clean(r["pack_tok"]) or _clean(r["multi_tok"]) or "").strip()
        qty = _clean(r["unit_qty"])
        front = _clean(r["frontline_case_price"])
        btl = _clean(r["frontline_unit_price"])
        findings.append({
            "check": "pack_size_mismatch",
            "severity": "medium",
            "wholesaler": _clean(r["wholesaler"]),
            "product_name": _clean(r["product_name"]),
            "upc": _clean(r["upc"]),
            "unit_volume": _clean(r["unit_volume"]),
            "vintage": None,
            "variance_pct": None,
            "observed": _clean_dict({
                "edition": r["edition"],
                "unit_qty": qty,
                "frontline_case_price": front,
                "frontline_unit_price": btl,
            }),
            "root_cause": "pack_size_missing",
            "root_cause_detail": (
                f"Product name implies a multi-unit pack ('{token}') but unit_qty "
                f"is {qty if qty is not None else 'missing'}, so per-bottle price "
                "equals per-case price — bottle-level pricing is misleading."
            ),
            "evidence": _clean_dict({
                "implied_pack_token": token,
                "recorded_unit_qty": qty,
                "case_equals_bottle": (front is not None and btl is not None
                                       and abs((front or 0) - (btl or 0)) < 0.01),
            }),
            "suggested_fix": ("Name implies a pack but unit_qty=1 — correct the pack "
                              "count in the source/parser so per-bottle pricing is right."),
        })
    return findings


# --- Detector (e): vintage_placeholder_dupe --------------------------------

def _detect_vintage_placeholder_dupe(con, src, threshold, wholesaler, limit) -> list:
    """Wine SKUs listed twice — real vintage + a '0'/NULL placeholder — same price.

    The source sometimes carries the same vintage-sensitive SKU twice in one
    edition: once with its real vintage (e.g. 2024) and once with a '0'/blank
    vintage placeholder, at the *same* price. That produces phantom duplicate
    rows in vintage-aware comparisons (e.g. the month-over-month screen).

    Detection: within (wholesaler, upc, unit_volume, unit_qty, edition,
    frontline_case_price), a vintage-sensitive group containing BOTH a non-null
    and a null normalized vintage. Genuinely distinct vintages priced
    differently fall into different price groups and are NOT flagged.
    """
    ed_map = _current_edition_map(con, src, wholesaler)
    if not ed_map:
        return []
    params = {"lim": int(limit)}
    ed_pairs = []
    for i, (ws, ed) in enumerate(ed_map.items()):
        params[f"ws_{i}"] = ws
        params[f"ed_{i}"] = ed
        ed_pairs.append(f"(wholesaler = $ws_{i} AND edition = $ed_{i})")
    current_filter = "(" + " OR ".join(ed_pairs) + ")"

    sql = f"""
        WITH cur AS (
            SELECT wholesaler, edition, upc, product_name, product_type,
                   unit_volume, unit_qty, vintage, frontline_case_price,
                   ({vintage_norm_sql('vintage')}) AS vintage_norm,
                   {is_vintage_sensitive_sql('product_type')} AS is_vintage
            FROM {src}
            WHERE {current_filter}
              AND {valid_upc_sql('upc')}
              AND (combo_code IS NULL OR combo_code = '' OR combo_code = '0')
        )
        SELECT
            wholesaler, edition, upc, unit_volume,
            ANY_VALUE(product_name) AS product_name,
            ANY_VALUE(product_type) AS product_type,
            frontline_case_price,
            MAX(vintage_norm) AS real_vintage,
            COUNT(*) FILTER (WHERE vintage_norm IS NOT NULL) AS n_real,
            COUNT(*) FILTER (WHERE vintage_norm IS NULL) AS n_placeholder
        FROM cur
        WHERE is_vintage
        GROUP BY wholesaler, edition, upc, unit_volume,
                 TRY_CAST(unit_qty AS DOUBLE), frontline_case_price
        HAVING COUNT(*) FILTER (WHERE vintage_norm IS NOT NULL) >= 1
           AND COUNT(*) FILTER (WHERE vintage_norm IS NULL) >= 1
        ORDER BY product_name
        LIMIT $lim
    """
    df = con.execute(sql, params).fetchdf()

    findings = []
    for _, r in df.iterrows():
        real_v = _clean(r["real_vintage"])
        price = _clean(r["frontline_case_price"])
        findings.append({
            "check": "vintage_placeholder_dupe",
            "severity": "medium",
            "wholesaler": _clean(r["wholesaler"]),
            "product_name": _clean(r["product_name"]),
            "upc": _clean(r["upc"]),
            "unit_volume": _clean(r["unit_volume"]),
            "vintage": real_v,
            "variance_pct": None,
            "observed": _clean_dict({
                "edition": r["edition"],
                "frontline_case_price": price,
                "real_vintage_rows": _clean(r["n_real"]),
                "placeholder_rows": _clean(r["n_placeholder"]),
            }),
            "root_cause": "vintage_placeholder_dupe",
            "root_cause_detail": (
                f"Vintage-sensitive {r['product_type']} listed twice at the same "
                f"price (${price}): once as vintage {real_v} and once with a "
                "'0'/blank placeholder — the placeholder is a phantom duplicate."
            ),
            "evidence": _clean_dict({
                "real_vintage": real_v,
                "placeholder_rows": _clean(r["n_placeholder"]),
                "frontline_case_price": price,
            }),
            "suggested_fix": ("Same SKU tagged with both a real vintage and a '0'/blank "
                              "placeholder at one price — drop the placeholder row in "
                              "the source/parser so it isn't double-counted."),
        })
    return findings


# --- Orchestrator ----------------------------------------------------------

_DETECTORS = {
    "edition_price_moves": _detect_edition_price_moves,
    "cross_distributor_gaps": _detect_cross_distributor_gaps,
    "calc_bugs": _detect_calc_bugs,
    "pack_size_mismatch": _detect_pack_size_mismatch,
    "vintage_placeholder_dupe": _detect_vintage_placeholder_dupe,
}


def run_scan(threshold: float = VARIANCE_THRESHOLD,
             wholesaler: Optional[str] = None,
             checks: Optional[list] = None,
             limit_per_check: int = 200) -> dict:
    """Run the variance scan and return findings with root-cause classification.

    Returns a dict::

        {
          "threshold": float,
          "generated_at": iso-8601 str,
          "wholesaler": str|None,
          "checks_run": [str, ...],
          "summary": {
              "total": int,
              "by_severity": {"high": int, "medium": int, "low": int},
              "by_root_cause": {<code>: int, ...},
              "by_check": {<check>: int, ...},
          },
          "findings": [Finding, ...],
        }

    A Finding is a dict with keys: check, severity ('high'|'medium'|'low'),
    wholesaler, product_name, upc, unit_volume, vintage, variance_pct (signed
    float where meaningful), observed (dict), root_cause (snake_case code),
    root_cause_detail (sentence), evidence (dict), suggested_fix (sentence).
    """
    if threshold is None:
        threshold = VARIANCE_THRESHOLD
    threshold = float(threshold)

    if checks:
        selected = [c for c in checks if c in _DETECTORS]
    else:
        selected = list(ALL_CHECKS)

    findings = []
    with get_duckdb() as con:
        src = read_parquet(con, "cpl_enriched")
        for name in selected:
            detector = _DETECTORS[name]
            findings.extend(
                detector(con, src, threshold, wholesaler, limit_per_check)
            )

    by_severity = {"high": 0, "medium": 0, "low": 0}
    by_root_cause = {}
    by_check = {}
    for f in findings:
        sev = f.get("severity", "low")
        by_severity[sev] = by_severity.get(sev, 0) + 1
        rc = f.get("root_cause", "unknown")
        by_root_cause[rc] = by_root_cause.get(rc, 0) + 1
        ck = f.get("check", "unknown")
        by_check[ck] = by_check.get(ck, 0) + 1

    return {
        "threshold": threshold,
        "generated_at": datetime.now().isoformat(),
        "wholesaler": wholesaler,
        "checks_run": selected,
        "summary": {
            "total": len(findings),
            "by_severity": by_severity,
            "by_root_cause": by_root_cause,
            "by_check": by_check,
        },
        "findings": findings,
    }
