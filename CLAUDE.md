# CELR — Project Ground Rules

Instructions for Claude Code (and human contributors) working in this repo.

## Troubleshooting: always verify against PROD
- For ANY reported issue ("not working", "still nothing", "wrong data"),
  reproduce by calling the LIVE prod API (`curl https://nj.celr.ai/api/...`)
  BEFORE concluding anything or claiming a fix. Check the actual JSON.
- "Pushed" is NOT "live": Render serves the previous build for ~5-8 min per
  deploy. Confirm the fix is on the serving build (test prod), don't assume.
- Use a control case to separate filter vs data vs deploy (e.g. if July is
  empty, test June/May on prod; if those work, it's the deploy/gate, not the code).

## Everything is EDITION-specific (no exceptions)
- A CPL is published monthly as an `edition` (`YYYY-MM`). Prices, quantity
  discounts, RIP codes, RIP tiers, and RIP membership are ALL re-issued each
  edition, and **RIP codes are recycled** — code `10954` can be Parrot Bay in
  May and Sarti Rosa in June. Treating any of these as global is a bug.
- EVERY price/RIP/tier/savings read MUST be scoped to one (edition, distributor).
  When a query resolves a "current" price, it resolves it for a specific edition
  — never "the latest matching code" across months.
- EVERY modal, popover, quick-view, or drill-down that shows pricing (price,
  tiers, RIP rebate, savings, members list) MUST be opened with the edition of
  the row/card it came from and pass that edition to the backend
  (`/api/catalog/rip-siblings`, `/api/catalog/product`, etc. all take `edition`).
  Do NOT let it default to the current calendar month — the source row may be a
  past or future edition (e.g. the Best RIPs board shows multiple months).
- The displayed RIP code on a card/row MUST be the code that actually produced
  the shown (edition-specific) tier ladder, not the CPL's nominal `rip_code`,
  so the badge and its members modal always agree within the edition.
- Multi-edition trend/sparkline views are the ONLY place multiple editions mix,
  and only to show history — the "current"/headline value is still one edition.

## Pricing / catalog math
- `backend/FOUNDATION.md` is the contract. All pricing, savings, RIP, tier,
  ranking, and "best buy" math MUST follow it and live in the canonical
  helpers (`backend/pricing.py`, `backend/rip_utils.py`). Do not re-implement
  the math in routers, the assistant, MCP, or the frontend.
- Never recompute a precomputed column from `cpl_enriched`; fix `derive.py`
  and rebuild the parquet instead.
- A change that alters a formula MUST update `FOUNDATION.md` in the same commit.

## Semantic layer must stay in sync (app == AI assistant)
- The app catalog (`backend/routers/catalog.py`) and the AI assistant
  (`backend/assistant.py`) both import the SAME `from backend.semantic_search
  import semantic_search`. Keep search/dedup logic in that shared module so the
  app and the assistant always return the same results. Do not fork it.
- SKU identity / dedup in the semantic layer MUST mirror `derive.py` /
  `attach_tiers` — including `unit_qty` so multi-pack sizes of the same UPC are
  not collapsed and silently dropped.
- Any change to product/catalog fields, parsing, or enrichment must also update
  the semantic layer:
  - FTS index is ensured automatically on startup via `ensure_fts_index()` in
    `backend/main.py`.
  - Product embeddings: rebuild with `python scripts/build_semantic_index.py`
    (`--all` to re-embed from scratch); see `backend/voyage_embed.py`.

## Product search must be smart/semantic EVERYWHERE
- EVERY product search box in the app (Price 360, Compare Prices/RIPs, Edition
  Comparison, Catalog, Products, and any new screen) must resolve the query
  through the smart/semantic search stack — never raw `name LIKE '%q%'`
  substring matching. A retailer typing "absolut vodka", "tito's", a misspelling,
  or a barcode must land on the right product.
- Use the shared `ProductSearchBox` typeahead component (suggestions from
  `/api/catalog/search`, which already does aliases + spell-fix + UPC resolve);
  selecting a suggestion passes the exact product (name + UPC) downstream. Do
  not hand-roll a plain `<input>` that posts free text to a substring matcher.
- Backend endpoints that resolve a `match` (e.g. `price360`, `compare_rip_outcomes`)
  should accept a UPC and prefer it; the smart resolution happens at the search
  box. When a name must be resolved server-side, fall back to `semantic_search`,
  not bare `LIKE`.

## Two machines — sync via git, NOT OneDrive
- This project exists as two working copies under OneDrive: `RIP_ABC` (office)
  and `RIP_ABC _Laptop` (home), both clones of GitHub
  `hellou2xai/njabcpriceanalytics` on `main`.
- Sync via git only: `git push` from the machine you finished on, `git pull` on
  the other. Do NOT rely on OneDrive to move code, and do NOT bulk-copy files
  between the two folders.
- OneDrive rewrites line endings (office checks out CRLF, laptop LF). A raw byte
  `diff` between the copies will flag files that are actually identical — use
  `diff --strip-trailing-cr` or trust `git status` to find real drift.
