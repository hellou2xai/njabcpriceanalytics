"""Shared RIP math + uniform case-vs-bottle unit translation.

RIP rebate tiers can be quoted per CASE or per BOTTLE. The rebate `amount` is
the TOTAL for buying `qty` units, so `amount / qty` is the per-unit rebate. To
express savings per CASE — the unit every screen compares on — a BOTTLE tier's
per-bottle rebate must be multiplied by the pack size (bottles per case).
Forgetting this undervalues bottle RIPs by the pack factor (e.g. a 6-pack's
bottle RIP looked 6x too small).

Per-wholesaler unit encodings observed in the source data
---------------------------------------------------------
RIP UNIT NO. * column (rip_unit_1 / 2 / 3 / 4):
  allied       'Case(s)'  'Bottles'
  fedway       'C'        'B'
  opici        'C'        'B'
  (high_grade, peerless — no RIP listings)

CPL DISCOUNT qty column (discount_*_qty), raw text:
  allied       '<n> Cases'                              -> always cases
  fedway       '<n>' or '<n>.0' (no unit text)          -> implicit cases
  opici        '<n> case' or '<n> bottle' (lowercase)   -> both flavours appear
  high_grade   '<n>' (no unit text)                     -> implicit cases
  peerless     '<n>' (no unit text)                     -> implicit cases

`normalize_unit()` collapses every observed spelling — and the absence of a
unit string — to the canonical {'case', 'bottle', None}. `is_bottle_unit()`
and the rip_per_* helpers all flow through it so the rules live in ONE place.
"""

from __future__ import annotations


def _f(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    # NaN check without importing math everywhere
    return None if f != f else f


def normalize_unit(unit) -> str | None:
    """Map any observed RIP / discount unit spelling to 'case' | 'bottle' | None.

    Rules — designed around the per-wholesaler encodings documented in the
    module docstring:

    - None / empty / NaN          -> None (caller decides the default)
    - String starting with 'b'    -> 'bottle' (covers 'B', 'btl', 'Bottle',
                                    'Bottles', 'bottle', 'BTL', …)
    - String starting with 'c'    -> 'case'   (covers 'C', 'Cs', 'Case',
                                    'Case(s)', 'Cases', 'case', …)
    - Anything else (incl. bare numbers, '0', etc.) -> None
    """
    if unit is None:
        return None
    if isinstance(unit, float) and unit != unit:  # NaN
        return None
    s = str(unit).strip().lower()
    if not s:
        return None
    first = s[0]
    if first == "b":
        return "bottle"
    if first == "c":
        return "case"
    return None


def is_bottle_unit(unit) -> bool:
    """True when a RIP/discount tier's unit is bottles, false otherwise.

    `None` / unrecognised falls through to False — the safe default for the
    quantity-threshold check is "treat as cases" because every wholesaler that
    omits the unit text (fedway, high_grade, peerless) means cases implicitly.
    """
    return normalize_unit(unit) == "bottle"


def rip_per_case(amount, qty, unit, pack) -> float:
    """Per-CASE savings for one RIP tier.

    pack = bottles per case (CPL unit_qty). Bottle-unit tiers are converted to
    per-case by multiplying the per-bottle rebate by pack.
    """
    a, q = _f(amount), _f(qty)
    if a is None or q is None or q <= 0:
        return 0.0
    per_unit = a / q
    if is_bottle_unit(unit):
        p = _f(pack)
        return per_unit * p if (p and p > 0) else per_unit
    return per_unit


def rip_per_bottle(amount, qty, unit, pack) -> float:
    """Per-BOTTLE savings for one RIP tier (mirror of rip_per_case)."""
    a, q = _f(amount), _f(qty)
    if a is None or q is None or q <= 0:
        return 0.0
    per_unit = a / q
    if is_bottle_unit(unit):
        return per_unit  # already per bottle
    p = _f(pack)
    return per_unit / p if (p and p > 0) else 0.0


def rip_bundle_cost(qty, unit, case_price, btl_price) -> float:
    """Cost of buying one RIP bundle (qty cases, or qty bottles) — for ROI."""
    q = _f(qty)
    if q is None or q <= 0:
        return 0.0
    if is_bottle_unit(unit):
        bp = _f(btl_price)
        return bp * q if bp else 0.0
    cp = _f(case_price)
    return cp * q if cp else 0.0
