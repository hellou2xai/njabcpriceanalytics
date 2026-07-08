"""Precomputed cross-distributor offer grid (the smart-cart "bread and butter").

PRECOMPUTE_INVENTORY #11: the compare boards and the smart cart both need, for a
given SKU, the FULL per-distributor offer set (frontline / after-QD / RIP / net,
ranked cheapest-first) within one edition. Computing that live means grouping the
whole catalogue by the canonical identity (normalised UPC + size + pack + vintage)
on every request. The grouping is a pure function of the pricing data, so we do it
ONCE at cache-build time and materialise `sku_offer`, then every consumer (cart,
Compare, Price 360, the assistant) reads it as a point lookup.

Crucially this does NOT re-implement any pricing/identity math. It CALLS the
canonical `compare._common_rows` (same `_size_key` / `_pack_norm` / `_vintage_key`
identity, same best-offer-per-distributor rule), so the grid can never drift from
the live Compare board. The headline numbers (frontline / best_case / effective /
rip_savings) are the precomputed columns already on `cpl_enriched`; here we only
add the cross-distributor RANK.

RIP is computed and stored PER DISTRIBUTOR, never assumed equal across houses:
each row carries that distributor's own `has_rip` / `rip_code` / `rip_savings`, so
the comparison shows every distributor's RIP layer (blank where a house has none).

Edition is in the key of every row. RIP codes are recycled per edition, so a grid
keyed on identity WITHOUT edition would weld May's Parrot Bay onto June's Sarti
Rosa. Consumers MUST filter to the row's own edition.
"""

import math
import os
import time

import pandas as pd

# Reuse the canonical compare helpers — do not fork the identity / best-offer rule.
from backend.routers.compare import _common_rows, _display_name, _cpn_for_upcs
from backend import pricing as _pricing

_TIE_EPS = 0.005

# How many editions to materialise. 0 = ALL loaded editions (the default) so the
# Discover Deals "bible" (deal_grid, built from sku_offer) can serve EVERY month
# the Month filter offers. The cart/Compare only need the recent months, but the
# extra editions are cheap here (a handful loaded) and prod is a paid instance;
# set SKU_OFFER_EDITIONS=N to cap to the most recent N (plus future) if ever needed.
_RECENT_EDITIONS = int(os.getenv("SKU_OFFER_EDITIONS", "0"))

# Per-row columns written to the sku_offer table, in order.
_OFFER_COLS = [
    "edition", "match_key", "group_key", "wholesaler",
    "upc", "upc_norm", "product_name", "display_name",
    "unit_volume", "unit_volume_std", "unit_qty", "vintage",
    "item_no", "product_type", "brand",
    "frontline_case_price", "after_qd_case_price", "effective_case_price",
    "btl_effective", "qd_save_per_case", "rip_savings", "total_savings_per_case",
    "has_discount", "has_rip", "rip_code",
    "net_rank", "is_cheapest_net", "n_distributors", "spread_net",
    "enr_category", "enr_region", "abv_proof",
]


def _num(v):
    """Coerce to float or None (NaN -> None)."""
    if v is None:
        return None
    try:
        f = float(v)
        return None if f != f else f
    except (TypeError, ValueError):
        return None


def _rank_key(row: dict) -> float:
    eff = _num(row.get("effective_case_price"))
    return eff if eff is not None else float("inf")


def _editions(con, src: str) -> list[str]:
    rows = con.execute(
        f"SELECT DISTINCT edition FROM {src} WHERE edition IS NOT NULL ORDER BY edition"
    ).fetchall()
    eds = [r[0] for r in rows]
    if _RECENT_EDITIONS <= 0 or len(eds) <= _RECENT_EDITIONS:
        return eds
    # Keep the most recent N editions PLUS any edition after today's month (the
    # next-month preview), even if it falls outside the recent window.
    cur = _pricing.current_yyyy_mm()
    recent = set(eds[-_RECENT_EDITIONS:])
    future = {e for e in eds if e > cur}
    return sorted(recent | future)


def _slugs_for_edition(con, src: str, edition: str) -> list[str]:
    rows = con.execute(
        f"SELECT DISTINCT wholesaler FROM {src} WHERE edition = ? AND wholesaler IS NOT NULL",
        [edition],
    ).fetchall()
    return sorted(r[0] for r in rows)


