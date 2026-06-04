"""Postgres access: staging loader + pluggable crosswalk writers.

Local staging (stg_*) and the UPC master live in the local app DB. The final
dim_distributor_upc_crosswalk is written both locally and to Render. Writers are
behind a small interface so a future target (BigQuery, etc.) drops in without
touching parse/match code.
"""
import json
import psycopg
from datetime import datetime, timezone

from . import config

STG_ITEMS = "stg_distributor_items"
STG_DEALS = "stg_distributor_deals"
STG_COMBOS = "stg_distributor_combos"
CROSSWALK = "dim_distributor_upc_crosswalk"


def _conn(url):
    return psycopg.connect(url)


def create_staging(con):
    con.execute(f"""
        CREATE TABLE IF NOT EXISTS {STG_ITEMS} (
            id serial PRIMARY KEY,
            distributor_code text, source_file text, price_book_month text,
            extracted_at timestamptz,
            item_number_raw text, item_number_norm text,
            category text, type text, country text, brand text,
            product_name text, product_notes text, program_flags text,
            size_raw text, size_ml integer, pack_qty integer,
            proof double precision, vintage text,
            front_line_case_price double precision, bottle_price double precision,
            best_rip_bottle_price double precision,
            unit_price double precision, unit_of_measure text,
            rip_id text, is_changed boolean, source_section text,
            page integer, raw_attributes jsonb
        )""")
    con.execute(f"""
        CREATE TABLE IF NOT EXISTS {STG_DEALS} (
            id serial PRIMARY KEY,
            distributor_code text, item_number_norm text,
            tier_qty integer, tier_unit text, discount_amount double precision,
            effective_month integer, source_section text,
            start_date text, end_date text,
            case_price double precision, bottle_price double precision,
            brand_label text
        )""")
    con.execute(f"""
        CREATE TABLE IF NOT EXISTS {STG_COMBOS} (
            id serial PRIMARY KEY,
            distributor_code text, item_number_norm text, title text,
            contents_raw text, savings_amount double precision,
            case_price double precision, source_section text, page integer
        )""")


def truncate_staging(con, distributor_code):
    for t in (STG_ITEMS, STG_DEALS, STG_COMBOS):
        con.execute(f"DELETE FROM {t} WHERE distributor_code = %s", (distributor_code,))


