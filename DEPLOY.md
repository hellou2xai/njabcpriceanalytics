# Deploy and operations runbook

How this app is built, how to run it locally, how to load data each month, and
how to deploy it to Render. Keep this current when the architecture changes.

## Architecture in one minute

Two separate data layers:

1. **Pricing / analytics (read-only).** Processed monthly from Excel into
   Parquet on a local machine, loaded into PostgreSQL, and served through
   DuckDB. At boot the app copies the pricing tables out of Postgres into a
   local DuckDB file (`user_data/pricing_<ts>.duckdb`) and runs every analytical
   query against that. DuckDB stays the query engine, so the analytical SQL is
   unchanged.
2. **User data (read/write).** Accounts, orders, notes, stores, alerts. Lives in
   the same PostgreSQL database, read and written live.

On Render there is **no local data dependency**: pricing comes from Postgres
(rebuilt into the DuckDB cache on each start), user data is in Postgres, and no
Parquet ships in the image. The only local step is the monthly ingestion, which
pushes processed data into Postgres.

Key files:
- `backend/db.py` - DuckDB cache connection (`get_duckdb`), `read_parquet` (now
  returns a table name), Postgres schema (`init_user_db`).
- `backend/pg.py` - Postgres connection pool for user data.
- `backend/pricing_cache.py` - builds the local DuckDB cache from Postgres (or
  Parquet in dev); `PRICING_SOURCE` selects the source.
- `scripts/ingest_to_postgres.py` - loads Parquet into Postgres (full replace).
- `Dockerfile`, `.dockerignore`, `render.yaml` - the Render deploy.

## Environment variables

| Variable | Used by | Notes |
| --- | --- | --- |
| `DATABASE_URL` | app + ingestion | Postgres URL. Render injects it; local dev sets it in `.env`. |
| `PRICING_SOURCE` | app + ingestion | `postgres` (default) or `parquet` (local dev before any ingestion). |
| `PARQUET_DIR` | ingestion / parquet mode | Path to `parquet_output`. Unused on Render. |
| `ANTHROPIC_API_KEY` | AI features | Optional. |
| `GOOGLE_MAPS_API_KEY` | store address lookup | Optional. |
| `SERPAPI_API_KEY` | web price search | Optional. |
| `RENDER_EXTERNAL_URL` | CORS | Set automatically by Render. |

## Local development

1. PostgreSQL running locally. Create the dev database once:
   ```sql
   CREATE ROLE celr LOGIN PASSWORD 'celrdev';
   CREATE DATABASE celr_dev OWNER celr;
   ```
2. Copy `.env.example` to `.env` and set `DATABASE_URL`, e.g.
   `postgresql://celr:celrdev@localhost:5432/celr_dev`.
3. Backend:
   ```
   pip install -r backend/requirements.txt
   cd backend && python -m uvicorn main:app --host 127.0.0.1 --port 8000
   ```
   The user-state tables are created on startup. For pricing locally, either run
   the ingestion (below) or set `PRICING_SOURCE=parquet` to read the local
   Parquet directly.
4. Frontend:
   ```
   cd frontend && npm install && npm run dev
   ```
   Build for production with `npx vite build` (use this, not `npm run build`,
   which also runs `tsc -b` and fails on pre-existing type errors).

Note: the local backend does not reliably hot-reload on this OneDrive path.
Restart it after backend changes, and watch for a stale process holding port
8000.

## Working from another machine

Code travels via git; only `.env`, your local Postgres, and the Parquet/Excel
data are not in the repo. On a new PC: install PostgreSQL, clone the repo, then
run the bootstrap, which detects a fresh machine (celr_dev not reachable yet),
creates the `celr` role and `celr_dev` database, writes `.env`, builds the
schema, and loads pricing from `parquet_output`:

```
python scripts/setup_local.py
```

It asks for the postgres superuser password once (only to create the role/db).
Re-running is safe (idempotent). Use `--no-data` for schema only, or
`--admin-url postgresql://postgres:PW@localhost:5432/postgres` to skip the
prompt. Bring your `parquet_output` (or run the Excel pipeline first) so the
bootstrap can load pricing; without it, the schema is created but pricing pages
stay empty until you ingest. Deploying and the monthly ingestion do not need any
of this, only git and the Render database URL.

