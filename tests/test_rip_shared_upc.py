"""
Regression: a RIP must NOT leak onto a different SKU that merely shares a barcode.

Bug (prod): UPC 080432400395 is reused by two distinct Allied SKUs —
  - CHIVAS REGAL 12YR (12-pack, carries RIP 112112), and
  - CHIVAS GOYA 3P    (3-pack,  carries NO rip_code).
The tier ladder attached RIP 112112's rebates ($60/$150/$480, sized for the
12-bottle case) to the 3-pack's $93.27 list, quoting an impossible
$33.27/case ($11.09/bottle). Root cause: the single-vs-multi listing gate read
the raw `cpl` table and FAILED OPEN (treated the barcode as single-listing when
the lookup failed/was unavailable on prod), so the broad UPC-wide RIP pull fired.

The fix (FOUNDATION 3.4.2): the listing count is read from `cpl_enriched` and
FAILS CLOSED, and a code applies to a SKU only when the UPC is single-listing OR
the SKU's own CPL row carries that code — on EVERY surface.

This test exercises `pricing.attach_tiers` directly (no server needed) and
asserts:
  1. CHIVAS GOYA 3P (shared barcode, no own RIP)  -> 0 RIP tiers.
  2. CHIVAS REGAL 12YR (owns RIP 112112)          -> RIP tiers present.
  3. A genuine single-listing RIP product         -> still gets its RIP tiers
     (the fix must not over-correct and strip legitimate rebates).

Run:  python tests/test_rip_shared_upc.py
"""
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
os.environ.setdefault("PRICING_SOURCE", "parquet")

from backend.db import get_duckdb, read_parquet   # noqa: E402
from backend import pricing                        # noqa: E402

GOYA_UPC = "80432400395"
WS = "allied"


def _rip_tiers(rec) -> list:
    return [t for t in (rec.get("tiers") or []) if t.get("source") == "rip"]


def main() -> int:
    failures: list[str] = []
    with get_duckdb() as con:
        e = read_parquet(con, "cpl_enriched")
        ed = con.execute(
            f"SELECT MAX(edition) FROM {e} WHERE wholesaler = $w AND edition <= '2026-06'",
            {"w": WS},
        ).fetchone()[0]
        if not ed:
            print("SKIP — no Allied edition <= 2026-06 in the local parquet")
            return 0

        # ---- 1 + 2. Shared-barcode GOYA case ----
        recs = con.execute(
            f"""SELECT * FROM {e}
                WHERE wholesaler = $w AND edition = $ed
                  AND LTRIM(CAST(upc AS VARCHAR), '0') = $u""",
            {"w": WS, "ed": ed, "u": GOYA_UPC},
        ).fetchdf().to_dict("records")
        names = {str(r.get("product_name")) for r in recs}
        if not any("GOYA" in n for n in names) or not any("REG" in n for n in names):
            print(f"SKIP — expected both GOYA + REG on {GOYA_UPC}; found {sorted(names)}")
            return 0

        pricing.attach_tiers(con, recs, ref_date="2026-06-18")
        for r in recs:
            n = len(_rip_tiers(r))
            name = str(r.get("product_name"))
            if "GOYA" in name:
                if n != 0:
                    failures.append(f"GOYA 3P leaked {n} RIP tier(s) via shared barcode (expected 0)")
                print(f"[1] {name:16} own_rip={r.get('rip_code')} rip_tiers={n} (want 0)")
            elif "REG" in name:
                if n == 0:
                    failures.append("CHIVAS REG 12Y lost its own RIP 112112 (expected >0)")
                print(f"[2] {name:16} own_rip={r.get('rip_code')} rip_tiers={n} (want >0)")

        # ---- 3. A genuine single-listing RIP product still gets its tiers ----
        row = con.execute(
            f"""
            WITH lc AS (
              SELECT wholesaler, edition, LTRIM(CAST(upc AS VARCHAR), '0') AS un,
                     COUNT(DISTINCT (product_name, COALESCE(unit_volume, ''),
                           COALESCE(CAST(vintage AS VARCHAR), ''),
                           COALESCE(regexp_replace(TRIM(CAST(unit_qty AS VARCHAR)), '\\.0+$', ''), ''))) AS n
              FROM {e} WHERE edition = $ed GROUP BY 1, 2, 3)
            SELECT c.wholesaler, c.product_name
            FROM {e} c
            JOIN lc ON lc.wholesaler = c.wholesaler AND lc.edition = c.edition
                   AND lc.un = LTRIM(CAST(c.upc AS VARCHAR), '0')
            WHERE c.edition = $ed AND c.has_rip = true AND lc.n = 1
              AND c.rip_code IS NOT NULL AND CAST(c.rip_code AS VARCHAR) NOT IN ('', '0', 'None', 'nan')
            LIMIT 1
            """,
            {"ed": ed},
        ).fetchdf()
        if len(row):
            nm = row.iloc[0]["product_name"]
            recs2 = con.execute(
                f"SELECT * FROM {e} WHERE wholesaler = $w AND product_name = $n AND edition = $ed",
                {"w": row.iloc[0]["wholesaler"], "n": nm, "ed": ed},
            ).fetchdf().to_dict("records")
            pricing.attach_tiers(con, recs2, ref_date="2026-06-18")
            n = max((len(_rip_tiers(r)) for r in recs2), default=0)
            if n == 0:
                failures.append(f"single-listing RIP product '{nm}' lost its tiers (over-correction)")
            print(f"[3] {str(nm)[:24]:24} (single-listing) rip_tiers={n} (want >0)")
        else:
            print("[3] SKIP — no single-listing RIP product in this edition")

    print("\n========== RESULT ==========")
    if failures:
        print(f"FAIL — {len(failures)} issue(s):")
        for f in failures:
            print("  -", f)
        return 1
    print("PASS — RIP stays with the SKU that owns it; no shared-barcode leak.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
