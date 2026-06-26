"""LLM geo/varietal enrichment for catalog products.

The Go-UPC `region` column is coarse ("USA or Canada" / "Outside of North
America") and ~half empty, so origin filtering had to be derived from hand-coded
name-token lists (backend/region_semantics.py) — a maintenance dead end. This
module instead asks the model, which already knows every wine region on earth,
to classify each product into structured geo + varietal fields from its
name / brand / description / category. The result is persisted on
product_enrichment and flows into cpl_enriched, search facets, and the semantic
index, so "douro", "barossa", "mosel", any appellation, any spelling all resolve
because the product itself carries its true origin.

Design notes:
- Batched: many products per call (JSON array out) to keep cost low. Haiku.
- Goes through the backend.llm_client seam (provider-pluggable, cached).
- Fields are deliberately catalog-wide (wine + spirits + beer): unknowns come
  back null rather than guessed.
"""
from __future__ import annotations

import json
from typing import Any, Optional

from backend import llm_client

# Model: Haiku is plenty for "what country/region/grape is this bottle". Override
# with CELR_GEO_ENRICH_MODEL if a run needs more horsepower.
import os
GEO_ENRICH_MODEL = os.getenv("CELR_GEO_ENRICH_MODEL", llm_client.HAIKU)

# The structured fields we extract. Kept flat so they map 1:1 to enrichment
# columns and FTS tokens. Everything is optional — null when not inferable.
_FIELDS = (
    "country",        # e.g. "France", "United States", "Italy", "Scotland"
    "region",         # primary wine/spirit region, e.g. "Bordeaux", "Napa Valley", "Speyside"
    "subregion",      # finer locality / appellation, e.g. "Pauillac", "Oakville", "Barossa Valley"
    "appellation",    # legal designation if any, e.g. "AOC Margaux", "DOCG", "AVA", "VQA"
    "varietal",       # grape(s) or base, e.g. "Cabernet Sauvignon", "Tempranillo; Garnacha"
    "color",          # wine: Red/White/Rose/Orange; sparkling: Sparkling; null for spirits
    "style",          # e.g. "Still", "Sparkling", "Fortified", "Single Malt", "Blanco Tequila", "IPA"
    "classification", # quality tier if stated, e.g. "Grand Cru", "Reserva", "VSOP", "Bottled in Bond"
)

_TOOL = {
    "name": "record_geo",
    "description": "Record the structured origin and varietal for each product.",
    "input_schema": {
        "type": "object",
        "properties": {
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "i": {"type": "integer", "description": "the product's index from the input list"},
                        "country": {"type": ["string", "null"]},
                        "region": {"type": ["string", "null"]},
                        "subregion": {"type": ["string", "null"]},
                        "appellation": {"type": ["string", "null"]},
                        "varietal": {"type": ["string", "null"]},
                        "color": {"type": ["string", "null"]},
                        "style": {"type": ["string", "null"]},
                        "classification": {"type": ["string", "null"]},
                    },
                    "required": ["i"],
                },
            }
        },
        "required": ["items"],
    },
}

_SYSTEM = (
    "You are a master sommelier and spirits expert building a clean catalog. "
    "For each product, infer its true origin and varietal from the name, brand, "
    "category and description. Use your own world knowledge of producers and "
    "appellations: you know that Caymus is Napa Valley, Kim Crawford is "
    "Marlborough New Zealand, Tignanello is Tuscany, Glenfiddich is Speyside "
    "Scotland, Don Julio is Jalisco Mexico. "
    "Rules: "
    "1) Only state what you are confident about; use null for any field you "
    "cannot determine. Never guess a region just because a grape is typical, "
    "and never invent a subregion you are unsure of (leave subregion null "
    "rather than guess a specific village/appellation). "
    "2) Use canonical, standard names (the form wine-searcher uses): country "
    "full name (e.g. 'United States', 'France', 'Scotland', 'New Zealand'); "
    "region/grape in their accepted spelling ('Napa Valley' not 'Napa', "
    "'Cabernet Sauvignon' not 'Cab', 'Tempranillo' not 'Tinto Fino'). "
    "3) `region`/`subregion` go broad to fine (region 'Bordeaux', subregion "
    "'Pauillac'; region 'Napa Valley', subregion 'Oakville'). "
    "4) `varietal` is the grape(s) for wine or the base spirit; list the actual "
    "grapes for known blends, separated by '; ', most-dominant first. "
    "5) `color` only for wine (Red/White/Rose/Orange) or 'Sparkling'; null for "
    "spirits/beer. "
    "6) Return one entry per input product, echoing its index `i`."
)


def _fmt(products: list[dict]) -> str:
    lines = []
    for i, p in enumerate(products):
        bits = [f"[{i}]"]
        if p.get("name"):
            bits.append(f"name: {p['name']}")
        if p.get("brand"):
            bits.append(f"brand: {p['brand']}")
        if p.get("category"):
            bits.append(f"category: {p['category']}")
        if p.get("product_type"):
            bits.append(f"type: {p['product_type']}")
        desc = (p.get("description") or "").strip()
        if desc:
            bits.append(f"desc: {desc[:280]}")
        lines.append(" | ".join(bits))
    return "\n".join(lines)


def classify(products: list[dict], *, model: Optional[str] = None) -> list[dict]:
    """Classify a batch of products. Returns a list aligned to `products`, each a
    dict of the _FIELDS (missing/unknown -> None). Empty list if the provider is
    not configured."""
    if not products:
        return []
    if not llm_client.enabled():
        return [{f: None for f in _FIELDS} for _ in products]

    out: list[dict] = [{f: None for f in _FIELDS} for _ in products]
    comp = llm_client.complete(
        model=model or GEO_ENRICH_MODEL,
        system=_SYSTEM,
        messages=[{"role": "user", "content":
                   "Classify these products:\n" + _fmt(products)}],
        tools=[_TOOL],
        tool_choice={"type": "tool", "name": "record_geo"},
        max_tokens=4096,
    )
    if not comp.tool_use:
        return out
    items = (comp.tool_use.get("input") or {}).get("items") or []
    for it in items:
        try:
            idx = int(it.get("i"))
        except (TypeError, ValueError):
            continue
        if 0 <= idx < len(out):
            for f in _FIELDS:
                v = it.get(f)
                if isinstance(v, str):
                    v = v.strip() or None
                out[idx][f] = v
    return out


def fields() -> tuple[str, ...]:
    return _FIELDS
