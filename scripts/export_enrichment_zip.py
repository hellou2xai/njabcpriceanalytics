#!/usr/bin/env python
"""Export enriched products to a local zip for inspection: the product images
plus a manifest (CSV) and a full JSON dump of every field.

Usage:
    python scripts/export_enrichment_zip.py                 # all 'ok' rows
    python scripts/export_enrichment_zip.py --limit 5
    python scripts/export_enrichment_zip.py --out C:\\path\\goupc_test.zip
"""
import argparse
import csv
import io
import json
import os
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv
load_dotenv(str(Path(__file__).resolve().parent.parent / ".env"))

import httpx
from backend.pg import get_pg

COLS = ["upc", "name", "brand", "category", "category_path", "description",
        "region", "specs", "ean", "code_type", "barcode_url", "inferred",
        "image_url", "image_key"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="Max rows (0 = all)")
    ap.add_argument("--out", default=None, help="Output zip path")
    args = ap.parse_args()

    out = args.out or str(Path(__file__).resolve().parent.parent / "goupc_test_5.zip")

    sql = (f"SELECT {','.join(COLS)} FROM product_enrichment "
           "WHERE status = 'ok' ORDER BY upc")
    if args.limit:
        sql += f" LIMIT {int(args.limit)}"
    with get_pg() as con:
        rows = [dict(r) for r in con.execute(sql).fetchall()]

    man = io.StringIO()
    w = csv.writer(man)
    w.writerow(["upc", "name", "brand", "category", "category_path", "description",
                "region", "specs", "ean", "code_type", "inferred", "image_file",
                "image_url", "dl_status", "bytes"])

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for r in rows:
            fname = (r["image_key"] or "").split("/")[-1] or f"{r['upc']}.jpg"
            status = ""
            nbytes = ""
            if r["image_url"]:
                try:
                    resp = httpx.get(r["image_url"], timeout=30, follow_redirects=True)
                    status = resp.status_code
                    if resp.status_code == 200 and resp.content:
                        nbytes = len(resp.content)
                        z.writestr(f"images/{fname}", resp.content)
                except Exception as e:  # noqa: BLE001
                    status = f"ERR {type(e).__name__}"
            cp = " > ".join(json.loads(r["category_path"])) if r["category_path"] else ""
            w.writerow([r["upc"], r["name"], r["brand"], r["category"], cp,
                        r["description"], r["region"], r["specs"] or "", r["ean"],
                        r["code_type"], r["inferred"], fname, r["image_url"],
                        status, nbytes])
            print(f"  {r['upc']}  {status}  {nbytes}B  {r['name']}")
        z.writestr("manifest.csv", man.getvalue())
        z.writestr("rows_full.json", json.dumps(rows, indent=2))

    print("---")
    print(f"ZIP: {os.path.abspath(out)}  ({os.path.getsize(out)} bytes, {len(rows)} products)")


if __name__ == "__main__":
    main()
