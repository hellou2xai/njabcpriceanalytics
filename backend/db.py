"""
Data connections.

Pricing/analytics: DuckDB reading Parquet (stateless, read-only).
User state (accounts, orders, notes, stores, alerts): PostgreSQL via backend.pg,
because Render's filesystem is ephemeral and SQLite would not survive restarts.

The legacy SQLite helper is kept below, unused, for reference and quick rollback.
"""

import os
import sqlite3
from pathlib import Path
from contextlib import contextmanager

import duckdb
from dotenv import load_dotenv

load_dotenv()

PROJECT_ROOT = Path(__file__).parent.parent
PARQUET_DIR = PROJECT_ROOT / os.getenv("PARQUET_DIR", "parquet_output")
USER_DATA_DIR = PROJECT_ROOT / "user_data"
SQLITE_PATH = USER_DATA_DIR / "state.db"

# SQL expression mirroring SQLite's datetime('now'): UTC, 'YYYY-MM-DD HH:MM:SS'.
# Used for created_at/updated_at defaults and updates so timestamp strings stay
# byte-identical to the old SQLite output for existing clients.
NOW_UTC = "to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')"


def get_parquet_dir() -> Path:
    return PARQUET_DIR


@contextmanager
def get_duckdb():
    """Yield a read-only DuckDB connection to the local pricing cache, which is
    materialised from Postgres (or Parquet in dev) by backend.pricing_cache.
    Built lazily on first use and rebuilt by the reload endpoint."""
    from backend.pricing_cache import get_pricing_path
    con = duckdb.connect(str(get_pricing_path()), read_only=True)
    # Single-threaded so row order is deterministic. Native-table scans are
    # parallelised by default, which makes queries that lack a total ORDER BY
    # (ties) or post-process in Python return a varying row order run to run.
    # The dataset is small, so the speed cost is negligible.
    con.execute("SET threads TO 1")
    try:
        yield con
    finally:
        con.close()


def read_parquet(con: duckdb.DuckDBPyConnection, table: str, **kwargs):
    """Return the table name to query. The data now lives as native tables in
    the DuckDB pricing cache, so callers' ``FROM {src}`` keeps working unchanged
    (this used to return a read_parquet(...) expression)."""
    return table


def get_sqlite():
    """LEGACY (unused): SQLite connection for user state. Kept for rollback."""
    USER_DATA_DIR.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(SQLITE_PATH))
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA foreign_keys=ON")
    return con


