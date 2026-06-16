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
from backend.enrichment_join import attach_sku_mapping as _attach_sku_mapping
from backend.rip_utils import is_bottle_unit as _is_bottle_unit, rip_per_case as _rip_per_case, rip_bundle_cost as _rip_bundle_cost, normalize_unit as _norm_unit
# Canonical pricing helpers live in backend/pricing.py — every router, the
# assistant engine and MCP read from there so a formula change ripples
# through every surface (see backend/FOUNDATION.md).
from backend import pricing as _pricing


def _current_yyyy_mm() -> str:
    """Edition string for today's month, Eastern-anchored (e.g. '2026-05')."""
    return _pricing.current_yyyy_mm()


def _next_yyyy_mm() -> str:
    """Edition string for next month, Eastern-anchored (e.g. '2026-06')."""
    return _pricing.next_yyyy_mm()


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


# Python mirror of _vintage_norm_sql so price lookups can build dictionary
# keys that match what the SQL side computes — used for apple-to-apple
# year-by-year vintage matching when cross-month comparing the same UPC.
import re as _re
_VN_RE_4 = _re.compile(r"^[0-9]{4}$")
_VN_RE_40 = _re.compile(r"^([0-9]{4})\.0+$")
_VN_RE_2 = _re.compile(r"^[0-9]{2}$")

def _uq_key(v) -> str:
    """Normalise a raw unit_qty cell for use in cross-edition lookup keys.

    A bottle-pack count of "12", "12.0", 12.0, " 12 ", and the integer 12 must
    all collapse to the same string so a 12-pack listing in May matches the
    12-pack listing in June — distinct pack sizes like 6 vs 12 are different
    SKUs (see DE TOREN FUSION V: UPC 816053000375 ships as a 12-pack 2019 and
    a 6-pack 2020 in the same edition). NaN / None / blank → '' so missing
    pack info doesn't accidentally bucket every row together.
    """
    if v is None: return ""
    if isinstance(v, float):
        if v != v: return ""  # NaN
        try:
            return str(int(v)) if float(v).is_integer() else str(v)
        except (TypeError, ValueError, OverflowError):
            return ""
    try:
        s = str(v).strip()
        if not s: return ""
        return str(int(float(s)))
    except (TypeError, ValueError):
        return str(v).strip()


def _norm_vintage(v) -> str | None:
    """Return a 4-digit vintage string ('2019') or None for NV / blank / junk."""
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


router = APIRouter(prefix="/api/catalog", tags=["catalog"])

# Distributor display name mapping
DISTRIBUTOR_NAMES = {
    "allied": "Allied",
    "fedway": "Fedway",
    "high_grade": "Highgrade",
    "opici": "Opici",
    "peerless": "Peerless",
    "kramer": "Kramer",
    "shore_point": "Shore Point",
    "jersey_beverage": "Jersey Beverage",
}


def _display_name(code: str) -> str:
    return DISTRIBUTOR_NAMES.get(code, code)


def _in_filter(where, params, column, csv, prefix):
    """Append a `column IN (...)` clause for a comma-separated multi-select value.
    Case-insensitive so a value supplied by the AI assistant (e.g. ?categories=
    spirits) still matches the canonical 'Spirits' stored in the cache."""
    vals = [v.strip() for v in (csv or "").split(",") if v.strip()]
    if not vals:
        return
    keys = []
    for i, v in enumerate(vals):
        k = f"{prefix}{i}"
        params[k] = v.upper()
        keys.append(f"${k}")
    where.append(f"UPPER(CAST({column} AS VARCHAR)) IN ({', '.join(keys)})")


def _cpl_clean_brand_view(con) -> str:
    """A view over cpl_enriched with an extra `brand_clean` column: the Go-UPC
    enrichment brand (joined by normalised UPC), which is clean (~5k distinct
    real brands like 'Smirnoff', 'Jim Beam'). The catalogue's own `brand`
    column is polluted with full product descriptions (~18k distinct values),
    so brand facets / filters / display read `brand_clean` instead. Degrades to
    `brand_clean = brand` when the enrichment table or its brand column is
    unavailable. One temp table + one view per request (cheap)."""
    base = read_parquet(con, "cpl_enriched")
    try:
        has_pe_brand = con.execute(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_name = 'product_enrichment' AND column_name = 'brand'"
        ).fetchone()
        if not has_pe_brand:
            raise RuntimeError("no enrichment brand column")
        pe = read_parquet(con, "product_enrichment")
        # Brands have near-duplicate spellings ("Jack Daniel's" vs "Jack
        # Daniels", "DeKuyper" vs "Dekuyper", "Moet & Chandon" vs "Moet and
        # Chandon"). Canonicalise to the MOST COMMON spelling per normalised key
        # (lowercased, '&'->'and', punctuation stripped) so the brand facet +
        # filter show one entry per brand.
        nk = ("trim(regexp_replace(regexp_replace("
              "replace(lower(brand), '&', ' and '), '[^a-z0-9 ]', '', 'g'), "
              "'\\s+', ' ', 'g'))")
        con.execute(f"""
            CREATE OR REPLACE TEMP TABLE _brand_canon AS
            WITH cnt AS (
                SELECT brand, COUNT(*) AS c, {nk} AS nk
                FROM {pe} WHERE brand IS NOT NULL AND brand <> ''
                GROUP BY brand
            )
            SELECT nk, arg_max(brand, c) AS canon FROM cnt GROUP BY nk
        """)
        # Per-UPC map: canonical brand + the enrichment NAME (used to group a
        # product's differently-named sizes into one family on the list).
        con.execute(f"""
            CREATE OR REPLACE TEMP TABLE _pe_brand AS
            SELECT LTRIM(CAST(pe.upc AS VARCHAR), '0') AS un,
                   ANY_VALUE(bc.canon) AS brand,
                   ANY_VALUE(pe.name) AS enr_name
            FROM {pe} pe
            JOIN _brand_canon bc ON bc.nk = {nk.replace('brand', 'pe.brand')}
            WHERE pe.brand IS NOT NULL AND pe.brand <> '' AND pe.upc IS NOT NULL
            GROUP BY 1
        """)
        con.execute(f"""
            CREATE OR REPLACE TEMP VIEW _cpl_cb AS
            SELECT c.*, pe.brand AS brand_clean, pe.enr_name AS enr_name
            FROM {base} c
            LEFT JOIN _pe_brand pe
              ON LTRIM(CAST(c.upc AS VARCHAR), '0') = pe.un
        """)
        return "_cpl_cb"
    except Exception:
        con.execute(f"CREATE OR REPLACE TEMP VIEW _cpl_cb AS SELECT *, brand AS brand_clean, CAST(NULL AS VARCHAR) AS enr_name FROM {base}")
        return "_cpl_cb"


def _q_clause(q: str, extra_aliases: dict | None = None,
              name_col: str = "product_name", brand_col: str = "brand",
              upc_col: str = "upc", enrich_table: str | None = None,
              enrich_upc_expr: str | None = None) -> tuple[str, dict, str]:
    """Build the search predicate for a free-text query: returns (clause, params,
    relevance_expr).

    Every whitespace token must match the product NAME or BRAND (AND across
    tokens), so "chivas 12" finds "CHIVAS REGAL 12YR" but not unrelated items.
    Shorthand and nicknames are expanded (see backend/search_aliases): a token
    like "jw" or "henny" also accepts its full brand. The relevance_expr counts
    how many tokens match the NAME (not just the brand), so a name match (real
    Hennessy) ranks above a brand-only match (e.g. the Moet Hennessy portfolio).
    An essentially-numeric query is matched against the UPC instead.

    When ``enrich_table`` is given (the Go-UPC product_enrichment table), each
    token may ALSO match the enriched description / category / category_path /
    region for the same UPC — so a search like 'tequila' finds Spirits whose
    NAME doesn't say tequila but whose enriched data does. ``enrich_upc_expr``
    must be the fully-qualified outer UPC column (e.g. 'cpl_enriched.upc') so the
    correlated subquery references the OUTER row, not the enrichment table's own
    upc. Description matches do NOT raise relevance (name matches still rank
    first)."""
    from backend.search_aliases import expansion_for
    tokens = [t for t in q.lower().split() if t]
    params: dict = {}
    counter = {"i": 0}
    token_clauses, rel_terms = [], []
    _outer_upc = enrich_upc_expr or upc_col
    for tok in tokens:
        terms = [tok] + (expansion_for(tok, extra_aliases) or [])
        keys, subs = [], []
        for term in terms:                            # literal + each alias phrase (OR'd:
            k = f"qt{counter['i']}"                   # catalogue names abbreviate brands)
            counter["i"] += 1
            params[k] = f"%{term}%"
            keys.append(k)
            # Required match: a row must have at least one of these structured
            # fields contain the token. Description is INTENTIONALLY excluded
            # here — a critic name like "Josh Raynolds" mentioned inside the
            # tasting notes used to qualify a Perrin wine for q=JOSH, which
            # was nonsense. Description is now ranking-only (see rel_terms
            # below): when present it boosts a row that's already qualified
            # by a structured-field match, but it can no longer qualify a row
            # on its own. q='tequila' still works because unit_volume,
            # category, category_path and region all match it via the
            # enrichment side.
            sub = (
                f"UPPER({name_col}) LIKE UPPER(${k}) "
                f"OR UPPER(COALESCE({brand_col},'')) LIKE UPPER(${k}) "
                f"OR UPPER(COALESCE(unit_volume,'')) LIKE UPPER(${k}) "
                f"OR UPPER(COALESCE(unit_volume_std,'')) LIKE UPPER(${k}) "
                # rip_code: typing '109359' or 'Lindemans' in the catalog
                # search box should also surface the cluster's rows. Match
                # is exact-or-substring on the canonical rip_code stored
                # on the cpl row (full multi-code stacking lives in the
                # rip table and is reached via the dedicated rip_code
                # filter, not free-text search).
                f"OR UPPER(COALESCE(CAST(rip_code AS VARCHAR),'')) LIKE UPPER(${k})"
            )
            if enrich_table:
                sub += (
                    f" OR EXISTS (SELECT 1 FROM {enrich_table} _pe "
                    f"WHERE _pe.upc = LTRIM(CAST({_outer_upc} AS VARCHAR), '0') AND ("
                    f"UPPER(COALESCE(_pe.category,'')) LIKE UPPER(${k}) "
                    f"OR UPPER(COALESCE(_pe.category_path,'')) LIKE UPPER(${k}) "
                    f"OR UPPER(COALESCE(_pe.region,'')) LIKE UPPER(${k}) "
                    f"OR UPPER(COALESCE(_pe.name,'')) LIKE UPPER(${k})))")
            subs.append(f"({sub})")
        token_clauses.append("(" + " OR ".join(subs) + ")")
        # Relevance: NAME match scores 1.0 per token. Description match
        # (boost-only — no longer qualifies a row on its own) adds 0.25.
        # Combined name + description match (1.25) ranks above name-only
        # (1.0) which ranks above brand/category/volume match (0.0).
        name_only = " OR ".join(f"UPPER({name_col}) LIKE UPPER(${k})" for k in keys)
        rel_terms.append(f"(CASE WHEN ({name_only}) THEN 1 ELSE 0 END)")
        if enrich_table:
            desc_only = " OR ".join(
                f"UPPER(COALESCE(_pe2.description,'')) LIKE UPPER(${k})" for k in keys
            )
            rel_terms.append(
                f"(CASE WHEN EXISTS (SELECT 1 FROM {enrich_table} _pe2 "
                f"WHERE _pe2.upc = LTRIM(CAST({_outer_upc} AS VARCHAR), '0') "
                f"AND ({desc_only})) THEN 0.25 ELSE 0 END)"
            )
    name_match = " AND ".join(token_clauses) if token_clauses else "TRUE"
    rel_expr = "(" + " + ".join(rel_terms) + ")" if rel_terms else "0"

    compact = q.replace(" ", "").replace("-", "")
    if compact.isdigit() and len(compact) >= 4:
        digits_norm = compact.lstrip("0") or compact
        params["q_upc"] = f"%{compact}%"
        params["q_upc2"] = f"%{digits_norm}%"
        ors = [f"{upc_col} LIKE $q_upc", f"{upc_col} LIKE $q_upc2"]
        # The same digits can be an Allied (ABG) item number or a RIP cluster
        # code rather than a barcode - exactly the numbers the catalog cards
        # display. identifier_clause() ORs in those lookups (sku_mapping +
        # the rip table) so the number a buyer reads off the card always
        # finds the product.
        from backend.code_search import identifier_clause
        id_clause, id_params = identifier_clause(q, upc_expr=_outer_upc)
        if id_clause:
            ors.append(id_clause)
            params.update(id_params)
        return f"(({name_match}) OR {' OR '.join(ors)})", params, rel_expr
    return f"({name_match})", params, rel_expr


_ENRICH_SEARCHABLE = None


def _enrichment_searchable(con) -> bool:
    """True once if the product_enrichment table exists and holds searchable
    text (description/category), so free-text search can include it. Cached per
    process; degrades to name/brand-only search if the table is absent/empty."""
    global _ENRICH_SEARCHABLE
    if _ENRICH_SEARCHABLE is None:
        try:
            n = con.execute(
                "SELECT COUNT(*) FROM product_enrichment "
                "WHERE COALESCE(description,'') <> '' OR COALESCE(category_path,'') <> '' "
                "OR COALESCE(category,'') <> ''").fetchone()[0]
            _ENRICH_SEARCHABLE = bool(n)
        except Exception:
            _ENRICH_SEARCHABLE = False
    return _ENRICH_SEARCHABLE


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


_VOCAB = None


def _vocab(con, src):
    """Distinct words (>=4 letters) from product names + brands, used to spell-fix a
    typed token against the catalogue's own vocabulary. Built once, cached."""
    global _VOCAB
    if _VOCAB is None:
        try:
            rows = con.execute(f"""
                SELECT DISTINCT w FROM (
                  SELECT unnest(string_split(regexp_replace(lower(product_name), '[^a-z ]', ' ', 'g'), ' ')) AS w FROM {src}
                  UNION ALL
                  SELECT unnest(string_split(regexp_replace(lower(COALESCE(brand,'')), '[^a-z ]', ' ', 'g'), ' ')) AS w FROM {src}
                ) WHERE length(w) >= 4
            """).fetchall()
            _VOCAB = [r[0] for r in rows]
        except Exception:
            _VOCAB = []
    return _VOCAB


def _spell_fix(q, vocab):
    """If a query token isn't a real catalogue word but is very close to one
    (e.g. 'hennesy' -> 'hennessy', 'glenfidich' -> 'glenfiddich'), substitute it.
    Returns the corrected query, or None if nothing changed."""
    import difflib
    if not vocab:
        return None
    vset = set(vocab)
    out, changed = [], False
    for t in q.lower().split():
        if len(t) >= 4 and t.isalpha() and t not in vset:
            cands = [w for w in vocab if w[:1] == t[:1]]   # typos usually keep the first letter
            m = difflib.get_close_matches(t, cands, n=1, cutoff=0.86)
            if m and m[0] != t:
                out.append(m[0])
                changed = True
                continue
        out.append(t)
    return " ".join(out) if changed else None


def _attach_next_month_prices(con, src, records):
    """Thin shim — canonical impl lives in backend/pricing.py.
    Kept for the existing call sites; equivalent to pricing.attach_next_month_prices."""
    _pricing.attach_next_month_prices(con, src, records)


def _attach_discount_rip_tiers(con, records, ref_date=None):
    """Thin shim — canonical impl lives in backend/pricing.py.
    Kept for the existing call sites; equivalent to pricing.attach_tiers.
    ``ref_date`` (ISO date, default today ET) annotates each tier's window."""
    _pricing.attach_tiers(con, records, ref_date=ref_date)


def _attach_live_rip(con, records, ref_date=None):
    """Thin shim — canonical impl lives in backend/pricing.py.
    Stamps the date-aware live-now RIP overlay; equivalent to
    pricing.attach_live_rip."""
    _pricing.attach_live_rip(con, records, ref_date=ref_date)


def _attach_next_tiers(con, records):
    """Thin shim — canonical impl lives in backend/pricing.py.
    Kept for the existing call sites; equivalent to pricing.attach_next_tiers."""
    _pricing.attach_next_tiers(con, records)


