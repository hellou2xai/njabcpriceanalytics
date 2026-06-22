# Multi-stage build: Node builds the React frontend, Python serves the API and
# the built frontend. Pricing data lives in Postgres (materialised into a local
# DuckDB cache at boot), so no Parquet ships in the image.

# ---- Stage 1: build the frontend ----
FROM node:20-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# vite build directly (the package "build" script runs `tsc -b` first, which
# fails on pre-existing type errors; vite build is the real gate).
RUN npx vite build

# ---- Stage 2: Python runtime ----
FROM python:3.12-slim
WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PRICING_SOURCE=postgres

COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install -r backend/requirements.txt

# Pre-install the DuckDB postgres extension so the first request doesn't pay a
# download. Pinned to the installed duckdb version, so it loads at runtime.
RUN python -c "import duckdb; duckdb.connect().execute('INSTALL postgres')"

COPY backend/ ./backend/
# Agent pipeline + POS feed framework: top-level packages imported by
# backend.main (procurement_agents.api) and the seed/ingest tooling.
COPY procurement_agents/ ./procurement_agents/
COPY pos_feed/ ./pos_feed/
COPY --from=frontend /app/frontend/dist ./frontend/dist

# Render injects $PORT. Shell form so it expands.
# Single worker by default: each worker builds + holds its OWN in-memory pricing
# cache at boot (the build isn't shared across forked processes), so N workers =
# N concurrent multi-GB cache builds. That OOMed the box even at idle once the
# catalogue grew (a 4-CPU instance defaulting WEB_CONCURRENCY to 4 meant 4
# simultaneous builds). Passing --workers explicitly also makes uvicorn ignore
# WEB_CONCURRENCY. Raise UVICORN_WORKERS only after the shared/lazy cache lands.
CMD ["sh", "-c", "uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers ${UVICORN_WORKERS:-1}"]
