"""Generate the canonical wine + spirits taxonomy from the model's knowledge.

wine-searcher (the reference the user pointed to) blocks automated crawling
(PerimeterX captcha after a few hits), so instead of scraping we have the model
emit the SAME canonical structure it encodes, seeded with wine-searcher's own
country universe. Output is version-controlled reference data the user can
review and edit:

  backend/data/wine_regions.json   { country: { region: [subregion, ...] } }
  backend/data/grape_varieties.json { canonical_grape: [synonym, ...] }
  backend/data/spirits_taxonomy.json { type: { "regions": [...], "styles": [...], "base": [...] } }

Run:  python scripts/build_taxonomy_llm.py [--only wine|grapes|spirits]
"""
from __future__ import annotations

import argparse
import json
import os
import sys

from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
load_dotenv()

from backend import llm_client

DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    "backend", "reference")
os.makedirs(DATA, exist_ok=True)

# wine-searcher's country universe (scraped from /regions before the block),
# trimmed to real producers worth modelling.
WINE_COUNTRIES = [
    "France", "Italy", "Spain", "Portugal", "Germany", "Austria", "Greece",
    "Hungary", "United States", "Argentina", "Chile", "Australia",
    "New Zealand", "South Africa", "Canada", "Mexico", "Brazil", "Uruguay",
    "Switzerland", "Bulgaria", "Romania", "Croatia", "Slovenia", "Georgia",
    "Moldova", "Israel", "Lebanon", "China", "Japan", "England",
    "United Kingdom", "Czech Republic", "Slovakia", "Serbia", "Turkey",
    "Armenia", "North Macedonia", "Montenegro", "Cyprus", "Luxembourg",
    "Ukraine", "Russia", "Peru", "Bolivia", "India",
]


def _ask(model, system, user, tool):
    comp = llm_client.complete(
        model=model, system=system,
        messages=[{"role": "user", "content": user}],
        tools=[tool], tool_choice={"type": "tool", "name": tool["name"]},
        max_tokens=8000)
    if not comp.tool_use:
        return None
    return comp.tool_use.get("input")


def build_wine():
    tool = {
        "name": "record_regions",
        "description": "Record the wine regions and their subregions/appellations for a country.",
        "input_schema": {
            "type": "object",
            "properties": {
                "regions": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "region": {"type": "string"},
                            "subregions": {"type": "array", "items": {"type": "string"}},
                        },
                        "required": ["region"],
                    },
                }
            },
            "required": ["regions"],
        },
    }
    system = (
        "You are a wine geography authority. Emit the canonical wine-region "
        "taxonomy for a country using standard wine-searcher / industry names. "
        "List the country's major wine regions, and for each its notable "
        "subregions / appellations (AOC, DOCG, DO, AVA, GI). Use accepted "
        "English spellings (e.g. 'Napa Valley', 'Cote de Nuits', 'Barossa "
        "Valley'). Be reasonably complete for major producers; for tiny "
        "producers a short list is fine. Do not invent."
    )
    out: dict[str, dict] = {}
    for i, c in enumerate(WINE_COUNTRIES, 1):
        res = _ask(llm_client.SONNET, system,
                   f"Country: {c}. List its wine regions and subregions/appellations.", tool)
        regions = {}
        for r in (res or {}).get("regions", []) or []:
            name = (r.get("region") or "").strip()
            if not name:
                continue
            subs = [s.strip() for s in (r.get("subregions") or []) if s and s.strip()]
            regions[name] = sorted(dict.fromkeys(subs))
        out[c] = dict(sorted(regions.items()))
        print(f"[{i}/{len(WINE_COUNTRIES)}] {c}: {len(regions)} regions, "
              f"{sum(len(v) for v in regions.values())} subregions", flush=True)
    path = os.path.join(DATA, "wine_regions.json")
    json.dump(out, open(path, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    print(f"WROTE {path}: {len(out)} countries", flush=True)


def build_grapes():
    tool = {
        "name": "record_grapes",
        "description": "Record canonical grape varieties and their synonyms.",
        "input_schema": {
            "type": "object",
            "properties": {
                "grapes": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "color": {"type": "string", "description": "Red, White, or other"},
                            "synonyms": {"type": "array", "items": {"type": "string"}},
                        },
                        "required": ["name"],
                    },
                }
            },
            "required": ["grapes"],
        },
    }
    system = (
        "You are a grape-variety (ampelography) authority. Emit canonical grape "
        "variety names with their common synonyms and trade names, using "
        "wine-searcher / industry standard primary names. Include the major and "
        "widely-traded varieties worldwide (vinifera and notable hybrids). For "
        "each: primary name, color (Red/White), and synonyms (e.g. Syrah -> "
        "[Shiraz], Tempranillo -> [Tinto Fino, Tinta Roriz, Aragonez], "
        "Pinot Gris -> [Pinot Grigio, Grauburgunder]). Be thorough: aim for "
        "200+ varieties across two batches if needed."
    )
    out: dict[str, dict] = {}
    for batch in ("the most planted and widely-traded 150 varieties",
                  "another 150 notable varieties NOT already obvious top-tier "
                  "(regional Italian, Spanish, Portuguese, Greek, Eastern "
                  "European, hybrid and emerging varieties)"):
        res = _ask(llm_client.SONNET, system,
                   f"List {batch}. Give primary name, color, synonyms.", tool)
        for g in (res or {}).get("grapes", []) or []:
            nm = (g.get("name") or "").strip()
            if not nm:
                continue
            out.setdefault(nm, {
                "color": (g.get("color") or "").strip() or None,
                "synonyms": sorted(dict.fromkeys(
                    s.strip() for s in (g.get("synonyms") or []) if s and s.strip())),
            })
        print(f"grapes so far: {len(out)}", flush=True)
    path = os.path.join(DATA, "grape_varieties.json")
    json.dump(dict(sorted(out.items())), open(path, "w", encoding="utf-8"),
              indent=1, ensure_ascii=False)
    print(f"WROTE {path}: {len(out)} grapes", flush=True)