def _attach_price_3mo(con, records):
    """Thin shim — canonical impl lives in backend/pricing.py.
    Attaches `price_3mo` (last 3 existing editions: 1-case-discount + best-RIP
    prices + per-edition tiers) that powers the two-line 3-month sparkline."""
    _pricing.attach_price_3mo(con, records)


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
    by_upc: dict[str, tuple[int, int, list[str]]] = {}  # un -> (distributor_count, max products at one distributor, distributor slugs)
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
                    SELECT un,
                           COUNT(DISTINCT w) AS ndist,
                           MAX(pc) AS maxpc,
                           list_sort(list_distinct(list(w))) AS distrib_list
                    FROM per GROUP BY un""", prm
            ).fetchall()
            for r in rows:
                ws_list = list(r[3]) if r[3] is not None else []
                by_upc[str(r[0])] = (int(r[1]), int(r[2]), [str(x) for x in ws_list if x])
        except Exception:
            by_upc = {}
    for rec in records:
        un = str(rec.get("upc") or "").lstrip("0")
        ndist, maxpc, ws_list = by_upc.get(un, (0, 0, []))
        rec["distributor_count"] = ndist
        # "Multiple distributors" = the SAME product carried by 2+ distributors.
        # Require maxpc == 1: no single distributor reuses the barcode for more than
        # one product. When a distributor puts one barcode on several products it is
        # a placeholder/garbage UPC, not a shared product, so we don't tag it.
        rec["multi_distributor"] = ndist > 1 and maxpc == 1
        # Full slug list so the UI can spell out who carries this UPC in the
        # tooltip ("Allied, Fedway"). Only meaningful when multi_distributor is
        # true, but always populated for completeness.
        rec["multi_distributor_names"] = ws_list
        rec["dup_upc"] = False


def attach_vintages_available(con, records):
    """For each Promotions record that's a wine / sparkling / vermouth, look
    up the distinct vintages of the same (wholesaler, product_name,
    unit_volume) listed in the same edition and attach them as
    ``vintages_available`` (sorted, normalised 4-digit strings + 'NV' for
    non-vintage). Lets the card render a "Multiple vintages" sticker so
    the buyer knows a single product name covers several SKUs.

    No-op for records whose product_type isn't a vintage-bearing category,
    or whose lookup tuple is incomplete. ``vintages_available`` is set
    only when there are two or more distinct vintages — single-vintage
    SKUs get an empty list. The current row's own vintage is included
    when present so the tooltip's "current vs the rest" framing reads.
    """
    if not records:
        return
    VIN_TYPES = {"WINE", "SPARKLING", "VERMOUTH"}
    src = read_parquet(con, "cpl_enriched")
    keys = []
    for r in records:
        pt = (r.get("product_type") or "").upper()
        if pt not in VIN_TYPES:
            r["vintages_available"] = []
            continue
        ws = r.get("wholesaler")
        nm = r.get("product_name")
        vol = r.get("unit_volume")
        ed = r.get("edition")
        if not (ws and nm and ed):
            r["vintages_available"] = []
            continue
        keys.append((ws, nm, vol or "", ed))
    if not keys:
        return
    uniq = sorted(set(keys))
    ph = ", ".join(f"($w{i}, $n{i}, $v{i}, $e{i})" for i in range(len(uniq)))
    params = {}
    for i, (w, n, v, e) in enumerate(uniq):
        params[f"w{i}"], params[f"n{i}"], params[f"v{i}"], params[f"e{i}"] = w, n, v, e
    vn = _vintage_norm_sql("vintage")
    df = con.execute(
        f"""SELECT wholesaler, product_name, COALESCE(unit_volume, '') AS unit_volume,
                   edition, {vn} AS vn
            FROM {src}
            WHERE (wholesaler, product_name, COALESCE(unit_volume, ''), edition)
                  IN ({ph})""",
        params,
    ).fetchdf()
    bag: dict = {}
    for _, nr in df.iterrows():
        key = (nr["wholesaler"], nr["product_name"], nr["unit_volume"], nr["edition"])
        v = nr["vn"]
        # Normalise None / NaN to the 'NV' bucket; a wine with no vintage
        # tag is meaningfully distinct from a 2019 listing of the same SKU.
        if v is None or (isinstance(v, float) and math.isnan(v)):
            label = "NV"
        else:
            label = str(v)
        bag.setdefault(key, set()).add(label)
    for r in records:
        if "vintages_available" in r:  # already set above (non-wine or incomplete key)
            continue
        key = (r["wholesaler"], r["product_name"], r.get("unit_volume") or "", r["edition"])
        vs = sorted(bag.get(key, set()))
        r["vintages_available"] = vs if len(vs) > 1 else []


def attach_promotion_tiers(con, records):
    """Public entry-point for the Promotions endpoints (Time-Sensitive Deals,
    Major Discounts, Price Drops / Increases). Takes records from any
    promotion-flavoured query — they don't have to carry the CPL discount /
    RIP columns — and ends with each record carrying the same ``tiers`` and
    ``next_tiers`` arrays the Catalog row uses, so the cards can render the
    same MonthEffectiveSparkline popover (Frontline / Discount tiers / RIP
    tiers / Best for both months).

    Steps:
      1. For every record that's missing the CPL discount + RIP columns,
         look them up by (wholesaler, edition, upc) in one batch.
      2. Hand the augmented records to _attach_discount_rip_tiers (current
         month) and _attach_next_tiers (next edition).

    Pass-through if records is empty. Records with no upc / no edition are
    left as-is (they'd never have a tier ladder anyway).
    """
    if not records:
        return
    src = read_parquet(con, "cpl_enriched")

    needed = (
        "frontline_unit_price", "rip_code",
        "discount_1_qty", "discount_1_amt",
        "discount_2_qty", "discount_2_amt",
        "discount_3_qty", "discount_3_amt",
        "discount_4_qty", "discount_4_amt",
        "discount_5_qty", "discount_5_amt",
    )

    # Collect the rows we actually need to enrich (skip ones already carrying
    # the columns, e.g. records coming straight from a catalog SELECT).
    todo = [r for r in records if r.get("upc") and r.get("edition")
            and any(c not in r for c in needed)]
    if todo:
        keys = sorted({(r["wholesaler"], r["edition"], str(r["upc"]))
                       for r in todo})
        ph_keys = ", ".join(f"($w{i}, $e{i}, $u{i})" for i in range(len(keys)))
        params = {}
        for i, (w, e, u) in enumerate(keys):
            params[f"w{i}"], params[f"e{i}"], params[f"u{i}"] = w, e, u
        col_list = ", ".join(("wholesaler", "edition", "upc",) + needed)
        df = con.execute(
            f"SELECT {col_list} FROM {src} "
            f"WHERE (wholesaler, edition, CAST(upc AS VARCHAR)) IN ({ph_keys})",
            params,
        ).fetchdf()
        lookup: dict = {}
        for _, nr in df.iterrows():
            d = dict(nr)
            lookup[(d["wholesaler"], d["edition"], str(d["upc"]))] = d
        for r in todo:
            extras = lookup.get((r["wholesaler"], r["edition"], str(r["upc"]))) or {}
            for col in needed:
                if col not in r:
                    val = extras.get(col)
                    # Replace NaN with None so downstream `if amt is None`
                    # checks behave (pandas reads NaNs into floats).
                    if isinstance(val, float) and math.isnan(val):
                        val = None
                    r[col] = val

    # `rip_group_code` is only relevant for the Catalog's group_by_rip path;
    # set it to None so _attach_discount_rip_tiers falls back to `rip_code`.
    for r in records:
        r.setdefault("rip_group_code", None)

    _attach_discount_rip_tiers(con, records)
    _attach_price_3mo(con, records)


def _introduced_window(con, months: int) -> dict[tuple, str]:
    """{(wholesaler, upc_norm): introduced_edition} for items first introduced in
    the last ``months`` editions. "Introduced" = the start of the SKU's current
    run, detected by normalised UPC first-appearance (absent from the prior
    edition) — the SAME definition the /new-items endpoint uses (robust to
    distributors renaming items between editions, e.g. Highgrade). Runs as a
    read-only SELECT so it works on the read-only pricing connection."""
    src = read_parquet(con, "cpl_enriched")
    current_ym = _current_yyyy_mm()
    valid_upc = _VALID_UPC_SQL.format(col="upc")
    eds = con.execute(f"""
        SELECT DISTINCT edition FROM {src}
        WHERE edition <= $cym ORDER BY edition DESC LIMIT $months
    """, {"cym": current_ym, "months": int(months)}).fetchdf()
    window_eds = [r["edition"] for _, r in eds.iterrows()]
    if not window_eds:
        return {}
    window_start = min(window_eds)
    rows = con.execute(f"""
        WITH eds AS (
            SELECT wholesaler, edition,
                   LAG(edition) OVER (PARTITION BY wholesaler ORDER BY edition) AS prev_edition
            FROM (SELECT DISTINCT wholesaler, edition FROM {src})
        ),
        present AS (
            SELECT DISTINCT wholesaler, LTRIM(upc, '0') AS upc_norm, edition
            FROM {src} WHERE {valid_upc}
        ),
        firstapp AS (
            SELECT p.wholesaler, p.upc_norm, p.edition
            FROM present p
            JOIN eds e ON e.wholesaler = p.wholesaler AND e.edition = p.edition
            WHERE e.prev_edition IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1 FROM present p2
                  WHERE p2.wholesaler = p.wholesaler AND p2.upc_norm = p.upc_norm
                    AND p2.edition = e.prev_edition)
        ),
        introduced AS (
            SELECT wholesaler, upc_norm, MAX(edition) AS introduced_edition
            FROM firstapp GROUP BY wholesaler, upc_norm
        )
        SELECT wholesaler, upc_norm, introduced_edition FROM introduced
        WHERE introduced_edition >= $ws AND introduced_edition <= $cym
    """, {"cym": current_ym, "ws": window_start}).fetchall()
    return {(w, u): ed for (w, u, ed) in rows}


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
    time_sensitive: Optional[bool] = None,  # True = only products with a DATED (sub-month) QD/RIP window this edition
    price_drop: Optional[bool] = None,      # True = keep rows whose next-month effective is cheaper
    price_increase: Optional[bool] = None,  # True = keep rows whose next-month effective is higher
    brand: Optional[str] = None,
    unit_volume: Optional[str] = None,
    divisions: Optional[str] = None,        # comma-separated wholesalers (filter panel)
    categories: Optional[str] = None,       # comma-separated product types
    brands: Optional[str] = None,           # comma-separated brands
    sizes: Optional[str] = None,            # comma-separated unit volumes
    unit_kinds: Optional[str] = None,       # comma-separated container types: Bottle, Can, Keg
    upcs: Optional[str] = Query(None, description="Comma-separated UPCs (leading-zero-normalised); restricts the grid to exactly these SKUs. Used by Celar Assistant 'Open in Catalog' links."),
    rip_code: Optional[str] = Query(None, description="Restrict to products in this RIP cluster (current edition). Optional ?wholesaler= or ?divisions= narrows to one distributor; without that, any wholesaler carrying the code is included. Same (edition, distributor, UPC-validity) scoping the catalog's group-by-RIP plumbing uses."),
    region: Optional[str] = Query(None, description="Region / origin hint, e.g. 'california', 'napa', 'bordeaux', 'tuscany'. Filters by product name tokens + enrichment description. Auto-narrows product_type when the region implies a category (e.g. region=california auto-applies product_type=Wine if none is set)."),
    varietal: Optional[str] = Query(None, description="Varietal / style hint, e.g. 'cabernet', 'pinot noir', 'ipa', 'bourbon', 'reposado', 'single malt'. Combine with region for queries like 'California cabernets' or 'Kentucky bourbon'."),
    tracked_only: bool = Query(False, description="If true, only return products on the watchlist"),
    introduced_within_months: Optional[int] = Query(None, ge=1, le=12, description="If set, restrict to items first introduced (by UPC first-appearance) within the last N editions, and attach introduced_edition per row. Powers the New Items page (same universe as /new-items) while keeping the full search/filter/facet stack."),
    sort: str = Query("product_name", description="Sort field"),
    order: str = Query("asc", description="asc or desc"),
    limit: int = Query(50, ge=1, le=50000),
    offset: int = Query(0, ge=0),
    include_tiers: bool = Query(False, description="If true, include discount_tiers and rip_tiers arrays per item"),
    group_by_rip: bool = Query(False, description="If true, attach rip_group_code (from the RIP sheet) per row and sort by it so products sharing a rebate cluster together"),
    images_first: bool = Query(False, description="If true, products that have an enrichment image sort before those without (storefront category browsing). Sits under text-relevance ranking and RIP clustering, above the user's sort field."),
    as_of: Optional[str] = Query(None, description="Reference date (YYYY-MM-DD, default today ET) used to classify RIP windows and compute the date-aware 'live now' RIP price overlay per row. Does not change the grid's sort/filter; only annotates each row + tier."),
    user: Optional[dict] = Depends(get_optional_user),
):
    """Full-text search with faceted filtering. Defaults to latest edition to avoid duplicates."""
    with get_duckdb() as con:
        # cpl_enriched + a clean `brand_clean` column (enrichment brand). The
        # raw `brand` column is description-polluted, so brand filter + display
        # read brand_clean.
        src = _cpl_clean_brand_view(con)

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

        # New Items mode: restrict to SKUs first introduced in the last N editions
        # and remember each one's introduced edition (attached to the rows below).
        intro_map: dict[tuple, str] = {}
        if introduced_within_months:
            intro_map = _introduced_window(con, introduced_within_months)
            if not intro_map:
                where.append("1 = 0")   # nothing new in window -> empty grid
            else:
                keys = []
                for i, (w_, u_) in enumerate(intro_map):
                    params[f"introk{i}"] = f"{w_}|{u_}"
                    keys.append(f"$introk{i}")
                where.append(
                    "(wholesaler || '|' || LTRIM(CAST(upc AS VARCHAR), '0')) IN ("
                    + ", ".join(keys) + ")")

        q_clause_idx = None
        rel_expr = "0"
        # CELR Product Number lookup: typing "CELR-003873" (or "celr 3873")
        # resolves the FAMILY -> every barcode in the registry under that
        # number, across sizes/vintages/distributors. Replaces the text
        # search for that query; also drives the ProductSearchBox typeahead.
        _celr_q = re.fullmatch(r"(?i)\s*celr[-\s]*0*(\d{1,9})\s*", q or "")
        if _celr_q:
            try:
                _cdf = con.execute(
                    "SELECT upc_norm FROM celr_products WHERE cpn = $c",
                    {"c": int(_celr_q.group(1))}).fetchdf()
                _cu = [str(u) for u in _cdf["upc_norm"].tolist()]
            except Exception:
                _cu = []
            if _cu:
                keys = []
                for i, u in enumerate(_cu):
                    params[f"celru{i}"] = u
                    keys.append(f"$celru{i}")
                where.append(f"LTRIM(CAST(upc AS VARCHAR), '0') IN ({', '.join(keys)})")
            else:
                where.append("1 = 0")   # unknown number -> no results, not noise
            q = ""                       # skip the text clause entirely
        # Free-text search also looks inside the Go-UPC enrichment (description,
        # category, region) so subtype queries like "tequila" — which is a
        # Spirits product, not a category — still find matches.
        _enr = "product_enrichment" if _enrichment_searchable(con) else None
        _enr_upc = f"{src}.upc" if _enr else None
        if q:
            clause, qp, rel_expr = _q_clause(q, _brand_initialisms(con, src),
                                             enrich_table=_enr, enrich_upc_expr=_enr_upc)
            # group-by-RIP EXPANSION: when the toggle is on, a row that
            # matches q drags in EVERY OTHER row in its RIP cluster, so a
            # search for one product surfaces the FULL Case Mix the buyer
            # needs to plan a rebate basket. Implemented as an OR against a
            # pre-computed UPC set: seed matches via the text clause, then
            # walk the rip table to pull every UPC under the same code.
            if group_by_rip:
                rip_x_src = read_parquet(con, "rip")
                # Pre-compute the seed UPC set once for this request via a
                # plain Python query (DuckDB executes via fetchdf). This
                # avoids correlating the rip-expansion EXISTS to every cpl
                # row in the main scan.
                try:
                    seed_sql = (
                        f"SELECT DISTINCT wholesaler, "
                        f"       LTRIM(CAST(upc AS VARCHAR), '0') AS un "
                        f"FROM {src} WHERE {clause} "
                        f"  AND upc IS NOT NULL "
                        f"  AND LTRIM(CAST(upc AS VARCHAR), '0') NOT IN ('','None','nan') "
                    )
                    seed_df = con.execute(seed_sql, qp).fetchdf()
                    seed_pairs = [(str(r["wholesaler"]),
                                   str(r["un"])) for _, r in seed_df.iterrows()]
                except Exception:
                    seed_pairs = []
                # From seeds, find every (wholesaler, upc) that shares a
                # rip_code with a seed UPC. Latest edition <= today, valid
                # rip_code only (rip codes recycle month to month).
                expanded_pairs: set = set(seed_pairs)
                if seed_pairs:
                    try:
                        ph = ", ".join(f"($sw{i}, $su{i})" for i in range(len(seed_pairs)))
                        sp = {"x_cym": _current_yyyy_mm()}
                        for i, (w, u) in enumerate(seed_pairs):
                            sp[f"sw{i}"], sp[f"su{i}"] = w, u
                        x_df = con.execute(
                            "WITH ripcur AS (SELECT wholesaler, MAX(edition) ed "
                            f"                FROM {rip_x_src} "
                            "                WHERE edition <= $x_cym GROUP BY wholesaler), "
                            "seed AS (SELECT _r.wholesaler, "
                            "                CAST(_r.rip_code AS VARCHAR) AS rc "
                            f"          FROM {rip_x_src} _r "
                            "         JOIN ripcur ON _r.wholesaler=ripcur.wholesaler "
                            "                    AND _r.edition=ripcur.ed "
                            "         WHERE (_r.wholesaler, "
                            "                LTRIM(CAST(_r.upc AS VARCHAR),'0')) "
                            f"               IN ({ph}) "
                            "           AND CAST(_r.rip_code AS VARCHAR) "
                            "               NOT IN ('','0','None','nan') "
                            "           AND _r.upc IS NOT NULL "
                            "           AND CAST(_r.upc AS VARCHAR) "
                            "               NOT IN ('','0','None','nan')) "
                            f"SELECT DISTINCT _e.wholesaler, "
                            "        LTRIM(CAST(_e.upc AS VARCHAR),'0') AS un "
                            f"FROM {rip_x_src} _e "
                            "JOIN ripcur ON _e.wholesaler=ripcur.wholesaler "
                            "           AND _e.edition=ripcur.ed "
                            "JOIN seed ON seed.wholesaler=_e.wholesaler "
                            "          AND seed.rc=CAST(_e.rip_code AS VARCHAR) "
                            "WHERE _e.upc IS NOT NULL "
                            "  AND CAST(_e.upc AS VARCHAR) "
                            "      NOT IN ('','0','None','nan') "
                            "  AND LTRIM(CAST(_e.upc AS VARCHAR),'0') "
                            "      NOT IN ('','None','nan')",
                            sp).fetchdf()
                        for _, r in x_df.iterrows():
                            expanded_pairs.add((str(r["wholesaler"]), str(r["un"])))
                    except Exception:
                        pass  # any failure falls back to the literal text match
                # The original text clause stays as part of the OR (catches
                # the rows where rip data is silent but the text matches —
                # e.g. closeouts without a current RIP). The expanded UPC
                # set joins via VALUES so DuckDB can index-scan it.
                if expanded_pairs and len(expanded_pairs) > len(seed_pairs):
                    vals_keys = []
                    for i, (w, u) in enumerate(sorted(expanded_pairs)):
                        params[f"xw{i}"], params[f"xu{i}"] = w, u
                        vals_keys.append(f"(${'xw'+str(i)}, ${'xu'+str(i)})")
                    where.append(
                        "(" + clause + " OR (wholesaler, "
                        "LTRIM(CAST(upc AS VARCHAR), '0')) IN ("
                        + ", ".join(vals_keys) + "))"
                    )
                else:
                    where.append(clause)
            else:
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
        # Semantic region filter. Resolves a phrase like "california" to a
        # set of product-name tokens + enrichment description terms, and
        # auto-narrows product_type when the region implies one (so
        # 'california' returns Wine, not vodka). The caller's explicit
        # product_type wins if set.
        if region:
            from backend.region_semantics import build_region_filter
            # Qualify the columns with the outer table: the region clause's
            # description/category EXISTS subqueries correlate on upc, and an
            # UNqualified `upc` binds to the inner product_enrichment.upc
            # (name resolution prefers the inner scope), making the correlation
            # `pe.upc = pe.upc` — always true — so the filter matched the WHOLE
            # catalog. Qualifying as {src}.upc restores the real correlation.
            region_clause, region_params, region_auto_type = build_region_filter(
                region, name_col=f"{src}.product_name", upc_col=f"{src}.upc")
            if region_clause:
                where.append(region_clause)
                params.update(region_params)
                if region_auto_type and not product_type:
                    product_type = region_auto_type
        # Semantic varietal / style filter. Stacks with region for queries
        # like 'California cabernets' or 'Kentucky bourbon'. Auto-product_type
        # again — region's narrowing wins if both set the same; varietal can
        # add narrowing the region didn't supply (e.g. varietal=ipa -> Beer).
        if varietal:
            from backend.varietal_semantics import build_varietal_filter
            # Same correlation fix as region above — qualify with the outer table.
            v_clause, v_params, v_auto_type = build_varietal_filter(
                varietal, name_col=f"{src}.product_name", upc_col=f"{src}.upc")
            if v_clause:
                where.append(v_clause)
                params.update(v_params)
                if v_auto_type and not product_type:
                    product_type = v_auto_type
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
        if time_sensitive is True:
            # Products carrying a DATED (sub-month) deal this edition: the row's
            # own CPL price line has a partial-month window (cpl_full_window =
            # false), or any precomputed rip_windows entry is partial-month.
            # Mirrors pricing.is_time_sensitive_window: NULL on either side =
            # evergreen; from on the 1st AND to = month-end = full month; else
            # time-sensitive. Reuses precomputed columns only; degrades to a
            # no-op when an old cache predates them.
            ts_cols = {r[0] for r in con.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'cpl_enriched' "
                "AND column_name IN ('cpl_full_window', 'rip_windows')"
            ).fetchall()}
            ts_parts = []
            if "cpl_full_window" in ts_cols:
                ts_parts.append("COALESCE(cpl_full_window, true) = false")
            if "rip_windows" in ts_cols:
                _parsed = f"from_json(rip_windows, '{_pricing._RIP_WINDOWS_JSON_SCHEMA}')"
                ts_parts.append(
                    f"len(list_filter({_parsed}, w -> "
                    "w.from_date IS NOT NULL AND w.to_date IS NOT NULL "
                    "AND NOT (substr(w.from_date, 9, 2) = '01' "
                    "AND w.to_date = strftime(last_day(CAST(w.to_date AS DATE)), '%Y-%m-%d')))) > 0"
                )
            if ts_parts:
                where.append(f"({' OR '.join(ts_parts)})")
        # Multi-select panel filters (applied server-side so they span all pages).
        _in_filter(where, params, "wholesaler", divisions, "div_")
        _in_filter(where, params, "product_type", categories, "cat_")
        # Container-type filter (Bottle / Can / Keg), standardised from the messy
        # per-distributor unit_type via the canonical bucket so the filter is clean.
        _in_filter(where, params, _UNIT_KIND_SQL, unit_kinds, "ukind_")
        # Brand filter matches the clean enrichment brand (brand_clean), so a
        # picked brand like "Smirnoff" actually selects the right rows.
        _in_filter(where, params, "brand_clean", brands, "brnd_")
        # Size filters on the standardized bucket so e.g. "750ML" also matches a
        # bottle stored as "25.33OZ". COALESCE keeps it working if the cache
        # predates the unit_volume_std column.
        _in_filter(where, params, "COALESCE(unit_volume_std, unit_volume)", sizes, "size_")
        # Exact-UPC restriction used by Celar Assistant deep-links — locks
        # the grid to the same SKUs the chat surfaced. Leading zeros are
        # normalised on BOTH sides so "020585000475" and "20585000475"
        # match the same product.
        if upcs:
            # Placeholder barcodes (shared fake codes like 111111111117) are
            # dropped: matching on one would weld dozens of unrelated products
            # into the response. If nothing real remains the filter matches
            # nothing rather than silently un-filtering.
            vals = [u.strip().lstrip("0") for u in upcs.split(",") if u.strip()]
            clean = [v for v in vals if _is_clean_upc(v)]
            if clean:
                keys = []
                for i, v in enumerate(clean):
                    k = f"upc_{i}"
                    params[k] = v
                    keys.append(f"${k}")
                where.append(f"LTRIM(CAST(upc AS VARCHAR), '0') IN ({', '.join(keys)})")
            elif vals:
                where.append("1 = 0")

        # RIP-cluster restriction: limit the grid to products whose UPC sits
        # under this rip_code in the current edition's rip sheet. EXISTS
        # subquery against the rip parquet, scoped to (wholesaler, latest rip
        # edition <= today, valid UPC). Used by the assistant's "Open Allied
        # RIP 109359 in Catalog" deep links.
        if rip_code:
            rip_filter_src = read_parquet(con, "rip")
            params["rip_code_filter"] = rip_code
            params["rip_code_cym"] = _current_yyyy_mm()
            where.append(f"""
                EXISTS (
                    SELECT 1 FROM {rip_filter_src} _rfilt
                    WHERE _rfilt.wholesaler = wholesaler
                      AND CAST(_rfilt.rip_code AS VARCHAR) = $rip_code_filter
                      AND LTRIM(CAST(_rfilt.upc AS VARCHAR), '0')
                        = LTRIM(CAST(upc AS VARCHAR), '0')
                      AND _rfilt.upc IS NOT NULL
                      AND CAST(_rfilt.upc AS VARCHAR) NOT IN ('', '0', 'None', 'nan')
                      AND LTRIM(CAST(_rfilt.upc AS VARCHAR), '0')
                          NOT IN ('', 'None', 'nan')
                      AND _rfilt.edition = (
                          SELECT MAX(_rfilt2.edition)
                          FROM {rip_filter_src} _rfilt2
                          WHERE _rfilt2.wholesaler = _rfilt.wholesaler
                            AND CAST(_rfilt2.rip_code AS VARCHAR)
                                = $rip_code_filter
                            AND _rfilt2.edition <= $rip_code_cym
                      )
                )
            """)
            # RIP membership is by UPC, but a UPC can have several SKUs — a
            # promo/gift/VAP sibling (or unrelated product) that shares the UPC
            # but carries NO valid rip_code gets NO rebate and is NOT a member.
            # Drop such a sibling ONLY when a SAME-UPC + SAME-VINTAGE sibling does
            # carry a rip_code (different vintages are their own products, never
            # collapsed). Single-SKU UPCs are untouched.
            where.append(f"""
                (
                  (rip_code IS NOT NULL AND CAST(rip_code AS VARCHAR) NOT IN ('', '0', 'None', 'nan'))
                  OR NOT EXISTS (
                    SELECT 1 FROM {src} _sib
                    WHERE _sib.wholesaler = wholesaler AND _sib.edition = edition
                      AND LTRIM(CAST(_sib.upc AS VARCHAR), '0') = LTRIM(CAST(upc AS VARCHAR), '0')
                      AND COALESCE(CAST(_sib.vintage AS VARCHAR), '') = COALESCE(CAST(vintage AS VARCHAR), '')
                      AND _sib.rip_code IS NOT NULL
                      AND CAST(_sib.rip_code AS VARCHAR) NOT IN ('', '0', 'None', 'nan')
                  )
                )
            """)

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
            # Date-aware: the price/savings active on `as_of` (default today ET).
            # Computed as a SELECT alias below so ORDER BY can use it.
            "live_effective_case_price", "live_savings",
        }
        sort_col = sort if sort in allowed_sorts else "product_name"
        sort_dir = "DESC" if order.lower() == "desc" else "ASC"

        # Reference date for the live RIP price + sort. Inlined as a quoted SQL
        # literal (DuckDB rejects bound params inside the lambda the rip_windows
        # filter uses). Validated to a real ISO date first so it can't inject.
        try:
            ref_date_val = date.fromisoformat(str(as_of)[:10]).isoformat() if as_of else _pricing.eastern_today().isoformat()
        except (TypeError, ValueError):
            ref_date_val = _pricing.eastern_today().isoformat()
        ref_lit = f"'{ref_date_val}'"
        # Degrade gracefully when the cache predates the rip_windows column (a
        # deploy that lands before the ETL rebuilds the parquet). Without this
        # the SQL below would reference a missing column and 500 the whole
        # catalog. Fallback: live price == month price, live sort -> effective.
        has_rip_windows = bool(con.execute(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_name = 'cpl_enriched' AND column_name = 'rip_windows'"
        ).fetchone())
        if has_rip_windows:
            live_eff_expr = _pricing.live_effective_sql(ref_lit)
            live_amt_expr = _pricing.live_rip_amt_sql("rip_windows", ref_lit)
        else:
            live_eff_expr = "effective_case_price"
            live_amt_expr = "CAST(NULL AS DOUBLE)"
            if sort_col in ("live_effective_case_price", "live_savings"):
                sort_col = "effective_case_price"

        where_clause = " AND ".join(where)

        # A row is a duplicate ONLY when the barcode, name, size, vintage, PRICE and
        # DEALS all match. Rule from the user: same barcode but a different price or
        # different deals is NOT a duplicate (e.g. a different vintage, or a placeholder
        # barcode reused across unrelated products), so it stays as its own row.
        # When group_by_rip is on, the RIP membership code is included in the
        # partition so a UPC stacked under N rebates produces N distinct rows
        # (one per cluster) instead of being collapsed back to 1.
        dedup_extra = ", COALESCE(rm.membership_code, '')" if group_by_rip else ""
        dedup = (
            "QUALIFY ROW_NUMBER() OVER (PARTITION BY wholesaler, LTRIM(COALESCE(upc,''),'0'), "
            "product_name, unit_volume, COALESCE(CAST(vintage AS VARCHAR),''), "
            "COALESCE(frontline_case_price,-1), COALESCE(effective_case_price,-1), "
            "COALESCE(total_savings_per_case,-1), has_discount, has_rip"
            f"{dedup_extra} "
            "ORDER BY edition DESC) = 1"
        )

        # When group_by_rip is on, build the rip_groups + rip_memberships CTEs
        # once and inject them into BOTH the count and data queries so the
        # fan-out (one row per RIP a UPC qualifies for) is reflected in
        # pagination totals. Defined ahead of the count query so both call
        # sites share the same CTE text.
        rip_cte_sql = ""
        rip_join_sql = ""
        if group_by_rip:
            rip_src_cte = read_parquet(con, "rip")
            rip_cte_sql = f"""
                WITH mix_listing_counts AS (
                    -- Distinct listings per (wholesaler, edition, UPC). One UPC
                    -- is reused across vintages, so single-vs-multi decides RIP
                    -- membership: single-listing joins a group by UPC alone (the
                    -- CPL code is unreliable, esp. opici text labels); multi-
                    -- listing requires the row's OWN code to match the group's,
                    -- so a vintage never inherits another vintage's rebate.
                    -- Mirrors nj_abc_parser/derive.py + pricing.attach_tiers.
                    SELECT wholesaler AS lc_ws, edition AS lc_ed,
                           CAST(upc AS VARCHAR) AS lc_upc,
                           COUNT(DISTINCT (
                               product_name,
                               COALESCE(unit_volume, ''),
                               COALESCE(CAST(vintage AS VARCHAR), ''),
                               COALESCE(regexp_replace(TRIM(CAST(unit_qty AS VARCHAR)), '\\.0+$', ''), '')
                           )) AS n_listings
                    FROM {src}
                    GROUP BY wholesaler, edition, CAST(upc AS VARCHAR)
                ),
                rip_groups AS (
                    SELECT wholesaler AS rg_wholesaler,
                           edition    AS rg_edition,
                           CAST(upc AS VARCHAR) AS rg_upc,
                           MIN(CAST(rip_code AS VARCHAR)) AS rip_group_min,
                           COUNT(DISTINCT CAST(rip_code AS VARCHAR)) AS rip_group_count,
                           list_distinct(list(CAST(rip_code AS VARCHAR))) AS rip_group_codes
                    FROM {rip_src_cte}
                    WHERE upc IS NOT NULL
                      AND CAST(upc AS VARCHAR) NOT IN ('', '0', 'None', 'nan')
                      AND rip_code IS NOT NULL
                      AND CAST(rip_code AS VARCHAR) NOT IN ('', '0', 'None', 'nan')
                    GROUP BY wholesaler, edition, CAST(upc AS VARCHAR)
                ),
                -- Cluster size = number of distinct catalog SKUs sharing each
                -- (wholesaler, edition, rip_code). User rule: same UPC + different
                -- vintage (or pack size) is a DIFFERENT item, so we count distinct
                -- (UPC, vintage, unit_volume, unit_qty) tuples from the live CPL,
                -- not just distinct UPCs on the RIP sheet. Drives the biggest-
                -- first ordering when group_by_rip is on, so the sort matches the
                -- row count the user sees on the page.
                rip_cluster_sizes AS (
                    SELECT cls.wholesaler  AS rcs_wholesaler,
                           cls.edition     AS rcs_edition,
                           cls.rip_code    AS rcs_code,
                           COUNT(DISTINCT (
                               LTRIM(CAST(c.upc AS VARCHAR), '0'),
                               COALESCE(CAST(c.vintage AS VARCHAR), ''),
                               COALESCE(c.unit_volume, ''),
                               COALESCE(CAST(c.unit_qty AS VARCHAR), '')
                           )) AS cluster_members
                    FROM (
                        SELECT DISTINCT wholesaler, edition,
                               CAST(rip_code AS VARCHAR) AS rip_code,
                               LTRIM(CAST(upc AS VARCHAR), '0') AS upc_n
                        FROM {rip_src_cte}
                        WHERE upc IS NOT NULL
                          AND CAST(upc AS VARCHAR) NOT IN ('', '0', 'None', 'nan')
                          AND rip_code IS NOT NULL
                          AND CAST(rip_code AS VARCHAR) NOT IN ('', '0', 'None', 'nan')
                    ) cls
                    JOIN {src} c
                      ON c.wholesaler = cls.wholesaler
                     AND c.edition    = cls.edition
                     AND LTRIM(CAST(c.upc AS VARCHAR), '0') = cls.upc_n
                    -- Exclude a same-UPC sibling that carries NO valid rip_code
                    -- (promo/gift/VAP variant or unrelated product) when a
                    -- same-UPC + same-VINTAGE sibling DOES carry one. Different
                    -- vintages are distinct products and never collapsed.
                    WHERE (c.rip_code IS NOT NULL AND CAST(c.rip_code AS VARCHAR) NOT IN ('', '0', 'None', 'nan'))
                       OR NOT EXISTS (
                           SELECT 1 FROM {src} c2
                           WHERE c2.wholesaler = c.wholesaler AND c2.edition = c.edition
                             AND LTRIM(CAST(c2.upc AS VARCHAR), '0') = LTRIM(CAST(c.upc AS VARCHAR), '0')
                             AND COALESCE(CAST(c2.vintage AS VARCHAR), '') = COALESCE(CAST(c.vintage AS VARCHAR), '')
                             AND c2.rip_code IS NOT NULL
                             AND CAST(c2.rip_code AS VARCHAR) NOT IN ('', '0', 'None', 'nan'))
                    GROUP BY cls.wholesaler, cls.edition, cls.rip_code
                ),
                -- Fan rip_groups out by code so a UPC with N rebates emits N
                -- rows. The LEFT JOIN below preserves UPCs that don't qualify
                -- for any rebate (they pass through with NULL membership).
                rip_memberships AS (
                    SELECT rg.rg_wholesaler, rg.rg_edition, rg.rg_upc,
                           UNNEST(rg.rip_group_codes) AS membership_code,
                           rg.rip_group_min, rg.rip_group_count, rg.rip_group_codes
                    FROM rip_groups rg
                )
            """
            rip_join_sql = r"""
                LEFT JOIN mix_listing_counts mlc
                  ON mlc.lc_ws  = wholesaler
                 AND mlc.lc_ed  = edition
                 AND mlc.lc_upc = CAST(upc AS VARCHAR)
                LEFT JOIN rip_memberships rm
                  ON rm.rg_wholesaler = wholesaler
                 AND rm.rg_edition    = edition
                 AND rm.rg_upc        = CAST(upc AS VARCHAR)
                 -- Single listing (real UPC, not an all-same-digit stub): member
                 -- by UPC. Many listings: member only of the code(s) THIS row
                 -- actually carries, so a wrong-vintage row (code 0 / blank /
                 -- different code) drops out of the cluster.
                 AND (
                     (COALESCE(mlc.n_listings, 1) <= 1
                      AND LENGTH(REPLACE(CAST(upc AS VARCHAR), LEFT(CAST(upc AS VARCHAR), 1), '')) > 0)
                     OR list_contains(
                          string_split(REGEXP_REPLACE(COALESCE(CAST(rip_code AS VARCHAR), ''), '\s+', ' '), ' '),
                          rm.membership_code)
                 )
                LEFT JOIN rip_cluster_sizes rcs
                  ON rcs.rcs_wholesaler = wholesaler
                 AND rcs.rcs_edition    = edition
                 AND rcs.rcs_code       = rm.membership_code
            """

        # Price-trend filter: keep rows whose effective price changes between
        # this month and next. Two paths:
        #   FAST: read the precomputed `price_trend` column on cpl_enriched
        #         (built by nj_abc_parser/derive.py via LEAD per UPC), so the
        #         filter is a plain `WHERE price_trend = 'drop'`.
        #   FALLBACK: build a next_eff_lookup CTE + LEFT JOIN on the fly,
        #         used while Render hasn't yet ingested a parquet with the
        #         new column. Same match key as _attach_next_month_prices
        #         so the per-row "Better price" sticker agrees with what
        #         the filter kept.
        # The frontend currently exposes radio semantics (only one of
        # drop / increase set) but the backend OR-s them so a future
        # "any change" toggle works without further changes.
        trend_active = (price_drop is True) or (price_increase is True)
        trend_cte_body = ""
        trend_join_sql = ""
        if trend_active:
            # Cheap column-existence probe so a stale schema falls back to
            # the runtime join instead of 500ing on an unknown column.
            try:
                _cols = {r[0] for r in con.execute(f"DESCRIBE {src}").fetchall()}
            except Exception:
                _cols = set()
            has_trend_col = "price_trend" in _cols

            if has_trend_col:
                trend_conds = []
                if price_drop is True:
                    trend_conds.append(f"{src}.price_trend = 'drop'")
                if price_increase is True:
                    trend_conds.append(f"{src}.price_trend = 'increase'")
                where.append("(" + " OR ".join(trend_conds) + ")")
            else:
                params["next_ym"] = _next_yyyy_mm()
                src_vn = _vintage_norm_sql(f"{src}.vintage")
                nx_vn = _vintage_norm_sql("vintage")
                trend_cte_body = f"""
                    next_eff_lookup AS (
                        SELECT wholesaler AS nx_wholesaler,
                               COALESCE(CAST(upc AS VARCHAR), '') AS nx_upc_key,
                               COALESCE(product_name, '') AS nx_name_key,
                               COALESCE(unit_volume, '') AS nx_size_key,
                               {nx_vn} AS nx_vintage_key,
                               MIN(effective_case_price) AS next_eff
                        FROM {src}
                        WHERE edition = $next_ym
                        GROUP BY 1, 2, 3, 4, 5
                    )
                """
                trend_join_sql = f"""
                    LEFT JOIN next_eff_lookup nx
                      ON nx.nx_wholesaler  = {src}.wholesaler
                     AND nx.nx_upc_key     = COALESCE(CAST({src}.upc AS VARCHAR), '')
                     AND nx.nx_name_key    = COALESCE({src}.product_name, '')
                     AND nx.nx_size_key    = COALESCE({src}.unit_volume, '')
                     AND nx.nx_vintage_key IS NOT DISTINCT FROM ({src_vn})
                """
                trend_conds = []
                curr_eff_expr = f"COALESCE({src}.effective_case_price, {src}.frontline_case_price)"
                if price_drop is True:
                    trend_conds.append(
                        f"(nx.next_eff IS NOT NULL AND {curr_eff_expr} IS NOT NULL "
                        f"AND nx.next_eff < {curr_eff_expr} - 0.005)"
                    )
                if price_increase is True:
                    trend_conds.append(
                        f"(nx.next_eff IS NOT NULL AND {curr_eff_expr} IS NOT NULL "
                        f"AND nx.next_eff > {curr_eff_expr} + 0.005)"
                    )
                where.append("(" + " OR ".join(trend_conds) + ")")
            where_clause = " AND ".join(where)

        def _add_cte(existing: str, body: str) -> str:
            """Append a CTE body to an existing WITH block, or open a new one."""
            if not body:
                return existing
            if existing.strip():
                return f"{existing.rstrip()}, {body}"
            return f"WITH {body}"

        count_cte_sql = _add_cte(rip_cte_sql, trend_cte_body)

        # Count query (deduped to match the data query). With group_by_rip on
        # the join + partition mirror the data path so total reflects fan-out.
        count = con.execute(
            f"{count_cte_sql} SELECT count(*) FROM "
            f"(SELECT 1 FROM {src} {rip_join_sql} {trend_join_sql} WHERE {where_clause} {dedup}) t",
            params,
        ).fetchone()[0]

        # AI fallback: a text search that found nothing -> ask Claude (Sonnet) to map
        # the shorthand to real brand terms and retry once. Key-gated + cached, so it
        # only fires on genuine misses and never on the common (alias-handled) ones.
        corrected_query = None
        if (q and count == 0 and offset == 0 and q_clause_idx is not None
                and any(ch.isalpha() for ch in q)):
            def _retry(fixed_q):
                nonlocal where_clause, rel_expr
                clause2, qp2, rel2 = _q_clause(fixed_q, _brand_initialisms(con, src),
                                               enrich_table=_enr, enrich_upc_expr=_enr_upc)
                where[q_clause_idx] = clause2
                rel_expr = rel2
                # Drop the previous query params so none are left bound but unused
                # (which would make the retry query error).
                for k in [k for k in params if k.startswith("qt") or k.startswith("q_upc")]:
                    params.pop(k, None)
                params.update(qp2)
                where_clause = " AND ".join(where)
                return con.execute(
                    f"{count_cte_sql} SELECT count(*) FROM "
                    f"(SELECT 1 FROM {src} {rip_join_sql} {trend_join_sql} WHERE {where_clause} {dedup}) t",
                    params,
                ).fetchone()[0]

            # 1) Deterministic spell-fix against the catalogue vocabulary (no API cost).
            try:
                fix = _spell_fix(q, _vocab(con, src))
                if fix and fix.lower() != q.lower():
                    n = _retry(fix)
                    if n > 0:
                        count, corrected_query = n, fix
            except Exception:
                pass

            # 2) AI fallback for phrasing/semantics a spell-fix can't catch
            #    (e.g. "cordon blue" -> "cordon bleu").
            if count == 0:
                try:
                    from backend.ai_search import ai_expand_query
                    ai_q = ai_expand_query(q)
                    if ai_q:
                        n = _retry(ai_q)
                        if n > 0:
                            count, corrected_query = n, ai_q
                except Exception:
                    pass

        # Rank text searches by relevance (tokens matching the NAME first) so a
        # brand-only match (e.g. the Moet Hennessy portfolio) never outranks the
        # real product. Only when the user hasn't picked an explicit sort.
        order_by = f"{sort_col} {sort_dir}"
        if images_first:
            # Sort key only: the actual image URL is attached per page later
            # (attach_enrichment_image), so image presence must be tested in
            # SQL via the normalised-UPC enrichment table. Skipped quietly
            # when the table is absent (parquet dev mode before a load).
            has_enrich_table = bool(con.execute(
                "SELECT 1 FROM information_schema.tables "
                "WHERE table_name = 'product_enrichment'"
            ).fetchone())
            if has_enrich_table:
                _img_valid = _VALID_UPC_SQL.format(col="CAST(upc AS VARCHAR)")
                order_by = (
                    f"(({_img_valid}) AND EXISTS (SELECT 1 FROM product_enrichment _img "
                    "WHERE _img.upc = LTRIM(CAST(upc AS VARCHAR), '0') "
                    "AND _img.image_url IS NOT NULL AND _img.image_url <> '')) DESC, "
                    + order_by
                )
        if q and sort == "product_name":
            order_by = f"{rel_expr} DESC, {order_by}"

        # "Group by Case Mix RIP": each row carries the RIP-sheet rip_code for
        # its UPC (a UPC can be listed under a RIP without the CPL row
        # referencing it back; we use MIN(rip_code) as the canonical group key
        # so the same UPC always lands in the same coloured cluster). When the
        # toggle is on we sort by it first so products sharing a rebate appear
        # next to each other; when it's off we still surface the field but
        # don't disturb the ranked / user-picked sort. The CTE columns are
        # aliased (rg_*) so the unqualified WHERE clause above keeps resolving
        # to the CPL table unambiguously.
        if group_by_rip:
            # Sort clusters by the count of rows surfaced IN THE CURRENT VIEW
            # (after the user's search/filter), biggest first. User rule: when
            # I search 'LIND BIN' with group-by-RIP on, the cluster showing 15
            # filtered products belongs above the one showing 1, regardless of
            # how big either cluster is globally. COUNT(*) OVER runs after the
            # WHERE clause and the QUALIFY-dedup, so it reflects exactly what
            # the user sees. rip_group_member_count (global cluster size) stays
            # in the SELECT for the UI badge but is no longer the sort key.
            order_by = (
                "rip_group_code IS NULL, "
                "COUNT(*) OVER (PARTITION BY rip_group_code) DESC NULLS LAST, "
                "rip_group_code ASC, "
                + order_by
            )
        # When group_by_rip is on we LEFT JOIN the fanned-out rip_memberships
        # so a UPC stacked under N rebates emits one row per rebate (per
        # cluster). When off, we LEFT JOIN the per-UPC canonical group
        # (one row) so normal browsing is undisturbed.
        if group_by_rip:
            rip_select_sql = """
                   rm.membership_code AS rip_group_code,
                   rm.rip_group_count,
                   rcs.cluster_members AS rip_group_member_count,
                   CASE
                       WHEN rm.rip_group_min IS NULL THEN false
                       -- Single-listing real UPC qualifies by sheet presence, so
                       -- a non-matching CPL code is NOT a mismatch here.
                       WHEN COALESCE(mlc.n_listings, 1) <= 1
                            AND LENGTH(REPLACE(CAST(upc AS VARCHAR), LEFT(CAST(upc AS VARCHAR), 1), '')) > 0 THEN false
                       WHEN rip_code IS NULL OR CAST(rip_code AS VARCHAR) IN ('', '0') THEN true
                       WHEN list_contains(rm.rip_group_codes, CAST(rip_code AS VARCHAR)) THEN false
                       ELSE true
                   END AS rip_cpl_mismatch
            """
            data_cte_sql = rip_cte_sql
            data_join_sql = rip_join_sql
        else:
            rip_src_legacy = read_parquet(con, "rip")
            data_cte_sql = f"""
                WITH rip_groups AS (
                    SELECT wholesaler AS rg_wholesaler,
                           edition    AS rg_edition,
                           CAST(upc AS VARCHAR) AS rg_upc,
                           MIN(CAST(rip_code AS VARCHAR)) AS rip_group_min,
                           COUNT(DISTINCT CAST(rip_code AS VARCHAR)) AS rip_group_count,
                           list_distinct(list(CAST(rip_code AS VARCHAR))) AS rip_group_codes
                    FROM {rip_src_legacy}
                    WHERE upc IS NOT NULL
                      AND CAST(upc AS VARCHAR) NOT IN ('', '0', 'None', 'nan')
                      AND rip_code IS NOT NULL
                      AND CAST(rip_code AS VARCHAR) NOT IN ('', '0', 'None', 'nan')
                    GROUP BY wholesaler, edition, CAST(upc AS VARCHAR)
                )
            """
            data_join_sql = """
                LEFT JOIN rip_groups rg
                  ON rg.rg_wholesaler = wholesaler
                 AND rg.rg_edition    = edition
                 AND rg.rg_upc        = CAST(upc AS VARCHAR)
            """
            # Off path: keep the canonical-group select so the "RIP family"
            # tag still rides along on rows even when clustering is off.
            rip_select_sql = """
                   CASE
                       WHEN rg.rip_group_min IS NULL THEN NULL
                       WHEN rip_code IS NOT NULL AND CAST(rip_code AS VARCHAR) <> ''
                            AND CAST(rip_code AS VARCHAR) <> '0'
                            AND list_contains(rg.rip_group_codes, CAST(rip_code AS VARCHAR))
                       THEN CAST(rip_code AS VARCHAR)
                       ELSE rg.rip_group_min
                   END AS rip_group_code,
                   rg.rip_group_count,
                   CASE
                       WHEN rg.rip_group_min IS NULL THEN false
                       WHEN rip_code IS NULL OR CAST(rip_code AS VARCHAR) IN ('', '0') THEN true
                       WHEN list_contains(rg.rip_group_codes, CAST(rip_code AS VARCHAR)) THEN false
                       ELSE true
                   END AS rip_cpl_mismatch
            """

        # Same trend CTE + LEFT JOIN as the count query so total / pages stay
        # consistent when the user has Price Drop / Price Increase checked.
        data_cte_full = _add_cte(data_cte_sql, trend_cte_body)
        rows = con.execute(f"""
            {data_cte_full}
            SELECT wholesaler, edition, upc, product_name, product_type,
                   brand_clean AS brand, enr_name,
                   unit_qty, unit_volume, unit_type, vintage, frontline_case_price, frontline_unit_price,
                   best_case_price, best_unit_price, effective_case_price,
                   has_discount, has_rip, has_closeout, discount_pct,
                   total_savings_per_case, rip_code, combo_code,
                   discount_1_qty, discount_1_amt,
                   discount_2_qty, discount_2_amt,
                   discount_3_qty, discount_3_amt,
                   discount_4_qty, discount_4_amt,
                   discount_5_qty, discount_5_amt,
                   -- Date-aware "live now" RIP price (active on $as_of) + the
                   -- savings vs the stable month price. Computed here so ORDER BY
                   -- can sort the whole grid by it. Mirror of pricing.attach_live_rip.
                   {live_eff_expr} AS live_effective_case_price,
                   {live_amt_expr} AS live_rip_amt,
                   ({live_eff_expr}) < effective_case_price - 0.005 AS live_better_than_month,
                   ROUND(effective_case_price - ({live_eff_expr}), 2) AS live_savings,
                   {rip_select_sql}
            FROM {src}
            {data_join_sql}
            {trend_join_sql}
            WHERE {where_clause}
            {dedup}
            ORDER BY {order_by}
            LIMIT $limit OFFSET $offset
        """, {**params, "limit": limit, "offset": offset}).fetchdf()

        # Replace NaN with None so JSON serialization works
        import math as _math
        records = rows.to_dict(orient="records")
        for rec in records:
            for k, v in list(rec.items()):
                if isinstance(v, float) and _math.isnan(v):
                    rec[k] = None
            # New Items mode: stamp the edition each SKU was introduced in.
            if intro_map:
                rec["introduced_edition"] = intro_map.get(
                    (rec.get("wholesaler"), str(rec.get("upc") or "").lstrip("0")))

        # Family grouping key for the Products list, so a product's
        # differently-named sizes collapse into ONE card.
        #
        # Phase 1 — UPC-first: any SKU with a CLEAN barcode (_is_clean_upc, the
        # same notion of "real barcode" the rest of the app uses) groups by that
        # UPC, so the same product carried under different distributor names /
        # pack sizes (e.g. "CASAL GAR VV WHITENV" + "CASAL GAR VVWH BAG6P" +
        # "CASAL GARCIA WH VERDE", all UPC 764793208301) collapses into ONE card
        # with the enriched Go-UPC name as the header. The individual distributor
        # SKU names then show on the expanded size rows.
        # Phase 2 (legacy fallback, for SKUs WITHOUT a clean UPC — placeholder /
        # '0' barcodes, most wines): spirits group by the enrichment-name core
        # (catalogue-name core when un-enriched); wine groups by product_name
        # (its vintages share a card).
        #
        # First pass: pick ONE header per clean UPC so every row of the group
        # agrees regardless of which row the frontend renders first — prefer the
        # enriched name, else the most common SKU name (tie-break the longest /
        # most descriptive).
        from collections import Counter as _Counter
        upc_display: dict = {}
        upc_names: dict = {}
        for rec in records:
            if not _is_clean_upc(rec.get("upc")):
                continue
            un = str(rec.get("upc")).lstrip("0")
            enr = rec.get("enr_name")
            if enr and un not in upc_display:
                upc_display[un] = _display_name(enr)
            upc_names.setdefault(un, _Counter())[str(rec.get("product_name") or "")] += 1
        for un, names in upc_names.items():
            if un not in upc_display:
                # Prefer a non-junk title (no closeout / pack tokens), then the
                # most common name, then the longest (most descriptive).
                upc_display[un] = sorted(
                    names.items(),
                    key=lambda kv: (_header_junk(kv[0]), -kv[1], -len(kv[0])),
                )[0][0]

        # Phase 3 — CELR Product Number (docs/CELR_PRODUCT_NUMBER_DESIGN.md):
        # the persistent FAMILY registry spanning sizes/vintages/distributors.
        # Resolution order per row: (1) registry by BARCODE; (2) registry by
        # NAME KEY (covers placeholder barcodes like 111111111117, whose rows
        # must still join their family — nothing is ever hidden, the family
        # only decides which card a listing sits under); (3) the per-UPC /
        # name-core legacy behaviour below.
        from backend.celr import family_key as _celr_family_key
        from backend.celr import display_header as _celr_display_header
        celr_map: dict = {}
        celr_key_map: dict = {}
        try:
            celr_upcs = sorted({str(rec.get("upc")).lstrip("0") for rec in records
                                if _is_clean_upc(rec.get("upc"))})
            if celr_upcs:
                ph = ", ".join(f"$cu{i}" for i in range(len(celr_upcs)))
                prm = {f"cu{i}": u for i, u in enumerate(celr_upcs)}
                cdf = con.execute(
                    f"SELECT upc_norm, cpn, header_name FROM celr_products "
                    f"WHERE upc_norm IN ({ph})", prm).fetchdf()
                for _, r in cdf.iterrows():
                    celr_map[str(r["upc_norm"])] = (int(r["cpn"]), r["header_name"])
            # name keys for every row not resolved by barcode
            keys = sorted({
                _celr_family_key(rec.get("product_name"), rec.get("product_type"))
                for rec in records
                if str(rec.get("upc") or "").lstrip("0") not in celr_map
            })
            if keys:
                ph = ", ".join(f"$ck{i}" for i in range(len(keys)))
                prm = {f"ck{i}": k for i, k in enumerate(keys)}
                kdf = con.execute(
                    f"SELECT key, cpn, header_name FROM celr_family_keys "
                    f"WHERE key IN ({ph})", prm).fetchdf()
                for _, r in kdf.iterrows():
                    celr_key_map[str(r["key"])] = (int(r["cpn"]), r["header_name"])
        except Exception:
            celr_map, celr_key_map = {}, {}

        for rec in records:
            pname = rec.get("product_name") or ""
            ptype = (rec.get("product_type") or "")
            brand = rec.get("brand") or ""
            enr = rec.get("enr_name")
            un = str(rec.get("upc") or "").lstrip("0")
            hit = celr_map.get(un) or celr_key_map.get(
                _celr_family_key(pname, ptype))
            if hit:
                cpn, header = hit
                rec["product_group"] = f"cpn:{cpn}"
                rec["product_display"] = _celr_display_header(header, ptype) or pname
                rec["celr_product_number"] = f"CELR-{cpn:06d}"
            elif _is_clean_upc(rec.get("upc")):
                # Distributor- AND name-agnostic key so every listing of
                # this barcode merges into one card.
                rec["product_group"] = "u:" + un
                rec["product_display"] = upc_display.get(un) or pname
            else:
                if "wine" in ptype.lower():
                    core, display = "w:" + pname.lower().strip(), pname
                elif enr:
                    core, display = "e:" + _product_core(enr), _display_name(enr)
                else:
                    core, display = "c:" + _catalog_core(pname), pname
                rec["product_group"] = f"{brand}|{core}"
                rec["product_display"] = display or pname
            rec.pop("enr_name", None)   # internal only

        # When the toggle is on, attach the FULL list of RIP codes per UPC
        # (a single UPC can stack across several rebates). Done as a separate
        # batch lookup so we hand FastAPI a clean Python list[str] instead of
        # the numpy ndarray DuckDB returns from list_sort/list_distinct,
        # which the encoder cannot serialize.
        if group_by_rip and records:
            pairs = sorted({(r.get("wholesaler"), r.get("edition"), str(r.get("upc") or ""))
                            for r in records if r.get("upc")})
            codes_by_key: dict[tuple, list[str]] = {}
            if pairs:
                ph = ", ".join(f"($w{i}, $e{i}, $u{i})" for i in range(len(pairs)))
                prm = {}
                for i, (w, e, u) in enumerate(pairs):
                    prm[f"w{i}"], prm[f"e{i}"], prm[f"u{i}"] = w, e, u
                try:
                    rip_src2 = read_parquet(con, "rip")
                    rdf = con.execute(f"""
                        SELECT DISTINCT wholesaler, edition,
                               CAST(upc AS VARCHAR) AS upc,
                               CAST(rip_code AS VARCHAR) AS rip_code
                        FROM {rip_src2}
                        WHERE upc IS NOT NULL AND rip_code IS NOT NULL
                          AND CAST(upc AS VARCHAR) NOT IN ('', '0', 'None', 'nan')
                          AND CAST(rip_code AS VARCHAR) NOT IN ('', '0', 'None', 'nan')
                          AND (wholesaler, edition, CAST(upc AS VARCHAR)) IN ({ph})
                    """, prm).fetchdf()
                    for _, r in rdf.iterrows():
                        key = (r["wholesaler"], r["edition"], r["upc"])
                        codes_by_key.setdefault(key, []).append(str(r["rip_code"]))
                except Exception:
                    codes_by_key = {}
            for rec in records:
                key = (rec.get("wholesaler"), rec.get("edition"), str(rec.get("upc") or ""))
                codes = codes_by_key.get(key)
                rec["rip_all_codes"] = sorted(set(codes)) if codes else None

        # Look up next-month prices for the same UPCs so the UI can show
        # a "Better Price: Same / This Month / Next Month" column.
        if not edition:
            _attach_next_month_prices(con, src, records)

        # Optionally enrich each item with discount + RIP tier sub-rows.
        if include_tiers:
            _attach_discount_rip_tiers(con, records, ref_date=as_of)
            # Last 3 existing editions (1-case-discount + best-RIP prices + per-
            # edition tiers) for the two-line 3-month sparkline + its popover.
            _attach_price_3mo(con, records)

        # The date-aware "live now" RIP price (live_effective_case_price,
        # live_rip_amt, live_better_than_month, live_savings) is computed in the
        # SQL above so the whole grid can be SORTED by it (sort=live_effective_
        # case_price / live_savings), not just annotated post-pagination.

        # Go-UPC thumbnail per row (one batch query; served from R2 CDN).
        _attach_enrichment_image(con, records)
        _attach_sku_mapping(con, records)
        _attach_dup_upc(con, src, records)
        _attach_best_qd(records)   # deepest QD bracket for the card sticker

        return {
            "total": count,
            "limit": limit,
            "offset": offset,
            "items": records,
            "corrected_query": corrected_query,
        }


def _attach_best_qd(records):
    """Attach `best_qd` = the deepest QUANTITY-DISCOUNT bracket for the Products
    card sticker (RIP is NOT a QD). All inputs are already on the row:
    best_case_price / best_unit_price (price after the best QD, per case & bottle),
    frontline_case_price, and the discount_N_qty/amt brackets.

      cases          physical cases to unlock the deepest QD
      case_price     best case price (best_case_price)
      bottle_price   best per-bottle cost (best_unit_price, else case/pack)
      save_per_case  frontline_case_price - best_case_price
      total_cost     cases * case_price  (cash to buy the bracket)
      total_save     cases * save_per_case

    None when there is no real QD (best_case_price not below frontline)."""
    for rec in records:
        front = rec.get("frontline_case_price")
        best = rec.get("best_case_price")
        if front is None or best is None or best >= front - 0.005:
            rec["best_qd"] = None
            continue
        # deepest bracket = the discount tier with the largest per-case amount
        best_amt, best_qty = -1.0, None
        for i in range(1, 6):
            try:
                af = float(rec.get(f"discount_{i}_amt"))
            except (TypeError, ValueError):
                continue
            if af != af or af <= 0:
                continue
            if af > best_amt:
                best_amt = af
                m = re.match(r"^\s*(\d+(?:\.\d+)?)", str(rec.get(f"discount_{i}_qty") or ""))
                best_qty = float(m.group(1)) if m else None
        cases = int(math.ceil(best_qty - 1e-9)) if best_qty and best_qty > 0 else None
        # A 1-case QD is just the baseline single-case price (already the headline),
        # not a volume bracket worth a sticker — skip it.
        if cases is not None and cases <= 1:
            rec["best_qd"] = None
            continue
        try:
            pack = float(rec.get("unit_qty") or 0)
        except (TypeError, ValueError):
            pack = 0.0
        bp = rec.get("best_unit_price")
        bottle = (round(float(bp), 2) if bp is not None
                  else (round(best / pack, 2) if pack else None))
        save_pc = round(front - best, 2)
        rec["best_qd"] = {
            "cases": cases,
            "case_price": round(best, 2),
            "bottle_price": bottle,
            "save_per_case": save_pc,
            "total_cost": round(cases * best, 2) if cases else None,
            "total_save": round(cases * save_pc, 2) if cases else None,
        }


# Valid-UPC predicate reused for new-item detection: drop NULL/blank/stub UPCs
# ('0', all-zeros/nines/ones, '999999…' placeholders, too-short) so cross-edition
# matching only relies on real barcodes. Mirrors the stub filtering in
# /cross-distributor. {col} is substituted with the column to test.
_VALID_UPC_SQL = (
    "{col} IS NOT NULL AND {col} <> '' AND {col} <> '0'"
    " AND NOT regexp_matches({col}, '^(0+|9+|1+)$')"
    " AND NOT regexp_matches({col},"
    " '^(0{{9}}|1{{9}}|2{{9}}|3{{9}}|4{{9}}|5{{9}}|6{{9}}|7{{9}}|8{{9}}|9{{9}})')"
    " AND NOT {col} LIKE '999999%'"
    " AND LENGTH(LTRIM({col}, '0')) >= 8"
)

# Canonical container-type bucket from the messy DB unit_type (keg/KEG/Keg,
# BOTTLE/Bottle/Glass/PET, CAN/Can/can, '5.17 1/6 BBL', ...). A keg is anything
# keg/barrel or a gallon volume; a can is anything 'can'; everything else is a
# bottle. Mirrors the frontend lib/distributors helpers so the Unit Type filter,
# its facet counts, and the on-card label all agree.
_UNIT_KIND_SQL = (
    "CASE "
    "WHEN lower(COALESCE(unit_type, '')) LIKE '%keg%' "
    "  OR lower(COALESCE(unit_type, '')) LIKE '%bbl%' "
    "  OR lower(COALESCE(unit_type, '')) LIKE '%barrel%' "
    "  OR lower(COALESCE(unit_volume, '')) LIKE '%gal%' THEN 'Keg' "
    "WHEN lower(COALESCE(unit_type, '')) LIKE '%can%' THEN 'Can' "
    "ELSE 'Bottle' END"
)


@router.get("/semantic-search")
def semantic_search(
    q: str = Query(..., description="Free-text descriptive phrase, e.g. 'old vine zinfandel from California', 'single barrel bourbon', 'natural orange wine'."),
    limit: int = Query(24, ge=1, le=100, description="Max product cards returned"),
    product_type: Optional[str] = Query(None, description="Optional product_type narrowing (Wine, Spirits, Beer, ...)"),
):
    """Long-tail semantic catalog search.

    Layer #3 of the assistant's semantic stack. Layers #1 (region) and #2
    (varietal) handle structured filters; this endpoint catches free-text
    descriptive phrases that don't map to a fixed taxonomy. Returns ranked
    product cards in the same shape as /api/catalog/search items, plus a
    `score` field for the UI to display.

    Engine: Postgres FTS today. Will swap to pgvector + Voyage when
    VOYAGE_API_KEY is set and the embedding index has been built — same
    API contract."""
    from backend.semantic_search import semantic_search as _ss
    from backend.pg import get_pg
    with get_pg() as pg, get_duckdb() as con:
        rows = _ss(pg, con, q, limit=limit, product_type=product_type)
    return {"q": q, "count": len(rows), "items": rows}


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
    as_of: Optional[str] = Query(None, description="Reference date (YYYY-MM-DD, default today ET) for RIP window status + the date-aware 'live now' RIP price overlay per row."),
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
            clause, qp, _ = _q_clause(q, _brand_initialisms(con, src),
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
                   e.rip_savings, e.rip_windows,
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
            _attach_discount_rip_tiers(con, records, ref_date=as_of)
            _attach_price_3mo(con, records)
        _attach_live_rip(con, records, ref_date=as_of)
        _attach_enrichment_image(con, records)
        _attach_sku_mapping(con, records)
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
    rip_code: Optional[str] = None,
    as_of: Optional[str] = None,
):
    """Full product detail with all pricing, discount tiers, and RIP info.

    ``as_of`` (YYYY-MM-DD, default today ET) is the reference date each RIP /
    discount window is classified against, and the date the 'live now' RIP
    price overlay (live_effective_case_price / live_rip_amt /
    live_better_than_month on the product) is computed for.

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
            # Normalise BOTH sides: the caller passes the RAW vintage as stored
            # on the source row (a 2-digit '20', a float '2018.0', or 'NV'),
            # while the column is normalised to a 4-digit year. Comparing the
            # normalised column against the raw param made a '20' caller miss a
            # '2020'-normalised row, so the detail 404'd and the modal hung on
            # "Loading…". Mirror /product-breakdown: normalise the param too.
            extra_filters.append(
                f"AND ({_vintage_norm_sql('vintage')}) "
                f"IS NOT DISTINCT FROM ({_vintage_norm_sql('$vnorm')})"
            )
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

        # The UPC uniquely identifies the SKU, so when it's given we resolve by it
        # and DON'T require an exact product_name match — links into this page can
        # carry a cleaned/display name ("GLENLIVET 12YR SCOTCH") that differs from
        # the catalog row ("GLENLIVET 12YR SCOTCH 12PK"); requiring the name made
        # the lookup miss and dropped ALL enrichment (size, region, specs, image).
        name_filter = "" if upc else "AND product_name = $product_name"
        # DuckDB rejects named params a query doesn't reference, so drop
        # product_name from the main lookup when we're resolving by UPC.
        main_params = {k: v for k, v in params.items() if not (upc and k == "product_name")}
        row = con.execute(f"""
            SELECT * FROM {src}
            WHERE wholesaler = $wholesaler {name_filter}
            {edition_filter}
            {' '.join(extra_filters)}
            LIMIT 1
        """, main_params).fetchdf()

        # Fall back to a name match if the UPC didn't resolve (e.g. a stale link
        # whose UPC isn't on the current edition).
        if row.empty and upc:
            fb_params = {k: v for k, v in params.items()
                         if k in ("wholesaler", "product_name", "edition", "latest_ed")}
            row = con.execute(f"""
                SELECT * FROM {src}
                WHERE wholesaler = $wholesaler AND product_name = $product_name
                {edition_filter}
                LIMIT 1
            """, fb_params).fetchdf()

        if row.empty:
            return {"error": "Product not found"}

        def _iso_date(v):
            """Render a date-ish cell as 'YYYY-MM-DD' or None."""
            if v is None or (isinstance(v, float) and v != v):
                return None
            s = str(v)[:10]
            return s or None

        # Get discount tiers (CPL)
        tiers = []
        item = row.iloc[0]
        case_price_for_roi = float(item["frontline_case_price"]) if item.get("frontline_case_price") else 0.0
        # The CPL row's own window classifies its discount tiers.
        cpl_win = _pricing.window_status(item.get("from_date"), item.get("to_date"), as_of)
        cpl_from, cpl_to = _iso_date(item.get("from_date")), _iso_date(item.get("to_date"))
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
                    "from_date": cpl_from,
                    "to_date": cpl_to,
                    "window_status": cpl_win["status"],
                    "days_to_expire": cpl_win["days_to_expire"],
                })

        # Get RIP tiers (RIP sheet, joined by rip_code + upc + edition)
        rip_tiers = []
        # Caller can pin the modal to a specific RIP cluster via the
        # `rip_code` query param — a UPC can sit under several rebates and
        # the cpl row's canonical rip_code is just one of them. Falls back to
        # the canonical when no override is sent.
        override_rc = rip_code if (rip_code and str(rip_code).strip()
                                   and str(rip_code) not in ("None", "nan", "0"))\
                                  else None
        rip_code = override_rc or item.get("rip_code")
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
        un_detail = str(upc or "").lstrip("0")
        if un_detail:
            rip_src = read_parquet(con, "rip")
            # Some wholesalers (Fedway) pack several RIP codes into one cell,
            # e.g. "240002 250002". The RIP sheet stores each code as its own
            # row, so match ANY of the split codes (same as pricing.attach_tiers
            # and derive.py) instead of the literal multi-code string.
            rcodes = (_pricing._split_rip_codes(rip_code) or [str(rip_code)]) \
                if rip_code and str(rip_code) not in ("None", "nan", "0", "") else []
            # A UPC can sit under SEVERAL rebates (Buehler 724404009031: mix
            # RIP 100567 at 2cs $15 AND standalone 100714 at 2cs $60). The CPL
            # row references only one, but the buyer must see every program to
            # pick the better one — so on the SINGLE-LISTING path fetch every
            # code listing this UPC, the same rule pricing.attach_tiers uses.
            # Multi-listing barcodes keep the strict own-code lookup (a reused
            # barcode must not borrow another product's RIP). An explicit
            # rip_code override still pins the modal to that cluster alone.
            single_listing = True
            try:
                craw_d = read_parquet(con, "cpl")
                nrow = con.execute(f"""
                    SELECT COUNT(DISTINCT (product_name, COALESCE(unit_volume, ''),
                                           COALESCE(CAST(vintage AS VARCHAR), ''),
                                           COALESCE(regexp_replace(TRIM(CAST(unit_qty AS VARCHAR)), '\\.0+$', ''), ''))) AS n
                    FROM {craw_d}
                    WHERE wholesaler = $w AND edition = $e
                      AND LTRIM(CAST(upc AS VARCHAR), '0') = $u
                """, {"w": wholesaler, "e": ed, "u": un_detail}).fetchone()
                single_listing = bool(nrow) and int(nrow[0]) <= 1
            except Exception:
                single_listing = True
            broad = single_listing and not override_rc
            rc_ph = ", ".join(f"$rc{i}" for i in range(len(rcodes))) or "''"
            # DuckDB rejects bind params the SQL doesn't reference, so the
            # code params only exist on the strict (non-broad) path.
            rc_params = {} if broad else {f"rc{i}": c for i, c in enumerate(rcodes)}
            rip_rows = con.execute(f"""
                SELECT CAST(rip_code AS VARCHAR) AS rip_code, rip_description,
                       from_date, to_date,
                       rip_unit_1, rip_qty_1, rip_amt_1,
                       rip_unit_2, rip_qty_2, rip_amt_2,
                       rip_unit_3, rip_qty_3, rip_amt_3,
                       rip_unit_4, rip_qty_4, rip_amt_4
                FROM {rip_src}
                WHERE wholesaler = $wholesaler
                  AND edition = $edition
                  AND LTRIM(CAST(upc AS VARCHAR), '0') = $un
                  AND ({'1 = 1' if broad else f'CAST(rip_code AS VARCHAR) IN ({rc_ph})'})
            """, {
                **rc_params, "wholesaler": wholesaler,
                "edition": ed, "un": un_detail,
            }).fetchdf()

            # Case-credit lookups for this product's tiers: per-UPC row first,
            # then the size/pack fallback (mirrors pricing.attach_tiers and
            # derive.rip_credit_by_pack), so the modal/assistant quote the
            # PHYSICAL buy-in for half-case qualifiers.
            _credit_rows: dict = {}
            _credit_pack_d: dict = {}
            try:
                _crd = con.execute(f"""
                    SELECT CAST(rip_code AS VARCHAR) AS rc, upc, case_credit
                    FROM {read_parquet(con, 'rip_credits')}
                    WHERE wholesaler = $w AND edition = $e
                """, {"w": wholesaler, "e": ed}).fetchdf()
                for _, _c in _crd.iterrows():
                    _credit_rows[(str(_c["rc"]), str(_c["upc"]))] = float(_c["case_credit"])
                _crp = con.execute(f"""
                    SELECT CAST(rc.rip_code AS VARCHAR) AS rc, c.unit_volume AS uv,
                           REGEXP_REPLACE(TRIM(CAST(c.unit_qty AS VARCHAR)), '\\.0+$', '') AS uqn,
                           MIN(rc.case_credit) AS case_credit
                    FROM {read_parquet(con, 'rip_credits')} rc
                    JOIN {read_parquet(con, 'cpl_enriched')} c
                      ON c.wholesaler = rc.wholesaler AND c.edition = rc.edition
                     AND LTRIM(CAST(c.upc AS VARCHAR), '0') = rc.upc
                    WHERE rc.wholesaler = $w AND rc.edition = $e
                    GROUP BY 1, 2, 3
                    HAVING COUNT(DISTINCT rc.case_credit) = 1
                """, {"w": wholesaler, "e": ed}).fetchdf()
                for _, _c in _crp.iterrows():
                    _credit_pack_d[(str(_c["rc"]), str(_c["uv"] or ""),
                                    str(_c["uqn"] or ""))] = float(_c["case_credit"])
            except Exception:
                pass
            _item_uqn = re.sub(r"\.0+$", "", str(item.get("unit_qty") or "").strip())

            def _detail_credit(code):
                c = _credit_rows.get((str(code or ""), un_detail))
                if c is None:
                    c = _credit_pack_d.get((str(code or ""),
                                            str(item.get("unit_volume") or ""), _item_uqn))
                return c

            seen = set()
            for _, r in rip_rows.iterrows():
                description = r.get("rip_description")
                tier_code = str(r.get("rip_code") or "").strip() or None
                rwin = _pricing.window_status(r.get("from_date"), r.get("to_date"), as_of)
                rfrom, rto = _iso_date(r.get("from_date")), _iso_date(r.get("to_date"))
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
                    # Include the window in the signature so two distinct date
                    # ranges at the same qty/amount (e.g. an active 1-8 Jun deal
                    # and an upcoming 11-30 Jun one) both survive — the buyer
                    # sees the full picture, each badged with its own status.
                    sig = (tier_code, int(rqty_f), round(ramt_f, 2), str(unit), rfrom, rto)
                    if sig in seen:
                        continue
                    seen.add(sig)
                    # Case-credit model (FOUNDATION 3.4.1): per-UPC credit, with
                    # the size/pack fallback for placeholder-barcode rows. The
                    # per-physical-case rebate scales by it and the physical
                    # buy-in is qty/credit.
                    credit = _detail_credit(tier_code)
                    is_btl_unit = str(unit or "").lower().startswith("b")
                    # Bottle-unit RIPs are per-bottle → ×pack for per-case.
                    per_case = round(_rip_per_case(ramt_f, rqty_f, unit, item_pack,
                                                   credit), 2)
                    qual_cases = (None if (is_btl_unit or not credit or credit == 1.0)
                                  else round(rqty_f / credit, 2))
                    bundle_cost = _rip_bundle_cost(
                        int(qual_cases) if qual_cases else int(rqty_f),
                        unit, case_price, item_btl_price)
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
                        "code": tier_code,
                        "description": str(description) if description else None,
                        "from_date": rfrom,
                        "to_date": rto,
                        "window_status": rwin["status"],
                        "days_to_expire": rwin["days_to_expire"],
                        "is_time_sensitive": _pricing.is_time_sensitive_window(
                            r.get("from_date"), r.get("to_date")),
                        **({"case_credit": credit, "qualified_cases": qual_cases}
                           if qual_cases else {}),
                    })
            # Order by program (code), then qty, then window start so an
            # "active now" tier sorts ahead of a later "starts DD MMM" tier at
            # the same qty and each RIP's tiers stay contiguous for display.
            rip_tiers.sort(key=lambda x: (x.get("code") or "", x["qty"], x.get("from_date") or ""))

        # Go-UPC enrichment (image + canonical details), matched by normalised
        # UPC. Empty/absent table -> no enrichment, never an error. category_path
        # and specs are stored as JSON text; parse them back to list/dict here.
        enrichment = None
        prod_upc = item.get("upc")
        # Placeholder barcodes carry someone else's enrichment (the Kyocera
        # incident): only a real barcode may pull Go-UPC details.
        if _is_clean_upc(prod_upc):
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

        # AI explainer (pre-generated). Falls back to None when there isn't
        # one yet, so the UI hides the section gracefully.
        ai_blurb = None
        try:
            from backend.pg import get_pg
            pu = str(prod_upc) if prod_upc is not None else ""
            if pu:
                with get_pg() as pg:
                    rec = pg.execute(
                        "SELECT blurb FROM ai_product_blurbs "
                        "WHERE wholesaler = %s AND LTRIM(upc, '0') = LTRIM(%s, '0') AND edition = %s "
                        "ORDER BY generated_at DESC LIMIT 1",
                        (wholesaler, pu, str(item.get("edition") or "")),
                    ).fetchone()
                    if rec and rec.get("blurb"):
                        ai_blurb = rec["blurb"]
        except Exception:
            ai_blurb = None

        # Date-aware "live now" RIP overlay on the product itself, so the modal
        # can show the month-stable price AND the price live on `as_of`.
        prod_rec = row.to_dict(orient="records")[0]
        _attach_live_rip(con, [prod_rec], ref_date=as_of)
        _attach_sku_mapping(con, [prod_rec])

        # CELR Product Number for the detail header / quick view chip.
        try:
            _pu = str(prod_rec.get("upc") or "").lstrip("0")
            if _pu:
                _cr = con.execute(
                    "SELECT cpn, header_name FROM celr_products WHERE upc_norm = $u",
                    {"u": _pu}).fetchone()
                if _cr:
                    from backend.celr import display_header as _cdh
                    prod_rec["celr_product_number"] = f"CELR-{int(_cr[0]):06d}"
                    prod_rec["celr_header_name"] = _cdh(
                        _cr[1], prod_rec.get("product_type"))
        except Exception:
            pass

        return {
            "product": _clean_record(prod_rec),
            "discount_tiers": tiers,
            "rip_tiers": rip_tiers,
            "enrichment": enrichment,
            "ai_blurb": ai_blurb,
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
    """Month-over-month price comparison across the two most recent editions
    LOADED in the system (per wholesaler).

    For each (wholesaler, upc, product_name) present in both the latest edition
    and the one right before it, return the earlier and latest prices and the
    delta. Used by the dashboard "Price Changes" tile. It always compares the
    last two months of data on hand, so it shows results even when no future
    edition has been ingested yet (the old this->next compare was empty whenever
    next month wasn't loaded). `current_ym`/`next_ym` name the two months
    compared (earlier -> later) for the header.
    """
    def _ed_ok(x) -> bool:
        return x is not None and not (isinstance(x, float) and x != x) and str(x) != "nan"

    with get_duckdb() as con:
        src = read_parquet(con, "cpl_enriched")

        params = {}
        ws_filter = ""
        if wholesaler:
            ws_filter = " AND c.wholesaler = $wholesaler AND n.wholesaler = $wholesaler"
            params["wholesaler"] = wholesaler
        pt_filter = ""
        if product_type:
            pt_filter = " AND c.product_type = $product_type"
            params["product_type"] = product_type

        # The two most recent editions LOADED per wholesaler: cur_ed = newest,
        # prev_ed = the one right before it. We compare prev_ed -> cur_ed.
        eds_df = con.execute(f"""
            WITH e AS (SELECT DISTINCT wholesaler, edition FROM {src} WHERE edition IS NOT NULL)
            SELECT wholesaler,
                   MAX(edition) AS cur_ed,
                   MAX(CASE WHEN edition < (
                         SELECT MAX(edition) FROM e e2 WHERE e2.wholesaler = e.wholesaler
                       ) THEN edition END) AS prev_ed
            FROM e GROUP BY wholesaler
        """).fetchdf()
        cur_map = dict(zip(eds_df["wholesaler"], eds_df["cur_ed"]))
        prev_map = dict(zip(eds_df["wholesaler"], eds_df["prev_ed"]))

        # Global two most-recent editions, for the header label.
        all_eds = sorted({str(e) for e in con.execute(
            f"SELECT DISTINCT edition FROM {src} WHERE edition IS NOT NULL"
        ).fetchdf()["edition"]})
        next_ym = all_eds[-1] if all_eds else _current_yyyy_mm()
        current_ym = all_eds[-2] if len(all_eds) >= 2 else next_ym

        # Per-wholesaler edition pair filters: c = prev (earlier), n = cur (latest).
        pair_clauses = []
        for i, ws in enumerate(sorted(set(cur_map) | set(prev_map))):
            ce = prev_map.get(ws)   # earlier edition -> the "c" (current_*) side
            ne = cur_map.get(ws)    # latest edition  -> the "n" (next_*) side
            if not _ed_ok(ce) or not _ed_ok(ne):
                continue
            params[f"ws_{i}"] = ws
            params[f"ce_{i}"] = str(ce)
            params[f"ne_{i}"] = str(ne)
            pair_clauses.append(
                f"(c.wholesaler = $ws_{i} AND c.edition = $ce_{i} AND n.wholesaler = $ws_{i} AND n.edition = $ne_{i})"
            )
        if not pair_clauses:
            return {"current_ym": current_ym, "next_ym": next_ym, "total": 0, "returned": 0, "items": []}

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
            WITH upc_ed_ref AS (
                -- Per (UPC, edition) cross-distributor reference: the highest
                -- case price any distributor lists for that UPC and how many
                -- distributors carry it. Lets us spot a distributor whose price
                -- is a wild outlier vs peers (a likely unit/pack data error) so
                -- the row can be kept out of the Month-over-Month movers and left
                -- to QA: Data Quality Anomalies instead.
                SELECT LTRIM(CAST(upc AS VARCHAR), '0') AS un, edition,
                       MAX(frontline_case_price) AS max_price,
                       COUNT(DISTINCT wholesaler) AS n_dist
                FROM {src}
                WHERE frontline_case_price > 0 AND upc IS NOT NULL
                  AND CAST(upc AS VARCHAR) NOT IN ('', '0')
                GROUP BY 1, 2
            )
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
                     ELSE 0 END AS effective_delta_pct,
                rc.max_price AS curr_xdist_max, rc.n_dist AS curr_n_dist,
                rn.max_price AS next_xdist_max, rn.n_dist AS next_n_dist
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
            LEFT JOIN upc_ed_ref rc ON rc.un = LTRIM(CAST(c.upc AS VARCHAR), '0') AND rc.edition = c.edition
            LEFT JOIN upc_ed_ref rn ON rn.un = LTRIM(CAST(n.upc AS VARCHAR), '0') AND rn.edition = n.edition
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
              -- Suppress likely unit/data anomalies: an extreme month-over-month
              -- swing (>=150%) where one side's case price is under half the
              -- cross-distributor max for that UPC/edition (>=2 distributors
              -- carry it). That pattern is a price-book unit error (e.g. a
              -- per-pack price entered as a per-case price), not a real move; it
              -- still surfaces in QA: Data Quality Anomalies.
              AND NOT (
                  ABS(CASE WHEN c.frontline_case_price > 0
                           THEN (n.frontline_case_price - c.frontline_case_price) / c.frontline_case_price * 100
                           ELSE 0 END) >= 150
                  AND (
                      (rc.n_dist >= 2 AND c.frontline_case_price < 0.5 * rc.max_price)
                      OR (rn.n_dist >= 2 AND n.frontline_case_price < 0.5 * rn.max_price)
                  )
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
    unit_kinds: Optional[str] = None,
    min_price: Optional[float] = None,
    max_price: Optional[float] = None,
    has_rip: Optional[bool] = None,
    has_discount: Optional[bool] = None,
    introduced_within_months: Optional[int] = Query(None, ge=1, le=12, description="Restrict facet counts to the New Items universe (items introduced in the last N editions), mirroring /search."),
):
    """Drill-down facet counts. Each facet's counts honour all the OTHER active
    filters (but not its own dimension), so the numbers reconcile with the
    results you actually see. `total` reflects every active filter.
    """
    with get_duckdb() as con:
        # cpl_enriched + clean enrichment brand (see _cpl_clean_brand_view).
        src = _cpl_clean_brand_view(con)

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
            clause, qp, _ = _q_clause(q)
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

        # New Items universe (same restriction as /search) so facet counts match.
        if introduced_within_months:
            intro_map = _introduced_window(con, introduced_within_months)
            if not intro_map:
                base.append("1 = 0")
            else:
                keys = []
                for i, (w_, u_) in enumerate(intro_map):
                    bp[f"fintrok{i}"] = f"{w_}|{u_}"
                    keys.append(f"$fintrok{i}")
                base.append(
                    "(wholesaler || '|' || LTRIM(CAST(upc AS VARCHAR), '0')) IN ("
                    + ", ".join(keys) + ")")

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
        add_in("brand", "brand_clean", brands, "fbrnd_")
        add_in("size", "COALESCE(unit_volume_std, unit_volume)", sizes, "fsize_")
        add_in("ukind", _UNIT_KIND_SQL, unit_kinds, "fukind_")
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
            "brands": grouped("brand_clean", "brand"),
            "sizes": grouped("COALESCE(unit_volume_std, unit_volume)", "size"),
            # Container type buckets (Bottle / Can / Keg) from the DB unit_type.
            "unit_kinds": grouped(_UNIT_KIND_SQL, "ukind"),
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

        # The canonical SKU identity is
        #   (wholesaler, product_name, unit_volume, unit_qty_norm, vintage_norm)
        # — NOT UPC. Allied (and others) reissue the same product under a new
        # UPC between editions (e.g. W TURK RUS 13Y 6P UPC 119440782 in
        # May -> 721059003094 in June), so a strict UPC filter would split a
        # single SKU's timeline at the boundary where the UPC changed. UPC is
        # passed in as a hint but not enforced; vintage + unit_qty + size are
        # the real keys, mirroring the price_changes derive partition and
        # the analytics slot key so modal + page row agree.
        where = ["wholesaler = $wholesaler", "product_name = $product_name"]
        params = {"wholesaler": wholesaler, "product_name": product_name}
        if unit_volume:
            where.append("unit_volume = $unit_volume")
            params["unit_volume"] = unit_volume
        if unit_qty:
            # Normalise both sides ('12' / '12.0' / 12 / 12.0 -> '12') so the
            # int<->float round-trip in the monthly Excel doesn't break the
            # match. Mirrors the uq_key used in derive.py and analytics.py.
            where.append(
                "regexp_replace(TRIM(CAST(unit_qty AS VARCHAR)), '\\.0+$', '') = "
                "regexp_replace(TRIM(CAST($uq AS VARCHAR)), '\\.0+$', '')"
            )
            params["uq"] = unit_qty
        if vintage:
            where.append(f"({_vintage_norm_sql('vintage')}) IS NOT DISTINCT FROM "
                         f"({_vintage_norm_sql('$vnorm')})")
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


@router.get("/rip-siblings/{wholesaler}/{rip_code}")
def get_rip_siblings(
    wholesaler: str,
    rip_code: str,
    edition: Optional[str] = None,
    exclude_upc: Optional[str] = None,
    exclude_name: Optional[str] = Query(None, description="With exclude_upc: drop only the exact CURRENT listing (name, plus vintage when given) instead of every listing on the barcode, so same-UPC sibling SKUs and vintages still show in the member list."),
    exclude_vintage: Optional[str] = None,
    as_of: Optional[str] = None,
):
    """Every product in the same RIP rebate group.

    Authoritative source is the RIP sheet — it lists every UPC that qualifies
    under a rip_code, including ones whose CPL row carries a *different*
    rip_code (a wholesaler can stack a SKU under multiple rebates and only
    reference one of them on the CPL row). Pulling siblings from the CPL
    alone misses those, so we drive the set from the RIP sheet and join CPL
    in afterwards for the price + image data the UI shows.
    """
    rc = (rip_code or "").strip()
    if not rc or rc in ("None", "nan", "0"):
        return {"items": []}
    with get_duckdb() as con:
        src = read_parquet(con, "cpl_enriched")
        rip_src = read_parquet(con, "rip")
        if not edition:
            current_ym = _current_yyyy_mm()
            row_ed = con.execute(
                f"""SELECT MAX(CASE WHEN edition <= $c THEN edition END) AS cur,
                           MAX(edition) AS latest
                    FROM {src} WHERE wholesaler = $w""",
                {"w": wholesaler, "c": current_ym},
            ).fetchone()
            edition = (row_ed[0] or row_ed[1]) if row_ed else None
        if not edition:
            return {"items": []}
        params = {"w": wholesaler, "rc": rc, "e": edition}
        excl_rip = ""
        if exclude_upc and not exclude_name:
            # Legacy whole-UPC exclusion (callers that don't identify the
            # current listing). Compare on the LTRIMmed form so a leading-zero
            # variant of the same UPC is still excluded. When exclude_name IS
            # given, the UPC stays in the set and only the exact current
            # listing is dropped after the CPL join (same-UPC siblings show).
            # The member query applies the same exclusion via member_excl.
            excl_rip = "AND LTRIM(CAST(r.upc AS VARCHAR), '0') <> $xu"
            params["xu"] = str(exclude_upc).lstrip("0")
        # 1) Authoritative UPC list comes from the RIP sheet for this rebate.
        #    Filter out blank / '0' / '000000000000' / 'None' / 'nan' rows
        #    BEFORE the join — the all-zeros placeholder row (a duplicate of
        #    a brand's real-UPC row) would otherwise leak in and the cpl join
        #    would match every blank-UPC product in the catalog, bleeding
        #    hundreds of unrelated brands into the cluster (700+ items in the
        #    ProductQuickView "Other Products in this RIP" panel).
        upc_rows = con.execute(f"""
            SELECT DISTINCT LTRIM(CAST(r.upc AS VARCHAR), '0') AS un
            FROM {rip_src} r
            WHERE r.wholesaler = $w AND r.edition = $e
              AND CAST(r.rip_code AS VARCHAR) = $rc
              AND r.upc IS NOT NULL
              AND CAST(r.upc AS VARCHAR) NOT IN ('', '0', 'None', 'nan')
              AND LTRIM(CAST(r.upc AS VARCHAR), '0') NOT IN ('', 'None', 'nan')
              {excl_rip}
        """, params).fetchdf()
        rip_upcs = sorted({str(u).strip() for u in upc_rows["un"].tolist() if u and str(u).strip()})
        # Junk barcodes in the SHEET ('1', 111111111117, 999999999993, …) are
        # shared by unrelated products, so they never join by barcode — that
        # welded 21 fine wines into the Skyy vodka RIP. Their membership is
        # resolved by RIP-CODE instead (below): when the sheet carries a junk
        # UPC and a CPL row carries the SAME junk UPC plus this rip_code, that
        # row is the intended member (Benziger 101050: sheet '0' row + CPL
        # 'BENZIGER PN M CTY 24' upc '0' rip_code 101050).
        clean_rip_upcs = [u for u in rip_upcs if _is_clean_upc(u)]
        # 2) Join CPL rows: by real barcode (so leading-zero formatting can't
        #    miss a product, and a row stacked under ANOTHER rip_code on its
        #    CPL line still qualifies here — UPC 80432400708 is the canonical
        #    example), PLUS every row whose own rip_code references this code
        #    (covers junk-barcode rows the sheet can't address by UPC).
        ph = ", ".join(f"$u{i}" for i in range(len(clean_rip_upcs)))
        uprm = {**{"w": wholesaler, "e": edition, "rc2": rc},
                **{f"u{i}": u for i, u in enumerate(clean_rip_upcs)}}
        member_clauses = ["CAST(rip_code AS VARCHAR) = $rc2"]
        if clean_rip_upcs:
            member_clauses.append(
                "(CAST(upc AS VARCHAR) NOT IN ('', '0', 'None', 'nan')"
                " AND LTRIM(CAST(upc AS VARCHAR), '0') NOT IN ('', 'None', 'nan')"
                f" AND LTRIM(CAST(upc AS VARCHAR), '0') IN ({ph}))")
        # Legacy whole-UPC exclusion must also hold against the code-claim
        # join, or the excluded barcode re-enters through its own rip_code.
        member_excl = ""
        if exclude_upc and not exclude_name:
            member_excl = "AND LTRIM(CAST(upc AS VARCHAR), '0') <> $xu2"
            uprm["xu2"] = str(exclude_upc).lstrip("0")
        # Degrade gracefully when the parquet predates the rip_windows column
        # (same guard the catalog search uses). Without it this SELECT
        # references a missing column and 500s the whole siblings panel.
        has_rip_windows = bool(con.execute(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_name = 'cpl_enriched' AND column_name = 'rip_windows'"
        ).fetchone())
        rip_windows_expr = "rip_windows" if has_rip_windows else "CAST(NULL AS VARCHAR) AS rip_windows"
        df = con.execute(f"""
            SELECT wholesaler, edition, upc, product_name, brand, vintage,
                   product_type, unit_volume, unit_qty, unit_type, unit_volume_std,
                   frontline_case_price, frontline_unit_price,
                   best_case_price, best_unit_price,
                   effective_case_price, rip_savings, {rip_windows_expr}, total_savings_per_case,
                   has_discount, has_rip, has_closeout, discount_pct,
                   rip_code, combo_code
            FROM {src}
            WHERE wholesaler = $w AND edition = $e
              AND ({' OR '.join(member_clauses)})
              {member_excl}
        """, uprm).fetchdf()
        records = [
            {k: (None if isinstance(v, float) and math.isnan(v) else v) for k, v in r.items()}
            for r in df.to_dict(orient="records")
        ]
        # Multi-listing UPC rule (mirrors derive.py / attach_tiers): when a
        # reused barcode carries MORE THAN ONE SKU and SOME line's own CPL
        # rip_code matches this code, only the matching line(s) belong
        # (e.g. Allied's Coppola Chardonnay + Pinot Noir sharing
        # 739958057209, where the sheet says EXCLUDES PINOT NOIR).
        # When NO line matches, the RIP SHEET'S word wins and ALL listings
        # show — hiding every listing of a sheet-qualified barcode means
        # buyers can't see (or buy) products that DO count toward the
        # rebate (Coppola Diamond Collection 112206 lost 8 products that
        # way). Show, don't hide.
        by_upc: dict = {}
        for r in records:
            by_upc.setdefault(str(r.get("upc") or "").lstrip("0"), []).append(r)
        # UPCs that DO exist on the CPL must never get a "not in current
        # CPL" stub, even when every one of their listings is filtered out.
        cpl_upcs = set(by_upc.keys())
        filtered = []
        for rows in by_upc.values():
            names = {str(r.get("product_name") or "").strip().upper() for r in rows}
            if len(names) <= 1:
                filtered.extend(rows)
                continue
            matching = [r for r in rows if str(r.get("rip_code") or "").strip() == rc]
            filtered.extend(matching if matching else rows)
        records = filtered
        # Drop only the exact CURRENT listing (name + vintage) when the
        # caller identifies it — the old UPC-wide exclusion hid same-UPC
        # sibling SKUs and vintages from the "buy these together" list.
        if exclude_upc and exclude_name:
            xu = str(exclude_upc).lstrip("0")
            xn = str(exclude_name).strip().upper()

            def _vd(v) -> str:
                s = "".join(ch for ch in str(v or "") if ch.isdigit())
                return s[:4]
            xv = _vd(exclude_vintage) if exclude_vintage else ""
            records = [
                r for r in records
                if not (str(r.get("upc") or "").lstrip("0") == xu
                        and str(r.get("product_name") or "").strip().upper() == xn
                        and (not xv or _vd(r.get("vintage")) == xv))
            ]
        # 3) Real RIP UPCs missing from the CPL still belong on screen —
        #    surface a minimal stub so the user sees the full rebate group and
        #    knows the SKU isn't on the current CPL. The UI keeps Add-to-Cart
        #    disabled when the row has no price. Junk barcodes get no stub:
        #    they identify nothing (their membership resolved by rip_code
        #    above). Compare by LTRIMmed UPC since that's what records carry.
        seen_upcs = {str(r.get("upc") or "").lstrip("0") for r in records} | cpl_upcs
        for u in clean_rip_upcs:
            if u not in seen_upcs:
                records.append({
                    "wholesaler": wholesaler, "edition": edition, "upc": u,
                    "product_name": f"UPC {u} (not in current CPL)",
                    "unavailable": True,
                })
        records.sort(key=lambda r: str(r.get("product_name") or ""))
        try:
            _attach_enrichment_image(con, records)
            _attach_sku_mapping(con, records)
        except Exception:
            pass
        try:
            _attach_discount_rip_tiers(con, records, ref_date=as_of)
        except Exception:
            pass
        try:
            _attach_live_rip(con, records, ref_date=as_of)
        except Exception:
            pass
        try:
            _attach_price_3mo(con, records)
        except Exception:
            pass

        # The rebate's tier ladder (buy N units -> $X back), shown at the top of
        # the modal. All member rows of a code share the same statewide tiers, so
        # we dedupe across them and sort by quantity.
        tiers = []
        try:
            tdf = con.execute(f"""
                SELECT rip_unit_1, rip_qty_1, rip_amt_1,
                       rip_unit_2, rip_qty_2, rip_amt_2,
                       rip_unit_3, rip_qty_3, rip_amt_3,
                       rip_unit_4, rip_qty_4, rip_amt_4,
                       from_date, to_date, rip_description
                FROM {rip_src}
                WHERE wholesaler = $w AND edition = $e
                  AND CAST(rip_code AS VARCHAR) = $rc
            """, {"w": wholesaler, "e": edition, "rc": rc}).fetchdf()
            seen = set()
            for r in tdf.to_dict("records"):
                fd = str(r.get("from_date"))[:10] if r.get("from_date") is not None else None
                td = str(r.get("to_date"))[:10] if r.get("to_date") is not None else None
                for i in (1, 2, 3, 4):
                    amt = r.get(f"rip_amt_{i}")
                    qty = r.get(f"rip_qty_{i}")
                    unit = r.get(f"rip_unit_{i}")
                    try:
                        amtf = float(amt)
                    except (TypeError, ValueError):
                        continue
                    if amtf != amtf or amtf <= 0:
                        continue
                    try:
                        qf = float(qty)
                    except (TypeError, ValueError):
                        qf = None
                    key = (unit, qf, round(amtf, 2), fd, td)
                    if key in seen:
                        continue
                    seen.add(key)
                    tiers.append({
                        "unit": (str(unit) if unit is not None else None),
                        "qty": (int(qf) if qf is not None and qf == int(qf) else qf),
                        "amount": round(amtf, 2),
                        "from_date": fd, "to_date": td,
                        "description": (str(r.get("rip_description")) if r.get("rip_description") is not None else None),
                    })
            tiers.sort(key=lambda t: (t["qty"] if t["qty"] is not None else 1e9, t["amount"]))
        except Exception:
            tiers = []
    return {"edition": edition, "rip_code": rc, "items": records, "tiers": tiers}


# Strip size / volume / pack tokens from a product name so different-sized SKUs
# of the SAME product collapse to one "core". The catalogue's own names are
# inconsistent across sizes ("GLENFID MALT 12Y 12P", "GLENFID MALT 12YR"), but
# the Go-UPC enrichment names share a stable core ("Glenfiddich 12 Year Old
# Single Malt Scotch Whisky" + a size suffix), so we normalise THAT.
_VARIANT_SIZE_RE = re.compile(
    r'\b\d+(?:[.,]\d+)?\s*(?:ml|cl|lt|ltr|liter|litre|liters|l|oz|pk|pack|p)\b', re.I)
_VARIANT_PUNCT_RE = re.compile(r'[^a-z0-9 ]+')
# Pack/case tokens that appear in catalogue names: "12P", "6PK", "96/12",
# "1X96", "24CT". These are packaging, not the product.
_VARIANT_PACK_RE = re.compile(
    r'\b\d+\s*(?:p|pk|pack|ct|cnt)\b|\b\d+\s*[x/]\s*\d+\b', re.I)
# Age tokens — normalise "12Y" / "12YR" / "12 YEAR" / "12YO" to a single form so
# size variants of the same age unify but 12 never merges with 15.
_VARIANT_AGE_RE = re.compile(r'\b(\d+)\s*(?:yr|yrs|yo|years|year|y)\b', re.I)


def _product_core(name: Optional[str]) -> str:
    """Core of a Go-UPC ENRICHMENT name: drop only the size suffix. Names are
    already clean + descriptive, so cask/edition variants stay distinct.
    Coerces non-strings (a NaN float from the parquet is TRUTHY, so `name or ''`
    wouldn't guard it — that crashed prod product-variant-upcs)."""
    s = (name if isinstance(name, str) else "").lower()
    s = _VARIANT_SIZE_RE.sub(" ", s)
    s = _VARIANT_PUNCT_RE.sub(" ", s)
    return re.sub(r"\s+", " ", s).strip()


def _display_name(enr_name: Optional[str]) -> str:
    """A clean product title from the enrichment name: strip the size suffix
    ("... 1 Liter", "... 750 mL") but keep the original casing."""
    safe = enr_name if isinstance(enr_name, str) else ""
    s = _VARIANT_SIZE_RE.sub(" ", safe)
    s = re.sub(r"\s+", " ", s).strip(" ,-")
    return s or safe


def _catalog_core(name: Optional[str]) -> str:
    """Best-effort core of a raw CATALOGUE name (used for un-enriched SKUs):
    strip pack + size tokens, normalise the age token, keep the rest (so
    'SHERRY' / 'FESTIVE' descriptors still separate products). Can't fix brand
    abbreviation variance (GLENFID vs GLENFIDDICH), so it only groups SKUs whose
    base name is otherwise consistent and differs by pack/size."""
    s = (name if isinstance(name, str) else "").lower()
    s = _VARIANT_PACK_RE.sub(" ", s)
    s = _VARIANT_SIZE_RE.sub(" ", s)
    s = _VARIANT_PUNCT_RE.sub(" ", s)
    s = _VARIANT_AGE_RE.sub(lambda m: f"{m.group(1)}yr", s)
    return re.sub(r"\s+", " ", s).strip()


# Tokens that make a raw distributor name a poor card HEADER: closeout / old-lot
# markers and pack-encoded names ("BAG6P", "12P", "6 PK"). Used only to pick the
# representative title when a clean UPC has no Go-UPC enrichment name yet — so
# the header avoids "… OLD LOT" / "… BAG6P" and prefers the plain product name.
_HEADER_JUNK_RE = re.compile(
    r'\b(?:old\s*lot|oldlot|close\s*out|closeout|clsout|clo)\b|\b(?:bag)?\d+\s*(?:p|pk|pack)\b', re.I)


def _header_junk(name: str) -> int:
    return 1 if _HEADER_JUNK_RE.search(name or "") else 0


def _is_clean_upc(upc) -> bool:
    """Python mirror of ``_VALID_UPC_SQL``: True only for a real barcode, not a
    stub/placeholder. Rejects NULL/blank/'0', all-same-digit fillers
    ('000…', '111…', '999…'), '999999…' sentinels, and codes shorter than 8
    digits after leading zeros. Kept in lock-step with the SQL predicate so the
    Products-grid UPC grouping uses the SAME notion of "clean barcode" as the
    rest of the app (compare / cross-distributor / new-item detection)."""
    s = str(upc).strip() if upc is not None else ""
    if s in ("", "0"):
        return False
    if re.fullmatch(r"(0+|9+|1+)", s):
        return False
    if s.startswith("999999"):
        return False
    # Repeated-digit placeholders like 111111111117 (nine or more leading
    # repeats of one digit): Allied's fake-barcode pattern. Shared by dozens
    # of unrelated products, so it must never act as a join/group key.
    # Mirrors backend.celr.is_registry_upc.
    if re.match(r"^(\d)\1{8,}", s):
        return False
    return len(s.lstrip("0")) >= 8


def _norm_vintage(v) -> str:
    """Collapse non-vintage markers to one bucket. For WINE, same-name SKUs of
    DIFFERENT vintages are different products (different price/year), so the
    grouping must also match vintage; for spirits the vintage is blank/NV and
    this is a no-op."""
    s = str(v if v is not None else "").strip().lower()
    return "" if s in ("", "nv", "0", "none", "nan", "n/a") else re.sub(r"[^0-9]", "", s) or ""


@router.get("/product-variant-upcs/{wholesaler}/{product_name:path}")
def product_variant_upcs(
    wholesaler: str,
    product_name: str,
    upc: Optional[str] = None,
):
    """Every UPC that is the SAME product as (wholesaler, product_name) across
    its different sizes, grouped by the normalised Go-UPC enrichment name.

    Our catalogue names sizes inconsistently, so an exact product_name match
    misses most sizes (e.g. Glenfiddich 12 is 'GLENFID MALT 12Y 12P' in 1L but
    'GLENFID MALT 12YR' in 750mL). We resolve the seed SKU's enrichment name,
    strip its size tokens to a core, and return every SKU in the current edition
    whose enrichment-name core matches (same brand) — plus every exact
    product_name match as a guaranteed floor. The detail page then loads those
    UPCs via /search?upcs=… so all sizes show on one page. Returns an empty list
    when there's no enrichment to group on (caller falls back to exact name)."""
    with get_duckdb() as con:
        src = read_parquet(con, "cpl_enriched")
        en = read_parquet(con, "product_enrichment")
        # current edition for this wholesaler (latest on-or-before today)
        cym = _current_yyyy_mm()
        row_ed = con.execute(
            f"""SELECT MAX(CASE WHEN edition <= $c THEN edition END) AS cur,
                       MAX(edition) AS latest
                FROM {src} WHERE wholesaler = $w""",
            {"w": wholesaler, "c": cym},
        ).fetchone()
        edition = (row_ed[0] or row_ed[1]) if row_ed else None
        if not edition:
            return {"upcs": [], "core": None, "edition": None}

        # Per-UPC enrichment name/brand map (deduped).
        en_sub = f"""(
            SELECT LTRIM(CAST(upc AS VARCHAR), '0') AS un,
                   ANY_VALUE(name) AS name, ANY_VALUE(brand) AS brand
            FROM {en} GROUP BY 1
        )"""

        # 1) Resolve the seed row's enrichment name/brand + type/vintage/upc.
        # A placeholder barcode (111111111117 etc.) is shared by unrelated
        # products, so seeding by it would resolve an arbitrary row and pull
        # that row's enrichment. Seed those by exact product name instead.
        seed_by_upc = bool(upc) and _is_clean_upc(upc)
        seed_row = con.execute(f"""
            SELECT pe.name AS enr_name, pe.brand AS enr_brand,
                   c.product_type AS ptype, c.vintage AS vintage,
                   LTRIM(CAST(c.upc AS VARCHAR), '0') AS un
            FROM {src} c
            LEFT JOIN {en_sub} pe ON LTRIM(CAST(c.upc AS VARCHAR), '0') = pe.un
            WHERE c.wholesaler = $w AND c.edition = $e
              AND ({"LTRIM(CAST(c.upc AS VARCHAR),'0') = $u" if seed_by_upc else "c.product_name = $pn"})
            LIMIT 1
        """, {"w": wholesaler, "e": edition,
              **({"u": str(upc).lstrip("0")} if seed_by_upc else {"pn": product_name})}).fetchone()
        seed_enr_name = seed_row[0] if seed_row else None
        seed_brand = seed_row[1] if seed_row else None
        seed_ptype = (seed_row[2] if seed_row else None) or ""
        seed_vintage = _norm_vintage(seed_row[3]) if seed_row else ""
        seed_un = (seed_row[4] if seed_row else None) or (str(upc).lstrip("0") if seed_by_upc else None)

        # WINE: a wine's identity is its product_name + vintage. Its barcode is
        # frequently the '0' placeholder (shared across unrelated wines), so the
        # UPC isn't a safe key. The existing name fetch already returns every
        # vintage of the wine, so we signal the caller to use that path rather
        # than fuzzy name-matching (which could merge unrelated wines).
        if "wine" in seed_ptype.lower():
            return {"upcs": [], "core": None, "edition": edition, "mode": "wine_name"}

        core = _product_core(seed_enr_name) if seed_enr_name else None
        cat_core = _catalog_core(product_name)
        cat_ok = len(cat_core.split()) >= 2     # skip too-generic single-token cores

        # 2) Candidate rows — bounded to the same brand-name prefix (first 4
        #    chars of the catalogue name) OR the same clean enrichment brand, so
        #    we never scan the whole edition.
        prefix = (product_name or "")[:4].lower() + "%"
        df = con.execute(f"""
            SELECT c.upc AS upc, c.product_name AS product_name, c.vintage AS vintage,
                   pe.name AS enr_name, pe.brand AS enr_brand
            FROM {src} c
            LEFT JOIN {en_sub} pe ON LTRIM(CAST(c.upc AS VARCHAR), '0') = pe.un
            WHERE c.wholesaler = $w AND c.edition = $e
              AND (LOWER(c.product_name) LIKE $pref
                   {"OR pe.brand = $sb" if seed_brand else ""})
        """, {"w": wholesaler, "e": edition, "pref": prefix,
              **({"sb": seed_brand} if seed_brand else {})}).fetchdf()

        upcs: set[str] = set()
        for r in df.itertuples():
            # Skip placeholder/blank barcodes (incl. shared fakes like
            # 111111111117): they aren't searchable and would over-match in
            # /search?upcs=. (Exact-name rows are still covered by the
            # caller's name fallback.)
            if not _is_clean_upc(r.upc):
                continue
            # Same vintage as the seed (no-op for NV spirits; keeps a vintage
            # spirit/port from merging across years).
            if _norm_vintage(r.vintage) != seed_vintage:
                continue
            # (a) exact catalogue name — guaranteed floor.
            if r.product_name == product_name:
                upcs.add(str(r.upc)); continue
            inc = False
            # (b) enrichment-name core match (same brand when known).
            if core and r.enr_name and _product_core(r.enr_name) == core:
                if not (seed_brand and r.enr_brand and r.enr_brand != seed_brand):
                    inc = True
            # (c) catalogue-name core fallback (covers un-enriched sizes that
            #     differ only by pack/size).
            if not inc and cat_ok and _catalog_core(r.product_name) == cat_core:
                inc = True
            if inc:
                upcs.add(str(r.upc))

    return {"upcs": sorted(upcs), "core": core, "cat_core": cat_core,
            "edition": edition, "mode": "name_core"}


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
            # Normalise both sides (see /product detail): a raw 2-digit '20'
            # caller must still match the '2020'-normalised history rows, else
            # the price chart silently shows nothing.
            where.append(f"({_vintage_norm_sql('vintage')}) IS NOT DISTINCT FROM "
                         f"({_vintage_norm_sql('$vnorm')})")
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


from pydantic import BaseModel


class CatalogAiQueryBody(BaseModel):
    question: str
    history: Optional[list] = None   # prior [{role, content}] turns for memory


@router.post("/ai-query")
def catalog_ai_query(body: CatalogAiQueryBody, user: Optional[dict] = Depends(get_optional_user)):
    """Natural-language catalog assistant. Maps the buyer's question to catalog
    filters + actions (+ a short answer and the token/dollar cost of the call)
    so the page can re-run its search and the screen reflects the answer.

    Token-optimized by design: ONE tool-use round-trip translates the question
    into filter/action params; the catalog rows never enter the model context.
    `history` gives multi-turn memory; usage is logged for the admin rollup."""
    from backend import ai_catalog_query, ai_usage
    res = ai_catalog_query.answer_question(body.question, body.history)
    ai_usage.log_usage(user, "catalog", body.question, res.get("usage"))
    return res
