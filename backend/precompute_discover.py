"""Precomputed Discover "Deals" grid — one durable row per FULLY-MERGED deal card,
per edition, in Postgres.

The Discover page is heavy: per rail it runs a cold include_tiers search over
~300 rows, then merges the same product across distributors, collapses case-mix
flavour variants, and derives the three per-bottle prices + best-RIP/QD chips.
That whole pipeline is a pure function of one edition's pricing data, so we run it
ONCE per (edition, category) at build time and materialise `discover_deal`; the
page then reads ready-to-render cards with plain WHERE/ORDER BY + indexes.

Design (per the product decision):
  * Grain: ONE row per merged card = (edition, product_key, unit_volume, pack,
    vintage). Distributors sharing the same product + same RIP/QD are folded into
    one row (distributor list on the row).
  * Durable Postgres table with a primary key, a natural unique key, and indexes
    on the columns the page filters/sorts by (edition, spirit_category, size,
    deal flags, discount, mi_volume).
  * ALL loaded editions are materialised (edition is in the natural key; RIP codes
    recycle per edition, so consumers MUST filter to the row's edition).

No pricing math is re-implemented: the per-SKU numbers come from the canonical
`search_products` (frontline_/best_unit_price, effective_case_price, tier ladders).
This module only ports the Discover-specific MERGE / COLLAPSE / display derivation
that used to live in the frontend, so the table and the page agree by construction.

Any new field the Discover card shows in future MUST be added to _CARD_COLS + the
DDL + _card_from_group here, so the table stays the single source for the page.
"""

import json
import os
import re
import time

# ---- ported Discover derivation (kept identical to frontend Discover.tsx) --------

def _num(v):
    try:
        f = float(v)
        return None if f != f else f
    except (TypeError, ValueError):
        return None


def _real_upc(u):
    s = re.sub(r"\D", "", str(u or "")).lstrip("0")
    return s if len(s) >= 11 and not re.fullmatch(r"(\d)\1+", s) else None


def _product_key(p):
    ru = _real_upc(p.get("upc"))
    return f"U:{ru}" if ru else f"N:{(p.get('product_name') or '').upper()}"


def _pack(p):
    try:
        return int(float(p.get("unit_qty")))
    except (TypeError, ValueError):
        return None


def _top_tier(tiers, source):
    cand = [t for t in (tiers or []) if t.get("source") == source]
    if not cand:
        return None
    if source == "rip":
        return max(cand, key=lambda t: _num(t.get("amount")) or 0)
    return max(cand, key=lambda t: _num(t.get("save_per_case")) or 0)


def _deal_sig(p):
    rip = _top_tier(p.get("tiers"), "rip")
    qd = _top_tier(p.get("tiers"), "discount")
    return "|".join(str(x) for x in (
        rip.get("amount") if rip else "-", rip.get("qty") if rip else "-",
        qd.get("save_per_case") if qd else "-", qd.get("qty") if qd else "-",
    ))


def _one_cs_case(p):
    """1-case price the card shows: 1-case non-TS entry QD, else frontline."""
    for t in (p.get("tiers") or []):
        if (t.get("source") == "discount" and t.get("qty") == 1
                and not t.get("is_time_sensitive") and t.get("price_after") is not None):
            return _num(t.get("price_after"))
    return _num(p.get("frontline_case_price"))


def _distributor_name(w):
    return (w or "").strip()


# Columns written to discover_deal, in insert order.
_CARD_COLS = [
    "edition", "product_key", "upc", "upc_norm", "product_name", "display_name",
    "brand", "spirit_category", "product_type",
    "unit_volume", "unit_qty", "pack", "vintage",
    "primary_wholesaler", "wholesalers", "n_distributors",
    "dist_item_no", "dist_item_name",
    "mi_volume", "image_url",
    "frontline_case_price", "one_cs_case_price", "effective_case_price",
    "btl_price_1cs", "btl_price_best_qd", "btl_price_best_qd_rip",
    "best_rip_qty", "best_rip_amount", "best_rip_per_case", "best_rip_code",
    "best_rip_is_ts", "best_rip_from", "best_rip_to",
    "best_qd_qty", "best_qd_save_per_case", "best_qd_total",
    "has_rip", "has_qd", "has_both", "is_time_sensitive",
    "net_discount", "discount_pct", "rip_code",
]


