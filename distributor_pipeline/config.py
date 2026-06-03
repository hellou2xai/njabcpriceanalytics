"""Run configuration: paths, DB targets, distributor identity, section ranges.

distributor_code is the app's EXISTING wholesaler code ('fedway'), not 'FEDWAY',
so the crosswalk joins straight onto cpl_enriched.wholesaler and every other
table in the system (same rule the ABG SKU mapping follows).
"""
import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PARSE_DIR = PROJECT_ROOT / "Distributor product parsing"
PDF_PATH = PARSE_DIR / "Fedway+Pricebook+Full+June+2026.pdf"
OUTPUT_DIR = PARSE_DIR / "output"

DISTRIBUTOR_CODE = "fedway"          # MUST match the app's wholesaler code
SOURCE_FILE = PDF_PATH.name
PRICE_BOOK_MONTH = "2026-06"

# Local Postgres: the project standard is DATABASE_URL (.env). Fall back to the
# prompt's PG* vars if DATABASE_URL is absent.
def local_db_url() -> str:
    url = os.getenv("DATABASE_URL")
    if url:
        return url
    host = os.getenv("PGHOST", "localhost"); port = os.getenv("PGPORT", "5432")
    db = os.getenv("PGDATABASE", "celr_dev"); user = os.getenv("PGUSER", "celr")
    pw = os.getenv("PGPASSWORD", "")
    return f"postgresql://{user}:{pw}@{host}:{port}/{db}"

# Render: prompt says RENDER_DATABASE_URL; this project uses
# RENDER_EXTERNAL_DATABASE_URL. Accept either.
def render_db_url() -> str | None:
    return os.getenv("RENDER_DATABASE_URL") or os.getenv("RENDER_EXTERNAL_DATABASE_URL")

# Section name (from the page header) -> parser kind. Header format:
#   "Order Phone: 800-4-FEDWAY  {SECTION}  Order Fax: 908-647-1269"
# Parser kinds: A=3-col catalog, B=best-deal tabular, C=retail incentives,
# D=combo packs. Anything else is skipped.
SECTION_PARSER = {
    "SPIRITS": "A", "CANS AND COCKTAILS": "A", "MALT": "A", "WINE": "A",
    "NON ALCOHOLIC": "A", "GLASSWARE": "A", "MIXERS": "A",
    "CRAFT DISTILLED": "A", "SAKE": "A", "FEATURED SAKE": "A",
    "HIGHLY RATED": "A",
    "BEST DEAL - ALL BUY-INS": "B", "PARTIAL MONTH": "B",
    "RETAIL INCENTIVES": "C",
    "COMBO PACKS": "D",
}

# Page ranges used ONLY to validate header detection (1-based, inclusive).
EXPECTED_RANGES = {
    "A": [(67, 161), (162, 179), (180, 180), (181, 278), (279, 285), (286, 292), (293, 298)],
    "B": [(22, 27), (28, 32)],
    "C": [(33, 55)],
    "D": [(56, 66)],
}
SKIP_BEFORE = 22  # pages 1-21 skipped