def _grid_rows_for_edition(con, src: str, edition: str) -> list[dict]:
    """All sku_offer rows for one edition: the canonical best offer per
    (identity, distributor) from _common_rows, ranked cheapest-net first within
    each identity group."""
    slugs = _slugs_for_edition(con, src, edition)
    if not slugs:
        return []
    eds = {s: edition for s in slugs}
    # require_all=False -> keep the best offer at EVERY distributor that carries the
    # SKU (no intersection), so a SKU carried by one house still gets a row.
    recs = _common_rows(con, src, slugs, eds, require_all=False)
    if not recs:
        return []

    # CELR family (cpn) makes cross-distributor grouping correct in both
    # directions, the SAME way the compare boards do it:
    #   - MERGE the same product filed under DIFFERENT barcodes by each house
    #     (e.g. Glenlivet Jamaica: allied 674868000146 vs fedway 64868000146).
    #   - SPLIT a barcode that two genuinely different products share in the
    #     source data (e.g. Penfolds Bin 28 vs Bin 98 under one bad barcode) —
    #     different cpn => different group => no bogus "switch" suggestion.
    # Name divergence can't gate this (a legit match like Yamazaki has wildly
    # different names per house), but cpn can. When no cpn is known we fall back
    # to the barcode identity (match_key), i.e. today's behaviour.
    cpn_map = {}
    try:
        cpn_map = _cpn_for_upcs(con, [r.get("upc_norm") for r in recs])
    except Exception:
        cpn_map = {}

    def _group_key(r: dict) -> str:
        cpn = cpn_map.get(str(r.get("upc_norm")))
        if cpn is None:
            return r["match_key"]
        # cpn + physical-size/pack/vintage suffix of the match_key, so a 750ml and
        # a 1.75L of the same family stay in SEPARATE comparison sets.
        suffix = r["match_key"].split("|", 1)[1] if "|" in r["match_key"] else ""
        return f"C{cpn}|{suffix}"

    # Group by the cpn-aware key to assign the cross-distributor rank.
    groups: dict[str, list[dict]] = {}
    for r in recs:
        r["_group_key"] = _group_key(r)
        groups.setdefault(r["_group_key"], []).append(r)

    out: list[dict] = []
    for gk, members in groups.items():
        members.sort(key=_rank_key)
        effs = [e for e in (_num(m.get("effective_case_price")) for m in members) if e is not None]
        spread = round(max(effs) - min(effs), 2) if len(effs) >= 2 else 0.0
        n_dist = len({m["wholesaler"] for m in members})
        # vintage tokens for the cleaned display name
        vintages = {m.get("vintage") for m in members if m.get("vintage")}
        rank = 0
        for m in members:
            front = _num(m.get("frontline_case_price"))
            after = _num(m.get("best_case_price"))
            eff = _num(m.get("effective_case_price"))
            uqd = _num(m.get("uqd"))
            qd_save = (round(front - after, 2)
                       if front is not None and after is not None and after < front - _TIE_EPS
                       else 0.0)
            vsens = bool(m.get("vintage_sensitive"))
            name = m.get("enr_name") or m.get("product_name")
            out.append({
                "edition": edition,
                "match_key": m.get("match_key"),
                "group_key": gk,
                "wholesaler": m.get("wholesaler"),
                "upc": m.get("upc"),
                "upc_norm": m.get("upc_norm"),
                "product_name": m.get("product_name"),
                "display_name": _display_name(name, vintages, vsens),
                "unit_volume": m.get("unit_volume"),
                "unit_volume_std": m.get("unit_volume_std"),
                "unit_qty": (str(m.get("unit_qty")) if m.get("unit_qty") is not None else None),
                "vintage": m.get("vintage"),
                "item_no": m.get("dist_item_no") or m.get("abg_sku"),
                "product_type": m.get("product_type"),
                "brand": m.get("brand"),
                "frontline_case_price": front,
                "after_qd_case_price": after,
                "effective_case_price": eff,
                "btl_effective": (round(eff / uqd, 2) if eff is not None and uqd else None),
                "qd_save_per_case": qd_save or None,
                "rip_savings": _num(m.get("rip_savings")),
                "total_savings_per_case": _num(m.get("total_savings_per_case")),
                "has_discount": bool(m.get("has_discount")),
                "has_rip": bool(m.get("has_rip")),
                "rip_code": (str(m.get("rip_code")) if m.get("rip_code") not in (None, "", "0") else None),
                "net_rank": rank,
                "is_cheapest_net": (rank == 0 and eff is not None),
                "n_distributors": n_dist,
                "spread_net": spread,
                "enr_category": m.get("enr_category"),
                "enr_region": m.get("enr_region"),
                "abv_proof": m.get("abv_proof"),
            })
            rank += 1
    return out


