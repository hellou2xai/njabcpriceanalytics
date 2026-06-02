"""Smoke-test the SQL used by _t_rip_summary against Render Postgres so we know
the by-distributor roll-up returns plausible totals (and that JOSH 112074 still
reads as 21 SKUs, matching the catalog page)."""
from __future__ import annotations

import os, sys
from dotenv import load_dotenv
import psycopg

load_dotenv()
DB = os.environ.get("RENDER_EXTERNAL_DATABASE_URL") or os.environ.get("DATABASE_URL")
if not DB:
    print("no DB url in env", file=sys.stderr); sys.exit(1)

CYM = "2026-06"

con = psycopg.connect(DB)
cur = con.cursor()

cur.execute(
    """
    WITH cpl_cur AS (
        SELECT wholesaler, MAX(edition) ed FROM cpl_enriched
        WHERE edition <= %s GROUP BY wholesaler
    ),
    rip_cur AS (
        SELECT wholesaler, MAX(edition) ed FROM rip
        WHERE edition <= %s GROUP BY wholesaler
    ),
    rip_set AS (
        SELECT r.wholesaler,
               CAST(r.rip_code AS VARCHAR) AS rip_code,
               LTRIM(CAST(r.upc AS VARCHAR), '0') AS upc_n
        FROM rip r JOIN rip_cur rc ON r.wholesaler=rc.wholesaler AND r.edition=rc.ed
        WHERE r.upc IS NOT NULL
          AND CAST(r.upc AS VARCHAR) NOT IN ('', '0', 'None', 'nan')
          AND LTRIM(CAST(r.upc AS VARCHAR), '0') NOT IN ('', 'None', 'nan')
          AND r.rip_code IS NOT NULL
          AND CAST(r.rip_code AS VARCHAR) NOT IN ('', '0', 'None', 'nan')
    )
    SELECT rs.wholesaler, rs.rip_code,
           COUNT(DISTINCT (LTRIM(CAST(c.upc AS VARCHAR),'0'),
                           COALESCE(CAST(c.vintage AS VARCHAR),''),
                           COALESCE(c.unit_volume,''),
                           COALESCE(CAST(c.unit_qty AS VARCHAR),''))) AS member_count
    FROM rip_set rs
    JOIN cpl_cur cc ON cc.wholesaler = rs.wholesaler
    JOIN cpl_enriched c ON c.wholesaler = cc.wholesaler AND c.edition = cc.ed
                       AND LTRIM(CAST(c.upc AS VARCHAR),'0') = rs.upc_n
    WHERE c.upc IS NOT NULL
      AND LTRIM(CAST(c.upc AS VARCHAR),'0') NOT IN ('', 'None', 'nan')
    GROUP BY rs.wholesaler, rs.rip_code
    ORDER BY rs.wholesaler, member_count DESC, rs.rip_code
    """,
    (CYM, CYM),
)
rows = cur.fetchall()

by = {}
for ws, code, n in rows:
    by.setdefault(ws, []).append((code, n))

for ws in sorted(by.keys()):
    print(f"\n=== {ws} ({len(by[ws])} codes) ===")
    print(f"{'code':<10} {'items':>6}")
    for code, n in by[ws][:10]:
        print(f"{code:<10} {n:>6}")
    if len(by[ws]) > 10:
        print(f"...and {len(by[ws]) - 10} more")

# Spot-check the JOSH cluster we've been tracking.
js = next((n for code, n in by.get("allied", []) if code == "112074"), None)
print()
print(f"sanity: allied / 112074 = {js} (expect 21)")

con.close()
