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

import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

from backend.db import get_duckdb, read_parquet, init_user_db
from backend.pg import get_pg, close_pool
from backend import goupc, r2

# Mirrors catalog._VALID_UPC_SQL: a real barcode, not all-zeros/nines filler.
VALID_UPC = (
    "upc IS NOT NULL AND upc <> '' AND upc <> '0'"
    " AND NOT regexp_matches(upc, '^(0+|9+|1+)$')"
    " AND NOT upc LIKE '999999%'"
    " AND LENGTH(LTRIM(upc, '0')) >= 8"
)

_EXT = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif"}

EMIT_EVERY_S = 60  # progress-line cadence in seconds (serial + pipelined)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ts() -> str:
    """Local wall-clock HH:MM:SS for progress lines."""
    return datetime.now().strftime("%H:%M:%S")


def _dur(seconds: float) -> str:
    """Human duration, e.g. '2h 05m 30s'."""
    seconds = int(max(seconds, 0))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    if h:
        return f"{h}h {m:02d}m {s:02d}s"
    if m:
        return f"{m}m {s:02d}s"
    return f"{s}s"


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
    d = data or {}
    # Image provenance: stamped only when an image was actually fetched + stored.
    image_source = "go-upc" if image_url else None

    def _json(v):
        return json.dumps(v) if v else None

    with get_pg() as con:
        con.execute(
            """INSERT INTO product_enrichment
                 (upc, name, brand, category, category_path, description, region,
                  specs, ean, code_type, barcode_url, inferred, image_url, image_key,
                  image_source, attributes, source, status, attempts, fetched_at, updated_at)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'go-upc',%s,1,%s,%s)
               ON CONFLICT (upc) DO UPDATE SET
                 name=EXCLUDED.name, brand=EXCLUDED.brand, category=EXCLUDED.category,
                 category_path=EXCLUDED.category_path, description=EXCLUDED.description,
                 region=EXCLUDED.region, specs=EXCLUDED.specs, ean=EXCLUDED.ean,
                 code_type=EXCLUDED.code_type, barcode_url=EXCLUDED.barcode_url,
                 inferred=EXCLUDED.inferred,
                 image_url=COALESCE(EXCLUDED.image_url, product_enrichment.image_url),
                 image_key=COALESCE(EXCLUDED.image_key, product_enrichment.image_key),
                 image_source=COALESCE(EXCLUDED.image_source, product_enrichment.image_source),
                 attributes=EXCLUDED.attributes, status=EXCLUDED.status,
                 attempts=product_enrichment.attempts + 1,
                 fetched_at=EXCLUDED.fetched_at, updated_at=EXCLUDED.updated_at""",
            (
                upc,
                d.get("name"), d.get("brand"), d.get("category"),
                _json(d.get("category_path")), d.get("description"), d.get("region"),
                _json(d.get("specs")), d.get("ean"), d.get("code_type"),
                d.get("barcode_url"), 1 if d.get("inferred") else 0,
                image_url, image_key, image_source,
                _json(d.get("attributes")),
                status, _now(), _now(),
            ),
        )


def _run_threaded(todo, args, emit):
    """Pipelined backfill: a bounded thread pool runs the full per-UPC pipeline
    (lookup -> image download -> R2 upload -> upsert) concurrently, capped at a
    global request rate. Failsafe by design:
      - every UPC commits in its own transaction, so a crash/stop just resumes;
      - transient errors (429/5xx/network) retry with backoff, then mark 'error'
        (negative-cached, retryable later with --refetch error);
      - an auth/quota failure (401/403) aborts the whole run instead of burning
        every remaining UPC into an error row;
      - 25 consecutive errors trips an abort (systemic failure: network/R2/DB).
    """
    total = len(todo)
    c = {"ok": 0, "not_found": 0, "errors": 0, "skipped": 0, "images": 0}
    start = time.time()
    last_emit = start

    stop = threading.Event()
    abort_reason = [None]
    rate_lock = threading.Lock()
    next_call = [start]
    min_spacing = (1.0 / args.max_rps) if args.max_rps and args.max_rps > 0 else 0.0

    def pace():
        """Space Go-UPC call starts globally so concurrency stays polite."""
        if min_spacing <= 0:
            return
        with rate_lock:
            now = time.time()
            wait = next_call[0] - now
            next_call[0] = max(now, next_call[0]) + min_spacing
        if wait > 0:
            time.sleep(wait)

    def process_one(upc):
        if stop.is_set():
            return ("skipped", False)
        result = None
        for attempt in range(args.retries + 1):
            if stop.is_set():
                return ("skipped", False)
            pace()
            try:
                result = goupc.lookup(upc)
                break
            except goupc.GoUpcAuthError as e:
                abort_reason[0] = abort_reason[0] or str(e)
                stop.set()
                return ("skipped", False)
            except goupc.GoUpcError:
                if attempt < args.retries:
                    time.sleep(min(2 ** attempt, 8))  # 1s, 2s, 4s, 8s
                else:
                    try:
                        upsert(upc, status="error")
                    except Exception:
                        pass
                    return ("error", False)
        try:
            if result is None:
                upsert(upc, status="not_found")
                return ("not_found", False)
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
                    except Exception as e:  # noqa: BLE001
                        emit(f"  {upc}: R2 upload failed: {e}")
            upsert(upc, status="ok", data=result, image_url=image_url, image_key=image_key)
            return ("ok", bool(image_url))
        except Exception:  # noqa: BLE001 - DB/unexpected: record + keep going
            try:
                upsert(upc, status="error")
            except Exception:
                pass
            return ("error", False)

    emit(f"[{_ts()}] starting (pipelined): {total} UPC(s) | {args.workers} workers | cap {args.max_rps}/s")
    consec_err = 0
    done = 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = [ex.submit(process_one, u) for u in todo]
        for fut in as_completed(futures):
            done += 1
            try:
                status, had_image = fut.result()
            except Exception:  # noqa: BLE001
                status, had_image = ("error", False)
            if status == "ok":
                c["ok"] += 1
                c["images"] += 1 if had_image else 0
                consec_err = 0
            elif status == "not_found":
                c["not_found"] += 1
                consec_err = 0
            elif status == "skipped":
                c["skipped"] += 1
            else:
                c["errors"] += 1
                consec_err += 1
            if consec_err >= 25 and not stop.is_set():
                abort_reason[0] = abort_reason[0] or "25+ consecutive errors (systemic failure?)"
                stop.set()

            now = time.time()
            if now - last_emit >= EMIT_EVERY_S or done == total:
                last_emit = now
                elapsed = now - start
                processed = max(done - c["skipped"], 1)
                rate = processed / elapsed if elapsed > 0 else 0
                eta = (total - done) / rate if rate > 0 else 0
                pct = 100.0 * done / total if total else 100.0
                emit(f"[{_ts()}] {done}/{total} ({pct:.1f}%) ok={c['ok']} "
                     f"not_found={c['not_found']} errors={c['errors']} images={c['images']} "
                     f"| {rate:.2f} upc/s | elapsed {_dur(elapsed)} | ETA {_dur(eta)}")

    elapsed = time.time() - start
    if abort_reason[0]:
        emit(f"[{_ts()}] ABORTED: {abort_reason[0]} | done={done} ok={c['ok']} "
             f"not_found={c['not_found']} errors={c['errors']} skipped={c['skipped']}")
        return 1
    emit(f"[{_ts()}] Done in {_dur(elapsed)}. ok={c['ok']} not_found={c['not_found']} "
         f"errors={c['errors']} images_uploaded={c['images']}")
    return 0


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
