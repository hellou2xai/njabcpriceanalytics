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


class GoUpcAuthError(GoUpcError):
    """Auth or quota failure (401/403). NOT transient: stop the run, don't retry
    every remaining UPC into the ground."""


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
        raise GoUpcAuthError(f"auth/quota problem ({r.status_code}): {r.text[:200]}")
    if r.status_code == 429:
        raise GoUpcError("rate limited (429)")
    # A 400 "not in a recognized format" means the code isn't a real barcode
    # (e.g. a 9/10/11-digit internal code that slipped into `upc`). Go-UPC will
    # never have it, so treat it like 404/not-found — cache it and move on,
    # rather than raising an error that trips the consecutive-error abort and
    # burns retries on a code that can't succeed.
    if r.status_code == 400 and "not in a recognized format" in r.text.lower():
        return None
    if r.status_code >= 400:
        raise GoUpcError(f"unexpected status {r.status_code}: {r.text[:200]}")

    try:
        payload = r.json()
    except ValueError as e:
        raise GoUpcError(f"bad JSON: {e}") from e

    return normalise(payload)


def normalise(payload: dict) -> dict | None:
    """Turn a raw Go-UPC payload into the flat dict we persist. Kept separate
    from the HTTP call so stored payloads can be re-parsed (e.g. after adding a
    column) without paying Go-UPC again. Returns None if there is no product."""
    product = payload.get("product") or {}
    if not product:
        return None

    # specs arrives as a list of [name, value] pairs; fold it into a dict so it
    # is easy to query/display (e.g. specs["Size"], specs["Alcohol Percentage"]).
    specs_raw = product.get("specs") or []
    specs = {}
    if isinstance(specs_raw, list):
        for pair in specs_raw:
            if isinstance(pair, (list, tuple)) and len(pair) == 2 and pair[0]:
                specs[str(pair[0])] = pair[1]
    elif isinstance(specs_raw, dict):
        specs = specs_raw

    def _str(v):
        return None if v is None else str(v)

    return {
        "name": product.get("name"),
        "brand": product.get("brand"),
        "category": product.get("category"),
        "category_path": product.get("categoryPath") or None,  # list of strings
        "description": product.get("description"),
        "region": product.get("region"),
        "specs": specs or None,
        "ean": _str(product.get("ean")),
        "code_type": payload.get("codeType"),
        "barcode_url": payload.get("barcodeUrl"),
        "inferred": bool(payload.get("inferred")),
        "image_url": product.get("imageUrl"),
        "attributes": payload,
    }
