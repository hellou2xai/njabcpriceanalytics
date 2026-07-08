"""`deal_grid` — the precomputed "bible" for the Discover Deals page.

One row per MERGED deal card, per edition, built ENTIRELY at cache-build time from
the PROVEN engineering so the page reads it with a plain indexed query (no live
pricing engine on the request path -> millisecond response):

  * `sku_offer` (precompute_offers.py, via compare._common_rows) gives the merged
    card: the cheapest-net offer per cross-distributor identity (is_cheapest_net),
    the distributor count, and the frontline/after-QD/effective case prices.
  * `pricing.attach_tiers` gives that SKU's QD + RIP tier ladders (the SAME tiers
    /search renders), from which we take the best-RIP (qty/amount/dates/TS) and
    best-QD (qty/save) the chips show.
  * `cpl_enriched` columns supply spirit_category, mi_volume, image, the two
    per-bottle prices (frontline_unit_price = X1, best_unit_price = X2), pack,
    vintage, distributor item no/name.

No pricing math is re-implemented here; we only assemble + rank the precomputed
values. Typed columns only (no JSON blob): any new field the Discover card grows
is a new typed column here + in the DDL + in the read endpoint.

Edition is in the natural key of every row (RIP codes recycle per edition), so the
read endpoint MUST filter to one edition.
"""

import os
import time
import traceback

from backend.routers.compare import _common_rows  # noqa: F401  (proven engine dep marker)

# Last build's per-edition diagnostics (surfaced by /api/admin/reload-pricing) so a
# prod build that yields 0 rows can be diagnosed without shell access to the box.
LAST_BUILD: dict = {}

# Columns, in insert order. Typed only.
_COLS = [
    "edition", "group_key", "product_key", "upc", "upc_norm",
    "product_name", "display_name", "brand", "spirit_category", "product_type",
    "unit_volume", "unit_qty", "pack", "vintage",
    "primary_wholesaler", "wholesalers", "n_distributors",
    "dist_item_no", "dist_item_name",
    "mi_volume", "image_url",
    "frontline_case_price", "one_cs_case_price", "effective_case_price",
    "btl_1cs", "btl_best_qd", "btl_best_qd_rip",
    "rip_qty", "rip_amount", "rip_per_case", "rip_code", "rip_is_ts", "rip_from", "rip_to",
    "qd_qty", "qd_save_per_case", "qd_total",
    "has_rip", "has_qd", "has_both", "is_time_sensitive",
    "net_discount", "discount_pct", "case_mix_primary",
]

_BOOL = {"has_rip", "has_qd", "has_both", "is_time_sensitive", "case_mix_primary", "rip_is_ts"}
_INT = {"pack", "n_distributors", "rip_qty", "qd_qty"}
_DBL = {"mi_volume", "frontline_case_price", "one_cs_case_price", "effective_case_price",
        "btl_1cs", "btl_best_qd", "btl_best_qd_rip", "rip_amount", "rip_per_case",
        "qd_save_per_case", "qd_total", "net_discount", "discount_pct"}


def _coltype(c: str) -> str:
    return "BOOLEAN" if c in _BOOL else "INTEGER" if c in _INT else "DOUBLE" if c in _DBL else "VARCHAR"


_DDL = None  # built lazily from _COLS
_INDEXES = [
    "CREATE INDEX IF NOT EXISTS ix_dg_ed_cat_disc ON deal_grid(edition, spirit_category, discount_pct)",
    "CREATE INDEX IF NOT EXISTS ix_dg_ed_cat_size ON deal_grid(edition, spirit_category, unit_volume)",
    "CREATE INDEX IF NOT EXISTS ix_dg_ed_deal     ON deal_grid(edition, has_rip, has_qd, has_both)",
    "CREATE INDEX IF NOT EXISTS ix_dg_ed_mi       ON deal_grid(edition, mi_volume)",
    "CREATE INDEX IF NOT EXISTS ix_dg_ed_upc      ON deal_grid(edition, upc_norm)",
    "CREATE INDEX IF NOT EXISTS ix_dg_ed_prim     ON deal_grid(edition, case_mix_primary)",
]


