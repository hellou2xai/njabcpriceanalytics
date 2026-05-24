"""Shared RIP math.

RIP rebate tiers can be quoted per CASE ('C', 'Case(s)') or per BOTTLE
('B', 'Bottles'). The rebate `amount` is the TOTAL for buying `qty` units, so
`amount / qty` is the per-unit rebate. To express savings per CASE — the unit
every screen compares on — a BOTTLE tier's per-bottle rebate must be multiplied
by the pack size (bottles per case). Forgetting this undervalues bottle RIPs by
the pack factor (e.g. a 6-pack's bottle RIP looked 6x too small).
"""

from __future__ import annotations


def _f(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    # NaN check without importing math everywhere
    return None if f != f else f


def is_bottle_unit(unit) -> bool:
    """True when a RIP/discount tier's unit is bottles ('B', 'Bottles', ...)."""
    return str(unit or "").strip().lower().startswith("b")


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
