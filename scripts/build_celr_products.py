"""Build / update the CELR Product Number registry.

See docs/CELR_PRODUCT_NUMBER_DESIGN.md. Assigns every CLEAN barcode in the
catalogue to a product FAMILY (cpn) that spans sizes, vintages and
distributors, and standardizes a header_name per family.

Incremental and idempotent:
  - existing upc -> cpn assignments are NEVER changed (numbers are stable),
  - new UPCs join an existing family when their normalized core matches,
    else they mint the next cpn,
  - header_name/brand on a family may be refreshed when richer enrichment
    arrives; the identity (cpn, family_key) never moves,
  - manual curation lives in celr_family_aliases and is never touched here.

Inputs : parquet_output/derived/cpl_enriched.parquet (all editions)
         product_enrichment table in Postgres (DATABASE_URL)
Outputs: celr_families / celr_product_upcs in Postgres
         parquet_output/derived/celr_products.parquet (flattened, for the
         parquet dev cache)

Run after every monthly ingest:
    python scripts/build_celr_products.py
"""
from __future__ import annotations

import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.pg import get_pg                              # noqa: E402
from backend.routers.catalog import (                      # noqa: E402
    _catalog_core, _display_name, _header_junk, _is_clean_upc, _product_core,
)

PARQUET = ROOT / "parquet_output" / "derived" / "cpl_enriched.parquet"
OUT_PARQUET = ROOT / "parquet_output" / "derived" / "celr_products.parquet"

# Standalone vintage years inside a name (wine cores only).
_YEAR_RE = re.compile(r"\b(?:19|20)\d{2}\b")
_TRAIL2_RE = re.compile(r"\s\d{2}$")

# Words that never DISTINGUISH two products of the same brand line: articles,
# packaging words, and unambiguous category descriptors. Words that CAN
# distinguish (bourbon vs rye, flavours, cask finishes, colours, proof
# numbers) are deliberately NOT here: a wrong split is cheap to alias-merge
# later, a wrong merge corrupts history.
_STOPWORDS = {
    "the", "a", "of", "with", "w", "and",
    "carton", "gift", "box", "set", "vap", "bottle", "btl", "can", "pk",
    "wine", "whisky", "whiskey", "scotch", "single", "malt", "blended",
}
_AGE_WORDS = {"year", "years", "yr", "yrs", "y", "old", "aged"}


def norm_upc(v) -> str:
    return re.sub(r"\D", "", str(v or "")).lstrip("0")


def family_core(name: str | None, product_type: str | None, enriched: bool) -> str:
    """Order-independent token signature of a product family.

    Starts from the existing app cores (size/pack handled there), then:
      - wine: vintage years + trailing 2-digit vintage tokens drop (variant),
      - apostrophes/punct collapse (founder's == founders),
      - age tokens normalize ("12 year" == "12 yr" == "12yr" -> "12yr"),
      - category/packaging stopwords drop,
      - tokens sort, so word order can't split a family
        ("Glenlivet Founders Reserve Single Malt Scotch Whisky" ==
         "Glenlivet Founder's Reserve Whisky, Scotch, Single Malt").
    """
    # Apostrophes must go BEFORE the core regexes (they would turn "Founder's"
    # into "founder s", leaving an orphan token that splits the family).
    clean = (name if isinstance(name, str) else "").replace("'", "").replace("’", "")
    core = _product_core(clean) if enriched else _catalog_core(clean)
    if "wine" in str(product_type or "").lower():
        core = _YEAR_RE.sub(" ", core)
        core = _TRAIL2_RE.sub("", core.rstrip())
    raw = [t for t in re.split(r"[^a-z0-9]+", core.lower()) if t]
    toks: list[str] = []
    i = 0
    while i < len(raw):
        t = raw[i]
        if i + 1 < len(raw) and t.isdigit() and raw[i + 1] in _AGE_WORDS:
            toks.append(f"{int(t)}yr")
            i += 2
            while i < len(raw) and raw[i] in _AGE_WORDS:
                i += 1
            continue
        m = re.fullmatch(r"(\d+)(?:yr|yrs|y)", t)
        if m:
            toks.append(f"{int(m.group(1))}yr")
            i += 1
            continue
        if t not in _STOPWORDS and t not in _AGE_WORDS:
            toks.append(t)
        i += 1
    return " ".join(sorted(set(toks)))


