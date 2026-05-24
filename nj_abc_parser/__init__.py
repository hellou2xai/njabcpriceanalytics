"""
NJ ABC Parser - Template-based parser for New Jersey ABC eCPL wholesale price files.

All NJ wholesalers submit monthly pricing in a standardized format:
  - CPL  (Current Price List) — product catalog with pricing & discount tiers
  - RIP  (Reduced Item Price) — promotional rebates/discounts
  - COMBO — bundle deals with component breakdown
  - BEER MIX and MATCH — beer-specific volume discounts

Each wholesaler has minor variations (header row offset, number of discount tiers,
product type labels) handled via per-wholesaler config overrides.
"""

from nj_abc_parser.etl import run_etl
from nj_abc_parser.registry import get_wholesaler_config, list_wholesalers

__version__ = "0.1.0"
