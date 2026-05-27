"""
Catalog API â€” browse, search, filter products.

Covers: Â§2 Catalog, Â§2.6 Editions, Â§2.7 Categories/Brands, Â§3.1 Item Detail
"""

import json
import math
import re
from datetime import date

from fastapi import APIRouter, Query, Depends
from typing import Optional

from backend.db import get_duckdb, read_parquet
from backend.auth import get_optional_user
from backend.enrichment_join import attach_enrichment_image as _attach_enrichment_image
from backend.rip_utils import is_bottle_unit as _is_bottle_unit, rip_per_case as _rip_per_case, rip_bundle_cost as _rip_bundle_cost


def _current_yyyy_mm() -> str:
    """Edition string for today's month (e.g. '2026-05')."""
    t = date.today()
    return f"{t.year:04d}-{t.month:02d}"


def _next_yyyy_mm() -> str:
    """Edition string for next month (e.g. '2026-06')."""
    t = date.today()
    y, m = t.year, t.month
    if m == 12:
        y, m = y + 1, 1
    else:
        m += 1
    return f"{y:04d}-{m:02d}"


def _clean_record(rec: dict) -> dict:
    """Replace NaN with None and convert non-serializable types to strings."""
    out = {}
    for k, v in rec.items():
        if isinstance(v, float) and math.isnan(v):
            out[k] = None
        elif hasattr(v, 'isoformat'):
            out[k] = v.isoformat() if v is not None else None
        else:
            out[k] = v
    return out


