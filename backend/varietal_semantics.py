"""Varietal / style semantic filter.

Companion to backend.region_semantics — but for grape varietals, spirit
sub-types, beer styles, etc. The same shape:

  1. Each entry maps a hint (e.g. "cabernet", "pinot noir", "single malt",
     "ipa", "reposado") to a high-precision product-name token list plus
     looser enrichment description terms.
  2. `build_varietal_filter()` returns a SQL clause + params + an
     auto_product_type the catalog can apply.
  3. `resolve_varietal()` accepts natural phrasings via an alias map
     ("cabernets", "pinots", "IPAs", "single malt scotch") and resolves
     to the canonical key.

Why this exists: after region (#1) is set, the next narrowing the user
typically asks for is varietal/style. "California cabernets", "Italian
reds", "Japanese single malts", "session IPAs" — none of these worked
reliably under the old q-based search. The region filter alone returns
all California wines; this layer narrows to "California CABERNETS".

The taxonomy is intentionally focused on the LIVE catalog (NJ ABC). It
covers the high-volume varietals you actually find on Allied / Fedway /
Opici / Highgrade / Peerless price lists, not every grape grown in the
world.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass(frozen=True)
class Varietal:
    """One varietal / style hint.

    Mirror of backend.region_semantics.Region. `tokens` are matched
    case-insensitive against product NAME. `description_terms` join to
    product_enrichment.description for fallback when the name is opaque.
    `auto_product_type` is the implied product_type, applied when the
    caller didn't pass their own (e.g. varietal=ipa -> Beer).
    """
    key: str
    label: str
    tokens: tuple[str, ...]
    description_terms: tuple[str, ...] = field(default_factory=tuple)
    auto_product_type: Optional[str] = None


# Each entry resolves ONE natural-language style ("cabernet", "pinot", "IPA").
# Tokens are high-precision — common abbreviations the wholesalers actually
# use in product names. The description fallback handles SKUs where the name
# is opaque (e.g. brand-only naming with no varietal letters).

_VARIETALS: dict[str, Varietal] = {
    # ---- wine: red ----
    "cabernet": Varietal(
        key="cabernet", label="Cabernet Sauvignon",
        tokens=("CAB SAUV", "CABERNET SAUVIGNON", "CAB SAUVIGNON", "CABERNET",
                "CABERNET-SAUVIGNON", "CS ", " CS ", "CAB "),
        description_terms=("cabernet sauvignon",),
        auto_product_type="Wine",
    ),
    "merlot": Varietal(
        key="merlot", label="Merlot",
        tokens=("MERLOT",),
        description_terms=("merlot",),
        auto_product_type="Wine",
    ),
    "pinot noir": Varietal(
        key="pinot noir", label="Pinot Noir",
        tokens=("PINOT NOIR", "PINOT N", "PINOT NR", " PN ", " PN."),
        description_terms=("pinot noir",),
        auto_product_type="Wine",
    ),
    "syrah": Varietal(
        key="syrah", label="Syrah / Shiraz",
        tokens=("SYRAH", "SHIRAZ"),
        description_terms=("syrah", "shiraz"),
        auto_product_type="Wine",
    ),
    "malbec": Varietal(
        key="malbec", label="Malbec",
        tokens=("MALBEC",),
        description_terms=("malbec",),
        auto_product_type="Wine",
    ),
    "zinfandel": Varietal(
        key="zinfandel", label="Zinfandel",
        tokens=("ZINFANDEL", "ZIN ", " ZIN", "OLD VINE ZIN"),
        description_terms=("zinfandel",),
        auto_product_type="Wine",
    ),
    "sangiovese": Varietal(
        key="sangiovese", label="Sangiovese",
        tokens=("SANGIOVESE", "CHIANTI", "BRUNELLO", "VINO NOBILE"),
        description_terms=("sangiovese", "chianti", "brunello"),
        auto_product_type="Wine",
    ),
    "nebbiolo": Varietal(
        key="nebbiolo", label="Nebbiolo",
        tokens=("NEBBIOLO", "BAROLO", "BARBARESCO", "LANGHE NEB"),
        description_terms=("nebbiolo", "barolo", "barbaresco"),
        auto_product_type="Wine",
    ),
    "tempranillo": Varietal(
        key="tempranillo", label="Tempranillo",
        tokens=("TEMPRANILLO", "RIBERA DEL DUERO"),
        description_terms=("tempranillo", "ribera del duero"),
        auto_product_type="Wine",
    ),
    "grenache": Varietal(
        key="grenache", label="Grenache / GSM",
        tokens=("GRENACHE", "GARNACHA", " GSM"),
        description_terms=("grenache", "garnacha"),
        auto_product_type="Wine",
    ),
    "red blend": Varietal(
        key="red blend", label="Red Blend",
        tokens=("RED BLEND", " RED BL", "RED BL ", "RED WINE",
                "PROPRIETARY RED"),
        description_terms=("red blend", "proprietary red"),
        auto_product_type="Wine",
    ),
    # ---- wine: white ----
    "chardonnay": Varietal(
        key="chardonnay", label="Chardonnay",
        tokens=("CHARDONNAY", "CHARD ", " CHARD", " CH ", "CHARD"),
        description_terms=("chardonnay",),
        auto_product_type="Wine",
    ),
    "sauvignon blanc": Varietal(
        key="sauvignon blanc", label="Sauvignon Blanc",
        tokens=("SAUVIGNON BLANC", "SAUV BL", "SAUV BLANC", " SB ", "SB."),
        description_terms=("sauvignon blanc",),
        auto_product_type="Wine",
    ),
    "pinot grigio": Varietal(
        key="pinot grigio", label="Pinot Grigio / Gris",
        tokens=("PINOT GRIGIO", "PINOT GRIS", "P GRIG", "PINOT GR",
                " PG ", "PG."),
        description_terms=("pinot grigio", "pinot gris"),
        auto_product_type="Wine",
    ),
    "riesling": Varietal(
        key="riesling", label="Riesling",
        tokens=("RIESLING",),
        description_terms=("riesling",),
        auto_product_type="Wine",
    ),
    "viognier": Varietal(
        key="viognier", label="Viognier",
        tokens=("VIOGNIER",),
        description_terms=("viognier",),
        auto_product_type="Wine",
    ),
    "white blend": Varietal(
        key="white blend", label="White Blend",
        tokens=("WHITE BLEND", "WHITE WINE", "PROPRIETARY WHITE"),
        description_terms=("white blend",),
        auto_product_type="Wine",
    ),
    # ---- wine: rose / sparkling ----
    "rose": Varietal(
        key="rose", label="Rose",
        tokens=("ROSE", "ROSÉ"),
        description_terms=("rosé", "rose wine"),
        auto_product_type="Wine",
    ),
    "prosecco": Varietal(
        key="prosecco", label="Prosecco",
        tokens=("PROSECCO",),
        description_terms=("prosecco",),
        auto_product_type="Sparkling",
    ),
    "cava": Varietal(
        key="cava", label="Cava",
        tokens=("CAVA",),
        description_terms=("cava",),
        auto_product_type="Sparkling",
    ),
    "sparkling": Varietal(
        key="sparkling", label="Sparkling Wine",
        tokens=("SPARKLING", "BRUT", "BLANC DE BL", "BLANC DE NO"),
        description_terms=("sparkling wine", "champagne", "prosecco", "cava"),
        auto_product_type="Sparkling",
    ),
    # ---- spirits: whiskey family ----
    "bourbon": Varietal(
        key="bourbon", label="Bourbon",
        tokens=("BOURBON",),
        description_terms=("bourbon",),
        auto_product_type="Spirits",
    ),
    "rye": Varietal(
        key="rye", label="Rye Whiskey",
        tokens=("RYE WHISK", "RYE WSKY", " RYE ", "STRAIGHT RYE"),
        description_terms=("rye whiskey",),
        auto_product_type="Spirits",
    ),
    "scotch": Varietal(
        key="scotch", label="Scotch",
        tokens=("SCOTCH", "SCOT WHISK", "BLENDED SCOTCH"),
        description_terms=("scotch whisky", "scotch"),
        auto_product_type="Spirits",
    ),
    "single malt": Varietal(
        key="single malt", label="Single Malt",
        tokens=("SINGLE MALT", "SNGL MALT", "SGL MALT"),
        description_terms=("single malt",),
        auto_product_type="Spirits",
    ),
    "irish whiskey": Varietal(
        key="irish whiskey", label="Irish Whiskey",
        tokens=("IRISH WHISK", "IRISH WSKY", "JAMESON", "BUSHMILLS",
                "REDBREAST", "TULLAMORE"),
        description_terms=("irish whiskey",),
        auto_product_type="Spirits",
    ),
    "japanese whisky": Varietal(
        key="japanese whisky", label="Japanese Whisky",
        tokens=("JAPANESE WHIS", "HAKUSHU", "HIBIKI", "YAMAZAKI",
                "NIKKA", "TOKI"),
        description_terms=("japanese whisky",),
        auto_product_type="Spirits",
    ),
    "canadian whisky": Varietal(
        key="canadian whisky", label="Canadian Whisky",
        tokens=("CANADIAN WHIS", "CROWN ROYAL", "CANADIAN CLUB"),
        description_terms=("canadian whisky",),
        auto_product_type="Spirits",
    ),
    # ---- spirits: agave ----
    "tequila": Varietal(
        key="tequila", label="Tequila",
        tokens=("TEQUILA", " TEQ ", "TEQ."),
        description_terms=("tequila",),
        auto_product_type="Spirits",
    ),
    "blanco": Varietal(
        key="blanco", label="Blanco / Silver Tequila",
        tokens=("BLANCO", "SILVER TEQ", " PLATA"),
        description_terms=("blanco tequila", "silver tequila"),
        auto_product_type="Spirits",
    ),
    "reposado": Varietal(
        key="reposado", label="Reposado",
        tokens=("REPOSADO", " REPO "),
        description_terms=("reposado",),
        auto_product_type="Spirits",
    ),
    "anejo": Varietal(
        key="anejo", label="Anejo",
        tokens=("ANEJO", "AÑEJO", "EXTRA ANEJO", "EXTRA AÑEJO",
                "X ANEJO", "X AÑEJO"),
        description_terms=("añejo", "anejo"),
        auto_product_type="Spirits",
    ),
    "mezcal": Varietal(
        key="mezcal", label="Mezcal",
        tokens=("MEZCAL",),
        description_terms=("mezcal",),
        auto_product_type="Spirits",
    ),
    # ---- spirits: other ----
    "vodka": Varietal(
        key="vodka", label="Vodka",
        tokens=("VODKA", " VOD ", "VOD."),
        description_terms=("vodka",),
        auto_product_type="Spirits",
    ),
    "gin": Varietal(
        key="gin", label="Gin",
        tokens=("GIN ", " GIN", "LONDON DRY", "NAVY STR"),
        description_terms=("gin",),
        auto_product_type="Spirits",
    ),
    "rum": Varietal(
        key="rum", label="Rum",
        tokens=("RUM ", " RUM", "RHUM ", " RHUM"),
        description_terms=("rum",),
        auto_product_type="Spirits",
    ),
    "cognac": Varietal(
        key="cognac", label="Cognac",
        tokens=("COGNAC", " VS ", " VSOP", " XO ", "HENNESSY", "MARTELL",
                "REMY MARTIN", "COURVOISIER"),
        description_terms=("cognac",),
        auto_product_type="Spirits",
    ),
    "armagnac": Varietal(
        key="armagnac", label="Armagnac",
        tokens=("ARMAGNAC",),
        description_terms=("armagnac",),
        auto_product_type="Spirits",
    ),
    # ---- beer ----
    "ipa": Varietal(
        key="ipa", label="IPA",
        tokens=("IPA",),
        description_terms=("ipa", "india pale ale"),
        auto_product_type="Beer",
    ),
    "lager": Varietal(
        key="lager", label="Lager",
        tokens=("LAGER", "PILSNER", "PILSENER", "PILS "),
        description_terms=("lager", "pilsner"),
        auto_product_type="Beer",
    ),
    "stout": Varietal(
        key="stout", label="Stout / Porter",
        tokens=("STOUT", "PORTER"),
        description_terms=("stout", "porter"),
        auto_product_type="Beer",
    ),
    "sour": Varietal(
        key="sour", label="Sour Beer",
        tokens=("SOUR ", "GOSE", "BERLINER"),
        description_terms=("sour beer", "gose", "berliner weiss"),
        auto_product_type="Beer",
    ),
    "wheat beer": Varietal(
        key="wheat beer", label="Wheat Beer",
        tokens=("WHEAT", "HEFEWEIZEN", "WITBIER"),
        description_terms=("wheat beer", "hefeweizen"),
        auto_product_type="Beer",
    ),
}


# Natural variants that map to canonical keys above.
_ALIASES: dict[str, str] = {
    "cabernets": "cabernet", "cab sauv": "cabernet", "cab": "cabernet",
    "pinots": "pinot noir", "pn": "pinot noir",
    "chards": "chardonnay", "chard": "chardonnay",
    "sauv blanc": "sauvignon blanc", "sb": "sauvignon blanc",
    "p grigio": "pinot grigio", "pg": "pinot grigio",
    "zins": "zinfandel",
    "ipas": "ipa", "india pale ale": "ipa",
    "lagers": "lager", "pils": "lager", "pilsner": "lager",
    "stouts": "stout", "porters": "stout",
    "single malts": "single malt", "scotch single malt": "single malt",
    "bourbons": "bourbon",
    "tequilas": "tequila",
    "reposados": "reposado",
    "anejos": "anejo", "anejo tequila": "anejo",
    "blancos": "blanco", "silver": "blanco",
    "rums": "rum",
    "gins": "gin",
    "vodkas": "vodka",
    "irish": "irish whiskey", "japanese": "japanese whisky",
    "canadian": "canadian whisky",
    "champagne": "sparkling",   # champagne -> region filter handles geography; varietal collapses to sparkling
    "roses": "rose", "rosés": "rose",
}


def resolve_varietal(text: Optional[str]) -> Optional[Varietal]:
    """Map a free-text varietal/style phrase to a Varietal. Case-insensitive.
    Returns None if no known varietal resolves."""
    if not text:
        return None
    t = text.strip().lower()
    if not t:
        return None
    if t in _VARIETALS:
        return _VARIETALS[t]
    if t in _ALIASES:
        return _VARIETALS[_ALIASES[t]]
    # Longest alias / key wins so e.g. "pinot grigio" beats "pinot noir"
    # when the input is "pinot grigio".
    for alias in sorted(_ALIASES.keys(), key=len, reverse=True):
        if alias in t:
            return _VARIETALS[_ALIASES[alias]]
    for key in sorted(_VARIETALS.keys(), key=len, reverse=True):
        if key in t:
            return _VARIETALS[key]
    return None


def build_varietal_filter(
    varietal_hint: Optional[str], *, name_col: str = "product_name",
    upc_col: str = "upc",
) -> tuple[Optional[str], dict, Optional[str]]:
    """Return (sql_clause, params, auto_product_type) for a varietal filter.

    Shape mirrors backend.region_semantics.build_region_filter: a SQL OR of
    product-name LIKE matches plus EXISTS subqueries into product_enrichment
    for the description fallback. Returns None when no varietal resolves.
    """
    v = resolve_varietal(varietal_hint)
    if v is None:
        return None, {}, None
    parts: list[str] = []
    params: dict = {}
    for i, tok in enumerate(v.tokens):
        key = f"var_{v.key.replace(' ', '_').replace('-', '_')}_n_{i}"
        params[key] = f"%{tok}%"
        parts.append(f"UPPER({name_col}) LIKE ${key}")
    if v.description_terms:
        for i, term in enumerate(v.description_terms):
            key = f"var_{v.key.replace(' ', '_').replace('-', '_')}_d_{i}"
            params[key] = f"%{term}%"
            parts.append(
                f"EXISTS (SELECT 1 FROM product_enrichment pe "
                f"WHERE LTRIM(CAST(pe.upc AS VARCHAR), '0') = LTRIM(CAST({upc_col} AS VARCHAR), '0') "
                f"AND LOWER(COALESCE(pe.description, '')) LIKE ${key})"
            )
    if not parts:
        return None, {}, None
    return "(" + " OR ".join(parts) + ")", params, v.auto_product_type


def known_varietal_keys() -> list[str]:
    """Canonical varietal keys, exposed in the assistant's tool schema."""
    return sorted(_VARIETALS.keys())
