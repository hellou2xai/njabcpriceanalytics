#!/usr/bin/env python
"""
Agentic QA scan — CLI for CI.

Runs the deterministic variance scanner (backend.services.qa_engine.run_scan),
prints a plain-ASCII report grouped by root cause, and exits non-zero if any
'high'-severity finding exists so CI can gate on it.

Usage:
    python qa_scan.py [--threshold 0.05] [--wholesaler allied]
                      [--check edition_price_moves] [--limit 200]

Exit codes:
    0  no high-severity findings
    1  at least one high-severity finding (CI should fail)
"""

import argparse
import sys
from pathlib import Path

# Make the project root importable when run from anywhere.
sys.path.insert(0, str(Path(__file__).resolve().parent))

# Avoid Windows cp1252 crashes on any stray non-ASCII output.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

from backend.services.qa_engine import run_scan, VARIANCE_THRESHOLD, ALL_CHECKS


SEP = "=" * 78
SUB = "-" * 78


def _fmt_pct(v):
    if v is None:
        return "n/a"
    return f"{v * 100:+.1f}%"


def _print_report(result: dict, examples_per_cause: int = 3) -> None:
    s = result["summary"]
    print(SEP)
    print("AGENTIC QA VARIANCE SCAN")
    print(SEP)
    print(f"Generated:   {result['generated_at']}")
    print(f"Threshold:   {result['threshold'] * 100:.1f}%")
    print(f"Wholesaler:  {result['wholesaler'] or 'ALL'}")
    print(f"Checks run:  {', '.join(result['checks_run'])}")
    print(SUB)
    print(f"Total findings: {s['total']}")
    sev = s["by_severity"]
    print(f"  Severity:  high={sev.get('high', 0)}  "
          f"medium={sev.get('medium', 0)}  low={sev.get('low', 0)}")
    print("  By check:")
    for ck, n in sorted(s["by_check"].items(), key=lambda kv: -kv[1]):
        print(f"    {ck:<26} {n}")
    print(SEP)

    # Group findings by root_cause for the detail section.
    by_cause = {}
    for f in result["findings"]:
        by_cause.setdefault(f["root_cause"], []).append(f)

    print("FINDINGS BY ROOT CAUSE")
    print(SEP)
    if not by_cause:
        print("  (no findings above threshold)")
    for cause, items in sorted(by_cause.items(), key=lambda kv: -len(kv[1])):
        # Severity breakdown for this cause
        c_sev = {"high": 0, "medium": 0, "low": 0}
        for it in items:
            c_sev[it["severity"]] = c_sev.get(it["severity"], 0) + 1
        print(f"\n[{cause}]  count={len(items)}  "
              f"(high={c_sev['high']} medium={c_sev['medium']} low={c_sev['low']})")
        # Suggested fix is constant per cause — print once.
        print(f"  FIX: {items[0]['suggested_fix']}")
        print(f"  Examples (up to {examples_per_cause}):")
        for it in items[:examples_per_cause]:
            name = (it.get("product_name") or "?")[:48]
            print(f"    - [{it['severity'].upper():<6}] {it['wholesaler']} | "
                  f"{name} | {it.get('unit_volume') or '-'} | "
                  f"upc={it.get('upc') or '-'} | var={_fmt_pct(it.get('variance_pct'))}")
            print(f"        why: {it['root_cause_detail']}")
    print()
    print(SEP)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Agentic QA variance scan (CI gate on high-severity findings)."
    )
    parser.add_argument("--threshold", type=float, default=VARIANCE_THRESHOLD,
                        help="Variance threshold as a fraction (default 0.05 = 5%%).")
    parser.add_argument("--wholesaler", type=str, default=None,
                        help="Restrict to one distributor slug (e.g. allied).")
    parser.add_argument("--check", action="append", default=None,
                        choices=list(ALL_CHECKS),
                        help="Detector(s) to run; repeatable. Default: all.")
    parser.add_argument("--limit", type=int, default=200,
                        help="Max rows per detector (default 200).")
    args = parser.parse_args()

    result = run_scan(
        threshold=args.threshold,
        wholesaler=args.wholesaler,
        checks=args.check,
        limit_per_check=args.limit,
    )
    _print_report(result)

    high = result["summary"]["by_severity"].get("high", 0)
    if high > 0:
        print(f"RESULT: FAIL - {high} high-severity finding(s) require attention.")
        return 1
    print("RESULT: PASS - no high-severity findings.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
