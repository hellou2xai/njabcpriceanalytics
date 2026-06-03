"""Identifier search: match products by distributor item number or RIP code.

A catalog row carries three kinds of code a buyer might type into a search
box:

  - UPC: the barcode on the cpl row itself. Already searchable everywhere.
  - ABG item number: Allied's own SKU. It lives in sku_mapping (abg_sku ->
    upc_norm) and is shown on Allied cards as "ABG 1234567", but it is not a
    column on the cpl row, so plain column matching can never find it.
  - RIP code: the rebate cluster number. The canonical code sits on the cpl
    row (rip_code), but a product can belong to more than one cluster; the
    full code set lives in the rip table.

This module gives every search surface one shared way to match those codes:

  - identifier_clause(): a self-contained SQL fragment (DuckDB, $-style
    params) that can be OR'd into an existing WHERE. It uses uncorrelated IN
    subqueries on purpose: no outer column other than the UPC expression is
    referenced, so it is safe inside any query shape (plain scans, aliased
    joins, EXISTS chains) without alias plumbing.
  - resolve_codes_to_upcs(): code -> list of normalised UPCs, for surfaces
    that work with UPC sets instead of SQL (semantic search, the RIP-products
    in-memory cache filter, the assistant's price timeline).

Both helpers expect a connection to the DuckDB pricing cache, which always
holds sku_mapping and rip (pricing_cache creates empty stubs when the source
tables are missing), so they degrade to "no extra matches" rather than error.
"""
from __future__ import annotations

import re


def compact_identifier(q: str) -> str | None:
    """Return the digits of an identifier-like query ('42-19043' -> '4219043'),
    or None when q is not a plausible code. Needs 4+ digits and nothing else,
    matching the catalog's existing numeric-query rule."""
    compact = re.sub(r"[\s\-]", "", q or "")
    if compact.isdigit() and len(compact) >= 4:
        return compact
    return None


def identifier_clause(q: str, *, upc_expr: str, prefix: str = "idq"):
    """Build (clause, params) matching rows whose UPC resolves from the typed
    code: an Allied ABG item number (sku_mapping) or a RIP cluster code (rip
    table, which also catches secondary codes that are not the canonical
    rip_code stored on the cpl row).

    upc_expr is the caller's UPC column expression ('upc', 'c.upc', ...).
    Returns (None, {}) when q is not identifier-like, so callers can do:

        idc, idp = identifier_clause(q, upc_expr="c.upc")
        if idc:
            ors.append(idc); params.update(idp)

    Substring (LIKE) semantics on both raw and zero-stripped forms, mirroring
    how the UPC itself is matched."""
    compact = compact_identifier(q)
    if not compact:
        return None, {}
    norm = compact.lstrip("0") or compact
    params = {f"{prefix}_raw": f"%{compact}%", f"{prefix}_norm": f"%{norm}%"}
    upc_n = f"LTRIM(CAST({upc_expr} AS VARCHAR), '0')"
    clause = (
        f"({upc_n} IN (SELECT upc_norm FROM sku_mapping "
        f"WHERE (abg_sku LIKE ${prefix}_raw OR LTRIM(abg_sku, '0') LIKE ${prefix}_norm) "
        f"AND upc_norm IS NOT NULL AND upc_norm <> '') "
        f"OR {upc_n} IN (SELECT LTRIM(CAST(upc AS VARCHAR), '0') FROM rip "
        f"WHERE CAST(rip_code AS VARCHAR) LIKE ${prefix}_raw "
        f"AND upc IS NOT NULL "
        f"AND LTRIM(CAST(upc AS VARCHAR), '0') NOT IN ('', 'None', 'nan')))"
    )
    return clause, params


def resolve_codes_to_upcs(con, q: str, limit: int = 500) -> list[str]:
    """Map an identifier-like query to the normalised UPCs it denotes, via
    exact match on Allied item numbers (sku_mapping.abg_sku) and RIP cluster
    codes (rip table, newest edition carrying the code so a recycled code
    resolves to its current cluster). Returns [] when q is not identifier-like
    or nothing matches. Tolerates a missing table by returning what it can."""
    compact = compact_identifier(q)
    if not compact:
        return []
    norm = compact.lstrip("0") or compact
    out: list[str] = []
    try:
        rows = con.execute(
            "SELECT DISTINCT upc_norm FROM sku_mapping "
            "WHERE (abg_sku = ? OR LTRIM(abg_sku, '0') = ?) "
            "AND upc_norm IS NOT NULL AND upc_norm <> '' LIMIT ?",
            [compact, norm, limit],
        ).fetchall()
        out += [str(r[0]) for r in rows]
    except Exception:
        pass
    try:
        rows = con.execute(
            "SELECT DISTINCT LTRIM(CAST(upc AS VARCHAR), '0') FROM rip "
            "WHERE CAST(rip_code AS VARCHAR) IN (?, ?) "
            "AND edition = (SELECT MAX(edition) FROM rip "
            "               WHERE CAST(rip_code AS VARCHAR) IN (?, ?)) "
            "AND upc IS NOT NULL "
            "AND LTRIM(CAST(upc AS VARCHAR), '0') NOT IN ('', 'None', 'nan') "
            "LIMIT ?",
            [compact, norm, compact, norm, limit],
        ).fetchall()
        out += [str(r[0]) for r in rows]
    except Exception:
        pass
    return list(dict.fromkeys(u for u in out if u))