def init_user_db():
    """Create the user-state tables in PostgreSQL if absent (idempotent).

    The full current schema is defined directly (no historical migrations): a
    fresh Postgres database needs the final shape, not the SQLite evolution.
    Timestamps are UTC text (see NOW_UTC) so created_at/updated_at strings match
    the previous SQLite format exactly. Integer 0/1 flags are kept as integers
    (not booleans) to avoid any behaviour drift.
    """
    from backend.pg import get_pg

    stmts = [
        f"""CREATE TABLE IF NOT EXISTS users (
            id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            email text NOT NULL UNIQUE,
            password_hash text NOT NULL,
            full_name text,
            phone text,
            activated integer DEFAULT 0,
            tos_accepted_at text,
            created_at text DEFAULT {NOW_UTC}
        )""",
        f"""CREATE TABLE IF NOT EXISTS auth_tokens (
            token text PRIMARY KEY,
            user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at text DEFAULT {NOW_UTC},
            expires_at text NOT NULL
        )""",
        f"""CREATE TABLE IF NOT EXISTS stores (
            id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            user_id integer REFERENCES users(id) ON DELETE CASCADE,
            name text NOT NULL,
            place_id text,
            formatted_address text,
            street text,
            city text,
            state text,
            postal_code text,
            country text,
            phone text,
            lat double precision,
            lng double precision,
            license_number text,
            notes text,
            created_at text DEFAULT {NOW_UTC},
            updated_at text DEFAULT {NOW_UTC}
        )""",
        f"""CREATE TABLE IF NOT EXISTS watchlist (
            id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            user_id integer REFERENCES users(id) ON DELETE CASCADE,
            upc text,
            product_name text NOT NULL,
            wholesaler text NOT NULL,
            unit_volume text,
            target_price double precision,
            notes text,
            created_at text DEFAULT {NOW_UTC}
        )""",
        """CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlist_user_item
            ON watchlist(user_id, product_name, wholesaler, unit_volume)""",
        f"""CREATE TABLE IF NOT EXISTS orders (
            id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            user_id integer REFERENCES users(id) ON DELETE CASCADE,
            name text NOT NULL,
            status text DEFAULT 'draft' CHECK (status IN ('draft','submitted','archived')),
            notes text,
            division text,
            distributor text,
            sales_rep_id integer,
            created_at text DEFAULT {NOW_UTC},
            updated_at text DEFAULT {NOW_UTC}
        )""",
        f"""CREATE TABLE IF NOT EXISTS order_lines (
            id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            order_id integer NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
            product_name text NOT NULL,
            wholesaler text NOT NULL,
            upc text,
            unit_volume text,
            qty_cases integer DEFAULT 0,
            qty_units integer DEFAULT 0,
            selected_discount_tier integer,
            combo_code text,
            retail_price double precision,
            notes text,
            created_at text DEFAULT {NOW_UTC}
        )""",
        f"""CREATE TABLE IF NOT EXISTS user_notes (
            id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            user_id integer REFERENCES users(id) ON DELETE CASCADE,
            product_name text NOT NULL,
            wholesaler text NOT NULL,
            note text NOT NULL,
            deleted integer DEFAULT 0,
            created_at text DEFAULT {NOW_UTC},
            updated_at text DEFAULT {NOW_UTC}
        )""",
        f"""CREATE TABLE IF NOT EXISTS user_ratings (
            id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            user_id integer REFERENCES users(id) ON DELETE CASCADE,
            product_name text NOT NULL,
            wholesaler text NOT NULL,
            edition text NOT NULL,
            rating integer CHECK (rating IN (-1, 1)),
            created_at text DEFAULT {NOW_UTC}
        )""",
        """CREATE UNIQUE INDEX IF NOT EXISTS idx_ratings_user_item
            ON user_ratings(user_id, product_name, wholesaler, edition)""",
        f"""CREATE TABLE IF NOT EXISTS alerts (
            id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            user_id integer REFERENCES users(id) ON DELETE CASCADE,
            alert_type text NOT NULL,
            product_name text,
            wholesaler text,
            edition text,
            message text NOT NULL,
            priority integer DEFAULT 0,
            read integer DEFAULT 0,
            payload text,
            created_at text DEFAULT {NOW_UTC}
        )""",
        f"""CREATE TABLE IF NOT EXISTS sales_reps (
            id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            user_id integer REFERENCES users(id) ON DELETE CASCADE,
            name text NOT NULL,
            division text,
            distributor text,
            email text,
            phone text
        )""",
        f"""CREATE TABLE IF NOT EXISTS divisions (
            id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            user_id integer REFERENCES users(id) ON DELETE CASCADE,
            name text NOT NULL,
            created_at text DEFAULT {NOW_UTC}
        )""",
        f"""CREATE TABLE IF NOT EXISTS audit_log (
            id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            table_name text NOT NULL,
            record_id integer NOT NULL,
            action text NOT NULL CHECK (action IN ('insert','update','delete','soft_delete','restore')),
            old_values text,
            new_values text,
            created_at text DEFAULT {NOW_UTC}
        )""",
        # Email verification + password-reset tokens (single-use, time-limited).
        f"""CREATE TABLE IF NOT EXISTS email_tokens (
            token text PRIMARY KEY,
            user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            purpose text NOT NULL CHECK (purpose IN ('activate','reset')),
            expires_at text NOT NULL,
            created_at text DEFAULT {NOW_UTC}
        )""",
        # Beta feedback: bug reports and improvement suggestions. The user only
        # types a message; user/page/agent are attached automatically. Feedback
        # is kept even if the user is later removed (ON DELETE SET NULL).
        f"""CREATE TABLE IF NOT EXISTS feedback (
            id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            user_id integer REFERENCES users(id) ON DELETE SET NULL,
            user_email text,
            kind text,
            message text NOT NULL,
            page text,
            user_agent text,
            created_at text DEFAULT {NOW_UTC}
        )""",
        # Cookie/consent log: one row per decision (accept all, reject, or saved
        # preferences), tracked for both signed-in and anonymous visitors. anon_id
        # is a random id stored in the visitor's browser so repeat decisions can be
        # correlated without any personal data.
        f"""CREATE TABLE IF NOT EXISTS cookie_consents (
            id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            user_id integer REFERENCES users(id) ON DELETE SET NULL,
            user_email text,
            anon_id text,
            necessary integer DEFAULT 1,
            analytics integer DEFAULT 0,
            marketing integer DEFAULT 0,
            decision text,
            policy_version text,
            page text,
            user_agent text,
            created_at text DEFAULT {NOW_UTC}
        )""",
        # Small key/value store for admin-editable app settings (e.g. the
        # WhatsApp share message and link).
        f"""CREATE TABLE IF NOT EXISTS app_settings (
            key text PRIMARY KEY,
            value text,
            updated_at text DEFAULT {NOW_UTC}
        )""",
    ]
    with get_pg() as con:
        for s in stmts:
            con.execute(s)
        # If 'activated' was just added to an existing users table, grandfather
        # all current users as activated so the email-verification rollout never
        # locks out people who signed up before it existed. Runs once.
        has_col = con.execute(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_name = 'users' AND column_name = 'activated'"
        ).fetchone()
        if not has_col:
            con.execute("ALTER TABLE users ADD COLUMN activated integer DEFAULT 0")
            con.execute("UPDATE users SET activated = 1")
        # Add later columns to an existing users table if they are missing.
        # (CREATE TABLE IF NOT EXISTS won't alter an existing table.)
        for col, ddl in (
            ("phone", "ALTER TABLE users ADD COLUMN phone text"),
            ("tos_accepted_at", "ALTER TABLE users ADD COLUMN tos_accepted_at text"),
        ):
            exists = con.execute(
                "SELECT 1 FROM information_schema.columns "
                "WHERE table_name = 'users' AND column_name = %s",
                (col,),
            ).fetchone()
            if not exists:
                con.execute(ddl)
