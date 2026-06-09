#!/usr/bin/env python
"""Load the processed Parquet pricing tables into Postgres.

Run locally each month after the Excel -> Parquet pipeline. DuckDB reads the
Parquet (Hive partitions materialise the wholesaler/edition columns) and writes
straight into Postgres via the postgres extension, preserving column types so
the existing DuckDB casts behave identically.

INCREMENTAL BY DEFAULT (partition-replace). Six of the seven tables carry
(wholesaler, edition); for those, each (wholesaler, edition) partition PRESENT
in the Parquet is deleted and re-inserted, so a load only touches the partitions
it actually ships. Partitions that exist in Postgres but NOT in the Parquet are
LEFT ALONE. This means loading one distributor (or one month) can never wipe the
others as a side effect, and you can add a new distributor by loading just its
file. `cross_source_links` has no per-row (wholesaler, edition) so it is always
full-replaced (it is global and small, recomputed across all distributors).

Use --full for an exact mirror (drop + recreate every table) when you want
Postgres to match the Parquet precisely, including dropping partitions that are
no longer in the Parquet.

Usage:
    python scripts/ingest_to_postgres.py                       # local, all parquet partitions (incremental)
    python scripts/ingest_to_postgres.py --wholesaler kramer   # only Kramer's partitions
    python scripts/ingest_to_postgres.py --edition 2026-06     # only the June partitions
    python scripts/ingest_to_postgres.py --wholesaler kramer --prod   # one distributor, prod
    python scripts/ingest_to_postgres.py --full                # exact mirror (old full-replace)
    python scripts/ingest_to_postgres.py --prod                # prod (RENDER_EXTERNAL_DATABASE_URL)
    python scripts/ingest_to_postgres.py --all                 # local AND prod
    python scripts/ingest_to_postgres.py --database-url "postgresql://user:pw@host/db?sslmode=require"

--wholesaler / --edition accept comma-separated lists and may be repeated.

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


def _sql_str(v: str) -> str:
    """Quote a literal for inlining (slugs / editions only)."""
    return "'" + str(v).replace("'", "''") + "'"


def _pg_table_exists(con, t: str) -> bool:
    try:
        con.execute(f"SELECT 1 FROM pg.{t} LIMIT 1")
        return True
    except duckdb.Error:
        return False


def ingest(database_url: str, wholesalers=None, editions=None, full: bool = False) -> None:
    scope = []
    if wholesalers:
        scope.append("wholesaler in " + ", ".join(wholesalers))
    if editions:
        scope.append("edition in " + ", ".join(editions))
    mode_txt = "FULL replace" if full else "incremental (partition-replace)"
    print(f"Ingesting {len(ALL_TABLES)} pricing tables into "
          f"{database_url.split('@')[-1]} — {mode_txt}"
          + (f"; scope: {'; '.join(scope)}" if scope else ""))

    con = duckdb.connect()
    con.execute("INSTALL postgres; LOAD postgres;")
    con.execute(f"ATTACH '{pg_libpq(database_url)}' AS pg (TYPE postgres)")
    try:
        for t in ALL_TABLES:
            cols = [d[0] for d in con.execute(
                f"SELECT * FROM {_parquet_select(t)} LIMIT 0").description]
            partitionable = ("wholesaler" in cols) and ("edition" in cols)

            # Scope the Parquet read to the requested partitions (only for tables
            # that actually carry those columns).
            conds = []
            if wholesalers and "wholesaler" in cols:
                conds.append("wholesaler IN (" + ", ".join(_sql_str(w) for w in wholesalers) + ")")
            if editions and "edition" in cols:
                conds.append("edition IN (" + ", ".join(_sql_str(e) for e in editions) + ")")
            where = (" WHERE " + " AND ".join(conds)) if conds else ""
            src = f"(SELECT * FROM {_parquet_select(t)}{where})"

            # Full mirror, or a global/first-time table -> drop + recreate.
            if full or not partitionable or not _pg_table_exists(con, t):
                con.execute(f"DROP TABLE IF EXISTS pg.{t}")
                con.execute(f"CREATE TABLE pg.{t} AS SELECT * FROM {src}")
                n = con.execute(f"SELECT count(*) FROM pg.{t}").fetchone()[0]
                why = "global" if not partitionable else ("scoped" if conds else "all")
                print(f"  {t}: {n} rows (full replace, {why})")
                continue

            # Incremental: delete only the (wholesaler, edition) partitions present
            # in this Parquet read, then insert them. Untouched partitions remain.
            parts = [(w, e) for (w, e) in con.execute(
                f"SELECT DISTINCT wholesaler, edition FROM {src}").fetchall()
                if w is not None and e is not None]
            if not parts:
                print(f"  {t}: 0 rows (no matching partitions, skipped)")
                continue
            tuples = ", ".join(f"({_sql_str(w)}, {_sql_str(e)})" for w, e in parts)
            con.execute(f"DELETE FROM pg.{t} WHERE (wholesaler, edition) IN ({tuples})")
            con.execute(f"INSERT INTO pg.{t} SELECT * FROM {src}")
            n = con.execute(f"SELECT count(*) FROM {src}").fetchone()[0]
            print(f"  {t}: {n} rows ({len(parts)} partition(s))")
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
    ap.add_argument("--wholesaler", action="append", default=None,
                    help="Only load these distributor slug(s). Comma-separated "
                         "and/or repeated. Partition-replace, others untouched.")
    ap.add_argument("--edition", action="append", default=None,
                    help="Only load these edition(s), e.g. 2026-06. Comma-separated "
                         "and/or repeated.")
    ap.add_argument("--full", action="store_true",
                    help="Exact mirror: drop + recreate every table (drops "
                         "partitions no longer in the Parquet). Default is "
                         "incremental partition-replace.")
    args = ap.parse_args()

    def _split(vals):
        if not vals:
            return None
        out = []
        for v in vals:
            out.extend(s.strip() for s in str(v).split(",") if s.strip())
        return out or None

    wholesalers = _split(args.wholesaler)
    editions = _split(args.edition)

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
        ingest(url, wholesalers=wholesalers, editions=editions, full=args.full)
        if label == "local" or (label == "explicit" and "render.com" not in url):
            sweep_local_cache()

    if any(label in ("prod", "explicit") for label, _ in targets):
        print("Done. Trigger /api/admin/reload-pricing (Admin page) or redeploy "
              "so prod rebuilds its cache.")
    else:
        print("Done. Local cache swept; next local read rebuilds automatically.")


if __name__ == "__main__":
    main()
