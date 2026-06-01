"""Confirm the bleed fix. With NO UPC filter on ripupc, the all-zeros UPC
in the RIP sheet joins to every blank-UPC product in cpl_enriched and
the cluster count + sample explode (AI showed 137 with HESS / BROKEN /
COWBOY etc).

With the filter on, the cluster collapses back to the 21 SKU count we
computed earlier, and the sample is JOSH-only.
"""
from __future__ import annotations

import os, sys
from dotenv import load_dotenv
import psycopg

load_dotenv()
DB = os.environ.get("RENDER_EXTERNAL_DATABASE_URL") or os.environ.get("DATABASE_URL")
if not DB:
    print("no DB url in env", file=sys.stderr); sys.exit(1)

WS, CODE = "allied", "112074"
con = psycopg.connect(DB)
cur = con.cursor()

cur.execute("SELECT MAX(edition) FROM rip WHERE wholesaler = %s", (WS,))
rip_ed = cur.fetchone()[0]
cur.execute("SELECT MAX(edition) FROM cpl_enriched WHERE wholesaler = %s", (WS,))
cpl_ed = cur.fetchone()[0]

# OLD (buggy) count: no UPC filter on ripupc.
cur.execute(
    """
    WITH ripupc AS (
        SELECT DISTINCT LTRIM(CAST(upc AS VARCHAR), '0') AS un
        FROM rip WHERE wholesaler = %s AND CAST(rip_code AS VARCHAR) = %s AND edition = %s
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
print(f"OLD (no UPC filter): {cur.fetchone()[0]}")

# NEW count: UPC filter on BOTH ripupc and cpl side.
cur.execute(
    """
    WITH ripupc AS (
        SELECT DISTINCT LTRIM(CAST(upc AS VARCHAR), '0') AS un
        FROM rip WHERE wholesaler = %s AND CAST(rip_code AS VARCHAR) = %s AND edition = %s
          AND upc IS NOT NULL
          AND CAST(upc AS VARCHAR) NOT IN ('', '0', 'None', 'nan')
          AND LTRIM(CAST(upc AS VARCHAR), '0') NOT IN ('', 'None', 'nan')
    )
    SELECT COUNT(DISTINCT (
        LTRIM(CAST(c.upc AS VARCHAR), '0'),
        COALESCE(CAST(c.vintage AS VARCHAR), ''),
        COALESCE(c.unit_volume, ''),
        COALESCE(CAST(c.unit_qty AS VARCHAR), '')
    ))
    FROM cpl_enriched c JOIN ripupc r ON LTRIM(CAST(c.upc AS VARCHAR), '0') = r.un
    WHERE c.wholesaler = %s AND c.edition = %s
      AND c.upc IS NOT NULL
      AND LTRIM(CAST(c.upc AS VARCHAR), '0') NOT IN ('', 'None', 'nan')
    """,
    (WS, CODE, rip_ed, WS, cpl_ed),
)
print(f"NEW (with UPC filter): {cur.fetchone()[0]}")

# NEW sample - confirm it's JOSH-only.
cur.execute(
    """
    WITH ripupc AS (
        SELECT DISTINCT LTRIM(CAST(upc AS VARCHAR), '0') AS un
        FROM rip WHERE wholesaler = %s AND CAST(rip_code AS VARCHAR) = %s AND edition = %s
          AND upc IS NOT NULL
          AND CAST(upc AS VARCHAR) NOT IN ('', '0', 'None', 'nan')
          AND LTRIM(CAST(upc AS VARCHAR), '0') NOT IN ('', 'None', 'nan')
    )
    SELECT DISTINCT c.product_name, c.unit_volume, c.vintage
    FROM cpl_enriched c JOIN ripupc r ON LTRIM(CAST(c.upc AS VARCHAR), '0') = r.un
    WHERE c.wholesaler = %s AND c.edition = %s
      AND c.upc IS NOT NULL
      AND LTRIM(CAST(c.upc AS VARCHAR), '0') NOT IN ('', 'None', 'nan')
    ORDER BY c.product_name
    """,
    (WS, CODE, rip_ed, WS, cpl_ed),
)
print()
print("NEW sample (full member list, no LIMIT):")
for name, vol, vin in cur.fetchall():
    print(f"  {name!s:<40} {vol or '-':<8} {vin or '-'}")

con.close()
