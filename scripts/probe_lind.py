"""Repro the missing Full Case Mix for LIND BIN 40 MER 21 / Allied 109359.
Mirrors the exact SQL _focal_product_for_rip + _full_case_mix run, against
Render Postgres so we can see why they return 0 rows in production.
"""
from __future__ import annotations

import os, sys
from dotenv import load_dotenv
import psycopg

load_dotenv()
DB = os.environ.get("RENDER_EXTERNAL_DATABASE_URL") or os.environ.get("DATABASE_URL")
if not DB:
    print("no DB url", file=sys.stderr); sys.exit(1)

CYM = "2026-06"
WS = "allied"
CODE = "109359"

con = psycopg.connect(DB)
cur = con.cursor()

# 1) Find the focal product (LIND BIN 40 MER 21) by name and inspect raw row.
cur.execute("""
    SELECT wholesaler, edition, CAST(upc AS VARCHAR) AS upc, product_name,
           unit_volume, unit_qty,
           frontline_case_price, frontline_unit_price,
           effective_case_price
    FROM cpl_enriched
    WHERE LOWER(wholesaler) = %s
      AND edition = %s
      AND product_name ILIKE '%%LIND%%BIN%%40%%MER%%'
    ORDER BY product_name
""", (WS, CYM))
print("LIND focal candidates:")
for r in cur.fetchall():
    print(" ", r)

# 2) Now query the way _focal_product_for_rip does, using the LTRIM key.
cur.execute("""
    WITH cur_ AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched
                  WHERE edition<=%s GROUP BY wholesaler)
    SELECT c.product_name, c.wholesaler, CAST(c.upc AS VARCHAR) AS upc,
           c.unit_volume, c.unit_qty,
           c.frontline_case_price, c.frontline_unit_price,
           c.effective_case_price
    FROM cpl_enriched c
    JOIN cur_ ON c.wholesaler=cur_.wholesaler AND c.edition=cur_.ed
    WHERE LOWER(c.wholesaler) = LOWER(%s)
      AND LTRIM(CAST(c.upc AS VARCHAR), '0') = %s
    LIMIT 1
""", (CYM, WS, "12354089983"))
print()
print("_focal_product_for_rip(LIND, upc=12354089983):", cur.fetchone())

# 3) Run the same SQL with no LTRIM on cpl side - maybe the cpl stores
#    upc with leading zeros so LTRIM is needed only on rip-side.
cur.execute("""
    SELECT product_name, CAST(upc AS VARCHAR), LTRIM(CAST(upc AS VARCHAR), '0')
    FROM cpl_enriched
    WHERE LOWER(wholesaler) = %s AND edition = %s
      AND product_name ILIKE '%%LIND%%BIN%%40%%MER%%'
""", (WS, CYM))
print()
print("UPC formats stored in cpl_enriched for LIND:")
for r in cur.fetchall():
    print(" ", r)

# 4) Count members of Allied 109359 via the same SQL _full_case_mix uses.
cur.execute("""
    WITH cur_ AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched
                  WHERE edition<=%s GROUP BY wholesaler),
    ripupc AS (
        SELECT DISTINCT wholesaler, LTRIM(CAST(upc AS VARCHAR),'0') AS un
        FROM rip
        WHERE CAST(rip_code AS VARCHAR) = %s
          AND LOWER(wholesaler) = LOWER(%s)
          AND edition = (SELECT MAX(edition) FROM rip
                         WHERE CAST(rip_code AS VARCHAR) = %s
                           AND LOWER(wholesaler) = LOWER(%s)
                           AND edition <= %s)
          AND upc IS NOT NULL
          AND CAST(upc AS VARCHAR) NOT IN ('', '0', 'None', 'nan')
          AND LTRIM(CAST(upc AS VARCHAR),'0') NOT IN ('', 'None', 'nan')
    )
    SELECT COUNT(*), COUNT(DISTINCT c.product_name)
    FROM cpl_enriched c
    JOIN cur_ ON c.wholesaler=cur_.wholesaler AND c.edition=cur_.ed
    JOIN ripupc r ON r.wholesaler=c.wholesaler
                 AND r.un=LTRIM(CAST(c.upc AS VARCHAR), '0')
    WHERE c.upc IS NOT NULL
      AND LTRIM(CAST(c.upc AS VARCHAR), '0') NOT IN ('', 'None', 'nan')
""", (CYM, CODE, WS, CODE, WS, CYM))
print()
print("_full_case_mix(Allied/109359) rows, distinct products:", cur.fetchone())

con.close()
