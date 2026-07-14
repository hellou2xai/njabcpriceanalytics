# Cross-Page Price Accuracy Audit — Compare Distributor Prices vs Discover

**When:** 2026-07-14 · **Target:** live prod (`https://nj.celr.ai`) · **Pair:** Allied + Fedway
**Test:** `tests/playwright/test_cross_page_price_accuracy.py`
**Raw data:** `cross_page_price_audit.csv` (957 checks), `cross_page_price_audit.json`

## Method
1. Sampled **160 items** from `/api/compare/products` (Allied+Fedway) where the Best-Net
   spread between the two distributors is clearly visible ($12–$1,951/case) — the biggest
   differences first. (>=100 required.)
2. For the **same item + distributor**, pulled the Discover deal card's data source
   (`/api/catalog/search?upcs=…&include_tiers=true`) and replicated the card's exact
   displayed prices (mirrors `frontend/src/pages/Discover.tsx`): 1-Case, Best QD, Best Net.
3. Matched SKUs on **UPC + size + pack + vintage** (a shared barcode is reused across
   vintages/sizes — matching without vintage produced false positives that were removed).
   Live time-sensitive deals are **classified**, not failed.

## Result — the two headline prices are consistent

| Tier | Match | Rate |
|---|---|---|
| **1-Case Price** | 318 / 319 | **99.7%** |
| **Best QD** | 316 / 319 | **99.1%** |
| **Best Net** | 257 exact + 58 live-deal-explained / 319 | 4 true mismatches |

1-Case Price and Best QD — the prices a buyer reads first — are effectively identical
across both pages. Only 1 item, 319 item×distributor checks, 1 unmatched (a size-label edge).

---

## Findings (defects surfaced — NOT introduced by the recent 1-Case work)

### 1. Discover card's per-bottle "after QD+RIP" net (X3) is wrong on ~52 / 160 items
**48 understated, up to −$126/case.** The card computes
`X3 = best_case_price − rip.save_per_case` (`Discover.tsx` → `BottlePrices`). That **stacks
the 1-case QD price with the full-from-frontline RIP saving**, producing a net below the
canonical `effective_case_price` (a price you can't actually reach). Compare and the
canonical column are correct.

| Item | Dist | Card net (X3) | Canonical | Δ |
|---|---|---|---|---|
| Bruichladdich 18 Yr | allied | $563.94 | $689.94 | −$126.00 |
| Remy Martin 1738 (Roche gift) | allied | $231.01 | $331.26 | −$100.25 |
| Johnnie Walker Black | allied | $225.24 | $321.24 | −$96.00 |
| Stolichnaya Elit | allied | $131.25 | $221.25 | −$90.00 |
| Remy Martin 1738 | allied | $209.88 | $287.88 | −$78.00 |
| Johnnie Walker Red | allied | $90.08 | $167.54 | −$77.46 |
| Mount Gay Eclipse 1.75L | allied | $103.11 | $156.56 | −$53.45 |
| 360 Georgia Peach | allied | $93.44 | $128.94 | −$35.50 |

**Fix direction:** X3 should be the canonical effective (deepest tier), i.e. the deeper of
best-QD vs best-RIP — not `best_case_price − rip.save_per_case`. Use `effective_case_price` /
`live_effective_case_price` or the deepest tier's `price_after`.

### 2. Compare GRID best-net misses whole-month RIPs its own ladder applies
The grid's best-deal RIP overlay (`attach_live_rip`) does not pick up RIPs the ladder
(`attach_tiers`) shows, so the grid understates Best Net (and skews winner/spread).

- **Mount Gay Eclipse 1.75L (Allied):** GRID Best Net **$204.56** (no RIP) vs LADDER &
  canonical **$156.56** (whole-month RIP: 5 Case(s) → $156.56). Δ **−$48**.
  Grid ladder tiers present: rip 1cs→$183.56, 3cs→$168.56, 5cs→$156.56 (all `whole_month`),
  yet grid `effective` = $204.56.

**Fix direction:** the grid's cases=0 RIP layer must cover the same whole-month RIP tiers the
ladder/`attach_tiers` builds (likely a gap in the `rip_windows` overlay for this SKU shape,
e.g. 1.75L/bottle-unit).

### 3. Stale catalog `effective_case_price` columns (a few)
Column doesn't reflect the deepest discount tier; Compare (live/deepest) is correct.
- Bollinger La Grande Année v2015 (Allied): column $1,000 vs deepest tier $944 (Compare $944).
- Marietta Roman Zinfandel v2022 (Allied): column $212 vs deepest tier $188 (Compare $188).

### 4. Raw-window vs tier-ladder QD divergence (minor, a few SKUs)
Compare's 1-case / QD comes from live raw windows; Discover from `attach_tiers`. They differ on:
- Stoli Cucumber Vodka (Allied): Compare 1-case $323.88 vs tier $310.80 (Δ $13.08).
- Nipozzano Chianti (Allied), Castiglioni Chianti (Allied): Compare shows a more-current live
  QD than the whole-month column.

---

## The 8 flagged mismatches (after removing vintage/size artifacts)

| Item | Dist | Tier | Compare | Discover | Δ | Category |
|---|---|---|---|---|---|---|
| Stoli Cucumber Vodka | allied | 1-Case | $323.88 | $310.80 | +$13.08 | #4 raw-vs-tier QD |
| Stoli Cucumber Vodka | allied | Best QD | $323.88 | $310.80 | +$13.08 | #4 |
| Bollinger La Grande Année | allied | Best Net | $944.00 | $1,000.00 | −$56.00 | #3 stale column (Compare right) |
| Nipozzano Chianti | allied | Best QD | $100.08 | $144.00 | −$43.92 | #4 live QD (Compare more current) |
| Nipozzano Chianti | allied | Best Net | $100.08 | $144.00 | −$43.92 | #4 |
| Mount Gay Eclipse 1.75L | allied | Best Net | $204.56 | $156.56 | +$48.00 | **#2 Compare grid RIP-miss** |
| Castiglioni Chianti | allied | Best QD | $104.00 | $108.00 | −$4.00 | #4 live QD |
| Marietta Roman Zinfandel | allied | Best Net | $188.00 | $212.00 | −$24.00 | #3 stale column (Compare right) |

Net: **1 genuine Compare bug (#2, Mount Gay)**, 2 stale-column cases where Compare is correct,
and 3 live-vs-whole-month deltas where Compare is more current. Plus the systematic **Discover
card X3 net bug (#1, ~52 items)**.

## Re-run
```
python tests/playwright/test_cross_page_price_accuracy.py
# env: AUDIT_BASE (default prod), VISIBLE=1.0, MAX_ITEMS=160,
#      RENDER=1 (browser spot-check), AUDIT_EMAIL/AUDIT_PASSWORD (if pages gated)
```