def _num(v):
    try:
        f = float(v)
        return None if f != f else f
    except (TypeError, ValueError):
        return None


def _r2(v):
    """Round a money value to 2 dp, killing float-division tails (66.6733..., 4.9999...)."""
    return round(v, 2) if isinstance(v, (int, float)) and v == v else v


def _s(v):
    """Clean string for a VARCHAR column / string op. Guards the Postgres-vs-parquet
    type drift: the Postgres-backed prod cache hands back rip_code / vintage / item_no
    as FLOATs (10954.0, 2019.0) where the local parquet gives strings. Floats become
    the integer form ('10954'), NaN/None become None."""
    if v is None:
        return None
    if isinstance(v, float):
        if v != v:  # NaN
            return None
        return str(int(v)) if v == int(v) else str(v)
    s = str(v).strip()
    return s or None


def _idkey(w, upc_norm, uv, uq, vint):
    """Full SKU identity: distributor + normalised UPC + size + pack + vintage.
    Must produce the SAME tuple from a sku_offer offer and its cpl_enriched record."""
    try:
        pk = str(int(float(uq))) if uq not in (None, "") else ""
    except (TypeError, ValueError):
        pk = str(uq or "")
    return (str(w or ""), str(upc_norm or ""), str(uv or ""), pk, _s(vint) or "")


def _pick_rec(cands, offer):
    """Among cpl records sharing a SKU identity, pick the one whose frontline case
    price matches the sku_offer offer (the exact row the offer was built from), so
    a distributor's duplicate listing can't hand deal_grid a different price than
    sku_offer/live picked."""
    if not cands:
        return None
    of = _num(offer.get("frontline_case_price"))
    if of is None:
        return cands[0]
    return min(cands, key=lambda r: abs(
        (_num(r.get("frontline_case_price")) if _num(r.get("frontline_case_price")) is not None else 1e12) - of))


def _top(tiers, source):
    cand = [t for t in (tiers or []) if t.get("source") == source]
    if not cand:
        return None
    key = (lambda t: _num(t.get("amount")) or 0) if source == "rip" else (lambda t: _num(t.get("save_per_case")) or 0)
    return max(cand, key=key)


def _one_cs(rec):
    for t in (rec.get("tiers") or []):
        if (t.get("source") == "discount" and t.get("qty") == 1
                and not t.get("is_time_sensitive") and t.get("price_after") is not None):
            return _num(t.get("price_after"))
    return _num(rec.get("frontline_case_price"))


def build_deal_grid(con, *, log=print) -> int:
    """(Re)build `deal_grid` on the cache connection, AFTER sku_offer + cpl_enriched
    are finalised. Returns row count. Best-effort caller-wrapped."""
    if os.getenv("BUILD_DEAL_GRID", "1").strip().lower() not in ("1", "true", "yes", "on"):
        log("[deal_grid] skipped (BUILD_DEAL_GRID disabled)")
        return 0
    # sku_offer must exist (it's the source).
    have = con.execute(
        "SELECT 1 FROM information_schema.tables WHERE table_name = 'sku_offer'"
    ).fetchone()
    if not have:
        log("[deal_grid] skipped: sku_offer not built")
        return 0

    from backend.pricing import attach_tiers, read_parquet
    src = read_parquet(con, "cpl_enriched")

    global _DDL
    _DDL = "CREATE TABLE deal_grid (" + ", ".join(f"{c} {_coltype(c)}" for c in _COLS) + ")"
    con.execute("DROP TABLE IF EXISTS deal_grid")
    con.execute(_DDL)

    editions = [r[0] for r in con.execute(
        "SELECT DISTINCT edition FROM sku_offer WHERE edition IS NOT NULL ORDER BY edition"
    ).fetchall()]

    t0 = time.time()
    total = 0
    per_ed: dict = {}
    for ed in editions:
        try:
            n = _build_edition(con, src, ed, attach_tiers, log, per_ed)
            total += n
        except Exception as e:  # one edition failing must not sink the rest
            per_ed[ed] = {"error": f"{type(e).__name__}: {e}", "tb": traceback.format_exc()[-800:]}
            log(f"[deal_grid] edition {ed} failed: {e}")
    for ix in _INDEXES:
        con.execute(ix)
    LAST_BUILD.clear()
    LAST_BUILD.update({"total": total, "editions": per_ed, "secs": round(time.time() - t0)})
    log(f"[deal_grid] built {total} cards across {len(editions)} editions in {round(time.time()-t0)}s")
    return total


