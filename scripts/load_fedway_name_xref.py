#!/usr/bin/env python
"""Resolve fuller Fedway item names from the Fedway "BR2" product export
(PRODUCT SKU + Common Name + UPC) into `fedway_name_xref` for the cache to apply.

Fedway's authoritative item number (PRODUCT SKU) IS our `dist_item_no`, so the
join key is the SKU directly (no UPC-truncation / semantic gymnastics that Allied
needed). The Common Name column is a PROPER, un-abbreviated name (e.g. CPL says
"DANIELS BLACK", Common Name says "Jack Daniels Black Whiskey"), unlike the
earlier diveport list whose names were the same abbreviations.

GUARD (Fedway recycles SKUs, so a bare SKU match is not enough): a match is kept
only when the SKU match is CONFIRMED by either the UPC agreeing or the Common
Name semantically agreeing (brand-anchored) with our abbreviated CPL name. A UPC
that is present on both sides but DIFFERS is a recycled-SKU red flag -> rejected.

Applied by the cache on (wholesaler='fedway', sku_norm, product_name), so the
proper name lands only on the confirmed row. dist_item_name is set; product_name
is never touched. STRONG tier auto-applies (same policy as Allied).

Usage:
    python scripts/load_fedway_name_xref.py --csv "<path to BR2 .csv>"          # dry run
    python scripts/load_fedway_name_xref.py --csv "<...>" --write               # load table
"""
import argparse
import csv
import importlib.util
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import psycopg
from backend.pg import DATABASE_URL as ENV_DATABASE_URL

# reuse the brand-anchored name matcher from the Allied loader (no duplication)
_al = importlib.util.spec_from_file_location(
    "load_allied_name_xref", str(Path(__file__).resolve().parent / "load_allied_name_xref.py"))
_alm = importlib.util.module_from_spec(_al); _al.loader.exec_module(_alm)
name_agreement = _alm.name_agreement

def sku_norm(s): return re.sub(r"\D", "", str(s or "")).lstrip("0")
def upc_norm(u): return re.sub(r"\D", "", str(u or "")).lstrip("0")


def read_br2(path: Path):
    """Return {sku_norm: (common_name, upc_norm)} from the Fedway BR2 export."""
    out = {}
    with open(path, encoding="utf-8-sig", errors="replace") as f:
        for row in csv.DictReader(f):
            sk = sku_norm(row.get("PRODUCT SKU"))
            cn = (row.get("Common Name") or "").strip()
            if not sk or not cn:
                continue
            out[sk] = (cn, upc_norm(row.get("UPC Code")))
    return out


def read_fedway_catalog(db):
    """Distinct Fedway (sku_norm, product_name, upc_norm) from cpl_enriched."""
    with psycopg.connect(db) as con:
        rows = con.execute("""
            SELECT DISTINCT CAST(dist_item_no AS VARCHAR) AS sku, product_name, upc
            FROM cpl_enriched WHERE wholesaler='fedway'
              AND dist_item_no IS NOT NULL
              AND CAST(dist_item_no AS VARCHAR) NOT IN ('','0','None')
        """).fetchall()
    return [(sku_norm(sk), pn, upc_norm(u)) for sk, pn, u in rows]


def resolve(catalog, br2):
    for sk, cpl_name, our_upc in catalog:
        cand = br2.get(sk)
        if not cand:
            yield dict(sku_norm=sk, cpl_name=cpl_name, tier="NO_SKU", match_type=None)
            continue
        common, br_upc = cand
        upc_match = bool(our_upc and br_upc and our_upc == br_upc)
        upc_conflict = bool(our_upc and br_upc and our_upc != br_upc)
        sc, brand = name_agreement(cpl_name, common)
        if upc_conflict and not (brand and sc >= 0.6):
            tier, mt = "REJECT", "upc_conflict"        # recycled SKU red flag
        elif upc_match or (brand and sc >= 0.6):
            tier, mt = "STRONG", ("sku+upc" if upc_match else "sku+name")
        elif brand and sc >= 0.34:
            tier, mt = "MEDIUM", "sku+weakname"
        else:
            tier, mt = "REJECT", "unconfirmed"
        yield dict(sku_norm=sk, cpl_name=cpl_name, dist_item_name=common,
                   upc_norm=our_upc, score=round(sc, 3), tier=tier, match_type=mt)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True, help="Fedway BR2 export .csv")
    ap.add_argument("--database-url", default=ENV_DATABASE_URL)
    ap.add_argument("--write", action="store_true", help="load fedway_name_xref (STRONG). Default: dry run.")
    args = ap.parse_args()

    path = Path(args.csv)
    if not path.exists():
        sys.exit(f"csv not found: {path}")

    br2 = read_br2(path)
    catalog = read_fedway_catalog(args.database_url)
    resolved = list(resolve(catalog, br2))

    tiers = defaultdict(list)
    for r in resolved:
        tiers[r["tier"]].append(r)
    print(f"BR2 SKUs: {len(br2)} | Fedway naming units (sku,name): {len(resolved)}")
    for t in ("NO_SKU", "REJECT", "MEDIUM", "STRONG"):
        print(f"  {t:8}: {len(tiers[t])}")
    by_mt = defaultdict(int)
    for r in tiers["STRONG"]:
        by_mt[r["match_type"]] += 1
    print(f"  => STRONG auto-apply: {len(tiers['STRONG'])} ({dict(by_mt)})")

    for t in ("STRONG", "MEDIUM", "REJECT"):
        p = path.parent / f"fedway_name_xref_{t.lower()}.csv"
        with open(p, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["sku_norm", "cpl_name", "common_name", "upc_norm", "score", "match_type"])
            for r in tiers[t]:
                w.writerow([r["sku_norm"], r["cpl_name"], r.get("dist_item_name"),
                            r.get("upc_norm"), r.get("score"), r.get("match_type")])
        print(f"  wrote {p.name} ({len(tiers[t])})")

    if not args.write:
        print("\nDRY RUN. Re-run with --write to load fedway_name_xref (STRONG only).")
        return

    strong = tiers["STRONG"]
    print(f"\nWriting fedway_name_xref into {args.database_url.split('@')[-1]} ...")
    with psycopg.connect(args.database_url) as con:
        con.execute("DROP TABLE IF EXISTS fedway_name_xref")
        con.execute("""CREATE TABLE fedway_name_xref (
            sku_norm text NOT NULL, cpl_name text NOT NULL,
            dist_item_name text, upc_norm text, score double precision, match_type text)""")
        with con.cursor() as cur:
            cur.executemany(
                "INSERT INTO fedway_name_xref (sku_norm,cpl_name,dist_item_name,upc_norm,score,match_type) "
                "VALUES (%s,%s,%s,%s,%s,%s)",
                [(r["sku_norm"], r["cpl_name"], r["dist_item_name"], r.get("upc_norm"),
                  r["score"], r["match_type"]) for r in strong])
        con.execute("CREATE INDEX idx_fedway_name_xref ON fedway_name_xref (sku_norm, cpl_name)")
        con.commit()
        n = con.execute("SELECT count(*) FROM fedway_name_xref").fetchone()[0]
    print(f"Done. {n} rows. Trigger /api/admin/reload-pricing or redeploy to surface the names.")


if __name__ == "__main__":
    main()