## Data ingestion (any month, past or future)

The pipeline is edition-aware and idempotent, so adding a future month and
back-filling a past month are the *same* steps. The edition (YYYY-MM) and
wholesaler are auto-detected from each file name, and each (wholesaler, edition)
is written to its own Parquet partition
(`parquet_output/cpl/wholesaler=allied/edition=2026-06/data.parquet`). So
re-processing a month overwrites just that partition and never duplicates, and
new months simply add new partitions next to the existing ones.

Steps (next scheduled run: 17 June 2026):

1. Put the month's Excel files in `Data/` (one per wholesaler). Keep older files
   too if you want their editions retained. Editions and wholesalers are
   detected automatically; `python run_etl.py --list` shows the recognised
   wholesaler slugs and file-name patterns.
2. Build the raw + derived Parquet:
   ```
   python run_etl.py --derive
   ```
   (`--wholesaler allied` for one distributor; `--derive-only` to just rebuild
   the derived tables; `--dry-run` to parse without writing.)
3. Load Parquet into Postgres. This is a FULL REPLACE, so Postgres always mirrors
   exactly what is in `parquet_output`. Local target:
   ```
   python scripts/ingest_to_postgres.py
   ```
   Render target (the database's External URL, which includes `sslmode=require`):
   ```
   python scripts/ingest_to_postgres.py --database-url "postgresql://celr:...@dpg-....render.com/celr?sslmode=require"
   ```
4. Refresh the running app's cache so it picks up the new data:
   - the "Reload pricing cache" button on the Admin page, or
   - `POST /api/admin/reload-pricing` (admin), or
   - a Manual Deploy in Render (a restart rebuilds the cache).

Notes:
- Past vs future is identical: drop the file, run the ETL, ingest, reload. The
  app's current/next-edition logic just uses whichever editions are present.
- Because ingest is a full replace, to remove an old edition delete its
  partition folders under `parquet_output` (and the source Excel) before
  ingesting. Otherwise editions accumulate, which is usually what you want.
- `Data/` and `parquet_output/` are gitignored (local only), by design.

## Deploy to Render (Blueprint)

1. Push the repo to GitHub (https://github.com/hellou2xai/njabcpriceanalytics).
2. Render dashboard: New, then Blueprint, and connect the repo. Render reads
   `render.yaml` and creates the `njabc-db` Postgres plus the
   `njabc-price-analytics` Docker web service, building the image from the
   `Dockerfile`. No image registry is involved.
3. Set the optional secrets in the service Environment tab: `ANTHROPIC_API_KEY`,
   `GOOGLE_MAPS_API_KEY`, `SERPAPI_API_KEY`. `DATABASE_URL` is wired
   automatically from the database.
4. First boot is healthy even before any data: `/api/health` returns 200 with
   `status: "starting"`.
5. Load data with the ingestion command above (External URL), then refresh the
   cache. `/api/health` then shows `status: "ok"` with a row count.

Every later `git push` to the connected branch rebuilds and redeploys
(`autoDeploy: true`).

Caveats on the free tier: free Postgres is removed after 90 days (upgrade to
keep it), and the free web service cold-starts after idle, so the first request
after a quiet period is slow while the container boots and rebuilds the cache.

## Regression safety net

`tests/golden/` holds a captured baseline of API responses. After any change
that could affect behaviour:

```
python scripts/snapshot_api.py --label after        # against a running backend
python scripts/compare_snapshots.py baseline after   # exit 0 = no behaviour change
```

Comparison is order-insensitive and ignores a small set of inherently
non-deterministic endpoints. See `tests/golden/README.md` for the rules and the
determinism note (`SET threads TO 1` on the pricing reads).

## Rollback

The previous SQLite path is still present (`get_sqlite` in `backend/db.py`,
unused) for reference. The data layers are independent: a pricing problem is
fixed by re-ingesting and reloading; a user-data problem does not touch pricing.
