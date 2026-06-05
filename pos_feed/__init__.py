"""POS feed framework.

Two halves, deliberately separated:

- ingest.py: the ingestion CONTRACT. Takes normalized sales/inventory rows and
  loads them idempotently into pos_sales_daily / pos_inventory (Postgres).
  A real POS export adapter later calls exactly these functions.
- dummy.py: a synthetic-feed generator that produces 24 months of plausible
  daily sell-through for a store, sampling real SKUs from the live catalog
  (cpl_enriched in DuckDB). It is just one producer of ingest-shaped rows.

Nothing in here knows about the procurement agents; they only read the tables.
"""
