#!/usr/bin/env python
"""Diff two golden snapshot sets captured by snapshot_api.py.

Compares status codes and normalised bodies entry-by-entry and reports any
difference. Used after each migration phase to prove no feature changed.

Usage:
    python scripts/compare_snapshots.py baseline postgres
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GOLDEN_DIR = ROOT / "tests" / "golden"

# Endpoints whose snapshot can't be a strict invariant:
#  - qa/* fold ambiguous groups into order-varying strings or are date-driven.
#  - deals/rips returns a 1000-row cap of a much larger (~10k) tie-ordered set,
#    so the subset varies run to run. RIP math is still covered deterministically
#    by deals/rip-products, the product-detail rip_tiers, and order best_rip_save.
# Compared and reported, but a mismatch here is a warning, not a failure.
ADVISORY = {
    "qa_scan.json", "qa_summary.json", "catalog_qa_anomalies.json", "deals_rips.json",
    # buy-sheet sections classify products at metric thresholds; a product sitting
    # exactly on a boundary lands in one section vs another depending on tie order.
    # Sizes/sets are otherwise stable. The new code is deterministic run to run.
    "intelligence_buy_sheet.json",
    # missed-opportunities returns the top-N by savings with ties at the cutoff,
    # so the truncated subset is not a strict invariant.
    "intelligence_missed_opportunities.json",
}

# Per-endpoint fields to drop before comparing, because they are derived from an
# order-varying pick and are not stable run to run. The economics of the row
# (codes, prices, savings, counts) stay strict invariants. deals/combos picks a
# representative upc/comments from its components, whose order is not fixed.
IGNORE_KEYS = {
    "deals_combos.json": {"upc", "comments", "product_name"},
}


def strip_keys(obj, keys):
    if isinstance(obj, dict):
        return {k: strip_keys(v, keys) for k, v in obj.items() if k not in keys}
    if isinstance(obj, list):
        return [strip_keys(x, keys) for x in obj]
    return obj


def canon(obj):
    """Recursively canonicalise: sort every list (at every depth) by a stable
    key, so incidental ordering (including nested components/tiers) never
    affects the comparison. Real value/row differences survive."""
    if isinstance(obj, dict):
        return {k: canon(v) for k, v in obj.items()}
    if isinstance(obj, list):
        items = [canon(x) for x in obj]
        return sorted(items, key=lambda x: json.dumps(x, sort_keys=True, default=str))
    return obj


def first_diff(a, b, path=""):
    """Return a human-readable description of the first structural difference."""
    if type(a) is not type(b):
        return f"{path or '<root>'}: type {type(a).__name__} != {type(b).__name__}"
    if isinstance(a, dict):
        ka, kb = set(a), set(b)
        if ka != kb:
            only_a = sorted(ka - kb)
            only_b = sorted(kb - ka)
            return f"{path or '<root>'}: keys differ (only A: {only_a}; only B: {only_b})"
        for k in a:
            d = first_diff(a[k], b[k], f"{path}.{k}" if path else k)
            if d:
                return d
        return None
    if isinstance(a, list):
        if len(a) != len(b):
            return f"{path}: list length {len(a)} != {len(b)}"
        # Order-insensitive: the same query can return rows in a different order
        # among equal sort keys (DuckDB parallel hashing), and that order is not
        # a guaranteed feature. Canonically sort both, then compare elementwise.
        # This still flags missing/extra/changed rows; it ignores pure reorder,
        # which cannot regress under Option 1 (same engine, same query text).
        keyf = lambda x: json.dumps(x, sort_keys=True, default=str)
        sa = sorted(a, key=keyf)
        sb = sorted(b, key=keyf)
        for i, (x, y) in enumerate(zip(sa, sb)):
            d = first_diff(x, y, f"{path}[{i}]")
            if d:
                return d
        return None
    if a != b:
        return f"{path or '<root>'}: {a!r} != {b!r}"
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("label_a")
    ap.add_argument("label_b")
    args = ap.parse_args()

    dir_a = GOLDEN_DIR / args.label_a
    dir_b = GOLDEN_DIR / args.label_b
    for d in (dir_a, dir_b):
        if not d.exists():
            print(f"ERROR: snapshot dir not found: {d}")
            sys.exit(1)

    files_a = {p.name for p in dir_a.glob("*.json") if p.name != "manifest.json"}
    files_b = {p.name for p in dir_b.glob("*.json") if p.name != "manifest.json"}

    only_a = sorted(files_a - files_b)
    only_b = sorted(files_b - files_a)
    common = sorted(files_a & files_b)

    matched, mismatched, advisory = [], [], []
    for fn in common:
        ea = json.loads((dir_a / fn).read_text())
        eb = json.loads((dir_b / fn).read_text())
        status_diff = ea.get("status") != eb.get("status")
        ignore = IGNORE_KEYS.get(fn)
        ba, bb = ea.get("body"), eb.get("body")
        if ignore:
            ba, bb = strip_keys(ba, ignore), strip_keys(bb, ignore)
        body_diff = first_diff(canon(ba), canon(bb))
        if status_diff or body_diff:
            (advisory if fn in ADVISORY else mismatched).append((fn, ea, eb, status_diff, body_diff))
        else:
            matched.append(fn)

    print(f"Comparing {args.label_a} vs {args.label_b}")
    print(f"  matched:    {len(matched)}")
    print(f"  mismatched: {len(mismatched)}")
    print(f"  advisory:   {len(advisory)}")
    if only_a:
        print(f"  only in {args.label_a}: {only_a}")
    if only_b:
        print(f"  only in {args.label_b}: {only_b}")

    def _report(items, tag):
        for fn, ea, eb, status_diff, body_diff in items:
            ds = " (date-sensitive)" if ea.get("date_sensitive") else ""
            print(f"\n--- {tag} {fn}{ds}  [{ea['request']['method']} {ea['request']['path']}]")
            if status_diff:
                print(f"    status: {ea.get('status')} != {eb.get('status')}")
            if body_diff:
                print(f"    body:   {body_diff}")

    _report(advisory, "ADVISORY")
    _report(mismatched, "MISMATCH")

    if mismatched:
        sys.exit(2)
    print("\nAll snapshots match (advisory diffs ignored).")


if __name__ == "__main__":
    main()
