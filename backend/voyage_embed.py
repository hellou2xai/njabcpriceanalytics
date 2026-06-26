"""Voyage AI embedding client + product indexing.

Two responsibilities:

  1. `embed_documents(texts)` / `embed_query(text)` — call the Voyage
     embeddings API for a list of strings (or a single query). Returns
     1024-dim vectors as Python lists. Voyage's API caps each batch at
     128 inputs and ~120K total tokens, so we chunk automatically.

  2. `index_enrichment(con_pg, batch_size, only_missing, model)` —
     one-shot job that walks product_enrichment, composes the search
     text per row, batches through Voyage, upserts to the
     product_embeddings table. Idempotent and resumable: re-running
     after a partial failure picks up where it stopped if `only_missing`
     is True.

The endpoint and the assistant tool stay in backend/semantic_search.py;
this module is the embedding backend.

Defaults to model "voyage-3" (Anthropic's recommended general-purpose
embedder, 1024 dims). The Voyage free tier covers a multiple of what
this app's 28k SKUs need, indefinitely.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Iterable, Optional, Sequence

log = logging.getLogger("voyage_embed")

VOYAGE_BASE_URL = "https://api.voyageai.com/v1/embeddings"
VOYAGE_DEFAULT_MODEL = os.getenv("VOYAGE_EMBED_MODEL", "voyage-3")
# Voyage limits per-batch: 128 inputs OR 120000 tokens. We chunk by count;
# token cap is a soft fallback (rarely hit for our text length).
VOYAGE_BATCH_SIZE = 128


def voyage_available() -> bool:
    """True when VOYAGE_API_KEY is set (the only Voyage prerequisite)."""
    return bool(os.getenv("VOYAGE_API_KEY"))


def _post(payload: dict, *, retries: int = 3, read_timeout: float = 45.0) -> dict:
    """POST one batch to Voyage. Retries on 429/5xx with exponential backoff.

    Uses httpx instead of urllib so the per-phase timeout (connect vs read)
    is enforced by urllib3-style infrastructure that works on Windows SSL
    sockets. urllib's socket timeout is unreliable on Windows HTTPS once
    the TLS handshake completes — a hung read blocks indefinitely."""
    import httpx

    key = os.environ.get("VOYAGE_API_KEY")
    if not key:
        raise RuntimeError("VOYAGE_API_KEY not set")
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    timeout = httpx.Timeout(connect=10.0, read=read_timeout, write=10.0, pool=5.0)
    delay = 1.0
    for attempt in range(retries):
        try:
            resp = httpx.post(VOYAGE_BASE_URL, json=payload, headers=headers, timeout=timeout)
            if resp.status_code == 429 or 500 <= resp.status_code < 600:
                log.warning("Voyage HTTP %d (attempt %d/%d) - backing off %.1fs",
                            resp.status_code, attempt + 1, retries, delay)
                time.sleep(delay)
                delay *= 2
                continue
            resp.raise_for_status()
            return resp.json()
        except httpx.TimeoutException as e:
            log.warning("Voyage timeout (attempt %d/%d): %s", attempt + 1, retries, e)
            time.sleep(delay)
            delay *= 2
        except httpx.HTTPStatusError as e:
            raise RuntimeError(f"Voyage HTTP {e.response.status_code}: {e.response.text}") from e
        except httpx.NetworkError as e:
            log.warning("Voyage network error (attempt %d/%d): %s", attempt + 1, retries, e)
            time.sleep(delay)
            delay *= 2
    raise RuntimeError("Voyage request failed after retries")


def embed_documents(texts: Sequence[str], *, model: str = VOYAGE_DEFAULT_MODEL,
                    batch_size: int = VOYAGE_BATCH_SIZE) -> list[list[float]]:
    """Embed a list of document strings. Returns one vector per input,
    same order. Batches automatically; safe for the ~28k corpus."""
    out: list[list[float]] = []
    if not texts:
        return out
    for i in range(0, len(texts), batch_size):
        chunk = list(texts[i:i + batch_size])
        # Voyage rejects empty strings - substitute a space so the index
        # alignment stays correct; downstream callers can still tell the
        # row apart by its UPC.
        chunk = [t if t and t.strip() else " " for t in chunk]
        resp = _post({"input": chunk, "model": model, "input_type": "document"})
        data = resp.get("data") or []
        # Voyage returns objects in REQUEST order with .index = position.
        vecs = [None] * len(chunk)
        for d in data:
            vecs[d["index"]] = d["embedding"]
        out.extend(vecs)
    return out


def embed_query(text: str, *, model: str = VOYAGE_DEFAULT_MODEL) -> list[float]:
    """Embed one short query string. Uses Voyage's `input_type=query`
    flag which slightly skews the embedding toward query-style text."""
    resp = _post({"input": [text or " "], "model": model, "input_type": "query"})
    data = resp.get("data") or []
    if not data:
        raise RuntimeError("Voyage query embed returned no data")
    return data[0]["embedding"]


def _compose_text(name: Optional[str], brand: Optional[str], description: Optional[str],
                  region: Optional[str], category: Optional[str],
                  category_path: Optional[str], *,
                  unit_volume: Optional[str] = None,
                  unit_qty: Optional[str] = None,
                  vintage: Optional[str] = None,
                  abv_proof: Optional[str] = None,
                  product_type: Optional[str] = None,
                  enr_category: Optional[str] = None,
                  enr_region: Optional[str] = None,
                  geo_country: Optional[str] = None,
                  geo_region: Optional[str] = None,
                  geo_subregion: Optional[str] = None,
                  geo_varietal: Optional[str] = None,
                  geo_style: Optional[str] = None) -> str:
    """The text blob each product is embedded as. Keep parts short but
    distinctive — Voyage embeds up to 32K tokens but the relevant signal
    fits in well under 1K.

    Physical attributes (volume, vintage, proof, type) from cpl_enriched are
    appended when supplied so queries like '750ml bourbon 90 proof 2019' find
    the right product even when those words don't appear in the Go-UPC text."""
    parts = []
    if name: parts.append(name.strip())
    if brand and (not name or brand.strip().lower() not in name.lower()):
        parts.append(brand.strip())
    # Canonical geo (LLM enrichment) is the most reliable origin signal — put
    # the full country/region/subregion chain first so "Bordeaux", "Napa
    # Valley", "Marlborough" embed strongly even when absent from the name.
    geo_chain = " ".join(x.strip() for x in (geo_country, geo_region, geo_subregion) if x)
    if geo_chain:
        parts.append(f"origin: {geo_chain}")
    if geo_varietal:
        parts.append(f"grape: {geo_varietal.strip()}")
    if geo_style:
        parts.append(f"style: {geo_style.strip()}")
    # Region: prefer enr_region (CPL-sourced) over the Go-UPC region field.
    r = (enr_region or region or "").strip()
    if r and r.lower() not in geo_chain.lower(): parts.append(f"region: {r}")
    # Category: prefer enr_category (granular, e.g. "Bourbon Whiskey") over the
    # Go-UPC top-level category ("Spirits"). Both are kept when they differ.
    cat = (enr_category or category or "").strip()
    if cat: parts.append(f"category: {cat}")
    if product_type and product_type.strip().lower() not in cat.lower():
        parts.append(f"type: {product_type.strip()}")
    if category_path:
        parts.append(category_path.strip())
    # Physical attributes — critical for volume/pack/proof/vintage searches.
    phys = []
    if unit_volume: phys.append(str(unit_volume).strip())
    if unit_qty:
        try:
            phys.append(f"{int(float(unit_qty))} per case")
        except (ValueError, TypeError):
            phys.append(str(unit_qty).strip())
    if vintage:
        vstr = str(vintage).split(".")[0]
        if vstr: phys.append(f"vintage {vstr}")
    if abv_proof: phys.append(str(abv_proof).strip())
    if phys: parts.append(" ".join(phys))
    if description:
        d = description.strip().replace("\n", " ")[:2000]
        parts.append(d)
    return " | ".join(parts)


