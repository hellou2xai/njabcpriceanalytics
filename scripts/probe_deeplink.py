"""Replay the catalog's rip_code EXISTS filter against Render to see how
many UPCs land in each cluster the assistant deep-linked to."""
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

cases = [
    ("fedway", "10209"),
    ("allied", "112256"),
    ("allied", "110846"),
    ("allied", "112111"),
    ("fedway", "50017"),
    ("fedway", "50019"),
    ("fedway", "10209 50017"),
    ("fedway", "10209 50019"),
]

for ws, code in cases:
    # The catalog's new rip_code filter, applied to cpl_enriched.
    cur.execute(
        """
        WITH cpl_cur AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched
                         WHERE edition <= %s GROUP BY wholesaler)
        SELECT COUNT(DISTINCT LTRIM(CAST(c.upc AS VARCHAR), '0'))
        FROM cpl_enriched c JOIN cpl_cur ON c.wholesaler=cpl_cur.wholesaler AND c.edition=cpl_cur.ed
        WHERE LOWER(c.wholesaler) = LOWER(%s)
          AND EXISTS (
            SELECT 1 FROM rip _r
            WHERE _r.wholesaler = c.wholesaler
              AND CAST(_r.rip_code AS VARCHAR) = %s
              AND LTRIM(CAST(_r.upc AS VARCHAR), '0')
                  = LTRIM(CAST(c.upc AS VARCHAR), '0')
              AND _r.upc IS NOT NULL
              AND CAST(_r.upc AS VARCHAR) NOT IN ('', '0', 'None', 'nan')
              AND LTRIM(CAST(_r.upc AS VARCHAR), '0') NOT IN ('', 'None', 'nan')
              AND _r.edition = (
                  SELECT MAX(_r2.edition) FROM rip _r2
                  WHERE _r2.wholesaler = _r.wholesaler
                    AND CAST(_r2.rip_code AS VARCHAR) = %s
                    AND _r2.edition <= %s
              )
          )
        """,
        (CYM, ws, code, code, CYM),
    )
    n = cur.fetchone()[0]
    print(f"  {ws:8} / {code:20}: catalog filter -> {n} distinct UPCs")

con.close()
