"""
Cloudflare R2 image storage (S3-compatible).

We upload product images to R2 and serve them from the bucket's public URL
(stored in product_enrichment.image_url). If the R2_* env vars are not set,
R2 is disabled and uploads are skipped, so local dev and the deploy keep working
without it.

Env:
  R2_ACCOUNT_ID        Cloudflare account id (also forms the S3 endpoint).
  R2_ACCESS_KEY_ID     R2 API token access key.
  R2_SECRET_ACCESS_KEY R2 API token secret.
  R2_BUCKET            Bucket name.
  R2_PUBLIC_BASE_URL   Public base for objects, e.g. https://img.celr.ai (no
                       trailing slash). Required to build the served URL.
"""

import functools
import os

R2_ACCOUNT_ID = os.getenv("R2_ACCOUNT_ID", "").strip()
R2_ACCESS_KEY_ID = os.getenv("R2_ACCESS_KEY_ID", "").strip()
R2_SECRET_ACCESS_KEY = os.getenv("R2_SECRET_ACCESS_KEY", "").strip()
R2_BUCKET = os.getenv("R2_BUCKET", "").strip()
R2_PUBLIC_BASE_URL = os.getenv("R2_PUBLIC_BASE_URL", "").rstrip("/")

R2_ENABLED = bool(R2_ACCOUNT_ID and R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY and R2_BUCKET)


@functools.lru_cache(maxsize=1)
def _client():
    import boto3  # imported lazily so the dependency isn't needed when R2 is off
    from botocore.config import Config
    return boto3.client(
        "s3",
        endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name="auto",
        config=Config(signature_version="s3v4", retries={"max_attempts": 3}),
    )


def public_url(key: str) -> str:
    """Public URL for an object key (requires R2_PUBLIC_BASE_URL)."""
    return f"{R2_PUBLIC_BASE_URL}/{key}" if R2_PUBLIC_BASE_URL else ""


def upload_bytes(key: str, data: bytes, content_type: str) -> str:
    """Upload bytes to R2 under `key` and return the public URL. Raises if R2 is
    not configured (callers should check R2_ENABLED first)."""
    if not R2_ENABLED:
        raise RuntimeError("R2 is not configured")
    _client().put_object(
        Bucket=R2_BUCKET,
        Key=key,
        Body=data,
        ContentType=content_type,
        CacheControl="public, max-age=31536000, immutable",
    )
    return public_url(key)
