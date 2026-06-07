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
               unit_qty, unit_volume, vintage,
               frontline_case_price, frontline_unit_price,
               best_case_price, best_unit_price,
               effective_case_price, rip_savings, total_savings_per_case,
               has_discount, has_rip, rip_code,
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
            "frontline": rec.get("frontline_case_price"),
            "after_qd": rec.get("best_case_price"),
            "effective": rec.get("effective_case_price"),
            "tiers": rec.get("tiers", []),
        }
    return {"wholesalers": slugs, "ladders": out}
