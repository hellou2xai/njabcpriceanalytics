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
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Canonical core lives in backend/enrich_backfill.py (so it also ships in the
# Docker image for the server-side POST /api/admin/enrich-missing). This CLI is
# a thin front-end: dry-run, serial mode, file logging.
from backend.enrich_backfill import (  # noqa: E402
    _EXT, _dur, _ts, already_done, catalogue_upcs, close_pool,
    download_image, init_user_db, run_threaded, upsert,
)
from backend import goupc, r2  # noqa: E402

EMIT_EVERY_S = 60  # progress-line cadence in seconds (serial mode)


def _run_threaded(todo, args, emit):
    return run_threaded(todo, args, emit)



def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="Max UPCs to process (0 = all)")
    ap.add_argument("--dry-run", action="store_true", help="Show the work, call nothing")
    ap.add_argument("--refetch", choices=["not_found", "error", "all"], default=None,
                    help="Also re-process UPCs previously in this state")
    ap.add_argument("--sleep", type=float, default=0.5, help="Seconds between Go-UPC calls (serial mode)")
    ap.add_argument("--log", default=None, help="Also append progress lines to this file (flushed live)")
    ap.add_argument("--workers", type=int, default=1, help="Concurrent workers (>1 = pipelined mode)")
    ap.add_argument("--max-rps", type=float, default=8.0, help="Global Go-UPC request cap per second (pipelined)")
    ap.add_argument("--retries", type=int, default=3, help="Transient-error retries per UPC (pipelined)")
    args = ap.parse_args()

    logf = open(args.log, "a", encoding="utf-8") if args.log else None

    def emit(msg):
        print(msg, flush=True)
        if logf:
            logf.write(msg + "\n")
            logf.flush()

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

    if args.workers and args.workers > 1:
        rc = _run_threaded(todo, args, emit)
        if logf:
            logf.close()
        close_pool()
        sys.exit(rc)

    total = len(todo)
    ok = missing = errors = images = 0
    start = time.time()
    last_emit = start
    emit(f"[{_ts()}] starting: {total} UPC(s) to process")

    for i, upc in enumerate(todo, 1):
        try:
            result = goupc.lookup(upc)
        except goupc.GoUpcError as e:
            emit(f"[{i}/{total}] {upc}: error: {e}")
            upsert(upc, status="error")
            errors += 1
            time.sleep(min(args.sleep * 4, 5))  # back off on errors
        else:
            if result is None:
                upsert(upc, status="not_found")
                missing += 1
            else:
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
                            emit(f"[{i}/{total}] {upc}: R2 upload failed: {e}")
                upsert(upc, status="ok", data=result, image_url=image_url, image_key=image_key)
                ok += 1
            time.sleep(args.sleep)

        # Progress with rate + ETA, every EMIT_EVERY_S seconds (and on the last).
        now = time.time()
        if now - last_emit >= EMIT_EVERY_S or i == total:
            last_emit = now
            elapsed = now - start
            rate = i / elapsed if elapsed > 0 else 0
            eta = (total - i) / rate if rate > 0 else 0
            pct = 100.0 * i / total if total else 100.0
            emit(f"[{_ts()}] {i}/{total} ({pct:.1f}%) ok={ok} not_found={missing} "
                 f"errors={errors} images={images} | {rate:.2f} upc/s | "
                 f"elapsed {_dur(elapsed)} | ETA {_dur(eta)}")

    elapsed = time.time() - start
    emit(f"[{_ts()}] Done in {_dur(elapsed)}. ok={ok} not_found={missing} "
         f"errors={errors} images_uploaded={images}")
    if logf:
        logf.close()
    close_pool()


if __name__ == "__main__":
    main()
