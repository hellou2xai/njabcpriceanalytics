"""Compare Prices — side-by-side price comparison across 2-3 distributors.

Strict UPC intersection: only products carried by ALL selected distributors
(same normalised UPC + size + pack + vintage rules as /catalog/cross-distributor)
so the grid never shows blank cells.

Three price layers per distributor per product:
  - frontline_case_price  (list)
  - best_case_price       (price after the best CPL quantity discount)
  - effective_case_price  (after best QD + best full-month RIP — the canonical
                           "the price" per FOUNDATION.md)
plus the full QD/RIP tier ladder on demand (/tiers) via pricing.attach_tiers —
no pricing math re-implemented here.

Endpoints:
  GET /api/compare/options   — distributors + product counts for the picker
  GET /api/compare/products  — the comparison grid + smart analysis summary
  GET /api/compare/tiers     — full side-by-side tier ladders for one product
  GET /api/compare/rips      — RIP-outcome comparison (landed curve + break-even)
  GET /api/compare/price360  — one holistic per-product label ranking every offer
"""
import math
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from backend import pricing as _pricing
from backend.auth import get_optional_user
from backend.db import get_duckdb, read_parquet
from backend.size_std import _to_ml

router = APIRouter(prefix="/api/compare", tags=["compare"])

_MAX_WHOLESALERS = 3
_TIE_EPS = 0.005

# Same validity rule as catalog: a real barcode, not stub/placeholder filler.
_VALID_UPC = (
    "upc IS NOT NULL AND upc <> '' AND upc <> '0'"
    " AND NOT regexp_matches(upc, '^(0+|9+|1+)$')"
    " AND NOT upc LIKE '999999%'"
    " AND LENGTH(upc) >= 8"
)


def _parse_wholesalers(raw: str, con) -> list[str]:
    """Validate the comma-separated wholesaler list against the data."""
    slugs = [w.strip() for w in raw.split(",") if w.strip()]
    if not (2 <= len(slugs) <= _MAX_WHOLESALERS):
        raise HTTPException(400, f"Pick 2-{_MAX_WHOLESALERS} distributors")
    if len(set(slugs)) != len(slugs):
        raise HTTPException(400, "Duplicate distributor")
    src = read_parquet(con, "cpl_enriched")
    known = {r[0] for r in con.execute(f"SELECT DISTINCT wholesaler FROM {src}").fetchall()}
    bad = [s for s in slugs if s not in known]
    if bad:
        raise HTTPException(400, f"Unknown distributor(s): {', '.join(bad)}")
    return slugs


def _editions_for(con, src: str, slugs: list[str]) -> dict[str, str]:
    """Current edition per wholesaler (latest edition <= current ET month,
    falling back to the latest available)."""
    current_ym = _pricing.current_yyyy_mm()
    placeholders = ",".join("?" * len(slugs))
    rows = con.execute(
        f"""
        SELECT wholesaler,
               MAX(CASE WHEN edition <= ? THEN edition END) AS cur_ed,
               MAX(edition) AS latest_ed
        FROM {src}
        WHERE wholesaler IN ({placeholders})
        GROUP BY wholesaler
        """,
        [current_ym] + slugs,
    ).fetchall()
    eds = {r[0]: (r[1] or r[2]) for r in rows}
    missing = [s for s in slugs if s not in eds]
    if missing:
        raise HTTPException(400, f"No data for: {', '.join(missing)}")
    return eds


def _edition_pred(slugs: list[str], eds: dict[str, str]) -> tuple[str, list]:
    parts, params = [], []
    for s in slugs:
        parts.append("(wholesaler = ? AND edition = ?)")
        params.extend([s, eds[s]])
    return "(" + " OR ".join(parts) + ")", params


def _nan_clean(rec: dict) -> dict:
    for k, v in list(rec.items()):
        if isinstance(v, float) and math.isnan(v):
            rec[k] = None
    return rec


_PACK_COMBO = re.compile(r"^\s*(\d+)\s*[/xX\s]\s*(\d+)")


def _pack_norm(uq) -> str:
    """Bottles-per-case as a canonical string. Handles '24', '24.0', 24.0 and
    multi-pack spellings like '2 12-Packs' / '4 6-packs' (-> 24). '' if unknown."""
    if uq is None:
        return ""
    s = str(uq).strip()
    if not s:
        return ""
    try:
        f = float(s)
        if f != f:  # NaN
            return ""
        return str(int(f)) if f.is_integer() else str(f)
    except ValueError:
        pass
    m = _PACK_COMBO.match(s)
    if m:
        return str(int(m.group(1)) * int(m.group(2)))
    return s.upper()


def _size_key(raw) -> str:
    """Physical-size bucket so '12OZ', '12oz' and '355ML' all match (same can),
    and '15.5GAL' matches '1984OZ' (same 1/2-BBL keg). Unparseable sizes fall
    back to the cleaned raw string so they can still match their own spelling."""
    ml, _fam = _to_ml(str(raw or ""))
    if ml is None:
        return (str(raw or "").strip().upper().replace(" ", "")) or "?"
    if ml >= 15000:  # kegs / bulk: bucket to 100 ml
        return f"K{round(ml / 100)}"
    return f"M{round(ml / 5) * 5}"  # bottles/cans: bucket to 5 ml


def _common_rows(con, src: str, slugs: list[str], eds: dict[str, str]) -> list[dict]:
    """One best-offer row per (identity key, wholesaler), restricted to
    identity keys present at ALL selected wholesalers.

    Identity = normalised UPC + physical-size bucket + bottles-per-case +
    vintage (vintage-sensitive categories only). Size and pack are normalised
    in Python (_size_key / _pack_norm) because distributors spell the same
    physical size many ways ('12OZ' vs '355ML', '24' vs '2 12-Packs')."""
    ed_pred, ed_params = _edition_pred(slugs, eds)
    vn = _pricing.vintage_norm_sql("vintage")
    # Exclude a row as "part of a combo bundle" ONLY when its combo_code is a
    # real code in that wholesaler's COMBO sheet. Some distributors (Shore
    # Point, Jersey Beverage) repurpose the CPL combo-code column for internal
    # cross-reference codes — a blanket non-empty test would silently drop
    # most of their catalogue from every comparison.
    combo_pred = "TRUE"
    has_combo_tbl = bool(con.execute(
        "SELECT 1 FROM information_schema.tables WHERE table_name = 'combo'"
    ).fetchone())
    if has_combo_tbl:
        combo_src = read_parquet(con, "combo")
        combo_pred = f"""NOT EXISTS (
            SELECT 1 FROM {combo_src} cb
            WHERE cb.wholesaler = e.wholesaler AND cb.edition = e.edition
              AND cb.combo_code = e.combo_code
        )"""
    sql = f"""
        SELECT wholesaler, edition, upc, product_name, product_type, brand,
               unit_qty, unit_volume, vintage, abv_proof,
               frontline_case_price, frontline_unit_price,
               best_case_price, best_unit_price,
               effective_case_price, rip_savings, total_savings_per_case,
               has_discount, has_rip, rip_code,
               discount_1_qty, discount_1_amt, discount_2_qty, discount_2_amt,
               discount_3_qty, discount_3_amt, discount_4_qty, discount_4_amt,
               discount_5_qty, discount_5_amt,
               LTRIM(upc, '0') AS upc_norm,
               TRY_CAST(unit_qty AS DOUBLE) AS uqd,
               {vn} AS vintage_norm,
               UPPER(product_type) IN ('WINE','SPARKLING','VERMOUTH') AS vintage_sensitive
        FROM {src} e
        WHERE {ed_pred}
          AND {_VALID_UPC}
          AND (combo_code IS NULL OR combo_code = '' OR combo_code = '0'
               OR {combo_pred})
    """
    df = con.execute(sql, ed_params).df()
    recs = [_nan_clean(r) for r in df.to_dict(orient="records")]

    # Build identity keys in Python (size/pack spellings vary by distributor).
    for r in recs:
        pack = _pack_norm(r.get("unit_qty"))
        r["pack_norm"] = pack
        r["match_key"] = "|".join([
            r["upc_norm"],
            _size_key(r.get("unit_volume")),
            pack,
            (r.get("vintage_norm") or "") if r.get("vintage_sensitive") else "",
        ])

    # Drop ambiguous identities: a key mapping to >1 distinct product name
    # within ONE wholesaler is an unreliable barcode (same rule as
    # /catalog/cross-distributor). Split-case duplicate listings of the same
    # product share a name prefix, so compare on a cleaned name.
    names: dict[tuple, set] = {}
    for r in recs:
        names.setdefault((r["wholesaler"], r["match_key"]), set()).add(
            re.sub(r"\s+", " ", (r["product_name"] or "").strip().upper())[:12]
        )
    ambiguous = {k for k, v in names.items() if len(v) > 1}
    recs = [r for r in recs if (r["wholesaler"], r["match_key"]) not in ambiguous]

    # Best offer per (key, wholesaler): cheapest effective, then frontline.
    best: dict[tuple, dict] = {}
    for r in recs:
        k = (r["match_key"], r["wholesaler"])
        cur = best.get(k)
        def _rank(x):
            return (
                x.get("effective_case_price") if x.get("effective_case_price") is not None else float("inf"),
                x.get("frontline_case_price") if x.get("frontline_case_price") is not None else float("inf"),
            )
        if cur is None or _rank(r) < _rank(cur):
            best[k] = r

    # Keep only keys present at ALL selected wholesalers.
    per_key: dict[str, int] = {}
    for (mk, _w) in best:
        per_key[mk] = per_key.get(mk, 0) + 1
    n = len(slugs)
    return [r for (mk, _w), r in best.items() if per_key[mk] == n]


