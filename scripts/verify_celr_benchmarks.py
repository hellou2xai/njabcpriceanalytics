"""CELR grouping benchmarks — run after every monthly load (monthly_load.py
calls this). The three cases that caught every past grouping regression:

  1. Jim Beam Orange  -> ONE family, incl. the placeholder-barcode rows
  2. Glenlivet Founders Reserve -> ONE family across Allied + Fedway
  3. Coppola Diamond Chardonnay vs Pinot Noir -> SEPARATE families

Usage: python scripts/verify_celr_benchmarks.py [2026-07]
Exit 0 = all pass.
"""
from __future__ import annotations

import sys
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.celr import family_key, is_registry_upc  # noqa: E402

P = (ROOT / "parquet_output").as_posix()


def main() -> None:
    con = duckdb.connect()
    cpl = f"read_parquet('{P}/derived/cpl_enriched.parquet')"
    edition = (sys.argv[1] if len(sys.argv) > 1 else
               con.execute(f"SELECT MAX(edition) FROM {cpl}").fetchone()[0])

    upc_map = {r[0]: int(r[1]) for r in con.execute(
        f"SELECT upc_norm, cpn FROM read_parquet('{P}/derived/celr_products.parquet')").fetchall()}
    key_map = {r[0]: int(r[1]) for r in con.execute(
        f"SELECT key, cpn FROM read_parquet('{P}/derived/celr_family_keys.parquet')").fetchall()}

    def groups_for(like: str) -> dict[int | str, list[str]]:
        rows = con.execute(f"""
            SELECT product_name, product_type, LTRIM(CAST(upc AS VARCHAR), '0')
            FROM {cpl}
            WHERE edition = '{edition}' AND UPPER(product_name) LIKE '{like}'
        """).fetchall()
        out: dict = {}
        for name, ptype, un in rows:
            cpn = upc_map.get(un) if is_registry_upc(un or "") else None
            if cpn is None:
                cpn = key_map.get(family_key(name or "", ptype or ""),
                                  f"name:{name}")
            out.setdefault(cpn, []).append(name)
        return out

    failures = []

    jb = groups_for("%JIM BEAM ORANGE%")
    print(f"[{edition}] Jim Beam Orange: {sum(len(v) for v in jb.values())} "
          f"listings in {len(jb)} family(ies)")
    if len(jb) != 1:
        failures.append(f"Jim Beam Orange split into {len(jb)} families: "
                        + "; ".join(str(k) for k in jb))

    gl = groups_for("%GLENLIVET FOUND%")
    print(f"[{edition}] Glenlivet Founders: {sum(len(v) for v in gl.values())} "
          f"listings in {len(gl)} family(ies)")
    if len(gl) != 1:
        failures.append(f"Glenlivet Founders split into {len(gl)} families")

    ch = set(groups_for("%COPPOLA DMD CHARD%"))
    pn = set(groups_for("%COPPOLA DMD PN%")) | set(groups_for("%COPPOLA DMD ROSE%"))
    overlap = ch & pn
    print(f"[{edition}] Coppola DMD Chard families {sorted(map(str, ch))} vs "
          f"PN/Rose families {sorted(map(str, pn))} — overlap: {len(overlap)}")
    if overlap:
        failures.append(f"Coppola varietals share families: {overlap}")

    if failures:
        print("\nBENCHMARKS FAILED:")
        for f in failures:
            print(" -", f)
        sys.exit(1)
    print("\nALL CELR BENCHMARKS PASS")


if __name__ == "__main__":
    main()
