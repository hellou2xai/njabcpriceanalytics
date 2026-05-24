"""
Stores API: each owner manages their own list of stores.

A store is created by typing its name; the Google Places API (New) resolves it
to a full address. The Google key lives only on the server, so the browser
never sees it: the frontend calls these proxy endpoints instead.

  GET  /api/stores/lookup?q=...   -> name autocomplete (Places Autocomplete)
  GET  /api/stores/place/{id}     -> resolve a pick to a full address
  GET  /api/stores                -> the signed-in owner's stores
  POST /api/stores                -> add a store
  PUT  /api/stores/{id}           -> edit a store
  DELETE /api/stores/{id}         -> remove a store

If GOOGLE_MAPS_API_KEY is not set, lookup returns ``enabled: false`` and the
frontend falls back to plain manual address entry.
"""

import os
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from typing import Optional

from backend.db import NOW_UTC
from backend.pg import get_pg
from backend.auth import get_current_user

router = APIRouter(prefix="/api/stores", tags=["stores"])

_AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete"
_DETAILS_URL = "https://places.googleapis.com/v1/places/{place_id}"


def _api_key() -> Optional[str]:
    key = os.getenv("GOOGLE_MAPS_API_KEY") or os.getenv("GOOGLE_PLACES_API_KEY")
    return key.strip() if key else None


# ---- Google Places proxy ----

@router.get("/lookup")
def lookup_store(q: str = Query(..., min_length=2)):
    """Autocomplete a store name -> address predictions. Never raises: on any
    failure it returns an empty, disabled result so the UI can fall back to
    manual entry."""
    key = _api_key()
    if not key:
        return {"enabled": False, "predictions": [],
                "note": "Address lookup is off (no GOOGLE_MAPS_API_KEY set). Enter the address manually."}
    try:
        import httpx
        resp = httpx.post(
            _AUTOCOMPLETE_URL,
            headers={"X-Goog-Api-Key": key, "Content-Type": "application/json"},
            json={"input": q, "includedRegionCodes": ["us"]},
            timeout=10,
        )
        data = resp.json()
        if resp.status_code != 200:
            detail = (data.get("error") or {}).get("message", "lookup failed")
            return {"enabled": True, "predictions": [], "note": detail}
        predictions = []
        for s in data.get("suggestions", []):
            p = s.get("placePrediction")
            if not p:
                continue
            fmt = p.get("structuredFormat") or {}
            predictions.append({
                "place_id": p.get("placeId"),
                "description": (p.get("text") or {}).get("text"),
                "main_text": (fmt.get("mainText") or {}).get("text"),
                "secondary_text": (fmt.get("secondaryText") or {}).get("text"),
            })
        return {"enabled": True, "predictions": predictions, "note": None}
    except Exception as exc:  # noqa: BLE001 — surface to UI, never 500
        return {"enabled": True, "predictions": [],
                "note": f"Lookup unavailable ({type(exc).__name__}). Enter the address manually."}


def _component(components: list, *types: str, short: bool = False) -> Optional[str]:
    """First address component matching any of the given Google types."""
    for c in components:
        if any(t in c.get("types", []) for t in types):
            return c.get("shortText" if short else "longText")
    return None


@router.get("/place/{place_id}")
def place_details(place_id: str):
    """Resolve a chosen prediction into a structured address."""
    key = _api_key()
    if not key:
        raise HTTPException(status_code=400, detail="Address lookup is not configured on the server")
    try:
        import httpx
        resp = httpx.get(
            _DETAILS_URL.format(place_id=place_id),
            headers={
                "X-Goog-Api-Key": key,
                "X-Goog-FieldMask": ("id,displayName,formattedAddress,addressComponents,"
                                     "location,nationalPhoneNumber,internationalPhoneNumber"),
            },
            timeout=10,
        )
        data = resp.json()
        if resp.status_code != 200:
            detail = (data.get("error") or {}).get("message", "place details failed")
            raise HTTPException(status_code=502, detail=detail)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Place details unavailable ({type(exc).__name__})")

    comps = data.get("addressComponents", [])
    street_number = _component(comps, "street_number")
    route = _component(comps, "route")
    street = " ".join(x for x in (street_number, route) if x) or None
    loc = data.get("location") or {}
    return {
        "place_id": data.get("id"),
        "name": (data.get("displayName") or {}).get("text"),
        "formatted_address": data.get("formattedAddress"),
        "street": street,
        "city": _component(comps, "locality", "postal_town", "sublocality"),
        "state": _component(comps, "administrative_area_level_1", short=True),
        "postal_code": _component(comps, "postal_code"),
        "country": _component(comps, "country", short=True),
        "phone": data.get("nationalPhoneNumber") or data.get("internationalPhoneNumber"),
        "lat": loc.get("latitude"),
        "lng": loc.get("longitude"),
    }


# ---- Store CRUD (per owner) ----

class StoreIn(BaseModel):
    name: str
    place_id: Optional[str] = None
    formatted_address: Optional[str] = None
    street: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    postal_code: Optional[str] = None
    country: Optional[str] = None
    phone: Optional[str] = None
    lat: Optional[float] = None
    lng: Optional[float] = None
    license_number: Optional[str] = None
    notes: Optional[str] = None


_FIELDS = ("name", "place_id", "formatted_address", "street", "city", "state",
           "postal_code", "country", "phone", "lat", "lng", "license_number", "notes")


@router.get("")
def list_stores(user: dict = Depends(get_current_user)):
    with get_pg() as con:
        rows = con.execute(
            "SELECT * FROM stores WHERE user_id = %s ORDER BY name", (user["id"],)
        ).fetchall()
    return [dict(r) for r in rows]


@router.post("")
def create_store(store: StoreIn, user: dict = Depends(get_current_user)):
    if not store.name.strip():
        raise HTTPException(status_code=422, detail="Store name is required")
    with get_pg() as con:
        cols = ["user_id"] + list(_FIELDS)
        vals = [user["id"]] + [getattr(store, f) for f in _FIELDS]
        placeholders = ", ".join("%s" for _ in cols)
        cur = con.execute(
            f"INSERT INTO stores ({', '.join(cols)}) VALUES ({placeholders}) RETURNING id", vals
        )
        store_id = cur.fetchone()["id"]
    return {"id": store_id, "status": "created"}


@router.put("/{store_id}")
def update_store(store_id: int, store: StoreIn, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        owned = con.execute(
            "SELECT 1 FROM stores WHERE id = %s AND user_id = %s", (store_id, user["id"])
        ).fetchone()
        if not owned:
            raise HTTPException(status_code=404, detail="Store not found")
        assignments = ", ".join(f"{f} = %s" for f in _FIELDS)
        vals = [getattr(store, f) for f in _FIELDS] + [store_id, user["id"]]
        con.execute(
            f"UPDATE stores SET {assignments}, updated_at = {NOW_UTC} WHERE id = %s AND user_id = %s",
            vals,
        )
    return {"status": "updated"}


@router.delete("/{store_id}")
def delete_store(store_id: int, user: dict = Depends(get_current_user)):
    with get_pg() as con:
        con.execute("DELETE FROM stores WHERE id = %s AND user_id = %s", (store_id, user["id"]))
    return {"status": "deleted"}
