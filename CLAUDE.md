# CELR — Project Ground Rules

Instructions for Claude Code (and human contributors) working in this repo.

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
