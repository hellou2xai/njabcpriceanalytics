#!/usr/bin/env python
"""Build (or refresh) the Voyage semantic index over product_enrichment.

Walks every enriched row, composes its text blob (name + brand + region +
category + category_path + description + unit_volume + vintage + abv_proof +
product_type + enr_category from cpl_enriched), embeds via Voyage AI, and
upserts (upc, vec, model, text_blob) into product_embeddings.

Usage:
    # Index every row that doesn't yet have an embedding (default).
    # Safe to re-run — fully idempotent.
    python scripts/build_semantic_index.py

    # Re-embed everything from scratch (e.g. after a model upgrade or after
    # adding new enrichment fields like volume/proof/vintage).
    python scripts/build_semantic_index.py --all

    # Target a specific database URL (defaults to RENDER_EXTERNAL_DATABASE_URL
    # if set, else DATABASE_URL).
    python scripts/build_semantic_index.py --database-url 'postgresql://...'

    # Smoke run on a small batch to confirm Voyage credentials work.
    python scripts/build_semantic_index.py --limit 32

    # Skip cpl_enriched supplement (Go-UPC-only text, faster but less precise).
    python scripts/build_semantic_index.py --no-cpl

Requirements:
    - VOYAGE_API_KEY in env (free tier covers our 28k corpus indefinitely).
    - pgvector extension installed (CREATE EXTENSION vector).
    - product_embeddings table present (created by the migration block
      below if absent — harmless if it already exists).
    - PRICING_CACHE_PATH (or a DuckDB parquet cache) for the cpl_enriched
      supplement; gracefully skipped when absent.
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from dotenv import load_dotenv
import psycopg

load_dotenv()


def ensure_table(con) -> None:
    """Make sure pgvector + the embeddings table + HNSW index all exist."""
    cur = con.cursor()
    cur.execute("CREATE EXTENSION IF NOT EXISTS vector")
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS product_embeddings (
            upc          text PRIMARY KEY,
            vec          vector(1024),
            model        text NOT NULL,
            text_blob    text,
            updated_at   timestamptz DEFAULT now()
        )
        """
    )
    cur.execute(
        """
        CREATE INDEX IF NOT EXISTS product_embeddings_vec_idx
        ON product_embeddings USING hnsw (vec vector_cosine_ops)
        """
    )
    con.commit()


def main() -> None:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--database-url",
        default=os.getenv("RENDER_EXTERNAL_DATABASE_URL") or os.getenv("DATABASE_URL"),
        help="Postgres URL (defaults to RENDER_EXTERNAL_DATABASE_URL or DATABASE_URL)",
    )
    ap.add_argument("--all", action="store_true",
                    help="Re-embed every row (default: only rows missing an embedding)")
    ap.add_argument("--limit", type=int, default=None,
                    help="Cap the number of rows for a smoke run")
    ap.add_argument("--model", default=os.getenv("VOYAGE_EMBED_MODEL", "voyage-3"),
                    help="Voyage model id (default: voyage-3, 1024 dims)")
    ap.add_argument("--batch-size", type=int, default=64,
                    help="Inputs per Voyage call (default 64; Voyage hard cap 128)")
    ap.add_argument("--pause", type=float, default=0.0,
                    help="Seconds to sleep between batches. Use 2-3 if Voyage 429s persist")
    ap.add_argument("--no-cpl", action="store_true",
                    help="Skip the cpl_enriched supplement (Go-UPC-only text, faster)")
    args = ap.parse_args()

    if not os.getenv("VOYAGE_API_KEY"):
        sys.exit("error: VOYAGE_API_KEY is not set in the environment")
    if not args.database_url:
        sys.exit("error: no database URL (set RENDER_EXTERNAL_DATABASE_URL or DATABASE_URL)")

    print(f"Target: {args.database_url.split('@')[-1]}")
    print(f"Model:  {args.model}")
    print(f"Mode:   {'ALL rows' if args.all else 'missing rows only'}"
          + (f", limit={args.limit}" if args.limit else ""))
    print()

    # Build the cpl_enriched supplement: physical attributes (volume, vintage,
    # proof, product_type, enr_category, enr_region) keyed on upc_norm.
    # Used to enrich the embedding text beyond what Go-UPC provides.
    cpl_supplement: dict = {}
    if not args.no_cpl:
        try:
            import duckdb as _ddb
            from backend.db import get_duckdb as _get_duck
            print("Building cpl_enriched supplement ...")
            with _get_duck() as duck:
                rows_cpl = duck.execute("""
                    SELECT LTRIM(CAST(upc AS VARCHAR), '0') AS un,
                           ANY_VALUE(unit_volume) AS unit_volume,
                           ANY_VALUE(TRY_CAST(unit_qty AS VARCHAR)) AS unit_qty,
                           ANY_VALUE(CAST(vintage AS VARCHAR)) AS vintage,
                           ANY_VALUE(abv_proof) AS abv_proof,
                           ANY_VALUE(product_type) AS product_type,
                           ANY_VALUE(enr_category) AS enr_category,
                           ANY_VALUE(enr_region) AS enr_region
                    FROM cpl_enriched
                    WHERE upc IS NOT NULL AND LTRIM(CAST(upc AS VARCHAR),'0') != ''
                    GROUP BY 1
                """).fetchall()
            for row in rows_cpl:
                un = row[0]
                if un:
                    cpl_supplement[un] = {
                        "unit_volume": row[1], "unit_qty": row[2],
                        "vintage": row[3], "abv_proof": row[4],
                        "product_type": row[5], "enr_category": row[6],
                        "enr_region": row[7],
                    }
            print(f"  {len(cpl_supplement)} UPC supplement rows loaded")
        except Exception as exc:
            print(f"  cpl_enriched supplement skipped: {exc}")

    with psycopg.connect(args.database_url) as con:
        ensure_table(con)
        from backend.voyage_embed import index_enrichment
        result = index_enrichment(
            con,
            only_missing=not args.all,
            limit=args.limit,
            model=args.model,
            batch_size=args.batch_size,
            pause_between_batches=args.pause,
            cpl_supplement=cpl_supplement or None,
        )
        print()
        print(f"Done: {result}")


if __name__ == "__main__":
    main()
