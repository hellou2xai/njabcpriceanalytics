#!/usr/bin/env python
"""Re-derive the flat product_enrichment columns from each row's stored raw
Go-UPC `attributes` payload, without calling Go-UPC again.

Run this after adding new enrichment columns so existing rows get backfilled.
Because the full payload is kept in `attributes`, growing the schema never means
paying Go-UPC a second time (one call per UPC, ever).

Usage:
    python scripts/reparse_enrichment.py            # all enriched rows
    python scripts/reparse_enrichment.py --limit 5  # just a few
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.db import init_user_db
from backend.pg import get_pg
from backend import goupc


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="Max rows to reparse (0 = all)")
    args = ap.parse_args()

    init_user_db()  # apply any new columns (idempotent)

    sql = ("SELECT upc, attributes, image_url FROM product_enrichment "
           "WHERE attributes IS NOT NULL AND status = 'ok' ORDER BY upc")
    if args.limit:
        sql += f" LIMIT {int(args.limit)}"

    updated = skipped = 0
    with get_pg() as con:
        rows = [dict(r) for r in con.execute(sql).fetchall()]
        for r in rows:
            try:
                payload = json.loads(r["attributes"])
            except (TypeError, ValueError):
                skipped += 1
                continue
            d = goupc.normalise(payload)
            if not d:
                skipped += 1
                continue
            image_source = "go-upc" if r.get("image_url") else None
            con.execute(
                """UPDATE product_enrichment SET
                     name=%s, brand=%s, category=%s, category_path=%s,
                     description=%s, region=%s, specs=%s, ean=%s,
                     code_type=%s, barcode_url=%s, inferred=%s, image_source=%s
                   WHERE upc=%s""",
                (
                    d.get("name"), d.get("brand"), d.get("category"),
                    json.dumps(d["category_path"]) if d.get("category_path") else None,
                    d.get("description"), d.get("region"),
                    json.dumps(d["specs"]) if d.get("specs") else None,
                    d.get("ean"), d.get("code_type"), d.get("barcode_url"),
                    1 if d.get("inferred") else 0, image_source,
                    r["upc"],
                ),
            )
            updated += 1

    print(f"Reparsed {updated} row(s); skipped {skipped}.")


if __name__ == "__main__":
    main()
