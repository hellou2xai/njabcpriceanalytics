"""Per-distributor parsing profiles.

A profile captures everything layout-specific about ONE distributor's price book
so the extractor stays generic. Next month's Fedway book reuses FEDWAY unchanged;
a new distributor (e.g. Allied, whose book has a different layout, $X ON NCS deal
tiers, 7-digit item numbers) is added as its own profile here, not by editing the
parser.

Set the active profile in config (DISTRIBUTOR / PROFILE). Anything NOT in a
profile (the matcher, staging, writers, reports) is distributor-agnostic.
"""
from dataclasses import dataclass, field


@dataclass(frozen=True)
class DistributorProfile:
    code: str                      # app wholesaler code; MUST match cpl_enriched.wholesaler
    # --- page routing ---
    header_regex: str              # captures the SECTION from the page header line
    section_parser: dict           # SECTION name -> parser kind 'A'/'B'/'C'/'D'
    skip_before_page: int          # 1-based; pages before this are skipped
    # --- 3-column catalog geometry (parser A/D) ---
    n_columns: int
    col_anchor_token: str          # repeated header word marking each column's left edge
    col_span_px: float             # approx px between column left edges
    col_cut_offset: float          # cut this many px LEFT of each edge (headers bleed left)
    # --- font classification (dominant font of a reconstructed line) ---
    font_type_country: str         # marker for TYPE / COUNTRY banners
    font_type_min_size: float      # size >= this and type_country marker => TYPE else COUNTRY
    font_product: str              # marker for PRODUCT label (checked before brand)
    font_brand: str                # marker for BRAND banner
    font_italic: str               # marker for description lines
    # --- vocab / flags ---
    program_flags: frozenset
    type_words: frozenset
    country_words: frozenset
    # --- item identity + price model ---
    item_number_pad: int           # zero-pad width for item_number_norm (no *10)
    frontline_rule: str            # 'bottle_times_pack' = regular bottle * bottles-per-case


FEDWAY = DistributorProfile(
    code="fedway",
    header_regex=r"800-4-FEDWAY\s+(.*?)\s+Order Fax",
    section_parser={
        "SPIRITS": "A", "CANS AND COCKTAILS": "A", "MALT": "A", "WINE": "A",
        "NON ALCOHOLIC": "A", "GLASSWARE": "A", "MIXERS": "A",
        "CRAFT DISTILLED": "A", "SAKE": "A", "FEATURED SAKE": "A", "HIGHLY RATED": "A",
        "BEST DEAL - ALL BUY-INS": "B", "PARTIAL MONTH": "B",
        "RETAIL INCENTIVES": "C", "COMBO PACKS": "D",
    },
    skip_before_page=22,
    n_columns=3,
    col_anchor_token="ITEM",
    col_span_px=204.0,          # page width / 3 (612/3); columns are evenly spaced
    col_cut_offset=10.0,
    font_type_country="Kingsbridge",
    font_type_min_size=8.5,
    font_product="SemiBold",    # AsapCondensed-SemiBold (contains 'Bold', so check first)
    font_brand="Bold",          # AsapCondensed-Bold
    font_italic="Italic",
    program_flags=frozenset({"F", "LA", "GP", "JNC", "JC", "J", "N", "SM", "VAP", "C", "G"}),
    type_words=frozenset({
        "WHISKIES", "WHISKY", "WHISKEY", "BOURBON", "SCOTCH", "VODKA", "VODKAS",
        "GIN", "GINS", "RUM", "RUMS", "TEQUILA", "TEQUILAS", "MEZCAL", "BRANDY",
        "COGNAC", "CORDIALS", "LIQUEUR", "LIQUEURS", "CANADIAN", "IRISH", "RYE",
        "RED", "WHITE", "ROSE", "BLUSH", "SPARKLING", "CHAMPAGNE", "STILL",
        "DESSERT", "SAKE", "VERMOUTH", "APERITIF", "BITTERS", "BLENDED", "MALT",
        "SCHNAPPS", "GRAPPA", "PORT", "SHERRY", "WINE", "SPIRITS", "CANS",
        "COCKTAILS", "CRAFT", "PROSECCO", "MOSCATO", "RTD", "RTS",
    }),
    country_words=frozenset({
        "JAPAN", "USA", "CANADA", "SCOTLAND", "IRELAND", "FRANCE", "MEXICO",
        "ITALY", "SPAIN", "GERMANY", "AUSTRALIA", "ARGENTINA", "CHILE",
        "PORTUGAL", "ENGLAND", "CARIBBEAN", "PUERTO", "BARBADOS", "JAMAICA",
        "GREECE", "AUSTRIA", "HUNGARY", "ISRAEL", "BRAZIL", "PERU", "CUBA",
        "DOMINICAN", "GUATEMALA", "NICARAGUA", "VENEZUELA", "RUSSIA", "POLAND",
        "SWEDEN", "FINLAND", "HOLLAND", "BELGIUM", "SWITZERLAND", "INTERNATIONAL",
        "DOMESTIC", "IMPORTED",
    }),
    item_number_pad=9,
    frontline_rule="bottle_times_pack",
)

# Active profile. Add e.g. ALLIED = DistributorProfile(...) and switch here.
PROFILES = {"fedway": FEDWAY}


def get(code: str) -> DistributorProfile:
    return PROFILES[code]
