"""
PostgreSQL connection layer for user-state data.

User data (accounts, orders, notes, stores, alerts) must live in a durable
store because Render's filesystem is ephemeral. This replaces the SQLite layer
in db.py for that data while keeping the same ergonomics: a context-managed
connection with dict-like rows, so call sites keep using row["col"] and dict(r).

Pricing/analytics data is unaffected: it keeps running on DuckDB.

Connection string comes from DATABASE_URL (Render injects it). Locally it
defaults to a Postgres on localhost.
"""

import os
from contextlib import contextmanager

from dotenv import load_dotenv
import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://localhost/celr_dev")

_pool: ConnectionPool | None = None


def get_pool() -> ConnectionPool:
    """Lazily create the process-wide connection pool. dict_row makes every
    cursor return dict rows, matching the old sqlite3.Row access by name."""
    global _pool
    if _pool is None:
        _pool = ConnectionPool(
            DATABASE_URL,
            min_size=1,
            max_size=10,
            open=True,
            kwargs={
                "row_factory": dict_row,
                "connect_timeout": 10,
                # TCP keepalives detect silently-dropped Render connections
                # within ~25s (10s idle + 3 probes × 5s) instead of hanging
                # until the next query attempt times out at the app level.
                "keepalives": 1,
                "keepalives_idle": 10,
                "keepalives_interval": 5,
                "keepalives_count": 3,
            },
        )
    return _pool


@contextmanager
def get_pg():
    """Yield a pooled connection. The transaction commits on a clean exit and
    rolls back if the block raises; the connection then returns to the pool.

    Usage mirrors the old SQLite pattern, minus the manual commit/close:
        with get_pg() as con:
            con.execute("INSERT ... VALUES (%s)", (x,))
    """
    with get_pool().connection() as conn:
        yield conn


def close_pool() -> None:
    """Close the pool and its worker threads. The FastAPI app calls this on
    shutdown; scripts should call it before exit to avoid a finalizer warning."""
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


def ping() -> bool:
    """Return True if the database is reachable. Used by a health check and by
    a quick local connectivity test."""
    try:
        with get_pg() as con:
            con.execute("SELECT 1")
        return True
    except Exception:
        return False
