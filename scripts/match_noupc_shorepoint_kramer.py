"""Semantic-ish name matching: Shore Point blank-UPC lines vs Kramer catalog.

Shore Point truncates words (YUENG = Yuengling, HON CRISP = Honeycrisp,
OBRN SHND = Oberon Shandy), so matching is prefix-aware token matching,
not plain edit distance. Size compatibility gates the final candidates:
keg fractions (1/2, 1/4, 1/6 BBL <-> 15.5 / 7.75 / 5.16 GAL) and
package volume (355ML ~ 12OZ, 473ML ~ 16OZ).

Run:  python scripts/match_noupc_shorepoint_kramer.py
Output: prints scored candidates; writes scripts/noupc_match_candidates.csv
"""
import re
import sys
from pathlib import Path

import duckdb
import pandas as pd

PROJECT = Path(__file__).resolve().parents[1]
ENRICHED = PROJECT / "parquet_output" / "derived" / "cpl_enriched.parquet"

# Tokens that describe packaging, not the product
PACK_TOKENS = {
    "NR", "CN", "CAN", "CANS", "BT", "BTL", "BTLS", "BOTTLE", "BOTTLES",
    "KEG", "BBL", "LTR", "L", "ML", "OZ", "GAL", "PK", "PACK", "BAG",
    "SLIM", "LOOSE", "VP", "10M", "5M",
}
# Shore Point truncation expansions that prefix-matching alone can't bridge
EXPAND = {
    "HER": "HERSHEY",
    "PORT": "PORTER",
    "OKTOFEST": "OKTOBERFEST",
    "1/2&1/2": "HALF AND HALF",
    "ISL": "ISLAND",
}


def norm_tokens(name: str) -> list[str]:
    s = str(name).upper()
    s = re.sub(r"\d+/\d+", " ", s)          # pack fractions 4/6, 2/12, 1/750ML, 1/2 BBL
    s = re.sub(r"\d+(\.\d+)?\s*(OZ|ML|LTR|L|GAL)\b", " ", s)
    s = re.sub(r"[^A-Z0-9&/]+", " ", s)
    toks = []
    for t in s.split():
        if t in PACK_TOKENS or t.isdigit():
            continue
        t = EXPAND.get(t, t)
        toks.extend(t.split())
    return toks


def tok_sim(a: str, b: str) -> float:
    """Prefix-aware token similarity: 1.0 on prefix containment (len>=3)."""
    if a == b:
        return 1.0
    if len(a) >= 3 and len(b) >= 3 and (b.startswith(a) or a.startswith(b)):
        return 0.95
    # last resort: short edit similarity for typo-level drift (WATERMELO)
    from rapidfuzz.distance import JaroWinkler
    jw = JaroWinkler.similarity(a, b)
    return jw if jw >= 0.88 else 0.0


def name_score(sp_toks: list[str], kr_toks: list[str]) -> float:
    """Mean of each SP token's best match in Kramer tokens, penalised when
    Kramer has many unmatched tokens (prevents brand-only matches)."""
    if not sp_toks or not kr_toks:
        return 0.0
    fwd = sum(max(tok_sim(t, k) for k in kr_toks) for t in sp_toks) / len(sp_toks)
    bwd = sum(max(tok_sim(k, t) for t in sp_toks) for k in kr_toks) / len(kr_toks)
    return 0.65 * fwd + 0.35 * bwd


KEG_GAL = {"15.5": "1/2", "7.75": "1/4", "5.16": "1/6", "13.2": "EURO 1/2"}


