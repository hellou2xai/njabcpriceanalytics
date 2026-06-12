"""Validate nj_abc_parser.rip_rules against known ground-truth cases."""
import sys
from pathlib import Path

import duckdb
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from nj_abc_parser.rip_rules import compute_rip_credits  # noqa: E402

con = duckdb.connect()
rip = con.sql("""
    SELECT * FROM read_parquet('parquet_output/rip/**/*.parquet',
                               hive_partitioning=1, union_by_name=1)
    WHERE wholesaler IN ('fedway','allied') AND edition='2026-06'
""").df()
cpl = con.sql("""
    SELECT wholesaler, edition, upc, product_name, unit_volume, unit_qty
    FROM read_parquet('parquet_output/cpl/**/*.parquet',
                      hive_partitioning=1, union_by_name=1)
    WHERE wholesaler IN ('fedway','allied') AND edition='2026-06'
""").df()

credits = compute_rip_credits(rip, cpl)
print("credit rows:", len(credits))
print(credits.groupby(["wholesaler", "case_credit"]).size().to_string())
print("\nsplit-allowance rows:", int(credits["split_pack"].notna().sum()))
print("\nmethods:")
print(credits.groupby("method").size().to_string())

# ---- ground truth checks
def check(label, cond):
    print(("PASS  " if cond else "FAIL  ") + label)

dq = credits[(credits.rip_code == "100417")]
check("Don Q 100417: 1.75L SKUs credit 1.0 + split_pack 3",
      len(dq) == 2 and (dq.case_credit == 1.0).all()
      and (dq.split_pack == 3).all() and (dq.split_credit == 0.5).all())

gm = credits[(credits.rip_code == "102519") & (credits.upc == "649188900469")]
check("Grand Marnier 375x12: credit 0.5",
      len(gm) == 1 and gm.iloc[0].case_credit == 0.5)

mg = credits[credits.rip_code == "101447"]
check("Magellan VAPS rule: NO rows (no VAP member)", len(mg) == 0)

baks = credits[(credits.wholesaler == "fedway")
               & (credits.rule_kind == "counts_as_more")]
check("Bak's counts-as-more: credit 2.0",
      len(baks) > 0 and (baks.case_credit == 2.0).all())

# a 750ML member must never carry a credit from a 375ML-only rule
cpl_idx = cpl.copy()
cpl_idx["upc_n"] = cpl_idx["upc"].astype(str).str.lstrip("0")
sizes = dict(zip(zip(cpl_idx.wholesaler, cpl_idx.upc_n), cpl_idx.unit_volume))
bad = [r for _, r in credits.iterrows()
       if "375ML" in str(r.rule_excerpt) and "750" not in str(r.rule_excerpt)
       and "&" not in str(r.rule_excerpt) and "PK" not in str(r.rule_excerpt)
       and str(sizes.get((r.wholesaler, r.upc), "")).upper() == "750ML"
       and r.split_pack is None and not pd.isna(r.case_credit)
       and r.case_credit < 1.0]
check(f"no 750ML rows tagged by pure-375ML rules ({len(bad)} found)",
      len(bad) == 0)
if bad:
    for r in bad[:5]:
        print("   ", r.rip_code, r.upc, r.rule_excerpt)
