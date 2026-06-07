#!/usr/bin/env python
"""Load the processed Parquet pricing tables into Postgres (full replace).

Run locally each month after the Excel -> Parquet pipeline. DuckDB reads the
Parquet (Hive partitions materialise the wholesaler/edition columns) and writes
straight into Postgres via the postgres extension, preserving column types so
the existing DuckDB casts behave identically.

Usage:
    python scripts/ingest_to_postgres.py            # local DATABASE_URL only
    python scripts/ingest_to_postgres.py --prod     # prod (RENDER_EXTERNAL_DATABASE_URL) only
    python scripts/ingest_to_postgres.py --all      # local AND prod (the monthly load)
    python scripts/ingest_to_postgres.py --database-url "postgresql://user:pw@host/db?sslmode=require"

By default reads DATABASE_URL / RENDER_EXTERNAL_DATABASE_URL and PARQUET_DIR
from the environment / .env, so the same command works from any machine that
has the OneDrive project folder (which carries .env and parquet_output).

After every run that touched the LOCAL database, the stale local DuckDB cache
files (user_data/pricing_*.duckdb) are swept so the next local read rebuilds
from the fresh data instead of silently serving the old month.

For prod, finish by triggering POST /api/admin/reload-pricing (Admin page
button) or a Render redeploy so the app rebuilds its cache.
"""
import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import duckdb
from backend.pg import DATABASE_URL as ENV_DATABASE_URL
from backend.pricing_cache import ALL_TABLES, CACHE_DIR, _parquet_select, pg_libpq


def ingest(database_url: str) -> None:
    print(f"Ingesting {len(ALL_TABLES)} pricing tables into {database_url.split('@')[-1]}")
    con = duckdb.connect()
    con.execute("INSTALL postgres; LOAD postgres;")
    con.execute(f"ATTACH '{pg_libpq(database_url)}' AS pg (TYPE postgres)")
    try:
        for t in ALL_TABLES:
            sel = _parquet_select(t)
            con.execute(f"DROP TABLE IF EXISTS pg.{t}")
            con.execute(f"CREATE TABLE pg.{t} AS SELECT * FROM {sel}")
            n = con.execute(f"SELECT count(*) FROM pg.{t}").fetchone()[0]
            print(f"  {t}: {n} rows")
    finally:
        con.execute("DETACH pg")
        con.close()


def sweep_local_cache() -> None:
    """Remove stale local DuckDB cache files so the next local read rebuilds.

    Safe: these are disposable derived artifacts; anything held open by a
    running backend just fails to unlink and is skipped (that backend still
    needs its /api/admin/reload-pricing anyway)."""
    removed = 0
    for p in CACHE_DIR.glob("pricing_*.duckdb"):
        try:
            p.unlink()
            removed += 1
        except OSError:
            print(f"  (cache file in use, skipped: {p.name})")
    if removed:
        print(f"Swept {removed} stale local cache file(s) from {CACHE_DIR.name}/")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--database-url", default=None,
                    help="Explicit target Postgres URL (overrides --prod/--all)")
    ap.add_argument("--prod", action="store_true",
                    help="Target prod (RENDER_EXTERNAL_DATABASE_URL) instead of local")
    ap.add_argument("--all", action="store_true",
                    help="Target local DATABASE_URL and then prod")
    args = ap.parse_args()

    targets: list[tuple[str, str]] = []  # (label, url)
    if args.database_url:
        targets.append(("explicit", args.database_url))
    else:
        prod_url = (os.getenv("RENDER_EXTERNAL_DATABASE_URL") or "").strip()
        if args.all or not args.prod:
            targets.append(("local", ENV_DATABASE_URL))
        if args.all or args.prod:
            if not prod_url:
                sys.exit("RENDER_EXTERNAL_DATABASE_URL not set (.env) — cannot target prod")
            targets.append(("prod", prod_url))

    for label, url in targets:
        print(f"=== {label} ===")
        ingest(url)
        if label == "local" or (label == "explicit" and "render.com" not in url):
            sweep_local_cache()

    if any(label in ("prod", "explicit") for label, _ in targets):
        print("Done. Trigger /api/admin/reload-pricing (Admin page) or redeploy "
              "so prod rebuilds its cache.")
    else:
        print("Done. Local cache swept; next local read rebuilds automatically.")


if __name__ == "__main__":
    main()