def _card_from_group(rep: dict, dists: list[str]) -> dict:
    """Build one merged-card row dict from the representative SKU (highest mi_volume
    of its (product_key, deal) group) plus the distributor list."""
    tiers = rep.get("tiers") or []
    rip = _top_tier(tiers, "rip")
    qd = _top_tier(tiers, "discount")
    pack = _pack(rep)
    x1 = _num(rep.get("frontline_unit_price"))
    x2 = _num(rep.get("best_unit_price"))
    rip_per_case = (_num(rip.get("amount")) / rip.get("qty")) if (rip and rip.get("qty")) else 0.0
    x3 = (max(0.0, x2 - (rip_per_case / pack)) if (x2 is not None and pack) else None)
    one_cs = _one_cs_case(rep)
    eff = _num(rep.get("effective_case_price"))
    net = (max(0.0, one_cs - eff) if (one_cs is not None and eff is not None) else None)
    qd_total = ((qd.get("qty") or 0) * (_num(qd.get("save_per_case")) or 0)) if qd else None
    is_ts = any(t.get("is_time_sensitive") for t in tiers)
    return {
        "edition": rep.get("edition"),
        "product_key": _product_key(rep),
        "upc": rep.get("upc"),
        "upc_norm": re.sub(r"\D", "", str(rep.get("upc") or "")).lstrip("0") or None,
        "product_name": rep.get("product_name"),
        "display_name": (rep.get("abg_item_name") or "").strip() or None,
        "brand": rep.get("brand"),
        "spirit_category": rep.get("spirit_category"),
        "product_type": rep.get("product_type"),
        "unit_volume": rep.get("unit_volume"),
        "unit_qty": rep.get("unit_qty"),
        "pack": pack,
        "vintage": rep.get("vintage"),
        "primary_wholesaler": dists[0] if dists else rep.get("wholesaler"),
        "wholesalers": ",".join(dists),
        "n_distributors": len(dists),
        "dist_item_no": rep.get("dist_item_no") or rep.get("abg_sku"),
        "dist_item_name": rep.get("dist_item_name"),
        "mi_volume": _num(rep.get("mi_volume")),
        "image_url": rep.get("image_url"),
        "frontline_case_price": _num(rep.get("frontline_case_price")),
        "one_cs_case_price": one_cs,
        "effective_case_price": eff,
        "btl_price_1cs": x1,
        "btl_price_best_qd": x2,
        "btl_price_best_qd_rip": x3,
        "best_rip_qty": rip.get("qty") if rip else None,
        "best_rip_amount": _num(rip.get("amount")) if rip else None,
        "best_rip_per_case": rip_per_case if rip else None,
        "best_rip_code": (rip.get("code") if rip else None),
        "best_rip_is_ts": bool(rip.get("is_time_sensitive")) if rip else None,
        "best_rip_from": (rip.get("from_date") if rip else None),
        "best_rip_to": (rip.get("to_date") if rip else None),
        "best_qd_qty": qd.get("qty") if qd else None,
        "best_qd_save_per_case": _num(qd.get("save_per_case")) if qd else None,
        "best_qd_total": qd_total,
        "has_rip": rip is not None,
        "has_qd": qd is not None,
        "has_both": rip is not None and qd is not None,
        "is_time_sensitive": is_ts,
        "net_discount": net,
        "discount_pct": (net / one_cs) if (net is not None and one_cs) else None,
        "rip_code": rep.get("rip_code"),
    }


