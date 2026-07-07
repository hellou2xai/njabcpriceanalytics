"""
Pricing cache: a local DuckDB database materialised from the canonical store.

Option 1 architecture: the processed pricing tables live in Postgres (loaded
monthly by scripts/ingest_to_postgres.py). At boot, and on demand, we copy them
into a local DuckDB file and serve every analytical query from there, unchanged.
DuckDB stays the query engine, so none of the ~144 analytical queries change.

PRICING_SOURCE selects where the cache is built from:
  - "postgres" (default): copy from the attached Postgres database.
  - "parquet": read the Parquet files directly (handy for local dev before any
    Postgres ingestion has run).

The cache file is versioned (pricing_<ts>.duckdb) and swapped atomically by
pointer, so a reload never overwrites a file that open read connections hold.
"""

import os
import time
import threading
from pathlib import Path
from urllib.parse import urlparse, parse_qsl

import duckdb

from backend.db import PROJECT_ROOT, PARQUET_DIR

PRICING_SOURCE = os.getenv("PRICING_SOURCE", "postgres")  # 'postgres' | 'parquet'
CACHE_DIR = PROJECT_ROOT / "user_data"

# Single-file (derived) tables vs Hive-partitioned (raw) tables, matching the
# Parquet layout. These names are exactly what read_parquet() is called with.
DERIVED = ["cpl_enriched", "price_changes", "item_lifecycle",
           "cross_source_links", "rip_credits"]
RAW = ["cpl", "rip", "combo"]
ALL_TABLES = DERIVED + RAW

_lock = threading.Lock()
_current_path: Path | None = None
_last_pointer_check = 0.0

# ---- Shared cache across workers -------------------------------------------
# Each uvicorn worker is a separate process; building the cache once per worker
# meant N concurrent multi-GB builds at boot (the OOM). Instead we coordinate:
#   * _BUILD_LOCK_FILE  — a cross-process exclusive lock so only ONE process
#     builds at a time; the others wait and adopt the finished file.
#   * _POINTER          — a tiny file holding the active cache filename. Every
#     worker reads it (throttled) to discover the current file, so a reload in
#     ONE worker propagates to all of them without a restart.
# A build writes to a hidden temp file and atomically renames it into place, so
# no worker ever opens a half-written cache.
_POINTER = CACHE_DIR / "pricing_current"
_BUILD_LOCK_FILE = CACHE_DIR / "pricing_build.lock"
_POINTER_CHECK_INTERVAL = 3.0   # seconds; throttle the pointer re-read hot path


def _read_pointer() -> "Path | None":
    """The active cache file named by the pointer, or None if absent/missing."""
    try:
        name = _POINTER.read_text().strip()
    except OSError:
        return None
    if not name:
        return None
    p = CACHE_DIR / name
    return p if p.exists() else None


def _write_pointer(path: Path) -> None:
    """Publish the active cache file atomically (temp + rename)."""
    tmp = CACHE_DIR / f".pointer_{os.getpid()}.tmp"
    try:
        tmp.write_text(path.name)
        os.replace(tmp, _POINTER)  # atomic on Windows + POSIX
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass


def _acquire_build_lock(timeout: float, stale: float = 1800.0):
    """Cross-process exclusive lock via O_CREAT|O_EXCL. Returns an fd, or None on
    timeout. A lock older than `stale` (a crashed builder) is reclaimed."""
    deadline = time.time() + timeout
    while True:
        try:
            fd = os.open(str(_BUILD_LOCK_FILE), os.O_CREAT | os.O_EXCL | os.O_RDWR)
            try:
                os.write(fd, str(os.getpid()).encode())
            except OSError:
                pass
            return fd
        except FileExistsError:
            try:
                if time.time() - os.path.getmtime(_BUILD_LOCK_FILE) > stale:
                    os.unlink(_BUILD_LOCK_FILE)
                    continue  # reclaim a crashed builder's lock
            except OSError:
                pass
            if time.time() >= deadline:
                return None
            time.sleep(0.4)


def _release_build_lock(fd) -> None:
    try:
        os.close(fd)
    except OSError:
        pass
    try:
        os.unlink(_BUILD_LOCK_FILE)
    except OSError:
        pass


def _wait_for_pointer(timeout: float) -> "Path | None":
    """Poll the pointer until a builder publishes a file (or timeout)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        p = _read_pointer()
        if p is not None:
            return p
        time.sleep(0.5)
    return None

# Vintage normalisation used in the price_trend recompute's partition key.
# Kept byte-identical to nj_abc_parser/derive.py so "same product across editions"
# is grouped the same way here as when the column is first derived.
_VINTAGE_NORM_SQL = (
    "CASE "
    "WHEN vintage IS NULL OR vintage = '' THEN NULL "
    "WHEN UPPER(vintage) IN ('NA','N/A','NONE','NV') THEN NULL "
    "WHEN regexp_matches(vintage, '^[0-9]{4}$') THEN vintage "
    "WHEN regexp_matches(vintage, '^[0-9]{4}\\.0+$') THEN substr(vintage, 1, 4) "
    "WHEN regexp_matches(vintage, '^[0-9]{2}$') THEN "
    "CASE WHEN CAST(vintage AS INTEGER) <= 30 THEN '20' || vintage ELSE '19' || vintage END "
    "ELSE NULL END"
)


def _parquet_select(table: str) -> str:
    pdir = PARQUET_DIR.as_posix()
    if table in DERIVED:
        return f"read_parquet('{pdir}/derived/{table}.parquet')"
    return f"read_parquet('{pdir}/{table}/**/data.parquet', hive_partitioning=true, union_by_name=true)"


def pg_libpq(url: str) -> str:
    """Convert a DATABASE_URL into a libpq keyword string for DuckDB's ATTACH.

    Query params are preserved, so a Render external URL with sslmode=require
    connects with SSL the same way psycopg does."""
    u = urlparse(url)
    parts = []
    if u.hostname: parts.append(f"host={u.hostname}")
    if u.port: parts.append(f"port={u.port}")
    if u.username: parts.append(f"user={u.username}")
    if u.password: parts.append(f"password={u.password}")
    db = u.path.lstrip("/")
    if db: parts.append(f"dbname={db}")
    for k, v in parse_qsl(u.query):
        parts.append(f"{k}={v}")
    return " ".join(parts)


def _cleanup_old(keep: Path | None):
    """Best-effort removal of stale cache files.

    Skips the keep file, anything modified in the last 10 minutes (likely held
    by a sibling worker that just rebuilt it), and anything whose unlink fails
    because a reader still has it open. Multiple uvicorn workers each maintain
    their own _current_path, so we must not sweep each other's fresh files."""
    now = time.time()
    for p in CACHE_DIR.glob("pricing_*.duckdb"):
        if keep is not None and p == keep:
            continue
        try:
            if now - p.stat().st_mtime < 600:
                continue  # another worker built this recently; leave it alone
            p.unlink()
        except OSError:
            pass  # a reader still has it open; leave it for next time
    # Sweep abandoned build temps (a crashed/killed builder) plus any orphaned
    # DuckDB WAL siblings, but never one being written right now.
    for pat in (".building_*.duckdb", ".building_*.duckdb.wal"):
        for p in CACHE_DIR.glob(pat):
            try:
                if now - p.stat().st_mtime < 600:
                    continue
                p.unlink()
            except OSError:
                pass


