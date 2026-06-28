"""Golden tests for the deterministic month-over-month answer path.

The CELR.AI Assistant must answer comparison / price-history questions from
CODE-RENDERED templates, never model-authored prose — so the same question can
never drop a distributor or mis-state a delta (the 'June vs July' bug). These
tests lock the intent router and the renderer; the end-to-end numbers are
verified separately against prod data.
"""
from backend import assistant as a


def test_temporal_compare_intent_router():
    # Month-over-month / history / 'X vs Y month' -> conversational (inline).
    assert a._is_temporal_compare("Compare Glenlivet Jamaica June vs July")
    assert a._is_temporal_compare("price history for Tito's 1.75L")
    assert a._is_temporal_compare("how does this compare this month vs next month")
    assert a._is_temporal_compare("month-over-month price for Don Julio")
    # Cross-distributor (same edition) is NOT temporal — must keep its grid/cards.
    assert not a._is_temporal_compare("Compare Tito's 1.75L across all distributors")
    assert not a._is_temporal_compare("cheapest tequila under $300")


def _demo():
    mk = lambda ed, eff, rip, d, p: {
        "edition": ed, "frontline_case_price": 348.54, "effective_case_price": eff,
        "has_rip": rip, "has_discount": True, "delta_vs_prev": d, "pct_vs_prev": p,
    }
    return {
        "product": "GLENLIVET JAMAICA", "upc": "64868000146",
        "distributors": [
            {"wholesaler": "allied", "unit_volume": "750ML", "bottles_per_case": "6",
             "timeline": [mk("2026-06", 246.54, False, None, None),
                          mk("2026-07", 270.54, True, 24.0, 9.7)]},
            {"wholesaler": "fedway", "unit_volume": "750ML", "bottles_per_case": "6",
             "timeline": [mk("2026-06", 246.54, False, None, None),
                          mk("2026-07", 330.54, False, 84.0, 34.1)]},
        ],
    }


def test_price_timeline_renderer_includes_every_distributor_and_month():
    md = a._format_price_timeline_md(_demo())
    # Both distributors present (the bug dropped Fedway).
    assert "**Allied**" in md and "**Fedway**" in md
    # Both editions, both effective prices, the deltas.
    assert "Jun 2026" in md and "Jul 2026" in md
    assert "$246.54" in md and "$270.54" in md and "$330.54" in md
    assert "+$24.00" in md and "+$84.00" in md
    # Code-computed verdict names the cheaper distributor for the latest month.
    assert "Cheapest in Jul 2026: Allied at $270.54/cs" in md


def test_price_timeline_renderer_empty_is_safe():
    assert a._format_price_timeline_md({}) == ""
    assert a._format_price_timeline_md({"distributors": []}) == ""
