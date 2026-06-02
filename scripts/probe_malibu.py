"""Why didn't the RIP template fire for 'rip mix for malibu pink 1.75 l'?

Replays the term-extraction + the exact match query _t_rip_lookup runs,
against Render so we can see step by step what the assistant actually
gets back. If matched_products comes back empty (or rip_codes does),
the template legitimately can't render — and we know to widen the
match logic.
"""
from __future__ import annotations

import os, re, sys
from dotenv import load_dotenv
import psycopg

load_dotenv()
DB = os.environ.get("RENDER_EXTERNAL_DATABASE_URL") or os.environ.get("DATABASE_URL")
if not DB:
    print("no DB url", file=sys.stderr); sys.exit(1)

CYM = "2026-06"
QUESTION = "rip mix for malibu pink 1.75 l"

# Step 1: term extraction (copy of the assistant's regex chain).
m = re.search(r"\b(?:for|of|about|on)\s+(.+)$", QUESTION, re.I)
term = (m.group(1) if m else "").strip()
print(f"raw term:        {term!r}")
term = re.sub(r"\b(rip|rebate|details?|analysis|code|tiers?|mix|bottle|prices?)\b",
              " ", term, flags=re.I).strip()
term = re.sub(r"\s+", " ", term)
print(f"stripped term:   {term!r}")

# Step 2: tokenise (same as _t_rip_lookup) and build a name+brand LIKE clause.
tokens = [t for t in re.split(r"\s+", term) if t]
print(f"tokens:          {tokens}")

con = psycopg.connect(DB)
cur = con.cursor()

# Replay the matching query _t_rip_lookup runs (current edition per
# wholesaler, name OR brand LIKE for each token, all ANDed).
where = ["1=1"]
params: list = []
for t in tokens:
    where.append("(UPPER(product_name) LIKE UPPER(%s) OR UPPER(COALESCE(brand,'')) LIKE UPPER(%s))")
    params.extend([f"%{t}%", f"%{t}%"])
where_sql = " AND ".join(where)

cur.execute(
    f"""
    WITH cur AS (SELECT wholesaler, MAX(edition) ed FROM cpl_enriched
                 WHERE edition <= %s GROUP BY wholesaler)
    SELECT c.wholesaler, c.product_name, c.unit_volume, CAST(c.upc AS VARCHAR) AS upc,
           CAST(c.rip_code AS VARCHAR) AS cpl_rip
    FROM cpl_enriched c JOIN cur ON c.wholesaler=cur.wholesaler AND c.edition=cur.ed
    WHERE {where_sql}
    ORDER BY c.product_name
    LIMIT 50
    """,
    (CYM, *params),
)
rows = cur.fetchall()
print()
print(f"matched products: {len(rows)}")
for r in rows[:15]:
    print(" ", r)
if not rows:
    print("  (none)")

# Step 3: for the matched products, fetch the rip_codes via the rip table
# (the second join _t_rip_lookup does).
if rows:
    keys = sorted({(r[0], (str(r[3]) or '').lstrip('0')) for r in rows
                   if (str(r[3]) or '').lstrip('0')})
    print()
    print(f"unique (wholesaler, upc) pairs: {len(keys)}")
    rip_count = 0
    for ws, un in keys[:5]:
        cur.execute(
            """
            WITH cur AS (SELECT wholesaler, MAX(edition) ed FROM rip
                         WHERE edition <= %s GROUP BY wholesaler)
            SELECT DISTINCT CAST(rp.rip_code AS VARCHAR) AS rip_code
            FROM rip rp JOIN cur ON rp.wholesaler=cur.wholesaler AND rp.edition=cur.ed
            WHERE rp.wholesaler = %s
              AND LTRIM(CAST(rp.upc AS VARCHAR), '0') = %s
              AND CAST(rp.rip_code AS VARCHAR) NOT IN ('', '0', 'None', 'nan')
            """,
            (CYM, ws, un),
        )
        codes = [r[0] for r in cur.fetchall()]
        rip_count += len(codes)
        print(f"  {ws} / {un}: codes = {codes}")
    print(f"total rip codes surfaced for sampled pairs: {rip_count}")

con.close()