def build_pricing_cache(force: bool = False) -> Path:
    """(Re)build the cache into a fresh versioned file and point at it. Returns
    the new file path.

    Coordinated across workers: a cross-process lock means only ONE process
    builds at a time (no more N concurrent multi-GB builds at boot), and the
    file is published atomically via a pointer the other workers read. With
    `force=False` (boot/first-use), if a sibling already published a current
    file while we waited, we ADOPT it instead of building a duplicate. With
    `force=True` (admin reload / new monthly data), we always build fresh."""
    global _current_path
    with _lock:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        # Only one process builds at a time. If we can't get the lock, another
        # process is building — wait for its pointer rather than build a dup.
        _lock_fd = _acquire_build_lock(
            timeout=float(os.getenv("DUCKDB_BUILD_LOCK_WAIT", "600")))
        if _lock_fd is None:
            adopted = _wait_for_pointer(timeout=180)
            if adopted is not None:
                _current_path = adopted
                return adopted
            # Builder seems stuck and never published; fall through and build
            # ourselves (without the lock) as a last resort.
        try:
            if not force:
                # A sibling may have published a fresh file while we waited on
                # the lock — adopt it instead of rebuilding.
                target = _read_pointer()
                if target is not None:
                    _current_path = target
                    return target
            _stamp = f"{int(time.time() * 1000)}_{os.getpid()}"
            new_path = CACHE_DIR / f"pricing_{_stamp}.duckdb"
            # Build into a hidden temp, then atomically rename into place so no
            # worker ever opens a half-written cache.
            tmp_path = CACHE_DIR / f".building_{_stamp}.duckdb"
            for _stale in (tmp_path, Path(str(tmp_path) + ".wal")):
                try:
                    _stale.unlink()
                except OSError:
                    pass
            con = duckdb.connect(str(tmp_path))
            # Bound the BUILD connection's memory. DuckDB defaults memory_limit to
            # ~80% of system RAM, and EACH uvicorn worker builds its own cache at
            # boot (the _lock is per-process, so it does NOT serialise across
            # forked workers). Two concurrent builds each grabbing ~80% of RAM OOMs
            # the container even with zero users — which is exactly what we hit when
            # the catalogue grew. Cap each build and give it a spill directory so a
            # large CREATE TABLE AS SELECT / sku_offer build spills to disk instead
            # of blowing the box. Tunable via env without a code change.
            try:
                _bmem = os.getenv("DUCKDB_BUILD_MEMORY_LIMIT", "2GB")
                _bthreads = os.getenv("DUCKDB_BUILD_THREADS", "2")
                _bspill = os.getenv("DUCKDB_TEMP_DIR") or str(CACHE_DIR / "build_spill")
                os.makedirs(_bspill, exist_ok=True)
                con.execute(f"SET memory_limit='{_bmem}'")
                con.execute(f"SET threads TO {_bthreads}")
                con.execute(f"SET temp_directory='{_bspill}'")
            except Exception:
                pass
            try:
                # Enrichment columns surfaced to the catalogue (everything useful
                # Go-UPC returns, minus the raw attributes blob which stays in
                # Postgres). category_path/specs are JSON text parsed by the API.
                enrich_cols = (
                    "upc, name, brand, category, category_path, description, region, "
                    "specs, ean, code_type, barcode_url, inferred, image_url, image_source, "
                    # LLM geo/varietal enrichment (canonical taxonomy). See
                    # backend/taxonomy.py + scripts/enrich_geo_run.py.
                    "geo_country, geo_region, geo_subregion, geo_appellation, "
                    "geo_varietal, geo_color, geo_style, geo_classification"
                )
                empty_enrich = (
                    "CREATE TABLE product_enrichment ("
                    "upc VARCHAR, name VARCHAR, brand VARCHAR, category VARCHAR, "
                    "category_path VARCHAR, description VARCHAR, region VARCHAR, "
                    "specs VARCHAR, ean VARCHAR, code_type VARCHAR, barcode_url VARCHAR, "
                    "inferred INTEGER, image_url VARCHAR, image_source VARCHAR, "
                    "geo_country VARCHAR, geo_region VARCHAR, geo_subregion VARCHAR, "
                    "geo_appellation VARCHAR, geo_varietal VARCHAR, geo_color VARCHAR, "
                    "geo_style VARCHAR, geo_classification VARCHAR)"
                )
                # Allied (ABG) SKU<->UPC translation table, loaded by
                # scripts/load_sku_mapping.py. Joined onto Allied catalogue rows by
                # the normalised UPC to surface the distributor's own item number.
                empty_sku = (
                    "CREATE TABLE sku_mapping ("
                    "distributor VARCHAR, abg_sku VARCHAR, upc VARCHAR, "
                    "upc_norm VARCHAR, brand_reg VARCHAR, item_name VARCHAR)"
                )
                # Allied's authoritative SKU translation (scripts/load_allied_translation.py):
                # the ABG item number per FULL SKU identity (UPC + size_ml + pack +
                # vintage). Joined onto Allied cpl rows below to set dist_item_no.
                empty_allied_xref = (
                    "CREATE TABLE allied_sku_xref ("
                    "upc_norm VARCHAR, size_ml INTEGER, pack VARCHAR, "
                    "vintage_norm VARCHAR, sku VARCHAR, product_name VARCHAR)"
                )
                # Fuller Allied item names resolved from the Wine Chateau x ABG
                # inventory export by EXACT UPC + brand-anchored semantic name
                # agreement (scripts/load_allied_name_xref.py). Keyed on
                # (upc_norm, cpl_name) so the fuller name is attached ONLY to the
                # Allied row whose abbreviated CPL name actually agrees — never
                # across a shared/placeholder barcode. Sets dist_item_name (fuller)
                # + dist_item_no (ABG SKU); never touches product_name.
                empty_allied_name_xref = (
                    "CREATE TABLE allied_name_xref ("
                    "upc_norm VARCHAR, cpl_name VARCHAR, dist_item_name VARCHAR, "
                    "abg_sku VARCHAR, score DOUBLE)"
                )
                # Fuller Fedway item names resolved from the Fedway "BR2" product
                # export (scripts/load_fedway_name_xref.py). Fedway's SKU IS our
                # dist_item_no, so keyed on (sku_norm, cpl_name); a SKU match is
                # confirmed by UPC or brand-anchored name agreement (guards Fedway's
                # recycled SKUs). Sets dist_item_name; never touches product_name.
                empty_fedway_name_xref = (
                    "CREATE TABLE fedway_name_xref ("
                    "sku_norm VARCHAR, cpl_name VARCHAR, dist_item_name VARCHAR, "
                    "upc_norm VARCHAR, score DOUBLE, match_type VARCHAR)"
                )
                # Market-intelligence 9L sales volume per brand (Nielsen-style
                # Category Performance + Wine files), mapped to our catalogue's
                # enriched brand by normalised name (scripts/build via the LLM
                # brand crosswalk). Keyed on brand_norm = UPPER minus non-alphanum.
                # Powers the "sort by sales volume" mode on the MI Top-Category rails.
                empty_brand_mi_volume = (
                    "CREATE TABLE brand_mi_volume ("
                    "brand_norm VARCHAR, volume_9l DOUBLE, source VARCHAR)"
                )
                # Distributor-supplied product images re-hosted in R2
                # (scripts/load_dist_images.py). Allied keyed by upc_norm, Fedway
                # by sku_norm. Used ONLY to fill an image the Go-UPC enrichment is
                # missing; never overrides a Go-UPC image.
                empty_dist_image = (
                    "CREATE TABLE dist_image ("
                    "wholesaler VARCHAR, upc_norm VARCHAR, sku_norm VARCHAR, image_url VARCHAR)"
                )
                # CELR Product Number registry, flattened + alias-resolved (see
                # docs/CELR_PRODUCT_NUMBER_DESIGN.md; built by
                # scripts/build_celr_products.py). Maps every clean barcode to its
                # product FAMILY so the grid groups sizes/vintages/distributors.
                empty_celr = (
                    "CREATE TABLE celr_products ("
                    "upc_norm VARCHAR, cpn INTEGER, header_name VARCHAR, brand VARCHAR)"
                )
                empty_celr_keys = (
                    "CREATE TABLE celr_family_keys ("
                    "key VARCHAR, cpn INTEGER, header_name VARCHAR)"
                )
                # Half-case rule layer (nj_abc_parser.rip_rules): per-UPC case
                # credits. Missing source (pre-rollout DB / first run) -> empty
                # table, which every consumer reads as credit 1.0.
                empty_credits = (
                    "CREATE TABLE rip_credits ("
                    "wholesaler VARCHAR, edition VARCHAR, rip_code VARCHAR, "
                    "upc VARCHAR, case_credit DOUBLE, split_pack DOUBLE, "
                    "split_credit DOUBLE, rule_kind VARCHAR, method VARCHAR, "
                    "rule_excerpt VARCHAR)"
                )
                if PRICING_SOURCE == "parquet":
                    for t in ALL_TABLES:
                        if t == "rip_credits":
                            continue  # guarded create below
                        con.execute(f"CREATE TABLE {t} AS SELECT * FROM {_parquet_select(t)}")
                    try:
                        con.execute(
                            f"CREATE TABLE rip_credits AS SELECT * FROM {_parquet_select('rip_credits')}")
                    except Exception:  # derived file not built yet
                        con.execute(empty_credits)
                    # No enrichment in parquet dev mode; an empty table keeps joins valid.
                    con.execute(empty_enrich)
                    con.execute(empty_sku)
                    con.execute(empty_allied_xref)
                    con.execute(empty_allied_name_xref)
                    con.execute(empty_fedway_name_xref)
                    con.execute(empty_brand_mi_volume)
                    con.execute(empty_dist_image)
                    con.execute("CREATE TABLE ai_deal_blurbs (wholesaler VARCHAR, upc VARCHAR, edition VARCHAR, blurb VARCHAR)")
                    _celr_pq = PARQUET_DIR / "derived" / "celr_products.parquet"
                    if _celr_pq.exists():
                        con.execute(
                            f"CREATE TABLE celr_products AS SELECT * FROM read_parquet('{_celr_pq.as_posix()}')")
                    else:
                        con.execute(empty_celr)
                    _celr_keys_pq = PARQUET_DIR / "derived" / "celr_family_keys.parquet"
                    if _celr_keys_pq.exists():
                        con.execute(
                            f"CREATE TABLE celr_family_keys AS SELECT * FROM read_parquet('{_celr_keys_pq.as_posix()}')")
                    else:
                        con.execute(empty_celr_keys)
                else:
                    from backend.pg import DATABASE_URL
                    con.execute("INSTALL postgres; LOAD postgres;")
                    con.execute(f"ATTACH '{pg_libpq(DATABASE_URL)}' AS pg (TYPE postgres, READ_ONLY)")
                    for t in ALL_TABLES:
                        if t == "rip_credits":
                            continue  # guarded create below
                        con.execute(f"CREATE TABLE {t} AS SELECT * FROM pg.{t}")
                    try:
                        con.execute("CREATE TABLE rip_credits AS SELECT * FROM pg.rip_credits")
                    except Exception:  # not ingested yet on this DB
                        con.execute(empty_credits)
                    try:
                        con.execute(f"CREATE TABLE product_enrichment AS SELECT {enrich_cols} FROM pg.product_enrichment")
                    except Exception:  # table may not exist yet on a brand-new DB
                        con.execute(empty_enrich)
                    try:
                        con.execute("CREATE TABLE sku_mapping AS SELECT distributor, abg_sku, upc, upc_norm, brand_reg, item_name FROM pg.sku_mapping")
                    except Exception:  # table not loaded yet
                        con.execute(empty_sku)
                    # AI-generated deal blurbs (one per product per edition). Used by
                    # the Time-Sensitive Deals endpoint to attach an "AI says" line.
                    try:
                        con.execute("CREATE TABLE ai_deal_blurbs AS SELECT wholesaler, upc, edition, blurb FROM pg.ai_deal_blurbs")
                    except Exception:
                        con.execute("CREATE TABLE ai_deal_blurbs (wholesaler VARCHAR, upc VARCHAR, edition VARCHAR, blurb VARCHAR)")
                    try:
                        # Alias-resolved flatten so the cache always serves the
                        # CANONICAL family even after manual merges.
                        con.execute("""
                            CREATE TABLE celr_products AS
                            SELECT u.upc_norm,
                                   COALESCE(a.canonical_cpn, u.cpn) AS cpn,
                                   f.header_name, f.brand
                            FROM pg.celr_product_upcs u
                            LEFT JOIN pg.celr_family_aliases a ON a.cpn = u.cpn
                            JOIN pg.celr_families f ON f.cpn = COALESCE(a.canonical_cpn, u.cpn)
                        """)
                    except Exception:   # registry not built yet
                        con.execute(empty_celr)
                    try:
                        # Name-key lookup for rows whose barcode is a placeholder:
                        # the serving layer computes the row's family key and joins
                        # here (same alias resolution as celr_products).
                        con.execute("""
                            CREATE TABLE celr_family_keys AS
                            SELECT k.key,
                                   COALESCE(a.canonical_cpn, k.cpn) AS cpn,
                                   f.header_name
                            FROM pg.celr_family_keys k
                            LEFT JOIN pg.celr_family_aliases a ON a.cpn = k.cpn
                            JOIN pg.celr_families f ON f.cpn = COALESCE(a.canonical_cpn, k.cpn)
                        """)
                    except Exception:
                        con.execute(empty_celr_keys)
                    try:
                        con.execute("CREATE TABLE allied_sku_xref AS SELECT upc_norm, size_ml, pack, vintage_norm, sku, product_name FROM pg.allied_sku_xref")
                    except Exception:  # not loaded yet
                        con.execute(empty_allied_xref)
                    try:
                        con.execute("CREATE TABLE allied_name_xref AS SELECT upc_norm, cpl_name, dist_item_name, abg_sku, score FROM pg.allied_name_xref")
                    except Exception:  # not loaded yet
                        con.execute(empty_allied_name_xref)
                    try:
                        con.execute("CREATE TABLE fedway_name_xref AS SELECT sku_norm, cpl_name, dist_item_name, upc_norm, score, match_type FROM pg.fedway_name_xref")
                    except Exception:  # not loaded yet
                        con.execute(empty_fedway_name_xref)
                    try:
                        con.execute("CREATE TABLE brand_mi_volume AS SELECT brand_norm, volume_9l, source FROM pg.brand_mi_volume")
                    except Exception:  # not loaded yet
                        con.execute(empty_brand_mi_volume)
                    try:
                        con.execute("CREATE TABLE dist_image AS SELECT wholesaler, upc_norm, sku_norm, image_url FROM pg.dist_image")
                    except Exception:  # not loaded yet
                        con.execute(empty_dist_image)
                    con.execute("DETACH pg")

                # Wire the catalogue brand to the Go-UPC enriched brand by UPC. CPL
                # brands are noisy/wrong; the enrichment brand (keyed by normalised
                # UPC) is canonical. This corrects the brand everywhere at once: row
                # display, the Brand filter facet, and brand filtering. No-op in
                # parquet dev mode (enrichment table is the empty stub).
                try:
                    con.execute("""
                        UPDATE cpl_enriched
                        SET brand = pe.brand
                        FROM product_enrichment pe
                        WHERE pe.upc = LTRIM(cpl_enriched.upc, '0')
                          AND pe.brand IS NOT NULL AND pe.brand <> ''
                    """)
                except Exception:
                    pass

                # Precompute combo membership so the catalogue can filter to bundle
                # products cheaply (a product is "in combo" if its wholesaler+UPC
                # appears in the combo table).
                try:
                    con.execute("ALTER TABLE cpl_enriched ADD COLUMN in_combo BOOLEAN DEFAULT false")
                    con.execute("""
                        UPDATE cpl_enriched SET in_combo = true
                        WHERE EXISTS (
                            SELECT 1 FROM combo c
                            WHERE c.wholesaler = cpl_enriched.wholesaler
                              AND LTRIM(c.upc, '0') = LTRIM(cpl_enriched.upc, '0')
                        )
                    """)
                except Exception:
                    pass

                # Precompute a standardized size bucket so the Size filter groups by
                # real physical size (750ML, 1.75L, Keg / Bulk, ...) and filters
                # correctly, instead of the ~180 noisy raw unit_volume spellings
                # (oz-expressed bottles, LITER vs 1L, keg ounces, etc.). The mapping
                # is built from the distinct values actually present, so new months
                # with new spellings still normalize. See backend/size_std.py.
                try:
                    from backend.size_std import build_size_map
                    con.execute("ALTER TABLE cpl_enriched ADD COLUMN unit_volume_std VARCHAR")
                    raws = [r[0] for r in con.execute(
                        "SELECT DISTINCT unit_volume FROM cpl_enriched "
                        "WHERE unit_volume IS NOT NULL AND unit_volume <> ''"
                    ).fetchall()]
                    mp = build_size_map(raws)
                    con.execute("CREATE TEMP TABLE _size_map(raw VARCHAR, std VARCHAR)")
                    if mp:
                        con.executemany("INSERT INTO _size_map VALUES (?, ?)", list(mp.items()))
                    con.execute(
                        "UPDATE cpl_enriched SET unit_volume_std = m.std "
                        "FROM _size_map m WHERE m.raw = cpl_enriched.unit_volume"
                    )
                    # Anything with a size we couldn't map still gets a bucket.
                    con.execute(
                        "UPDATE cpl_enriched SET unit_volume_std = 'Other' "
                        "WHERE unit_volume_std IS NULL AND unit_volume IS NOT NULL AND unit_volume <> ''"
                    )
                except Exception:
                    pass

                # Price-trend safety net (recomputed at every cache build so it is
                # self-healing regardless of how stale the source column is). The
                # derived column is forward-looking (this edition vs the NEXT one),
                # so the LATEST loaded edition is null until next month's sheet
                # arrives — e.g. it is July but the July price list is not published
                # until mid-month, so June is still the newest edition. We recompute
                # both-directionally: forward when a next edition exists ("buy now vs
                # wait"), else backward vs the prior edition so Price Increases/Drops
                # and price_movers keep working on the newest edition during the gap.
                try:
                    _cols = {r[0] for r in con.execute("DESCRIBE cpl_enriched").fetchall()}
                    _excl = "EXCLUDE (price_trend)" if "price_trend" in _cols else ""
                    con.execute(f"""
                        CREATE OR REPLACE TABLE cpl_enriched AS
                        SELECT * {_excl},
                            CASE
                                WHEN effective_case_price IS NULL THEN NULL
                                WHEN LEAD(effective_case_price) OVER w IS NOT NULL THEN
                                    CASE
                                        WHEN ABS(LEAD(effective_case_price) OVER w - effective_case_price) <= 0.005 THEN 'flat'
                                        WHEN LEAD(effective_case_price) OVER w < effective_case_price THEN 'drop'
                                        ELSE 'increase'
                                    END
                                WHEN LAG(effective_case_price) OVER w IS NOT NULL THEN
                                    CASE
                                        WHEN ABS(effective_case_price - LAG(effective_case_price) OVER w) <= 0.005 THEN 'flat'
                                        WHEN effective_case_price < LAG(effective_case_price) OVER w THEN 'drop'
                                        ELSE 'increase'
                                    END
                                ELSE NULL
                            END AS price_trend
                        FROM cpl_enriched
                        WINDOW w AS (
                            PARTITION BY wholesaler,
                                         COALESCE(CAST(upc AS VARCHAR), ''),
                                         COALESCE(product_name, ''),
                                         COALESCE(unit_volume, ''),
                                         {_VINTAGE_NORM_SQL}
                            ORDER BY edition
                        )
                    """)
                except Exception:
                    pass

                # ---- Indexes (PERF_TODO #1) --------------------------------------
                # The hot per-request lookups (per-card /search, product detail,
                # rip-siblings, cross-distributor compare) filter a single product by
                # its NORMALISED UPC. Two costs to remove: (1) `LTRIM(upc,'0')` runs
                # the function on all ~176k rows EVERY call, and (2) a function on a
                # column can never use an index. So we materialise the normalised
                # value into a plain `upc_norm` column and index THAT. Measured on the
                # live table: LTRIM(upc,'0')=? ~20ms -> upc_norm=? plain ~1.5ms ->
                # upc_norm=? indexed ~0.2ms (a 60-card grid resolves in one ~1.8ms
                # query). CAST(.. AS VARCHAR) first so a Postgres-typed numeric UPC
                # normalises the same as the parquet string. Built LAST because the
                # price_trend CREATE OR REPLACE above rebuilds cpl_enriched and would
                # otherwise drop the column/index. DuckDB has only ART indexes (no
                # covering/INCLUDE); they serve point lookups, IN-lists and equality
                # joins, not the memoised full-grid sort. All best-effort: a missing
                # table/column must never fail the build.
                def _try(sql):
                    try:
                        con.execute(sql)
                    except Exception:
                        pass

                for _t in ("cpl_enriched", "cpl", "rip", "combo"):
                    _try(f"ALTER TABLE {_t} ADD COLUMN upc_norm VARCHAR")
                    _try(f"UPDATE {_t} SET upc_norm = LTRIM(CAST(upc AS VARCHAR), '0')")

                # Allied (ABG) distributor item numbers, set from the authoritative
                # Allied Translation sheet (allied_sku_xref) by FULL SKU identity
                # (UPC + size_ml + pack + vintage) — one UPC can carry several SKUs,
                # so a UPC-only join would attach the wrong number. The xref holds
                # only UNAMBIGUOUS identities (one SKU each); ambiguous ones are
                # dropped at load time and stay blank here. The cpl-side size_ml /
                # pack / vintage normalisation is kept byte-aligned with the Python
                # in scripts/load_allied_translation.py. Edition-independent and
                # re-applied every build, so it survives re-ingests. attach_sku_mapping
                # then prefers this dist_item_no for Allied (same as Fedway).
                _try("ALTER TABLE cpl_enriched ADD COLUMN dist_item_no VARCHAR")
                # dist_item_name: the distributor's OWN authoritative product name
                # for the item (Allied's sheet name, e.g. "Nigori The Blue One"
                # where the CPL only says "JOTO NIGORI"). New column, Allied-only
                # for now; surfaced alongside dist_item_no.
                _try("ALTER TABLE cpl_enriched ADD COLUMN dist_item_name VARCHAR")
                _ALLIED_SIZE_ML = (
                    "CAST(ROUND(CASE "
                    "WHEN unit_volume IS NULL OR unit_volume = '' THEN NULL "
                    "WHEN UPPER(REPLACE(unit_volume,' ','')) IN ('LITER','LIT','1LITER','1L') THEN 1000 "
                    "WHEN regexp_extract(UPPER(REPLACE(unit_volume,' ','')), '^([0-9.]+)', 1) = '' THEN NULL "
                    "ELSE CAST(regexp_extract(UPPER(REPLACE(unit_volume,' ','')), '^([0-9.]+)', 1) AS DOUBLE) * "
                    "CASE regexp_extract(UPPER(REPLACE(unit_volume,' ','')), '^[0-9.]+(ML|L|LITER|LIT|OZ|FLOZ|GAL|GALLON)', 1) "
                    "WHEN 'L' THEN 1000 WHEN 'LITER' THEN 1000 WHEN 'LIT' THEN 1000 "
                    "WHEN 'OZ' THEN 29.5735 WHEN 'FLOZ' THEN 29.5735 "
                    "WHEN 'GAL' THEN 3785.41 WHEN 'GALLON' THEN 3785.41 ELSE 1 END "
                    "END) AS INTEGER)"
                )
                _ALLIED_PACK = (
                    "CASE WHEN TRY_CAST(unit_qty AS DOUBLE) IS NULL THEN '' "
                    "ELSE CAST(CAST(TRY_CAST(unit_qty AS DOUBLE) AS INTEGER) AS VARCHAR) END"
                )
                _ALLIED_VTG = f"COALESCE({_VINTAGE_NORM_SQL}, '')"
                # Overlay the sheet's number/name ONLY on matched Allied rows —
                # existing values on unmatched rows are left untouched. (Stale '0'
                # placeholders are never DISPLAYED: enrichment_join.attach_sku_mapping
                # treats '0' as blank.)
                _try(f"""
                    UPDATE cpl_enriched
                    SET dist_item_no = x.sku, dist_item_name = x.product_name
                    FROM allied_sku_xref x
                    WHERE cpl_enriched.wholesaler = 'allied'
                      AND x.upc_norm = cpl_enriched.upc_norm
                      AND x.size_ml = {_ALLIED_SIZE_ML}
                      AND x.pack = {_ALLIED_PACK}
                      AND x.vintage_norm = {_ALLIED_VTG}
                """)

                # Fuller Allied item names from the Wine Chateau x ABG inventory,
                # resolved offline by EXACT UPC + brand-anchored semantic name
                # agreement (scripts/load_allied_name_xref.py). Applied by
                # (upc_norm, cpl_name) so the fuller name lands ONLY on the row
                # whose abbreviated CPL name was confirmed to be the same product
                # — the guard against shared/placeholder barcodes. Runs AFTER the
                # allied_sku_xref overlay so this (buyer-chosen, name-verified)
                # source wins on any overlap. Edition-independent, re-applied every
                # build, so it survives re-ingests. product_name is never touched.
                _try("""
                    UPDATE cpl_enriched
                    SET dist_item_name = x.dist_item_name,
                        dist_item_no = COALESCE(NULLIF(x.abg_sku, ''), cpl_enriched.dist_item_no)
                    FROM allied_name_xref x
                    WHERE cpl_enriched.wholesaler = 'allied'
                      AND x.upc_norm = cpl_enriched.upc_norm
                      AND x.cpl_name = cpl_enriched.product_name
                """)

                # Fuller Fedway item names from the Fedway BR2 export, resolved
                # offline by SKU match confirmed by UPC or brand-anchored name
                # agreement (scripts/load_fedway_name_xref.py). Fedway's SKU is
                # already on the row as dist_item_no, so we match on the normalised
                # SKU AND the CPL name (guards recycled SKUs across editions). Only
                # sets dist_item_name (the fuller name); dist_item_no already carries
                # the Fedway number from ingest. product_name is never touched.
                _try("""
                    UPDATE cpl_enriched
                    SET dist_item_name = x.dist_item_name
                    FROM fedway_name_xref x
                    WHERE cpl_enriched.wholesaler = 'fedway'
                      AND LTRIM(CAST(cpl_enriched.dist_item_no AS VARCHAR), '0') = x.sku_norm
                      AND x.cpl_name = cpl_enriched.product_name
                """)

                # has_image: precompute the default-grid "images first" sort key
                # (PERF_TODO #4 / the ~9s sort). The storefront grid floats products
                # with a Go-UPC image to the top; doing that live ran a correlated
                # EXISTS against product_enrichment for every one of ~176k rows on
                # every grid load. Materialise it once: a row is "image first" iff it
                # carries a REAL barcode AND that barcode has a non-empty image. The
                # valid-barcode test mirrors routers/catalog._VALID_UPC_SQL /
                # pricing._clean_upc (keep in sync) so a placeholder barcode that
                # shares an enrichment row never sorts up. Built here because
                # product_enrichment lives only in the cache; needs upc_norm (above).
                # ORDER BY has_image DESC is then a plain low-cardinality column the
                # zonemap drives, no subquery.
                _valid_upc = (
                    "upc IS NOT NULL AND upc <> '' AND upc <> '0'"
                    " AND NOT regexp_matches(upc, '^(0+|9+|1+)$')"
                    " AND NOT regexp_matches(upc,"
                    " '^(0{9}|1{9}|2{9}|3{9}|4{9}|5{9}|6{9}|7{9}|8{9}|9{9})')"
                    " AND NOT upc LIKE '999999%'"
                    " AND LENGTH(LTRIM(upc, '0')) >= 8"
                )
                _try("ALTER TABLE cpl_enriched ADD COLUMN has_image BOOLEAN DEFAULT false")
                _try(f"""UPDATE cpl_enriched SET has_image = true
                         WHERE ({_valid_upc})
                           AND upc_norm IN (SELECT upc FROM product_enrichment
                                            WHERE image_url IS NOT NULL AND image_url <> '')""")

                # Distributor image fallback: fill an R2-hosted distributor image
                # (dist_image) ONLY where the Go-UPC enrichment has none, so the
                # frontend shows a real bottle shot instead of the placeholder.
                # Allied matches by upc_norm, Fedway by sku_norm (LTRIM dist_item_no).
                # The serving layer (enrichment_join.attach_enrichment_image) reads
                # this column as a fallback after the Go-UPC image + admin override.
                _try("ALTER TABLE cpl_enriched ADD COLUMN dist_image_url VARCHAR")
                _try("""UPDATE cpl_enriched SET dist_image_url = di.image_url
                        FROM dist_image di
                        WHERE cpl_enriched.wholesaler = 'allied' AND di.wholesaler = 'allied'
                          AND di.upc_norm = cpl_enriched.upc_norm
                          AND NOT cpl_enriched.has_image""")
                _try("""UPDATE cpl_enriched SET dist_image_url = di.image_url
                        FROM dist_image di
                        WHERE cpl_enriched.wholesaler = 'fedway' AND di.wholesaler = 'fedway'
                          AND di.sku_norm = LTRIM(CAST(cpl_enriched.dist_item_no AS VARCHAR), '0')
                          AND NOT cpl_enriched.has_image""")
                # Fold the distributor image into the images-first sort key too.
                _try("UPDATE cpl_enriched SET has_image = true WHERE dist_image_url IS NOT NULL AND dist_image_url <> ''")

                # Denormalise the Go-UPC enrichment TEXT the Products search matches
                # on (name/category/category_path/region/description), so free-text
                # search reads plain columns on the row instead of running a
                # correlated EXISTS against product_enrichment FOR EVERY ROW. That
                # per-row subquery is the search's CPU cost and dominates on the prod
                # instance (cold "vodka" ~5s there vs <1s with this). Exact parity
                # with the old join (pe.upc = upc_norm); _q_clause reads enr_* when
                # present and falls back to the EXISTS on an older cache.
                for _c in ("enr_name", "enr_category", "enr_category_path",
                           "enr_region", "enr_description"):
                    _try(f"ALTER TABLE cpl_enriched ADD COLUMN {_c} VARCHAR")
                _try("""UPDATE cpl_enriched SET
                          enr_name = pe.name, enr_category = pe.category,
                          enr_category_path = pe.category_path, enr_region = pe.region,
                          enr_description = pe.description
                        FROM product_enrichment pe
                        WHERE pe.upc = cpl_enriched.upc_norm""")

                # spirit_category: a clean spirits taxonomy (Whiskey/Vodka/Tequila/
                # Rum/Gin/Cordials/Brandy/Cognac) derived from the Go-UPC category
                # (enr_category) because our CPL has no spirit-category field. The
                # Go-UPC category classifies ~46k spirit rows directly; the generic
                # "Liquor & Spirits" bucket and rows with no enrichment fall back to
                # product_name keywords. Spirits only; other product_types stay NULL.
                # Powers the market-intelligence "Top <Category>" rails + facet.
                _try("ALTER TABLE cpl_enriched ADD COLUMN spirit_category VARCHAR")
                _try(r"""
                    UPDATE cpl_enriched SET spirit_category = CASE
                      WHEN enr_category IN ('Whiskey','Rye','Bourbon','Scotch','Barley') THEN 'Whiskey'
                      WHEN enr_category = 'Vodka' THEN 'Vodka'
                      WHEN enr_category IN ('Tequila','Mezcal') THEN 'Tequila'
                      WHEN enr_category = 'Rum' THEN 'Rum'
                      WHEN enr_category = 'Gin' THEN 'Gin'
                      WHEN enr_category IN ('Liqueurs','Bitters') THEN 'Cordials'
                      WHEN enr_category = 'Brandy' THEN
                        CASE WHEN regexp_matches(UPPER(product_name || ' ' || COALESCE(enr_name,'')), 'COGNAC')
                             THEN 'Cognac' ELSE 'Brandy' END
                      -- name-keyword fallback (generic 'Liquor & Spirits' / no enrichment),
                      -- tolerant of NJ CPL abbreviations (BRBN, WHSK, VDK, TEQ).
                      WHEN regexp_matches(UPPER(product_name), 'BOURBON|BRBN|WHISK|WHSK|WHIS|SCOTCH|(^| )RYE|IRISH WH') THEN 'Whiskey'
                      WHEN regexp_matches(UPPER(product_name), 'VODKA|VODK|VDK') THEN 'Vodka'
                      WHEN regexp_matches(UPPER(product_name), 'TEQUILA|TEQ|MEZCAL|MEZ ') THEN 'Tequila'
                      WHEN regexp_matches(UPPER(product_name), 'COGNAC|VSOP|( VS )|( XO )') THEN 'Cognac'
                      WHEN regexp_matches(UPPER(product_name), 'BRANDY|GRAPPA|ARMAGNAC|PISCO') THEN 'Brandy'
                      WHEN regexp_matches(UPPER(product_name), '(^| )RUM|CACHACA') THEN 'Rum'
                      WHEN regexp_matches(UPPER(product_name), '(^| )GIN( |$)') THEN 'Gin'
                      WHEN regexp_matches(UPPER(product_name), 'LIQUEUR|LIQ |SCHNAPP|CORDIAL|TRIPLE SEC|AMARETTO|CREME DE|SAMBUCA|APERITIF|APEROL|CAMPARI') THEN 'Cordials'
                      ELSE 'Other'
                    END
                    WHERE product_type = 'Spirits'
                """)

                # mi_volume: the brand's market-intelligence 9L sales volume,
                # denormalised onto the row by normalised brand so the MI rails can
                # ORDER BY it directly (no per-query join). NULL when the brand has
                # no MI match (those sort last). Same denormalise-for-speed pattern
                # as enr_* / has_image above.
                _try("ALTER TABLE cpl_enriched ADD COLUMN mi_volume DOUBLE")
                _try("""UPDATE cpl_enriched SET mi_volume = bmv.volume_9l
                        FROM brand_mi_volume bmv
                        WHERE brand IS NOT NULL AND brand <> ''
                          AND bmv.brand_norm = regexp_replace(UPPER(brand), '[^A-Z0-9]', '', 'g')""")

                # Canonical LLM geo/varietal enrichment, denormalised onto the row
                # for the same reason as enr_* above (search/facets read plain
                # columns, no per-row subquery). These are the canonical taxonomy
                # values (geo_country/region/subregion/varietal/...) the Products
                # origin & grape facets filter on. See backend/taxonomy.py.
                for _c in ("geo_country", "geo_region", "geo_subregion",
                           "geo_appellation", "geo_varietal", "geo_color",
                           "geo_style", "geo_classification"):
                    _try(f"ALTER TABLE cpl_enriched ADD COLUMN {_c} VARCHAR")
                _try("""UPDATE cpl_enriched SET
                          geo_country = pe.geo_country, geo_region = pe.geo_region,
                          geo_subregion = pe.geo_subregion, geo_appellation = pe.geo_appellation,
                          geo_varietal = pe.geo_varietal, geo_color = pe.geo_color,
                          geo_style = pe.geo_style, geo_classification = pe.geo_classification
                        FROM product_enrichment pe
                        WHERE pe.upc = cpl_enriched.upc_norm""")

                # Distributor item numbers, made EDITION-INDEPENDENT. Fedway's
                # authoritative number lives on the CPL row (dist_item_no), but that
                # column is only populated for the editions that were enriched, so a
                # non-enriched edition would show no number; and the prior fedway
                # sku_mapping rows were keyed on enrichment UPCs that don't always
                # match the priced UPC (e.g. YAMAZAKI 12YR on a barcode it shares with
                # Allied). Fold the LATEST dist_item_no per (distributor, UPC) into
                # sku_mapping — the enrichment table attach_sku_mapping reads on every
                # page — so the number resolves by UPC for ANY edition.
                _try("DELETE FROM sku_mapping WHERE distributor = 'fedway'")
                _try("""
                    INSERT INTO sku_mapping (distributor, abg_sku, upc, upc_norm, brand_reg, item_name)
                    SELECT 'fedway', dist_item_no, upc, upc_norm, NULL, product_name FROM (
                        SELECT upc, upc_norm, dist_item_no, product_name,
                               ROW_NUMBER() OVER (PARTITION BY upc_norm ORDER BY edition DESC) AS rn
                        FROM cpl_enriched
                        WHERE wholesaler = 'fedway'
                          AND dist_item_no IS NOT NULL AND dist_item_no <> ''
                    ) WHERE rn = 1
                """)

                # rip_cluster_sizes_pre: precompute the "Case Mix RIP" cluster size
                # per (wholesaler, edition, rip_code) — the single ~7s hash-join the
                # grouped grid (group_by_rip) rebuilt on every request
                # (routers/catalog.py rip_cluster_sizes CTE). Cluster size = distinct
                # catalog SKUs (upc, vintage, size, pack) the RIP sheet lists under a
                # code, excluding a same-UPC sibling that carries NO valid code when a
                # same-UPC+same-vintage sibling DOES. The body is byte-identical to
                # that CTE (rip + cpl_enriched both live in the cache). KEYED ON
                # EDITION: RIP codes are recycled per edition, so a size keyed on code
                # alone would merge May's Parrot Bay with June's Sarti Rosa. The grid
                # reads this table when present (else recomputes inline).
                _try("""
                    CREATE TABLE rip_cluster_sizes_pre AS
                    SELECT cls.wholesaler AS rcs_wholesaler,
                           cls.edition    AS rcs_edition,
                           cls.rip_code   AS rcs_code,
                           COUNT(DISTINCT (
                               LTRIM(CAST(c.upc AS VARCHAR), '0'),
                               COALESCE(CAST(c.vintage AS VARCHAR), ''),
                               COALESCE(c.unit_volume, ''),
                               COALESCE(CAST(c.unit_qty AS VARCHAR), '')
                           )) AS cluster_members
                    FROM (
                        SELECT DISTINCT wholesaler, edition,
                               CAST(rip_code AS VARCHAR) AS rip_code,
                               LTRIM(CAST(upc AS VARCHAR), '0') AS upc_n
                        FROM rip
                        WHERE upc IS NOT NULL
                          AND CAST(upc AS VARCHAR) NOT IN ('', '0', 'None', 'nan')
                          AND rip_code IS NOT NULL
                          AND CAST(rip_code AS VARCHAR) NOT IN ('', '0', 'None', 'nan')
                    ) cls
                    JOIN cpl_enriched c
                      ON c.wholesaler = cls.wholesaler
                     AND c.edition    = cls.edition
                     AND LTRIM(CAST(c.upc AS VARCHAR), '0') = cls.upc_n
                    WHERE (c.rip_code IS NOT NULL AND CAST(c.rip_code AS VARCHAR) NOT IN ('', '0', 'None', 'nan'))
                       OR NOT EXISTS (
                           SELECT 1 FROM cpl_enriched c2
                           WHERE c2.wholesaler = c.wholesaler AND c2.edition = c.edition
                             AND LTRIM(CAST(c2.upc AS VARCHAR), '0') = LTRIM(CAST(c.upc AS VARCHAR), '0')
                             AND COALESCE(CAST(c2.vintage AS VARCHAR), '') = COALESCE(CAST(c.vintage AS VARCHAR), '')
                             AND c2.rip_code IS NOT NULL
                             AND CAST(c2.rip_code AS VARCHAR) NOT IN ('', '0', 'None', 'nan'))
                    GROUP BY cls.wholesaler, cls.edition, cls.rip_code
                """)

                # (index name, table, columns) — see PRICING_INDEX_INVENTORY.md
                _INDEXES = [
                    # cpl_enriched: the main catalogue, hottest table
                    ("idx_cpl_upc_norm",    "cpl_enriched",      "upc_norm"),
                    ("idx_cpl_ws_ed",       "cpl_enriched",      "wholesaler, edition"),
                    ("idx_cpl_rip_code",    "cpl_enriched",      "rip_code"),
                    ("idx_cpl_combo_code",  "cpl_enriched",      "combo_code"),
                    # cpl: the RAW price list (partial-QD windows, RIP-trap detection)
                    ("idx_cplraw_upc_norm", "cpl",               "upc_norm"),
                    ("idx_cplraw_ws_ed",    "cpl",               "wholesaler, edition"),
                    # rip: the RIP-tier / case-mix source
                    ("idx_rip_upc_norm",    "rip",               "upc_norm"),
                    ("idx_rip_ws_ed",       "rip",               "wholesaler, edition"),
                    ("idx_rip_ws_ed_code",  "rip",               "wholesaler, edition, rip_code"),
                    ("idx_rip_code",        "rip",               "rip_code"),
                    # combo: bundle/pack-out sheets
                    ("idx_combo_upc_norm",  "combo",             "upc_norm"),
                    ("idx_combo_ws_ed",     "combo",             "wholesaler, edition"),
                    ("idx_combo_code",      "combo",             "combo_code"),
                    # celr family registry
                    ("idx_celr_upc_norm",   "celr_products",     "upc_norm"),
                    ("idx_celr_cpn",        "celr_products",     "cpn"),
                    ("idx_celr_keys_key",   "celr_family_keys",  "key"),
                    # batched per-page attach lookups
                    ("idx_pe_upc",          "product_enrichment", "upc"),
                    ("idx_sku_dist_upcn",   "sku_mapping",       "distributor, upc_norm"),
                    # half-case credit per tier
                    ("idx_credits",         "rip_credits",       "rip_code, wholesaler, edition, upc"),
                    # precomputed Case-Mix cluster size (grouped grid)
                    ("idx_rcs_pre",         "rip_cluster_sizes_pre", "rcs_wholesaler, rcs_edition, rcs_code"),
                    # AI deal blurb attach (per product per edition). NOTE only
                    # ai_deal_blurbs is materialised into the cache; the product- and
                    # mover-blurb lookups run against Postgres directly (get_pg), so
                    # their indexes belong on the PG table, not here.
                    ("idx_ai_deal",         "ai_deal_blurbs",    "wholesaler, edition, upc"),
                ]
                for _name, _tbl, _cols in _INDEXES:
                    _try(f"CREATE INDEX {_name} ON {_tbl} ({_cols})")

                # sku_offer: the precomputed cross-distributor offer grid (smart cart
                # + Compare + Price 360). Built LAST, after cpl_enriched is finalised
                # (price_trend rebuild + upc_norm + enr_name) because it CALLS the
                # canonical compare._common_rows, which reads those columns. Best-
                # effort — a failure here must never break the pricing cache.
                try:
                    from backend.precompute_offers import build_sku_offer
                    build_sku_offer(con)
                except Exception as _exc:
                    print(f"[pricing_cache] sku_offer build skipped: {_exc}")
            finally:
                con.close()
            # Atomic publish: rename the finished temp into its versioned name,
            # then point every worker at it.
            os.replace(tmp_path, new_path)
            _write_pointer(new_path)
            _current_path = new_path
            _cleanup_old(keep=new_path)
            return new_path
        finally:
            if _lock_fd is not None:
                _release_build_lock(_lock_fd)