def _format_vec_literal(vec: list[float]) -> str:
    """pgvector accepts a text literal like '[0.1,0.2,...]' for inserts."""
    return "[" + ",".join(f"{x:.7f}" for x in vec) + "]"


def _connect():
    """Open a fresh psycopg connection to the configured database.

    Three layers of timeout defence:
    - connect_timeout=10: abort if the TCP+auth handshake takes > 10s.
    - keepalives: detect a silently-dropped connection within ~10s of inactivity
      (idle=5s, then 3 probes at 2s intervals). Without this, a hung execute()
      or commit() can block indefinitely even after the server drops the socket.
    - statement_timeout=30000: Postgres aborts any statement that runs > 30s,
      which covers the INSERT/ON CONFLICT upsert loop."""
    import psycopg
    url = os.environ.get("RENDER_EXTERNAL_DATABASE_URL") or os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("no database URL")
    return psycopg.connect(
        url,
        connect_timeout=10,
        keepalives=1,
        keepalives_idle=5,
        keepalives_interval=2,
        keepalives_count=3,
        options="-c statement_timeout=180000",
    )


def index_enrichment(
    con_pg,
    *,
    batch_size: int = VOYAGE_BATCH_SIZE,
    only_missing: bool = True,
    model: str = VOYAGE_DEFAULT_MODEL,
    limit: Optional[int] = None,
    pause_between_batches: float = 0.0,
    cpl_supplement: Optional[dict] = None,
) -> dict:
    """Embed enrichment rows and upsert them into product_embeddings.

    Args:
        con_pg: psycopg connection.
        batch_size: rows per Voyage call (capped at 128 by the API).
        only_missing: when True, skip rows already in product_embeddings.
            Set False to re-embed every row (e.g. after a description
            refresh or model upgrade).
        model: Voyage model id; defaults to voyage-3 (1024 dims).
        limit: optional cap on rows for a smoke run.
        cpl_supplement: optional dict mapping upc_norm (leading-zero-stripped
            UPC string) to a dict of physical attributes from cpl_enriched:
            {unit_volume, unit_qty, vintage, abv_proof, product_type,
            enr_category, enr_region}. Built by the build script from a
            DuckDB connection and passed here so the embedding text includes
            volume/proof/vintage/type even though they aren't in
            product_enrichment. When absent, embedding reverts to the
            Go-UPC-only text (name + brand + region + category + description).

    Returns a small dict with counts for the log line at run end.
    """
    if not voyage_available():
        return {"error": "VOYAGE_API_KEY not set", "embedded": 0}
    # Initial fetch uses its OWN short-lived connection so the candidate
    # cursor doesn't get hit by Render's idle-timeout drop. Once we have
    # the row list in memory, batch-level upserts open their own.
    # Pull the canonical geo enrichment straight from product_enrichment (the
    # table being embedded) so origin/grape land in the vector regardless of the
    # cache supplement. Guarded by column existence for DBs that predate them.
    _GEO = ["geo_country", "geo_region", "geo_subregion", "geo_varietal", "geo_style"]
    with _connect() as _cc:
        _ck = _cc.cursor()
        _ck.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'product_enrichment' AND column_name = ANY(%s)", (_GEO,))
        _have = {(r["column_name"] if isinstance(r, dict) else r[0]) for r in _ck.fetchall()}
    geo_sel = "".join(f", pe.{c}" for c in _GEO if c in _have)
    base = f"""
        SELECT pe.upc, pe.name, pe.brand, pe.description, pe.region,
               pe.category, pe.category_path{geo_sel}
        FROM product_enrichment pe
        WHERE pe.upc IS NOT NULL AND pe.upc != ''
          AND (
              (pe.name IS NOT NULL AND pe.name != '')
              OR (pe.brand IS NOT NULL AND pe.brand != '')
              OR (pe.description IS NOT NULL AND pe.description != '')
          )
    """
    if only_missing:
        base += """
          AND NOT EXISTS (
              SELECT 1 FROM product_embeddings emb WHERE emb.upc = pe.upc
          )
        """
    if limit:
        base += f" LIMIT {int(limit)}"
    with _connect() as fetch_con:
        fcur = fetch_con.cursor()
        fcur.execute(base)
        _cols = [d[0] for d in fcur.description]
        # Normalise every row to a dict keyed by column name (works whether the
        # driver returns tuples or dict rows), so geo columns read by name.
        rows = [r if isinstance(r, dict) else dict(zip(_cols, r)) for r in fcur.fetchall()]
    log.info("Indexing %d enrichment rows into product_embeddings", len(rows))
    embedded = 0
    skipped_empty = 0
    failed_batches = 0
    total_batches = (len(rows) + batch_size - 1) // batch_size
    for bi, i in enumerate(range(0, len(rows), batch_size), start=1):
        chunk = rows[i:i + batch_size]
        texts: list[str] = []
        upcs: list[str] = []
        for r in chunk:
            # Rows are normalised to dicts above (column-name keyed).
            upc = r["upc"]
            name, brand, desc, region, cat, cat_path = (
                r.get("name"), r.get("brand"), r.get("description"),
                r.get("region"), r.get("category"), r.get("category_path"))
            cpl = (cpl_supplement or {}).get(str(upc).lstrip("0") or str(upc)) or {}
            # Geo: prefer the value selected straight from product_enrichment;
            # fall back to the cache supplement for older DBs without the columns.
            geo = lambda k: r.get(k) or cpl.get(k)  # noqa: E731
            blob = _compose_text(name, brand, desc, region, cat, cat_path,
                                 unit_volume=cpl.get("unit_volume"),
                                 unit_qty=cpl.get("unit_qty"),
                                 vintage=cpl.get("vintage"),
                                 abv_proof=cpl.get("abv_proof"),
                                 product_type=cpl.get("product_type"),
                                 enr_category=cpl.get("enr_category"),
                                 enr_region=cpl.get("enr_region"),
                                 geo_country=geo("geo_country"),
                                 geo_region=geo("geo_region"),
                                 geo_subregion=geo("geo_subregion"),
                                 geo_varietal=geo("geo_varietal"),
                                 geo_style=geo("geo_style"))
            if not blob.strip():
                skipped_empty += 1
                continue
            upcs.append(str(upc))
            texts.append(blob)
        if not texts:
            continue
        # Per-batch isolation: a single batch failure doesn't kill the job.
        # The catalogue is large enough that occasional network blips are
        # expected; we log the failure with full context, leave those UPCs
        # un-embedded, and re-attempt them on the next idempotent run.
        try:
            vecs = embed_documents(texts, model=model)
        except Exception as e:
            failed_batches += 1
            log.warning("batch %d/%d FAILED (%d rows skipped this pass): %s",
                        bi, total_batches, len(texts), e)
            continue
        # Fresh connection per batch. Render Postgres drops long-lived
        # connections silently every ~30 min; opening per batch sidesteps
        # the whole class of "server closed the connection unexpectedly"
        # crashes. Overhead is ~50ms per batch — negligible vs the Voyage
        # call. Retries twice on transient DB errors.
        upsert_attempts = 0
        while True:
            try:
                with _connect() as upsert_con:
                    ucur = upsert_con.cursor()
                    for upc, blob, vec in zip(upcs, texts, vecs):
                        if vec is None:
                            continue
                        ucur.execute(
                            """
                            INSERT INTO product_embeddings (upc, vec, model, text_blob, updated_at)
                            VALUES (%s, %s::vector, %s, %s, now())
                            ON CONFLICT (upc) DO UPDATE SET
                                vec = EXCLUDED.vec,
                                model = EXCLUDED.model,
                                text_blob = EXCLUDED.text_blob,
                                updated_at = now()
                            """,
                            (str(upc), _format_vec_literal(vec), model, blob),
                        )
                        embedded += 1
                    upsert_con.commit()
                break
            except Exception as e:
                upsert_attempts += 1
                if upsert_attempts >= 3:
                    log.warning("batch %d/%d upsert failed after %d attempts: %s — skipping batch (rows will retry on next idempotent run)",
                                bi, total_batches, upsert_attempts, e)
                    # Roll back embedded count for the rows we attempted in this batch.
                    embedded -= sum(1 for v in vecs if v is not None)
                    break
                log.warning("batch %d/%d upsert attempt %d failed (%s) — retrying",
                            bi, total_batches, upsert_attempts, e)
                time.sleep(1.0)
        # Log every 5 batches so progress is visible from the Monitor stream.
        if bi % 5 == 0 or bi == total_batches:
            log.info("  batch %d/%d - embedded %d / candidates %d",
                     bi, total_batches, embedded, len(rows))
        # Pace between batches to stay under Voyage's per-minute caps. At
        # Tier 1 this can be 0; on a freshly-upgraded account that hasn't
        # fully propagated, 2-3 seconds keeps us well below any plausible
        # TPM ceiling without making the run unreasonably long.
        if pause_between_batches > 0 and bi < total_batches:
            time.sleep(pause_between_batches)
    return {"embedded": embedded, "skipped_empty": skipped_empty,
            "failed_batches": failed_batches, "candidate_rows": len(rows),
            "model": model}