def _winner(per: dict[str, dict], field: str) -> dict:
    """Cheapest wholesaler for a price field. Ties within $0.005 -> 'tie'."""
    vals = {w: d.get(field) for w, d in per.items() if d.get(field) is not None and d.get(field) > 0}
    if not vals:
        return {"winner": None, "spread": None}
    lo = min(vals.values())
    hi = max(vals.values())
    winners = [w for w, v in vals.items() if abs(v - lo) < _TIE_EPS]
    return {
        "winner": "tie" if len(winners) > 1 else winners[0],
        "spread": round(hi - lo, 2),
    }


@router.get("/options")
def options(user: Optional[dict] = Depends(get_optional_user)):
    """Distributors available for comparison, with current-edition product
    counts so the picker can hint at catalogue size."""
    with get_duckdb() as con:
        src = read_parquet(con, "cpl_enriched")
        slugs = [r[0] for r in con.execute(
            f"SELECT DISTINCT wholesaler FROM {src} ORDER BY wholesaler").fetchall()]
        eds = _editions_for(con, src, slugs)
        ed_pred, ed_params = _edition_pred(slugs, eds)
        rows = con.execute(f"""
            SELECT wholesaler, COUNT(DISTINCT LTRIM(upc,'0') || '|' || COALESCE(unit_volume,'')) AS n
            FROM {src}
            WHERE {ed_pred} AND {_VALID_UPC}
            GROUP BY wholesaler ORDER BY wholesaler
        """, ed_params).fetchall()
        return [
            {"wholesaler": w, "edition": eds.get(w), "products": n}
            for w, n in rows
        ]


@router.get("/products")
def compare_products(
    wholesalers: str = Query(..., description="2-3 comma-separated slugs"),
    q: str = Query("", description="Product name contains"),
    product_type: str = Query(""),
    only_differences: bool = Query(False),
    min_spread: float = Query(0.0, ge=0),
    sort: str = Query("spread", description="spread | spread_pct | product | effective"),
    order: str = Query("desc"),
    limit: int = Query(2000, ge=1, le=50000),
    user: Optional[dict] = Depends(get_optional_user),
):
    """The comparison grid: products common to ALL selected distributors with
    the three price layers per distributor, per-layer winners, and a smart
    analysis summary."""
    with get_duckdb() as con:
        src = read_parquet(con, "cpl_enriched")
        slugs = _parse_wholesalers(wholesalers, con)
        eds = _editions_for(con, src, slugs)
        raw = _common_rows(con, src, slugs, eds)

    # Pivot: match_key -> {wholesaler: row}
    by_key: dict[str, dict[str, dict]] = {}
    for r in raw:
        by_key.setdefault(r["match_key"], {})[r["wholesaler"]] = r

    rows = []
    for key, per in by_key.items():
        if len(per) != len(slugs):
            continue  # defensive; SQL already guarantees this
        any_row = per[slugs[0]]
        name = min((d["product_name"] for d in per.values()), key=len)
        w_front = _winner(per, "frontline_case_price")
        w_qd = _winner(per, "best_case_price")
        w_eff = _winner(per, "effective_case_price")
        effs = [d.get("effective_case_price") for d in per.values()
                if d.get("effective_case_price")]
        best_eff = min(effs) if effs else None
        parts = key.split("|")
        row = {
            "match_key": key,
            "upc_norm": parts[0],
            "size_key": parts[1] if len(parts) > 1 else "",
            "product_name": name,
            "product_type": any_row.get("product_type"),
            "brand": any_row.get("brand"),
            "unit_qty": any_row.get("unit_qty"),
            "unit_volume": any_row.get("unit_volume"),
            "vintage": any_row.get("vintage"),
            "upc": any_row.get("upc"),
            "prices": {
                w: {
                    "upc": d.get("upc"),
                    "edition": d.get("edition"),
                    "product_name": d.get("product_name"),
                    "frontline": d.get("frontline_case_price"),
                    "after_qd": d.get("best_case_price"),
                    "effective": d.get("effective_case_price"),
                    "btl_effective": (
                        round(d["effective_case_price"] / d["uqd"], 2)
                        if d.get("effective_case_price") and d.get("uqd") else None
                    ),
                    "rip_savings": d.get("rip_savings"),
                    "has_discount": bool(d.get("has_discount")),
                    "has_rip": bool(d.get("has_rip")),
                } for w, d in per.items()
            },
            "winner_frontline": w_front["winner"],
            "winner_after_qd": w_qd["winner"],
            "winner_effective": w_eff["winner"],
            "spread": w_eff["spread"],
            "spread_pct": (
                round(w_eff["spread"] / best_eff * 100, 1)
                if w_eff["spread"] is not None and best_eff else None
            ),
            # winner changes once deals are applied -> volume/deals flip it
            "deal_flip": (
                w_front["winner"] is not None and w_eff["winner"] is not None
                and w_front["winner"] != w_eff["winner"]
            ),
        }
        rows.append(row)

    # ---- search/category filters narrow BOTH the grid and the summary ------
    if q:
        qq = q.lower()
        rows = [r for r in rows if qq in (r["product_name"] or "").lower()
                or qq in (r["brand"] or "").lower()]
    if product_type:
        rows = [r for r in rows if (r["product_type"] or "").lower() == product_type.lower()]

    # ---- smart analysis (over the full common set for this search context;
    #      only_differences / min_spread are display filters and must NOT
    #      zero out the ties / common-products scoreboard) -------------------
    wins = {w: 0 for w in slugs}
    wins_front = {w: 0 for w in slugs}
    ties = 0
    flips = []
    total_spread = 0.0
    by_type: dict[str, dict[str, int]] = {}
    for r in rows:
        w = r["winner_effective"]
        if w == "tie":
            ties += 1
        elif w in wins:
            wins[w] += 1
            t = r["product_type"] or "Other"
            by_type.setdefault(t, {x: 0 for x in slugs})[w] += 1
        wf = r["winner_frontline"]
        if wf in wins_front:
            wins_front[wf] += 1
        if r["deal_flip"]:
            flips.append(r)
        total_spread += r["spread"] or 0.0

    top_spreads = sorted(rows, key=lambda r: -(r["spread"] or 0))[:5]
    insights = []
    if rows:
        overall = max(wins, key=lambda w: wins[w])
        if wins[overall] > 0:
            insights.append(
                f"{overall} is cheapest on {wins[overall]} of {len(rows)} shared products "
                f"(effective price, after all deals)."
            )
        for t, tw in sorted(by_type.items(), key=lambda kv: -sum(kv[1].values()))[:4]:
            tot = sum(tw.values())
            if tot >= 3:
                lead = max(tw, key=lambda w: tw[w])
                if tw[lead] > tot / 2:
                    insights.append(f"{lead} wins {tw[lead]}/{tot} in {t}.")
        if flips:
            ex = max(flips, key=lambda r: r["spread"] or 0)
            if ex["winner_frontline"] == "tie":
                ex_txt = (f"e.g. {ex['product_name']}: tied at list price, "
                          f"but {ex['winner_effective']} wins after deals.")
            elif ex["winner_effective"] == "tie":
                ex_txt = (f"e.g. {ex['product_name']}: {ex['winner_frontline']} is cheaper "
                          f"at list, but deals level it to a tie.")
            else:
                ex_txt = (f"e.g. {ex['product_name']}: {ex['winner_frontline']} is cheaper "
                          f"at list but {ex['winner_effective']} wins after deals.")
            insights.append(
                f"{len(flips)} product(s) change winner once QD/RIP deals apply — {ex_txt}"
            )
        if total_spread > 0:
            insights.append(
                f"Buying every shared product from its cheapest distributor saves "
                f"${total_spread:,.2f} per case-each versus always picking the most expensive."
            )

    total = len(rows)  # common universe for this search context

    # ---- display filters (grid only — summary above is already computed) ---
    if only_differences:
        rows = [r for r in rows if r["winner_effective"] not in (None, "tie")]
    if min_spread > 0:
        rows = [r for r in rows if (r["spread"] or 0) >= min_spread]

    # ---- sort + limit ------------------------------------------------------
    keymap = {
        "spread": lambda r: r["spread"] or 0,
        "spread_pct": lambda r: r["spread_pct"] or 0,
        "product": lambda r: (r["product_name"] or "").lower(),
        "effective": lambda r: min(
            (p["effective"] for p in r["prices"].values() if p["effective"]),
            default=0,
        ),
    }
    rows.sort(key=keymap.get(sort, keymap["spread"]),
              reverse=(order != "asc") if sort != "product" else (order == "desc"))
    rows = rows[:limit]

    return {
        "wholesalers": slugs,
        "editions": eds,
        "total_common": total,
        "rows": rows,
        "summary": {
            "common_products": total,
            "wins_effective": wins,
            "wins_frontline": wins_front,
            "ties": ties,
            "deal_flips": len(flips),
            "total_spread": round(total_spread, 2),
            "top_spreads": [
                {
                    "product_name": r["product_name"],
                    "spread": r["spread"],
                    "winner": r["winner_effective"],
                    "unit_volume": r["unit_volume"],
                } for r in top_spreads if (r["spread"] or 0) > 0
            ],
            "by_type": by_type,
            "insights": insights,
        },
    }


