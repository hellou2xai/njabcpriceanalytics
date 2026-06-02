"""Why is the Frontline Case Cost row missing for LIND BIN 40 MER 21 750ML?
Check what discount_n_qty / discount_n_amt the cpl_enriched row carries —
if no slot has qty==1, my template skips the row by design.
"""
from __future__ import annotations

import os, sys
from dotenv import load_dotenv
import psycopg

load_dotenv()
DB = os.environ.get("RENDER_EXTERNAL_DATABASE_URL") or os.environ.get("DATABASE_URL")
if not DB:
    print("no DB url", file=sys.stderr); sys.exit(1)

con = psycopg.connect(DB)
cur = con.cursor()

cur.execute("""
    SELECT product_name, unit_volume, unit_qty,
           frontline_case_price, frontline_unit_price, effective_case_price,
           discount_1_qty, discount_1_amt,
           discount_2_qty, discount_2_amt,
           discount_3_qty, discount_3_amt,
           discount_4_qty, discount_4_amt,
           discount_5_qty, discount_5_amt
    FROM cpl_enriched
    WHERE LOWER(wholesaler) = 'allied'
      AND edition = '2026-06'
      AND product_name = 'LIND BIN 40 MER 21'
    ORDER BY unit_volume
""")
print(f"{'product':<20} {'size':<8} {'uq':<4} {'fl_cs':>7} {'fl_btl':>7} {'eff_cs':>7}  tiers")
for r in cur.fetchall():
    pn, vol, uq, fc, fb, ec = r[0], r[1], r[2], r[3], r[4], r[5]
    tiers = []
    for i in (6, 8, 10, 12, 14):
        q, a = r[i], r[i + 1]
        if q is not None and a is not None and a != 0:
            tiers.append(f"{q}cs=${a}")
    print(f"{pn:<20} {vol or '-':<8} {str(uq):<4} ${fc:>6} ${fb:>6} ${ec:>6}  {', '.join(tiers)}")

con.close()
