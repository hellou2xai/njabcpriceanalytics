"""Side-car that polls the embedding progress every minute and writes a
markdown status file. Designed to run alongside scripts/build_semantic_index.py
so you can check progress from another PC (OneDrive syncs the file).

Stops when the embedding queue reaches zero OR when --max-minutes elapses.
"""
from __future__ import annotations

import os
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from dotenv import load_dotenv
import psycopg

load_dotenv()

LOG_PATH = Path(__file__).parent.parent / "process logs" / "voyage_log.md"


def snapshot(con) -> dict:
    """One row of status info."""
    cur = con.cursor()
    cur.execute("SELECT COUNT(*) FROM product_embeddings")
    embedded = cur.fetchone()[0]
    # The eligible-for-embedding row count (rows with actual text content)
    cur.execute(
        """
        SELECT COUNT(*) FROM product_enrichment pe
        WHERE pe.upc IS NOT NULL AND pe.upc != ''
          AND (
              (pe.name IS NOT NULL AND pe.name != '')
              OR (pe.brand IS NOT NULL AND pe.brand != '')
              OR (pe.description IS NOT NULL AND pe.description != '')
          )
        """
    )
    eligible = cur.fetchone()[0]
    # Remaining eligible rows
    cur.execute(
        """
        SELECT COUNT(*) FROM product_enrichment pe
        WHERE pe.upc IS NOT NULL AND pe.upc != ''
          AND (
              (pe.name IS NOT NULL AND pe.name != '')
              OR (pe.brand IS NOT NULL AND pe.brand != '')
              OR (pe.description IS NOT NULL AND pe.description != '')
          )
          AND NOT EXISTS (
              SELECT 1 FROM product_embeddings emb WHERE emb.upc = pe.upc
          )
        """
    )
    remaining = cur.fetchone()[0]
    cur.execute("SELECT MAX(updated_at) FROM product_embeddings")
    last_ts = cur.fetchone()[0]
    return {
        "embedded": embedded,
        "eligible": eligible,
        "remaining": remaining,
        "last_upsert": last_ts,
    }


def render_md(snaps: list[dict], started: datetime) -> str:
    """Render the markdown file from the list of snapshots."""
    if not snaps:
        return "_no data yet_"
    s = snaps[-1]
    pct = (s["embedded"] / s["eligible"] * 100) if s["eligible"] else 0.0
    # Rolling rate from the last ~5 minutes of snapshots (5 entries)
    window = snaps[-6:] if len(snaps) >= 6 else snaps
    if len(window) >= 2:
        d_rows = window[-1]["embedded"] - window[0]["embedded"]
        d_sec = (window[-1]["_ts"] - window[0]["_ts"]).total_seconds()
        rate_per_min = (d_rows / d_sec * 60) if d_sec > 0 else 0.0
    else:
        rate_per_min = 0.0
    eta_min = (s["remaining"] / rate_per_min) if rate_per_min > 0 else None
    eta_str = (f"{int(eta_min // 60)}h {int(eta_min % 60)}m" if eta_min and eta_min >= 60
               else f"{int(eta_min)} min" if eta_min else "n/a")

    lines = []
    lines.append("# Voyage Embedding Indexing — progress log")
    lines.append("")
    lines.append(f"_Started: {started:%Y-%m-%d %H:%M:%S UTC}_")
    lines.append(f"_Updated: {datetime.utcnow():%Y-%m-%d %H:%M:%S UTC}_")
    lines.append("")
    lines.append("## Current status")
    lines.append("")
    lines.append(f"- **Embedded so far**: `{s['embedded']:,}` / `{s['eligible']:,}` "
                 f"({pct:.1f}%)")
    lines.append(f"- **Remaining (eligible rows)**: `{s['remaining']:,}`")
    lines.append(f"- **Rate (last 5 min)**: `{rate_per_min:.1f} rows/min`")
    lines.append(f"- **ETA**: `{eta_str}`")
    if s.get("last_upsert"):
        lines.append(f"- **Last upsert**: `{s['last_upsert']:%Y-%m-%d %H:%M:%S}`")
    lines.append("")
    lines.append("## Recent samples (every minute)")
    lines.append("")
    lines.append("| UTC time | Embedded | Remaining | %     | Δ vs prev |")
    lines.append("|----------|----------|-----------|-------|-----------|")
    # Last 30 entries
    prev_n = None
    for snap in snaps[-30:]:
        n = snap["embedded"]
        delta = (n - prev_n) if prev_n is not None else 0
        pct_row = (n / snap["eligible"] * 100) if snap["eligible"] else 0
        lines.append(f"| {snap['_ts']:%H:%M:%S} | {n:>8,} | {snap['remaining']:>9,} | "
                     f"{pct_row:5.1f}% | {f'+{delta:,}' if delta > 0 else f'{delta:,}'} |")
        prev_n = n
    lines.append("")
    if s["remaining"] == 0:
        lines.append("**INDEXING COMPLETE.**")
    lines.append("")
    return "\n".join(lines)


def main() -> None:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--interval", type=int, default=60,
                    help="Seconds between samples (default 60)")
    ap.add_argument("--max-minutes", type=int, default=720,
                    help="Stop after N minutes regardless (default 720 = 12h)")
    ap.add_argument(
        "--database-url",
        default=os.getenv("RENDER_EXTERNAL_DATABASE_URL") or os.getenv("DATABASE_URL"),
    )
    args = ap.parse_args()
    if not args.database_url:
        sys.exit("error: no database URL")

    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    started = datetime.utcnow()
    snaps: list[dict] = []
    print(f"Logger started — writing to {LOG_PATH}")
    while True:
        try:
            with psycopg.connect(args.database_url, connect_timeout=10) as con:
                s = snapshot(con)
            s["_ts"] = datetime.utcnow()
            snaps.append(s)
            LOG_PATH.write_text(render_md(snaps, started), encoding="utf-8")
            # Stop the logger when the queue is empty so it doesn't keep
            # writing identical snapshots forever.
            if s["remaining"] == 0:
                print(f"Done at {s['_ts']:%H:%M:%S}.")
                break
            # Hard cap
            if (s["_ts"] - started).total_seconds() / 60 >= args.max_minutes:
                print(f"max_minutes reached at {s['_ts']:%H:%M:%S}.")
                break
        except Exception as e:
            print(f"snapshot error: {e}", flush=True)
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
