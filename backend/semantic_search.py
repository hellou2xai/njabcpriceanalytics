"""Semantic catalog search over the enrichment corpus.

Layer #3 of the assistant's semantic stack. Layers #1 (region) and #2
(varietal) handle structured filters: any query that maps cleanly to a
known geography or grape/style key. This layer handles the long tail —
free-text descriptive phrases like:

    "old vine zinfandel from california"
    "single barrel bourbon from kentucky"
    "small batch japanese whisky"
    "natural orange wine"

The implementation today is Postgres full-text search (tsvector + GIN
index) over the concatenation of name + brand + description + region +
category + category_path. It ranks via ts_rank, joins back to the live
DuckDB catalog to surface only in-stock SKUs in the current edition,
and returns the same product card shape the catalog grid renders.

Why FTS not embeddings (yet):
  - Ships now, zero new infra or API keys.
  - Catches concrete vocabulary that's literally in the description
    (old vine, single barrel, blanc de blancs, etc.) — which is the
    majority of catalog queries.

Why this module is shaped for an embedding swap:
  - Single public function `semantic_search(con_pg, con_duck, q, ...)`
    so the catalog router doesn't know whether FTS or pgvector is on
    the back end.
  - The Postgres-side relevance comes through as a `score` column;
    swapping to `1 - (embedding <=> query_vec)` is a one-line edit.
  - The DuckDB join + edition-current logic is shared.

Index management:
  - `ensure_fts_index(con_pg)` is idempotent; it creates the GIN
    functional index on product_enrichment if absent. Called once at
    backend startup.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Optional

log = logging.getLogger("semantic_search")


_INDEX_NAME = "product_enrichment_fts_idx"


def ensure_fts_index(con_pg) -> bool:
    """Create the GIN functional index on product_enrichment if absent.

    Idempotent. Returns True if the index now exists (whether we just
    created it or it was already there). Quietly returns False on any
    error so a missing index doesn't crash the rest of the backend.
    """
    try:
        cur = con_pg.cursor()
        cur.execute(
            "SELECT 1 FROM pg_indexes WHERE indexname = %s",
            (_INDEX_NAME,),
        )
        if cur.fetchone():
            return True
        log.info("Creating Postgres FTS index %s on product_enrichment", _INDEX_NAME)
        cur.execute(
            f"""
            CREATE INDEX {_INDEX_NAME}
            ON product_enrichment
            USING GIN (
                to_tsvector('english',
                    COALESCE(name, '') || ' ' ||
                    COALESCE(brand, '') || ' ' ||
                    COALESCE(description, '') || ' ' ||
                    COALESCE(region, '') || ' ' ||
                    COALESCE(category, '') || ' ' ||
                    COALESCE(category_path, '')
                )
            )
            """
        )
        return True
    except Exception as e:
        log.warning("Could not ensure FTS index: %s", e)
        return False


def _voyage_upcs(con_pg, query: str, limit: int) -> Optional[list[tuple[str, float]]]:
    """Return (UPC, score) pairs ranked by pgvector cosine similarity against
    Voyage embeddings. Returns None when the engine isn't available (no key,
    no embeddings table, no rows) so the caller can fall back to FTS."""
    try:
        from backend.voyage_embed import voyage_available, embed_query, _format_vec_literal
    except Exception:
        return None
    if not voyage_available():
        return None
    try:
        cur = con_pg.cursor()
        # Confirm the embeddings table exists and has at least one row.
        cur.execute(
            "SELECT COUNT(*) FROM information_schema.tables "
            "WHERE table_name = 'product_embeddings'"
        )
        if not cur.fetchone()[0]:
            return None
        cur.execute("SELECT COUNT(*) FROM product_embeddings")
        if not cur.fetchone()[0]:
            return None
    except Exception as e:
        log.warning("Voyage path probe failed: %s", e)
        return None
    try:
        qvec = embed_query(query)
    except Exception as e:
        log.warning("Voyage query embed failed - falling back to FTS: %s", e)
        return None
    try:
        cur = con_pg.cursor()
        cur.execute(
            """
            SELECT upc, 1 - (vec <=> %s::vector) AS score
            FROM product_embeddings
            ORDER BY vec <=> %s::vector
            LIMIT %s
            """,
            (_format_vec_literal(qvec), _format_vec_literal(qvec),
             int(limit) * 3),
        )
        rows = cur.fetchall()
        return [(str(u), float(s)) for u, s in rows if u]
    except Exception as e:
        log.warning("pgvector query failed - falling back to FTS: %s", e)
        return None


def _fts_upcs(con_pg, query: str, limit: int) -> list[tuple[str, float]]:
    """Return (UPC, score) pairs ranked by Postgres FTS relevance."""
    cur = con_pg.cursor()
    cur.execute(
        """
        SELECT upc,
               ts_rank(
                   to_tsvector('english',
                       COALESCE(name,'') || ' ' || COALESCE(brand,'') || ' ' ||
                       COALESCE(description,'') || ' ' || COALESCE(region,'') || ' ' ||
                       COALESCE(category,'') || ' ' || COALESCE(category_path,'')
                   ),
                   websearch_to_tsquery('english', %s)
               ) AS rel
        FROM product_enrichment
        WHERE to_tsvector('english',
                  COALESCE(name,'') || ' ' || COALESCE(brand,'') || ' ' ||
                  COALESCE(description,'') || ' ' || COALESCE(region,'') || ' ' ||
                  COALESCE(category,'') || ' ' || COALESCE(category_path,'')
              ) @@ websearch_to_tsquery('english', %s)
          AND upc IS NOT NULL AND upc != ''
        ORDER BY rel DESC
        LIMIT %s
        """,
        (query, query, int(limit) * 3),   # over-fetch — many will drop in the cpl join
    )
    out = []
    for upc, rel in cur.fetchall():
        if upc:
            out.append((str(upc), float(rel)))
    return out


def semantic_search(
    con_pg,
    con_duck,
    query: str,
    *,
    limit: int = 24,
    product_type: Optional[str] = None,
    sizes: Optional[list] = None,
    unit_qty: Optional[str] = None,
    vintage: Optional[str] = None,
) -> list[dict[str, Any]]:
    """Return ranked product cards (current edition per wholesaler) that
    best match the free-text `query` against the enrichment corpus.

    Args:
        con_pg: psycopg or DuckDB-attached Postgres connection.
        con_duck: DuckDB connection (for the cpl_enriched join).
        query: any natural-language phrase.
        limit: max card count to return (default 24).
        product_type: optional narrowing — same semantics as the catalog's
            product_type filter ("Wine", "Spirits", "Beer", ...).
        sizes: list of volume strings to keep, e.g. ["750ML", "750"]. Each is
            normalised (no spaces, uppercase) and matched against unit_volume.
        unit_qty: pack size to keep, e.g. "12" (bottles/case).
        vintage: vintage year string to keep, e.g. "2019".

    Returns a list of dicts in the same shape as /api/catalog/search items:
    product_name, wholesaler, upc, unit_volume, unit_qty, vintage,
    frontline_case_price, effective_case_price, product_type, enr_category,
    enr_region, abv_proof, plus a `score` field for relevance display.
    """
    q = (query or "").strip()
    if not q or con_pg is None or con_duck is None:
        return []
    # Engine selection: identifier-like queries (a UPC, an Allied/ABG item
    # number, a RIP cluster code) never match the text corpus, so resolve
    # them straight to UPCs. Otherwise prefer Voyage vector search when
    # available + indexed, falling back to Postgres FTS. Same return shape
    # from every path.
    upcs_scored: list[tuple[str, float]] = []
    from backend.code_search import compact_identifier, resolve_codes_to_upcs
    cid = compact_identifier(q)
    if cid:
        norm = cid.lstrip("0") or cid
        ids = [norm] + resolve_codes_to_upcs(con_duck, q)
        upcs_scored = [(u, 1.0) for u in dict.fromkeys(ids)]
        engine = "codes"
    else:
        voyage_hits = _voyage_upcs(con_pg, q, limit)
        if voyage_hits is not None and voyage_hits:
            upcs_scored = voyage_hits
            engine = "voyage"
        else:
            try:
                upcs_scored = _fts_upcs(con_pg, q, limit)
                engine = "fts"
            except Exception as e:
                log.warning("FTS lookup failed: %s", e)
                return []
    log.debug("semantic_search engine=%s hits=%d q=%r", engine, len(upcs_scored), q)
    if not upcs_scored:
        return []

    # Normalise UPCs (strip leading zeros) for the join — cpl_enriched
    # carries the raw UPC; we LTRIM both sides to handle either format.
    upc_to_score = {u.lstrip("0"): s for u, s in upcs_scored if u.strip("0")}
    if not upc_to_score:
        return []
    upcs = sorted(upc_to_score.keys())

    # Now join to the live catalog. Latest edition per wholesaler so we
    # don't surface an SKU that's been off the shelf for months.
    cym = _current_ym()
    upc_ph = ", ".join(f"$u_{i}" for i in range(len(upcs)))
    params = {"cym": cym}
    for i, v in enumerate(upcs):
        params[f"u_{i}"] = v
    has_enr_cat = bool(con_duck.execute(
        "SELECT 1 FROM information_schema.columns "
        "WHERE table_name='cpl_enriched' AND column_name='enr_category'"
    ).fetchone())
    enr_cat_sel = "c.enr_category, c.enr_region," if has_enr_cat else "NULL AS enr_category, NULL AS enr_region,"
    pt_clause = ""
    if product_type:
        params["pt"] = product_type
        if has_enr_cat:
            # Granular terms like "bourbon" or "scotch whisky" won't match product_type
            # ("Spirits") — fall through to enr_category ILIKE as well.
            params["pt_like"] = f"%{product_type}%"
            pt_clause = ("AND (c.product_type = $pt "
                         "OR LOWER(COALESCE(c.enr_category,'')) LIKE LOWER($pt_like))")
        else:
            pt_clause = "AND c.product_type = $pt"
    # Volume (size) filter: normalise to no-space uppercase and IN-match.
    size_clause = ""
    if sizes:
        size_cands = set()
        for s in sizes:
            n = str(s or "").strip().upper().replace(" ", "").replace("LITER", "L").replace("LITRE", "L")
            if not n:
                continue
            size_cands.add(n)
            if n[-1].isdigit():
                size_cands.update({n + "L", n + "ML", n + "OZ"})
        if size_cands:
            sc = sorted(size_cands)
            for i, v in enumerate(sc):
                params[f"sz{i}"] = v
            size_clause = ("AND UPPER(REPLACE(c.unit_volume, ' ', '')) IN ("
                           + ", ".join(f"$sz{i}" for i in range(len(sc))) + ")")
    # Pack-size filter.
    pack_clause = ""
    if unit_qty is not None:
        try:
            params["pack"] = str(int(float(unit_qty)))
            pack_clause = "AND TRY_CAST(c.unit_qty AS INTEGER)::VARCHAR = $pack"
        except (ValueError, TypeError):
            pass
    # Vintage filter.
    vint_clause = ""
    if vintage:
        params["vint"] = str(vintage).split(".")[0]
        vint_clause = "AND CAST(c.vintage AS VARCHAR) LIKE $vint"
    rows = con_duck.execute(
        f"""
        WITH cur AS (
            SELECT wholesaler,
                   COALESCE(MAX(CASE WHEN edition <= $cym THEN edition END),
                            MAX(edition)) AS ed
            FROM cpl_enriched GROUP BY wholesaler
        )
        SELECT c.product_name, c.wholesaler, c.upc, c.unit_volume, c.unit_qty,
               c.vintage, c.frontline_case_price, c.effective_case_price,
               c.product_type, {enr_cat_sel} c.abv_proof
        FROM cpl_enriched c
        JOIN cur ON c.wholesaler = cur.wholesaler AND c.edition = cur.ed
        WHERE LTRIM(CAST(c.upc AS VARCHAR), '0') IN ({upc_ph})
          {pt_clause} {size_clause} {pack_clause} {vint_clause}
        """,
        params,
    ).fetchdf().to_dict(orient="records")

    # Re-attach the relevance score, sort by it, dedupe by the full SKU
    # identity and cap at the requested limit. Many enriched UPCs match
    # multiple CPL rows (different vintages AND pack sizes — one UPC can carry
    # a 3-pack and a 6-pack); the highest-score row per identity wins. unit_qty
    # (normalised, "12" == "12.0") is part of the key so distinct case sizes
    # are not collapsed and silently dropped (mirrors derive.py / attach_tiers).
    from backend.pricing import uq_key
    seen = set()
    out: list[dict] = []
    for r in rows:
        upc_n = str(r.get("upc") or "").lstrip("0")
        if not upc_n:
            continue
        r["score"] = upc_to_score.get(upc_n, 0.0)
        key = (r.get("wholesaler"), upc_n, r.get("unit_volume"),
               uq_key(r.get("unit_qty")), r.get("vintage"))
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    out.sort(key=lambda r: r.get("score") or 0.0, reverse=True)
    out = out[: int(limit)]
    # Distributor item number (ABG / Fedway) next to the UPC, for the cards the
    # semantic search and the AI assistant render.
    try:
        from backend.enrichment_join import attach_sku_mapping
        attach_sku_mapping(con_duck, out)
    except Exception:
        pass
    return out


def _current_ym() -> str:
    """Edition string for today's month, Eastern-anchored (mirrors pricing)."""
    from backend import pricing as _pricing
    return _pricing.current_yyyy_mm()


def enabled() -> bool:
    """True when semantic search can run (Postgres + DuckDB both reachable).

    The catalog endpoint uses this for a graceful degraded response when
    the enrichment table is empty (local dev without ingestion). The
    assistant tool also uses it to advertise availability."""
    return True   # FTS path has no external deps; always on when DB is up