@router.get("/tiers")
def compare_tiers(
    wholesalers: str = Query(...),
    upc_norm: str = Query(...),
    size_key: str = Query("", description="Physical-size bucket from /products rows"),
    user: Optional[dict] = Depends(get_optional_user),
):
    """Full QD + RIP tier ladders, side by side, for one matched product.
    Ladders come from pricing.attach_tiers — the same canonical builder the
    catalog grid and product modal use."""
    with get_duckdb() as con:
        src = read_parquet(con, "cpl_enriched")
        slugs = _parse_wholesalers(wholesalers, con)
        eds = _editions_for(con, src, slugs)
        ed_pred, ed_params = _edition_pred(slugs, eds)
        df = con.execute(f"""
            SELECT wholesaler, edition, upc, product_name, product_type,
                   unit_qty, unit_volume, vintage, rip_code,
                   frontline_case_price, frontline_unit_price,
                   best_case_price, effective_case_price,
                   discount_1_qty, discount_1_amt, discount_2_qty, discount_2_amt,
                   discount_3_qty, discount_3_amt, discount_4_qty, discount_4_amt,
                   discount_5_qty, discount_5_amt
            FROM {src}
            WHERE {ed_pred} AND LTRIM(upc,'0') = ?
        """, ed_params + [upc_norm]).df()
        records = [_nan_clean(r) for r in df.to_dict(orient="records")]
        if size_key:
            records = [r for r in records if _size_key(r.get("unit_volume")) == size_key]
        # best (cheapest effective) offer per wholesaler
        chosen: dict[str, dict] = {}
        for r in records:
            cur = chosen.get(r["wholesaler"])
            eff = r.get("effective_case_price")
            cur_eff = cur.get("effective_case_price") if cur else None
            if cur is None or (eff is not None and (cur_eff is None or eff < cur_eff)):
                chosen[r["wholesaler"]] = r
        records = list(chosen.values())
        _pricing.attach_tiers(con, records)

    out = {}
    for rec in records:
        out[rec["wholesaler"]] = {
            "product_name": rec.get("product_name"),
            "upc": rec.get("upc"),
            "edition": rec.get("edition"),
            "unit_qty": rec.get("unit_qty"),
            "unit_volume": rec.get("unit_volume"),
            "vintage": rec.get("vintage"),
            "frontline": rec.get("frontline_case_price"),
            "after_qd": rec.get("best_case_price"),
            "effective": rec.get("effective_case_price"),
            "tiers": rec.get("tiers", []),
        }
    return {"wholesalers": slugs, "ladders": out}


# ===========================================================================
# RIP comparison — RIP outcome is a landed-$/case curve as a function of cases
# bought; the same product can RIP completely differently across distributors.
# ===========================================================================

def _is_btl_unit(unit) -> bool:
    return "bottle" in (str(unit or "").lower()) or "btl" in str(unit or "").lower()


def _norm_proof(v) -> Optional[float]:
    """Normalise a proof/ABV cell to a comparable proof number. '40%'/'40' ABV
    -> 80 proof; '80'/'80 proof' -> 80. None for blank/junk."""
    if v is None:
        return None
    s = str(v).strip().lower()
    if not s or s in ("na", "n/a", "none"):
        return None
    is_abv = "%" in s
    m = re.search(r"(\d+(?:\.\d+)?)", s)
    if not m:
        return None
    x = float(m.group(1))
    if is_abv or x <= 50:  # ABV given (or a low number that must be ABV)
        x *= 2
    return round(x, 1)


def _cases_threshold(tier: dict, pack: float) -> Optional[float]:
    """A tier's qty expressed in CASES (bottle-unit tiers / pack)."""
    q = tier.get("qty")
    if q is None:
        return None
    if _is_btl_unit(tier.get("unit")) and pack and pack > 0:
        return q / pack
    return float(q)


def _landed_at(tiers: list, frontline: Optional[float], n_cases: float, pack: float) -> Optional[float]:
    """Best landed $/case at n_cases — min price_after over every QD/RIP tier
    whose threshold is cleared at n_cases (tiers already stack QD+RIP)."""
    best = frontline if frontline is not None else None
    for t in tiers:
        pa = t.get("price_after")
        thr = _cases_threshold(t, pack)
        if pa is None or thr is None:
            continue
        if n_cases + 1e-9 >= thr and (best is None or pa < best):
            best = pa
    return round(best, 2) if best is not None else None


def _rip_rebate_at(tiers: list, n_cases: float, pack: float) -> float:
    """Best RIP-only rebate $/case at n_cases (source == 'rip')."""
    best = 0.0
    for t in tiers:
        if t.get("source") != "rip":
            continue
        thr = _cases_threshold(t, pack)
        if thr is None or n_cases + 1e-9 < thr:
            continue
        save = t.get("rip_only_save_per_case")
        if save is None:
            save = t.get("save_per_case") or 0.0
        if save > best:
            best = save
    return round(best, 2)


def _min_cases_to_rip(tiers: list, pack: float) -> Optional[int]:
    """Fewest cases that unlock ANY RIP rebate (the 'less money required' metric)."""
    import math as _m
    mins = []
    for t in tiers:
        if t.get("source") != "rip":
            continue
        thr = _cases_threshold(t, pack)
        if thr is not None and thr > 0:
            mins.append(_m.ceil(thr - 1e-9))
    return min(mins) if mins else None


def _rip_tier_rows(tiers: list, pack: float) -> list[dict]:
    """Normalised RIP tiers for the side-by-side table."""
    import math as _m
    rows = []
    for t in tiers:
        if t.get("source") != "rip":
            continue
        thr = _cases_threshold(t, pack)
        rows.append({
            "cases_to_unlock": _m.ceil(thr - 1e-9) if thr is not None else None,
            "raw_qty": t.get("qty"),
            "unit": t.get("unit"),
            "rebate_per_case": t.get("rip_only_save_per_case")
                if t.get("rip_only_save_per_case") is not None else t.get("save_per_case"),
            "price_after": t.get("price_after"),
            "window_status": t.get("window_status"),
            "is_time_sensitive": bool(t.get("is_time_sensitive")),
            "from_date": t.get("from_date"),
            "to_date": t.get("to_date"),
        })
    rows.sort(key=lambda r: (r["cases_to_unlock"] if r["cases_to_unlock"] is not None else 1e9))
    return rows


def _p360_tier_rows(tiers: list, pack: float, source: str) -> list[dict]:
    """Labeled tier ladder for the Price 360 breakdown — QD or RIP, each with
    the resulting case AND bottle price, sorted by cases-to-unlock."""
    import math as _m
    rows = []
    for t in tiers:
        if t.get("source") != source:
            continue
        thr = _cases_threshold(t, pack)
        pa = t.get("price_after")
        save = (t.get("rip_only_save_per_case")
                if source == "rip" and t.get("rip_only_save_per_case") is not None
                else t.get("save_per_case"))
        rows.append({
            "cases_to_unlock": _m.ceil(thr - 1e-9) if thr is not None else None,
            "unit": t.get("unit"),
            "save_per_case": save,
            "price_after": pa,
            "price_after_btl": round(pa / pack, 2) if pa is not None and pack else None,
            "window_status": t.get("window_status"),
            "is_time_sensitive": bool(t.get("is_time_sensitive")),
            "from_date": t.get("from_date"), "to_date": t.get("to_date"),
        })
    rows.sort(key=lambda r: (r["cases_to_unlock"] if r["cases_to_unlock"] is not None else 1e9))
    return rows


