# Celar AI Assistant: model-driven (end-to-end) eval report

_Generated: 2026-06-01 18:48 · run `python scripts/eval_assistant_chat.py`_

**Result: 30 passed, 0 warning(s), 0 failed: all checks passed.**
_Total model cost this run: $0.0767._

Each row is a real question sent through the model + tools; the checks look at the actual answer, products, charts and screen action it produced.

## California wines (standalone)  (6/6 passed)

| Check | Status | Detail |
| --- | --- | --- |
| not_offline | ✅ PASS |  |
| no_banned_phrasing | ✅ PASS |  |
| min_products>=1 | ✅ PASS |  |
| products_type_in(['sparkling', 'wine']) | ✅ PASS |  |
| products_exclude('ABSOLUT') | ✅ PASS |  |
| no_near_free_products | ✅ PASS |  |

## Cheapest tequila  (5/5 passed)

| Check | Status | Detail |
| --- | --- | --- |
| not_offline | ✅ PASS |  |
| no_banned_phrasing | ✅ PASS |  |
| min_products>=1 | ✅ PASS |  |
| products_type_in(['spirits']) | ✅ PASS |  |
| no_near_free_products | ✅ PASS |  |

## RIP for Macallan 12 in May (past edition)  (2/2 passed)

| Check | Status | Detail |
| --- | --- | --- |
| not_offline | ✅ PASS |  |
| answer_has(any) | ✅ PASS |  |

## Price over months  (2/2 passed)

| Check | Status | Detail |
| --- | --- | --- |
| not_offline | ✅ PASS |  |
| chart_titled('over months') | ✅ PASS |  |

## Compare distributors  (2/2 passed)

| Check | Status | Detail |
| --- | --- | --- |
| not_offline | ✅ PASS |  |
| answer_has(any) | ✅ PASS |  |

## Prices going up (data-fix regression)  (4/4 passed)

| Check | Status | Detail |
| --- | --- | --- |
| not_offline | ✅ PASS |  |
| no_banned_phrasing | ✅ PASS |  |
| min_products>=1 | ✅ PASS |  |
| no_near_free_products | ✅ PASS |  |

## Best discount (no $0 Beronia)  (3/3 passed)

| Check | Status | Detail |
| --- | --- | --- |
| not_offline | ✅ PASS |  |
| no_near_free_products | ✅ PASS |  |
| answer_lacks | ✅ PASS |  |

## Off-topic refusal  (3/3 passed)

| Check | Status | Detail |
| --- | --- | --- |
| not_offline | ✅ PASS |  |
| answer_has(any) | ✅ PASS |  |
| answer_lacks | ✅ PASS |  |

## Docked: drive the grid  (3/3 passed)

| Check | Status | Detail |
| --- | --- | --- |
| not_offline | ✅ PASS |  |
| drove_screen | ✅ PASS |  |
| short_answer<=400 | ✅ PASS |  |