def _cards_for_items(items: list[dict]) -> list[dict]:
    """Port of the frontend dealProducts(): keep deal-bearing SKUs, merge same
    product+deal across distributors, collapse case-mix flavour variants to the
    top-mi primary. Input rows are mi_volume-desc; output preserves that order."""
    # 1) merge by (product_key, deal signature) — first (highest mi) wins, collect distributors
    groups: dict[str, dict] = {}
    for it in items:
        if not it.get("image_url"):
            continue
        tiers = it.get("tiers") or []
        if not (_top_tier(tiers, "rip") or _top_tier(tiers, "discount")):
            continue  # a price below list with no RIP/QD is NOT a deal
        key = f"{_product_key(it)}||{_deal_sig(it)}"
        g = groups.get(key)
        w = _distributor_name(it.get("wholesaler"))
        if not g:
            groups[key] = {"rep": it, "dists": [w]}
        elif w not in groups[key]["dists"]:
            groups[key]["dists"].append(w)
    merged = list(groups.values())
    # 2) collapse case-mix flavour variants: one primary per (rip_code, brand)
    seen: set[str] = set()
    out: list[dict] = []
    for g in merged:
        rep = g["rep"]
        code = (rep.get("rip_code") or "").strip()
        brand = (rep.get("brand") or "").strip().upper()
        if code and brand:
            ck = f"{code}|{brand}"
            if ck in seen:
                continue
            seen.add(ck)
        out.append(_card_from_group(rep, g["dists"]))
    return out


# ---- Postgres schema -----------------------------------------------------------

_DDL = """
CREATE TABLE IF NOT EXISTS discover_deal (
    id                     BIGSERIAL PRIMARY KEY,
    edition                VARCHAR NOT NULL,
    product_key            VARCHAR NOT NULL,
    upc                    VARCHAR,
    upc_norm               VARCHAR,
    product_name           VARCHAR NOT NULL,
    display_name           VARCHAR,
    brand                  VARCHAR,
    spirit_category        VARCHAR,
    product_type           VARCHAR,
    unit_volume            VARCHAR,
    unit_qty               VARCHAR,
    pack                   INTEGER,
    vintage                VARCHAR,
    primary_wholesaler     VARCHAR,
    wholesalers            VARCHAR,
    n_distributors         INTEGER,
    dist_item_no           VARCHAR,
    dist_item_name         VARCHAR,
    mi_volume              DOUBLE PRECISION,
    image_url              VARCHAR,
    frontline_case_price   DOUBLE PRECISION,
    one_cs_case_price      DOUBLE PRECISION,
    effective_case_price   DOUBLE PRECISION,
    btl_price_1cs          DOUBLE PRECISION,
    btl_price_best_qd      DOUBLE PRECISION,
    btl_price_best_qd_rip  DOUBLE PRECISION,
    best_rip_qty           INTEGER,
    best_rip_amount        DOUBLE PRECISION,
    best_rip_per_case      DOUBLE PRECISION,
    best_rip_code          VARCHAR,
    best_rip_is_ts         BOOLEAN,
    best_rip_from          VARCHAR,
    best_rip_to            VARCHAR,
    best_qd_qty            INTEGER,
    best_qd_save_per_case  DOUBLE PRECISION,
    best_qd_total          DOUBLE PRECISION,
    has_rip                BOOLEAN,
    has_qd                 BOOLEAN,
    has_both               BOOLEAN,
    is_time_sensitive      BOOLEAN,
    net_discount           DOUBLE PRECISION,
    discount_pct           DOUBLE PRECISION,
    rip_code               VARCHAR,
    built_at               TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT discover_deal_natural_key
        UNIQUE (edition, product_key, unit_volume, pack, vintage)
);
CREATE INDEX IF NOT EXISTS ix_dd_ed_cat_disc  ON discover_deal (edition, spirit_category, discount_pct DESC);
CREATE INDEX IF NOT EXISTS ix_dd_ed_cat_size  ON discover_deal (edition, spirit_category, unit_volume);
CREATE INDEX IF NOT EXISTS ix_dd_ed_deal      ON discover_deal (edition, has_rip, has_qd, has_both);
CREATE INDEX IF NOT EXISTS ix_dd_ed_mi        ON discover_deal (edition, mi_volume DESC);
CREATE INDEX IF NOT EXISTS ix_dd_ed_upc       ON discover_deal (edition, upc_norm);
"""


