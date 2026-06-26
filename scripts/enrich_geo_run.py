"""Batch geo/varietal enrichment over product_enrichment.

Pulls products that have no geo enrichment yet, classifies them through
backend.ai_geo_enrich (LLM, batched), and UPSERTs the structured
geo_* columns back to Postgres. Resume-safe: a row is "done" once
geo_enriched_at is set, so re-running continues where it left off.

Usage:
  python scripts/enrich_geo_run.py --limit 120            # pilot
  python scripts/enrich_geo_run.py                        # full run
  python scripts/enrich_geo_run.py --db local             # local Postgres
Options: --batch 18 --workers 8 --db prod|local
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from dotenv import load_dotenv

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
load_dotenv()

import psycopg2
import psycopg2.extras
from backend import ai_geo_enrich as geo
from backend import llm_client
from backend import taxonomy

_GEO_COLS = ["country", "region", "subregion", "appellation",
             "varietal", "color", "style", "classification"]

# Haiku pricing ($/1M) for a rough cost readout.
_PRICE = {"in": 1.0, "out": 5.0, "cache_read": 0.10, "cache_write": 1.25}


def _db_url(which: str) -> str:
    key = "RENDER_EXTERNAL_DATABASE_URL" if which == "prod" else "DATABASE_URL"
    url = os.getenv(key)
    if not url:
        raise SystemExit(f"{key} not set")
    return url


def _fetch_todo(con, limit: int | None) -> list[dict]:
    # Geo-meaningful first: wine/spirits/sparkling by Go-UPC category text, then
    # the rest. A NULL/empty name can't be classified, so skip it.
    sql = """
        SELECT upc, name, brand, category, description
        FROM product_enrichment
        WHERE geo_enriched_at IS NULL
          AND COALESCE(NULLIF(TRIM(name), ''), '') <> ''
        ORDER BY (CASE WHEN LOWER(COALESCE(category,'')) ~
                    'wine|spirit|whisk|vodka|tequila|rum|gin|brandy|cognac|liqueur|champagne|sake'
                  THEN 0 ELSE 1 END), upc
    """
    if limit:
        sql += f" LIMIT {int(limit)}"
    with con.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(sql)
        return [dict(r) for r in cur.fetchall()]


def _classify_batch(rows: list[dict]) -> tuple[list[dict], dict]:
    comp_usage = {"in": 0, "out": 0, "cr": 0, "cw": 0}
    # ai_geo_enrich.classify makes one llm_client.complete call; capture usage by
    # re-calling through a thin wrapper would double cost, so we re-run classify
    # and read usage off the last raw msg via a fresh call is avoided — instead
    # classify returns only data, so estimate usage separately is not possible.
    # We therefore call the seam here directly to also get token usage.
    out = [{f: None for f in geo.fields()} for _ in rows]
    if not llm_client.enabled():
        return out, comp_usage
    c = llm_client.complete(
        model=geo.GEO_ENRICH_MODEL,
        system=geo._SYSTEM,
        messages=[{"role": "user",
                   "content": "Classify these products:\n" + geo._fmt(rows)}],
        tools=[geo._TOOL],
        tool_choice={"type": "tool", "name": "record_geo"},
        max_tokens=4096,
    )
    comp_usage = {"in": c.input_tokens, "out": c.output_tokens,
                  "cr": c.cache_read, "cw": c.cache_write}
    if c.tool_use:
        for it in (c.tool_use.get("input") or {}).get("items") or []:
            try:
                idx = int(it.get("i"))
            except (TypeError, ValueError):
                continue
            if 0 <= idx < len(out):
                for f in geo.fields():
                    v = it.get(f)
                    out[idx][f] = (v.strip() or None) if isinstance(v, str) else None
    return out, comp_usage


def _normalize(o: dict) -> dict:
    """Snap region/subregion/varietal to canonical taxonomy values so facets
    don't fragment. country/region/subregion are back-filled from the finest
    recognised region; grapes canonicalised (Shiraz -> Syrah)."""
    n = taxonomy.normalize_geo(country=o.get("country"), region=o.get("region"),
                               subregion=o.get("subregion"), varietal=o.get("varietal"))
    o = dict(o)
    o["country"] = n["country"] or o.get("country")
    o["region"] = n["region"] or o.get("region")
    o["subregion"] = n["subregion"] or o.get("subregion")
    o["varietal"] = n["varietal"] or o.get("varietal")
    return o


def _upsert(con, rows: list[dict], results: list[dict]) -> None:
    sets = ", ".join(f"geo_{c} = %s" for c in _GEO_COLS)
    sql = f"UPDATE product_enrichment SET {sets}, geo_enriched_at = NOW() WHERE upc = %s"
    payload = []
    for r, o in zip(rows, results):
        o = _normalize(o)
        payload.append(tuple(o.get(c) for c in _GEO_COLS) + (r["upc"],))
    with con.cursor() as cur:
        cur.executemany(sql, payload)
    con.commit()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", choices=["prod", "local"], default="prod")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--batch", type=int, default=18)
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()

    if not llm_client.enabled():
        raise SystemExit("LLM provider not configured (ANTHROPIC_API_KEY).")

    url = _db_url(args.db)
    read_con = psycopg2.connect(url)
    todo = _fetch_todo(read_con, args.limit)
    read_con.close()
    n = len(todo)
    print(f"[geo] {n} products to enrich (db={args.db}, batch={args.batch}, workers={args.workers})", flush=True)
    if not n:
        return

    batches = [todo[i:i + args.batch] for i in range(0, n, args.batch)]
    t0 = time.time()
    done = 0
    usage = {"in": 0, "out": 0, "cr": 0, "cw": 0}
    write_con = psycopg2.connect(url)

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(_classify_batch, b): b for b in batches}
        for fut in as_completed(futs):
            b = futs[fut]
            try:
                results, u = fut.result()
            except Exception as e:  # noqa
                print(f"[geo] batch failed ({len(b)} rows): {e}", flush=True)
                continue
            for k in usage:
                usage[k] += u.get(k, 0)
            try:
                _upsert(write_con, b, results)
            except Exception as e:  # noqa
                print(f"[geo] upsert failed: {e}", flush=True)
                write_con.rollback()
                continue
            done += len(b)
            if done % (args.batch * 10) < args.batch or done >= n:
                rate = done / max(1e-6, time.time() - t0)
                cost = (usage["in"] * _PRICE["in"] + usage["out"] * _PRICE["out"]
                        + usage["cr"] * _PRICE["cache_read"] + usage["cw"] * _PRICE["cache_write"]) / 1e6
                eta = (n - done) / max(1e-6, rate)
                print(f"[geo] {done}/{n}  {rate:.1f}/s  cost~${cost:.2f}  eta {eta/60:.1f}m", flush=True)

    write_con.close()
    cost = (usage["in"] * _PRICE["in"] + usage["out"] * _PRICE["out"]
            + usage["cr"] * _PRICE["cache_read"] + usage["cw"] * _PRICE["cache_write"]) / 1e6
    print(f"[geo] DONE {done}/{n} in {(time.time()-t0)/60:.1f}m  total cost~${cost:.2f}", flush=True)


if __name__ == "__main__":
    main()
