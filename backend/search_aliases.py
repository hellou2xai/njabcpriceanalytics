"""Smarter product search: map the shorthand and nicknames retailers actually type
to the real brand terms, so "JW Blue" or "Johnnie Blue" finds Johnnie Walker Blue
Label, "Henny" finds Hennessy, "GG" finds Grey Goose, and so on.

How it is used (see backend/routers/catalog.py search): the typed query is split
into tokens; each token matches the product name OR brand, AND every token must
match. For a token that is an alias, we ALSO accept its expansion (e.g. "jw" ->
"johnnie" AND "walker"), so the literal text and the brand both work.

Derivation is two-layered and AI-assisted:
  1) CURATED below: an AI-derived table of common spirits/wine shorthand. Extend it
     freely, or regenerate from the live brand list with scripts/derive_search_aliases.py
     (which asks Claude for aliases of the brands actually in the catalogue).
  2) build_brand_initialisms(): for every multi-word brand in the catalogue we
     auto-derive its initialism (e.g. "Grey Goose" -> "gg", "Wild Turkey" -> "wt"),
     so even brands not in the curated table get an abbreviation alias for free.
"""
from __future__ import annotations

# token (lowercase, as typed) -> canonical phrase it expands to
CURATED: dict[str, str] = {
    # Scotch / whisky. Johnnie Walker is listed in the catalogue as J WALKER /
    # JOHN WALKER, so we match those phrases (not the bare word "walker", which
    # would also pull in Hiram Walker).
    "jw": ["johnnie walker", "john walker", "j walker"],
    "johnnie": ["johnnie walker", "john walker", "j walker"],
    "johnny": ["johnnie walker", "john walker", "j walker"],
    "mac": "macallan", "fiddich": "glenfiddich", "livet": "glenlivet",
    "chivas": "chivas regal", "monkey": "monkey shoulder",
    "laga": "lagavulin", "laph": "laphroaig", "dewars": "dewars",
    "johnnie blue": "johnnie walker blue", "jw blue": "johnnie walker blue",
    # Irish
    "jamo": "jameson", "jameson": "jameson", "redbreast": "redbreast",
    # Bourbon / American
    "jack": "jack daniels", "jd": "jack daniels", "jb": "jim beam",
    "makers": "makers mark", "mm": "makers mark", "woodford": "woodford reserve",
    "buffalo": "buffalo trace", "bt": "buffalo trace", "blantons": "blantons",
    "bulleit": "bulleit", "knob": "knob creek", "wt": "wild turkey",
    "eagle": "eagle rare", "weller": "weller", "crown": "crown royal", "cr": "crown royal",
    "gentleman": "gentleman jack",
    # Cognac
    "henny": "hennessy", "remy": "remy martin", "vsop": "vsop", "xo": "xo",
    # Tequila / mezcal
    "dj": "don julio", "don julio 1942": "don julio 1942", "1942": "don julio 1942",
    "patron": "patron", "casa": "casamigos", "clase": "clase azul",
    "espolon": "espolon", "herradura": "herradura", "1800": "1800 tequila",
    # Vodka
    "gg": "grey goose", "goose": "grey goose", "tito": "titos", "titos": "titos",
    "ketel": "ketel one", "belvedere": "belvedere", "ciroc": "ciroc",
    # Gin
    "bombay": "bombay sapphire", "tanq": "tanqueray", "hendricks": "hendricks",
    "beefeater": "beefeater",
    # Rum
    "captain": "captain morgan", "cm": "captain morgan", "kraken": "kraken",
    "malibu": "malibu", "bacardi": "bacardi",
    # Liqueur / aperitif
    "baileys": "baileys", "bailey": "baileys", "kahlua": "kahlua",
    "jager": "jagermeister", "jag": "jagermeister", "aperol": "aperol",
    "campari": "campari", "gm": "grand marnier", "cointreau": "cointreau",
    "fireball": "fireball",
    # Champagne / sparkling / wine
    "dom": "dom perignon", "veuve": "veuve clicquot", "vc": "veuve clicquot",
    "moet": "moet chandon", "caymus": "caymus", "josh": "josh cellars",
    "meiomi": "meiomi", "kim": "kim crawford", "la marca": "la marca",
    "whispering": "whispering angel",
}

# Words too generic to treat as a brand initialism (avoid junk like "rye" -> a brand).
_STOP = {"the", "and", "of", "co", "inc", "ltd", "llc", "spirits", "wine", "wines",
         "vineyards", "distillery", "company", "brands", "imports"}


def build_brand_initialisms(brands) -> dict[str, str]:
    """Auto-derive an initialism alias for every multi-word brand in the catalogue,
    e.g. 'Grey Goose' -> {'gg': 'grey goose'}. Skips one-word brands and ambiguous
    collisions (an initialism that maps to two different brands is dropped)."""
    seen: dict[str, str] = {}
    clash: set[str] = set()
    for b in brands or []:
        if not b:
            continue
        words = [w for w in str(b).lower().split() if w.isalpha() and w not in _STOP]
        if len(words) < 2:
            continue
        initials = "".join(w[0] for w in words[:4])
        if not (2 <= len(initials) <= 5):
            continue
        phrase = " ".join(words)
        if initials in seen and seen[initials] != phrase:
            clash.add(initials)
        else:
            seen[initials] = phrase
    for k in clash:
        seen.pop(k, None)
    return seen


def expansion_for(token: str, extra: dict[str, str] | None = None) -> list[str] | None:
    """Return the expansion PHRASES for an aliased query token, or None. Each phrase
    is matched contiguously against the product name/brand (so "john walker" excludes
    "Hiram Walker"). Curated entries win over auto-derived initialisms."""
    t = (token or "").strip().lower()
    if not t:
        return None
    val = CURATED.get(t)
    if val is None:
        val = (extra or {}).get(t)
    if not val:
        return None
    phrases = val if isinstance(val, list) else [val]
    out = [p for p in phrases if p and p != t]   # skip a phrase that's just the token
    return out or None