def ensure_schema(pg) -> None:
    with pg.cursor() as cur:
        cur.execute(_DDL)
    pg.commit()


def build_discover_deals(pg, *, editions=None, log=print) -> int:
    """(Re)build discover_deal for the given editions (default: ALL editions in the
    pricing cache). Reuses the canonical search_products for tiers + prices, then
    ports the Discover merge/collapse. Returns the number of rows written."""
    if os.getenv("BUILD_DISCOVER_DEALS", "1") != "1":
        log("[discover_deal] skipped (BUILD_DISCOVER_DEALS disabled)")
        return 0
    from backend.routers.catalog import search_products  # canonical pricing/tiers
    from backend.pricing_cache import get_duckdb, read_parquet

    ensure_schema(pg)

    # category rails (spirit + wine) from the same manifest the page uses
    cats_path = os.path.join(os.path.dirname(__file__), "reference", "mi_top_categories.json")
    with open(cats_path, encoding="utf-8") as f:
        cats = json.load(f)
    rails = (cats.get("spirits") or []) + (cats.get("wine") or [])

    with get_duckdb() as con:
        src = read_parquet(con, "cpl_enriched")
        if editions is None:
            editions = [r[0] for r in con.execute(
                f"SELECT DISTINCT edition FROM {src} WHERE edition IS NOT NULL ORDER BY edition"
            ).fetchall()]

    t0 = time.time()
    total = 0
    for ed in editions:
        cards: list[dict] = []
        for rail in rails:
            pr = rail.get("params") or {}
            try:
                res = search_products(
                    q=pr.get("q") or "", wholesaler=None, edition=ed,
                    product_type=pr.get("product_type"),
                    min_price=None, max_price=None, has_discount=None, has_closeout=None,
                    has_rip=None, in_combo=None, time_sensitive=None, price_drop=None,
                    price_increase=None, brand=None, unit_volume=None, divisions=None,
                    categories=None, brands=None, sizes="375ML,750ML,1L,1.75L",
                    unit_kinds=None, countries=None, regions=None,
                    grapes=pr.get("grapes"), spirit_category=pr.get("spirit_category"),
                    upcs=None, rip_code=None, region=None, varietal=None,
                    tracked_only=False, introduced_within_months=None, introduced_edition=None,
                    sort="mi_volume", order="desc", limit=2000, offset=0,
                    include_tiers=True, group_by_rip=False, images_first=False,
                    as_of=None, user=None,
                )
                cards.extend(_cards_for_items(res.get("items") or []))
            except Exception as e:  # noqa: BLE001
                log(f"[discover_deal] {ed} / {rail.get('label')} failed: {e}")
        # de-dup on the natural key within the edition (a product can appear under
        # more than one rail via q-overlap); keep the first (highest mi) seen.
        uniq: dict[tuple, dict] = {}
        for c in cards:
            k = (c["edition"], c["product_key"], c["unit_volume"], c["pack"], c["vintage"])
            uniq.setdefault(k, c)
        rows = list(uniq.values())
        _write_edition(pg, ed, rows)
        total += len(rows)
        log(f"[discover_deal] {ed}: {len(rows)} cards ({round(time.time()-t0)}s elapsed)")
    return total


def _write_edition(pg, edition: str, rows: list[dict]) -> None:
    """Replace one edition's rows atomically (DELETE + INSERT in a txn)."""
    cols = _CARD_COLS
    placeholders = ",".join(["%s"] * len(cols))
    with pg.cursor() as cur:
        cur.execute("DELETE FROM discover_deal WHERE edition = %s", (edition,))
        if rows:
            cur.executemany(
                f"INSERT INTO discover_deal ({','.join(cols)}) VALUES ({placeholders})",
                [[r.get(c) for c in cols] for r in rows],
            )
    pg.commit()
