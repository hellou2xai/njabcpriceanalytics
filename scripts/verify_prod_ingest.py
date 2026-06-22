#!/usr/bin/env python
"""Verify prod Postgres has everything local Parquet does, before the
shared-cache / CDN work. Read-only: counts rows + distributor coverage on both
sides and prints a side-by-side diff. Resolves the prod URL from .env
(RENDER_EXTERNAL_DATABASE_URL) the same way the ingest tooling does."""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv
load_dotenv()

import duckdb
from backend.pricing_cache import ALL_TABLES, _parquet_select, pg_libpq

PROD_URL = (os.getenv("RENDER_EXTERNAL_DATABASE_URL") or "").strip()
if not PROD_URL:
    print("RENDER_EXTERNAL_DATABASE_URL not set in .env — cannot verify prod")
    sys.exit(2)

# (wholesaler, edition) tables we can compare partition-by-partition.
PARTITIONED = ["cpl_enriched", "price_changes", "item_lifecycle", "cpl", "rip", "combo"]
# Extra tables not in ALL_TABLES but loaded by sibling scripts.
EXTRA = ["product_enrichment", "sku_mapping", "ai_deal_blurbs",
         "celr_families", "celr_product_upcs", "celr_family_keys",
         "celr_family_aliases"]

con = duckdb.connect()
con.execute("INSTALL postgres; LOAD postgres;")
con.execute(f"ATTACH '{pg_libpq(PROD_URL)}' AS prod (TYPE postgres, READ_ONLY)")


def prod_count(t):
    try:
        return con.execute(f"SELECT COUNT(*) FROM prod.{t}").fetchone()[0]
    except Exception as e:
        return f"MISSING ({str(e)[:40]})"


def parquet_count(t):
    try:
        return con.execute(f"SELECT COUNT(*) FROM {_parquet_select(t)}").fetchone()[0]
    except Exception as e:
        return f"n/a ({str(e)[:40]})"


print("=== ROW COUNTS  (local Parquet  ->  prod Postgres) ===")
ok = True
for t in ALL_TABLES + EXTRA:
    loc = parquet_count(t) if t in ALL_TABLES else "—"
    pr = prod_count(t)
    flag = ""
    if t in ALL_TABLES and isinstance(loc, int) and isinstance(pr, int):
        if pr < loc:
            flag = f"  <<< PROD SHORT by {loc - pr}"
            ok = False
        elif pr > loc:
            flag = f"  (prod has {pr - loc} extra — older partitions kept)"
    if isinstance(pr, str) and pr.startswith("MISSING") and t in ALL_TABLES:
        ok = False
    print(f"  {t:22} {str(loc):>10}  ->  {str(pr):>10}{flag}")

print("\n=== DISTRIBUTOR COVERAGE (cpl_enriched) ===")
loc_ws = {r[0] for r in con.execute(
    f"SELECT DISTINCT wholesaler FROM {_parquet_select('cpl_enriched')}").fetchall()}
pr_ws = {r[0] for r in con.execute(
    "SELECT DISTINCT wholesaler FROM prod.cpl_enriched").fetchall()}
print(f"  local: {len(loc_ws)} distributors")
print(f"  prod:  {len(pr_ws)} distributors")
missing = sorted(loc_ws - pr_ws)
extra = sorted(pr_ws - loc_ws)
if missing:
    print(f"  !!! IN LOCAL, NOT IN PROD: {missing}")
    ok = False
if extra:
    print(f"  (in prod, not local: {extra})")

print("\n=== PER-(distributor,edition) PARTITION DIFF (cpl_enriched) ===")
loc_parts = {(r[0], r[1]): r[2] for r in con.execute(
    f"SELECT wholesaler, edition, COUNT(*) FROM {_parquet_select('cpl_enriched')} "
    "GROUP BY 1,2").fetchall()}
pr_parts = {(r[0], r[1]): r[2] for r in con.execute(
    "SELECT wholesaler, edition, COUNT(*) FROM prod.cpl_enriched GROUP BY 1,2").fetchall()}
diffs = 0
for k, lc in sorted(loc_parts.items()):
    pc = pr_parts.get(k)
    if pc is None:
        print(f"  MISSING in prod: {k[0]} {k[1]}  (local {lc})")
        diffs += 1
        ok = False
    elif pc != lc:
        print(f"  COUNT DIFF: {k[0]} {k[1]}  local {lc} vs prod {pc}")
        diffs += 1
        ok = False
if diffs == 0:
    print("  all local partitions present in prod with matching counts")

con.execute("DETACH prod")
print("\n=== RESULT:", "PROD COMPLETE [OK]" if ok else "PROD INCOMPLETE [FAIL]", "===")
sys.exit(0 if ok else 1)