def main() -> None:
    # ---- 1) catalogue rows (every edition, so identity covers history) ----
    con = duckdb.connect()
    rows = con.execute(
        f"""SELECT CAST(upc AS VARCHAR) AS upc, product_name, product_type
            FROM '{PARQUET.as_posix()}'
            WHERE upc IS NOT NULL"""
    ).fetchdf().to_dict("records")

    by_upc: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        if not _is_clean_upc(r["upc"]):
            continue
        by_upc[norm_upc(r["upc"])].append(r)
    print(f"clean UPCs in catalogue: {len(by_upc)}")

    # ---- 2) enrichment names/brands from Postgres ----
    with get_pg() as pg:
        enr = {str(r["upc"] if isinstance(r, dict) else r[0]):
               (r["name"] if isinstance(r, dict) else r[1],
                r["brand"] if isinstance(r, dict) else r[2])
               for r in pg.execute(
                   "SELECT upc, name, brand FROM product_enrichment "
                   "WHERE name IS NOT NULL AND name <> ''").fetchall()}
    print(f"enriched UPCs: {len(enr)}")

    # ---- 3) per-UPC preferred core + display candidates ----
    upc_core: dict[str, str] = {}
    upc_cat_core: dict[str, str] = {}
    upc_header: dict[str, str] = {}
    upc_brand: dict[str, str] = {}
    upc_type: dict[str, str] = {}
    for un, recs in by_upc.items():
        ptype = Counter(str(r.get("product_type") or "") for r in recs).most_common(1)[0][0]
        upc_type[un] = ptype
        names = Counter(str(r.get("product_name") or "").strip() for r in recs)
        best_cat = sorted(names.items(),
                          key=lambda kv: (_header_junk(kv[0]), -kv[1], -len(kv[0])))[0][0]
        cat_core = family_core(best_cat, ptype, enriched=False)
        upc_cat_core[un] = cat_core
        e = enr.get(un)
        if e and e[0]:
            upc_core[un] = family_core(e[0], ptype, enriched=True)
            upc_header[un] = _display_name(e[0])
            if e[1]:
                upc_brand[un] = str(e[1])
        else:
            upc_core[un] = cat_core
            upc_header[un] = best_cat

    # ---- 4) bridge: unenriched UPCs whose CATALOG core matches a sibling
    #      enriched UPC's catalog core adopt the enriched family core, so a
    #      family isn't split just because only some sizes are enriched. ----
    bridge: dict[str, Counter] = defaultdict(Counter)
    for un in by_upc:
        if enr.get(un) and upc_cat_core[un]:
            bridge[upc_cat_core[un]][upc_core[un]] += 1
    bridged = 0
    for un in by_upc:
        if not enr.get(un) and upc_cat_core[un] in bridge:
            upc_core[un] = bridge[upc_cat_core[un]].most_common(1)[0][0]
            bridged += 1
    print(f"unenriched UPCs bridged into enriched families: {bridged}")

    # ---- 5) incremental assignment against the registry ----
    with get_pg() as pg:
        # ensure tables exist even before the app has booted with the new DDL
        pg.execute("""CREATE TABLE IF NOT EXISTS celr_families (
            cpn integer PRIMARY KEY, family_key text NOT NULL UNIQUE,
            header_name text, brand text, product_type text,
            created_at text)""")
        pg.execute("""CREATE TABLE IF NOT EXISTS celr_product_upcs (
            upc_norm text PRIMARY KEY,
            cpn integer NOT NULL REFERENCES celr_families(cpn),
            assigned_at text)""")
        pg.execute("""CREATE TABLE IF NOT EXISTS celr_family_aliases (
            cpn integer PRIMARY KEY, canonical_cpn integer NOT NULL)""")

        fam_by_key = {r["family_key"]: r["cpn"] for r in
                      pg.execute("SELECT family_key, cpn FROM celr_families").fetchall()}
        fam_headers = {r["cpn"]: r["header_name"] for r in
                       pg.execute("SELECT cpn, header_name FROM celr_families").fetchall()}
        assigned = {r["upc_norm"]: r["cpn"] for r in
                    pg.execute("SELECT upc_norm, cpn FROM celr_product_upcs").fetchall()}
        next_cpn = (max(fam_by_key.values()) + 1) if fam_by_key else 1

        # Batched writes: the backfill is ~28k families + ~32k upcs, and the
        # production DB is remote, so per-row round trips would crawl.
        now = "to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')"
        fam_rows: list[tuple] = []
        upc_rows: list[tuple] = []
        fam_members: dict[int, list[str]] = defaultdict(list)
        for un in by_upc:
            if un in assigned:
                fam_members[assigned[un]].append(un)
                continue
            ptype = upc_type[un]
            key = f"{'wine' if 'wine' in ptype.lower() else 'x'}|{upc_core[un]}"
            if not upc_core[un]:
                continue   # no usable name; leave unmapped (legacy grouping)
            cpn = fam_by_key.get(key)
            if cpn is None:
                cpn = next_cpn
                next_cpn += 1
                fam_by_key[key] = cpn
                fam_headers[cpn] = upc_header[un]
                fam_rows.append((cpn, key, upc_header[un], upc_brand.get(un), ptype))
            upc_rows.append((un, cpn))
            assigned[un] = cpn
            fam_members[cpn].append(un)

        CHUNK = 1000
        with pg.cursor() as cur:
            for i in range(0, len(fam_rows), CHUNK):
                cur.executemany(
                    "INSERT INTO celr_families (cpn, family_key, header_name, brand, product_type, created_at) "
                    f"VALUES (%s, %s, %s, %s, %s, {now}) ON CONFLICT (family_key) DO NOTHING",
                    fam_rows[i:i + CHUNK])
            for i in range(0, len(upc_rows), CHUNK):
                cur.executemany(
                    "INSERT INTO celr_product_upcs (upc_norm, cpn, assigned_at) "
                    f"VALUES (%s, %s, {now}) ON CONFLICT (upc_norm) DO NOTHING",
                    upc_rows[i:i + CHUNK])
        new_fams, new_upcs = len(fam_rows), len(upc_rows)

        # Refresh headers where an ENRICHED name exists for a family whose
        # stored header is still a raw ALL-CAPS catalogue name (identity
        # unchanged; display only).
        updates: list[tuple] = []
        for cpn, members in fam_members.items():
            enriched_headers = [upc_header[u] for u in members if enr.get(u)]
            if not enriched_headers:
                continue
            best = sorted(enriched_headers, key=lambda s: -len(s))[0]
            cur_name = fam_headers.get(cpn)
            if best and cur_name != best and (cur_name or "").upper() == (cur_name or ""):
                updates.append((best, cpn))
        with pg.cursor() as cur:
            for i in range(0, len(updates), CHUNK):
                cur.executemany("UPDATE celr_families SET header_name=%s WHERE cpn=%s",
                                updates[i:i + CHUNK])
        upgraded = len(updates)

        n_f = pg.execute("SELECT COUNT(*) AS n FROM celr_families").fetchone()["n"]
        n_u = pg.execute("SELECT COUNT(*) AS n FROM celr_product_upcs").fetchone()["n"]
    print(f"new families: {new_fams}  new upc assignments: {new_upcs}  headers upgraded: {upgraded}")
    print(f"registry totals: {n_f} families, {n_u} upcs")

    # ---- 6) parquet export for the dev cache (alias-resolved, flattened) ----
    from backend.pg import DATABASE_URL
    from backend.pricing_cache import pg_libpq
    con.execute("INSTALL postgres; LOAD postgres;")
    con.execute(f"ATTACH '{pg_libpq(DATABASE_URL)}' AS pg (TYPE postgres, READ_ONLY)")
    con.execute(f"""
        COPY (
            SELECT u.upc_norm,
                   COALESCE(a.canonical_cpn, u.cpn) AS cpn,
                   f.header_name, f.brand
            FROM pg.celr_product_upcs u
            LEFT JOIN pg.celr_family_aliases a ON a.cpn = u.cpn
            JOIN pg.celr_families f ON f.cpn = COALESCE(a.canonical_cpn, u.cpn)
        ) TO '{OUT_PARQUET.as_posix()}' (FORMAT PARQUET)
    """)
    con.execute("DETACH pg")
    print(f"wrote {OUT_PARQUET}")


if __name__ == "__main__":
    main()
