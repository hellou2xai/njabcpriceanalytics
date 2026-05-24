#!/usr/bin/env python
"""Load the processed Parquet pricing tables into Postgres (full replace).

Run locally each month after the Excel -> Parquet pipeline. DuckDB reads the
Parquet (Hive partitions materialise the wholesaler/edition columns) and writes
straight into Postgres via the postgres extension, preserving column types so
the existing DuckDB casts behave identically.

Usage:
    python scripts/ingest_to_postgres.py
    python scripts/ingest_to_postgres.py --database-url "postgresql://user:pw@host/db?sslmode=require"

By default reads DATABASE_URL and PARQUET_DIR from the environment / .env. Pass
--database-url to target a different database (for example the Render external
URL) without editing .env. After it runs, trigger POST /api/admin/reload-pricing
(or redeploy) so the app rebuilds its local DuckDB cache.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import duckdb
from backend.pg import DATABASE_URL as ENV_DATABASE_URL
from backend.pricing_cache import ALL_TABLES, _parquet_select, pg_libpq


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--database-url", default=ENV_DATABASE_URL,
                    help="Target Postgres URL (defaults to env DATABASE_URL)")
    args = ap.parse_args()
    database_url = args.database_url

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
    print("Done. Trigger /api/admin/reload-pricing or redeploy to refresh the cache.")


if __name__ == "__main__":
    main()
