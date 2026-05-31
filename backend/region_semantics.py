"""Region / origin semantic filter.

The catalog and the assistant accept a free-text `region` hint (e.g.
"california", "napa", "bordeaux", "tuscany"). This module:

1. Maps each known hint to a canonical set of TOKENS to look for inside the
   product NAME (the most reliable signal — names like "NAPA CAB SAUV",
   "BERONIA RIOJA", "ANTINORI TIGNANELLO" carry the region directly).
2. Builds a SQL predicate the catalog router can drop straight into its
   WHERE clause. The predicate also OPTIONALLY joins to product_enrichment
   so descriptive fields like "A Napa Valley red" still match even when the
   product name doesn't carry the region token.

Why this exists: the Go-UPC `region` column on product_enrichment only has
two values ("USA or Canada" / "Outside of North America"). Sub-region
("California", "Tuscany") is not surfaced anywhere structured, so the
filter has to be derived from product name + description text.

The expected caller flow:
    from backend.region_semantics import build_region_filter
    clause, params, auto_product_type = build_region_filter("california")
    if clause:
        where.append(clause); param_dict.update(params)
        if auto_product_type and not product_type:
            product_type = auto_product_type   # auto-narrow to Wine
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass(frozen=True)
class Region:
    """One region hint and its name-token whitelist.

    `tokens` are matched case-insensitively against the product NAME via
    `UPPER(product_name) LIKE '%TOKEN%'`. They're chosen to be specific
    enough that they don't false-positive against unrelated SKUs (e.g.
    'CAB' alone matches Cabernet broadly and would be a bad token; 'NAPA'
    is unambiguous).
    `auto_product_type` (e.g. "Wine") is applied when the user didn't pass
    their own product_type, so "california" doesn't return ABSOLUT vodka.
    `description_terms` are looser substrings searched inside the enrichment
    description field — useful when the name is opaque ("Schrader CCS 2018")
    but the description spells out "Napa Valley".
    """

    key: str
    label: str
    tokens: tuple[str, ...]
    description_terms: tuple[str, ...] = field(default_factory=tuple)
    auto_product_type: Optional[str] = None


# Each entry below is the answer to ONE natural-language phrase ("California
# wines", "Bordeaux reds", "Tuscan reds"). Add new regions here; the catalog
# filter picks them up automatically. Tokens are the high-precision name
# fragments; description_terms are looser substrings for enrichment fallback.

_REGIONS: dict[str, Region] = {
    "california": Region(
        key="california",
        label="California",
        tokens=("CALIF", "NAPA", "SONOMA", "PASO", "MENDOCINO", "MONTEREY",
                "CARNEROS", "RUSSIAN RIVER", "ALEXANDER VALL", "DRY CREEK",
                "SANTA BARB", "SANTA RITA", "SANTA YNEZ", "STAGS LEAP",
                "OAKVILLE", "RUTHERFORD", "HOWELL MTN", "SPRING MTN",
                "MT VEEDER", "ANDERSON VALL", "EDNA VALL", "LODI",
                "TEMECULA", "CENTRAL COAST", "SIERRA FOOTHILLS"),
        description_terms=("california", "napa valley", "sonoma", "paso robles",
                           "central coast"),
        auto_product_type="Wine",
    ),
    "napa": Region(
        key="napa",
        label="Napa",
        tokens=("NAPA", "OAKVILLE", "RUTHERFORD", "STAGS LEAP",
                "HOWELL MTN", "SPRING MTN", "MT VEEDER", "CARNEROS"),
        description_terms=("napa valley", "oakville", "rutherford"),
        auto_product_type="Wine",
    ),
    "sonoma": Region(
        key="sonoma",
        label="Sonoma",
        tokens=("SONOMA", "RUSSIAN RIVER", "DRY CREEK", "ALEXANDER VALL",
                "CHALK HILL", "BENNETT VALL", "KNIGHTS VALL"),
        description_terms=("sonoma", "russian river"),
        auto_product_type="Wine",
    ),
    "oregon": Region(
        key="oregon",
        label="Oregon",
        tokens=("OREGON", "WILLAMETTE", "ROGUE VALL", "UMPQUA"),
        description_terms=("oregon", "willamette"),
        auto_product_type="Wine",
    ),
    "washington": Region(
        key="washington",
        label="Washington",
        tokens=("WASHINGTON", "WALLA WALLA", "COLUMBIA VALL", "YAKIMA"),
        description_terms=("washington state", "walla walla", "columbia valley"),
        auto_product_type="Wine",
    ),
    "bordeaux": Region(
        key="bordeaux",
        label="Bordeaux",
        tokens=("BORDEAUX", "MARGAUX", "ST EMILION", "ST-EMILION",
                "PAUILLAC", "ST ESTEPHE", "ST-ESTEPHE", "ST JULIEN",
                "POMEROL", "GRAVES", "MEDOC", "SAUTERNES", "MOULIS",
                "PESSAC", "LISTRAC", "FRONSAC"),
        description_terms=("bordeaux", "margaux", "pauillac", "st-emilion"),
        auto_product_type="Wine",
    ),
    "burgundy": Region(
        key="burgundy",
        label="Burgundy",
        tokens=("BURGUNDY", "BOURGOGNE", "BEAUNE", "POMMARD", "VOLNAY",
                "MEURSAULT", "MONTRACHET", "CHABLIS", "GEVREY", "MOREY",
                "VOSNE", "NUITS", "MACON", "POUILLY-FUISSE", "RULLY"),
        description_terms=("burgundy", "bourgogne", "cote de", "cote-de"),
        auto_product_type="Wine",
    ),
    "tuscany": Region(
        key="tuscany",
        label="Tuscany",
        tokens=("TUSCAN", "BRUNELLO", "MONTALCINO", "MONTEPULCIANO",
                "CHIANTI", "BOLGHERI", "SUPER TUSCAN", "VINO NOBILE",
                "MAREMMA", "MORELLINO"),
        description_terms=("tuscan", "tuscany", "brunello", "chianti", "bolgheri"),
        auto_product_type="Wine",
    ),
    "piedmont": Region(
        key="piedmont",
        label="Piedmont",
        tokens=("PIEDMONT", "BAROLO", "BARBARESCO", "BARBERA D",
                "DOLCETTO D", "LANGHE", "ROERO", "ASTI", "GAVI"),
        description_terms=("piedmont", "piemonte", "barolo", "barbaresco", "langhe"),
        auto_product_type="Wine",
    ),
    "rioja": Region(
        key="rioja",
        label="Rioja",
        tokens=("RIOJA",),
        description_terms=("rioja",),
        auto_product_type="Wine",
    ),
    "champagne": Region(
        key="champagne",
        label="Champagne",
        tokens=("CHAMPAGNE", "EPERNAY", "REIMS", "MONTAGNE DE REIMS",
                "COTE DES BLANCS"),
        description_terms=("champagne",),
        auto_product_type="Sparkling",
    ),
    "italy": Region(
        key="italy",
        label="Italy",
        tokens=("ITALIAN", "ITALY", "TUSCAN", "BRUNELLO", "CHIANTI",
                "BAROLO", "BARBARESCO", "BARBERA", "MONTEPULCIANO",
                "PIEDMONT", "BOLGHERI", "VENETO", "SOAVE", "VALPOLICELLA",
                "AMARONE", "PROSECCO", "LAMBRUSCO", "FRIULI", "SICILIA",
                "ETNA", "PUGLIA", "ABRUZZO", "MARCHE"),
        description_terms=("italian", "italy", "tuscany", "piedmont", "veneto"),
        auto_product_type="Wine",
    ),
    "france": Region(
        key="france",
        label="France",
        tokens=("FRENCH", "FRANCE", "BORDEAUX", "BURGUNDY", "BOURGOGNE",
                "CHAMPAGNE", "RHONE", "PROVENCE", "LOIRE", "ALSACE",
                "LANGUEDOC", "BEAUJOLAIS", "SANCERRE", "POUILLY",
                "CHATEAUNEUF", "COTES DU RHONE", "COTES DE PROVENCE"),
        description_terms=("french", "france", "bordeaux", "burgundy", "loire",
                           "rhone"),
        auto_product_type="Wine",
    ),
    "spain": Region(
        key="spain",
        label="Spain",
        tokens=("SPAIN", "SPANISH", "RIOJA", "RIBERA DEL DUERO",
                "PRIORAT", "ALBARINO", "RIAS BAIXAS", "TORO", "JEREZ",
                "SHERRY", "CAVA"),
        description_terms=("spain", "spanish", "rioja", "ribera del duero"),
        auto_product_type="Wine",
    ),
    "argentina": Region(
        key="argentina",
        label="Argentina",
        tokens=("ARGENTINA", "ARGENTINE", "MENDOZA", "MALBEC", "UCO"),
        description_terms=("argentina", "argentine", "mendoza"),
        auto_product_type="Wine",
    ),
    "chile": Region(
        key="chile",
        label="Chile",
        tokens=("CHILE", "CHILEAN", "MAIPO", "COLCHAGUA", "CASABLANCA",
                "ACONCAGUA"),
        description_terms=("chile", "chilean", "maipo", "colchagua"),
        auto_product_type="Wine",
    ),
    "australia": Region(
        key="australia",
        label="Australia",
        tokens=("AUSTRALIA", "AUSTRALIAN", "BAROSSA", "MCLAREN VALE",
                "MARGARET RIVER", "HUNTER VALL", "YARRA VALL", "COONAWARRA"),
        description_terms=("australia", "australian", "barossa", "mclaren vale"),
        auto_product_type="Wine",
    ),
    "new zealand": Region(
        key="new zealand",
        label="New Zealand",
        tokens=("NEW ZEALAND", "NZ", "MARLBOROUGH", "CENTRAL OTAGO",
                "HAWKES BAY"),
        description_terms=("new zealand", "marlborough", "central otago"),
        auto_product_type="Wine",
    ),
    "germany": Region(
        key="germany",
        label="Germany",
        tokens=("GERMAN", "GERMANY", "MOSEL", "RHEINGAU", "PFALZ",
                "RHEINHESSEN", "BADEN"),
        description_terms=("german", "germany", "mosel", "rheingau"),
        auto_product_type="Wine",
    ),
    "portugal": Region(
        key="portugal",
        label="Portugal",
        tokens=("PORTUG", "DOURO", "DAO", "ALENTEJO", "PORT",
                "MADEIRA", "VINHO VERDE"),
        description_terms=("portuguese", "portugal", "douro", "alentejo"),
        auto_product_type="Wine",
    ),
    "kentucky": Region(
        key="kentucky",
        label="Kentucky",
        tokens=("KENTUCKY", "BOURBON",),
        description_terms=("kentucky bourbon", "kentucky straight"),
        auto_product_type="Spirits",
    ),
    "scotland": Region(
        key="scotland",
        label="Scotland",
        tokens=("SCOTCH", "SCOTLAND", "ISLAY", "SPEYSIDE", "HIGHLAND",
                "LOWLAND", "CAMPBELTOWN"),
        description_terms=("scotch", "scotland", "islay", "speyside"),
        auto_product_type="Spirits",
    ),
    "ireland": Region(
        key="ireland",
        label="Ireland",
        tokens=("IRISH", "IRELAND", "JAMESON", "BUSHMILLS"),
        description_terms=("irish whiskey", "ireland"),
        auto_product_type="Spirits",
    ),
    "japan": Region(
        key="japan",
        label="Japan",
        tokens=("JAPANESE", "JAPAN", "HAKUSHU", "HIBIKI",
                "YAMAZAKI", "NIKKA", "SUNTORY"),
        description_terms=("japanese whisky", "japan"),
        auto_product_type="Spirits",
    ),
    "mexico": Region(
        key="mexico",
        label="Mexico",
        tokens=("MEXICAN", "MEXICO", "JALISCO", "OAXACA"),
        description_terms=("mexican", "tequila", "mezcal"),
        auto_product_type="Spirits",
    ),
}


# Common alias phrasings that aren't the canonical key but should resolve to
# the same region. Lowercase keys; values are canonical region keys above.
_ALIASES: dict[str, str] = {
    "californian": "california", "cali": "california",
    "tuscan": "tuscany", "toscana": "tuscany",
    "bordelais": "bordeaux", "bordelaise": "bordeaux",
    "burgundian": "burgundy", "bourguignon": "burgundy",
    "piemonte": "piedmont", "piemontese": "piedmont",
    "spanish": "spain", "espana": "spain", "españa": "spain",
    "italian": "italy", "italia": "italy",
    "french": "france",
    "german": "germany", "deutschland": "germany",
    "portuguese": "portugal",
    "argentine": "argentina", "argentinian": "argentina",
    "chilean": "chile",
    "australian": "australia", "aussie": "australia",
    "kiwi": "new zealand", "nz": "new zealand",
    "japanese": "japan", "nihon": "japan",
    "mexican": "mexico",
    "irish": "ireland",
    "scottish": "scotland", "scotch": "scotland",
    "bourbon": "kentucky",
    "champagne wine": "champagne",
    "rioja wine": "rioja",
}


def resolve_region(text: Optional[str]) -> Optional[Region]:
    """Map a free-text region phrase to a Region. Case-insensitive. Returns
    None if no known region matches. Handles common phrasings like
    'California wines', 'wines from Napa', 'Bordeaux reds', 'tuscan reds',
    'bourbon whiskey'."""
    if not text:
        return None
    t = text.strip().lower()
    if not t:
        return None
    # Exact key match first.
    if t in _REGIONS:
        return _REGIONS[t]
    # Alias map for common variants ("tuscan" -> tuscany, "bourbon" -> kentucky).
    if t in _ALIASES:
        return _REGIONS[_ALIASES[t]]
    # Substring fallback — let "wines from napa", "californian wine",
    # "bourbon whiskey" still resolve. Try aliases first (longest match),
    # then canonical keys (longest match) so 'napa' is preferred over 'a'.
    for alias in sorted(_ALIASES.keys(), key=len, reverse=True):
        if alias in t:
            return _REGIONS[_ALIASES[alias]]
    for key in sorted(_REGIONS.keys(), key=len, reverse=True):
        if key in t:
            return _REGIONS[key]
    return None


def build_region_filter(
    region_hint: Optional[str], *, name_col: str = "product_name",
    upc_col: str = "upc",
) -> tuple[Optional[str], dict, Optional[str]]:
    """Return (sql_clause, params, auto_product_type) for a region filter.

    `sql_clause` is None when no region resolved. When set, it's an OR of
      - UPPER(name_col) LIKE '%TOKEN%' for each token
      - EXISTS (SELECT 1 FROM product_enrichment WHERE LTRIM(upc,'0') = LTRIM(name_col-side upc,'0') AND description ILIKE '%term%')
        for each description term.
    The catalog router drops this into its WHERE chain unchanged.

    `auto_product_type` is the region's narrowing hint (e.g. "Wine"). The
    caller should apply it ONLY when the user didn't already pass their own
    product_type — that's why we return it separately rather than baking
    it into the clause.
    """
    region = resolve_region(region_hint)
    if region is None:
        return None, {}, None
    parts: list[str] = []
    params: dict = {}
    for i, tok in enumerate(region.tokens):
        key = f"rgn_{region.key}_n_{i}"
        params[key] = f"%{tok}%"
        parts.append(f"UPPER({name_col}) LIKE ${key}")
    if region.description_terms:
        # Subquery joining to product_enrichment by leading-zero-normalised UPC.
        for i, term in enumerate(region.description_terms):
            key = f"rgn_{region.key}_d_{i}"
            params[key] = f"%{term}%"
            parts.append(
                f"EXISTS (SELECT 1 FROM product_enrichment pe "
                f"WHERE LTRIM(CAST(pe.upc AS VARCHAR), '0') = LTRIM(CAST({upc_col} AS VARCHAR), '0') "
                f"AND LOWER(COALESCE(pe.description, '')) LIKE ${key})"
            )
    if not parts:
        return None, {}, None
    clause = "(" + " OR ".join(parts) + ")"
    return clause, params, region.auto_product_type


def known_region_keys() -> list[str]:
    """List of canonical region keys for the assistant tool schema."""
    return sorted(_REGIONS.keys())
