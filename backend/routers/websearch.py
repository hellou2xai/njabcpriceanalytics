"""
Web price search — look up a product's RETAIL pricing from nearby stores on the
open web, matched to the exact SKU (name + vintage + size), with images.

Wine is vintage-specific, so the query always carries the vintage and bottle
size. Live structured results come from SerpAPI's Google Shopping engine when
``SERPAPI_API_KEY`` is set; otherwise we return real, current, location-aware
deep links (Wine-Searcher for vintage-level merchant pricing, Google Shopping,
Google Maps for nearby liquor stores) so the user always gets genuine listings.
"""

import os
import re
import urllib.parse

from fastapi import APIRouter, Query
from typing import Optional

router = APIRouter(prefix="/api/websearch", tags=["websearch"])

_VINTAGE_TYPES = ("WINE", "SPARKLING", "VERMOUTH")


def _clean_vintage(v: Optional[str]) -> Optional[str]:
    """Keep a real 4-digit year; treat 0/NA/NV/blank as no vintage (NV)."""
    if not v:
        return None
    s = str(v).strip()
    if s in ("", "0", "0.0") or s.upper() in ("NA", "N/A", "NONE", "NV"):
        return None
    m = re.match(r"^(\d{4})", s)
    return m.group(1) if m else None


@router.get("/product")
def product_web_search(
    product_name: str,
    product_type: Optional[str] = None,
    vintage: Optional[str] = None,
    unit_volume: Optional[str] = None,
    unit_qty: Optional[str] = None,
    upc: Optional[str] = None,
    lat: Optional[float] = None,
    lng: Optional[float] = None,
    location: Optional[str] = Query(None, description="Optional city/region label"),
):
    """Retail price lookup for one SKU, matched to vintage + size."""
    is_wine = (product_type or "").upper() in _VINTAGE_TYPES
    vyear = _clean_vintage(vintage)

    # Precise query: name + vintage (wine) + bottle size, so we match the exact
    # product and not a different vintage/size.
    parts = [product_name.strip()]
    if is_wine and vyear:
        parts.append(vyear)
    if unit_volume:
        parts.append(str(unit_volume))
    query = " ".join(p for p in parts if p)

    has_geo = lat is not None and lng is not None
    near = " near me" if (has_geo or location) else ""
    q_enc = urllib.parse.quote_plus(query + near)

    # Real, current, location-aware deep links (open live listings in a tab).
    links = []
    if is_wine:
        ws_terms = product_name + (f" {vyear}" if vyear else "")
        links.append({
            "label": "Wine-Searcher — nearby merchants by vintage",
            "url": f"https://www.wine-searcher.com/find/{urllib.parse.quote_plus(ws_terms)}",
            "why": "The standard for vintage-specific wine pricing across local merchants, with label images.",
        })
    links.append({
        "label": "Google Shopping",
        "url": f"https://www.google.com/search?tbm=shop&q={q_enc}",
        "why": "Retail listings with photos and current prices (uses your browser location for 'near me').",
    })
    maps_q = urllib.parse.quote_plus(f"{product_name} liquor store")
    maps_url = (f"https://www.google.com/maps/search/{maps_q}/@{lat},{lng},12z"
                if has_geo else f"https://www.google.com/maps/search/{maps_q}")
    links.append({
        "label": "Liquor stores near me (Maps)",
        "url": maps_url,
        "why": "Nearby stores that may carry it — pinned to your location.",
    })

    # ---- Additional details (background, reviews, ratings), not just prices ----
    q_plain = urllib.parse.quote_plus(query)
    info_links = [
        {"label": "Web overview & reviews",
         "url": f"https://www.google.com/search?q={q_plain}",
         "why": "Background, reviews, and ratings from across the web."},
        {"label": "Label & bottle images",
         "url": f"https://www.google.com/search?tbm=isch&q={q_plain}",
         "why": "Confirm you're matching the exact SKU by sight."},
    ]
    _ptype = (product_type or "").upper()
    if is_wine:
        info_links += [
            {"label": "Vivino: ratings & tasting notes", "url": f"https://www.vivino.com/search/wines?q={q_plain}", "why": "Community ratings and tasting notes."},
            {"label": "Wine-Searcher: critic scores", "url": f"https://www.wine-searcher.com/find/{q_plain}", "why": "Critic scores and producer details."},
        ]
    elif any(b in _ptype for b in ("BEER", "MALT", "CIDER", "SELTZER")):
        info_links += [
            {"label": "Untappd: beer details & ratings", "url": f"https://untappd.com/search?q={q_plain}", "why": "Style, ABV, and drinker ratings."},
            {"label": "BeerAdvocate reviews", "url": f"https://www.beeradvocate.com/search/?q={q_plain}&qt=beer", "why": "In-depth reviews."},
        ]
    else:
        info_links += [
            {"label": "Distiller: spirit details & ratings", "url": f"https://distiller.com/search?term={q_plain}", "why": "Tasting notes, ABV, and ratings."},
            {"label": "Wikipedia", "url": f"https://en.wikipedia.org/w/index.php?search={q_plain}", "why": "Brand and product background."},
        ]

    results = []
    info_results: list = []
    live = False
    note = ("Live in-app results need a SERPAPI_API_KEY on the server. "
            "The links below open real, current listings (location-aware in your browser).")

    api_key = os.getenv("SERPAPI_API_KEY")
    if api_key:
        try:
            import httpx
            params = {
                "engine": "google_shopping",
                "q": query,
                "api_key": api_key,
                "hl": "en",
                "gl": "us",
            }
            if location:
                params["location"] = location
            resp = httpx.get("https://serpapi.com/search.json", params=params, timeout=20)
            data = resp.json()
            for it in (data.get("shopping_results") or [])[:24]:
                results.append({
                    "title": it.get("title"),
                    "price": it.get("price"),
                    "extracted_price": it.get("extracted_price"),
                    "store": it.get("source"),
                    "link": it.get("product_link") or it.get("link"),
                    "thumbnail": it.get("thumbnail"),
                    "rating": it.get("rating"),
                    "reviews": it.get("reviews"),
                    "delivery": it.get("delivery"),
                })
            live = bool(results)
            note = (f"Live Google Shopping results for “{query}”."
                    if live else f"No live listings found for “{query}”. Try the links below.")
            # Organic web results for additional details (descriptions, reviews).
            try:
                oresp = httpx.get("https://serpapi.com/search.json", params={
                    "engine": "google", "q": query, "api_key": api_key, "hl": "en", "gl": "us",
                }, timeout=20)
                for it in (oresp.json().get("organic_results") or [])[:6]:
                    info_results.append({
                        "title": it.get("title"),
                        "snippet": it.get("snippet"),
                        "link": it.get("link"),
                        "source": it.get("source") or it.get("displayed_link"),
                    })
            except Exception:  # noqa: BLE001 — details are best-effort
                pass
        except Exception as exc:  # noqa: BLE001 — surface to UI, never 500
            note = f"Live search unavailable ({type(exc).__name__}). Use the links below."

    return {
        "query": query,
        "is_wine": is_wine,
        "vintage": vyear,
        "unit_volume": unit_volume,
        "location": location or (f"{lat:.3f}, {lng:.3f}" if has_geo else None),
        "live": live,
        "results": results,
        "links": links,
        "info_links": info_links,
        "info_results": info_results,
        "note": note,
    }
