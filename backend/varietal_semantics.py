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
    `category_path_terms` match the Go-UPC structured category leaf
    (e.g. varietal=whiskey -> category_path contains "Whiskey"), which is
    far more reliable than name substring for SKUs whose product name is
    pure brand ("BUFFALO TRACE" -> category_path leaf "Whiskey").
    `auto_product_type` is the implied product_type, applied when the
    caller didn't pass their own (e.g. varietal=ipa -> Beer).
    """
    key: str
    label: str
    tokens: tuple[str, ...]
    description_terms: tuple[str, ...] = field(default_factory=tuple)
    category_path_terms: tuple[str, ...] = field(default_factory=tuple)
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
    # The 'whiskey' bucket itself — for "show me whiskey" queries that don't
    # specify bourbon/scotch/rye. Anchored on the Go-UPC category leaf.
    "whiskey": Varietal(
        key="whiskey", label="Whiskey (all)",
        tokens=("WHISKEY", "WHISKY", "WHISK ", "WSKY"),
        description_terms=("whiskey", "whisky"),
        category_path_terms=("Whiskey",),
        auto_product_type="Spirits",
    ),
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
    "tennessee whiskey": Varietal(
        key="tennessee whiskey", label="Tennessee Whiskey",
        tokens=("TENNESSEE WHIS", "JACK DANIEL", "GEORGE DICKEL"),
        description_terms=("tennessee whiskey",),
        auto_product_type="Spirits",
    ),
    "wheated bourbon": Varietal(
        key="wheated bourbon", label="Wheated Bourbon",
        tokens=("WHEAT BOURBON", "WEATHER BOURBON", "MAKER'S MARK",
                "WHEATED"),
        description_terms=("wheated bourbon",),
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
    # Scotch sub-styles - islay/speyside/highland are commonly asked for.
    "islay scotch": Varietal(
        key="islay scotch", label="Islay Scotch",
        tokens=("ISLAY",),
        description_terms=("islay", "peated"),
        auto_product_type="Spirits",
    ),
    "speyside scotch": Varietal(
        key="speyside scotch", label="Speyside Scotch",
        tokens=("SPEYSIDE",),
        description_terms=("speyside",),
        auto_product_type="Spirits",
    ),
    "highland scotch": Varietal(
        key="highland scotch", label="Highland Scotch",
        tokens=("HIGHLAND",),
        description_terms=("highland scotch", "highland single malt"),
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
        category_path_terms=("Tequila",),
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
        tokens=("ANEJO", "AÑEJO"),
        description_terms=("añejo", "anejo"),
        auto_product_type="Spirits",
    ),
    "extra anejo": Varietal(
        key="extra anejo", label="Extra Anejo",
        tokens=("EXTRA ANEJO", "EXTRA AÑEJO", "X ANEJO", "X AÑEJO",
                "XANEJO"),
        description_terms=("extra anejo", "extra añejo"),
        auto_product_type="Spirits",
    ),
    "cristalino": Varietal(
        key="cristalino", label="Cristalino Tequila",
        tokens=("CRISTALINO",),
        description_terms=("cristalino",),
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
        category_path_terms=("Vodka",),
        auto_product_type="Spirits",
    ),
    "gin": Varietal(
        key="gin", label="Gin",
        tokens=("GIN ", " GIN", "LONDON DRY"),
        description_terms=("gin", "london dry"),
        category_path_terms=("Gin",),
        auto_product_type="Spirits",
    ),
    "navy strength gin": Varietal(
        key="navy strength gin", label="Navy-Strength Gin",
        tokens=("NAVY STR", "NAVY-STR"),
        description_terms=("navy strength",),
        auto_product_type="Spirits",
    ),
    "rum": Varietal(
        key="rum", label="Rum",
        tokens=("RUM ", " RUM", "RHUM ", " RHUM"),
        description_terms=("rum",),
        category_path_terms=("Rum",),
        auto_product_type="Spirits",
    ),
    "overproof rum": Varietal(
        key="overproof rum", label="Overproof Rum",
        tokens=("OVERPROOF", "151 ", "151PROOF"),
        description_terms=("overproof rum",),
        auto_product_type="Spirits",
    ),
    "brandy": Varietal(
        key="brandy", label="Brandy",
        tokens=("BRANDY",),
        description_terms=("brandy",),
        category_path_terms=("Brandy",),
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
    "liqueur": Varietal(
        key="liqueur", label="Liqueurs",
        tokens=("LIQUEUR", "CREME DE", "CREAM LIQ"),
        description_terms=("liqueur",),
        category_path_terms=("Liqueurs",),
        auto_product_type="Spirits",
    ),
    "amaro": Varietal(
        key="amaro", label="Amaro / Italian Bitter",
        tokens=("AMARO", "AMARI", "AVERNA", "FERNET", "MONTENEGRO",
                "RAMAZZOTTI", "BRAULIO"),
        description_terms=("amaro", "italian bitter"),
        auto_product_type="Spirits",
    ),
    "aperitif": Varietal(
        key="aperitif", label="Aperitif",
        tokens=("APEROL", "CAMPARI", "LILLET", "SUZE", "APERITIF"),
        description_terms=("aperitif",),
        auto_product_type="Spirits",
    ),
    "vermouth": Varietal(
        key="vermouth", label="Vermouth",
        tokens=("VERMOUTH",),
        description_terms=("vermouth",),
        auto_product_type="Vermouth",
    ),
    "bitter": Varietal(
        key="bitter", label="Bitters",
        tokens=("BITTERS", " BITTER", "ANGOSTURA", "PEYCHAUD"),
        description_terms=("bitters",),
        category_path_terms=("Bitters",),
        auto_product_type="Spirits",
    ),
    "single barrel": Varietal(
        key="single barrel", label="Single Barrel",
        tokens=("SINGLE BARREL", "SNGL BARREL"),
        description_terms=("single barrel",),
        auto_product_type="Spirits",
    ),
    "small batch": Varietal(
        key="small batch", label="Small Batch",
        tokens=("SMALL BATCH",),
        description_terms=("small batch",),
        auto_product_type="Spirits",
    ),
    "cask strength": Varietal(
        key="cask strength", label="Cask Strength",
        tokens=("CASK STR", "BARREL PROOF", "BARREL STR"),
        description_terms=("cask strength", "barrel proof"),
        auto_product_type="Spirits",
    ),
    "bottled in bond": Varietal(
        key="bottled in bond", label="Bottled-in-Bond",
        tokens=("BOTTLED IN BOND", "BTLD IN BOND", "BIB ", "100 PROOF BIB"),
        description_terms=("bottled-in-bond", "bottled in bond"),
        auto_product_type="Spirits",
    ),
    # ---- wine: style / production ----
    "old vine": Varietal(
        key="old vine", label="Old Vine",
        tokens=("OLD VINE", "OV ZIN"),
        description_terms=("old vine",),
        auto_product_type="Wine",
    ),
    "reserva": Varietal(
        key="reserva", label="Reserva",
        tokens=("RESERVA", "RES "),
        description_terms=("reserva",),
        auto_product_type="Wine",
    ),
    "gran reserva": Varietal(
        key="gran reserva", label="Gran Reserva",
        tokens=("GRAN RESERVA", "GRAN RES"),
        description_terms=("gran reserva",),
        auto_product_type="Wine",
    ),
    "biodynamic": Varietal(
        key="biodynamic", label="Biodynamic",
        tokens=("BIODYNAMIC",),
        description_terms=("biodynamic",),
        auto_product_type="Wine",
    ),
    "organic wine": Varietal(
        key="organic wine", label="Organic Wine",
        tokens=("ORGANIC",),
        description_terms=("organic wine", "certified organic"),
        auto_product_type="Wine",
    ),
    "natural wine": Varietal(
        key="natural wine", label="Natural Wine",
        tokens=("NATURAL WINE", "NAT WINE"),
        description_terms=("natural wine",),
        auto_product_type="Wine",
    ),
    "orange wine": Varietal(
        key="orange wine", label="Orange Wine",
        tokens=("ORANGE WINE", "SKIN CONTACT"),
        description_terms=("orange wine", "skin contact"),
        auto_product_type="Wine",
    ),
    "blanc de blancs": Varietal(
        key="blanc de blancs", label="Blanc de Blancs",
        tokens=("BLANC DE BL", "BDB"),
        description_terms=("blanc de blancs",),
        auto_product_type="Sparkling",
    ),
    "blanc de noirs": Varietal(
        key="blanc de noirs", label="Blanc de Noirs",
        tokens=("BLANC DE NO", "BDN"),
        description_terms=("blanc de noirs",),
        auto_product_type="Sparkling",
    ),
    "brut nature": Varietal(
        key="brut nature", label="Brut Nature",
        tokens=("BRUT NATURE", "EXTRA BRUT"),
        description_terms=("brut nature", "extra brut"),
        auto_product_type="Sparkling",
    ),
    "late harvest": Varietal(
        key="late harvest", label="Late Harvest / Dessert",
        tokens=("LATE HARVEST", "ICE WINE", "ICEWINE", "TBA", "BEERENAUSLESE"),
        description_terms=("late harvest", "dessert wine", "ice wine"),
        auto_product_type="Wine",
    ),
    # ---- beer ----
    "ipa": Varietal(
        key="ipa", label="IPA",
        tokens=("IPA",),
        description_terms=("ipa", "india pale ale"),
        auto_product_type="Beer",
    ),
    "double ipa": Varietal(
        key="double ipa", label="Double / Imperial IPA",
        tokens=("DBL IPA", "DOUBLE IPA", "IMPERIAL IPA", "DIPA"),
        description_terms=("double ipa", "imperial ipa", "dipa"),
        auto_product_type="Beer",
    ),
    "hazy ipa": Varietal(
        key="hazy ipa", label="Hazy / NEIPA",
        tokens=("HAZY IPA", "HAZY", "NEIPA", "NE IPA"),
        description_terms=("hazy ipa", "new england ipa"),
        auto_product_type="Beer",
    ),
    "session ipa": Varietal(
        key="session ipa", label="Session IPA",
        tokens=("SESSION IPA", "SESSION"),
        description_terms=("session ipa",),
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
    "imperial stout": Varietal(
        key="imperial stout", label="Imperial Stout",
        tokens=("IMPERIAL STOUT", "RUSSIAN IMP"),
        description_terms=("imperial stout", "russian imperial"),
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
        tokens=("WHEAT", "HEFEWEIZEN", "WITBIER", "HEFE"),
        description_terms=("wheat beer", "hefeweizen", "witbier"),
        auto_product_type="Beer",
    ),
    "saison": Varietal(
        key="saison", label="Saison",
        tokens=("SAISON", "FARMHOUSE"),
        description_terms=("saison", "farmhouse ale"),
        auto_product_type="Beer",
    ),
    "kolsch": Varietal(
        key="kolsch", label="Kolsch",
        tokens=("KOLSCH", "KÖLSCH"),
        description_terms=("kölsch", "kolsch"),
        auto_product_type="Beer",
    ),
    "belgian": Varietal(
        key="belgian", label="Belgian Style",
        tokens=("BELGIAN", "TRIPEL", "DUBBEL", "QUADRUPEL"),
        description_terms=("belgian", "tripel", "dubbel"),
        auto_product_type="Beer",
    ),
    # ---- other categories ----
    "hard cider": Varietal(
        key="hard cider", label="Hard Cider",
        tokens=("CIDER", "HARD CIDER"),
        description_terms=("hard cider",),
        category_path_terms=("Hard Cider",),
        auto_product_type="Cider",
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
    "neipa": "hazy ipa", "ne ipa": "hazy ipa", "hazy": "hazy ipa",
    "dipa": "double ipa", "imperial ipa": "double ipa",
    "imperial stouts": "imperial stout", "rauchbier": "imperial stout",
    "lagers": "lager", "pils": "lager", "pilsner": "lager", "pilsners": "lager",
    "stouts": "stout", "porters": "stout",
    "single malts": "single malt", "scotch single malt": "single malt",
    "islay": "islay scotch", "peated scotch": "islay scotch",
    "speyside": "speyside scotch",
    "highland": "highland scotch",
    "whiskeys": "whiskey", "whiskies": "whiskey", "whisky": "whiskey",
    "tennessee": "tennessee whiskey", "tennessee bourbon": "tennessee whiskey",
    "wheated": "wheated bourbon",
    "bourbons": "bourbon",
    "tequilas": "tequila",
    "reposados": "reposado",
    "anejos": "anejo", "anejo tequila": "anejo", "añejo": "anejo",
    "xanejo": "extra anejo", "x anejo": "extra anejo",
    "extra añejo": "extra anejo",
    "cristalinos": "cristalino",
    "mezcals": "mezcal", "mescal": "mezcal",
    "blancos": "blanco", "silver": "blanco",
    "rums": "rum",
    "overproof": "overproof rum", "151": "overproof rum",
    "gins": "gin", "london dry gin": "gin",
    "navy strength": "navy strength gin",
    "vodkas": "vodka",
    "brandies": "brandy",
    "liqueurs": "liqueur", "cordial": "liqueur",
    "amari": "amaro", "italian bitter": "amaro",
    "aperitifs": "aperitif",
    "vermouths": "vermouth",
    "bitters": "bitter", "amaro bitters": "bitter",
    "sb whiskey": "single barrel", "sngl bbl": "single barrel",
    "small batches": "small batch",
    "cask str": "cask strength", "barrel proof": "cask strength",
    "bib": "bottled in bond",
    "old vines": "old vine",
    "reservas": "reserva",
    "gran reservas": "gran reserva",
    "biodynamics": "biodynamic", "bio wine": "biodynamic",
    "organic": "organic wine",
    "natural": "natural wine", "low intervention": "natural wine",
    "skin contact": "orange wine", "amber wine": "orange wine",
    "bdb": "blanc de blancs", "blanc de blanc": "blanc de blancs",
    "bdn": "blanc de noirs", "blanc de noir": "blanc de noirs",
    "extra brut": "brut nature",
    "dessert wine": "late harvest", "ice wine": "late harvest", "icewine": "late harvest",
    "irish": "irish whiskey", "japanese": "japanese whisky",
    "canadian": "canadian whisky",
    "champagne": "sparkling",   # champagne -> region filter handles geography; varietal collapses to sparkling
    "roses": "rose", "rosés": "rose",
    "cider": "hard cider", "ciders": "hard cider",
    "saisons": "saison", "farmhouse ale": "saison",
    "kölsch": "kolsch",
    "wheat ale": "wheat beer", "hefeweizen": "wheat beer", "witbier": "wheat beer",
    "belgian ale": "belgian", "tripel": "belgian", "dubbel": "belgian",
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
    vkey = v.key.replace(" ", "_").replace("-", "_")
    for i, tok in enumerate(v.tokens):
        key = f"var_{vkey}_n_{i}"
        params[key] = f"%{tok}%"
        parts.append(f"UPPER({name_col}) LIKE ${key}")
    if v.description_terms:
        for i, term in enumerate(v.description_terms):
            key = f"var_{vkey}_d_{i}"
            params[key] = f"%{term}%"
            parts.append(
                f"EXISTS (SELECT 1 FROM product_enrichment pe "
                f"WHERE LTRIM(CAST(pe.upc AS VARCHAR), '0') = LTRIM(CAST({upc_col} AS VARCHAR), '0') "
                f"AND LOWER(COALESCE(pe.description, '')) LIKE ${key})"
            )
    if v.category_path_terms:
        # Match the Go-UPC structured category leaf (e.g. "Whiskey", "Vodka",
        # "Liqueurs"). category_path is a JSON-array text — '%"Whiskey"%'
        # picks the leaf cleanly without false-positives on prefix words.
        for i, term in enumerate(v.category_path_terms):
            key = f"var_{vkey}_c_{i}"
            params[key] = f'%"{term}"%'
            parts.append(
                f"EXISTS (SELECT 1 FROM product_enrichment pe "
                f"WHERE LTRIM(CAST(pe.upc AS VARCHAR), '0') = LTRIM(CAST({upc_col} AS VARCHAR), '0') "
                f"AND pe.category_path LIKE ${key})"
            )
    if not parts:
        return None, {}, None
    return "(" + " OR ".join(parts) + ")", params, v.auto_product_type


def known_varietal_keys() -> list[str]:
    """Canonical varietal keys, exposed in the assistant's tool schema."""
    return sorted(_VARIETALS.keys())


