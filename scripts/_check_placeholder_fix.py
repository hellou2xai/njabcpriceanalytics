"""Sanity checks for the placeholder-barcode serving fix (temp script)."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import duckdb

from backend.routers.catalog import _is_clean_upc, _VALID_UPC_SQL

cases = {
    "111111111117": False,   # Allied repeated-digit fake
    "999999999993": False,   # Fedway sentinel
    "111111111111": False,   # all-same
    "0": False,
    "": False,
    "80686021834": True,     # real Jim Beam Orange PET
    "080686021834": True,    # leading zero
    "739958057209": True,    # Coppola reused barcode (real GTIN)
    "5901": False,           # too short
    "123456789012": True,
}
ok = True
for upc, want in cases.items():
    got = _is_clean_upc(upc)
    mark = "ok" if got == want else "FAIL"
    if got != want:
        ok = False
    print(f"  py  {mark}  {upc!r}: {got} (want {want})")

con = duckdb.connect()
pred = _VALID_UPC_SQL.format(col="v")
for upc, want in cases.items():
    got = bool(con.execute(
        f"SELECT {pred} FROM (SELECT CAST($u AS VARCHAR) AS v)", {"u": upc}
    ).fetchone()[0])
    mark = "ok" if got == want else "FAIL"
    if got != want:
        ok = False
    print(f"  sql {mark}  {upc!r}: {got} (want {want})")

print("ALL OK" if ok else "FAILURES PRESENT")
sys.exit(0 if ok else 1)