def build_spirits():
    tool = {
        "name": "record_spirits",
        "description": "Record the canonical spirits taxonomy.",
        "input_schema": {
            "type": "object",
            "properties": {
                "types": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "type": {"type": "string", "description": "e.g. Whisky, Tequila, Rum, Gin"},
                            "styles": {"type": "array", "items": {"type": "string"},
                                       "description": "subtypes/styles, e.g. Bourbon, Single Malt, Blanco"},
                            "regions": {"type": "array", "items": {"type": "string"},
                                        "description": "producing regions/origins, e.g. Speyside, Jalisco, Cognac"},
                            "base": {"type": "array", "items": {"type": "string"},
                                     "description": "base materials, e.g. Malted Barley, Blue Agave, Molasses"},
                        },
                        "required": ["type"],
                    },
                }
            },
            "required": ["types"],
        },
    }
    system = (
        "You are a spirits authority. Emit the canonical spirits taxonomy used "
        "in the trade. Cover the major categories: Whisky/Whiskey (Scotch, "
        "Bourbon, Rye, Irish, Japanese, Canadian, Tennessee), Brandy (Cognac, "
        "Armagnac, Pisco, grape/fruit brandy), Tequila, Mezcal, Rum, Cachaca, "
        "Gin, Vodka, Liqueur/Cordial, Aperitif/Vermouth, Absinthe, Aquavit, "
        "Soju/Shochu, Baijiu, Grappa. For each: canonical styles/subtypes, "
        "producing regions/origins (with the legal whisky regions, agave "
        "regions, cognac crus), and base materials. Use standard names."
    )
    res = _ask(llm_client.SONNET, system,
               "Emit the full spirits taxonomy: types with their styles, "
               "regions and base materials.", tool)
    out = {}
    for t in (res or {}).get("types", []) or []:
        nm = (t.get("type") or "").strip()
        if not nm:
            continue
        out[nm] = {
            "styles": sorted(dict.fromkeys(s.strip() for s in (t.get("styles") or []) if s and s.strip())),
            "regions": sorted(dict.fromkeys(s.strip() for s in (t.get("regions") or []) if s and s.strip())),
            "base": sorted(dict.fromkeys(s.strip() for s in (t.get("base") or []) if s and s.strip())),
        }
    path = os.path.join(DATA, "spirits_taxonomy.json")
    json.dump(dict(sorted(out.items())), open(path, "w", encoding="utf-8"),
              indent=1, ensure_ascii=False)
    print(f"WROTE {path}: {len(out)} spirit types", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=["wine", "grapes", "spirits"])
    args = ap.parse_args()
    if not llm_client.enabled():
        raise SystemExit("LLM provider not configured (ANTHROPIC_API_KEY).")
    if args.only in (None, "wine"):
        build_wine()
    if args.only in (None, "grapes"):
        build_grapes()
    if args.only in (None, "spirits"):
        build_spirits()


if __name__ == "__main__":
    main()