def size_key(unit_type, unit_qty, unit_volume, name):
    """Coarse size signature for compatibility gating."""
    ut = str(unit_type or "").upper()
    vol = str(unit_volume or "").upper().replace(" ", "")
    nm = str(name).upper()
    if "KEG" in ut or "BBL" in nm or "GAL" in vol:
        m = re.search(r"(\d+(?:\.\d+)?)GAL", vol)
        if m:
            return ("KEG", KEG_GAL.get(m.group(1), m.group(1)))
        m = re.search(r"(1/[246])\s*BBL", nm)
        return ("KEG", m.group(1) if m else "?")
    # normalise volume to ml
    ml = None
    m = re.search(r"(\d+(?:\.\d+)?)ML", vol)
    if m:
        ml = float(m.group(1))
    else:
        m = re.search(r"(\d+(?:\.\d+)?)L", vol)
        if m:
            ml = float(m.group(1)) * 1000
        else:
            m = re.search(r"(\d+(?:\.\d+)?)OZ", vol)
            if m:
                ml = float(m.group(1)) * 29.5735
    qty = None
    try:
        qty = int(float(str(unit_qty)))
    except (TypeError, ValueError):
        pass
    return ("PKG", qty, round(ml / 10) * 10 if ml else None)


def size_compatible(a, b) -> bool:
    if a[0] != b[0]:
        return False
    if a[0] == "KEG":
        return a[1] == b[1]
    _, qa, va = a
    _, qb, vb = b
    vol_ok = va is None or vb is None or abs(va - vb) <= 30
    qty_ok = qa is None or qb is None or qa == qb
    return vol_ok and qty_ok


def main():
    con = duckdb.connect()
    sp = con.sql(f"""
        SELECT product_name, unit_type, unit_qty, unit_volume, product_type,
               frontline_case_price, effective_case_price
        FROM '{ENRICHED.as_posix()}'
        WHERE wholesaler='shore_point' AND (upc IS NULL OR TRIM(upc)='')
    """).df()
    kr = con.sql(f"""
        SELECT product_name, upc, unit_type, unit_qty, unit_volume, product_type,
               frontline_case_price, effective_case_price
        FROM '{ENRICHED.as_posix()}'
        WHERE wholesaler='kramer'
    """).df()

    kr["toks"] = kr["product_name"].map(norm_tokens)
    kr["skey"] = kr.apply(lambda r: size_key(r.unit_type, r.unit_qty, r.unit_volume, r.product_name), axis=1)

    rows = []
    for _, s in sp.iterrows():
        st = norm_tokens(s.product_name)
        sk = size_key(s.unit_type, s.unit_qty, s.unit_volume, s.product_name)
        best = []
        for _, k in kr.iterrows():
            sc = name_score(st, k.toks)
            if sc >= 0.55:
                best.append((sc, k))
        best.sort(key=lambda x: -x[0])
        for sc, k in best[:3]:
            rows.append({
                "sp_name": s.product_name, "kr_name": k.product_name,
                "score": round(sc, 3),
                "size_ok": size_compatible(sk, k.skey),
                "sp_size": f"{s.unit_qty}x{s.unit_volume}({s.unit_type})",
                "kr_size": f"{k.unit_qty}x{k.unit_volume}({k.unit_type})",
                "sp_type": s.product_type, "kr_type": k.product_type,
                "kr_upc": k.upc,
                "sp_case": s.frontline_case_price, "kr_case": k.frontline_case_price,
            })

    out = pd.DataFrame(rows).sort_values(["score"], ascending=False)
    csv_path = PROJECT / "scripts" / "noupc_match_candidates.csv"
    out.to_csv(csv_path, index=False)
    strong = out[(out.score >= 0.80) & out.size_ok]
    print(f"SP blank-UPC lines: {len(sp)} | Kramer lines: {len(kr)}")
    print(f"candidate pairs (score>=0.55): {len(out)} -> {csv_path.name}")
    print(f"strong (score>=0.80 AND size match): {len(strong)}")
    print(strong.to_string(index=False, max_colwidth=34))
    mid = out[(out.score >= 0.66) & (out.score < 0.80) & out.size_ok]
    print(f"\nreview band (0.66-0.80, size match): {len(mid)}")
    print(mid.to_string(index=False, max_colwidth=34))


if __name__ == "__main__":
    sys.exit(main())
