# Entry dashboard: build notes, reuse audit, and wiring checklist

This covers the free-release entry dashboard work (Smart Header, Action Center,
upgraded Key Metrics, and the Combo / RIP deep-dive pages), plus the CELR.ai
visual restyle that preceded it.

## Reuse vs fork audit

Reused, not rebuilt:
- `KPICard` (the MetricCard the brief names). Extended in place: added sub-lines and re-pointed the Active RIPs click-through to `/rips`. Not forked.
- `DashboardTile` + the nine Insights tiles. Left intact. The distributor axis now flows through the shared filter context instead of local state.
- `WholesalerFilter` (distributor pills). Reused as-is; now bound to the shared filter context so distributor composes with universe and date.
- The "Allied vs Fedway" comparison pattern. Extracted into `DistributorComparisonRow` and reused by both deep-dive pages. No second comparison component was created.

New (the operational layer the brief defines), not duplicating any existing surface:
- `DashboardFilterContext` (universe / date / distributor).
- `SmartHeaderStrip`, `ActionCenter` (Combo Watchlist, RIP Pacing, Smart Reorder).
- `ValidityBadge`, `CaseProgressBar` (the "build once, use everywhere" components).
- `ComboAnalytics` (`/combos`) and `RipAnalytics` (`/rips`).

Forks: none.

Route change worth noting: `/combos` and `/rips` previously rendered deal-browser
pages (`Combos.tsx`, `Rips.tsx`). Per the brief these routes now render the
analytics deep-dives. The old files remain in the repo but are no longer routed;
delete them once you are happy with the replacements.

## Stub data: what is mocked and where

All Action Center and deep-dive data is mocked in
`frontend/src/lib/dashboardFixtures.ts`. The component props are already typed
against these interfaces, so wiring real data means swapping the constants for
react-query fetches and deleting the fixtures.

Backend tables / feeds the brief specifies that DO NOT exist yet:

| Needed table / feed | Used by | Stub source |
|---|---|---|
| `combo_definitions` (combo_id, distributor, posting_period, components, total_cost, valid_from, valid_through) | Combo Watchlist, Combo Analytics | `STUB_COMBOS` |
| `rip_definitions` (rip_id, distributor, eligible_skus, tier ladder, valid_from/through) | RIP Pacing, RIP Analytics | `STUB_RIPS`, `STUB_ALMOST_RIPS` |
| `user_catalog` (user_id, sku, last_ordered_at, on_hand, trailing_90d_velocity) | Universe = My Catalog, fit scores, Smart Reorder | none yet; `hasCatalog` is hard-set false |
| `user_progress` (user_id, combo_or_rip_id, current_cases, current_dollars) | case progress, pacing forecasts | embedded in the stub combos/RIPs |
| Advent POS velocity (Sypram) | Smart Reorder | `STUB_REORDER`; `hasVelocity` is hard-set true to show the populated state |

`posted_prices` largely exists already as the Parquet `cpl` / `cpl_enriched`
tables that power the catalog and Insights tiles.

## Wired vs deferred (be honest about state)

Done and working on real data:
- Distributor axis composes through the context and drives the Key Metric
  queries and both deep-dive pages.
- Key Metric click-throughs route per the reuse map (Active RIPs now to `/rips`).
- Smart Header greeting reads the real store name and license from the stores
  feature; "Draft PO" creates a real order and opens it.
- Loading skeletons on the Key Metrics row; empty states on the Action Center
  cards; the catalog-upload prompt; the disabled "Ask CELR" slot.

Deferred (needs the tables above, or a backend field that is not in the row
payload yet). These are intentionally not faked on top of real aggregates:
1. Universe = My Catalog / My Watchlist does not yet recompute the six Key
   Metric counts or the Insights dollar totals. It sets a label only. Needs
   `user_catalog` plus per-universe aggregation params on the existing endpoints.
2. Date-window chips (Today / This Week / This Month / Next Month) are captured
   in context but not yet pushed into the existing tile queries as a
   `valid_from` / `valid_through` filter. The backend rows need those date
   columns surfaced.
3. Validity badges on the nine Insights line items: the component exists and is
   used in the Action Center and deep-dives, but the Insights row payloads do
   not carry `valid_through`, so the badge cannot be derived per row yet.
4. Key Metric sparklines: not added. The brief requires they share the existing
   month-over-month aggregation (`catalog.priceComparison`) rather than a new
   query. Add a 30-90 day series to that endpoint's response, then render it in
   `KPICard`. Do not add a second aggregation.

## Acceptance criteria status

Met: distributor composition; Key Metric click-throughs; deep-dives reuse
`DistributorComparisonRow`; deep-dives fit 1440 wide without horizontal scroll;
no new cross-distributor or MoM aggregation introduced; reserved Ask CELR slot
present, disabled, non-interactive; no em dash or hyphen-as-break in new copy;
empty and loading states present.

Pending the deferred items above: universe propagation to all tiles within
300ms (universe currently relabels rather than recomputes); per-card sparklines;
validity badges on every Insights line item; date-window propagation.

## CELR.ai restyle (shipped)

Light theme is the default, blue accent `#2563eb`, IBM Plex Sans / Plex Mono
loaded via Google Fonts, larger base type (15px) and bumped small text for
readability. Tokens live at the top of `frontend/src/index.css`; the dark theme
is still available via the toggle.
