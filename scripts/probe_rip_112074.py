"""Diagnostic for RIP code 112074 on Render. After the new rule
('same UPC + different vintage = different item'), the canonical Case-Mix
size = COUNT(DISTINCT (upc, vintage, unit_volume, unit_qty)) from
cpl_enriched, joined to the RIP cluster's UPCs.

Expect this to print ~22 for allied/2026-06/112074 - the same number the
catalog page shows for the cluster.
"""
from __future__ import annotations

import os, sys
from dotenv import load_dotenv
import psycopg

load_dotenv()
DB = os.environ.get("RENDER_EXTERNAL_DATABASE_URL") or os.environ.get("DATABASE_URL")
if not DB:
    print("no DB url in env", file=sys.stderr); sys.exit(1)

CODE = "112074"
WS = "allied"

con = psycopg.connect(DB)
cur = con.cursor()

cur.execute("SELECT MAX(edition) FROM rip WHERE wholesaler = %s", (WS,))
rip_ed = cur.fetchone()[0]
cur.execute("SELECT MAX(edition) FROM cpl_enriched WHERE wholesaler = %s", (WS,))
cpl_ed = cur.fetchone()[0]
print(f"editions: rip={rip_ed}  cpl_enriched={cpl_ed}")

# OLD count: distinct UPCs in rip
cur.execute(
    """
    SELECT COUNT(DISTINCT CAST(upc AS VARCHAR))
    FROM rip
    WHERE wholesaler = %s AND CAST(rip_code AS VARCHAR) = %s AND edition = %s
      AND upc IS NOT NULL AND CAST(upc AS VARCHAR) NOT IN ('', '0', 'None', 'nan')
    """,
    (WS, CODE, rip_ed),
)
old_count = cur.fetchone()[0]
print(f"OLD: distinct UPCs in rip = {old_count}")

# NEW count: distinct (upc, vintage, unit_volume, unit_qty) in cpl_enriched
cur.execute(
    """
    WITH ripupc AS (
        SELECT DISTINCT LTRIM(CAST(upc AS VARCHAR), '0') AS un
        FROM rip
        WHERE wholesaler = %s AND CAST(rip_code AS VARCHAR) = %s AND edition = %s
          AND upc IS NOT NULL AND CAST(upc AS VARCHAR) NOT IN ('', '0', 'None', 'nan')
    )
    SELECT COUNT(DISTINCT (
        LTRIM(CAST(c.upc AS VARCHAR), '0'),
        COALESCE(CAST(c.vintage AS VARCHAR), ''),
        COALESCE(c.unit_volume, ''),
        COALESCE(CAST(c.unit_qty AS VARCHAR), '')
    ))
    FROM cpl_enriched c JOIN ripupc r ON LTRIM(CAST(c.upc AS VARCHAR), '0') = r.un
    WHERE c.wholesaler = %s AND c.edition = %s
    """,
    (WS, CODE, rip_ed, WS, cpl_ed),
)
new_count = cur.fetchone()[0]
print(f"NEW: distinct SKUs in cpl_enriched = {new_count}")

# Show the per-UPC vintage breakdown so we can see WHY the count is higher.
cur.execute(
    """
    WITH ripupc AS (
        SELECT DISTINCT LTRIM(CAST(upc AS VARCHAR), '0') AS un
        FROM rip
        WHERE wholesaler = %s AND CAST(rip_code AS VARCHAR) = %s AND edition = %s
          AND upc IS NOT NULL AND CAST(upc AS VARCHAR) NOT IN ('', '0', 'None', 'nan')
    )
    SELECT LTRIM(CAST(c.upc AS VARCHAR), '0') AS upc_n,
           COUNT(DISTINCT (
             COALESCE(CAST(c.vintage AS VARCHAR), ''),
             COALESCE(c.unit_volume, ''),
             COALESCE(CAST(c.unit_qty AS VARCHAR), '')
           )) AS skus,
           STRING_AGG(DISTINCT COALESCE(CAST(c.vintage AS VARCHAR), '-'), ',' ORDER BY COALESCE(CAST(c.vintage AS VARCHAR), '-')) AS vintages
    FROM cpl_enriched c JOIN ripupc r ON LTRIM(CAST(c.upc AS VARCHAR), '0') = r.un
    WHERE c.wholesaler = %s AND c.edition = %s
    GROUP BY upc_n ORDER BY skus DESC, upc_n
    """,
    (WS, CODE, rip_ed, WS, cpl_ed),
)
print()
print("per-UPC SKU breakdown:")
print(f"  {'UPC':<14} {'skus':>5}  vintages")
for upc_n, skus, vins in cur.fetchall():
    print(f"  {upc_n:<14} {skus:>5}  {vins}")

con.close()
