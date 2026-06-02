"""Narrow the failing query token by token until the result stops being
empty. Whatever token is the culprit is the one I need to handle better
in the assistant's term extraction (probably either '1.75' or the bare
'l' isn't being matched the way I assumed)."""
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


def count(tokens: list[str]) -> int:
    where = []
    params: list = []
    for t in tokens:
        where.append("(UPPER(product_name) LIKE UPPER(%s) OR UPPER(COALESCE(brand,'')) LIKE UPPER(%s))")
        params.extend([f"%{t}%", f"%{t}%"])
    sql = (
        "WITH cur AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched "
        "             WHERE edition<=%s GROUP BY wholesaler) "
        "SELECT COUNT(*) FROM cpl_enriched c "
        "JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed "
        f"WHERE {' AND '.join(where) or '1=1'}"
    )
    cur.execute(sql, (CYM, *params))
    return cur.fetchone()[0]


for tokens in (
    ["malibu"],
    ["malibu", "pink"],
    ["malibu", "pink", "1.75"],
    ["malibu", "pink", "1.75", "l"],
    ["malibu", "pink", "1.75l"],
    ["malibu", "pink", "1.75L"],
):
    print(f"  tokens {tokens}: {count(tokens)} matches")

# Show what MALIBU PINK rows look like.
cur.execute(
    """
    WITH cur AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched
                 WHERE edition<=%s GROUP BY wholesaler)
    SELECT c.wholesaler, c.product_name, c.unit_volume, CAST(c.upc AS VARCHAR)
    FROM cpl_enriched c JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed
    WHERE UPPER(product_name) LIKE '%MALIBU PINK%'
    ORDER BY c.product_name
    """,
    (CYM,),
)
print()
print("MALIBU PINK rows:")
for r in cur.fetchall():
    print(" ", r)

con.close()