def build_sku_offer(con, *, log=print) -> int:
    """(Re)build the `sku_offer` table on the given cache connection. Returns the
    row count. Best-effort: the caller wraps this so a failure never breaks the
    cache build. Must run AFTER cpl_enriched is finalised (price_trend rebuild +
    upc_norm + enr_name columns), since _common_rows reads them."""
    if os.getenv("BUILD_SKU_OFFER", "1").strip().lower() not in ("1", "true", "yes", "on"):
        log("[sku_offer] skipped (BUILD_SKU_OFFER disabled)")
        return 0
    src = "cpl_enriched"
    t0 = time.time()
    con.execute("DROP TABLE IF EXISTS sku_offer")
    col_defs = ", ".join(
        f"{c} {'BOOLEAN' if c in ('has_discount', 'has_rip', 'is_cheapest_net') else 'INTEGER' if c in ('net_rank', 'n_distributors') else 'DOUBLE' if c in ('frontline_case_price', 'after_qd_case_price', 'effective_case_price', 'btl_effective', 'qd_save_per_case', 'rip_savings', 'total_savings_per_case', 'spread_net') else 'VARCHAR'}"
        for c in _OFFER_COLS
    )
    con.execute(f"CREATE TABLE sku_offer ({col_defs})")

    cols = ", ".join(_OFFER_COLS)
    total = 0
    for ed in _editions(con, src):
        try:
            rows = _grid_rows_for_edition(con, src, ed)
        except Exception as exc:  # one bad edition must not sink the rest
            log(f"[sku_offer] edition {ed} failed: {exc}")
            continue
        if not rows:
            continue
        # Insert per-edition and FREE immediately. Accumulating EVERY edition's
        # rows (~140k) plus a DataFrame copy peaked ~350MB of Python at boot,
        # which OOM'd the memory-constrained instance — and each uvicorn worker
        # builds the cache independently, so it doubled. Streaming the insert
        # caps the peak to a single edition.
        _df = pd.DataFrame(rows, columns=_OFFER_COLS)  # noqa: F841 (used by SQL)
        con.execute(f"INSERT INTO sku_offer SELECT {cols} FROM _df")
        total += len(rows)
        del rows, _df

    # Indexes for the two hot lookups: resolve a line's identity, then fetch the
    # whole grid by (edition, group_key).
    for name, cols in (
        ("idx_skuoffer_lookup", "edition, wholesaler, upc_norm"),
        ("idx_skuoffer_group", "edition, group_key"),
    ):
        try:
            con.execute(f"CREATE INDEX {name} ON sku_offer ({cols})")
        except Exception:
            pass
    log(f"[sku_offer] built {total} rows in {time.time() - t0:.1f}s")
    return total


# ---------------------------------------------------------------------------
# Serving helpers (read the precomputed table; safe fallback when it's absent).
# ---------------------------------------------------------------------------

def _resolve_group_key(con, edition: str, wholesaler: str, upc_norm: str,
                       unit_qty=None) -> str | None:
    """Find a cart line's comparison group (group_key) in sku_offer. When a
    barcode carries several packs, disambiguate by unit_qty."""
    try:
        rows = con.execute(
            "SELECT group_key, unit_qty FROM sku_offer "
            "WHERE edition = ? AND wholesaler = ? AND upc_norm = ?",
            [edition, wholesaler, upc_norm],
        ).fetchall()
    except Exception:
        return None
    if not rows:
        return None
    if len(rows) == 1:
        return rows[0][0]
    if unit_qty is not None:
        uq = str(unit_qty)
        for gk, ruq in rows:
            if str(ruq) == uq:
                return gk
    return rows[0][0]


def offer_grid(con, *, edition: str, wholesaler: str, upc_norm: str,
               unit_qty=None) -> list[dict]:
    """The full per-distributor comparison for one SKU within its edition,
    cheapest-net first. USER-INDEPENDENT, so memoize it (cache_util auto-keys on
    the pricing version, invalidating on reload). This is the cart's hot path —
    every cart load called it per line with 2 SQL each; under concurrency that
    serialized on the single-threaded DuckDB pool. The cached list is shared and
    READ-ONLY (callers must not mutate it)."""
    from backend import cache_util
    params = (edition, wholesaler, upc_norm, str(unit_qty) if unit_qty is not None else None)
    return cache_util.cached_response(
        "offer_grid", params,
        lambda: _offer_grid_build(con, edition=edition, wholesaler=wholesaler,
                                  upc_norm=upc_norm, unit_qty=unit_qty))


def _offer_grid_build(con, *, edition: str, wholesaler: str, upc_norm: str,
                      unit_qty=None) -> list[dict]:
    gk = _resolve_group_key(con, edition, wholesaler, upc_norm, unit_qty)
    if not gk:
        return []
    try:
        df = con.execute(
            f"SELECT {', '.join(_OFFER_COLS)} FROM sku_offer "
            "WHERE edition = ? AND group_key = ? ORDER BY net_rank",
            [edition, gk],
        ).df()
    except Exception:
        return []
    out = []
    for r in df.to_dict("records"):
        for k, v in list(r.items()):
            if isinstance(v, float) and math.isnan(v):
                r[k] = None
        out.append(r)
    return out
