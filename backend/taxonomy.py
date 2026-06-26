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
import unicodedata
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
    """Loose match key: lowercase, fold accents to ASCII (so 'Rhône'/'Añejo'
    match ASCII queries), strip punctuation, collapse spacing."""
    s = (s or "").strip().lower()
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.replace("&", " and ")
    s = re.sub(r"[\[\]().,'`’/]", " ", s)
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


# Common trade shorthands the taxonomy stores only in compound form ("Scotch
# Single Malt", not bare "Scotch"). type is the canonical spirits_taxonomy key.
_SPIRIT_ALIASES = {
    "scotch": {"type": "Whisky / Whiskey", "style": "Scotch", "region": "Scotland"},
    "scotch whisky": {"type": "Whisky / Whiskey", "style": "Scotch", "region": "Scotland"},
    "rye": {"type": "Whisky / Whiskey", "style": "Rye Whiskey", "region": None},
    "single malt": {"type": "Whisky / Whiskey", "style": "Single Malt", "region": None},
    "cognac": {"type": "Brandy", "style": "Cognac", "region": "Cognac"},
    "armagnac": {"type": "Brandy", "style": "Armagnac", "region": "Armagnac"},
    "pisco": {"type": "Brandy", "style": "Pisco", "region": None},
}


# --- spirits index: style/region/type -> canonical type ----------------------
@lru_cache(maxsize=1)
def _spirit_types() -> dict:
    """norm(type name) -> canonical type, e.g. 'tequila' -> 'Tequila'. Also a
    couple of obvious bare words the taxonomy nests ('whisky','whiskey')."""
    out = {}
    for typ in spirits_taxonomy():
        out[_norm(typ)] = typ
        # split "Whisky / Whiskey", "Liqueur / Cordial" into each bare word
        for part in re.split(r"[/]", typ):
            p = _norm(part)
            if p:
                out.setdefault(p, typ)
    return out


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
    for alias, rec in _SPIRIT_ALIASES.items():
        idx.setdefault(_norm(alias), rec)
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
    # Prefer an explicit TYPE word ("reposado tequila" -> Tequila, not Mezcal),
    # then enrich it with a style/region of that same type found in the query.
    types = _spirit_types()
    hit_type = None
    for key in sorted(types, key=len, reverse=True):
        if len(key) >= 3 and re.search(rf"\b{re.escape(key)}\b", t):
            hit_type = types[key]
            break
    if hit_type:
        style = region = None
        for key in _sorted_keys(idx):
            if len(key) >= 4 and key in t:
                rec = idx[key]
                if rec["type"] == hit_type:
                    style = style or rec.get("style")
                    region = region or rec.get("region")
        return {"type": hit_type, "style": style, "region": region}
    # No explicit type — fall back to any style/region term.
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


_QUERY_GENERIC = frozenset({
    "wine", "wines", "red", "reds", "white", "whites", "rose", "roses",
    "rosado", "blush", "sparkling", "vino", "vins", "vin", "bottle", "bottles",
    "the", "a", "an", "of", "from", "and", "grape", "grapes", "varietal",
    "spirit", "spirits", "whisky", "whiskey",
})


def _explained_words(*names) -> set:
    out: set = set()
    for nm in names:
        if nm:
            out.update(_norm(nm).split())
    return out


def resolve_query(text: Optional[str]) -> Optional[dict]:
    """If `text` is a PURE origin / grape / style browse, return a structured
    spec to filter the catalog's geo_* columns on; else None (so a brand query
    like 'napa cellars' or 'absolut vodka' stays a literal text search).

    Spec shapes:
      {"kind":"region","country":..,"region":..,"subregion":..}
      {"kind":"grape","grape":..}
      {"kind":"spirit","type":..,"style":..,"region":..}

    "Pure browse" = after removing the words the match explains plus generic
    wine/grape words, nothing meaningful is left. So "french wine", "napa",
    "bordeaux reds", "malbec", "speyside scotch" resolve; "napa cellars",
    "absolut vodka", "tito's" do not.
    """
    if not text:
        return None
    words = [w for w in _norm(text).split() if w]
    content = [w for w in words if w not in _QUERY_GENERIC]
    if not content:
        return None

    reg = canonical_region(text)
    grp = canonical_grape(text)
    spr = canonical_spirit(text)

    region_idx, region_words = _region_index(), _region_words()
    grape_idx, spirit_idx = _grape_index(), _spirit_index()

    def residual_after(explained: set, recognise) -> list:
        # A content word is explained if it's named in the match OR it is itself
        # a recognised term of this axis (so the matched trigger word — "chianti",
        # "scotch" — counts, while a brand word — "cellars" — does not).
        return [w for w in content
                if w not in explained and not recognise(w)]

    # Region browse — explained by country/region/subregion names + demonyms +
    # any recognised geographic word.
    if reg:
        explained = _explained_words(reg["country"], reg.get("region"), reg.get("subregion"))
        explained |= {d for d, c in _DEMONYM.items() if c == reg["country"]}
        explained |= set(_COUNTRY_ALIASES.get(reg["country"], []))
        if not residual_after(explained, lambda w: w in region_idx or w in region_words):
            return {"kind": "region", "country": reg["country"],
                    "region": reg.get("region"), "subregion": reg.get("subregion")}

    # Grape browse.
    if grp:
        syns = [grp] + (grape_varieties().get(grp, {}) or {}).get("synonyms", [])
        explained = _explained_words(*syns)
        if not residual_after(explained, lambda w: w in grape_idx):
            return {"kind": "grape", "grape": grp}

    # Spirit browse — explained by type/style/region tokens + recognised terms.
    if spr:
        explained = _explained_words(spr["type"], spr.get("style"), spr.get("region"))
        if not residual_after(explained, lambda w: w in spirit_idx):
            return {"kind": "spirit", "type": spr["type"],
                    "style": spr.get("style"), "region": spr.get("region")}
    return None


def query_name_tokens(spec: dict) -> list[str]:
    """Distinctive UPPER-CASE product-name fragments implied by a browse spec,
    for matching rows that aren't geo-enriched yet (fallback alongside the
    structured geo_* columns). Short/ambiguous tokens are dropped."""
    toks: list[str] = []

    def add(*vals):
        for v in vals:
            if not v:
                continue
            u = v.strip().upper()
            if len(u) >= 4 and u not in {x for x in toks}:
                toks.append(u)

    kind = spec.get("kind")
    if kind == "region":
        add(spec.get("subregion"), spec.get("region"))
        c = spec.get("country")
        add(c)
        for d, cc in _DEMONYM.items():
            if cc == c:
                add(d)
        for a in _COUNTRY_ALIASES.get(c, []):
            add(a)
    elif kind == "grape":
        g = spec.get("grape")
        add(g)
        for syn in (grape_varieties().get(g, {}) or {}).get("synonyms", []):
            add(syn)
    elif kind == "spirit":
        # A specific style/region ("Bourbon", "Speyside") is the precise signal;
        # the bare TYPE word ("Whisky") matches every whisky, so only fall back
        # to it for a pure type-level browse ("whiskey", "rum").
        if spec.get("style") or spec.get("region"):
            add(spec.get("style"), spec.get("region"))
        else:
            for part in re.split(r"[/]", spec.get("type") or ""):
                add(part.strip())
    # Drop tokens that are themselves generic (e.g. country 'GEORGIA' clashes
    # with the US state in names — but that's rare; keep it simple).
    return toks


def known_countries() -> list[str]:
    return sorted(wine_regions().keys())


def known_grapes() -> list[str]:
    return sorted(grape_varieties().keys())