def _case_mix_sizes(con, src: str, slugs: list[str], eds: dict[str, str]) -> dict[tuple, int]:
    """(wholesaler, rip_code) -> number of distinct products sharing that RIP
    code at that distributor — how wide you can MIX cases to reach a tier."""
    ed_pred, ed_params = _edition_pred(slugs, eds)
    sql = f"""
        WITH base AS (
            SELECT wholesaler,
                   LTRIM(upc,'0') || '|' || COALESCE(unit_volume,'')
                     || '|' || COALESCE(CAST(TRY_CAST(unit_qty AS DOUBLE) AS VARCHAR),'') AS ident,
                   UNNEST(string_split(REGEXP_REPLACE(rip_code, '\\s+', ' '), ' ')) AS code
            FROM {src} e
            WHERE {ed_pred} AND has_rip AND rip_code IS NOT NULL AND rip_code <> ''
        )
        SELECT wholesaler, code, COUNT(DISTINCT ident) AS n
        FROM base WHERE code <> '' AND code <> '0'
        GROUP BY wholesaler, code
    """
    rows = con.execute(sql, ed_params).fetchall()
    return {(w, c): int(n) for w, c, n in rows}


def _product_case_mix(rec: dict, mix: dict, w: str) -> Optional[int]:
    codes = [c.strip() for c in re.split(r"\s+", str(rec.get("rip_code") or "")) if c.strip()]
    sizes = [mix.get((w, c)) for c in codes if (w, c) in mix]
    return max(sizes) if sizes else None


def _rip_verdict(row: dict, slugs: list[str], n: float) -> dict:
    """Plain-language recommendation over the structured break-even data — which
    distributor's RIP is the better buy and why. Deterministic (no LLM): every
    row gets one instantly, derived from spread, thresholds, flips and combos."""
    ni = int(n)
    d = row["dists"]
    w, sp = row["winner_at_n"], row["spread_at_n"]
    mins = {x: d[x]["min_cases"] for x in slugs if d[x]["min_cases"]}
    soonest = min(mins, key=mins.get) if mins else None
    parts, pick = [], w

    if w and w != "tie" and sp:
        parts.append(f"{w.title()} is the better RIP at {ni} case(s) — "
                     f"${sp:.2f}/case lower landed cost.")
    elif w == "tie":
        parts.append(f"Landed cost ties at {ni} case(s).")
        pick = "tie"
    else:
        parts.append(f"No clear RIP edge at {ni} case(s).")

    if soonest and len(set(mins.values())) > 1:
        c = mins[soonest]
        parts.append(f"{soonest.title()} unlocks its rebate soonest "
                     f"({c} case{'s' if c != 1 else ''} down).")
        if pick in (None, "tie"):
            pick = soonest

    if row["flips"]:
        be = "; ".join(
            f"{r['from']}{('–' + str(r['to'])) if r['to'] else '+'} cs → {r['winner']}"
            for r in row["breakeven"] if r["winner"])
        parts.append(f"Best choice shifts with volume — {be}.")

    combos = [x for x in slugs if d[x]["is_combination"]]
    if combos and len(combos) < len(slugs):
        cm = d[combos[0]]["case_mix"]
        parts.append(f"{combos[0].title()}'s RIP is a combination"
                     + (f" (mix across {cm} items)" if cm else "")
                     + " — easier to hit the tier.")

    return {"pick": pick, "text": " ".join(parts)}


@router.get("/rips")
def compare_rips(
    wholesalers: str = Query("allied,fedway,opici", description="2-3 comma-separated slugs"),
    cases: float = Query(5, ge=1, description="Cases you plan to buy (drives winner@N)"),
    q: str = Query(""),
    product_type: str = Query(""),
    only_differences: bool = Query(False),
    sort: str = Query("spread", description="spread | product | min_cases | best1"),
    order: str = Query("desc"),
    limit: int = Query(2000, ge=1, le=50000),
    user: Optional[dict] = Depends(get_optional_user),
):
    """Compare RIP OUTCOMES across 2-3 distributors for every product they ALL
    carry a RIP on. Each distributor's RIP is normalised to a landed-$/case
    ladder; we report the winner at the chosen volume, the full break-even
    map, the min cases to unlock a rebate, the best 1-case outcome, and the
    case-mix breadth."""
    import math as _m
    with get_duckdb() as con:
        src = read_parquet(con, "cpl_enriched")
        slugs = _parse_wholesalers(wholesalers, con)
        eds = _editions_for(con, src, slugs)
        raw = _common_rows(con, src, slugs, eds)

        by_key: dict[str, dict[str, dict]] = {}
        for r in raw:
            by_key.setdefault(r["match_key"], {})[r["wholesaler"]] = r

        # Keep only products that ALL selected distributors RIP.
        keys = [k for k, per in by_key.items()
                if len(per) == len(slugs) and all(per[w].get("has_rip") for w in slugs)]
        flat = [by_key[k][w] for k in keys for w in slugs]
        _pricing.attach_tiers(con, flat)
        mix = _case_mix_sizes(con, src, slugs, eds)

    n = float(cases)
    rows = []
    for key in keys:
        per = by_key[key]
        any_row = per[slugs[0]]
        dists, packs, tiers_by_w = {}, {}, {}
        for w in slugs:
            rec = per[w]
            pack = rec.get("uqd") or 1.0
            tiers = rec.get("tiers", []) or []
            packs[w] = pack
            tiers_by_w[w] = tiers
            case_mix = _product_case_mix(rec, mix, w)
            rip_n = _rip_rebate_at(tiers, n, pack)
            rip_1 = _rip_rebate_at(tiers, 1, pack)
            # Combination RIP: the qualifying quantity can be MIXED across more
            # than one product/size under the same code (statute's combination
            # logic) — true when the code spans >1 listing or a tier says so.
            is_combo = bool(case_mix and case_mix > 1) or any(
                "combo" in str(t.get("description") or "").lower()
                or "combination" in str(t.get("description") or "").lower()
                for t in tiers if t.get("source") == "rip")
            dists[w] = {
                "frontline": rec.get("frontline_case_price"),
                "abv_proof": rec.get("abv_proof"),
                "landed_at_n": _landed_at(tiers, rec.get("frontline_case_price"), n, pack),
                "landed_at_1": _landed_at(tiers, rec.get("frontline_case_price"), 1, pack),
                "rip_at_1": rip_1,
                "rip_at_n": rip_n,
                # per-bottle normalisation (rebate $ spread over the pack)
                "rip_btl_at_1": round(rip_1 / pack, 2) if pack else None,
                "rip_btl_at_n": round(rip_n / pack, 2) if pack else None,
                "min_cases": _min_cases_to_rip(tiers, pack),
                "case_mix": case_mix,
                "is_combination": is_combo,
                "rip_tiers": _rip_tier_rows(tiers, pack),
                "rip_code": rec.get("rip_code"),
                "product_name": rec.get("product_name"),
                "upc": rec.get("upc"),
            }

        # winner at N
        landed_n = {w: d["landed_at_n"] for w, d in dists.items() if d["landed_at_n"] is not None}
        winner_n = None
        spread_n = None
        if landed_n:
            lo, hi = min(landed_n.values()), max(landed_n.values())
            winners = [w for w, v in landed_n.items() if abs(v - lo) < _TIE_EPS]
            winner_n = "tie" if len(winners) > 1 else winners[0]
            spread_n = round(hi - lo, 2)

        # break-even map + curve: landed cost only changes at tier thresholds
        bpset = {1, int(_m.ceil(n))}
        for w in slugs:
            for t in tiers_by_w[w]:
                thr = _cases_threshold(t, packs[w])
                if thr is not None:
                    bpset.add(max(1, int(_m.ceil(thr - 1e-9))))
        breakpoints = sorted(bpset)[:24]
        curve = []
        for b in breakpoints:
            landed = {w: _landed_at(tiers_by_w[w], per[w].get("frontline_case_price"), b, packs[w])
                      for w in slugs}
            vals = {w: v for w, v in landed.items() if v is not None}
            win = None
            if vals:
                lo = min(vals.values())
                ws = [w for w, v in vals.items() if abs(v - lo) < _TIE_EPS]
                win = "tie" if len(ws) > 1 else ws[0]
            curve.append({"cases": b, "landed": landed, "winner": win})
        # collapse consecutive same-winner breakpoints into ranges
        ranges = []
        for pt in curve:
            if ranges and ranges[-1]["winner"] == pt["winner"]:
                ranges[-1]["to"] = pt["cases"]
            else:
                ranges.append({"from": pt["cases"], "to": pt["cases"], "winner": pt["winner"]})
        if ranges:
            ranges[-1]["to"] = None  # last range is open-ended (N+)

        # statute: a RIP comparison is only valid for like proof + size. Size
        # is already part of the match key; flag any proof disagreement so the
        # UI can warn (rare — same UPC usually means same proof).
        proofs = {_norm_proof(d["abv_proof"]) for d in dists.values()
                  if _norm_proof(d["abv_proof"]) is not None}
        rows.append({
            "match_key": key,
            "upc_norm": key.split("|")[0],
            "size_key": key.split("|")[1] if "|" in key else "",
            "product_name": min((d["product_name"] for d in dists.values()), key=len),
            "product_type": any_row.get("product_type"),
            "proof_match": len(proofs) <= 1,
            "brand": any_row.get("brand"),
            "unit_qty": any_row.get("unit_qty"),
            "unit_volume": any_row.get("unit_volume"),
            "dists": dists,
            "winner_at_n": winner_n,
            "spread_at_n": spread_n,
            "breakeven": ranges,
            "curve": curve,
            "flips": len({r["winner"] for r in ranges if r["winner"]}) > 1,
            # the landed CHOICE differs: one distributor is cheaper at the
            # chosen volume, or the winner flips as volume grows. (Structural
            # differences that don't change what you pay are not counted.)
            "has_difference": bool(
                (spread_n and spread_n > 0)
                or len({r["winner"] for r in ranges if r["winner"]}) > 1),
        })

    # filters
    if q:
        qq = q.lower()
        rows = [r for r in rows if qq in (r["product_name"] or "").lower()
                or qq in (r["brand"] or "").lower()]
    if product_type:
        rows = [r for r in rows if (r["product_type"] or "").lower() == product_type.lower()]

    # AI verdict per row (deterministic, over the break-even data)
    for r in rows:
        r["verdict"] = _rip_verdict(r, slugs, n)

    # summary
    wins = {w: 0 for w in slugs}
    ties = 0
    flips = 0
    least_money = {w: 0 for w in slugs}   # who needs fewest cases to unlock
    for r in rows:
        if r["winner_at_n"] == "tie":
            ties += 1
        elif r["winner_at_n"] in wins:
            wins[r["winner_at_n"]] += 1
        if r["flips"]:
            flips += 1
        mins = {w: r["dists"][w]["min_cases"] for w in slugs if r["dists"][w]["min_cases"]}
        if mins:
            lo = min(mins.values())
            for w, v in mins.items():
                if v == lo:
                    least_money[w] += 1

    total = len(rows)  # full common-RIP universe for this search context

    # display filter (grid only — summary above already computed over all)
    if only_differences:
        rows = [r for r in rows if r["has_difference"]]

    keymap = {
        "spread": lambda r: r["spread_at_n"] or 0,
        "product": lambda r: (r["product_name"] or "").lower(),
        "min_cases": lambda r: min((d["min_cases"] or 1e9 for d in r["dists"].values()), default=1e9),
        "best1": lambda r: max((d["rip_at_1"] or 0 for d in r["dists"].values()), default=0),
    }
    rows.sort(key=keymap.get(sort, keymap["spread"]),
              reverse=(order != "asc") if sort != "product" else (order == "desc"))
    rows = rows[:limit]

    insights = []
    if total:
        lead = max(wins, key=lambda w: wins[w])
        if wins[lead]:
            insights.append(
                f"At {int(n)} case(s), {lead} gives the best RIP outcome on "
                f"{wins[lead]} of {total} shared-RIP products.")
        lm = max(least_money, key=lambda w: least_money[w])
        if least_money[lm]:
            insights.append(
                f"{lm} requires the fewest cases to unlock a RIP on "
                f"{least_money[lm]} products (least money down).")
        if flips:
            insights.append(
                f"{flips} product(s) change the best-RIP distributor as your "
                f"volume grows — check the break-even before you commit.")

    return {
        "wholesalers": slugs,
        "editions": eds,
        "cases": n,
        "total_common": total,
        "rows": rows,
        "summary": {
            "common_rip_products": total,
            "wins_at_n": wins,
            "ties": ties,
            "flips": flips,
            "least_money": least_money,
            "insights": insights,
        },
    }


