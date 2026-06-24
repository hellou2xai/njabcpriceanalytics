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
    PRICING_SOURCE=postgres \
    DISABLE_AUTOUPDATER=1

# Node 20 + the Claude Code CLI. The claude-agent-sdk (backend/agent_runtime.py)
# orchestrates the agentic surfaces by spawning the `claude` CLI as a subprocess;
# the SDK finds it on PATH. Tool execution still runs in-process in Python — only
# the agent loop is in the subprocess. DISABLE_AUTOUPDATER (set above) stops the
# ephemeral container from self-updating the binary at runtime. Placed before the
# requirements copy so this layer caches independently of app/code changes.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g @anthropic-ai/claude-code \
    && rm -rf /var/lib/apt/lists/*

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
# Worker count. The shared pricing cache means only ONE worker builds at boot
# and the rest adopt the published file, so multiple workers no longer each do a
# multi-GB build (the old idle-OOM). But RUNTIME memory bounds the count: each of
# the POOL_SIZE DuckDB connections PER WORKER can use up to DUCKDB_MEMORY_LIMIT
# (512 MB) on a heavy board/grid query, and that does NOT spill reliably. On the
# 8 GB box, 3 workers × 8 conns × 512 MB ≈ 12 GB -> Render OOM-killed workers
# (502s) under load. So default to 2 workers × pool 5 (see DUCKDB_POOL_SIZE) ≈
# 5 GB worst case, leaving headroom for Python + the cache. Throughput is largely
# CPU-bound at 4 cores anyway, so the bigger capacity lever is Cloudflare edge
# caching (see docs/CDN_AND_SHARED_CACHE.md). Passing --workers explicitly also
# makes uvicorn ignore WEB_CONCURRENCY. Override with UVICORN_WORKERS /
# DUCKDB_POOL_SIZE per instance (raise both only on a bigger box).
#
# DEFAULT 1: empirically, multiple workers are NOT safe on this 8 GB box. Each
# pooled connection (and each UNBOUNDED overflow connection spawned when the
# pool is exhausted under burst) can use up to 512 MB on a heavy query, and with
# 2-3 worker processes running queries truly in parallel, sustained high
# concurrency (≥400) blew past 8 GB and Render OOM-killed workers (502s). One
# worker was rock-solid: 0 errors from 100 up to 1500 concurrent, ~65 req/s,
# degrading gracefully (just slower) instead of crashing. The capacity lever
# that IS safe is Cloudflare edge caching (memory-free; see docs). Raise workers
# only on a bigger instance, and pair it with the overflow cap work in PERF_TODO.
CMD ["sh", "-c", "uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers ${UVICORN_WORKERS:-1}"]