# Generic words that carry no varietal signal on their own; when only these
# remain after pulling the varietal phrase out, the query is a clean style
# browse ("malbec", "bourbon", "ipa") rather than a brand-plus-category
# search ("absolut vodka", which must stay literal so it finds ABSOLUT, not
# every vodka).
_STYLE_GENERIC: frozenset[str] = frozenset({
    "wine", "wines", "red", "reds", "white", "whites", "rose", "roses",
    "sparkling", "whiskey", "whisky", "spirit", "spirits", "the", "a", "an",
    "of", "from", "and", "bottle", "bottles",
})


def route_varietal_browse(text: Optional[str]) -> Optional[str]:
    """Decide whether free-text `text` is a pure varietal/style browse.

    Returns the canonical varietal key (e.g. "malbec", "bourbon", "ipa") ONLY
    when removing the varietal phrase + generic words leaves nothing
    meaningful, so "cabernet", "pinot noir", "bourbon" route to the structured
    varietal filter while "absolut vodka" / "tito's" keep the literal search.
    Returns None when the query is not a clean style browse.
    """
    import re as _re
    v = resolve_varietal(text)
    if v is None or not text:
        return None
    leftover = text.lower()
    for phrase in sorted(set(_VARIETALS) | set(_ALIASES), key=len, reverse=True):
        if phrase in leftover:
            leftover = leftover.replace(phrase, " ")
    toks = [w for w in _re.split(r"[^a-z0-9]+", leftover) if w]
    residual = [w for w in toks if w not in _STYLE_GENERIC]
    return v.key if not residual else None