def assistant_rip_comparison(con, match: str, wholesalers: Optional[list[str]] = None,
                             cases: float = 5) -> dict:
    """Single-product RIP-outcome comparison for the AI assistant. Resolves
    `match` (product name or UPC) to the SKU that the most of the selected
    distributors put a RIP on, then returns each distributor's landed $/case
    at `cases`, best 1-case rebate, min cases to unlock, case-mix breadth,
    combination flag, full break-even map and a verdict — the same logic as
    the Compare RIPs page, scoped to one product."""
    import math as _m
    src = read_parquet(con, "cpl_enriched")
    known = {r[0] for r in con.execute(f"SELECT DISTINCT wholesaler FROM {src}").fetchall()}
    slugs = [s for s in (wholesalers or ["allied", "fedway", "opici"]) if s in known]
    if len(slugs) < 2:
        return {"found": False, "note": "Need at least two valid distributors to compare."}
    eds = _editions_for(con, src, slugs)
    raw = _common_rows(con, src, slugs, eds)

    # Group ALL distributors per identity first; the same UPC is often named
    # differently across distributors, so match the text to find candidate
    # KEYS, then compare every distributor that carries that key.
    by_key: dict[str, dict] = {}
    for r in raw:
        by_key.setdefault(r["match_key"], {})[r["wholesaler"]] = r

    m = (match or "").strip().lower()
    digits = re.sub(r"\D", "", m)
    is_upc = len(digits) >= 8
    cand_keys = []
    for k, per in by_key.items():
        hit = (k.split("|")[0] == digits.lstrip("0")) if is_upc else any(
            m in (rec.get("product_name") or "").lower() for rec in per.values())
        if hit:
            cand_keys.append(k)
    best_key, best_n = None, 0
    for k in cand_keys:
        per = by_key[k]
        n_rip = sum(1 for w in slugs if per.get(w) and per[w].get("has_rip"))
        if n_rip >= 2 and n_rip > best_n:
            best_n, best_key = n_rip, k
    if not best_key:
        return {"found": False, "match": match,
                "note": "No product matched with a RIP at 2+ of the selected distributors."}

    per = by_key[best_key]
    present = [w for w in slugs if per.get(w) and per[w].get("has_rip")]
    flat = [per[w] for w in present]
    _pricing.attach_tiers(con, flat)
    mix = _case_mix_sizes(con, src, present, eds)
    n = float(cases)

    dists, packs, tiers_by_w = {}, {}, {}
    for w in present:
        rec = per[w]
        pack = rec.get("uqd") or 1.0
        tiers = rec.get("tiers", []) or []
        packs[w], tiers_by_w[w] = pack, tiers
        case_mix = _product_case_mix(rec, mix, w)
        dists[w] = {
            "landed_at_n": _landed_at(tiers, rec.get("frontline_case_price"), n, pack),
            "frontline": rec.get("frontline_case_price"),
            "rip_at_1": _rip_rebate_at(tiers, 1, pack),
            "rip_at_n": _rip_rebate_at(tiers, n, pack),
            "min_cases": _min_cases_to_rip(tiers, pack),
            "case_mix": case_mix,
            "is_combination": bool(case_mix and case_mix > 1),
            "rip_code": rec.get("rip_code"),
            "rip_tiers": _rip_tier_rows(tiers, pack),
        }

    landed_n = {w: d["landed_at_n"] for w, d in dists.items() if d["landed_at_n"] is not None}
    winner, spread = None, None
    if landed_n:
        lo, hi = min(landed_n.values()), max(landed_n.values())
        ws = [w for w, v in landed_n.items() if abs(v - lo) < _TIE_EPS]
        winner = "tie" if len(ws) > 1 else ws[0]
        spread = round(hi - lo, 2)

    bpset = {1, int(_m.ceil(n))}
    for w in present:
        for t in tiers_by_w[w]:
            thr = _cases_threshold(t, packs[w])
            if thr is not None:
                bpset.add(max(1, int(_m.ceil(thr - 1e-9))))
    curve = []
    for b in sorted(bpset)[:24]:
        landed = {w: _landed_at(tiers_by_w[w], per[w].get("frontline_case_price"), b, packs[w])
                  for w in present}
        vals = {w: v for w, v in landed.items() if v is not None}
        win = None
        if vals:
            lo = min(vals.values())
            ws2 = [w for w, v in vals.items() if abs(v - lo) < _TIE_EPS]
            win = "tie" if len(ws2) > 1 else ws2[0]
        curve.append({"cases": b, "winner": win})
    ranges = []
    for pt in curve:
        if ranges and ranges[-1]["winner"] == pt["winner"]:
            ranges[-1]["to"] = pt["cases"]
        else:
            ranges.append({"from": pt["cases"], "to": pt["cases"], "winner": pt["winner"]})
    if ranges:
        ranges[-1]["to"] = None

    row = {
        "winner_at_n": winner, "spread_at_n": spread,
        "breakeven": ranges, "flips": len({r["winner"] for r in ranges if r["winner"]}) > 1,
        "dists": dists,
    }
    return {
        "found": True,
        "product_name": min((per[w].get("product_name") for w in present), key=len),
        "unit_volume": per[present[0]].get("unit_volume"),
        "unit_qty": per[present[0]].get("unit_qty"),
        "distributors": present,
        "cases": n,
        "winner_at_n": winner,
        "spread_at_n": spread,
        "breakeven": ranges,
        "dists": dists,
        "verdict": _rip_verdict(row, present, n)["text"],
    }


