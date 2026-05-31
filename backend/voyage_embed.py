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


def _post(payload: dict, *, retries: int = 3, timeout: float = 30.0) -> dict:
    """POST one batch to Voyage. Retries on 429/5xx with exponential backoff.

    Tightened defaults: 30s socket timeout (was 60), 3 retries (was 4). At
    the prior settings a single bad batch could burn 15 minutes silently."""
    import urllib.request
    import urllib.error
    import json

    key = os.environ.get("VOYAGE_API_KEY")
    if not key:
        raise RuntimeError("VOYAGE_API_KEY not set")
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        VOYAGE_BASE_URL,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
    )
    delay = 1.0
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            code = e.code
            if code == 429 or 500 <= code < 600:
                log.warning("Voyage HTTP %d (attempt %d/%d) - backing off %.1fs",
                            code, attempt + 1, retries, delay)
                time.sleep(delay)
                delay *= 2
                continue
            # Non-retryable: surface the response body for diagnostics.
            try:
                msg = e.read().decode("utf-8")
            except Exception:
                msg = str(e)
            raise RuntimeError(f"Voyage HTTP {code}: {msg}") from e
        except (urllib.error.URLError, TimeoutError) as e:
            log.warning("Voyage URL error (attempt %d/%d): %s", attempt + 1, retries, e)
            time.sleep(delay); delay *= 2
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
                  category_path: Optional[str]) -> str:
    """The text blob each product is embedded as. Keep parts short but
    distinctive — Voyage embeds up to 32K tokens but the relevant signal
    fits in well under 1K."""
    parts = []
    if name: parts.append(name.strip())
    if brand and (not name or brand.strip().lower() not in name.lower()):
        parts.append(brand.strip())
    if region: parts.append(f"region: {region.strip()}")
    if category: parts.append(f"category: {category.strip()}")
    if category_path:
        # category_path is JSON-array text - keep as-is for the model to read.
        parts.append(category_path.strip())
    if description:
        # Truncate ultra-long descriptions to ~2K chars to stay under any
        # token budget while keeping the signal.
        d = description.strip().replace("\n", " ")[:2000]
        parts.append(d)
    return " | ".join(parts)


def _format_vec_literal(vec: list[float]) -> str:
    """pgvector accepts a text literal like '[0.1,0.2,...]' for inserts."""
    return "[" + ",".join(f"{x:.7f}" for x in vec) + "]"


def _connect():
    """Open a fresh psycopg connection to the configured database. Used so the
    indexer can grab a clean connection per batch — eliminates the Render-side
    idle-timeout drops that kill long-lived connections mid-run."""
    import psycopg
    url = os.environ.get("RENDER_EXTERNAL_DATABASE_URL") or os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("no database URL")
    return psycopg.connect(url, connect_timeout=10)


def index_enrichment(
    con_pg,
    *,
    batch_size: int = VOYAGE_BATCH_SIZE,
    only_missing: bool = True,
    model: str = VOYAGE_DEFAULT_MODEL,
    limit: Optional[int] = None,
    pause_between_batches: float = 0.0,
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

    Returns a small dict with counts for the log line at run end.
    """
    if not voyage_available():
        return {"error": "VOYAGE_API_KEY not set", "embedded": 0}
    # Initial fetch uses its OWN short-lived connection so the candidate
    # cursor doesn't get hit by Render's idle-timeout drop. Once we have
    # the row list in memory, batch-level upserts open their own.
    base = """
        SELECT pe.upc, pe.name, pe.brand, pe.description, pe.region,
               pe.category, pe.category_path
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
        rows = fcur.fetchall()
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
            # Row may be a dict (psycopg dict_row) or a tuple — handle both.
            if isinstance(r, dict):
                upc = r["upc"]
                blob = _compose_text(r["name"], r["brand"], r["description"],
                                     r["region"], r["category"], r["category_path"])
            else:
                upc = r[0]
                blob = _compose_text(r[1], r[2], r[3], r[4], r[5], r[6])
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
