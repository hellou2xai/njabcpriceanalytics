#!/usr/bin/env python
"""Enrich catalogue products with Go-UPC data + images stored in Cloudflare R2.

For every valid, not-yet-enriched UPC in the pricing catalogue this:
  1. looks the barcode up on Go-UPC,
  2. downloads the product image and uploads it to R2,
  3. upserts the result into the product_enrichment table (keyed by the
     normalised UPC, LTRIM(upc,'0'), so it joins the catalogue).

It is idempotent: reruns only touch UPCs that have no successful row yet (and,
unless --refetch, skip ones already marked not_found/error). Negative results
are cached so a missing barcode is never paid for twice.

Usage:
    python scripts/enrich_products.py --dry-run         # show what would run
    python scripts/enrich_products.py --limit 50        # do 50 (a safe test)
    python scripts/enrich_products.py                   # full backfill
    python scripts/enrich_products.py --refetch error   # retry past failures

Needs GO_UPC_API_KEY and the R2_* env vars set (see backend/goupc.py, r2.py).
Reads pricing from the DuckDB cache (PRICING_SOURCE) and writes to DATABASE_URL.
"""
import argparse
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx

from backend.db import get_duckdb, read_parquet, init_user_db
from backend.pg import get_pg
from backend import goupc, r2

# Mirrors catalog._VALID_UPC_SQL: a real barcode, not all-zeros/nines filler.
VALID_UPC = (
    "upc IS NOT NULL AND upc <> '' AND upc <> '0'"
    " AND NOT regexp_matches(upc, '^(0+|9+|1+)$')"
    " AND NOT upc LIKE '999999%'"
    " AND LENGTH(LTRIM(upc, '0')) >= 8"
)

_EXT = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def catalogue_upcs() -> list[str]:
    """Distinct normalised UPCs in the current catalogue, most-recent first."""
    with get_duckdb() as con:
        src = read_parquet(con, "cpl_enriched")
        rows = con.execute(
            f"SELECT DISTINCT LTRIM(upc, '0') AS upc_norm FROM {src} WHERE {VALID_UPC}"
        ).fetchall()
    return [r[0] for r in rows if r[0]]


def already_done(refetch: str | None) -> set[str]:
    """UPCs we should skip. Always skip status='ok'. Also skip not_found/error
    unless the user asked to refetch that status."""
    skip_statuses = ["ok"]
    if refetch != "all":
        for s in ("not_found", "error"):
            if refetch != s:
                skip_statuses.append(s)
    ph = ", ".join(["%s"] * len(skip_statuses))
    with get_pg() as con:
        rows = con.execute(
            f"SELECT upc FROM product_enrichment WHERE status IN ({ph})", skip_statuses
        ).fetchall()
    return {r["upc"] for r in rows}


def download_image(url: str) -> tuple[bytes, str] | None:
    """Fetch an image URL; return (bytes, content_type) or None if not an image."""
    try:
        r = httpx.get(url, timeout=20, follow_redirects=True)
    except httpx.HTTPError:
        return None
    if r.status_code != 200:
        return None
    ctype = (r.headers.get("content-type") or "").split(";")[0].strip().lower()
    if not ctype.startswith("image/") or not r.content:
        return None
    return r.content, ctype


def upsert(upc: str, *, status: str, data: dict | None = None,
           image_url: str | None = None, image_key: str | None = None):
    import json
    with get_pg() as con:
        con.execute(
            """INSERT INTO product_enrichment
                 (upc, name, brand, category, description, image_url, image_key,
                  attributes, source, status, attempts, fetched_at, updated_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'go-upc',%s,1,%s,%s)
               ON CONFLICT (upc) DO UPDATE SET
                 name=EXCLUDED.name, brand=EXCLUDED.brand, category=EXCLUDED.category,
                 description=EXCLUDED.description,
                 image_url=COALESCE(EXCLUDED.image_url, product_enrichment.image_url),
                 image_key=COALESCE(EXCLUDED.image_key, product_enrichment.image_key),
                 attributes=EXCLUDED.attributes, status=EXCLUDED.status,
                 attempts=product_enrichment.attempts + 1,
                 fetched_at=EXCLUDED.fetched_at, updated_at=EXCLUDED.updated_at""",
            (
                upc,
                (data or {}).get("name"), (data or {}).get("brand"),
                (data or {}).get("category"), (data or {}).get("description"),
                image_url, image_key,
                json.dumps((data or {}).get("attributes")) if data and data.get("attributes") else None,
                status, _now(), _now(),
            ),
        )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="Max UPCs to process (0 = all)")
    ap.add_argument("--dry-run", action="store_true", help="Show the work, call nothing")
    ap.add_argument("--refetch", choices=["not_found", "error", "all"], default=None,
                    help="Also re-process UPCs previously in this state")
    ap.add_argument("--sleep", type=float, default=0.5, help="Seconds between Go-UPC calls")
    args = ap.parse_args()

    init_user_db()  # ensure product_enrichment exists (idempotent; cron-safe)
    all_upcs = catalogue_upcs()
    skip = already_done(args.refetch)
    todo = [u for u in all_upcs if u not in skip]
    if args.limit:
        todo = todo[: args.limit]

    print(f"Catalogue UPCs: {len(all_upcs)} | already handled: {len(skip)} | to process: {len(todo)}")
    if args.dry_run:
        for u in todo[:20]:
            print(f"  would enrich: {u}")
        if len(todo) > 20:
            print(f"  ... and {len(todo) - 20} more")
        return

    if not goupc.GO_UPC_ENABLED:
        print("ERROR: GO_UPC_API_KEY is not set. Aborting.")
        sys.exit(1)
    if not r2.R2_ENABLED:
        print("WARNING: R2 is not configured; product data will be saved without images.")

    ok = missing = errors = images = 0
    for i, upc in enumerate(todo, 1):
        try:
            result = goupc.lookup(upc)
        except goupc.GoUpcError as e:
            print(f"[{i}/{len(todo)}] {upc}: error: {e}")
            upsert(upc, status="error")
            errors += 1
            time.sleep(min(args.sleep * 4, 5))  # back off on errors
            continue

        if result is None:
            upsert(upc, status="not_found")
            missing += 1
            time.sleep(args.sleep)
            continue

        image_url = image_key = None
        if r2.R2_ENABLED and result.get("image_url"):
            dl = download_image(result["image_url"])
            if dl:
                content, ctype = dl
                ext = _EXT.get(ctype, "jpg")
                key = f"products/{upc}.{ext}"
                try:
                    image_url = r2.upload_bytes(key, content, ctype)
                    image_key = key
                    images += 1
                except Exception as e:  # noqa: BLE001 - keep going, save the text
                    print(f"[{i}/{len(todo)}] {upc}: R2 upload failed: {e}")

        upsert(upc, status="ok", data=result, image_url=image_url, image_key=image_key)
        ok += 1
        if i % 25 == 0:
            print(f"[{i}/{len(todo)}] ok={ok} missing={missing} errors={errors} images={images}")
        time.sleep(args.sleep)

    print(f"Done. ok={ok} not_found={missing} errors={errors} images_uploaded={images}")


if __name__ == "__main__":
    main()
