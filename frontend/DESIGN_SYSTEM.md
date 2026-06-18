# CELR frontend design system

The conventions every page MUST follow. They exist because each one was a bug we
shipped at least once. If you change UI, read this first; if you find yourself
re-solving one of these, the answer is already here.

## 1. The filter rail (shared `FilterSidebar`, `.prod-filter-*` skin)

One vertical left rail, 248px, sticky, used by every list/analysis page. Rules:

- The rail body is the SINGLE vertical scroll (`overflow-y:auto`, `max-height:
  calc(100vh-24px)`), and is **`overflow-x: hidden`** with bottom padding so the
  last section never cuts flush.
- Text inputs + selects in the rail are FLUID: `width:100%; min-width:0;
  max-width:100%; box-sizing:border-box`. Scope to
  `.filter-text, .filter-select, input[type=text|number|search], select`.
- **NEVER** apply width/`:is(input,select)` rules that hit `checkbox`/`radio` —
  the faceted Distributor/Brand/Category/Size lists are checkboxes; width:100%
  stretches them into giant boxes and pushes labels off. (Shipped this bug.)
- Facet lists (`.prod-filter-list`) are `overflow-y:auto` **and**
  `overflow-x:hidden` (overflow-y:auto otherwise forces overflow-x:auto → a long
  label triggers a horizontal scrollbar). Each row truncates its label with
  `flex:1; min-width:0; text-overflow:ellipsis; white-space:nowrap`; the count
  stays `flex-shrink:0`.
- Don't hand-roll page filter toolbars — use the shared rail.

## 2. Highlight convention: "best / changed / standout" = red on yellow

The one accent for "this is the number that matters": **red font `var(--hl-fg)`
on yellow `var(--hl-bg)`** (use the `.hl-best` utility or the tokens). Used by:
Edition Comparison changed values + breakdown, Compare Distributor Price best
cells, Best QD / Best RIPs headline badge + best tier row, Price Drops/Increases
diffs, next-month chips' down arrow. Do NOT invent new colors for "best".

## 3. Current month vs next month (the buyer rule)

"What I pay THIS month" is the headline (current edition = `MAX(edition <=
today)`); next month must be VISIBLE alongside, never hidden, never replacing the
headline. Use `NextMonthChip` (fed by `cpl_enriched.next_effective_case_price`).
Change/deal-timing views (Price Drops/Increases, Time-Sensitive, Edition
Comparison, dashboard counts) key off the latest LOADED edition instead. See
backend memory `current-edition-gating`.

## 4. Tables

- Long tables need a CLEAR END-OF-SECTION FOOTER ("End … N products" / "Showing
  X of N · Show more") plus ~64px bottom padding so the last rows clear the
  fixed assistant FAB and any horizontal scrollbar. (Shipped "rows hidden".)
- Headers: middle-aligned + centered, header band, row hover.
- Collapsed-by-default for dense comparison tables; Expand all / Collapse all on
  top.
- A click-to-EXPAND row must NOT also be a hyperlink — pick one affordance. Open
  individual items from the expanded detail.
- Surface SKU-identifying fields in expanded detail (vintage for wine, proof/ABV,
  item number, UPC) so near-identical SKUs are distinguishable.
- Pagination = page-size selector + Prev/Next; never silently cap rows.

## 5. Verify before declaring done

`npx vite build` must pass. For any rail/table change, look at a screenshot at a
normal viewport before claiming success — text-level checks miss off-screen /
clipped / stretched elements (see memory `agent-ui-lessons`).
