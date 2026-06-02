"""Confirm the fix: with unit_volume added to the per-token OR,
'malibu pink 1.75 l' now matches the right products."""
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

tokens = ["malibu", "pink", "1.75", "l"]
where = []
params: list = []
for t in tokens:
    where.append(
        "(UPPER(product_name) LIKE UPPER(%s) "
        "OR UPPER(COALESCE(brand,'')) LIKE UPPER(%s) "
        "OR UPPER(COALESCE(unit_volume,'')) LIKE UPPER(%s))"
    )
    params.extend([f"%{t}%"] * 3)

cur.execute(
    "WITH cur AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched "
    "             WHERE edition <= %s GROUP BY wholesaler) "
    "SELECT c.wholesaler, c.product_name, c.unit_volume, CAST(c.upc AS VARCHAR), "
    "       CAST(c.rip_code AS VARCHAR) "
    "FROM cpl_enriched c JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed "
    f"WHERE {' AND '.join(where)} ORDER BY c.product_name LIMIT 15",
    (CYM, *params),
)
rows = cur.fetchall()
print(f"with unit_volume in the OR: {len(rows)} matches")
for r in rows:
    print(" ", r)
con.close()
