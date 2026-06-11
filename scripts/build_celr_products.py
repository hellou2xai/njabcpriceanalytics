"""Build / update the CELR Product Number registry (v2).

See docs/CELR_PRODUCT_NUMBER_DESIGN.md. User-confirmed clustering order:
  1. NAME similarity first: catalogue-name token signatures (backend.celr
     .family_core) cluster listings of the same product. Distributor names
     are the consistent signal (JIM BEAM ORANGE everywhere).
  2. UPC match second: the same real barcode anywhere is the same product,
     stitching distributors together even when their name cores differ
     (GLENLIVET FOUND RES vs GLENLIVET FOUNDER'S RESERVE share barcodes).
  3. Sizes/distributor listings group UNDER the family as variants.

Trusted Go-UPC enrichment names (sharing at least one significant token with
the distributor's name) add bridge edges for abbreviation variance and supply
the standardized header_name. Untrusted enrichment (e.g. "Kyocera Test
Artist" on a placeholder barcode) is ignored entirely.

Implementation: union-find. Nodes = registry barcodes (backend.celr
.is_registry_upc — placeholder/repeated-digit codes are NOT nodes; their rows
join families at SERVING time by name key via celr_family_keys). Edges =
shared catalogue-name key OR shared trusted-enrichment key. Components =
families.

Incremental after the first build: existing upc -> cpn assignments never
change; a new barcode joins the family owning any of its keys (most key hits
wins; existing families are never merged by the script — that is the manual
alias table's job); otherwise it mints the next cpn.

Inputs : parquet_output/derived/cpl_enriched.parquet (all editions)
         product_enrichment in Postgres (DATABASE_URL)
Outputs: celr_families / celr_product_upcs / celr_family_keys in Postgres
         parquet_output/derived/celr_products.parquet + celr_family_keys.parquet

Run after every monthly ingest:  python scripts/build_celr_products.py
Full rebuild (drops the registry): add --rebuild
"""
from __future__ import annotations

import sys
from collections import Counter, defaultdict
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.pg import get_pg                                   # noqa: E402
from backend.celr import (                                      # noqa: E402
    family_core, family_key, is_registry_upc, norm_upc, trusted_enrichment,
)

PARQUET = ROOT / "parquet_output" / "derived" / "cpl_enriched.parquet"
OUT_UPCS = ROOT / "parquet_output" / "derived" / "celr_products.parquet"
OUT_KEYS = ROOT / "parquet_output" / "derived" / "celr_family_keys.parquet"

NOW = "to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')"

# Tokens that make a raw distributor name a poor HEADER (not identity).
import re                                                        # noqa: E402
_HEADER_JUNK_RE = re.compile(
    r"\b(?:old\s*lot|oldlot|close\s*out|closeout|clsout|clo)\b|\b(?:bag)?\d+\s*(?:p|pk|pack)\b", re.I)


def _ensure_tables(pg) -> None:
    pg.execute("""CREATE TABLE IF NOT EXISTS celr_families (
        cpn integer PRIMARY KEY, family_key text NOT NULL UNIQUE,
        header_name text, brand text, product_type text, created_at text)""")
    pg.execute("""CREATE TABLE IF NOT EXISTS celr_product_upcs (
        upc_norm text PRIMARY KEY,
        cpn integer NOT NULL REFERENCES celr_families(cpn), assigned_at text)""")
    pg.execute("""CREATE TABLE IF NOT EXISTS celr_family_keys (
        key text PRIMARY KEY, cpn integer NOT NULL REFERENCES celr_families(cpn))""")
    pg.execute("""CREATE TABLE IF NOT EXISTS celr_family_aliases (
        cpn integer PRIMARY KEY, canonical_cpn integer NOT NULL)""")


class _UF:
    def __init__(self):
        self.parent: dict[str, str] = {}

    def find(self, x: str) -> str:
        self.parent.setdefault(x, x)
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: str, b: str) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[max(ra, rb)] = min(ra, rb)


