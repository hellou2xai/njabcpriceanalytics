"""Size standardization.

`unit_volume` in the source data is a free-text per-container size that arrives
in many shapes: millilitres ("750ML"), litres ("1.5L", "LITER", "3LIT"),
ounces for beer/RTD cans ("12OZ"), ounces that are really a wine/spirit bottle
("25.33OZ" == 750ML), and ounces/gallons for kegs ("1984oz" == 1/2 BBL). That
left the catalog Size filter with ~180 noisy, duplicated, and unusable values.

`standardize_size` collapses each raw value to one canonical bucket so the Size
filter groups by real physical size and actually filters. The mapping is built
by converting to millilitres and snapping to a fixed canonical table, with a
separate whitelist for beer/RTD ounce cans (which are natively sold in oz) and
a single "Keg / Bulk" bucket for >=15 L formats. Anything unparseable ("ASST")
or far from every canonical falls into "Other".

The catalog builds a (raw -> canonical) lookup table from the distinct values
actually present, so new months that introduce new spellings still normalize.
"""
from __future__ import annotations

import re

# Canonical bottle/can sizes in millilitres -> display label. Order doesn't
# matter; we always snap to the nearest entry within tolerance.
_ML_CANON: list[tuple[float, str]] = [
    (50, "50ML"), (100, "100ML"), (187, "187ML"), (200, "200ML"),
    (250, "250ML"), (300, "300ML"), (330, "330ML"), (355, "355ML"),
    (375, "375ML"), (500, "500ML"), (570, "570ML"), (700, "700ML"),
    (720, "720ML"), (750, "750ML"),
    (1000, "1L"), (1500, "1.5L"), (1750, "1.75L"), (2000, "2L"),
    (3000, "3L"), (4000, "4L"), (4500, "4.5L"), (5000, "5L"),
    (6000, "6L"), (9000, "9L"), (12000, "12L"),
]

# Subset that an ounce value is allowed to snap to as a *wine/spirit* bottle
# (non-round decimal oz that are really a metric bottle). Deliberately excludes
# 330/355 so round beer cans (11.2OZ, 12OZ) stay labelled in ounces.
_OZ_TO_ML_CANON = {ml for ml, _ in _ML_CANON if ml not in (330, 355)}

# Beer / RTD cans are natively sold in ounces; keep them in ounces.
_OZ_CANON = [7, 7.5, 8, 8.4, 8.5, 10, 11.2, 12, 16, 16.9, 19.2, 22, 24, 25, 32, 40]

_ML_PER_OZ = 29.5735
_ML_PER_GAL = 3785.41

KEG_BULK = "Keg / Bulk"   # >= 15 L (kegs, bulk tanks)
OTHER = "Other"           # unparseable / no nearby canonical

_NUM_UNIT = re.compile(r"^\s*([\d.]+)?\s*(ML|MLS|L|LIT|LITER|LITRE|OZ|GL|GAL)?\s*$", re.I)


def _to_ml(raw: str) -> tuple[float | None, str | None]:
    """Parse a raw size to (millilitres, family) where family is 'ML' or 'OZ'.
    Returns (None, None) if it can't be parsed as a numeric size."""
    s = (raw or "").upper().replace(",", "").replace(" ", "").strip()
    if not s:
        return None, None
    m = _NUM_UNIT.match(s)
    if not m:
        return None, None
    num_s, unit = m.group(1), (m.group(2) or "")
    # "LITER" / "LITRE" with no number means 1 litre.
    if num_s is None:
        if unit.startswith("LIT"):
            return 1000.0, "ML"
        return None, None
    try:
        n = float(num_s)
    except ValueError:
        return None, None
    if n <= 0:
        return None, None
    u = unit.upper()
    if u == "OZ":
        return n * _ML_PER_OZ, "OZ"
    if u in ("GL", "GAL"):
        return n * _ML_PER_GAL, "OZ"   # gallons are a keg/bulk family for our purposes
    if u in ("L", "LIT", "LITER", "LITRE"):
        return n * 1000.0, "ML"
    # default (ML / MLS / bare number) -> millilitres
    return n, "ML"


def _snap(ml: float, allowed: set[float] | None = None, tol: float = 0.03) -> str | None:
    """Snap a millilitre value to the nearest canonical label within `tol`
    (relative). `allowed` optionally restricts which canonical mls are eligible."""
    best_lbl, best_rel = None, tol
    for cml, lbl in _ML_CANON:
        if allowed is not None and cml not in allowed:
            continue
        rel = abs(ml - cml) / cml
        if rel <= best_rel:
            best_rel, best_lbl = rel, lbl
    return best_lbl


def _fmt_oz(oz: float) -> str:
    return (f"{oz:.1f}".rstrip("0").rstrip(".")) + "OZ"


def standardize_size(raw: str) -> str:
    """Map a raw unit_volume to a canonical size bucket."""
    ml, family = _to_ml(raw)
    if ml is None:
        return OTHER

    # Kegs / bulk: anything >= 15 L regardless of how it was expressed.
    if ml >= 15000:
        return KEG_BULK

    if family == "OZ":
        oz = ml / _ML_PER_OZ
        # A non-round oz that lands on a metric bottle is wine/spirits in oz.
        wine = _snap(ml, allowed=_OZ_TO_ML_CANON, tol=0.02)
        if wine is not None:
            return wine
        # Otherwise treat as a beer/RTD can: snap to the nearest canonical oz.
        best, best_rel = None, 0.04
        for c in _OZ_CANON:
            rel = abs(oz - c) / c
            if rel <= best_rel:
                best_rel, best = rel, c
        if best is not None:
            return _fmt_oz(best)
        return OTHER

    # Native millilitres / litres.
    lbl = _snap(ml, tol=0.03)
    return lbl if lbl is not None else OTHER


def build_size_map(values) -> dict[str, str]:
    """Build a {raw_unit_volume: canonical_label} lookup for the distinct raw
    values present in the data."""
    return {v: standardize_size(v) for v in values if v not in (None, "")}