def _vintage_norm_sql(col: str = "vintage") -> str:
    """SQL expression standardizing a raw vintage to a 4-digit string or NULL.

    4-digit kept; '2023.0' floats trimmed; 2-digit treated as 20XX (<=30) else
    19XX; 'NA'/'NV'/blank/junk (incl. the '0' placeholder) become NULL
    (non-vintage). Mirrors the normalization used by /cross-distributor.

    The same UPC is reused across vintages for wine (e.g. a $169 non-vintage
    listing and a $36 2023 closeout under one UPC), so a price timeline must
    surface the vintage per edition rather than silently merge them.
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


def _clean_vintage(v):
    """Normalize a fetched vintage_norm cell to a plain string or None."""
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    return str(v)


router = APIRouter(prefix="/api/catalog", tags=["catalog"])

# Distributor display name mapping
DISTRIBUTOR_NAMES = {
    "allied": "Allied",
    "fedway": "Fedway",
    "high_grade": "Highgrade",
    "opici": "Opici",
    "peerless": "Peerless",
}


def _display_name(code: str) -> str:
    return DISTRIBUTOR_NAMES.get(code, code)


def _in_filter(where, params, column, csv, prefix):
    """Append a `column IN (...)` clause for a comma-separated multi-select value."""
    vals = [v.strip() for v in (csv or "").split(",") if v.strip()]
    if not vals:
        return
    keys = []
    for i, v in enumerate(vals):
        k = f"{prefix}{i}"
        params[k] = v
        keys.append(f"${k}")
    where.append(f"{column} IN ({', '.join(keys)})")


def _q_clause(q: str, extra_aliases: dict | None = None,
              name_col: str = "product_name", brand_col: str = "brand",
              upc_col: str = "upc") -> tuple[str, dict]:
    """Build the search predicate for a free-text query, with its params.

    Every whitespace token must match the product NAME or BRAND (AND across
    tokens), so "chivas 12" finds "CHIVAS REGAL 12YR" but not unrelated items.
    Shorthand and nicknames are expanded (see backend/search_aliases): a token
    like "jw" or "henny" also accepts its full brand ("johnnie walker",
    "hennessy"), so "JW Blue" and "Johnnie Blue" both find Johnnie Walker Blue
    Label. A query that is essentially a barcode is matched against the UPC with
    leading-zero tolerance (we never match the digits inside a text query against
    the UPC, which used to make "chivas 12" hit every barcode containing "12")."""
    from backend.search_aliases import expansion_for
    tokens = [t for t in q.lower().split() if t]
    params: dict = {}
    counter = {"i": 0}

    def _m(term: str) -> str:
        k = f"qt{counter['i']}"
        counter["i"] += 1
        params[k] = f"%{term}%"
        return f"(UPPER({name_col}) LIKE UPPER(${k}) OR UPPER(COALESCE({brand_col},'')) LIKE UPPER(${k}))"

    token_clauses = []
    for tok in tokens:
        subs = [_m(tok)]                              # the literal text, on name or brand
        exp = expansion_for(tok, extra_aliases)       # plus EACH alias word (OR, not AND:
        if exp:                                       # catalogue names abbreviate brands,
            subs.extend(_m(w) for w in exp)           # e.g. "Johnnie Walker" -> "J WALKER")
        token_clauses.append("(" + " OR ".join(subs) + ")")
    name_match = " AND ".join(token_clauses) if token_clauses else "TRUE"

    compact = q.replace(" ", "").replace("-", "")
    if compact.isdigit() and len(compact) >= 4:
        digits_norm = compact.lstrip("0") or compact
        params["q_upc"] = f"%{compact}%"
        params["q_upc2"] = f"%{digits_norm}%"
        return f"(({name_match}) OR {upc_col} LIKE $q_upc OR {upc_col} LIKE $q_upc2)", params
    return f"({name_match})", params


_BRAND_INITIALISMS = None


def _brand_initialisms(con, src):
    """Auto-derived {initialism: brand} map (e.g. 'gg' -> 'grey goose') built once
    per process from the catalogue's distinct brands, so even brands missing from
    the curated alias table still get an abbreviation alias."""
    global _BRAND_INITIALISMS
    if _BRAND_INITIALISMS is None:
        try:
            from backend.search_aliases import build_brand_initialisms
            rows = con.execute(
                f"SELECT DISTINCT brand FROM {src} WHERE brand IS NOT NULL AND brand <> ''"
            ).fetchall()
            _BRAND_INITIALISMS = build_brand_initialisms([r[0] for r in rows])
        except Exception:
            _BRAND_INITIALISMS = {}
    return _BRAND_INITIALISMS


def _attach_next_month_prices(con, src, records):
    """Annotate each record with next-month price + a "Better Price" verdict.

    Looks up the same UPCs in next month's edition and sets next_case_price,
    next_effective_case_price, and better_month (Same / This Month / Next Month).
    Shared by /search and /new-items so both render the "Better Price" column
    identically. No-op on an empty list.
    """
    if not records:
        return
    next_ym = _next_yyyy_mm()
    upcs = sorted({str(r["upc"]) for r in records if r.get("upc")})
    if not upcs:
        return
    upc_ph = ", ".join(f"$u{i}" for i in range(len(upcs)))
    up_params = {f"u{i}": u for i, u in enumerate(upcs)}
    next_df = con.execute(f"""
        SELECT wholesaler, edition, upc, product_name, unit_volume,
               frontline_case_price AS next_case_price,
               effective_case_price AS next_effective_case_price
        FROM {src}
        WHERE edition = $next_ym
          AND upc IN ({upc_ph})
    """, {**up_params, "next_ym": next_ym}).fetchdf()
    # Key on (wholesaler, upc, product_name, unit_volume) because a single UPC
    # can be attached to multiple distinct products in the source data (e.g.
    # Allied uses one UPC for both MACALLAN DBL CSK 12Y and MACALLAN LUNAR20 4P).
    next_map = {}
    for _, nr in next_df.iterrows():
        k = (
            nr["wholesaler"],
            str(nr["upc"]),
            nr.get("product_name") or "",
            nr.get("unit_volume") or "",
        )
        next_map[k] = nr
    for rec in records:
        key = (
            rec["wholesaler"],
            str(rec.get("upc") or ""),
            rec.get("product_name") or "",
            rec.get("unit_volume") or "",
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


def _attach_discount_rip_tiers(con, records):
    """Attach a ``tiers`` list (CPL discount tiers + stacked RIP tiers) to each
    record, mirroring what the catalog table renders as expandable sub-rows.
    Shared by /search (include_tiers) and /new-items. No-op on an empty list."""
    if not records:
        return
    rip_src = read_parquet(con, "rip")

    # Collect rip lookup keys for this page in one query
    keys = []
    for rec in records:
        rc = rec.get("rip_code")
        if rc and str(rc) not in ("None", "nan", "0", ""):
            keys.append((str(rc), rec["wholesaler"], rec["edition"]))
    # Dedupe codes for the IN-list
    uniq_codes = sorted({k[0] for k in keys})
    uniq_ws = sorted({k[1] for k in keys})
    uniq_ed = sorted({k[2] for k in keys})
    rip_full = {}   # (code, ws, ed, upc) -> [tiers]
    rip_by_code = {}  # (code, ws, ed)    -> [tiers]  (fallback)
    if uniq_codes:
        # Pull all RIP rows matching any (code, ws, ed) on this page, then split
        # into per-UPC and code-level buckets so we can fall back when a
        # wholesaler anchors the RIP to a stub UPC.
        rp = {}
        ph_codes = ", ".join(f"$rc_{i}" for i in range(len(uniq_codes)))
        ph_ws = ", ".join(f"$ws_{i}" for i in range(len(uniq_ws)))
        ph_ed = ", ".join(f"$ed_{i}" for i in range(len(uniq_ed)))
        for i, v in enumerate(uniq_codes): rp[f"rc_{i}"] = v
        for i, v in enumerate(uniq_ws): rp[f"ws_{i}"] = v
        for i, v in enumerate(uniq_ed): rp[f"ed_{i}"] = v
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
        rc = str(rec.get("rip_code") or "")
        if not rc or rc in ("None", "nan", "0", ""):
            return []
        upc_key = (rc, rec["wholesaler"], rec["edition"], str(rec.get("upc") or ""))
        if upc_key in rip_full:
            return rip_full[upc_key]
        code_key = (rc, rec["wholesaler"], rec["edition"])
        return rip_by_code.get(code_key, [])

    def _uq(rec) -> float:
        """Bottles per case (for per-bottle pricing). Defaults to 1."""
        try:
            n = float(rec.get("unit_qty") or 0)
            return n if n > 0 else 1.0
        except (TypeError, ValueError):
            return 1.0

    def _btl_after(price_after, uq) -> float | None:
        return round(price_after / uq, 2) if (price_after is not None and uq > 0) else None

    for rec in records:
        cp = float(rec.get("frontline_case_price") or 0)
        uq = _uq(rec)
        # Discount tiers from CPL
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
            tail = (m.group(2) or "").lower().strip()
            unit = "Bottles" if tail.startswith("bottle") or tail in ("b", "btl", "bottles") else "Cases"
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

        # Best applicable per-case discount at a given case qty (Cases unit only).
        # Discount tiers are mutually exclusive — you get the highest-amount
        # tier whose minimum qty you've met.
        def _best_disc_at_cases(n: int) -> float:
            best = 0.0
            for d in disc:
                if d["unit"].lower().startswith("case") and d["qty"] <= n and d["amount"] > best:
                    best = d["amount"]
            return best

        # RIP tiers (dedup by qty+unit+amount). RIPs STACK with the applicable
        # case discount, so the effective price subtracts both.
        rips_raw = _lookup_rips(rec)
        seen = set()
        rips = []
        for t in rips_raw:
            sig = (t["qty"], t["unit"].lower(), round(t["amount"], 2))
            if sig in seen:
                continue
            seen.add(sig)
            # Bottle-unit RIPs are per-bottle → ×pack to get per-case.
            is_bottle = _is_bottle_unit(t["unit"])
            rip_per_case = round(_rip_per_case(t["amount"], t["qty"], t["unit"], uq), 2)
            is_case_unit = not is_bottle
            disc_at_qty = _best_disc_at_cases(t["qty"]) if is_case_unit else 0.0
            combined_save = round(rip_per_case + disc_at_qty, 2)
            up_price = float(rec.get("frontline_unit_price") or 0)
            bundle_cost = _rip_bundle_cost(t["qty"], t["unit"], cp, up_price)
            rips.append({
                "source": "rip",
                "qty": t["qty"],
                "unit": t["unit"],
                "amount": t["amount"],
                "save_per_case": combined_save,
                "rip_only_save_per_case": rip_per_case,
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


def _attach_dup_upc(con, src, records):
    """For each row's UPC, work out whether the same barcode is carried by several
    distributors (informational: the same product at multiple suppliers) versus
    genuinely reused by ONE distributor for different products (a true duplicate).

    Only the latest edition per wholesaler is considered, so a distributor that
    renames an item every edition (e.g. Highgrade) does not look like a duplicate.
    Sets rec["distributor_count"], rec["multi_distributor"], and rec["dup_upc"]
    (same-distributor reuse). One batch query per page."""
    if not records:
        return
    norms = sorted({str(r.get("upc")).lstrip("0") for r in records
                    if r.get("upc") and str(r.get("upc")).lstrip("0")})
    by_upc: dict[str, tuple[int, int]] = {}  # un -> (distributor_count, max products at one distributor)
    if norms:
        ph = ", ".join(f"$d{i}" for i in range(len(norms)))
        prm = {f"d{i}": u for i, u in enumerate(norms)}
        try:
            rows = con.execute(
                f"""WITH latest AS (SELECT wholesaler, MAX(edition) AS ed FROM {src} GROUP BY wholesaler),
                         cur AS (
                           SELECT LTRIM(e.upc,'0') AS un, e.wholesaler AS w, e.product_name AS pn
                           FROM {src} e JOIN latest l ON e.wholesaler=l.wholesaler AND e.edition=l.ed
                           WHERE LTRIM(e.upc,'0') IN ({ph})
                         ),
                         per AS (SELECT un, w, COUNT(DISTINCT pn) AS pc FROM cur GROUP BY un, w)
                    SELECT un, COUNT(DISTINCT w) AS ndist, MAX(pc) AS maxpc
                    FROM per GROUP BY un""", prm
            ).fetchall()
            by_upc = {str(r[0]): (int(r[1]), int(r[2])) for r in rows}
        except Exception:
            by_upc = {}
    for rec in records:
        un = str(rec.get("upc") or "").lstrip("0")
        ndist, maxpc = by_upc.get(un, (0, 0))
        rec["distributor_count"] = ndist
        # "Multiple distributors" = the SAME product carried by 2+ distributors.
        # Require maxpc == 1: no single distributor reuses the barcode for more than
        # one product. When a distributor puts one barcode on several products it is
        # a placeholder/garbage UPC, not a shared product, so we don't tag it.
        rec["multi_distributor"] = ndist > 1 and maxpc == 1
        rec["dup_upc"] = False


@router.get("/search")
def search_products(
    q: str = Query("", description="Search term"),
    wholesaler: Optional[str] = None,
    edition: Optional[str] = None,
    product_type: Optional[str] = None,
    min_price: Optional[float] = None,
    max_price: Optional[float] = None,
    has_discount: Optional[bool] = None,
    has_closeout: Optional[bool] = None,
    has_rip: Optional[bool] = None,
    in_combo: Optional[bool] = None,        # True = only products that are in a combo/bundle
    brand: Optional[str] = None,
    unit_volume: Optional[str] = None,
    divisions: Optional[str] = None,        # comma-separated wholesalers (filter panel)
    categories: Optional[str] = None,       # comma-separated product types
    brands: Optional[str] = None,           # comma-separated brands
    sizes: Optional[str] = None,            # comma-separated unit volumes
    tracked_only: bool = Query(False, description="If true, only return products on the watchlist"),
    sort: str = Query("product_name", description="Sort field"),
    order: str = Query("asc", description="asc or desc"),
    limit: int = Query(50, ge=1, le=50000),
    offset: int = Query(0, ge=0),
    include_tiers: bool = Query(False, description="If true, include discount_tiers and rip_tiers arrays per item"),
    user: Optional[dict] = Depends(get_optional_user),
):
    """Full-text search with faceted filtering. Defaults to latest edition to avoid duplicates."""
    with get_duckdb() as con:
        src = read_parquet(con, "cpl_enriched")

        # Pre-compute the "current" edition per wholesaler: the latest edition
        # whose YYYY-MM is on-or-before today. So if today is 2026-05-22 and
        # the wholesaler ships April/May/June price files, pick May (the file
        # in effect right now) instead of June (next month's preview).
        if not edition:
            current_ym = _current_yyyy_mm()
            max_eds = con.execute(f"""
                SELECT wholesaler,
                       MAX(CASE WHEN edition <= $current_ym THEN edition END) AS current_ed,
                       MAX(edition) AS latest_ed
                FROM {src}
                GROUP BY wholesaler
            """, {"current_ym": current_ym}).fetchdf()
            latest_map = {
                r["wholesaler"]: r["current_ed"] or r["latest_ed"]
                for _, r in max_eds.iterrows()
            }

        where = ["1=1"]
        params = {}

        q_clause_idx = None
        if q:
            clause, qp = _q_clause(q, _brand_initialisms(con, src))
            where.append(clause)
            q_clause_idx = len(where) - 1
            params.update(qp)
        if wholesaler:
            where.append("wholesaler = $wholesaler")
            params["wholesaler"] = wholesaler
        if edition:
            where.append("edition = $edition")
            params["edition"] = edition
        else:
            # Filter to latest edition per wholesaler to avoid duplicate rows
            if wholesaler and wholesaler in latest_map:
                where.append("edition = $latest_ed")
                params["latest_ed"] = latest_map[wholesaler]
            else:
                # Build an IN filter for all latest editions
                ed_conditions = []
                for i, (ws, ed) in enumerate(latest_map.items()):
                    ws_key, ed_key = f"ws_{i}", f"ed_{i}"
                    ed_conditions.append(f"(wholesaler = ${ws_key} AND edition = ${ed_key})")
                    params[ws_key] = ws
                    params[ed_key] = ed
                if ed_conditions:
                    where.append(f"({' OR '.join(ed_conditions)})")
        if product_type:
            where.append("product_type = $product_type")
            params["product_type"] = product_type
        if min_price is not None:
            where.append("frontline_case_price >= $min_price")
            params["min_price"] = min_price
        if max_price is not None:
            where.append("frontline_case_price <= $max_price")
            params["max_price"] = max_price
        if has_discount is True:
            where.append("has_discount = true")
        elif has_discount is False:
            where.append("has_discount = false")
        if has_closeout is True:
            where.append("has_closeout = true")
        elif has_closeout is False:
            where.append("has_closeout = false")
        if has_rip is True:
            where.append("has_rip = true")
        elif has_rip is False:
            where.append("has_rip = false")
        if in_combo is True:
            where.append("COALESCE(in_combo, false) = true")
        # Multi-select panel filters (applied server-side so they span all pages).
        _in_filter(where, params, "wholesaler", divisions, "div_")
        _in_filter(where, params, "product_type", categories, "cat_")
        _in_filter(where, params, "brand", brands, "brnd_")
        # Size filters on the standardized bucket so e.g. "750ML" also matches a
        # bottle stored as "25.33OZ". COALESCE keeps it working if the cache
        # predates the unit_volume_std column.
        _in_filter(where, params, "COALESCE(unit_volume_std, unit_volume)", sizes, "size_")

        # Restrict to watchlisted products across ALL editions/pages (server-side
        # so tracked items aren't hidden by pagination). Match on (name, wholesaler).
        if tracked_only:
            from backend.pg import get_pg
            if user is None:
                wl_rows = []
            else:
                with get_pg() as wl_con:
                    wl_rows = wl_con.execute(
                        "SELECT DISTINCT product_name, wholesaler FROM watchlist WHERE user_id = %s",
                        (user["id"],)
                    ).fetchall()
            if not wl_rows:
                where.append("1 = 0")  # nothing tracked → no results
            else:
                conds = []
                for i, r in enumerate(wl_rows):
                    pn_key, ws_key = f"wl_pn_{i}", f"wl_ws_{i}"
                    conds.append(f"(product_name = ${pn_key} AND wholesaler = ${ws_key})")
                    params[pn_key] = r["product_name"]
                    params[ws_key] = r["wholesaler"]
                where.append(f"({' OR '.join(conds)})")

        allowed_sorts = {
            "product_name", "frontline_case_price", "best_case_price",
            "effective_case_price", "discount_pct", "total_savings_per_case",
        }
        sort_col = sort if sort in allowed_sorts else "product_name"
        sort_dir = "DESC" if order.lower() == "desc" else "ASC"

        where_clause = " AND ".join(where)

        # A row is a duplicate ONLY when the barcode, name, size, vintage, PRICE and
        # DEALS all match. Rule from the user: same barcode but a different price or
        # different deals is NOT a duplicate (e.g. a different vintage, or a placeholder
        # barcode reused across unrelated products), so it stays as its own row.
        dedup = (
            "QUALIFY ROW_NUMBER() OVER (PARTITION BY wholesaler, LTRIM(COALESCE(upc,''),'0'), "
            "product_name, unit_volume, COALESCE(CAST(vintage AS VARCHAR),''), "
            "COALESCE(frontline_case_price,-1), COALESCE(effective_case_price,-1), "
            "COALESCE(total_savings_per_case,-1), has_discount, has_rip "
            "ORDER BY edition DESC) = 1"
        )

        # Count query (deduped to match the data query)
        count = con.execute(
            f"SELECT count(*) FROM (SELECT 1 FROM {src} WHERE {where_clause} {dedup}) t", params
        ).fetchone()[0]

        # AI fallback: a text search that found nothing -> ask Claude (Sonnet) to map
        # the shorthand to real brand terms and retry once. Key-gated + cached, so it
        # only fires on genuine misses and never on the common (alias-handled) ones.
        if (q and count == 0 and offset == 0 and q_clause_idx is not None
                and any(ch.isalpha() for ch in q)):
            try:
                from backend.ai_search import ai_expand_query
                ai_q = ai_expand_query(q)
            except Exception:
                ai_q = None
            if ai_q:
                clause2, qp2 = _q_clause(ai_q, _brand_initialisms(con, src))
                where[q_clause_idx] = clause2
                params.update(qp2)
                where_clause = " AND ".join(where)
                count = con.execute(
                    f"SELECT count(*) FROM (SELECT 1 FROM {src} WHERE {where_clause} {dedup}) t", params
                ).fetchone()[0]

        # Data query
        rows = con.execute(f"""
            SELECT wholesaler, edition, upc, product_name, product_type,
                   unit_qty, unit_volume, vintage, frontline_case_price, frontline_unit_price,
                   best_case_price, best_unit_price, effective_case_price,
                   has_discount, has_rip, has_closeout, discount_pct,
                   total_savings_per_case, rip_code, combo_code,
                   discount_1_qty, discount_1_amt,
                   discount_2_qty, discount_2_amt,
                   discount_3_qty, discount_3_amt,
                   discount_4_qty, discount_4_amt,
                   discount_5_qty, discount_5_amt
            FROM {src}
            WHERE {where_clause}
            {dedup}
            ORDER BY {sort_col} {sort_dir}
            LIMIT $limit OFFSET $offset
        """, {**params, "limit": limit, "offset": offset}).fetchdf()

        # Replace NaN with None so JSON serialization works
        import math as _math
        records = rows.to_dict(orient="records")
        for rec in records:
            for k, v in list(rec.items()):
                if isinstance(v, float) and _math.isnan(v):
                    rec[k] = None

        # Look up next-month prices for the same UPCs so the UI can show
        # a "Better Price: Same / This Month / Next Month" column.
        if not edition:
            _attach_next_month_prices(con, src, records)

        # Optionally enrich each item with discount + RIP tier sub-rows.
        if include_tiers:
            _attach_discount_rip_tiers(con, records)

        # Go-UPC thumbnail per row (one batch query; served from R2 CDN).
        _attach_enrichment_image(con, records)
        _attach_dup_upc(con, src, records)

        return {
            "total": count,
            "limit": limit,
            "offset": offset,
            "items": records,
        }


# Valid-UPC predicate reused for new-item detection: drop NULL/blank/stub UPCs
# ('0', all-zeros/nines/ones, '999999…' placeholders, too-short) so cross-edition
# matching only relies on real barcodes. Mirrors the stub filtering in
# /cross-distributor. {col} is substituted with the column to test.
_VALID_UPC_SQL = (
    "{col} IS NOT NULL AND {col} <> '' AND {col} <> '0'"
    " AND NOT regexp_matches({col}, '^(0+|9+|1+)$')"
    " AND NOT {col} LIKE '999999%'"
    " AND LENGTH(LTRIM({col}, '0')) >= 8"
)


@router.get("/new-items")
def new_items(
    q: str = Query("", description="Search term"),
    wholesaler: Optional[str] = None,
    introduced_edition: Optional[str] = Query(None, description="Filter to a single introduced month (YYYY-MM)"),
    months: int = Query(3, ge=1, le=12, description="How many recent editions count as 'newly introduced'"),
    has_discount: Optional[bool] = None,
    has_rip: Optional[bool] = None,
    sort: str = Query("introduced_edition", description="Sort field"),
    order: str = Query("desc", description="asc or desc"),
    limit: int = Query(50, ge=1, le=50000),
    offset: int = Query(0, ge=0),
    include_tiers: bool = Query(False, description="If true, include discount_tiers and rip_tiers arrays per item"),
):
    """Products newly introduced in the last ``months`` editions.

    "New" is detected by normalized UPC: an item is new in an edition when its
    UPC was absent from that wholesaler's immediately-prior edition. Product name
    is deliberately NOT used, because some wholesalers reformat names between
    editions (e.g. Highgrade), which would mark unchanged items as new. The
    earliest edition has no prior to compare against, so its items are never
    flagged. Items without a usable UPC are excluded (they can't be tracked
    across editions).

    Rows are the current-edition catalog records (same shape as /search) plus an
    ``introduced_edition`` field, so the catalog table renders identically.
    """
    with get_duckdb() as con:
        src = read_parquet(con, "cpl_enriched")
        current_ym = _current_yyyy_mm()
        valid_upc = _VALID_UPC_SQL.format(col="upc")

        # Window = the most recent `months` editions on-or-before this month.
        eds = con.execute(f"""
            SELECT DISTINCT edition FROM {src}
            WHERE edition <= $cym
            ORDER BY edition DESC
            LIMIT $months
        """, {"cym": current_ym, "months": int(months)}).fetchdf()
        window_eds = [r["edition"] for _, r in eds.iterrows()]
        if not window_eds:
            return {"total": 0, "limit": limit, "offset": offset, "items": [],
                    "months": [], "current_ym": current_ym, "window_start": None}
        window_start = min(window_eds)

        # CTEs: per-wholesaler edition order, the current "view" edition, UPC
        # presence per edition, and the start of each UPC's current run.
        base_ctes = f"""
            WITH eds AS (
                SELECT wholesaler, edition,
                       LAG(edition) OVER (PARTITION BY wholesaler ORDER BY edition) AS prev_edition
                FROM (SELECT DISTINCT wholesaler, edition FROM {src})
            ),
            view_ed AS (
                SELECT wholesaler,
                       COALESCE(MAX(CASE WHEN edition <= $cym THEN edition END), MAX(edition)) AS ed
                FROM {src} GROUP BY wholesaler
            ),
            present AS (
                SELECT DISTINCT wholesaler, LTRIM(upc, '0') AS upc_norm, edition
                FROM {src}
                WHERE {valid_upc}
            ),
            firstapp AS (
                -- editions where a UPC appears but was absent in the prior edition
                SELECT p.wholesaler, p.upc_norm, p.edition
                FROM present p
                JOIN eds e ON e.wholesaler = p.wholesaler AND e.edition = p.edition
                WHERE e.prev_edition IS NOT NULL
                  AND NOT EXISTS (
                      SELECT 1 FROM present p2
                      WHERE p2.wholesaler = p.wholesaler
                        AND p2.upc_norm = p.upc_norm
                        AND p2.edition = e.prev_edition
                  )
            ),
            introduced AS (
                -- start of the current contiguous run = most recent first-appearance
                SELECT wholesaler, upc_norm, MAX(edition) AS introduced_edition
                FROM firstapp
                GROUP BY wholesaler, upc_norm
            )
        """

        # Filters shared by the data, count, and month-summary queries.
        params = {"cym": current_ym, "window_start": window_start}
        filters = [
            "i.introduced_edition >= $window_start",
            "i.introduced_edition <= $cym",
        ]
        if wholesaler:
            filters.append("e.wholesaler = $wholesaler")
            params["wholesaler"] = wholesaler
        if has_discount is True:
            filters.append("e.has_discount = true")
        elif has_discount is False:
            filters.append("e.has_discount = false")
        if has_rip is True:
            filters.append("e.has_rip = true")
        elif has_rip is False:
            filters.append("e.has_rip = false")

        # join cpl_enriched (current edition only) to the introduced set
        join_sql = f"""
            FROM {src} e
            JOIN view_ed v ON v.wholesaler = e.wholesaler AND v.ed = e.edition
            JOIN introduced i
              ON i.wholesaler = e.wholesaler
             AND i.upc_norm = LTRIM(e.upc, '0')
        """

        # Month chips: count per introduced edition, before the search box and
        # the specific-month selection are applied (so the chips stay stable).
        month_df = con.execute(f"""
            {base_ctes}
            SELECT i.introduced_edition AS edition, count(*) AS n
            {join_sql}
            WHERE {' AND '.join(filters)}
            GROUP BY i.introduced_edition
            ORDER BY i.introduced_edition DESC
        """, params).fetchdf()
        months_summary = [
            {"edition": r["edition"], "count": int(r["n"])}
            for _, r in month_df.iterrows()
        ]

        # Now layer the search box and the specific-month selection on top.
        # Same smart (alias + brand) matching as the Catalog search.
        if q:
            clause, qp = _q_clause(q, _brand_initialisms(con, src),
                                   name_col="e.product_name", brand_col="e.brand", upc_col="e.upc")
            filters.append(clause)
            params.update(qp)
        if introduced_edition:
            filters.append("i.introduced_edition = $intro")
            params["intro"] = introduced_edition

        where_sql = " AND ".join(filters)

        count = con.execute(f"""
            {base_ctes}
            SELECT count(*) {join_sql} WHERE {where_sql}
        """, params).fetchone()[0]

        allowed_sorts = {
            "product_name", "frontline_case_price", "effective_case_price",
            "total_savings_per_case", "discount_pct", "introduced_edition",
        }
        sort_col = sort if sort in allowed_sorts else "introduced_edition"
        sort_dir = "DESC" if order.lower() == "desc" else "ASC"

        rows = con.execute(f"""
            {base_ctes}
            SELECT e.wholesaler, e.edition, e.upc, e.product_name, e.product_type,
                   e.unit_qty, e.unit_volume, e.frontline_case_price, e.frontline_unit_price,
                   e.best_case_price, e.best_unit_price, e.effective_case_price,
                   e.has_discount, e.has_rip, e.has_closeout, e.discount_pct,
                   e.total_savings_per_case, e.rip_code, e.combo_code, e.brand,
                   e.discount_1_qty, e.discount_1_amt,
                   e.discount_2_qty, e.discount_2_amt,
                   e.discount_3_qty, e.discount_3_amt,
                   e.discount_4_qty, e.discount_4_amt,
                   e.discount_5_qty, e.discount_5_amt,
                   i.introduced_edition
            {join_sql}
            WHERE {where_sql}
            ORDER BY {sort_col} {sort_dir}, product_name ASC, upc ASC
            LIMIT $limit OFFSET $offset
        """, {**params, "limit": limit, "offset": offset}).fetchdf()

        records = rows.to_dict(orient="records")
        for rec in records:
            for k, v in list(rec.items()):
                if isinstance(v, float) and math.isnan(v):
                    rec[k] = None

        # Same enrichment as /search so the catalog table renders identically.
        _attach_next_month_prices(con, src, records)
        if include_tiers:
            _attach_discount_rip_tiers(con, records)
        _attach_enrichment_image(con, records)
        _attach_dup_upc(con, src, records)

        return {
            "total": int(count),
            "limit": limit,
            "offset": offset,
            "current_ym": current_ym,
            "window_start": window_start,
            "months": months_summary,
            "items": records,
        }


@router.get("/product/{wholesaler}/{product_name:path}")
def get_product_detail(
    wholesaler: str,
    product_name: str,
    edition: Optional[str] = None,
    upc: Optional[str] = None,
    unit_volume: Optional[str] = None,
    unit_qty: Optional[str] = None,
    vintage: Optional[str] = None,
):
    """Full product detail with all pricing, discount tiers, and RIP info.

    Accepts optional ``upc`` and ``unit_volume`` so callers can disambiguate
    when a wholesaler stocks several sizes (or several distinct SKUs) under
    the same product_name, and an optional ``vintage`` (normalized year) so a
    reused-UPC wine resolves to the intended vintage rather than an arbitrary
    one. Without them the first matching row is returned, which can be wrong.
    """
    with get_duckdb() as con:
        src = read_parquet(con, "cpl_enriched")

        params = {"wholesaler": wholesaler, "product_name": product_name}
        extra_filters = []
        if upc:
            extra_filters.append("AND upc = $upc")
            params["upc"] = upc
        if unit_volume:
            extra_filters.append("AND unit_volume = $unit_volume")
            params["unit_volume"] = unit_volume
        if unit_qty:
            extra_filters.append("AND TRY_CAST(unit_qty AS DOUBLE) = TRY_CAST($uq AS DOUBLE)")
            params["uq"] = unit_qty
        if vintage:
            extra_filters.append(f"AND ({_vintage_norm_sql('vintage')}) = $vnorm")
            params["vnorm"] = vintage
        if edition:
            edition_filter = "AND edition = $edition"
            params["edition"] = edition
        else:
            # Use the edition in effect for today's month (e.g. May while
            # today is 2026-05-22) and only fall back to the latest available
            # if no past-or-current edition exists.
            current_ym = _current_yyyy_mm()
            row_ed = con.execute(f"""
                SELECT
                    MAX(CASE WHEN edition <= $current_ym THEN edition END) AS current_ed,
                    MAX(edition) AS latest_ed
                FROM {src} WHERE wholesaler = $wholesaler
            """, {"wholesaler": wholesaler, "current_ym": current_ym}).fetchone()
            max_ed = row_ed[0] or row_ed[1]
            edition_filter = "AND edition = $latest_ed"
            params["latest_ed"] = max_ed

        row = con.execute(f"""
            SELECT * FROM {src}
            WHERE wholesaler = $wholesaler AND product_name = $product_name
            {edition_filter}
            {' '.join(extra_filters)}
            LIMIT 1
        """, params).fetchdf()

        if row.empty:
            return {"error": "Product not found"}

        # Get discount tiers (CPL)
        tiers = []
        item = row.iloc[0]
        case_price_for_roi = float(item["frontline_case_price"]) if item.get("frontline_case_price") else 0.0
        for i in range(1, 6):
            qty = item.get(f"discount_{i}_qty")
            amt = item.get(f"discount_{i}_amt")
            if amt and amt > 0:
                amt_f = float(amt)
                tiers.append({
                    "tier": i,
                    "quantity": qty,
                    "amount_per_case": amt_f,
                    "price_after": round(case_price_for_roi - amt_f, 2),
                    "roi_pct": round((amt_f / case_price_for_roi) * 100, 2) if case_price_for_roi > 0 else 0.0,
                })

        # Get RIP tiers (RIP sheet, joined by rip_code + upc + edition)
        rip_tiers = []
        rip_code = item.get("rip_code")
        upc = item.get("upc")
        ed = item.get("edition")
        case_price = float(item["frontline_case_price"]) if item.get("frontline_case_price") else 0.0
        try:
            item_pack = float(item.get("unit_qty") or 0)
        except (TypeError, ValueError):
            item_pack = 0.0
        try:
            item_btl_price = float(item.get("frontline_unit_price") or 0)
        except (TypeError, ValueError):
            item_btl_price = 0.0
        if rip_code and str(rip_code) not in ("None", "nan", "0", ""):
            rip_src = read_parquet(con, "rip")
            rip_rows = con.execute(f"""
                SELECT rip_description,
                       rip_unit_1, rip_qty_1, rip_amt_1,
                       rip_unit_2, rip_qty_2, rip_amt_2,
                       rip_unit_3, rip_qty_3, rip_amt_3,
                       rip_unit_4, rip_qty_4, rip_amt_4
                FROM {rip_src}
                WHERE rip_code = $rip_code
                  AND wholesaler = $wholesaler
                  AND edition = $edition
                  AND upc = $upc
            """, {
                "rip_code": str(rip_code), "wholesaler": wholesaler,
                "edition": ed, "upc": str(upc),
            }).fetchdf()

            seen = set()
            for _, r in rip_rows.iterrows():
                description = r.get("rip_description")
                for j in range(1, 5):
                    unit = r.get(f"rip_unit_{j}")
                    rqty = r.get(f"rip_qty_{j}")
                    ramt = r.get(f"rip_amt_{j}")
                    try:
                        ramt_f = float(ramt) if ramt is not None else 0.0
                        rqty_f = float(rqty) if rqty is not None else 0.0
                    except (TypeError, ValueError):
                        continue
                    import math as _m
                    if (_m.isnan(ramt_f) or _m.isnan(rqty_f)
                            or ramt_f <= 0 or rqty_f <= 0):
                        continue
                    sig = (int(rqty_f), round(ramt_f, 2), str(unit))
                    if sig in seen:
                        continue
                    seen.add(sig)
                    # Bottle-unit RIPs are per-bottle → ×pack for per-case.
                    per_case = round(_rip_per_case(ramt_f, rqty_f, unit, item_pack), 2)
                    bundle_cost = _rip_bundle_cost(int(rqty_f), unit, case_price, item_btl_price)
                    rip_tiers.append({
                        "qty": int(rqty_f),
                        "unit": str(unit) if unit else "Cases",
                        "amount": ramt_f,
                        "per_case_savings": per_case,
                        "per_bottle_savings": round(per_case / item_pack, 2) if item_pack > 0 else None,
                        "price_after": max(round(case_price - per_case, 2), 0),
                        "btl_price_after": (max(round(item_btl_price - (per_case / item_pack), 2), 0)
                                            if item_btl_price > 0 and item_pack > 0 else None),
                        "bundle_cost": round(bundle_cost, 2) if bundle_cost > 0 else 0.0,
                        "roi_pct": round((ramt_f / bundle_cost) * 100, 2) if bundle_cost > 0 else 0.0,
                        "description": str(description) if description else None,
                    })
            rip_tiers.sort(key=lambda x: x["qty"])

        # Go-UPC enrichment (image + canonical details), matched by normalised
        # UPC. Empty/absent table -> no enrichment, never an error. category_path
        # and specs are stored as JSON text; parse them back to list/dict here.
        enrichment = None
        prod_upc = item.get("upc")
        if prod_upc is not None and str(prod_upc) not in ("None", "nan", ""):
            try:
                er = con.execute(
                    "SELECT name, brand, category, category_path, description, region, "
                    "specs, ean, code_type, barcode_url, inferred, image_url, image_source "
                    "FROM product_enrichment WHERE upc = LTRIM($u, '0')",
                    {"u": str(prod_upc)},
                ).fetchone()
            except Exception:
                er = None
            if er and (er[0] or er[11]):  # has a name or an image
                def _loads(v):
                    if not v:
                        return None
                    try:
                        return json.loads(v)
                    except (TypeError, ValueError):
                        return None
                enrichment = {
                    "name": er[0], "brand": er[1], "category": er[2],
                    "category_path": _loads(er[3]), "description": er[4],
                    "region": er[5], "specs": _loads(er[6]), "ean": er[7],
                    "code_type": er[8], "barcode_url": er[9],
                    "inferred": bool(er[10]), "image_url": er[11],
                    "image_source": er[12],
                }

        return {
            "product": _clean_record(row.to_dict(orient="records")[0]),
            "discount_tiers": tiers,
            "rip_tiers": rip_tiers,
            "enrichment": enrichment,
        }


@router.get("/price-comparison")
def price_comparison(
    wholesaler: Optional[str] = None,
    product_type: Optional[str] = None,
    direction: str = Query("any", description="up | down | any — which way the price moves next month"),
    min_abs_delta_pct: float = Query(0.0, ge=0),
    sort: str = Query("abs_delta_pct", description="abs_delta_pct | delta_pct | delta | curr_price | product_name"),
    order: str = Query("desc", description="asc or desc"),
    limit: int = Query(50, ge=1, le=50000),
):
    """This-month vs next-month price comparison.

    For each (wholesaler, upc, product_name) that exists in both the current
    edition and the next edition, return the current and next prices and the
    delta. Used by the dashboard for the "What's changing next month?" table.
    """
    with get_duckdb() as con:
        src = read_parquet(con, "cpl_enriched")
        current_ym = _current_yyyy_mm()
        next_ym = _next_yyyy_mm()

        params = {}
        ws_filter = ""
        if wholesaler:
            ws_filter = " AND c.wholesaler = $wholesaler AND n.wholesaler = $wholesaler"
            params["wholesaler"] = wholesaler
        pt_filter = ""
        if product_type:
            pt_filter = " AND c.product_type = $product_type"
            params["product_type"] = product_type

        # current-month edition per wholesaler (latest <= current_ym)
        curr_eds = con.execute(f"""
            SELECT wholesaler,
                   COALESCE(MAX(CASE WHEN edition <= $current_ym THEN edition END), MAX(edition)) AS ed
            FROM {src} GROUP BY wholesaler
        """, {"current_ym": current_ym}).fetchdf()
        curr_map = dict(zip(curr_eds["wholesaler"], curr_eds["ed"]))

        # next-month edition per wholesaler (smallest edition > current_ed, or fall back to next_ym)
        next_eds_df = con.execute(f"""
            SELECT wholesaler, MIN(edition) AS ed
            FROM {src}
            WHERE edition > $current_ym
            GROUP BY wholesaler
        """, {"current_ym": current_ym}).fetchdf()
        next_map = dict(zip(next_eds_df["wholesaler"], next_eds_df["ed"]))

        # Build per-wholesaler edition pair filters
        pair_clauses = []
        for i, ws in enumerate(sorted(set(curr_map) | set(next_map))):
            ce = curr_map.get(ws)
            ne = next_map.get(ws)
            if not ce or not ne:
                continue
            params[f"ws_{i}"] = ws
            params[f"ce_{i}"] = ce
            params[f"ne_{i}"] = ne
            pair_clauses.append(
                f"(c.wholesaler = $ws_{i} AND c.edition = $ce_{i} AND n.wholesaler = $ws_{i} AND n.edition = $ne_{i})"
            )
        if not pair_clauses:
            return {"current_ym": current_ym, "next_ym": next_ym, "items": []}

        dir_clause = ""
        if direction == "up":
            dir_clause = " AND n.frontline_case_price > c.frontline_case_price"
        elif direction == "down":
            dir_clause = " AND n.frontline_case_price < c.frontline_case_price"

        allowed = {"abs_delta_pct", "delta_pct", "delta", "curr_price", "product_name"}
        sort_key = sort if sort in allowed else "abs_delta_pct"
        sort_dir = "DESC" if order.lower() == "desc" else "ASC"
        sort_map = {
            "abs_delta_pct": "ABS(delta_pct)",
            "delta_pct": "delta_pct",
            "delta": "delta",
            "curr_price": "curr_case_price",
            "product_name": "product_name",
        }
        sort_sql = sort_map[sort_key]

        # max discount amount across the 5 CPL tiers (per-case dollar off).
        # Used to surface "best discount" in the comparison table.
        max_disc = (
            "GREATEST("
            "COALESCE({0}.discount_1_amt, 0),"
            "COALESCE({0}.discount_2_amt, 0),"
            "COALESCE({0}.discount_3_amt, 0),"
            "COALESCE({0}.discount_4_amt, 0),"
            "COALESCE({0}.discount_5_amt, 0))"
        )
        sql = f"""
            SELECT
                c.wholesaler,
                c.upc,
                c.product_name,
                c.product_type,
                c.unit_volume,
                c.unit_qty,
                ({_vintage_norm_sql('c.vintage')}) AS vintage,
                c.edition          AS curr_edition,
                n.edition          AS next_edition,
                c.frontline_case_price AS curr_case_price,
                n.frontline_case_price AS next_case_price,
                c.effective_case_price AS curr_effective_case_price,
                n.effective_case_price AS next_effective_case_price,
                c.has_rip          AS curr_has_rip,
                n.has_rip          AS next_has_rip,
                c.has_discount     AS curr_has_discount,
                n.has_discount     AS next_has_discount,
                c.discount_pct     AS curr_discount_pct,
                n.discount_pct     AS next_discount_pct,
                {max_disc.format('c')} AS curr_best_discount,
                {max_disc.format('n')} AS next_best_discount,
                c.rip_savings      AS curr_rip_savings,
                n.rip_savings      AS next_rip_savings,
                c.total_savings_per_case AS curr_total_savings,
                n.total_savings_per_case AS next_total_savings,
                (n.frontline_case_price - c.frontline_case_price) AS delta,
                CASE WHEN c.frontline_case_price > 0
                     THEN (n.frontline_case_price - c.frontline_case_price) / c.frontline_case_price * 100
                     ELSE 0 END AS delta_pct,
                (n.effective_case_price - c.effective_case_price) AS effective_delta,
                CASE WHEN c.effective_case_price > 0
                     THEN (n.effective_case_price - c.effective_case_price) / c.effective_case_price * 100
                     ELSE 0 END AS effective_delta_pct
            FROM {src} c
            JOIN {src} n
              ON c.wholesaler = n.wholesaler
             AND c.upc = n.upc
             AND c.product_name = n.product_name
             AND c.unit_volume IS NOT DISTINCT FROM n.unit_volume
             -- Match on pack count too: a SKU that goes from 1-pack to 3-pack
             -- between editions has a real case-price ×3 but the per-bottle
             -- price is unchanged. Without this, those show as fake hikes.
             AND TRY_CAST(c.unit_qty AS DOUBLE) IS NOT DISTINCT FROM TRY_CAST(n.unit_qty AS DOUBLE)
             -- For wine/sparkling/vermouth a single UPC spans vintages; compare
             -- like vintage to like vintage only. A 2022→2023 swap on the same
             -- UPC is a new product, not a price change. One comparison per
             -- vintage. Non-vintage categories are unaffected (both NULL).
             AND (
                 UPPER(c.product_type) NOT IN ('WINE', 'SPARKLING', 'VERMOUTH')
                 OR ({_vintage_norm_sql('c.vintage')}) IS NOT DISTINCT FROM ({_vintage_norm_sql('n.vintage')})
             )
            WHERE ({' OR '.join(pair_clauses)})
              -- Drop rows with stub UPCs ('0', empty, all-zeros, all-nines, too short).
              -- These are placeholders that the wholesaler uses across many
              -- distinct products, so joins on them produce wrong pairs.
              AND c.upc IS NOT NULL AND c.upc != '' AND c.upc != '0'
              AND NOT regexp_matches(c.upc, '^(0+|9+|1+)$')
              AND NOT c.upc LIKE '999999%'
              AND LENGTH(c.upc) >= 8
              -- Drop combo-bundle rows — the case price is the bundle slot,
              -- not standalone retail.
              AND (c.combo_code IS NULL OR c.combo_code = '' OR c.combo_code = '0')
              AND (n.combo_code IS NULL OR n.combo_code = '' OR n.combo_code = '0')
              {ws_filter}
              {pt_filter}
              {dir_clause}
              AND (
                  ABS(CASE WHEN c.frontline_case_price > 0
                           THEN (n.frontline_case_price - c.frontline_case_price) / c.frontline_case_price * 100
                           ELSE 0 END) >= $min_abs_delta_pct
                  OR ABS(CASE WHEN c.effective_case_price > 0
                              THEN (n.effective_case_price - c.effective_case_price) / c.effective_case_price * 100
                              ELSE 0 END) >= $min_abs_delta_pct
                  OR c.has_rip <> n.has_rip
                  OR c.has_discount <> n.has_discount
                  OR ABS(COALESCE(c.rip_savings, 0) - COALESCE(n.rip_savings, 0)) > 0.01
                  OR ABS({max_disc.format('c')} - {max_disc.format('n')}) > 0.01
              )
            -- Wine placeholder dedup: the source sometimes lists the same SKU
            -- twice — once with its real vintage and once with a '0'/NULL
            -- placeholder — at identical prices, producing duplicate rows. When
            -- the name, UPC, size, pack, and BOTH prices match, keep the row
            -- carrying a real vintage. Genuinely different-priced vintages of
            -- one UPC (e.g. a 2023 closeout vs the NV listing) differ on price,
            -- so they land in different partitions and are both kept.
            QUALIFY ROW_NUMBER() OVER (
                PARTITION BY c.wholesaler, c.product_name, c.upc, c.unit_volume,
                             TRY_CAST(c.unit_qty AS DOUBLE),
                             c.frontline_case_price, n.frontline_case_price
                ORDER BY (({_vintage_norm_sql('c.vintage')}) IS NULL) ASC,
                         ({_vintage_norm_sql('c.vintage')}) DESC
            ) = 1
            ORDER BY {sort_sql} {sort_dir} NULLS LAST
            LIMIT $limit
        """
        params["min_abs_delta_pct"] = float(min_abs_delta_pct)
        params["limit"] = int(limit)
        df = con.execute(sql, params).fetchdf()

        import re as _re
        count_sql = _re.sub(r'\bORDER BY .+?(?=LIMIT)', '', sql, flags=_re.DOTALL)
        count_sql = _re.sub(r'\bLIMIT\s+\$limit\b', '', count_sql)
        count_params = {k: v for k, v in params.items() if k != "limit"}
        try:
            total_unbounded = con.execute(
                f"SELECT COUNT(*) FROM ({count_sql}) t", count_params
            ).fetchone()[0]
        except Exception:
            total_unbounded = len(df)

        items = []
        for _, r in df.iterrows():
            rec = {}
            for k in df.columns:
                v = r[k]
                if isinstance(v, float) and math.isnan(v):
                    rec[k] = None
                else:
                    rec[k] = v
            items.append(rec)

        return {
            "current_ym": current_ym,
            "next_ym": next_ym,
            "total": int(total_unbounded),
            "returned": len(items),
            "items": items,
        }


@router.get("/cross-distributor")
def cross_distributor(
    distributor_a: str = Query("allied", description="Left distributor slug"),
    distributor_b: str = Query("fedway", description="Right distributor slug"),
    min_abs_savings_pct: float = Query(0.0, ge=0),
    cheaper: Optional[str] = Query(None, description="Filter: 'a', 'b', or omit"),
    sort: str = Query("abs_savings_pct", description="abs_savings_pct | savings | a_price | product"),
    order: str = Query("desc"),
    limit: int = Query(50, ge=1, le=50000),
):
    """Compare prices between two distributors for products that share a UPC.

    Matches products by UPC after stripping leading zeros (so '00812066021598'
    matches '812066021598') and same unit_volume. Compares effective case price
    (which already factors in CPL discounts and RIP per-case savings).
    """
    with get_duckdb() as con:
        src = read_parquet(con, "cpl_enriched")
        current_ym = _current_yyyy_mm()

        # Per-wholesaler current edition (latest <= today's month)
        eds_df = con.execute(f"""
            SELECT wholesaler,
                   COALESCE(MAX(CASE WHEN edition <= $current_ym THEN edition END), MAX(edition)) AS ed
            FROM {src}
            WHERE wholesaler IN ($a, $b)
            GROUP BY wholesaler
        """, {"current_ym": current_ym, "a": distributor_a, "b": distributor_b}).fetchdf()
        ed_map = dict(zip(eds_df["wholesaler"], eds_df["ed"]))
        ed_a = ed_map.get(distributor_a)
        ed_b = ed_map.get(distributor_b)
        if not ed_a or not ed_b:
            return {"distributor_a": distributor_a, "distributor_b": distributor_b,
                    "edition_a": ed_a, "edition_b": ed_b, "total": 0, "items": []}

        sort_map = {
            "abs_savings_pct": "ABS(savings_pct)",
            "savings": "savings",
            "a_price": "a_effective",
            "product": "product_name",
        }
        sort_sql = sort_map.get(sort, "ABS(savings_pct)")
        sort_dir = "DESC" if order.lower() == "desc" else "ASC"

        cheaper_clause = ""
        if cheaper == "a":
            cheaper_clause = " AND a.effective_case_price < b.effective_case_price"
        elif cheaper == "b":
            cheaper_clause = " AND b.effective_case_price < a.effective_case_price"

        sql = f"""
            WITH ambiguous AS (
                -- UPCs that map to more than one distinct product within a
                -- wholesaler/edition. These are unreliable identifiers and
                -- create false cross-distributor matches.
                SELECT wholesaler, LTRIM(upc, '0') AS upc_norm, unit_volume
                FROM {src}
                WHERE wholesaler IN ($a, $b)
                  AND ((wholesaler = $a AND edition = $ed_a)
                       OR (wholesaler = $b AND edition = $ed_b))
                  AND upc IS NOT NULL AND upc != '' AND upc != '0'
                GROUP BY wholesaler, upc_norm, unit_volume
                HAVING COUNT(DISTINCT product_name) > 1
            ),
            norm AS (
                SELECT *,
                       LTRIM(upc, '0') AS upc_norm,
                       -- Standardize vintage: 4-digit kept; 2-digit treated as
                       -- 20XX for <=30 else 19XX; '2020.0' floats stripped;
                       -- 'na' and other junk treated as NULL.
                       CASE
                           WHEN vintage IS NULL OR vintage = '' THEN NULL
                           WHEN UPPER(vintage) IN ('NA', 'N/A', 'NONE', 'NV') THEN NULL
                           WHEN regexp_matches(vintage, '^[0-9]{{4}}$')
                               THEN vintage
                           WHEN regexp_matches(vintage, '^[0-9]{{4}}\\.0+$')
                               THEN substr(vintage, 1, 4)
                           WHEN regexp_matches(vintage, '^[0-9]{{2}}$')
                               THEN CASE WHEN CAST(vintage AS INTEGER) <= 30
                                         THEN '20' || vintage
                                         ELSE '19' || vintage END
                           ELSE NULL
                       END AS vintage_norm,
                       -- Treat WINE / SPARKLING / VERMOUTH as vintage-sensitive
                       UPPER(product_type) IN ('WINE', 'SPARKLING', 'VERMOUTH') AS is_vintage_product
                FROM {src}
                WHERE wholesaler IN ($a, $b)
                  AND upc IS NOT NULL AND upc != '' AND upc != '0'
                  -- Drop obvious stub/placeholder UPCs
                  AND NOT regexp_matches(upc, '^(0+|9+|1+)$')
                  AND NOT upc LIKE '999999%'
                  AND LENGTH(upc) >= 8
                  -- Drop rows tied to a combo bundle: the case price on a
                  -- combo line is the bundle allocation, not standalone retail.
                  AND (combo_code IS NULL OR combo_code = '' OR combo_code = '0')
            ),
            a_side AS (
                SELECT n.* FROM norm n
                LEFT JOIN ambiguous amb
                  ON n.wholesaler = amb.wholesaler
                 AND n.upc_norm = amb.upc_norm
                 AND n.unit_volume IS NOT DISTINCT FROM amb.unit_volume
                WHERE n.wholesaler = $a AND n.edition = $ed_a
                  AND amb.upc_norm IS NULL
            ),
            b_side AS (
                SELECT n.* FROM norm n
                LEFT JOIN ambiguous amb
                  ON n.wholesaler = amb.wholesaler
                 AND n.upc_norm = amb.upc_norm
                 AND n.unit_volume IS NOT DISTINCT FROM amb.unit_volume
                WHERE n.wholesaler = $b AND n.edition = $ed_b
                  AND amb.upc_norm IS NULL
            )
            SELECT
                a.upc_norm,
                a.upc                       AS a_upc,
                b.upc                       AS b_upc,
                a.product_name              AS product_name,
                b.product_name              AS b_product_name,
                a.unit_volume               AS unit_volume,
                CAST(TRY_CAST(a.unit_qty AS DOUBLE) AS INTEGER) AS unit_qty,
                a.product_type              AS product_type,
                a.vintage_norm              AS a_vintage,
                b.vintage_norm              AS b_vintage,
                a.frontline_case_price      AS a_case,
                b.frontline_case_price      AS b_case,
                a.frontline_unit_price      AS a_btl_frontline,
                b.frontline_unit_price      AS b_btl_frontline,
                a.effective_case_price      AS a_effective,
                b.effective_case_price      AS b_effective,
                -- Per-bottle effective: case price divided by case quantity
                -- so a 6-pack and a 12-pack only compare like-for-like.
                CASE WHEN TRY_CAST(a.unit_qty AS DOUBLE) > 0
                     THEN a.effective_case_price / TRY_CAST(a.unit_qty AS DOUBLE)
                     ELSE NULL END           AS a_effective_per_bottle,
                CASE WHEN TRY_CAST(b.unit_qty AS DOUBLE) > 0
                     THEN b.effective_case_price / TRY_CAST(b.unit_qty AS DOUBLE)
                     ELSE NULL END           AS b_effective_per_bottle,
                a.rip_savings               AS a_rip_savings,
                b.rip_savings               AS b_rip_savings,
                a.has_discount              AS a_has_discount,
                b.has_discount              AS b_has_discount,
                a.has_rip                   AS a_has_rip,
                b.has_rip                   AS b_has_rip,
                (b.effective_case_price - a.effective_case_price) AS savings,
                CASE WHEN GREATEST(a.effective_case_price, b.effective_case_price) > 0
                     THEN (b.effective_case_price - a.effective_case_price)
                          / GREATEST(a.effective_case_price, b.effective_case_price) * 100
                     ELSE 0 END AS savings_pct,
                CASE
                    WHEN ABS(a.effective_case_price - b.effective_case_price) < 0.005 THEN 'Same'
                    WHEN a.effective_case_price < b.effective_case_price THEN $a_label
                    ELSE $b_label
                END AS cheaper
            FROM a_side a
            JOIN b_side b
              ON a.upc_norm = b.upc_norm
             AND a.unit_volume IS NOT DISTINCT FROM b.unit_volume
             -- unit_qty stored as '12' by Allied but '12.0' by Fedway, so cast
             -- to a number before comparing.
             AND TRY_CAST(a.unit_qty AS DOUBLE) IS NOT DISTINCT FROM TRY_CAST(b.unit_qty AS DOUBLE)
             -- Same product category (Wine vs Spirits vs Beer etc.) so we
             -- never accidentally compare a Spirit to a Wine that share UPC.
             AND a.product_type IS NOT DISTINCT FROM b.product_type
             -- For vintage-sensitive categories the vintage must match (both
             -- standardized to 4-digit). For all other categories vintage is
             -- ignored. If either side has a NULL vintage on a vintage product,
             -- we still allow the match (non-vintage wines like NV champagne).
             AND (
                 NOT (a.is_vintage_product OR b.is_vintage_product)
                 OR a.vintage_norm IS NOT DISTINCT FROM b.vintage_norm
                 OR a.vintage_norm IS NULL OR b.vintage_norm IS NULL
             )
            WHERE 1=1
              {cheaper_clause}
              AND ABS(CASE WHEN GREATEST(a.effective_case_price, b.effective_case_price) > 0
                           THEN (b.effective_case_price - a.effective_case_price)
                                / GREATEST(a.effective_case_price, b.effective_case_price) * 100
                           ELSE 0 END) >= $min_pct
            ORDER BY {sort_sql} {sort_dir} NULLS LAST
            LIMIT $limit
        """
        params = {
            "a": distributor_a, "b": distributor_b,
            "ed_a": ed_a, "ed_b": ed_b,
            "a_label": _display_name(distributor_a),
            "b_label": _display_name(distributor_b),
            "min_pct": float(min_abs_savings_pct),
            "limit": int(limit),
        }
        df = con.execute(sql, params).fetchdf()

        # True match count, ignoring the LIMIT, so the UI can show the real
        # total. Build a count query that strips ORDER BY and LIMIT lines.
        import re as _re
        count_sql = _re.sub(r'\bORDER BY .+?(?=LIMIT)', '', sql, flags=_re.DOTALL)
        count_sql = _re.sub(r'\bLIMIT\s+\$limit\b', '', count_sql)
        count_params = {k: v for k, v in params.items() if k != "limit"}
        try:
            total_unbounded = con.execute(
                f"SELECT COUNT(*) FROM ({count_sql}) t", count_params
            ).fetchone()[0]
        except Exception:
            total_unbounded = len(df)

        items = []
        for _, r in df.iterrows():
            rec = {}
            for k in df.columns:
                v = r[k]
                rec[k] = None if isinstance(v, float) and math.isnan(v) else v
            items.append(rec)

        return {
            "distributor_a": distributor_a,
            "distributor_b": distributor_b,
            "edition_a": ed_a,
            "edition_b": ed_b,
            "total": int(total_unbounded),
            "returned": len(items),
            "items": items,
        }


@router.get("/cross-distributor-combined")
def cross_distributor_combined(
    distributor: str = Query("opici", description="The distributor to test for being cheapest"),
    competitors: str = Query("allied,fedway", description="Comma-separated rivals (combined market)"),
    min_abs_savings_pct: float = Query(0.0, ge=0),
    sort: str = Query("abs_savings_pct", description="abs_savings_pct | savings | a_price | product"),
    order: str = Query("desc"),
    limit: int = Query(50, ge=1, le=50000),
):
    """Products where ``distributor`` beats the CHEAPEST of ``competitors`` combined.

    Identical matching rules to /cross-distributor (normalized UPC, unit_volume,
    pack count, product type, vintage, ambiguous-UPC + stub-UPC exclusion,
    effective price incl. CPL discount + per-case RIP). For each shared SKU it
    keeps the lowest-effective competitor and returns rows where ``distributor``
    undercuts it — i.e. it's the cheapest place to buy among all of them.
    """
    comp_list = [c.strip() for c in competitors.split(",") if c.strip() and c.strip() != distributor]
    if not comp_list:
        return {"distributor_a": distributor, "distributor_b": "", "combined": True,
                "competitors": [], "total": 0, "returned": 0, "items": []}
    all_ws = [distributor] + comp_list

    with get_duckdb() as con:
        src = read_parquet(con, "cpl_enriched")
        current_ym = _current_yyyy_mm()
        ws_ph = ", ".join(f"$ws{i}" for i in range(len(all_ws)))
        wp = {f"ws{i}": w for i, w in enumerate(all_ws)}
        eds = con.execute(f"""
            SELECT wholesaler,
                   COALESCE(MAX(CASE WHEN edition <= $cym THEN edition END), MAX(edition)) AS ed
            FROM {src} WHERE wholesaler IN ({ws_ph}) GROUP BY wholesaler
        """, {**wp, "cym": current_ym}).fetchdf()
        ed_map = dict(zip(eds["wholesaler"], eds["ed"]))
        ed_a = ed_map.get(distributor)
        comp_eds = [(w, ed_map[w]) for w in comp_list if ed_map.get(w)]
        if not ed_a or not comp_eds:
            return {"distributor_a": distributor, "distributor_b": "+".join(comp_list),
                    "combined": True, "competitors": comp_list, "total": 0, "returned": 0, "items": []}

        ed_pairs = ["(wholesaler = $a AND edition = $ed_a)"]
        params = {"a": distributor, "ed_a": ed_a}
        for i, (w, e) in enumerate(comp_eds):
            ed_pairs.append(f"(wholesaler = $cw{i} AND edition = $ce{i})")
            params[f"cw{i}"], params[f"ce{i}"] = w, e
        ed_filter = "(" + " OR ".join(ed_pairs) + ")"

        sort_map = {"abs_savings_pct": "ABS(savings_pct)", "savings": "savings",
                    "a_price": "a_effective", "product": "product_name"}
        sort_sql = sort_map.get(sort, "ABS(savings_pct)")
        sort_dir = "DESC" if order.lower() == "desc" else "ASC"
        vnorm = _vintage_norm_sql('vintage')

        sql = f"""
            WITH ambiguous AS (
                SELECT wholesaler, LTRIM(upc, '0') AS upc_norm, unit_volume
                FROM {src}
                WHERE {ed_filter} AND upc IS NOT NULL AND upc != '' AND upc != '0'
                GROUP BY wholesaler, upc_norm, unit_volume
                HAVING COUNT(DISTINCT product_name) > 1
            ),
            norm AS (
                SELECT *, LTRIM(upc, '0') AS upc_norm,
                       ({vnorm}) AS vintage_norm,
                       UPPER(product_type) IN ('WINE', 'SPARKLING', 'VERMOUTH') AS is_vintage_product
                FROM {src}
                WHERE {ed_filter}
                  AND upc IS NOT NULL AND upc != '' AND upc != '0'
                  AND NOT regexp_matches(upc, '^(0+|9+|1+)$') AND NOT upc LIKE '999999%' AND LENGTH(upc) >= 8
                  AND (combo_code IS NULL OR combo_code = '' OR combo_code = '0')
            ),
            clean AS (
                SELECT n.* FROM norm n
                LEFT JOIN ambiguous amb
                  ON n.wholesaler = amb.wholesaler AND n.upc_norm = amb.upc_norm
                 AND n.unit_volume IS NOT DISTINCT FROM amb.unit_volume
                WHERE amb.upc_norm IS NULL
            ),
            a_side AS (SELECT * FROM clean WHERE wholesaler = $a),
            comp_side AS (SELECT * FROM clean WHERE wholesaler <> $a),
            pairs AS (
                SELECT
                    a.upc_norm, a.upc AS a_upc, a.product_name, a.unit_volume,
                    CAST(TRY_CAST(a.unit_qty AS DOUBLE) AS INTEGER) AS unit_qty,
                    a.product_type, a.vintage_norm AS a_vintage,
                    a.frontline_case_price AS a_case, a.effective_case_price AS a_effective,
                    CASE WHEN TRY_CAST(a.unit_qty AS DOUBLE) > 0 THEN a.effective_case_price / TRY_CAST(a.unit_qty AS DOUBLE) END AS a_effective_per_bottle,
                    a.has_discount AS a_has_discount, a.has_rip AS a_has_rip,
                    c.wholesaler AS b_wholesaler, c.upc AS b_upc, c.product_name AS b_product_name,
                    c.vintage_norm AS b_vintage, c.frontline_case_price AS b_case,
                    c.effective_case_price AS b_effective,
                    CASE WHEN TRY_CAST(c.unit_qty AS DOUBLE) > 0 THEN c.effective_case_price / TRY_CAST(c.unit_qty AS DOUBLE) END AS b_effective_per_bottle,
                    c.has_discount AS b_has_discount, c.has_rip AS b_has_rip,
                    ROW_NUMBER() OVER (
                        PARTITION BY a.upc_norm, a.unit_volume, TRY_CAST(a.unit_qty AS DOUBLE), a.vintage_norm, a.product_name
                        ORDER BY c.effective_case_price ASC
                    ) AS rn
                FROM a_side a
                JOIN comp_side c
                  ON a.upc_norm = c.upc_norm
                 AND a.unit_volume IS NOT DISTINCT FROM c.unit_volume
                 AND TRY_CAST(a.unit_qty AS DOUBLE) IS NOT DISTINCT FROM TRY_CAST(c.unit_qty AS DOUBLE)
                 AND a.product_type IS NOT DISTINCT FROM c.product_type
                 AND (
                     NOT (a.is_vintage_product OR c.is_vintage_product)
                     OR a.vintage_norm IS NOT DISTINCT FROM c.vintage_norm
                     OR a.vintage_norm IS NULL OR c.vintage_norm IS NULL
                 )
            )
            SELECT *,
                (b_effective - a_effective) AS savings,
                CASE WHEN GREATEST(a_effective, b_effective) > 0
                     THEN (b_effective - a_effective) / GREATEST(a_effective, b_effective) * 100
                     ELSE 0 END AS savings_pct
            FROM pairs
            WHERE rn = 1
              AND a_effective < b_effective
              AND ABS(CASE WHEN GREATEST(a_effective, b_effective) > 0
                           THEN (b_effective - a_effective) / GREATEST(a_effective, b_effective) * 100
                           ELSE 0 END) >= $min_pct
            ORDER BY {sort_sql} {sort_dir} NULLS LAST
            LIMIT $limit
        """
        params.update({"min_pct": float(min_abs_savings_pct), "limit": int(limit)})
        df = con.execute(sql, params).fetchdf()

        items = []
        for _, r in df.iterrows():
            rec = {}
            for k in df.columns:
                v = r[k]
                rec[k] = None if isinstance(v, float) and math.isnan(v) else v
            rec["cheaper"] = _display_name(distributor)
            items.append(rec)

        return {
            "distributor_a": distributor,
            "distributor_b": "+".join(comp_list),
            "combined": True,
            "competitors": comp_list,
            "edition_a": ed_a,
            "total": len(items),
            "returned": len(items),
            "items": items,
        }


@router.get("/qa/anomalies")
def qa_anomalies(
    limit_per_check: int = Query(20, ge=1, le=200),
    edition: Optional[str] = None,
):
    """Run a battery of data-quality checks and return suspicious rows.

    Each check returns up to ``limit_per_check`` rows with a ``reason`` code
    explaining what's suspicious. Designed to be re-run after every ETL so
    we can fix new issues as they appear in source data.
    """
    with get_duckdb() as con:
        src = read_parquet(con, "cpl_enriched")
        if not edition:
            edition = _current_yyyy_mm()
            row = con.execute(
                f"SELECT COALESCE(MAX(CASE WHEN edition <= $ed THEN edition END), MAX(edition)) FROM {src}",
                {"ed": edition}
            ).fetchone()
            edition = row[0] if row else None

        checks = {}

        # 1. Ambiguous UPCs — one UPC mapped to >1 distinct product within a
        #    wholesaler+unit_volume, in this edition. Excludes stubs.
        checks["ambiguous_upcs"] = con.execute(f"""
            SELECT wholesaler, upc, unit_volume,
                   COUNT(DISTINCT product_name) AS distinct_products,
                   STRING_AGG(DISTINCT product_name, ' | ') AS products
            FROM {src}
            WHERE edition = $ed
              AND upc IS NOT NULL AND upc != '' AND upc != '0'
              AND NOT regexp_matches(upc, '^(0+|9+|1+)$')
              AND LENGTH(upc) >= 8
            GROUP BY wholesaler, upc, unit_volume
            HAVING COUNT(DISTINCT product_name) > 1
            ORDER BY distinct_products DESC
            LIMIT $lim
        """, {"ed": edition, "lim": limit_per_check}).fetchdf().to_dict(orient="records")

        # 2. Multi-token rip_code (whitespace inside, e.g. Fedway "10049 30017").
        checks["multi_token_rip_codes"] = con.execute(f"""
            SELECT wholesaler, upc, product_name, unit_volume, rip_code
            FROM {src}
            WHERE edition = $ed
              AND rip_code IS NOT NULL
              AND regexp_matches(rip_code, '\\s')
            LIMIT $lim
        """, {"ed": edition, "lim": limit_per_check}).fetchdf().to_dict(orient="records")

        # 3. Same wholesaler/product/volume listed under BOTH a stub UPC and a
        #    real UPC in the same edition (causes price-comparison cartesian).
        checks["stub_plus_real_upc_dupes"] = con.execute(f"""
            WITH per_listing AS (
                SELECT wholesaler, product_name, unit_volume, unit_qty,
                       upc, frontline_case_price,
                       CASE WHEN upc = '0' OR upc = '' OR upc IS NULL THEN 'stub' ELSE 'real' END AS kind
                FROM {src}
                WHERE edition = $ed
            )
            SELECT wholesaler, product_name, unit_volume,
                   COUNT(*) FILTER (WHERE kind = 'stub') AS stub_rows,
                   COUNT(*) FILTER (WHERE kind = 'real') AS real_rows,
                   STRING_AGG(DISTINCT CAST(frontline_case_price AS VARCHAR), ', ') AS prices
            FROM per_listing
            GROUP BY wholesaler, product_name, unit_volume
            HAVING COUNT(*) FILTER (WHERE kind = 'stub') > 0
               AND COUNT(*) FILTER (WHERE kind = 'real') > 0
            ORDER BY stub_rows + real_rows DESC
            LIMIT $lim
        """, {"ed": edition, "lim": limit_per_check}).fetchdf().to_dict(orient="records")

        # 4. unit_qty change for same (wholesaler, upc, product_name, volume)
        #    across editions — distorts case-price comparisons.
        checks["unit_qty_changes"] = con.execute(f"""
            WITH per_ed AS (
                SELECT wholesaler, upc, product_name, unit_volume, edition,
                       TRY_CAST(unit_qty AS DOUBLE) AS qty,
                       frontline_case_price
                FROM {src}
                WHERE upc IS NOT NULL AND upc != '' AND upc != '0'
                  AND LENGTH(upc) >= 8
            )
            SELECT wholesaler, upc, product_name, unit_volume,
                   COUNT(DISTINCT qty) AS distinct_qty,
                   STRING_AGG(DISTINCT CONCAT(edition, ':', CAST(qty AS VARCHAR), 'x@$', CAST(frontline_case_price AS VARCHAR)), ' | ') AS history
            FROM per_ed
            GROUP BY wholesaler, upc, product_name, unit_volume
            HAVING COUNT(DISTINCT qty) > 1
            ORDER BY distinct_qty DESC
            LIMIT $lim
        """, {"lim": limit_per_check}).fetchdf().to_dict(orient="records")

        # 5. Frontline case price changes >50% between editions for same SKU.
        checks["price_jumps_gt_50pct"] = con.execute(f"""
            WITH ranked AS (
                SELECT *,
                       LAG(frontline_case_price) OVER (
                           PARTITION BY wholesaler, upc, product_name, unit_volume,
                                        TRY_CAST(unit_qty AS DOUBLE)
                           ORDER BY edition
                       ) AS prev_price,
                       LAG(edition) OVER (
                           PARTITION BY wholesaler, upc, product_name, unit_volume,
                                        TRY_CAST(unit_qty AS DOUBLE)
                           ORDER BY edition
                       ) AS prev_edition
                FROM {src}
                WHERE upc IS NOT NULL AND upc != '' AND upc != '0'
                  AND LENGTH(upc) >= 8
                  AND (combo_code IS NULL OR combo_code = '' OR combo_code = '0')
            )
            SELECT wholesaler, upc, product_name, unit_volume, unit_qty,
                   prev_edition, edition,
                   prev_price, frontline_case_price AS curr_price,
                   ROUND((frontline_case_price - prev_price) / prev_price * 100, 1) AS pct_change
            FROM ranked
            WHERE prev_price IS NOT NULL AND prev_price > 0
              AND ABS((frontline_case_price - prev_price) / prev_price) > 0.5
            ORDER BY ABS((frontline_case_price - prev_price) / prev_price) DESC
            LIMIT $lim
        """, {"lim": limit_per_check}).fetchdf().to_dict(orient="records")

        # 6. effective_case_price > frontline_case_price (computational bug)
        checks["effective_above_frontline"] = con.execute(f"""
            SELECT wholesaler, edition, upc, product_name, unit_volume,
                   frontline_case_price, best_case_price, effective_case_price,
                   rip_savings
            FROM {src}
            WHERE edition = $ed
              AND effective_case_price IS NOT NULL
              AND frontline_case_price IS NOT NULL
              AND effective_case_price > frontline_case_price + 0.01
            LIMIT $lim
        """, {"ed": edition, "lim": limit_per_check}).fetchdf().to_dict(orient="records")

        # 7. Negative effective price (shouldn't happen, GREATEST clamps to 0)
        checks["negative_effective"] = con.execute(f"""
            SELECT wholesaler, edition, upc, product_name, unit_volume,
                   frontline_case_price, effective_case_price, rip_savings
            FROM {src}
            WHERE edition = $ed
              AND effective_case_price < 0
            LIMIT $lim
        """, {"ed": edition, "lim": limit_per_check}).fetchdf().to_dict(orient="records")

        # 8. Per-bottle price outliers within product_type (>3 stdev from category median)
        checks["per_bottle_outliers"] = con.execute(f"""
            WITH per_btl AS (
                SELECT wholesaler, upc, product_name, product_type, unit_volume,
                       frontline_case_price, unit_qty,
                       frontline_case_price / TRY_CAST(unit_qty AS DOUBLE) AS per_btl
                FROM {src}
                WHERE edition = $ed
                  AND TRY_CAST(unit_qty AS DOUBLE) > 0
                  AND upc IS NOT NULL AND upc != '' AND upc != '0'
                  AND LENGTH(upc) >= 8
                  AND (combo_code IS NULL OR combo_code = '' OR combo_code = '0')
            ),
            stats AS (
                SELECT product_type,
                       APPROX_QUANTILE(per_btl, 0.5) AS median,
                       APPROX_QUANTILE(per_btl, 0.99) AS p99
                FROM per_btl
                GROUP BY product_type
            )
            SELECT p.wholesaler, p.upc, p.product_name, p.product_type, p.unit_volume,
                   p.unit_qty, p.frontline_case_price,
                   ROUND(p.per_btl, 2) AS per_btl,
                   ROUND(s.median, 2) AS category_median_per_btl,
                   ROUND(p.per_btl / NULLIF(s.median, 0), 2) AS x_median
            FROM per_btl p
            JOIN stats s USING (product_type)
            WHERE p.per_btl > s.p99 OR p.per_btl < s.median * 0.1
            ORDER BY ABS(p.per_btl - s.median) DESC
            LIMIT $lim
        """, {"ed": edition, "lim": limit_per_check}).fetchdf().to_dict(orient="records")

        # 9. Vintage format anomalies — any value that isn't empty/2-digit/4-digit
        checks["vintage_format_anomalies"] = con.execute(f"""
            SELECT wholesaler, edition, upc, product_name, unit_volume, vintage,
                   LENGTH(vintage) AS len
            FROM {src}
            WHERE edition = $ed
              AND vintage IS NOT NULL AND vintage != ''
              AND NOT regexp_matches(vintage, '^[0-9]{{2}}$')
              AND NOT regexp_matches(vintage, '^[0-9]{{4}}$')
              AND UPPER(vintage) NOT IN ('NA', 'N/A', 'NONE', 'NV')
            LIMIT $lim
        """, {"ed": edition, "lim": limit_per_check}).fetchdf().to_dict(orient="records")

        # Clean NaNs
        import math as _math
        for k, rows in checks.items():
            for r in rows:
                for kk, vv in list(r.items()):
                    if isinstance(vv, float) and _math.isnan(vv):
                        r[kk] = None

        summary = {
            "edition_checked": edition,
            "checks": {
                k: {
                    "count_returned": len(v),
                    "limit": limit_per_check,
                    "rows": v,
                }
                for k, v in checks.items()
            },
            "totals": {k: len(v) for k, v in checks.items()},
        }
        return summary


@router.get("/distributor-exclusive")
def distributor_exclusive(
    distributor: str = Query(..., description="Distributor whose exclusives to return"),
    compared_to: str = Query(..., description="Other distributor to subtract"),
    sort: str = Query("frontline_case_price", description="frontline_case_price | product_name | effective_case_price"),
    order: str = Query("desc"),
    limit: int = Query(50, ge=1, le=50000),
):
    """Products available at ``distributor`` but not at ``compared_to``.

    Joins by normalized UPC + unit_volume + product_type (and vintage for
    wines). Uses the current edition per wholesaler. Returns the rows from
    ``distributor`` whose UPC has no counterpart in ``compared_to``.
    """
    with get_duckdb() as con:
        src = read_parquet(con, "cpl_enriched")
        current_ym = _current_yyyy_mm()
        eds = con.execute(f"""
            SELECT wholesaler,
                   COALESCE(MAX(CASE WHEN edition <= $current_ym THEN edition END), MAX(edition)) AS ed
            FROM {src}
            WHERE wholesaler IN ($self, $other)
            GROUP BY wholesaler
        """, {"current_ym": current_ym, "self": distributor, "other": compared_to}).fetchdf()
        ed_map = dict(zip(eds["wholesaler"], eds["ed"]))
        ed_self = ed_map.get(distributor)
        ed_other = ed_map.get(compared_to)
        if not ed_self or not ed_other:
            return {"distributor": distributor, "compared_to": compared_to,
                    "edition": ed_self, "compared_edition": ed_other,
                    "total": 0, "items": []}

        sort_map = {
            "frontline_case_price": "frontline_case_price",
            "effective_case_price": "effective_case_price",
            "product_name": "product_name",
        }
        sort_sql = sort_map.get(sort, "frontline_case_price")
        sort_dir = "DESC" if order.lower() == "desc" else "ASC"

        sql = f"""
            WITH norm AS (
                SELECT *,
                       LTRIM(upc, '0') AS upc_norm
                FROM {src}
                WHERE wholesaler IN ($self, $other)
                  AND upc IS NOT NULL AND upc != '' AND upc != '0'
                  AND NOT regexp_matches(upc, '^(0+|9+|1+)$')
                  AND NOT upc LIKE '999999%'
                  AND LENGTH(upc) >= 8
                  -- Drop combo-bundle rows (the case price is the bundle slot,
                  -- not standalone retail).
                  AND (combo_code IS NULL OR combo_code = '' OR combo_code = '0')
            ),
            ambiguous AS (
                -- Drop UPCs that aren't unique product identifiers within a
                -- wholesaler+volume, since those create false matches.
                SELECT wholesaler, upc_norm, unit_volume
                FROM norm
                WHERE (wholesaler = $self AND edition = $ed_self)
                   OR (wholesaler = $other AND edition = $ed_other)
                GROUP BY wholesaler, upc_norm, unit_volume
                HAVING COUNT(DISTINCT product_name) > 1
            ),
            self_clean AS (
                SELECT n.* FROM norm n
                LEFT JOIN ambiguous amb
                  ON n.wholesaler = amb.wholesaler
                 AND n.upc_norm = amb.upc_norm
                 AND n.unit_volume IS NOT DISTINCT FROM amb.unit_volume
                WHERE n.wholesaler = $self AND n.edition = $ed_self
                  AND amb.upc_norm IS NULL
            ),
            other_keys AS (
                SELECT DISTINCT upc_norm, unit_volume
                FROM norm
                WHERE wholesaler = $other AND edition = $ed_other
            )
            SELECT
                s.wholesaler,
                s.edition,
                s.upc,
                s.upc_norm,
                s.product_name,
                s.product_type,
                s.unit_volume,
                CAST(TRY_CAST(s.unit_qty AS DOUBLE) AS INTEGER) AS unit_qty,
                s.frontline_case_price,
                s.effective_case_price,
                s.has_discount,
                s.has_rip,
                s.discount_pct,
                s.rip_savings,
                CASE WHEN TRY_CAST(s.unit_qty AS DOUBLE) > 0
                     THEN s.effective_case_price / TRY_CAST(s.unit_qty AS DOUBLE)
                     ELSE NULL END AS effective_per_bottle
            FROM self_clean s
            LEFT JOIN other_keys o
              ON s.upc_norm = o.upc_norm
             AND s.unit_volume IS NOT DISTINCT FROM o.unit_volume
            WHERE o.upc_norm IS NULL
            ORDER BY {sort_sql} {sort_dir} NULLS LAST
            LIMIT $limit
        """
        params = {
            "self": distributor, "other": compared_to,
            "ed_self": ed_self, "ed_other": ed_other,
            "limit": int(limit),
        }
        df = con.execute(sql, params).fetchdf()

        import re as _re
        count_sql = _re.sub(r'\bORDER BY .+?(?=LIMIT)', '', sql, flags=_re.DOTALL)
        count_sql = _re.sub(r'\bLIMIT\s+\$limit\b', '', count_sql)
        count_params = {k: v for k, v in params.items() if k != "limit"}
        try:
            total_unbounded = con.execute(
                f"SELECT COUNT(*) FROM ({count_sql}) t", count_params
            ).fetchone()[0]
        except Exception:
            total_unbounded = len(df)

        items = []
        for _, r in df.iterrows():
            rec = {}
            for k in df.columns:
                v = r[k]
                rec[k] = None if isinstance(v, float) and math.isnan(v) else v
            items.append(rec)

        return {
            "distributor": distributor,
            "compared_to": compared_to,
            "edition": ed_self,
            "compared_edition": ed_other,
            "total": int(total_unbounded),
            "returned": len(items),
            "items": items,
        }


@router.get("/facets")
def search_facets(
    q: str = Query("", description="Search term"),
    wholesaler: Optional[str] = None,
    edition: Optional[str] = None,
    divisions: Optional[str] = None,
    categories: Optional[str] = None,
    brands: Optional[str] = None,
    sizes: Optional[str] = None,
    min_price: Optional[float] = None,
    max_price: Optional[float] = None,
    has_rip: Optional[bool] = None,
    has_discount: Optional[bool] = None,
):
    """Drill-down facet counts. Each facet's counts honour all the OTHER active
    filters (but not its own dimension), so the numbers reconcile with the
    results you actually see. `total` reflects every active filter.
    """
    with get_duckdb() as con:
        src = read_parquet(con, "cpl_enriched")

        if not edition:
            current_ym = _current_yyyy_mm()
            max_eds = con.execute(f"""
                SELECT wholesaler,
                       MAX(CASE WHEN edition <= $current_ym THEN edition END) AS current_ed,
                       MAX(edition) AS latest_ed
                FROM {src}
                GROUP BY wholesaler
            """, {"current_ym": current_ym}).fetchdf()
            latest_map = {
                r["wholesaler"]: r["current_ed"] or r["latest_ed"]
                for _, r in max_eds.iterrows()
            }

        # ---- base scope: search box + edition (always applied) ----
        base = ["1=1"]
        bp: dict = {}
        if q:
            clause, qp = _q_clause(q)
            base.append(clause)
            bp.update(qp)
        if wholesaler:
            base.append("wholesaler = $wholesaler")
            bp["wholesaler"] = wholesaler
        if edition:
            base.append("edition = $edition")
            bp["edition"] = edition
        elif wholesaler and wholesaler in latest_map:
            base.append("edition = $latest_ed")
            bp["latest_ed"] = latest_map[wholesaler]
        elif not edition:
            ed_conditions = []
            for i, (ws, ed) in enumerate(latest_map.items()):
                base.append  # noqa (placeholder to keep structure clear)
                ed_conditions.append(f"(wholesaler = $ws_{i} AND edition = $ed_{i})")
                bp[f"ws_{i}"] = ws
                bp[f"ed_{i}"] = ed
            if ed_conditions:
                base.append(f"({' OR '.join(ed_conditions)})")

        # ---- active filter predicates, each tagged with its dimension ----
        preds: list[dict] = []

        def add_in(dim, column, csv, prefix):
            vals = [v.strip() for v in (csv or "").split(",") if v.strip()]
            if not vals:
                return
            keys, pp = [], {}
            for i, v in enumerate(vals):
                k = f"{prefix}{i}"; pp[k] = v; keys.append(f"${k}")
            preds.append({"dim": dim, "sql": f"{column} IN ({', '.join(keys)})", "params": pp})

        add_in("div", "wholesaler", divisions, "fdiv_")
        add_in("cat", "product_type", categories, "fcat_")
        add_in("brand", "brand", brands, "fbrnd_")
        add_in("size", "COALESCE(unit_volume_std, unit_volume)", sizes, "fsize_")
        if min_price is not None or max_price is not None:
            parts, pp = [], {}
            if min_price is not None: parts.append("frontline_case_price >= $fmin"); pp["fmin"] = min_price
            if max_price is not None: parts.append("frontline_case_price <= $fmax"); pp["fmax"] = max_price
            preds.append({"dim": "price", "sql": "(" + " AND ".join(parts) + ")", "params": pp})
        if has_rip is not None:
            preds.append({"dim": "rip", "sql": f"has_rip = {'true' if has_rip else 'false'}", "params": {}})
        if has_discount is not None:
            preds.append({"dim": "disc", "sql": f"has_discount = {'true' if has_discount else 'false'}", "params": {}})

        def build(exclude=None):
            clauses = list(base)
            p = dict(bp)
            for pr in preds:
                if pr["dim"] == exclude:
                    continue
                clauses.append(pr["sql"])
                p.update(pr["params"])
            return " AND ".join(clauses), p

        def count(exclude=None):
            wc, p = build(exclude)
            return int(con.execute(f"SELECT count(*) FROM {src} WHERE {wc}", p).fetchone()[0])

        def grouped(column, exclude, extra=""):
            wc, p = build(exclude)
            extra_sql = f" AND {extra}" if extra else ""
            df = con.execute(f"""
                SELECT {column} AS key, count(*) AS n
                FROM {src} WHERE {wc} AND {column} IS NOT NULL AND {column} != ''{extra_sql}
                GROUP BY {column} ORDER BY n DESC
            """, p).fetchdf()
            return [{"key": r["key"], "count": int(r["n"])} for _, r in df.iterrows()]

        wc, p = build("rip")
        rf = con.execute(f"SELECT count(*) FILTER (WHERE has_rip) a, count(*) FILTER (WHERE NOT has_rip) b FROM {src} WHERE {wc}", p).fetchdf().iloc[0]
        wc, p = build("disc")
        dfl = con.execute(f"SELECT count(*) FILTER (WHERE has_discount) a, count(*) FILTER (WHERE NOT has_discount) b FROM {src} WHERE {wc}", p).fetchdf().iloc[0]
        wc, p = build(None)
        cf = con.execute(f"SELECT count(*) FILTER (WHERE has_closeout) a, count(*) FILTER (WHERE NOT has_closeout) b FROM {src} WHERE {wc}", p).fetchdf().iloc[0]
        # In-combo count (products that belong to a bundle), so the "In combo"
        # filter can show a count like Has RIP / Has discount. in_combo is a
        # derived cache column; guard in case it is absent (parquet dev with no
        # combo table / older cache).
        try:
            wc, p = build(None)
            mf = con.execute(f"SELECT count(*) FILTER (WHERE in_combo) a, count(*) FILTER (WHERE NOT in_combo) b FROM {src} WHERE {wc}", p).fetchdf().iloc[0]
            has_combo, no_combo = int(mf["a"]), int(mf["b"])
        except Exception:
            has_combo, no_combo = 0, 0

        return {
            "total": count(None),
            "has_rip": int(rf["a"]), "no_rip": int(rf["b"]),
            "has_discount": int(dfl["a"]), "no_discount": int(dfl["b"]),
            "has_closeout": int(cf["a"]), "no_closeout": int(cf["b"]),
            "has_combo": has_combo, "no_combo": no_combo,
            "divisions": grouped("wholesaler", "div"),
            # Exclude product_type='Combo' (a handful of bundle-header rows); the
            # real "in a combo" concept is the In combo filter, counted above.
            "categories": grouped("product_type", "cat", "product_type <> 'Combo'"),
            "brands": grouped("brand", "brand"),
            "sizes": grouped("COALESCE(unit_volume_std, unit_volume)", "size"),
        }


@router.get("/editions")
def list_editions():
    """List all available editions per wholesaler."""
    with get_duckdb() as con:
        src = read_parquet(con, "cpl")
        df = con.execute(f"""
            SELECT wholesaler, edition, count(*) as item_count
            FROM {src}
            GROUP BY wholesaler, edition
            ORDER BY wholesaler, edition
        """).fetchdf()
        results = df.to_dict(orient="records")
        for r in results:
            r["display_name"] = _display_name(r["wholesaler"])
        return results


@router.get("/categories")
def list_categories(wholesaler: Optional[str] = None, edition: Optional[str] = None):
    """List product types with item counts."""
    with get_duckdb() as con:
        src = read_parquet(con, "cpl_enriched")
        where = ["product_type IS NOT NULL"]
        params = {}
        if wholesaler:
            where.append("wholesaler = $wholesaler")
            params["wholesaler"] = wholesaler
        if edition:
            where.append("edition = $edition")
            params["edition"] = edition

        df = con.execute(f"""
            SELECT product_type, count(*) as count
            FROM {src}
            WHERE {' AND '.join(where)}
            GROUP BY product_type
            ORDER BY count DESC
        """, params).fetchdf()
        return df.to_dict(orient="records")


@router.get("/product-breakdown/{wholesaler}/{product_name:path}")
def get_product_breakdown(
    wholesaler: str,
    product_name: str,
    upc: Optional[str] = None,
    unit_volume: Optional[str] = None,
    unit_qty: Optional[str] = None,
    vintage: Optional[str] = None,
):
    """Per-edition pricing breakdown including discount and RIP tiers.

    Returns one row per edition (month) for the product, with case price,
    best CPL discount, per-case RIP savings, effective price, and the
    discount + RIP tiers that applied in that edition. Optional ``vintage``
    (normalized year) scopes the timeline to one vintage of a reused UPC.
    """
    with get_duckdb() as con:
        src = read_parquet(con, "cpl_enriched")
        rip_src = read_parquet(con, "rip")

        where = ["wholesaler = $wholesaler", "product_name = $product_name"]
        params = {"wholesaler": wholesaler, "product_name": product_name}
        if upc:
            where.append("upc = $upc")
            params["upc"] = upc
        if unit_volume:
            where.append("unit_volume = $unit_volume")
            params["unit_volume"] = unit_volume
        if unit_qty:
            where.append("TRY_CAST(unit_qty AS DOUBLE) = TRY_CAST($uq AS DOUBLE)")
            params["uq"] = unit_qty
        if vintage:
            where.append(f"({_vintage_norm_sql('vintage')}) = $vnorm")
            params["vnorm"] = vintage

        rows = con.execute(f"""
            SELECT edition, upc, unit_volume, unit_qty, rip_code, product_type,
                   {_vintage_norm_sql()} AS vintage_norm,
                   frontline_case_price, frontline_unit_price,
                   best_case_price, effective_case_price,
                   has_discount, has_rip, discount_pct, rip_savings,
                   discount_1_qty, discount_1_amt,
                   discount_2_qty, discount_2_amt,
                   discount_3_qty, discount_3_amt,
                   discount_4_qty, discount_4_amt,
                   discount_5_qty, discount_5_amt
            FROM {src}
            WHERE {' AND '.join(where)}
            ORDER BY edition
        """, params).fetchdf()

        if rows.empty:
            return {"editions": []}

        # One row per (edition, vintage): a UPC can map to several pack sizes /
        # dupe rows within a month — collapse them so the timeline has a single
        # line per edition (wine keeps its distinct vintages).
        rows = rows.sort_values("edition").drop_duplicates(subset=["edition", "vintage_norm"], keep="first")

        # Batch fetch RIP rows for all (rip_code, edition) we need
        codes = sorted({(str(r["rip_code"]), r["edition"], str(r["upc"]))
                        for _, r in rows.iterrows()
                        if r.get("rip_code") and str(r["rip_code"]) not in ("None", "nan", "0", "")})
        rip_lookup = {}
        rip_by_code = {}
        if codes:
            ws_unique = {wholesaler}
            ed_unique = {c[1] for c in codes}
            code_unique = {c[0] for c in codes}
            cp = {}
            ph_c = ", ".join(f"$rc_{i}" for i in range(len(code_unique)))
            ph_e = ", ".join(f"$re_{i}" for i in range(len(ed_unique)))
            for i, v in enumerate(sorted(code_unique)): cp[f"rc_{i}"] = v
            for i, v in enumerate(sorted(ed_unique)): cp[f"re_{i}"] = v
            cp["wholesaler"] = wholesaler
            rip_df = con.execute(f"""
                SELECT rip_code, edition, upc, rip_description,
                       rip_unit_1, rip_qty_1, rip_amt_1,
                       rip_unit_2, rip_qty_2, rip_amt_2,
                       rip_unit_3, rip_qty_3, rip_amt_3,
                       rip_unit_4, rip_qty_4, rip_amt_4
                FROM {rip_src}
                WHERE wholesaler = $wholesaler
                  AND rip_code IN ({ph_c})
                  AND edition IN ({ph_e})
            """, cp).fetchdf()
            for _, r in rip_df.iterrows():
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
                rip_lookup.setdefault((str(r["rip_code"]), r["edition"], str(r.get("upc") or "")), []).extend(tiers_here)
                rip_by_code.setdefault((str(r["rip_code"]), r["edition"]), []).extend(tiers_here)

        editions = []
        for _, r in rows.iterrows():
            cp = float(r["frontline_case_price"]) if r.get("frontline_case_price") else 0.0

            # Discount tiers
            disc = []
            for i in range(1, 6):
                amt = r.get(f"discount_{i}_amt")
                if amt is None or (isinstance(amt, float) and math.isnan(amt)) or amt <= 0:
                    continue
                qty_raw = r.get(f"discount_{i}_qty")
                m = re.match(r"^\s*(\d+(?:\.\d+)?)\s*(.*)$", str(qty_raw or ""))
                if not m:
                    continue
                try:
                    qty_n = int(float(m.group(1)))
                except (TypeError, ValueError):
                    continue
                tail = (m.group(2) or "").lower().strip()
                unit = "Bottles" if tail.startswith("bottle") or tail in ("b", "btl", "bottles") else "Cases"
                disc.append({
                    "qty": qty_n,
                    "unit": unit,
                    "amount": float(amt),
                })

            # RIP tiers — try (code, ed, upc), else (code, ed)
            rc = str(r.get("rip_code") or "")
            ed = r["edition"]
            up = str(r.get("upc") or "")
            rip_raw = rip_lookup.get((rc, ed, up)) or rip_by_code.get((rc, ed), [])
            seen = set()
            rip_tiers = []
            for t in rip_raw:
                sig = (t["qty"], t["unit"].lower(), round(t["amount"], 2))
                if sig in seen:
                    continue
                seen.add(sig)
                rip_tiers.append(t)
            rip_tiers.sort(key=lambda x: x["qty"])

            # Best per-case discount on Cases-unit tiers
            best_disc = max(
                (d["amount"] for d in disc if d["unit"].lower().startswith("case")),
                default=0.0,
            )
            # Max per-case RIP savings across tiers. Bottle-unit tiers are
            # per-bottle → ×pack (unit_qty) for an apples-to-apples per-case figure.
            try:
                r_pack = float(r.get("unit_qty") or 0)
            except (TypeError, ValueError):
                r_pack = 0.0
            max_rip_per_case = max(
                (_rip_per_case(t["amount"], t["qty"], t["unit"], r_pack)
                 for t in rip_tiers if t["qty"] > 0),
                default=0.0,
            )

            editions.append({
                "edition": ed,
                "upc": up,
                "vintage": _clean_vintage(r.get("vintage_norm")),
                "unit_volume": r["unit_volume"],
                "rip_code": rc if rc and rc not in ("None", "nan", "0", "") else None,
                "frontline_case_price": cp,
                "frontline_unit_price": float(r["frontline_unit_price"]) if r.get("frontline_unit_price") and not (isinstance(r["frontline_unit_price"], float) and math.isnan(r["frontline_unit_price"])) else None,
                "best_case_price": float(r["best_case_price"]) if r.get("best_case_price") and not (isinstance(r["best_case_price"], float) and math.isnan(r["best_case_price"])) else None,
                "effective_case_price": float(r["effective_case_price"]) if r.get("effective_case_price") and not (isinstance(r["effective_case_price"], float) and math.isnan(r["effective_case_price"])) else None,
                "best_discount_per_case": round(best_disc, 2),
                "best_rip_per_case": round(max_rip_per_case, 2),
                "total_save_per_case": round(best_disc + max_rip_per_case, 2),
                "has_discount": bool(r.get("has_discount")),
                "has_rip": bool(r.get("has_rip")),
                "discount_tiers": disc,
                "rip_tiers": [
                    {
                        "qty": t["qty"],
                        "unit": t["unit"],
                        "amount": t["amount"],
                        "save_per_case": round(_rip_per_case(t["amount"], t["qty"], t["unit"], r_pack), 2),
                    }
                    for t in rip_tiers
                ],
            })

        return {"editions": editions}


@router.get("/price-history/{wholesaler}/{product_name:path}")
def get_price_history(
    wholesaler: str,
    product_name: str,
    upc: Optional[str] = None,
    unit_volume: Optional[str] = None,
    unit_qty: Optional[str] = None,
    vintage: Optional[str] = None,
):
    """Price history across all editions for a product.

    Accepts optional ``upc`` and ``unit_volume`` to scope the timeline to a
    single SKU (a product_name can cover several sizes/UPCs), and an optional
    ``vintage`` (normalized year) to scope it to one vintage — the same UPC is
    reused across vintages, so a vintage-specific view must not merge them.
    """
    with get_duckdb() as con:
        src = read_parquet(con, "cpl_enriched")

        where = ["wholesaler = $wholesaler", "product_name = $product_name"]
        params = {"wholesaler": wholesaler, "product_name": product_name}
        if upc:
            where.append("upc = $upc")
            params["upc"] = upc
        if unit_volume:
            where.append("unit_volume = $unit_volume")
            params["unit_volume"] = unit_volume
        if unit_qty:
            where.append("TRY_CAST(unit_qty AS DOUBLE) = TRY_CAST($uq AS DOUBLE)")
            params["uq"] = unit_qty
        if vintage:
            where.append(f"({_vintage_norm_sql('vintage')}) = $vnorm")
            params["vnorm"] = vintage

        df = con.execute(f"""
            SELECT edition, product_type, {_vintage_norm_sql()} AS vintage_norm,
                   frontline_case_price, best_case_price,
                   effective_case_price, discount_pct, has_discount, has_rip
            FROM {src}
            WHERE {' AND '.join(where)}
            ORDER BY edition
        """, params).fetchdf()

        if df.empty:
            return {"history": [], "stats": None}

        # One point per edition (a UPC carries a single vintage per edition).
        # Keep vintage on each point so the chart can split the line where the
        # vintage changes (a vintage swap is not a real price move).
        df = df.drop_duplicates(subset=["edition"], keep="first").sort_values("edition")
        df = df.rename(columns={"vintage_norm": "vintage"}).drop(columns=["product_type"])
        df["vintage"] = df["vintage"].apply(_clean_vintage)

        stats = {
            "min_price": float(df["frontline_case_price"].min()),
            "max_price": float(df["frontline_case_price"].max()),
            "avg_price": round(float(df["frontline_case_price"].mean()), 2),
            "current_price": float(df.iloc[-1]["frontline_case_price"]),
            "editions_count": len(df),
            "trend": _classify_trend(df["frontline_case_price"].tolist()),
        }

        return {"history": df.to_dict(orient="records"), "stats": stats}


def _classify_trend(prices: list) -> str:
    if len(prices) < 2:
        return "stable"
    recent = prices[-1]
    prev = prices[-2]
    if recent > prev:
        return "rising"
    elif recent < prev:
        return "falling"
    return "stable"
