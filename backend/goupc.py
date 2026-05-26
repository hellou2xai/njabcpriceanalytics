"""
Go-UPC product lookup (https://go-upc.com/api).

lookup(upc) returns a normalised dict on success, None when Go-UPC has no record
(404), and raises GoUpcError for transient/credential problems so the caller can
retry or back off. The API key comes from GO_UPC_API_KEY; if it is unset the
client is disabled and lookup() raises, so nothing calls out by accident.
"""

import os

import httpx

GO_UPC_API_KEY = os.getenv("GO_UPC_API_KEY", "").strip()
GO_UPC_ENABLED = bool(GO_UPC_API_KEY)

_URL = "https://go-upc.com/api/v1/code/{code}"


class GoUpcError(Exception):
    """Transient or configuration error worth retrying / backing off."""


def lookup(upc: str, timeout: float = 20.0) -> dict | None:
    """Look up a barcode. Returns a dict with name/brand/category/description/
    image_url and the raw payload, or None if Go-UPC has no record."""
    if not GO_UPC_ENABLED:
        raise GoUpcError("GO_UPC_API_KEY is not set")
    try:
        # Go-UPC authenticates with a Bearer token in the Authorization header.
        r = httpx.get(
            _URL.format(code=upc),
            headers={"Authorization": f"Bearer {GO_UPC_API_KEY}"},
            timeout=timeout,
        )
    except httpx.HTTPError as e:
        raise GoUpcError(f"request failed: {e}") from e

    if r.status_code == 404:
        return None
    if r.status_code in (401, 403):
        raise GoUpcError(f"auth/quota problem ({r.status_code}): {r.text[:200]}")
    if r.status_code == 429:
        raise GoUpcError("rate limited (429)")
    if r.status_code >= 400:
        raise GoUpcError(f"unexpected status {r.status_code}: {r.text[:200]}")

    try:
        payload = r.json()
    except ValueError as e:
        raise GoUpcError(f"bad JSON: {e}") from e

    product = payload.get("product") or {}
    if not product:
        return None
    return {
        "name": product.get("name"),
        "brand": product.get("brand"),
        "category": product.get("category"),
        "description": product.get("description"),
        "image_url": product.get("imageUrl"),
        "attributes": payload,
    }
