# Scripts

Operational scripts. Run from the repo root with the backend deps installed
(`pip install -r backend/requirements.txt`). Full details are in `DEPLOY.md`.

## Data ingestion (monthly, or back-filling a past month)

Same steps whether the file is a past or future month (edition-partitioned and
idempotent).

1. Put the month's Excel files in `Data/`, then build Parquet (at repo root):
   ```
   python run_etl.py --derive
   ```
2. Load Parquet into Postgres (FULL REPLACE; Postgres mirrors `parquet_output`):
   ```
   python scripts/ingest_to_postgres.py
   # Render target:
   python scripts/ingest_to_postgres.py --database-url "postgresql://celr:...@dpg-....render.com/celr?sslmode=require"
   ```
3. Refresh the live cache: Admin page "Reload pricing cache", or
   `POST /api/admin/reload-pricing`, or a Render Manual Deploy.

## Set up a new dev machine

Install PostgreSQL, then:
```
python scripts/setup_local.py
```
Detects a fresh PC, creates the `celr` role + `celr_dev` database (asks for the
postgres password once), writes `.env`, builds the schema, and loads pricing
from `parquet_output`. Idempotent. `--no-data` for schema only.

## Regression safety net (golden API snapshots)

Capture and diff API responses to prove behaviour is unchanged after a change.
```
python scripts/snapshot_api.py --label baseline     # against a running backend
python scripts/compare_snapshots.py baseline after   # exit 0 = no change
```
See `tests/golden/README.md` for the rules.
