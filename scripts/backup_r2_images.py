#!/usr/bin/env python
"""Back up every object in the R2 image bucket to a local folder.

Run before any bulk image processing (e.g. background removal) so the originals
are safe. Idempotent: skips files already downloaded with the same size.

Usage:
    python scripts/backup_r2_images.py                 # -> image_backup/
    python scripts/backup_r2_images.py --out some/dir
"""
import argparse
import os
import sys
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


def client():
    return boto3.client(
        "s3",
        endpoint_url=f"https://{ACCOUNT}.r2.cloudflarestorage.com",
        aws_access_key_id=KEY,
        aws_secret_access_key=SECRET,
        region_name="auto",
        config=Config(signature_version="s3v4", retries={"max_attempts": 3}),
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "image_backup"))
    args = ap.parse_args()
    if not (ACCOUNT and KEY and SECRET and BUCKET):
        print("ERROR: R2_* env vars not set (.env).")
        sys.exit(1)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    s3 = client()

    paginator = s3.get_paginator("list_objects_v2")
    total = downloaded = skipped = 0
    for page in paginator.paginate(Bucket=BUCKET):
        for obj in page.get("Contents", []):
            key, size = obj["Key"], obj["Size"]
            total += 1
            dest = out / key
            dest.parent.mkdir(parents=True, exist_ok=True)
            if dest.exists() and dest.stat().st_size == size:
                skipped += 1
                continue
            s3.download_file(BUCKET, key, str(dest))
            downloaded += 1
            if downloaded % 100 == 0:
                print(f"  downloaded {downloaded} (seen {total}) ...")

    print(f"Done. objects={total} downloaded={downloaded} skipped(existing)={skipped}")
    print(f"Backup at: {out}")


if __name__ == "__main__":
    main()
