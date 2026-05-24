#!/usr/bin/env python
"""One-shot local setup so a new PC matches the dev database exactly.

You install PostgreSQL; this script does the rest, and it is idempotent:
  - "New PC" is detected by the celr_dev database not being reachable yet. In
    that case it creates the celr role and celr_dev database (it asks for the
    postgres superuser password once, only for that step).
  - It ensures .env has DATABASE_URL.
  - It builds the user-data schema (init_user_db).
  - It loads the pricing tables from parquet_output (unless --no-data), which is
    a full replace, so re-running just refreshes.

Usage:
    python scripts/setup_local.py
    python scripts/setup_local.py --no-data          # schema only, skip pricing
    python scripts/setup_local.py --admin-url postgresql://postgres:PW@localhost:5432/postgres
"""
import argparse
import getpass
import os
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import psycopg

APP_ROLE = "celr"
APP_PASSWORD = "celrdev"
APP_DB = "celr_dev"
APP_URL = f"postgresql://{APP_ROLE}:{APP_PASSWORD}@localhost:5432/{APP_DB}"


def reachable(url: str) -> bool:
    try:
        with psycopg.connect(url, connect_timeout=4) as c:
            c.execute("SELECT 1")
        return True
    except Exception:
        return False


def build_admin_url(admin_url: str | None) -> str:
    if admin_url:
        return admin_url
    u = urlparse(APP_URL)
    host, port = (u.hostname or "localhost"), (u.port or 5432)
    pw = getpass.getpass(f"postgres superuser password (for {host}:{port}, used once to create the role/db): ")
    return f"postgresql://postgres:{pw}@{host}:{port}/postgres"


def ensure_role_and_db(admin_url: str) -> None:
    # autocommit: CREATE DATABASE cannot run inside a transaction.
    with psycopg.connect(admin_url, autocommit=True, connect_timeout=8) as con:
        if con.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (APP_ROLE,)).fetchone():
            print(f"  role {APP_ROLE}: exists")
        else:
            con.execute(f"CREATE ROLE {APP_ROLE} LOGIN PASSWORD %s", (APP_PASSWORD,))
            print(f"  role {APP_ROLE}: created")
        if con.execute("SELECT 1 FROM pg_database WHERE datname = %s", (APP_DB,)).fetchone():
            print(f"  database {APP_DB}: exists")
        else:
            con.execute(f"CREATE DATABASE {APP_DB} OWNER {APP_ROLE}")
            print(f"  database {APP_DB}: created")


def ensure_env() -> None:
    env = ROOT / ".env"
    if not env.exists():
        example = ROOT / ".env.example"
        if example.exists():
            shutil.copyfile(example, env)
            print("  .env: created from .env.example")
        else:
            env.write_text(f"DATABASE_URL={APP_URL}\n")
            print("  .env: created")
        return
    text = env.read_text()
    if "DATABASE_URL" in text:
        print("  .env: already has DATABASE_URL")
    else:
        with env.open("a", encoding="utf-8") as f:
            if text and not text.endswith("\n"):
                f.write("\n")
            f.write(f"DATABASE_URL={APP_URL}\n")
        print("  .env: added DATABASE_URL")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--admin-url", help="Superuser URL to create the role/db (skips the password prompt)")
    ap.add_argument("--no-data", action="store_true", help="Skip the pricing load (schema only)")
    args = ap.parse_args()

    print(f"Local setup -> {APP_DB}")

    if reachable(APP_URL):
        print("  database reachable; refreshing")
    else:
        print("  database not reachable -> treating as a new PC, creating role + database")
        ensure_role_and_db(build_admin_url(args.admin_url))
        if not reachable(APP_URL):
            print("ERROR: still cannot connect as celr after creation. Check Postgres is running on localhost:5432.")
            sys.exit(1)

    ensure_env()

    # Build the user-data schema against celr_dev.
    os.environ["DATABASE_URL"] = APP_URL
    from backend.db import init_user_db
    init_user_db()
    print("  user-data schema: ready")

    if args.no_data:
        print("  pricing load: skipped (--no-data)")
    elif (ROOT / "parquet_output").exists():
        print("  pricing load: ingesting from parquet_output ...")
        subprocess.run([sys.executable, str(ROOT / "scripts" / "ingest_to_postgres.py"),
                        "--database-url", APP_URL], check=True)
    else:
        print("  pricing load: no parquet_output found. Run your Excel->Parquet pipeline,")
        print("                then: python scripts/ingest_to_postgres.py")

    print("Done. Start the app: cd backend && python -m uvicorn main:app --port 8000")
    try:
        from backend.pg import close_pool
        close_pool()
    except Exception:
        pass


if __name__ == "__main__":
    main()