# ===========================================================================
# Price 360 — one holistic label per product comparing every wholesaler offer
# across all price layers, reduced to a reachability-adjusted effective net
# cost. Invoice cost (legal, discounts only) is kept separate from economic
# net cost (rebates incl. RIP). Score weights are FIXED + PUBLISHED.
# ===========================================================================

# Published, fixed value-score weights (sum 100). Identical for every offer.
PRICE360_WEIGHTS = {"net_cost": 70, "savings": 15, "stability": 10, "compliance": 5}

# NJ ABC RIP statutory limits (for the pre-approval flag).
_RIP_MAX_CASES = 50
_RIP_MAX_REBATE = 1000.0
_RIP_SMALL_QTY_CASES = 5


def _compliance_flags(tiers: list, pack: float) -> dict:
    """NJ ABC RIP limit checks → pre-approval flags (#17)."""
    rip = [t for t in tiers if t.get("source") == "rip"]
    flags = []
    if any((_cases_threshold(t, pack) or 0) > _RIP_MAX_CASES for t in rip):
        flags.append(f"RIP tier over {_RIP_MAX_CASES} cases")
    if any((t.get("amount") or 0) > _RIP_MAX_REBATE for t in rip):
        flags.append(f"single rebate over ${int(_RIP_MAX_REBATE):,}")
    if rip and not any((_cases_threshold(t, pack) or 1e9) <= _RIP_SMALL_QTY_CASES for t in rip):
        flags.append(f"no small-quantity tier (≤{_RIP_SMALL_QTY_CASES} cases)")
    return {"flags": flags, "pre_approval": bool(flags)}


def _reachability(rip_rebate_case: float, qualifying: Optional[int],
                  typical_cases: Optional[float], mode: str) -> dict:
    """Soft/hard/off reachability (#13/14). Returns the likelihood (0..1) the
    retailer hits the qualifying quantity and the rebate value to actually
    credit. Soft scales the rebate by likelihood; hard zeroes it if unreachable;
    off always credits full value (badge only). No history -> full value."""
    if not rip_rebate_case or not qualifying:
        return {"status": "no_rip", "likelihood": 1.0, "credited_rebate": 0.0,
                "qualifying": qualifying, "typical": typical_cases}
    if typical_cases is None:
        return {"status": "unknown", "likelihood": 1.0,
                "credited_rebate": round(rip_rebate_case, 2),
                "qualifying": qualifying, "typical": None}
    ratio = typical_cases / qualifying if qualifying else 1.0
    if mode == "hard":
        like = 1.0 if ratio >= 1 else 0.0
    elif mode == "off":
        like = 1.0
    else:  # soft
        like = max(0.0, min(1.0, ratio))
    status = ("likely" if ratio >= 1 else ("partial" if ratio > 0 else "unreachable"))
    return {"status": status, "likelihood": round(like, 2),
            "credited_rebate": round(rip_rebate_case * like, 2),
            "qualifying": qualifying, "typical": round(typical_cases, 1)}


def _value_score(net_case: Optional[float], min_net: Optional[float],
                 adj_savings_pct: float, full_month: bool, compliant: bool) -> dict:
    """Net-cost-dominant 0-100 composite (#8/20). Net cost dominates so the
    score never contradicts the net-cost ranking. Weights are PRICE360_WEIGHTS."""
    w = PRICE360_WEIGHTS
    net = w["net_cost"] * (min_net / net_case) if (net_case and min_net) else 0.0
    sav = w["savings"] * max(0.0, min(1.0, adj_savings_pct / 25.0))
    stab = w["stability"] * (1.0 if full_month else 0.5)
    comp = w["compliance"] * (1.0 if compliant else 0.0)
    total = round(net + sav + stab + comp, 1)
    return {"score": min(100.0, total), "breakdown": {
        "net_cost": round(net, 1), "savings": round(sav, 1),
        "stability": round(stab, 1), "compliance": round(comp, 1),
        "weights": w}}


def _fetch_product_offers(con, src: str, match: str) -> tuple[Optional[str], list[dict]]:
    """Resolve `match` to the product identity carried by the MOST distributors,
    return (identity_key, one best row per distributor) — every offer is the
    same UPC + size, so directly comparable."""
    all_slugs = [r[0] for r in con.execute(f"SELECT DISTINCT wholesaler FROM {src}").fetchall()]
    eds = _editions_for(con, src, all_slugs)
    ed_pred, ed_params = _edition_pred(all_slugs, eds)
    m = (match or "").strip()
    digits = re.sub(r"\D", "", m)
    is_upc = len(digits) >= 8
    match_pred = "LTRIM(upc,'0') = ?" if is_upc else "lower(product_name) LIKE ?"
    match_param = digits.lstrip("0") if is_upc else f"%{m.lower()}%"
    # Resolve the text to UPCs first, then pull EVERY distributor carrying those
    # UPCs — the same barcode is often named differently per distributor (Allied
    # 'CAMPARI APERITIVO' vs Fedway 'CAMPARI BITTERS'), so a name-only filter
    # would silently drop offers. (No combo-code exclusion: a product's
    # standalone CPL price is a valid offer regardless of combo linkage, and a
    # blanket combo_code filter wrongly drops Allied/Shore-Point internal codes.)
    base = f"{ed_pred} AND {_VALID_UPC}"
    params = list(ed_params) + list(ed_params) + [match_param]
    vn = _pricing.vintage_norm_sql("vintage")
    df = con.execute(f"""
        SELECT wholesaler, edition, upc, product_name, product_type, brand,
               unit_qty, unit_volume, vintage, abv_proof,
               frontline_case_price, frontline_unit_price,
               best_case_price, best_unit_price, effective_case_price,
               rip_savings, has_discount, has_rip, rip_code, rip_windows,
               discount_1_qty, discount_1_amt, discount_2_qty, discount_2_amt,
               discount_3_qty, discount_3_amt, discount_4_qty, discount_4_amt,
               discount_5_qty, discount_5_amt,
               LTRIM(upc,'0') AS upc_norm, TRY_CAST(unit_qty AS DOUBLE) AS uqd,
               {vn} AS vintage_norm,
               UPPER(product_type) IN ('WINE','SPARKLING','VERMOUTH') AS vintage_sensitive
        FROM {src} e WHERE {base}
          AND LTRIM(upc,'0') IN (
              SELECT DISTINCT LTRIM(upc,'0') FROM {src}
              WHERE {base} AND {match_pred})
    """, params).df()
    recs = [_nan_clean(r) for r in df.to_dict(orient="records")]
    if not recs:
        return None, []
    for r in recs:
        r["match_key"] = "|".join([
            r["upc_norm"], _size_key(r.get("unit_volume")), _pack_norm(r.get("unit_qty")),
            (r.get("vintage_norm") or "") if r.get("vintage_sensitive") else ""])
    # identity carried by the most distributors
    by_key: dict[str, dict] = {}
    for r in recs:
        by_key.setdefault(r["match_key"], {})
        cur = by_key[r["match_key"]].get(r["wholesaler"])
        if cur is None or (r.get("effective_case_price") or 1e9) < (cur.get("effective_case_price") or 1e9):
            by_key[r["match_key"]][r["wholesaler"]] = r
    best_key = max(by_key, key=lambda k: len(by_key[k]))
    return best_key, list(by_key[best_key].values())


