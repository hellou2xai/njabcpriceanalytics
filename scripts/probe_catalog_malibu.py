"""How many products SHOULD the catalog return for q='malibu pink'?
Run the same per-token OR the catalog uses against Render."""
from __future__ import annotations

import os, sys
from dotenv import load_dotenv
import psycopg

load_dotenv()
DB = os.environ.get("RENDER_EXTERNAL_DATABASE_URL") or os.environ.get("DATABASE_URL")
if not DB:
    print("no DB url", file=sys.stderr); sys.exit(1)

CYM = "2026-06"
con = psycopg.connect(DB)
cur = con.cursor()

# 1. Baseline: just name+brand (the catalog's OLD behaviour).
sql_old = """
    WITH cur AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched
                 WHERE edition <= %s GROUP BY wholesaler)
    SELECT COUNT(*) FROM cpl_enriched c JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed
    WHERE (UPPER(c.product_name) LIKE '%%MALIBU%%' OR UPPER(COALESCE(c.brand,'')) LIKE '%%MALIBU%%')
      AND (UPPER(c.product_name) LIKE '%%PINK%%' OR UPPER(COALESCE(c.brand,'')) LIKE '%%PINK%%')
"""
cur.execute(sql_old, (CYM,))
print(f"OLD (name+brand only): {cur.fetchone()[0]}")

# 2. With my new additions: name+brand+unit_volume+rip_code.
sql_new = """
    WITH cur AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched
                 WHERE edition <= %s GROUP BY wholesaler)
    SELECT COUNT(*) FROM cpl_enriched c JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed
    WHERE (UPPER(c.product_name) LIKE '%%MALIBU%%' OR UPPER(COALESCE(c.brand,'')) LIKE '%%MALIBU%%'
           OR UPPER(COALESCE(c.unit_volume,'')) LIKE '%%MALIBU%%'
           OR UPPER(COALESCE(CAST(c.rip_code AS VARCHAR),'')) LIKE '%%MALIBU%%')
      AND (UPPER(c.product_name) LIKE '%%PINK%%' OR UPPER(COALESCE(c.brand,'')) LIKE '%%PINK%%'
           OR UPPER(COALESCE(c.unit_volume,'')) LIKE '%%PINK%%'
           OR UPPER(COALESCE(CAST(c.rip_code AS VARCHAR),'')) LIKE '%%PINK%%')
"""
cur.execute(sql_new, (CYM,))
print(f"NEW (+ unit_volume + rip_code): {cur.fetchone()[0]}")

# 3. Show what those rows look like - distinct (name, distributor).
cur.execute("""
    WITH cur AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched
                 WHERE edition <= %s GROUP BY wholesaler)
    SELECT DISTINCT c.product_name, c.wholesaler, c.unit_volume
    FROM cpl_enriched c JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed
    WHERE UPPER(c.product_name) LIKE '%MALIBU PINK%'
    ORDER BY c.product_name, c.wholesaler
""", (CYM,))
print()
print("Distinct MALIBU PINK rows:")
for r in cur.fetchall():
    print(" ", r)
con.close()
