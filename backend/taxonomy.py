"""Canonical wine + spirits taxonomy: the controlled vocabulary everything maps to.

Loads the committed reference data (built by scripts/build_taxonomy_llm.py):
    backend/data/wine_regions.json     { country: { region: [subregion, ...] } }
    backend/data/grape_varieties.json  { grape: {color, synonyms: [...]} }
    backend/data/spirits_taxonomy.json { type: {styles, regions, base} }

Two jobs:
  1. NORMALISE enrichment output — snap a model-emitted "Napa"/"napa valley" to
     the canonical "Napa Valley" + its country, so facets never fragment.
  2. RESOLVE a user's free-text origin/grape/spirit query to canonical values,
     so "douro", "shiraz", "speyside" all land on the right structured filter.

Both the app catalog and the assistant import from here, so the vocabulary is
shared (no forked region lists). Pure data + string lookups, no model calls.
"""
from __future__ import annotations

import json
import os
import re
from functools import lru_cache
from typing import Optional

_DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reference")


def _load(name: str) -> dict:
    path = os.path.join(_DATA, name)
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _norm(s: str) -> str:
    """Loose match key: lowercase, strip accents-ish punctuation and spacing."""
    s = (s or "").strip().lower()
    s = s.replace("&", " and ")
    s = re.sub(r"[\[\]().,'`’]", " ", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


@lru_cache(maxsize=1)
def wine_regions() -> dict:
    return _load("wine_regions.json")


@lru_cache(maxsize=1)
def grape_varieties() -> dict:
    return _load("grape_varieties.json")


@lru_cache(maxsize=1)
def spirits_taxonomy() -> dict:
    return _load("spirits_taxonomy.json")


# --- region index: every country / region / subregion -> canonical record ----
@lru_cache(maxsize=1)
def _region_index() -> dict:
    """norm(text) -> {country, region, subregion, level}. level in
    country/region/subregion. Longer/more-specific keys win on lookup."""
    idx: dict[str, dict] = {}

    def put(key: str, rec: dict):
        k = _norm(key)
        if k and k not in idx:
            idx[k] = rec

    for country, regions in wine_regions().items():
        put(country, {"country": country, "region": None, "subregion": None, "level": "country"})
        # common demonym/short forms for countries
        for alt in _country_aliases(country):
            put(alt, {"country": country, "region": None, "subregion": None, "level": "country"})
        for region, subs in (regions or {}).items():
            put(region, {"country": country, "region": region, "subregion": None, "level": "region"})
            for sub in subs or []:
                put(sub, {"country": country, "region": region, "subregion": sub, "level": "subregion"})
    return idx


_COUNTRY_ALIASES = {
    "United States": ["usa", "us", "u.s.", "u.s.a.", "america", "american"],
    "United Kingdom": ["uk", "u.k.", "britain", "british", "england", "english"],
    "New Zealand": ["nz"],
    "South Africa": ["south african", "rsa"],
    "Czech Republic": ["czechia", "czech"],
    "North Macedonia": ["macedonia", "macedonian"],
}
# generic demonym -> country, so "french"/"italian"/"spanish" resolve.
_DEMONYM = {
    "french": "France", "italian": "Italy", "spanish": "Spain",
    "portuguese": "Portugal", "german": "Germany", "austrian": "Austria",
    "greek": "Greece", "hungarian": "Hungary", "argentine": "Argentina",
    "argentinian": "Argentina", "chilean": "Chile", "australian": "Australia",
    "canadian": "Canada", "mexican": "Mexico", "israeli": "Israel",
    "lebanese": "Lebanon", "croatian": "Croatia", "slovenian": "Slovenia",
    "georgian": "Georgia", "moldovan": "Moldova", "romanian": "Romania",
    "bulgarian": "Bulgaria", "brazilian": "Brazil", "uruguayan": "Uruguay",
    "swiss": "Switzerland", "japanese": "Japan", "chinese": "China",
    "turkish": "Turkey", "serbian": "Serbia", "ukrainian": "Ukraine",
}


def _country_aliases(country: str) -> list[str]:
    out = list(_COUNTRY_ALIASES.get(country, []))
    out += [d for d, c in _DEMONYM.items() if c == country]
    return out


# --- grape index: synonym/canonical -> canonical grape -----------------------
@lru_cache(maxsize=1)
def _grape_index() -> dict:
    idx: dict[str, str] = {}
    for grape, meta in grape_varieties().items():
        idx.setdefault(_norm(grape), grape)
        for syn in (meta or {}).get("synonyms", []) or []:
            idx.setdefault(_norm(syn), grape)
    return idx


# --- spirits index: style/region/type -> canonical type ----------------------
@lru_cache(maxsize=1)
def _spirit_index() -> dict:
    idx: dict[str, dict] = {}
    for typ, meta in spirits_taxonomy().items():
        rec = {"type": typ, "style": None, "region": None}
        idx.setdefault(_norm(typ), rec)
        for style in (meta or {}).get("styles", []) or []:
            idx.setdefault(_norm(style), {"type": typ, "style": style, "region": None})
        for region in (meta or {}).get("regions", []) or []:
            idx.setdefault(_norm(region), {"type": typ, "style": None, "region": region})
    return idx


# Generic geography words that don't identify a place on their own — never use
# them as a single-word trigger ("valley" must not match every "... Valley").
_GENERIC_GEO = frozenset({
    "valley", "valle", "coast", "coastal", "region", "regions", "cotes",
    "county", "hills", "hill", "mountain", "mountains", "river", "lake",
    "island", "islands", "isla", "north", "northern", "south", "southern",
    "east", "eastern", "west", "western", "central", "upper", "lower", "high",
    "highlands", "grand", "cru", "classico", "superiore", "reserva", "wine",
    "wines", "vino", "vinho", "vins", "vin", "do", "doc", "docg", "aoc", "ava",
    "igp", "igt", "dop", "primorje", "the", "de", "del", "des", "du", "da",
    "di", "of", "and", "estate", "city", "new", "old", "great",
})


@lru_cache(maxsize=1)
def _region_words() -> dict:
    """Distinctive single word -> region record, for resolving a bare
    appellation like 'napa', 'barossa', 'willamette'. A word is indexed only if
    it is non-generic and points to exactly ONE region (ambiguous words are
    dropped rather than guessed). Region-level keys take precedence over
    subregion when a word would otherwise collide."""
    by_word: dict[str, list] = {}
    for key, rec in _region_index().items():
        for w in key.split():
            if len(w) >= 4 and w not in _GENERIC_GEO:
                by_word.setdefault(w, []).append(rec)
    out: dict[str, dict] = {}
    for w, recs in by_word.items():
        countries = {r["country"] for r in recs}
        if len(countries) != 1:
            continue  # spans countries -> genuinely ambiguous, don't guess
        country = next(iter(countries))
        uniq = {(r.get("region"), r.get("subregion")): r for r in recs}
        if len(uniq) == 1:
            out[w] = next(iter(uniq.values()))
            continue
        # Multiple appellations share this word (Chianti Classico/Rufina;
        # Sonoma Coast/Valley) — collapse to the common parent region if they
        # share one, else to the country.
        regions = {r.get("region") for r in recs if r.get("region")}
        if len(regions) == 1:
            out[w] = {"country": country, "region": next(iter(regions)),
                      "subregion": None, "level": "region"}
        else:
            out[w] = {"country": country, "region": None,
                      "subregion": None, "level": "country"}
    return out


def canonical_region(text: Optional[str]) -> Optional[dict]:
    """Snap free text to a canonical region record {country, region, subregion,
    level}. Tries, in order: exact key, whole-phrase containment (word-bounded,
    longest first), then a distinctive single-word hit. None if unknown."""
    if not text:
        return None
    idx = _region_index()
    t = _norm(text)
    if t in idx:
        return idx[t]
    # whole canonical phrase contained as words in the query ("cotes du rhone
    # reds" -> Cotes du Rhone). Word-bounded + len>=4 so "bar" never matches
    # inside "barossa".
    for key in _sorted_keys(idx):
        if len(key) >= 4 and re.search(rf"\b{re.escape(key)}\b", t):
            return idx[key]
    # distinctive single word ("napa", "barossa", "willamette").
    words = [w for w in t.split() if len(w) >= 4 and w not in _GENERIC_GEO]
    wi = _region_words()
    for w in words:
        if w in wi:
            return wi[w]
    return None


def canonical_grape(text: Optional[str]) -> Optional[str]:
    if not text:
        return None
    idx = _grape_index()
    t = _norm(text)
    if t in idx:
        return idx[t]
    for key in _sorted_keys(idx):
        if len(key) >= 4 and re.search(rf"\b{re.escape(key)}\b", t):
            return idx[key]
    return None


def canonical_spirit(text: Optional[str]) -> Optional[dict]:
    if not text:
        return None
    idx = _spirit_index()
    t = _norm(text)
    if t in idx:
        return idx[t]
    for key in _sorted_keys(idx):
        if len(key) >= 4 and key in t:
            return idx[key]
    return None


_SORTED_CACHE: dict[int, list] = {}


def _sorted_keys(idx: dict) -> list:
    """Keys of an index, longest first, so 'napa valley' beats 'napa' and
    'rias baixas' beats 'spain'. Cached per index object."""
    key = id(idx)
    cache = _SORTED_CACHE.get(key)
    if cache is None:
        cache = sorted(idx.keys(), key=len, reverse=True)
        _SORTED_CACHE[key] = cache
    return cache


def normalize_geo(country=None, region=None, subregion=None, varietal=None) -> dict:
    """Snap a classifier's raw geo output to canonical taxonomy values.

    Returns {country, region, subregion, varietal} where each is the canonical
    form when recognised, else the original (title-cased) value so we never drop
    a real product attribute just because it's outside the curated list. The
    most specific recognised region wins and back-fills country/region.
    """
    out = {"country": _clean(country), "region": _clean(region),
           "subregion": _clean(subregion), "varietal": None}

    # Resolve the finest region we were given; it back-fills the coarser levels.
    for cand in (subregion, region, country):
        rec = canonical_region(cand)
        if rec:
            out["country"] = rec["country"]
            if rec.get("region"):
                out["region"] = rec["region"]
            if rec.get("subregion"):
                out["subregion"] = rec["subregion"]
            break

    # Grapes: canonicalise each token of a '; '-separated blend.
    if varietal:
        parts = [p.strip() for p in re.split(r"[;,/]", varietal) if p.strip()]
        canon = []
        for p in parts:
            g = canonical_grape(p)
            canon.append(g or _clean(p))
        # dedupe preserving order
        seen = set()
        out["varietal"] = "; ".join(
            g for g in canon if g and not (g.lower() in seen or seen.add(g.lower())))
    return out


def _clean(s):
    s = (s or "").strip()
    return s or None


def known_countries() -> list[str]:
    return sorted(wine_regions().keys())


def known_grapes() -> list[str]:
    return sorted(grape_varieties().keys())