def price360_offers(con, match: str, typical_map: Optional[dict] = None,
                    reach_mode: str = "soft") -> dict:
    """The Price 360 label data: every wholesaler offer for one product, each
    reduced to a reachability-adjusted effective net cost, ranked cheapest
    first. Reuses pricing.attach_tiers; no pricing math re-implemented."""
    src = read_parquet(con, "cpl_enriched")
    key, recs = _fetch_product_offers(con, src, match)
    if not recs:
        return {"found": False, "match": match, "note": "No product matched a valid barcode."}
    _pricing.attach_tiers(con, recs)
    all_slugs = list({r["wholesaler"] for r in recs})
    eds = _editions_for(con, src, all_slugs)
    mix = _case_mix_sizes(con, src, all_slugs, eds)
    typical_map = typical_map or {}

    offers = []
    for rec in recs:
        w = rec["wholesaler"]
        pack = rec.get("uqd") or 1.0
        tiers = rec.get("tiers", []) or []
        invoice_case = rec.get("best_case_price")            # legal cost basis (discounts only)
        economic_case = rec.get("effective_case_price")      # after RIP rebates
        frontline_case = rec.get("frontline_case_price")
        rip_rebate = round(max(0.0, (invoice_case or 0) - (economic_case or 0)), 2) \
            if invoice_case is not None and economic_case is not None else 0.0
        qualifying = _min_cases_to_rip(tiers, pack)
        reach = _reachability(rip_rebate, qualifying,
                              typical_map.get(rec["upc_norm"]), reach_mode)
        # reachability-adjusted net: invoice minus the credited (reachable) rebate
        net_case = round((invoice_case if invoice_case is not None else frontline_case or 0)
                         - reach["credited_rebate"], 2)
        case_mix = _product_case_mix(rec, mix, w)
        comp = _compliance_flags(tiers, pack)
        full_month = any(t.get("source") == "rip" and t.get("window_status") in (None, "whole_month", "evergreen", "active")
                         and not t.get("is_time_sensitive") for t in tiers) or rip_rebate == 0
        sav_case = round((frontline_case or 0) - net_case, 2) if frontline_case else 0.0
        sav_pct = round(sav_case / frontline_case * 100, 1) if frontline_case else 0.0
        offers.append({
            "wholesaler": w, "edition": rec.get("edition"),
            "product_name": rec.get("product_name"), "upc": rec.get("upc"),
            "frontline_case": frontline_case,
            "frontline_btl": rec.get("frontline_unit_price"),
            "invoice_case": invoice_case,
            "invoice_btl": rec.get("best_unit_price"),
            "net_case": net_case, "net_btl": round(net_case / pack, 2) if pack else None,
            "rip_rebate_full": rip_rebate,
            "rip_rebate_credited": reach["credited_rebate"],
            "savings_case": sav_case, "savings_pct": sav_pct,
            "reachability": reach,
            "divergence": bool(economic_case is not None and invoice_case is not None
                               and economic_case < invoice_case - 0.005),
            "compliance": comp,
            "case_mix": case_mix, "single_sku": not (case_mix and case_mix > 1),
            "abv_proof": rec.get("abv_proof"),
            "unit_volume": rec.get("unit_volume"), "unit_qty": rec.get("unit_qty"),
            "qd_tiers": _p360_tier_rows(tiers, pack, "discount"),
            "rip_tiers": _p360_tier_rows(tiers, pack, "rip"),
            "full_month": bool(full_month),
            "_pack": pack,
        })

    # rank by reachability-adjusted net cost (authoritative)
    ranked = [o for o in offers if o["net_case"] is not None]
    min_net = min((o["net_case"] for o in ranked), default=None)
    max_rebate = max((o["rip_rebate_full"] for o in offers), default=0)
    for o in offers:
        sc = _value_score(o["net_case"], min_net, o["savings_pct"],
                          o["full_month"], not o["compliance"]["pre_approval"])
        o["value_score"] = sc["score"]
        o["score_breakdown"] = sc["breakdown"]
    offers.sort(key=lambda o: (o["net_case"] if o["net_case"] is not None else 1e9))
    for o in offers:
        nc = o["net_case"]
        # competition ranking: every offer tied at the lowest net cost is a
        # co-winner (rank 1) — identical offers are never arbitrarily ordered.
        o["rank"] = 1 + sum(1 for x in offers if x["net_case"] is not None
                            and nc is not None and x["net_case"] < nc - 0.005)
        o["is_winner"] = nc is not None and min_net is not None and abs(nc - min_net) < 0.005
        # "bigger rebate, costs more" (#11): biggest headline rebate yet a
        # STRICTLY higher net cost than the winner — the rebate misleads.
        o["rebate_misleads"] = bool(
            not o["is_winner"] and max_rebate > 0
            and o["rip_rebate_full"] >= max_rebate - 0.005
            and min_net is not None and nc is not None
            and nc > min_net + 0.005)
        o.pop("_pack", None)
    n_winners = sum(1 for o in offers if o["is_winner"])

    meta = recs[0]
    # Same UPC + size => directly comparable. A differing filed proof is a data
    # warning, not a different product, so it never blocks ranking (#4/5).
    proofs = {_norm_proof(o["abv_proof"]) for o in offers if _norm_proof(o["abv_proof"]) is not None}
    return {
        "found": True,
        "product": {
            "product_name": min((o["product_name"] for o in offers), key=len),
            "upc": meta.get("upc"), "unit_volume": meta.get("unit_volume"),
            "unit_qty": meta.get("unit_qty"), "abv_proof": meta.get("abv_proof"),
            "product_type": meta.get("product_type"), "brand": meta.get("brand"),
        },
        "comparability": "direct",
        "proof_warning": len(proofs) > 1,
        "reach_mode": reach_mode,
        "weights": PRICE360_WEIGHTS,
        "tie": n_winners > 1,
        "n_winners": n_winners,
        "offers": offers,
    }


def _typical_cases_map(user_id: int, upc_norms: list[str]) -> dict:
    """Median cases this retailer historically orders per UPC (for soft
    reachability). Empty when there's no order history."""
    if not user_id or not upc_norms:
        return {}
    try:
        from backend.pg import get_pg
        with get_pg() as pg:
            ph = ", ".join(["%s"] * len(upc_norms))
            rows = pg.execute(
                f"""SELECT LTRIM(ol.upc, '0') AS u, AVG(ol.qty_cases) AS avg_cs
                    FROM order_lines ol JOIN orders o ON o.id = ol.order_id
                    WHERE o.user_id = %s AND ol.qty_cases > 0
                      AND LTRIM(ol.upc, '0') IN ({ph})
                    GROUP BY 1""",
                (user_id, *upc_norms)).fetchall()
        return {dict(r)["u"]: float(dict(r)["avg_cs"]) for r in rows if dict(r)["avg_cs"]}
    except Exception:
        return {}


@router.get("/price360")
def price360(
    match: str = Query(..., description="Product name or UPC"),
    reach_mode: str = Query("soft", description="soft | hard | off (reachability)"),
    user: Optional[dict] = Depends(get_optional_user),
):
    """Price 360 label: every wholesaler's offer for ONE product, each reduced
    to a reachability-adjusted effective net cost (case + bottle), ranked
    cheapest first, with invoice vs economic cost kept separate, a fixed-weight
    value score, NJ-ABC pre-approval flags, and full layer traceability."""
    if reach_mode not in ("soft", "hard", "off"):
        reach_mode = "soft"
    with get_duckdb() as con:
        src = read_parquet(con, "cpl_enriched")
        key, recs = _fetch_product_offers(con, src, match)
        upc_norms = list({r["upc_norm"] for r in recs}) if recs else []
    typical = _typical_cases_map(user.get("id") if user else 0, upc_norms) if recs else {}
    with get_duckdb() as con:
        return price360_offers(con, match, typical, reach_mode)


# ===========================================================================
# Edition comparison — one distributor across two CPL periods, every diff
# expressed in Price 360 net-cost terms (not raw frontline).
# ===========================================================================

def _wholesaler_editions(con, src: str, w: str) -> list:
    rows = con.execute(
        f"SELECT DISTINCT edition FROM {src} WHERE wholesaler = ? ORDER BY edition DESC",
        [w]).fetchall()
    return [r[0] for r in rows]


def _edition_rows(con, src: str, w: str, ed: str) -> dict:
    """One best row per SKU identity for a (wholesaler, edition). Same-distributor
    spelling is stable, so the identity is built in SQL."""
    vn = _pricing.vintage_norm_sql("vintage")
    ident_sql = ("LTRIM(upc,'0') || '|' || COALESCE(unit_volume,'') || '|' "
                 "|| COALESCE(CAST(TRY_CAST(unit_qty AS DOUBLE) AS VARCHAR),'') || '|' "
                 f"|| COALESCE({vn},'')")
    df = con.execute(f"""
        SELECT upc, product_name, product_type, brand, unit_qty, unit_volume,
               vintage, abv_proof,
               frontline_case_price, frontline_unit_price,
               best_case_price, best_unit_price, effective_case_price,
               rip_savings, has_rip, has_discount, rip_code,
               LTRIM(upc,'0') AS upc_norm, TRY_CAST(unit_qty AS DOUBLE) AS uqd,
               {vn} AS vintage_norm, {ident_sql} AS ident
        FROM {src}
        WHERE wholesaler = ? AND edition = ? AND {_VALID_UPC}
        QUALIFY ROW_NUMBER() OVER (PARTITION BY {ident_sql}
            ORDER BY effective_case_price NULLS LAST) = 1
    """, [w, ed]).df()
    return {r["ident"]: _nan_clean(r) for r in df.to_dict(orient="records")}


