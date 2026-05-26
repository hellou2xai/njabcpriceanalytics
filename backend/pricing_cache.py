"""
Pricing cache: a local DuckDB database materialised from the canonical store.

Option 1 architecture: the processed pricing tables live in Postgres (loaded
monthly by scripts/ingest_to_postgres.py). At boot, and on demand, we copy them
into a local DuckDB file and serve every analytical query from there, unchanged.
DuckDB stays the query engine, so none of the ~144 analytical queries change.

PRICING_SOURCE selects where the cache is built from:
  - "postgres" (default): copy from the attached Postgres database.
  - "parquet": read the Parquet files directly (handy for local dev before any
    Postgres ingestion has run).

The cache file is versioned (pricing_<ts>.duckdb) and swapped atomically by
pointer, so a reload never overwrites a file that open read connections hold.
"""

import os
import time
import threading
from pathlib import Path
from urllib.parse import urlparse, parse_qsl

import duckdb

from backend.db import PROJECT_ROOT, PARQUET_DIR

PRICING_SOURCE = os.getenv("PRICING_SOURCE", "postgres")  # 'postgres' | 'parquet'
CACHE_DIR = PROJECT_ROOT / "user_data"

# Single-file (derived) tables vs Hive-partitioned (raw) tables, matching the
# Parquet layout. These names are exactly what read_parquet() is called with.
DERIVED = ["cpl_enriched", "price_changes", "item_lifecycle", "cross_source_links"]
RAW = ["cpl", "rip", "combo"]
ALL_TABLES = DERIVED + RAW

_lock = threading.Lock()
_current_path: Path | None = None


def _parquet_select(table: str) -> str:
    pdir = PARQUET_DIR.as_posix()
    if table in DERIVED:
        return f"read_parquet('{pdir}/derived/{table}.parquet')"
    return f"read_parquet('{pdir}/{table}/**/data.parquet', hive_partitioning=true, union_by_name=true)"


def pg_libpq(url: str) -> str:
    """Convert a DATABASE_URL into a libpq keyword string for DuckDB's ATTACH.

    Query params are preserved, so a Render external URL with sslmode=require
    connects with SSL the same way psycopg does."""
    u = urlparse(url)
    parts = []
    if u.hostname: parts.append(f"host={u.hostname}")
    if u.port: parts.append(f"port={u.port}")
    if u.username: parts.append(f"user={u.username}")
    if u.password: parts.append(f"password={u.password}")
    db = u.path.lstrip("/")
    if db: parts.append(f"dbname={db}")
    for k, v in parse_qsl(u.query):
        parts.append(f"{k}={v}")
    return " ".join(parts)


def _cleanup_old(keep: Path | None):
    """Best-effort removal of stale cache files (skip any still held by a reader)."""
    for p in CACHE_DIR.glob("pricing_*.duckdb"):
        if keep is not None and p == keep:
            continue
        try:
            p.unlink()
        except OSError:
            pass  # a reader still has it open; leave it for next time


def build_pricing_cache() -> Path:
    """(Re)build the cache into a fresh versioned file and point at it. Returns
    the new file path. Safe to call concurrently; serialised by a lock."""
    global _current_path
    with _lock:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        new_path = CACHE_DIR / f"pricing_{int(time.time() * 1000)}.duckdb"
        con = duckdb.connect(str(new_path))
        try:
            # Enrichment columns surfaced to the catalogue (everything useful
            # Go-UPC returns, minus the raw attributes blob which stays in
            # Postgres). category_path/specs are JSON text parsed by the API.
            enrich_cols = (
                "upc, name, brand, category, category_path, description, region, "
                "specs, ean, code_type, barcode_url, inferred, image_url, image_source"
            )
            empty_enrich = (
                "CREATE TABLE product_enrichment ("
                "upc VARCHAR, name VARCHAR, brand VARCHAR, category VARCHAR, "
                "category_path VARCHAR, description VARCHAR, region VARCHAR, "
                "specs VARCHAR, ean VARCHAR, code_type VARCHAR, barcode_url VARCHAR, "
                "inferred INTEGER, image_url VARCHAR, image_source VARCHAR)"
            )
            if PRICING_SOURCE == "parquet":
                for t in ALL_TABLES:
                    con.execute(f"CREATE TABLE {t} AS SELECT * FROM {_parquet_select(t)}")
                # No enrichment in parquet dev mode; an empty table keeps joins valid.
                con.execute(empty_enrich)
            else:
                from backend.pg import DATABASE_URL
                con.execute("INSTALL postgres; LOAD postgres;")
                con.execute(f"ATTACH '{pg_libpq(DATABASE_URL)}' AS pg (TYPE postgres, READ_ONLY)")
                for t in ALL_TABLES:
                    con.execute(f"CREATE TABLE {t} AS SELECT * FROM pg.{t}")
                try:
                    con.execute(f"CREATE TABLE product_enrichment AS SELECT {enrich_cols} FROM pg.product_enrichment")
                except Exception:  # table may not exist yet on a brand-new DB
                    con.execute(empty_enrich)
                con.execute("DETACH pg")

            # Wire the catalogue brand to the Go-UPC enriched brand by UPC. CPL
            # brands are noisy/wrong; the enrichment brand (keyed by normalised
            # UPC) is canonical. This corrects the brand everywhere at once: row
            # display, the Brand filter facet, and brand filtering. No-op in
            # parquet dev mode (enrichment table is the empty stub).
            try:
                con.execute("""
                    UPDATE cpl_enriched
                    SET brand = pe.brand
                    FROM product_enrichment pe
                    WHERE pe.upc = LTRIM(cpl_enriched.upc, '0')
                      AND pe.brand IS NOT NULL AND pe.brand <> ''
                """)
            except Exception:
                pass

            # Precompute combo membership so the catalogue can filter to bundle
            # products cheaply (a product is "in combo" if its wholesaler+UPC
            # appears in the combo table).
            try:
                con.execute("ALTER TABLE cpl_enriched ADD COLUMN in_combo BOOLEAN DEFAULT false")
                con.execute("""
                    UPDATE cpl_enriched SET in_combo = true
                    WHERE EXISTS (
                        SELECT 1 FROM combo c
                        WHERE c.wholesaler = cpl_enriched.wholesaler
                          AND LTRIM(c.upc, '0') = LTRIM(cpl_enriched.upc, '0')
                    )
                """)
            except Exception:
                pass
        finally:
            con.close()
        old = _current_path
        _current_path = new_path
        _cleanup_old(keep=new_path)
        return new_path


def get_pricing_path() -> Path:
    """Path to the current cache file, building it on first use."""
    if _current_path is None:
        build_pricing_cache()
    return _current_path