def load_staging(url, dist, extracted):
    """Truncate-and-reload the three staging tables for this distributor."""
    now = datetime.now(timezone.utc)
    with _conn(url) as con:
        create_staging(con)
        truncate_staging(con, dist)
        with con.cursor() as cur:
            cur.executemany(
                f"""INSERT INTO {STG_ITEMS} (distributor_code, source_file, price_book_month,
                    extracted_at, item_number_raw, item_number_norm, category, type, country,
                    brand, product_name, product_notes, program_flags, size_raw, size_ml,
                    pack_qty, proof, vintage, front_line_case_price, bottle_price,
                    best_rip_bottle_price, unit_price, unit_of_measure, rip_id, is_changed,
                    source_section, page, raw_attributes)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                [(dist, config.SOURCE_FILE, config.PRICE_BOOK_MONTH, now,
                  i["item_number_raw"], i["item_number_norm"], i.get("category"), i.get("type"),
                  i.get("country"), i.get("brand"), i.get("product_name"), i.get("product_notes"),
                  i.get("program_flags"), i.get("size_raw"), i.get("size_ml"), i.get("pack_qty"),
                  i.get("proof"), i.get("vintage"), i.get("front_line_case_price"),
                  i.get("bottle_price"), i.get("best_rip_bottle_price"), i.get("unit_price"),
                  i.get("unit_of_measure"), i.get("rip_id"), i.get("is_changed"),
                  i.get("section"), i.get("page"), json.dumps(i.get("raw_attributes") or {}))
                 for i in extracted["items"]],
            )
            cur.executemany(
                f"""INSERT INTO {STG_DEALS} (distributor_code, item_number_norm, tier_qty,
                    tier_unit, discount_amount, effective_month, source_section, start_date,
                    end_date, case_price, bottle_price, brand_label)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                [(dist, d.get("item_number_norm"), d.get("tier_qty"), d.get("tier_unit"),
                  d.get("discount_amount"), d.get("effective_month"), d.get("source_section"),
                  d.get("start_date"), d.get("end_date"), d.get("case_price"),
                  d.get("bottle_price"), d.get("brand_label"))
                 for d in extracted["deals"]],
            )
            cur.executemany(
                f"""INSERT INTO {STG_COMBOS} (distributor_code, item_number_norm, title,
                    contents_raw, savings_amount, case_price, source_section, page)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
                [(dist, c.get("item_number_norm"), c.get("title"), c.get("contents_raw"),
                  c.get("savings_amount"), c.get("case_price"), c.get("section"), c.get("page"))
                 for c in extracted["combos"]],
            )
        con.commit()
    return len(extracted["items"]), len(extracted["deals"]), len(extracted["combos"])


def find_upc_master(url):
    """Locate the UPC master. Prefer cpl_enriched (it maps cleanly to upc /
    product_name / brand / size / pack / category / cost). Return rows with a
    REAL upc (Fedway's own rows use stub '0', so the usable UPCs come from the
    products carried across distributors). One row per (upc, size_ml)."""
    with _conn(url) as con:
        has = con.execute(
            "SELECT 1 FROM information_schema.tables WHERE table_name='cpl_enriched'"
        ).fetchone()
        if not has:
            raise RuntimeError("cpl_enriched not found; cannot locate UPC master")
        rows = con.execute("""
            WITH latest AS (
              SELECT wholesaler, MAX(edition) AS ed FROM cpl_enriched GROUP BY wholesaler
            )
            SELECT DISTINCT ON (c.upc, c.unit_volume)
                   c.upc, c.product_name, c.brand, c.unit_volume, c.unit_qty,
                   c.product_type, c.frontline_unit_price, c.frontline_case_price, c.wholesaler
            FROM cpl_enriched c JOIN latest l
              ON c.wholesaler=l.wholesaler AND c.edition=l.ed
            WHERE c.upc IS NOT NULL AND c.upc <> '0' AND c.upc <> ''
            ORDER BY c.upc, c.unit_volume, c.frontline_unit_price
        """).fetchall()
    return rows


class CrosswalkWriter:
    DDL = f"""
        CREATE TABLE IF NOT EXISTS {CROSSWALK} (
            distributor_code text NOT NULL,
            item_number_norm text NOT NULL,
            upc text, upc_product_name text,
            brand text, product_name text, size_ml integer, pack_qty integer,
            proof double precision, vintage text,
            front_line_case_price double precision, bottle_price double precision,
            best_rip_bottle_price double precision, rip_id text, program_flags text,
            price_book_month text,
            live_frontline_case_price double precision,
            category text, product_type text, country text,
            match_method text, match_confidence text, match_score double precision,
            price_delta double precision, price_flag boolean, updated_at timestamptz,
            PRIMARY KEY (distributor_code, item_number_norm)
        )"""
    # columns added after the first deploy; backfill on an existing table so the
    # upsert below always has them.
    ALTERS = tuple(
        f"ALTER TABLE {CROSSWALK} ADD COLUMN IF NOT EXISTS {c}"
        for c in ("live_frontline_case_price double precision",
                  "category text", "product_type text", "country text",
                  "price_flag boolean")
    )

    UPSERT = f"""
        INSERT INTO {CROSSWALK} (distributor_code, item_number_norm, upc, upc_product_name,
            brand, product_name, size_ml, pack_qty, proof, vintage, front_line_case_price,
            bottle_price, best_rip_bottle_price, rip_id, program_flags, price_book_month,
            live_frontline_case_price, category, product_type, country,
            match_method, match_confidence, match_score,
            price_delta, price_flag, updated_at)
        VALUES (%(distributor_code)s,%(item_number_norm)s,%(upc)s,%(upc_product_name)s,
            %(brand)s,%(product_name)s,%(size_ml)s,%(pack_qty)s,%(proof)s,%(vintage)s,
            %(front_line_case_price)s,%(bottle_price)s,%(best_rip_bottle_price)s,%(rip_id)s,
            %(program_flags)s,%(price_book_month)s,%(live_frontline_case_price)s,
            %(category)s,%(product_type)s,%(country)s,
            %(match_method)s,%(match_confidence)s,%(match_score)s,%(price_delta)s,
            %(price_flag)s,%(updated_at)s)
        ON CONFLICT (distributor_code, item_number_norm) DO UPDATE SET
            upc=EXCLUDED.upc, upc_product_name=EXCLUDED.upc_product_name, brand=EXCLUDED.brand,
            product_name=EXCLUDED.product_name, size_ml=EXCLUDED.size_ml, pack_qty=EXCLUDED.pack_qty,
            proof=EXCLUDED.proof, vintage=EXCLUDED.vintage,
            front_line_case_price=EXCLUDED.front_line_case_price, bottle_price=EXCLUDED.bottle_price,
            best_rip_bottle_price=EXCLUDED.best_rip_bottle_price, rip_id=EXCLUDED.rip_id,
            program_flags=EXCLUDED.program_flags, price_book_month=EXCLUDED.price_book_month,
            live_frontline_case_price=EXCLUDED.live_frontline_case_price,
            category=EXCLUDED.category, product_type=EXCLUDED.product_type, country=EXCLUDED.country,
            match_method=EXCLUDED.match_method, match_confidence=EXCLUDED.match_confidence,
            match_score=EXCLUDED.match_score, price_delta=EXCLUDED.price_delta,
            price_flag=EXCLUDED.price_flag, updated_at=EXCLUDED.updated_at"""

    def __init__(self, url, label):
        self.url = url
        self.label = label

    def write(self, rows):
        if not self.url:
            return 0
        now = datetime.now(timezone.utc)
        for r in rows:
            r["updated_at"] = now
            for k in ("live_frontline_case_price", "category", "product_type", "country"):
                r.setdefault(k, None)
            r.setdefault("price_flag", False)
        with _conn(self.url) as con:
            con.execute(self.DDL)
            for stmt in self.ALTERS:
                con.execute(stmt)
            with con.cursor() as cur:
                cur.executemany(self.UPSERT, rows)
            con.commit()
            n = con.execute(f"SELECT count(*) FROM {CROSSWALK} WHERE distributor_code=%s",
                            (config.DISTRIBUTOR_CODE,)).fetchone()[0]
        return n


def LocalPostgresWriter():
    return CrosswalkWriter(config.local_db_url(), "local")


def RenderPostgresWriter():
    return CrosswalkWriter(config.render_db_url(), "render")