def _build_edition(con, src, ed, attach_tiers, log, per_ed=None) -> int:
    diag = {}
    if per_ed is not None:
        per_ed[ed] = diag
    # 1) merged cards for this edition = the cheapest-net offer per identity.
    offers = con.execute(
        "SELECT group_key, wholesaler, upc, upc_norm, product_name, display_name, "
        "       unit_volume, unit_qty, vintage, item_no, product_type, brand, "
        "       frontline_case_price, after_qd_case_price, effective_case_price, n_distributors "
        "FROM sku_offer WHERE edition = ? AND is_cheapest_net", [ed],
    ).fetchdf().to_dict("records")
    diag["offers"] = len(offers)
    if not offers:
        return 0
    # distributor list per merged group (primary first = the cheapest-net one).
    dist_rows = con.execute(
        "SELECT group_key, wholesaler, net_rank FROM sku_offer WHERE edition = ? ORDER BY group_key, net_rank",
        [ed],
    ).fetchall()
    dists: dict[str, list[str]] = {}
    for gk, w, _r in dist_rows:
        dists.setdefault(gk, [])
        if w not in dists[gk]:
            dists[gk].append(w)

    # 2) pull the cpl_enriched record per merged card (the cheapest distributor's
    #    row) with everything attach_tiers + the card need, then attach tiers.
    keys = [(o["wholesaler"], o["upc_norm"]) for o in offers]
    recs = _fetch_cpl(con, src, ed, keys)
    diag["recs"] = len(recs)
    attach_tiers(con, recs)
    # Key the cpl records by the FULL SKU identity (distributor + UPC + size + pack +
    # vintage), NOT UPC alone: a UPC shared across pack/size siblings would otherwise
    # borrow the wrong sibling's price/tiers. Keep a LIST per identity because some
    # distributors (michael_skurnik) list the same SKU twice at different prices; we
    # pick the row whose case price matches the sku_offer offer (below).
    by_key: dict = {}
    for r in recs:
        by_key.setdefault(_idkey(r.get("wholesaler"), r.get("upc_norm"), r.get("unit_volume"),
                                 r.get("unit_qty"), r.get("vintage")), []).append(r)
    diag["matched"] = sum(1 for o in offers if _idkey(
        o["wholesaler"], o["upc_norm"], o.get("unit_volume"), o.get("unit_qty"), o.get("vintage")) in by_key)

    # 3) case-mix primary: top mi_volume per (rip_code, brand) within the edition.
    #    Rank offers by mi_volume desc first so the first seen is the primary.
    def _mi(o):
        r = _pick_rec(by_key.get(_idkey(o["wholesaler"], o["upc_norm"], o.get("unit_volume"),
                                        o.get("unit_qty"), o.get("vintage"))), o)
        return _num(r.get("mi_volume")) if r else None
    offers.sort(key=lambda o: (_mi(o) is None, -(_mi(o) or 0)))
    seen_cm: set = set()

    rows = []
    for o in offers:
        rec = _pick_rec(by_key.get(_idkey(o["wholesaler"], o["upc_norm"], o.get("unit_volume"),
                                          o.get("unit_qty"), o.get("vintage"))), o)
        if not rec:
            continue
        tiers = rec.get("tiers") or []
        rip = _top(tiers, "rip")
        qd = _top(tiers, "discount")
        if not (rip or qd):
            continue  # deal grid holds ONLY real RIP/QD deals
        try:
            pack = int(float(o.get("unit_qty"))) if o.get("unit_qty") else None
        except (TypeError, ValueError):
            pack = None
        x1 = _r2(_num(rec.get("frontline_unit_price")))
        # X2 = per-bottle after best QD. Prefer the raw best_unit_price column;
        # else the best-QD tier's own btl_price_after; else the list bottle (no QD).
        x2 = _num(rec.get("best_unit_price"))
        if x2 is None:
            x2 = _num(qd.get("btl_price_after")) if qd else x1
        x2 = _r2(x2)
        rip_pc = _r2((_num(rip.get("amount")) / rip.get("qty")) if (rip and rip.get("qty")) else 0.0)
        x3 = _r2(max(0.0, x2 - ((rip_pc or 0) / pack)) if (x2 is not None and pack) else None)
        one_cs = _r2(_one_cs(rec))
        eff = _r2(_num(o.get("effective_case_price")))
        net = _r2(max(0.0, one_cs - eff) if (one_cs is not None and eff is not None) else None)
        brand = (_s(o.get("brand")) or "").upper()
        code = _s(rec.get("rip_code")) or ""
        cm_primary = True
        if code and brand:
            ck = f"{code}|{brand}"
            cm_primary = ck not in seen_cm
            seen_cm.add(ck)
        dl = dists.get(o["group_key"], [o["wholesaler"]])
        rows.append([
            ed, _s(o.get("group_key")), _product_key(o), _s(o.get("upc")), _s(o.get("upc_norm")),
            _s(o.get("product_name")), _s(o.get("display_name")), _s(o.get("brand")),
            _s(rec.get("spirit_category")), _s(o.get("product_type")),
            _s(o.get("unit_volume")), _s(o.get("unit_qty")),
            pack, _s(o.get("vintage")),
            _s(dl[0]), ",".join(_s(d) or "" for d in dl), o.get("n_distributors") or len(dl),
            _s(o.get("item_no")), _s(rec.get("dist_item_name")),
            _num(rec.get("mi_volume")), _s(rec.get("image_url")),
            _r2(_num(o.get("frontline_case_price"))), one_cs, eff,
            x1, x2, x3,
            (rip.get("qty") if rip else None), (_r2(_num(rip.get("amount"))) if rip else None),
            (rip_pc if rip else None), (_s(rip.get("code")) if rip else (code or None)),
            (bool(rip.get("is_time_sensitive")) if rip else None),
            (rip.get("from_date") if rip else None), (rip.get("to_date") if rip else None),
            (qd.get("qty") if qd else None), (_r2(_num(qd.get("save_per_case"))) if qd else None),
            (_r2((qd.get("qty") or 0) * (_num(qd.get("save_per_case")) or 0)) if qd else None),
            rip is not None, qd is not None, (rip is not None and qd is not None),
            any(t.get("is_time_sensitive") for t in tiers),
            net, (net / one_cs if (net is not None and one_cs) else None), cm_primary,
        ])
    diag["rows"] = len(rows)
    if rows:
        try:
            con.executemany(
                f"INSERT INTO deal_grid ({','.join(_COLS)}) VALUES ({','.join(['?']*len(_COLS))})", rows
            )
        except Exception as e:
            diag["insert_error"] = f"{type(e).__name__}: {e}"
            diag["insert_sample"] = [str(v)[:40] for v in rows[0]]
            raise
    return len(rows)


def _product_key(o) -> str:
    import re
    s = re.sub(r"\D", "", str(o.get("upc") or "")).lstrip("0")
    real = s if len(s) >= 11 and not re.fullmatch(r"(\d)\1+", s) else None
    return f"U:{real}" if real else f"N:{(o.get('product_name') or '').upper()}"


def _fetch_cpl(con, src, ed, keys) -> list[dict]:
    """cpl_enriched rows (with the columns attach_tiers + the card need) for the
    given (wholesaler, upc_norm) pairs in one edition."""
    if not keys:
        return []
    ups = sorted({k[1] for k in keys if k[1] is not None})
    if not ups:
        return []
    ph = ",".join(["?"] * len(ups))
    # SELECT * so we never break on a column name that's computed in /search rather
    # than stored raw; attach_tiers + the card read the columns they need via .get.
    recs = con.execute(
        f"SELECT *, LTRIM(upc,'0') AS upc_norm FROM {src} WHERE edition = ? AND LTRIM(upc,'0') IN ({ph})",
        [ed, *ups],
    ).fetchdf().to_dict("records")
    return recs
