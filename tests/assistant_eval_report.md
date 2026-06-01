# Celar AI Assistant — tool-level eval report

_Generated: 2026-06-01 18:24 · run `python scripts/eval_assistant.py`_

**Result: 70 passed, 0 warning(s), 0 failed — all checks passed.**

This eval exercises the assistant's data tools directly (no model call), so it catches response bugs at their source: bad pricing, wrong filters, edition handling, crashes, and inconsistency between tools.

## robustness: empty + garbage input  (30/30 passed)

_Every tool is called with empty and nonsense input; none should raise._

| Check | Status | Detail |
| --- | --- | --- |
| no-crash: top_products({}) | ✅ PASS |  |
| no-crash: top_products(garbage) | ✅ PASS |  |
| no-crash: price_timeline({}) | ✅ PASS |  |
| no-crash: price_timeline(garbage) | ✅ PASS |  |
| no-crash: price_details({}) | ✅ PASS |  |
| no-crash: price_details(garbage) | ✅ PASS |  |
| no-crash: compare_distributors({}) | ✅ PASS |  |
| no-crash: compare_distributors(garbage) | ✅ PASS |  |
| no-crash: rip_lookup({}) | ✅ PASS |  |
| no-crash: rip_lookup(garbage) | ✅ PASS |  |
| no-crash: best_gp_deals({}) | ✅ PASS |  |
| no-crash: best_gp_deals(garbage) | ✅ PASS |  |
| no-crash: closeouts({}) | ✅ PASS |  |
| no-crash: closeouts(garbage) | ✅ PASS |  |
| no-crash: distributor_arbitrage({}) | ✅ PASS |  |
| no-crash: distributor_arbitrage(garbage) | ✅ PASS |  |
| no-crash: price_history({}) | ✅ PASS |  |
| no-crash: price_history(garbage) | ✅ PASS |  |
| no-crash: category_breakdown({}) | ✅ PASS |  |
| no-crash: category_breakdown(garbage) | ✅ PASS |  |
| no-crash: deal_360({}) | ✅ PASS |  |
| no-crash: deal_360(garbage) | ✅ PASS |  |
| no-crash: size_value({}) | ✅ PASS |  |
| no-crash: size_value(garbage) | ✅ PASS |  |
| no-crash: best_one_case_rip({}) | ✅ PASS |  |
| no-crash: best_one_case_rip(garbage) | ✅ PASS |  |
| no-crash: find_substitute({}) | ✅ PASS |  |
| no-crash: find_substitute(garbage) | ✅ PASS |  |
| no-crash: find_deals({}) | ✅ PASS |  |
| no-crash: price_movers({}) | ✅ PASS |  |

## stocking-deal floor ($0 free-with-purchase must not leak)  (9/9 passed)

_$0 / near-free 'free-with-purchase' rows must never surface in browse or deal results._

| Check | Status | Detail |
| --- | --- | --- |
| floor: top_products(cheapest Wine) | ✅ PASS |  |
| floor: top_products(cheapest Spirits) | ✅ PASS |  |
| floor: best_gp_deals | ✅ PASS |  |
| floor: closeouts | ✅ PASS |  |
| floor: distributor_arbitrage | ✅ PASS |  |
| floor: find_deals(discount) | ✅ PASS |  |
| floor: find_deals(time_sensitive) | ✅ PASS |  |
| floor: find_deals(clearance) | ✅ PASS |  |
| floor: price_movers(drop) | ✅ PASS |  |

## price sanity  (9/9 passed)

_Effective price must be <= list price and never negative._

| Check | Status | Detail |
| --- | --- | --- |
| sanity: top_products(cheapest Wine) | ✅ PASS |  |
| sanity: top_products(cheapest Spirits) | ✅ PASS |  |
| sanity: best_gp_deals | ✅ PASS |  |
| sanity: closeouts | ✅ PASS |  |
| sanity: distributor_arbitrage | ✅ PASS |  |
| sanity: find_deals(discount) | ✅ PASS |  |
| sanity: find_deals(time_sensitive) | ✅ PASS |  |
| sanity: find_deals(clearance) | ✅ PASS |  |
| sanity: price_movers(drop) | ✅ PASS |  |

## region / varietal semantics  (4/4 passed)

_A geography filter must return the right product type (California -> Wine, Kentucky -> Spirits), never stray substrings like ABSOLUT CALIFORNIA._

| Check | Status | Detail |
| --- | --- | --- |
| region=california returns rows | ✅ PASS |  |
| region=california -> Wine only | ✅ PASS |  |
| region=california excludes ABSOLUT | ✅ PASS |  |
| region=kentucky -> Spirits | ✅ PASS |  |

## data pipeline  (1/1 passed)

_Upstream data the tools depend on must be populated for the current edition._

| Check | Status | Detail |
| --- | --- | --- |
| price_trend populated in current edition (2026-06) | ✅ PASS |  |

## edition awareness  (7/7 passed)

_Month parsing and past-edition lookups (e.g. a rebate from a prior month) must work._

| Check | Status | Detail |
| --- | --- | --- |
| _resolve_month('May') | ✅ PASS |  |
| _resolve_month('2026-05') | ✅ PASS |  |
| _resolve_month('this month') -> current | ✅ PASS |  |
| _resolve_month('garbage zzz') -> None | ✅ PASS |  |
| _resolve_month('') -> None | ✅ PASS |  |
| rip_lookup month plumbs edition | ✅ PASS |  |
| rip_lookup(month=May) differs from current when expired | ✅ PASS |  |

## price_timeline  (6/6 passed)

_Month-over-month price tool: resolves the named product, sorts editions, computes deltas, errors gracefully._

| Check | Status | Detail |
| --- | --- | --- |
| timeline returns distributors | ✅ PASS |  |
| timeline editions sorted ascending | ✅ PASS |  |
| timeline resolved the named product (not a UPC collision) | ✅ PASS |  |
| timeline first delta is None, rest computed | ✅ PASS |  |
| timeline(nonexistent) -> error dict | ✅ PASS |  |
| timeline(empty) -> error dict | ✅ PASS |  |

## cross-tool consistency  (1/1 passed)

_The same product's numbers must agree across different tools._

| Check | Status | Detail |
| --- | --- | --- |
| price_details == compare_distributors (same UPC/ws effective) | ✅ PASS |  |

## price_movers direction  (1/1 passed)

_Products returned for 'prices going up' must actually be rising._

| Check | Status | Detail |
| --- | --- | --- |
| price_movers(increase) returns rising products | ✅ PASS |  |

## rip tiers  (2/2 passed)

_RIP tier ladders are sorted and flag exactly one best rung._

| Check | Status | Detail |
| --- | --- | --- |
| rip tiers sorted by amount | ✅ PASS |  |
| rip tiers flag exactly one best | ✅ PASS |  |