def get_pricing_path() -> Path:
    """Path to the current cache file, building it on first use.

    Reads the shared pointer (throttled) so a reload in ANY worker propagates
    to this one within a few seconds — it switches to the freshly published
    file, and db._get_pool() rebuilds its connections on the path change. Also
    recovers when a sibling rebuilt and swept the file this worker held."""
    global _current_path, _last_pointer_check
    now = time.time()
    if _current_path is not None and _current_path.exists():
        # Cheap fast path: only re-stat the pointer occasionally.
        if now - _last_pointer_check < _POINTER_CHECK_INTERVAL:
            return _current_path
        _last_pointer_check = now
        target = _read_pointer()
        if target is not None and target != _current_path:
            _current_path = target  # a reload published a new file
        if _current_path.exists():
            return _current_path
    # No usable current file: adopt the published pointer, then the newest
    # sibling file on disk, otherwise build (coordinated).
    _last_pointer_check = now
    target = _read_pointer()
    if target is not None:
        _current_path = target
        return _current_path
    candidates = sorted(
        CACHE_DIR.glob("pricing_*.duckdb"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    if candidates:
        _current_path = candidates[0]
        try:
            _write_pointer(_current_path)  # let siblings converge on it
        except OSError:
            pass
        return _current_path
    build_pricing_cache()
    return _current_path