def main() -> None:
    rebuild = "--rebuild" in sys.argv

    # ---- 1) catalogue rows (every edition) ----
    con = duckdb.connect()
    rows = con.execute(
        f"""SELECT CAST(upc AS VARCHAR) AS upc, product_name, product_type
            FROM '{PARQUET.as_posix()}' WHERE upc IS NOT NULL"""
    ).fetchdf().to_dict("records")
    by_upc: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        if is_registry_upc(r["upc"]):
            by_upc[norm_upc(r["upc"])].append(r)
    print(f"registry barcodes in catalogue: {len(by_upc)}")

    # ---- 2) enrichment names/brands ----
    with get_pg() as pg:
        enr = {str(r["upc"]): (r["name"], r["brand"]) for r in pg.execute(
            "SELECT upc, name, brand FROM product_enrichment "
            "WHERE name IS NOT NULL AND name <> ''").fetchall()}
    print(f"enriched barcodes: {len(enr)}")

    # ---- 3) per-barcode keys: every catalogue-name key + trusted enrichment ----
    upc_keys: dict[str, set[str]] = {}
    upc_type: dict[str, str] = {}
    upc_best_cat: dict[str, str] = {}
    upc_enr_header: dict[str, str] = {}
    upc_brand: dict[str, str] = {}
    distrusted = 0
    for un, recs in by_upc.items():
        ptype = Counter(str(r.get("product_type") or "") for r in recs).most_common(1)[0][0]
        upc_type[un] = ptype
        names = Counter(str(r.get("product_name") or "").strip() for r in recs)
        upc_best_cat[un] = sorted(
            names.items(),
            key=lambda kv: (1 if _HEADER_JUNK_RE.search(kv[0]) else 0, -kv[1], -len(kv[0])))[0][0]
        keys = {family_key(n, ptype) for n in names if family_core(n, ptype)}
        e = enr.get(un)
        if e and e[0]:
            if any(trusted_enrichment(n, e[0]) for n in names):
                ek = family_key(e[0], ptype)
                if family_core(e[0], ptype):
                    keys.add(ek)
                # header from enrichment, size suffix stripped, casing kept
                import backend.celr as _c
                h = _c._SIZE_RE.sub(" ", e[0])
                upc_enr_header[un] = re.sub(r"\s+", " ", h).strip(" ,-") or e[0]
                if e[1]:
                    upc_brand[un] = str(e[1])
            else:
                distrusted += 1
        upc_keys[un] = keys
    print(f"untrusted enrichment names ignored: {distrusted}")

    # ---- 4) union-find: shared key -> same family ----
    uf = _UF()
    key_first: dict[str, str] = {}
    for un in sorted(by_upc):           # sorted -> deterministic components
        for k in upc_keys[un]:
            if k in key_first:
                uf.union(key_first[k], un)
            else:
                key_first[k] = un
    comp: dict[str, list[str]] = defaultdict(list)
    for un in sorted(by_upc):
        comp[uf.find(un)].append(un)
    print(f"name+barcode components: {len(comp)}")

    # ---- 5) write to the registry ----
    with get_pg() as pg:
        _ensure_tables(pg)
        if rebuild:
            print("REBUILD: dropping existing registry")
            pg.execute("DELETE FROM celr_family_keys")
            pg.execute("DELETE FROM celr_product_upcs")
            pg.execute("DELETE FROM celr_family_aliases")
            pg.execute("DELETE FROM celr_families")
        assigned = {r["upc_norm"]: r["cpn"] for r in
                    pg.execute("SELECT upc_norm, cpn FROM celr_product_upcs").fetchall()}
        key_to_cpn = {r["key"]: r["cpn"] for r in
                      pg.execute("SELECT key, cpn FROM celr_family_keys").fetchall()}
        next_cpn = (pg.execute("SELECT COALESCE(MAX(cpn), 0) AS m FROM celr_families")
                    .fetchone()["m"]) + 1

        fam_rows, upc_rows, key_rows = [], [], []
        for root in sorted(comp):
            members = comp[root]
            # existing assignment wins (stability); else key vote; else mint
            existing = Counter(assigned[u] for u in members if u in assigned)
            keyhits = Counter(key_to_cpn[k] for u in members for k in upc_keys[u]
                              if k in key_to_cpn)
            if existing:
                cpn = existing.most_common(1)[0][0]
            elif keyhits:
                cpn = keyhits.most_common(1)[0][0]
            else:
                cpn = next_cpn
                next_cpn += 1
                # header: most common TRUSTED enrichment name, else best catalogue name
                eh = Counter(upc_enr_header[u] for u in members if u in upc_enr_header)
                header = (sorted(eh.items(), key=lambda kv: (-kv[1], -len(kv[0])))[0][0]
                          if eh else upc_best_cat[members[0]])
                brand = Counter(upc_brand[u] for u in members if u in upc_brand)
                ptype = Counter(upc_type[u] for u in members).most_common(1)[0][0]
                fam_rows.append((cpn, f"v2|{root}", header,
                                 brand.most_common(1)[0][0] if brand else None, ptype))
            for u in members:
                if u not in assigned:
                    upc_rows.append((u, cpn))
                    assigned[u] = cpn
            for u in members:
                for k in upc_keys[u]:
                    if k not in key_to_cpn:
                        key_to_cpn[k] = cpn
                        key_rows.append((k, cpn))

        # Bulk write. Backfills are ~25k families / 32k upcs / 52k keys; over a
        # remote production link per-row executemany held one transaction open
        # long enough for the server to kill the connection. COPY streams each
        # table in seconds. Rows are guaranteed-new by construction (filtered
        # against the loaded registry), so plain COPY is safe; the small
        # incremental case keeps executemany with ON CONFLICT as a belt.
        from datetime import datetime, timezone
        now_s = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        CHUNK = 1000
        bulk = rebuild or len(upc_rows) > 5000
        with pg.cursor() as cur:
            if bulk:
                if fam_rows:
                    with cur.copy("COPY celr_families (cpn, family_key, header_name, brand, product_type, created_at) FROM STDIN") as cp:
                        for r in fam_rows:
                            cp.write_row((*r, now_s))
                if upc_rows:
                    with cur.copy("COPY celr_product_upcs (upc_norm, cpn, assigned_at) FROM STDIN") as cp:
                        for r in upc_rows:
                            cp.write_row((*r, now_s))
                if key_rows:
                    with cur.copy("COPY celr_family_keys (key, cpn) FROM STDIN") as cp:
                        for r in key_rows:
                            cp.write_row(r)
            else:
                for i in range(0, len(fam_rows), CHUNK):
                    cur.executemany(
                        "INSERT INTO celr_families (cpn, family_key, header_name, brand, product_type, created_at) "
                        "VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT (family_key) DO NOTHING",
                        [(*r, now_s) for r in fam_rows[i:i + CHUNK]])
                for i in range(0, len(upc_rows), CHUNK):
                    cur.executemany(
                        "INSERT INTO celr_product_upcs (upc_norm, cpn, assigned_at) "
                        "VALUES (%s, %s, %s) ON CONFLICT (upc_norm) DO NOTHING",
                        [(*r, now_s) for r in upc_rows[i:i + CHUNK]])
                for i in range(0, len(key_rows), CHUNK):
                    cur.executemany(
                        "INSERT INTO celr_family_keys (key, cpn) VALUES (%s, %s) "
                        "ON CONFLICT (key) DO NOTHING", key_rows[i:i + CHUNK])
        n_f = pg.execute("SELECT COUNT(*) AS n FROM celr_families").fetchone()["n"]
        n_u = pg.execute("SELECT COUNT(*) AS n FROM celr_product_upcs").fetchone()["n"]
        n_k = pg.execute("SELECT COUNT(*) AS n FROM celr_family_keys").fetchone()["n"]
    print(f"new families: {len(fam_rows)}  new upcs: {len(upc_rows)}  new keys: {len(key_rows)}")
    print(f"registry totals: {n_f} families, {n_u} upcs, {n_k} keys")

    # ---- 6) parquet exports for the dev cache (alias-resolved) ----
    from backend.pg import DATABASE_URL
    from backend.pricing_cache import pg_libpq
    con.execute("INSTALL postgres; LOAD postgres;")
    con.execute(f"ATTACH '{pg_libpq(DATABASE_URL)}' AS pg (TYPE postgres, READ_ONLY)")
    con.execute(f"""
        COPY (SELECT u.upc_norm, COALESCE(a.canonical_cpn, u.cpn) AS cpn,
                     f.header_name, f.brand
              FROM pg.celr_product_upcs u
              LEFT JOIN pg.celr_family_aliases a ON a.cpn = u.cpn
              JOIN pg.celr_families f ON f.cpn = COALESCE(a.canonical_cpn, u.cpn)
        ) TO '{OUT_UPCS.as_posix()}' (FORMAT PARQUET)""")
    con.execute(f"""
        COPY (SELECT k.key, COALESCE(a.canonical_cpn, k.cpn) AS cpn, f.header_name
              FROM pg.celr_family_keys k
              LEFT JOIN pg.celr_family_aliases a ON a.cpn = k.cpn
              JOIN pg.celr_families f ON f.cpn = COALESCE(a.canonical_cpn, k.cpn)
        ) TO '{OUT_KEYS.as_posix()}' (FORMAT PARQUET)""")
    con.execute("DETACH pg")
    print(f"wrote {OUT_UPCS}")
    print(f"wrote {OUT_KEYS}")


if __name__ == "__main__":
    main()
