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
            expires_at text NOT NULL,
            last_activity text DEFAULT {NOW_UTC}
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
        # Lists: multiple named product lists per user (evolves Order Analysis).
        f"""CREATE TABLE IF NOT EXISTS lists (
            id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            user_id integer REFERENCES users(id) ON DELETE CASCADE,
            name text NOT NULL,
            created_at text DEFAULT {NOW_UTC},
            updated_at text DEFAULT {NOW_UTC}
        )""",
        f"""CREATE TABLE IF NOT EXISTS list_items (
            id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            list_id integer NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
            product_name text NOT NULL,
            wholesaler text NOT NULL,
            upc text,
            unit_volume text,
            combo_code text,
            notes text,
            created_at text DEFAULT {NOW_UTC}
        )""",
        """CREATE UNIQUE INDEX IF NOT EXISTS idx_list_items_item
            ON list_items(list_id, product_name, wholesaler, unit_volume)""",
        # Cart: one logical cart per user. Items group by assigned sales rep;
        # saved_for_later=1 parks an item in the "save for later" section.
        f"""CREATE TABLE IF NOT EXISTS cart_items (
            id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            user_id integer REFERENCES users(id) ON DELETE CASCADE,
            product_name text NOT NULL,
            wholesaler text NOT NULL,
            upc text,
            unit_volume text,
            combo_code text,
            qty_cases integer DEFAULT 0,
            qty_units integer DEFAULT 0,
            sales_rep_id integer,
            saved_for_later integer DEFAULT 0,
            retail_price double precision,
            notes text,
            created_at text DEFAULT {NOW_UTC},
            updated_at text DEFAULT {NOW_UTC}
        )""",
        """CREATE UNIQUE INDEX IF NOT EXISTS idx_cart_user_item
            ON cart_items(user_id, product_name, wholesaler, unit_volume)""",
        # Per-distributor "header" note for the cart, applied to that rep's order
        # on send (one order per rep/distributor group).
        f"""CREATE TABLE IF NOT EXISTS cart_group_notes (
            user_id integer REFERENCES users(id) ON DELETE CASCADE,
            wholesaler text NOT NULL,
            note text,
            updated_at text DEFAULT {NOW_UTC},
            PRIMARY KEY (user_id, wholesaler)
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
        # To-Do items the user creates by right-clicking a product anywhere.
        # Keeps the product context + the page it was created from (source) so
        # the To-Do board has everything needed to act.
        f"""CREATE TABLE IF NOT EXISTS todos (
            id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            user_id integer REFERENCES users(id) ON DELETE CASCADE,
            title text NOT NULL,
            note text,
            due_date text,
            status text DEFAULT 'open' CHECK (status IN ('open','done')),
            product_name text,
            wholesaler text,
            upc text,
            unit_volume text,
            source_page text,
            created_at text DEFAULT {NOW_UTC},
            completed_at text
        )""",
        # Share events: one row each time someone taps "Share via WhatsApp",
        # for signed-in users (user_id/email) and anonymous landing visitors.
        f"""CREATE TABLE IF NOT EXISTS share_events (
            id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            user_id integer REFERENCES users(id) ON DELETE SET NULL,
            user_email text,
            channel text,
            source text,
            page text,
            user_agent text,
            created_at text DEFAULT {NOW_UTC}
        )""",
        # Product analytics: one row per page view (with time spent) or action.
        # event_type: 'pageview' (has duration_ms) | 'action'. Anonymous rows
        # keep user_id NULL. Indexed for the admin rollups.
        f"""CREATE TABLE IF NOT EXISTS activity_events (
            id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            user_id integer REFERENCES users(id) ON DELETE SET NULL,
            user_email text,
            session_id text,
            event_type text NOT NULL,
            path text,
            label text,
            duration_ms integer,
            meta text,
            user_agent text,
            created_at text DEFAULT {NOW_UTC}
        )""",
        "CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_events(user_id)",
        "CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_events(created_at)",
        "CREATE INDEX IF NOT EXISTS idx_activity_type ON activity_events(event_type)",
        # Product enrichment from Go-UPC, keyed by the normalised UPC (leading
        # zeros stripped, i.e. LTRIM(upc,'0')) so it joins the pricing catalogue.
        # The image lives in R2; we store its public URL and object key here.
        # status: 'ok' | 'not_found' | 'error'. attributes holds the raw payload.
        f"""CREATE TABLE IF NOT EXISTS product_enrichment (
            upc           text PRIMARY KEY,
            name          text,
            brand         text,
            category      text,
            category_path text,
            description   text,
            region        text,
            specs         text,
            ean           text,
            code_type     text,
            barcode_url   text,
            inferred      integer DEFAULT 0,
            image_url     text,
            image_key     text,
            image_source  text,
            attributes    text,
            source        text DEFAULT 'go-upc',
            status        text,
            attempts      integer DEFAULT 0,
            fetched_at    text,
            updated_at    text DEFAULT {NOW_UTC}
        )""",
        # AI-generated "why this is a deal" blurb, keyed per product per edition.
        # Pre-generated after each data load (see backend.ai_blurbs). `version`
        # marks the prompt revision so we can bump it and have the generator
        # naturally re-write older entries with the richer context.
        f"""CREATE TABLE IF NOT EXISTS ai_deal_blurbs (
            wholesaler    text NOT NULL,
            upc           text NOT NULL,
            edition       text NOT NULL,
            blurb         text NOT NULL,
            version       text DEFAULT 'v1',
            generated_at  text DEFAULT {NOW_UTC},
            PRIMARY KEY (wholesaler, upc, edition)
        )""",
        # `version` column was added later; backfill on existing rows so the
        # generator's "not yet on current version" filter works.
        "ALTER TABLE ai_deal_blurbs ADD COLUMN IF NOT EXISTS version text DEFAULT 'v1'",
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
        # Session idle-timeout tracking. last_activity is bumped on every
        # authenticated request; non-admin sessions are auto-expired after
        # IDLE_TIMEOUT_HOURS of inactivity (see backend/auth.py). Backfill
        # existing rows so users on a session at migration time get a fresh
        # idle window rather than being kicked instantly.
        has_last_activity = con.execute(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_name = 'auth_tokens' AND column_name = 'last_activity'"
        ).fetchone()
        if not has_last_activity:
            con.execute(f"ALTER TABLE auth_tokens ADD COLUMN last_activity text DEFAULT {NOW_UTC}")
            con.execute(f"UPDATE auth_tokens SET last_activity = {NOW_UTC} WHERE last_activity IS NULL")
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
        # Add later Go-UPC columns to an existing product_enrichment table if
        # missing. We grew the schema to keep every field Go-UPC returns
        # (category_path, specs, region, ean, barcode, etc.), not just a few.
        for col, ddl in (
            ("category_path", "ALTER TABLE product_enrichment ADD COLUMN IF NOT EXISTS category_path text"),
            ("region", "ALTER TABLE product_enrichment ADD COLUMN IF NOT EXISTS region text"),
            ("specs", "ALTER TABLE product_enrichment ADD COLUMN IF NOT EXISTS specs text"),
            ("ean", "ALTER TABLE product_enrichment ADD COLUMN IF NOT EXISTS ean text"),
            ("code_type", "ALTER TABLE product_enrichment ADD COLUMN IF NOT EXISTS code_type text"),
            ("barcode_url", "ALTER TABLE product_enrichment ADD COLUMN IF NOT EXISTS barcode_url text"),
            ("inferred", "ALTER TABLE product_enrichment ADD COLUMN IF NOT EXISTS inferred integer DEFAULT 0"),
            ("image_source", "ALTER TABLE product_enrichment ADD COLUMN IF NOT EXISTS image_source text"),
        ):
            con.execute(ddl)
        # Alerts are roll-ups (one per user/category/month, product_name NULL).
        # De-duplicate any existing roll-ups, then enforce uniqueness so the two
        # auto-generate triggers can't race and create duplicate category rows.
        con.execute(
            """DELETE FROM alerts a USING alerts b
               WHERE a.product_name IS NULL AND b.product_name IS NULL
                 AND a.user_id = b.user_id AND a.alert_type = b.alert_type
                 AND a.edition = b.edition AND a.id > b.id"""
        )
        con.execute(
            """CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_rollup
               ON alerts(user_id, alert_type, edition) WHERE product_name IS NULL"""
        )
        # Divisions belong to a distributor (added later than the table).
        has_div_dist = con.execute(
            "SELECT 1 FROM information_schema.columns WHERE table_name = 'divisions' AND column_name = 'distributor'"
        ).fetchone()
        if not has_div_dist:
            con.execute("ALTER TABLE divisions ADD COLUMN distributor text")
        # Notes can now be standalone sticky notes (no product), with an optional
        # title and a colour. Relax the old product/wholesaler NOT NULLs and add
        # the new columns if they're missing.
        con.execute("ALTER TABLE user_notes ALTER COLUMN product_name DROP NOT NULL")
        con.execute("ALTER TABLE user_notes ALTER COLUMN wholesaler DROP NOT NULL")
        for col, ddl in (
            ("title", "ALTER TABLE user_notes ADD COLUMN title text"),
            ("color", "ALTER TABLE user_notes ADD COLUMN color text"),
        ):
            exists = con.execute(
                "SELECT 1 FROM information_schema.columns "
                "WHERE table_name = 'user_notes' AND column_name = %s",
                (col,),
            ).fetchone()
            if not exists:
                con.execute(ddl)
        # Orders carry a revision number. 0 = never submitted; each submit sets it
        # (first submit -> 1), and a reopened order can be re-submitted as the next
        # revision. Lets us cancel a prior PO and resend a revised one.
        has_rev = con.execute(
            "SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'revision'"
        ).fetchone()
        if not has_rev:
            con.execute("ALTER TABLE orders ADD COLUMN revision integer DEFAULT 0")
