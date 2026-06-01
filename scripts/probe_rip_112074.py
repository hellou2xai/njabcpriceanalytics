"""One-shot diagnostic: cluster size of RIP code 112074 on Render."""
from __future__ import annotations

import os, sys
from dotenv import load_dotenv
import psycopg

load_dotenv()
DB = os.environ.get("RENDER_EXTERNAL_DATABASE_URL") or os.environ.get("DATABASE_URL")
if not DB:
    print("no DB url in env", file=sys.stderr); sys.exit(1)

CODE = "112074"

con = psycopg.connect(DB)
cur = con.cursor()

# 0. Sanity - what wholesalers / editions are in rip?
cur.execute("SELECT DISTINCT wholesaler FROM rip ORDER BY 1")
print("wholesalers in rip:", [r[0] for r in cur.fetchall()])
cur.execute("SELECT wholesaler, MAX(edition) FROM rip GROUP BY 1")
for w, e in cur.fetchall():
    print(f"  latest rip edition for {w}: {e}")

# Find every (wholesaler, edition) where this code appears.
cur.execute(
    """
    SELECT wholesaler, edition,
           COUNT(*) AS rows_,
           COUNT(DISTINCT CAST(upc AS VARCHAR)) AS distinct_upcs,
           COUNT(DISTINCT CAST(upc AS VARCHAR)) FILTER (
             WHERE upc IS NOT NULL AND CAST(upc AS VARCHAR) NOT IN ('', '0', 'None', 'nan')
           ) AS filtered_distinct_upcs
    FROM rip
    WHERE CAST(rip_code AS VARCHAR) = %s
    GROUP BY 1, 2 ORDER BY 1, 2 DESC
    """,
    (CODE,),
)
print()
print(f"--- presence of RIP code {CODE} across (wholesaler, edition) ---")
print(f"{'wholesaler':<20} {'edition':<10} {'rows':>6} {'dist_upcs':>10} {'after_filter':>14}")
rows = cur.fetchall()
for w, e, n, d, f in rows:
    print(f"{(w or ''):<20} {(e or ''):<10} {n:>6} {d:>10} {f:>14}")

if not rows:
    print("code not found at all"); con.close(); sys.exit(0)

# Pick the most recent (wholesaler, edition) with the most distinct UPCs.
target = max(rows, key=lambda r: (r[1] or "", r[4] or 0))
WS, ED = target[0], target[1]
print()
print(f"=== probing {WS} / edition {ED} ===")

# How many of those UPCs JOIN to cpl_enriched in any edition?
cur.execute(
    """
    SELECT DISTINCT LTRIM(CAST(upc AS VARCHAR), '0') AS un
    FROM rip
    WHERE wholesaler = %s AND CAST(rip_code AS VARCHAR) = %s AND edition = %s
      AND upc IS NOT NULL AND CAST(upc AS VARCHAR) NOT IN ('', '0', 'None', 'nan')
    """,
    (WS, CODE, ED),
)
rip_upcs = [r[0] for r in cur.fetchall() if r[0]]
print(f"distinct UPCs in rip for {WS}/{ED}/{CODE}: {len(rip_upcs)}")

cur.execute("SELECT MAX(edition) FROM cpl_enriched WHERE wholesaler = %s", (WS,))
latest_cpl_ed = cur.fetchone()[0]
print(f"latest cpl_enriched edition for {WS}: {latest_cpl_ed}")

if rip_upcs:
    cur.execute(
        """
        SELECT COUNT(DISTINCT LTRIM(CAST(upc AS VARCHAR), '0'))
        FROM cpl_enriched
        WHERE wholesaler = %s AND edition = %s
          AND LTRIM(CAST(upc AS VARCHAR), '0') = ANY(%s)
        """,
        (WS, latest_cpl_ed, rip_upcs),
    )
    cat_n = cur.fetchone()[0]
    print(f"of those, how many JOIN cpl_enriched {WS}/{latest_cpl_ed}: {cat_n}")

    # Which ones are MISSING from cpl_enriched.
    cur.execute(
        """
        SELECT DISTINCT LTRIM(CAST(upc AS VARCHAR), '0')
        FROM cpl_enriched
        WHERE wholesaler = %s AND edition = %s
        """,
        (WS, latest_cpl_ed),
    )
    cpl_set = {r[0] for r in cur.fetchall()}
    missing = [u for u in rip_upcs if u not in cpl_set]
    print(f"UPCs on the RIP sheet but NOT in {WS} CPL for {latest_cpl_ed}: {len(missing)}")
    print(f"sample missing: {missing[:20]}")

con.close()