def _layer_changes(a: dict, b: dict) -> list:
    """Which underlying layers moved between editions (B11)."""
    out = []

    def chg(k):
        return abs((a.get(k) or 0) - (b.get(k) or 0)) > 0.005

    if chg("frontline_case_price"):
        out.append("frontline")
    if chg("best_case_price"):
        out.append("discount")   # invoice (single-case / QD) moved
    if bool(a.get("has_rip")) != bool(b.get("has_rip")):
        out.append("rip_gained" if b.get("has_rip") else "rip_lost")
    elif chg("rip_savings"):
        out.append("rip_modified")
    return out


@router.get("/editions/options")
def edition_options(wholesaler: str = Query(...),
                    user: Optional[dict] = Depends(get_optional_user)):
    """Available CPL periods for a distributor + the default (latest two)."""
    with get_duckdb() as con:
        src = read_parquet(con, "cpl_enriched")
        eds = _wholesaler_editions(con, src, wholesaler)
    if not eds:
        raise HTTPException(404, f"No editions for {wholesaler}")
    return {
        "wholesaler": wholesaler, "editions": eds,
        "default_newer": eds[0],
        "default_older": eds[1] if len(eds) > 1 else None,
        "single_edition": len(eds) < 2,
    }


def edition_comparison(con, wholesaler: str, older: str = "", newer: str = "",
                       scope: str = "catalog", match: str = "", change: str = "",
                       sort: str = "net_delta", order: str = "desc",
                       limit: int = 3000) -> dict:
    """Core edition comparison (shared by the HTTP endpoint and the assistant
    tool). Compares one distributor across two editions; every diff is the
    change in effective NET cost, with the layer that moved + add/remove
    classification + a delta summary."""
    src = read_parquet(con, "cpl_enriched")
    eds = _wholesaler_editions(con, src, wholesaler)
    if not eds:
        return {"wholesaler": wholesaler, "error": f"No editions for {wholesaler}"}
    if len(eds) < 2:
        return {"wholesaler": wholesaler, "single_edition": True, "editions": eds,
                "note": f"{wholesaler} has only one edition ({eds[0]}) — nothing to compare."}
    nw = newer if newer in eds else eds[0]
    ol = older if older in eds else eds[1]
    if nw == ol:
        ol = next((e for e in eds if e != nw), ol)
    a = _edition_rows(con, src, wholesaler, ol)   # older
    b = _edition_rows(con, src, wholesaler, nw)   # newer

    m = (match or "").strip().lower()
    digits = re.sub(r"\D", "", m)
    is_upc = len(digits) >= 8

    def matches(rec):
        if not m:
            return True
        return (rec.get("upc_norm") == digits.lstrip("0")) if is_upc \
            else (m in (rec.get("product_name") or "").lower())

    rows = []
    summary = {"rose": 0, "fell": 0, "unchanged": 0, "added": 0, "removed": 0,
               "rip_changed": 0, "not_comparable": 0}
    for k in (set(a) | set(b)):
        ra, rb = a.get(k), b.get(k)
        ref = rb or ra
        if m and not matches(ref):
            continue
        pack = (ref.get("uqd") or 1.0)
        if ra and rb:
            comparable = (_norm_proof(ra.get("abv_proof")) == _norm_proof(rb.get("abv_proof"))
                          or _norm_proof(ra.get("abv_proof")) is None
                          or _norm_proof(rb.get("abv_proof")) is None)
            net_a, net_b = ra.get("effective_case_price"), rb.get("effective_case_price")
            delta = round((net_b or 0) - (net_a or 0), 2) if net_a is not None and net_b is not None else None
            pct = round(delta / net_a * 100, 1) if (delta is not None and net_a) else None
            layers = _layer_changes(ra, rb)
            if not comparable:
                summary["not_comparable"] += 1
            elif delta is None or abs(delta) < 0.005:
                summary["unchanged"] += 1
            elif delta > 0:
                summary["rose"] += 1
            else:
                summary["fell"] += 1
            if any(str(l).startswith("rip") for l in layers):
                summary["rip_changed"] += 1
            rows.append({
                "ident": k, "status": "both", "comparable": comparable,
                "product_name": ref.get("product_name"), "unit_volume": ref.get("unit_volume"),
                "unit_qty": ref.get("unit_qty"), "product_type": ref.get("product_type"),
                "upc": ref.get("upc"),
                "net_a_case": net_a, "net_b_case": net_b,
                "net_a_btl": round(net_a / pack, 2) if net_a and pack else None,
                "net_b_btl": round(net_b / pack, 2) if net_b and pack else None,
                "net_delta_case": delta, "net_delta_pct": pct,
                "net_delta_btl": round(delta / pack, 2) if delta is not None and pack else None,
                "frontline_a": ra.get("frontline_case_price"), "frontline_b": rb.get("frontline_case_price"),
                "invoice_a": ra.get("best_case_price"), "invoice_b": rb.get("best_case_price"),
                "rip_a": ra.get("rip_savings"), "rip_b": rb.get("rip_savings"),
                "layers": layers,
            })
        elif rb:
            summary["added"] += 1
            rows.append({"ident": k, "status": "added", "comparable": True,
                         "product_name": rb.get("product_name"), "unit_volume": rb.get("unit_volume"),
                         "unit_qty": rb.get("unit_qty"), "product_type": rb.get("product_type"),
                         "upc": rb.get("upc"), "net_b_case": rb.get("effective_case_price"),
                         "net_b_btl": round((rb.get("effective_case_price") or 0) / pack, 2) if pack else None,
                         "net_delta_case": None, "layers": []})
        else:
            summary["removed"] += 1
            rows.append({"ident": k, "status": "removed", "comparable": True,
                         "product_name": ra.get("product_name"), "unit_volume": ra.get("unit_volume"),
                         "unit_qty": ra.get("unit_qty"), "product_type": ra.get("product_type"),
                         "upc": ra.get("upc"), "net_a_case": ra.get("effective_case_price"),
                         "net_a_btl": round((ra.get("effective_case_price") or 0) / pack, 2) if pack else None,
                         "net_delta_case": None, "layers": []})

    total = len(rows)
    if change == "increase":
        rows = [r for r in rows if (r.get("net_delta_case") or 0) > 0]
    elif change == "decrease":
        rows = [r for r in rows if (r.get("net_delta_case") or 0) < 0]
    elif change == "added":
        rows = [r for r in rows if r["status"] == "added"]
    elif change == "removed":
        rows = [r for r in rows if r["status"] == "removed"]
    elif change == "rip":
        rows = [r for r in rows if any(str(l).startswith("rip") for l in r.get("layers", []))]
    elif change == "changed":
        rows = [r for r in rows if r["status"] != "both"
                or (r.get("net_delta_case") and abs(r["net_delta_case"]) >= 0.005)]

    keyf = {
        "net_delta": lambda r: r.get("net_delta_case") if r.get("net_delta_case") is not None else 0,
        "net_delta_pct": lambda r: r.get("net_delta_pct") or 0,
        "product": lambda r: (r.get("product_name") or "").lower(),
    }
    rows.sort(key=keyf.get(sort, keyf["net_delta"]),
              reverse=(order != "asc") if sort != "product" else (order == "desc"))
    rows = rows[:limit]

    return {
        "wholesaler": wholesaler, "single_edition": False,
        "older": ol, "newer": nw, "editions": eds, "scope": scope,
        "total": total, "summary": summary, "rows": rows,
    }


@router.get("/editions")
def compare_editions(
    wholesaler: str = Query(...),
    older: str = Query(""),
    newer: str = Query(""),
    scope: str = Query("catalog", description="catalog | product"),
    match: str = Query(""),
    change: str = Query("", description="all|increase|decrease|added|removed|rip|changed"),
    sort: str = Query("net_delta", description="net_delta | net_delta_pct | product"),
    order: str = Query("desc"),
    limit: int = Query(3000, ge=1, le=50000),
    user: Optional[dict] = Depends(get_optional_user),
):
    """Compare one distributor across two editions; every diff is the change in
    effective NET cost (case + bottle, $ + %), which layer moved, with
    added/removed classification and a delta summary."""
    with get_duckdb() as con:
        return edition_comparison(con, wholesaler, older, newer, scope, match,
                                  change, sort, order, limit)
