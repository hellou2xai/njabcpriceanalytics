"""What is the all-zeros UPC row in Allied / 112074 actually?

Hypothesis: it's a duplicate of a brand_registration that ALREADY has
a real UPC row in the same cluster, so filtering it doesn't lose any
real product. Test by listing every (brand_registration, upc) pair
under 112074 and flagging cases where a brand has BOTH a real and a
zero UPC.

If a brand_registration has ONLY zero-UPC rows (no real UPC anywhere),
that's a genuine product we'd lose — the user's concern.
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

# What columns does the rip table actually have?
cur.execute("SELECT column_name FROM information_schema.columns WHERE table_name = 'rip' ORDER BY ordinal_position")
cols = [r[0] for r in cur.fetchall()]
print("rip columns:", cols)
print()

# Show the per-(brand, upc) row count for the cluster.
br_col = "brand_reg_no" if "brand_reg_no" in cols else (
    "brand_registration" if "brand_registration" in cols else None)
if br_col is None:
    print("no brand_registration column - cannot test the hypothesis")
    sys.exit(0)

cur.execute(
    f"""
    SELECT {br_col} AS brand,
           CAST(upc AS VARCHAR) AS upc,
           COUNT(*) AS rows_
    FROM rip
    WHERE wholesaler = %s AND CAST(rip_code AS VARCHAR) = %s
      AND edition = (SELECT MAX(edition) FROM rip WHERE wholesaler = %s)
    GROUP BY 1, 2 ORDER BY 1, 2
    """,
    (WS, CODE, WS),
)
rows = cur.fetchall()
print(f"--- {WS} / {CODE} : per-(brand, upc) row counts ---")
print(f"{'brand':<10} {'upc':<16} {'rows':>5}")
brand_upcs: dict = {}
for b, u, n in rows:
    print(f"{(b or ''):<10} {(u or ''):<16} {n:>5}")
    brand_upcs.setdefault(str(b), []).append(str(u))

print()
print("--- brands with BOTH real and zero UPC ---")
for b, us in brand_upcs.items():
    has_zero = any(u in ('', '0', '000000000000', 'None', 'nan') or set(u) == {'0'} for u in us)
    has_real = any(not (u in ('', '0', 'None', 'nan') or set(u) == {'0'}) for u in us)
    if has_zero and has_real:
        print(f"  {b}: {us}  (zero is a DUPLICATE - filtering loses nothing)")
    elif has_zero and not has_real:
        print(f"  {b}: {us}  (ONLY zero - filtering DROPS a real product!)")

con.close()
