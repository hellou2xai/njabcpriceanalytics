#!/usr/bin/env python
"""Make product images transparent (background removed), safely and resumably.

Pipeline, per object in the R2 bucket:
  1. download the original to a local backup folder (image_backup/<key>),
  2. remove the background with rembg -> transparent PNG,
  3. upload the PNG to a NEW key under a version prefix (t1/<key>.png).

New keys are required because the originals are served with an immutable,
1-year Cache-Control, so overwriting them would not refresh anyone's cache.
Originals are left untouched on R2 (and backed up locally), so this is fully
reversible.

State is written to image_backup/_state.json after every object, so the run
resumes where it stopped (safe to re-run / run overnight).

After ALL objects are processed, repoint the database with --repoint-db:
  UPDATE product_enrichment SET image_url -> the t1/...png URL.
Then reload the live pricing cache (Admin -> Reload, or POST /reload-pricing).

Usage:
  python scripts/transparent_images.py --limit 3            # small test
  python scripts/transparent_images.py                      # full run (overnight)
  python scripts/transparent_images.py --repoint-db --database-url "postgresql://...render.com/celr?sslmode=require"
"""
import argparse
import io
import json
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

import boto3
from botocore.config import Config

ACCOUNT = os.getenv("R2_ACCOUNT_ID", "").strip()
KEY = os.getenv("R2_ACCESS_KEY_ID", "").strip()
SECRET = os.getenv("R2_SECRET_ACCESS_KEY", "").strip()
BUCKET = os.getenv("R2_BUCKET", "").strip()
PUBLIC_BASE = os.getenv("R2_PUBLIC_BASE_URL", "").rstrip("/")

VERSION_PREFIX = "t1"   # new key namespace for the transparent versions
IMG_EXT = (".jpg", ".jpeg", ".png", ".webp")


def s3_client():
    return boto3.client(
        "s3",
        endpoint_url=f"https://{ACCOUNT}.r2.cloudflarestorage.com",
        aws_access_key_id=KEY, aws_secret_access_key=SECRET,
        region_name="auto",
        config=Config(signature_version="s3v4", retries={"max_attempts": 5}),
    )


def new_key(key: str) -> str:
    """products/80686007630.jpg -> t1/products/80686007630.png"""
    base = key.rsplit(".", 1)[0]
    return f"{VERSION_PREFIX}/{base}.png"


def process(args):
    if not (ACCOUNT and KEY and SECRET and BUCKET):
        print("ERROR: R2_* env vars not set."); sys.exit(1)
    from rembg import remove, new_session
    from PIL import Image

    backup = Path(args.backup); backup.mkdir(parents=True, exist_ok=True)
    state_path = backup / "_state.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {"done": []}
    done = set(state["done"])

    s3 = s3_client()
    session = new_session("u2net")

    keys = []
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET):
        for o in page.get("Contents", []):
            k = o["Key"]
            if k.lower().endswith(IMG_EXT) and not k.startswith(VERSION_PREFIX + "/"):
                keys.append(k)
    print(f"{len(keys)} source images; {len(done)} already done", flush=True)

    todo = [k for k in keys if k not in done]
    if args.limit:
        todo = todo[: args.limit]
    print(f"processing {len(todo)} now", flush=True)

    t0 = time.time(); n = 0
    for k in todo:
        try:
            data = s3.get_object(Bucket=BUCKET, Key=k)["Body"].read()
            # 1. backup original
            dest = backup / k; dest.parent.mkdir(parents=True, exist_ok=True)
            if not dest.exists():
                dest.write_bytes(data)
            # 2. remove background -> RGBA PNG
            cut = remove(data, session=session)
            png = io.BytesIO()
            Image.open(io.BytesIO(cut)).convert("RGBA").save(png, format="PNG", optimize=True)
            # 3. upload to the new key
            s3.put_object(
                Bucket=BUCKET, Key=new_key(k), Body=png.getvalue(),
                ContentType="image/png",
                CacheControl="public, max-age=31536000, immutable",
            )
            done.add(k); n += 1
            if n % 25 == 0:
                state["done"] = sorted(done); state_path.write_text(json.dumps(state))
                rate = n / max(1e-6, time.time() - t0)
                print(f"  {n}/{len(todo)} done ({rate:.1f}/s, {len(done)} total)", flush=True)
        except Exception as e:
            print(f"  ! {k}: {e}", flush=True)

    state["done"] = sorted(done); state_path.write_text(json.dumps(state))
    print(f"Processed {n} this run; {len(done)}/{len(keys)} total. Backup: {backup}", flush=True)
    if len(done) >= len(keys):
        print("ALL IMAGES PROCESSED. Next: --repoint-db, then reload the live cache.", flush=True)


def repoint(args):
    """Repoint product_enrichment.image_url to the transparent PNG URLs."""
    import psycopg
    url = args.database_url or os.getenv("DATABASE_URL")
    if not url:
        print("ERROR: --database-url (or DATABASE_URL) required for --repoint-db"); sys.exit(1)
    # /products/<base>.<ext>  ->  /t1/products/<base>.png
    pattern = r"/products/([^/]+)\.(jpg|jpeg|png|webp)$"
    repl = r"/" + VERSION_PREFIX + r"/products/\1.png"
    with psycopg.connect(url, autocommit=True) as con:
        before = con.execute(
            "SELECT count(*) FROM product_enrichment WHERE image_url LIKE %s",
            ("%/products/%",)).fetchone()[0]
        con.execute(
            "UPDATE product_enrichment "
            "SET image_url = regexp_replace(image_url, %s, %s) "
            "WHERE image_url LIKE %s AND image_url NOT LIKE %s",
            (pattern, repl, "%/products/%", f"%/{VERSION_PREFIX}/products/%"))
        print(f"repointed image_url for ~{before} enriched rows -> {VERSION_PREFIX}/ PNGs")
    print("Now reload the live pricing cache (Admin -> Reload pricing, or POST /api/admin/reload-pricing).")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backup", default=str(ROOT / "image_backup"))
    ap.add_argument("--limit", type=int, default=0, help="process only N (test)")
    ap.add_argument("--repoint-db", action="store_true", help="update DB image_url (run AFTER full processing)")
    ap.add_argument("--database-url", help="live DB url for --repoint-db")
    args = ap.parse_args()
    if args.repoint_db:
        repoint(args)
    else:
        process(args)


if __name__ == "__main__":
    main()
