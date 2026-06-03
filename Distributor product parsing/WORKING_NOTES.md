# Fedway price-book -> UPC crosswalk: working notes (handoff)

Last updated by the prior session. Pick up Fedway parsing from here. Everything
is in the repo under `distributor_pipeline/` (no-spaces package; the source PDFs
live in `Distributor product parsing/`). Pull the latest `main` first.

## Goal

Parse the Fedway monthly price-book PDF and map every Fedway item to a UPC, so
we get a `(fedway item, UPC, price-book price, live price, discrepancy)` table.
Distributor-agnostic: same pipeline/tables reused for Allied, Opici, future
months under their own `distributor_code`.

## Data model (verified, important)

- **Fedway has NO real UPC.** Its `cpl_enriched.upc` column holds a Fedway SKU /
  '0', not a GTIN. The live data does **not** contain the Fedway price-book item
  number either, so you CANNOT join PDF item number -> live row.
- The live catalogue identifies products by **UPC + item NAME + pricing**. Real
  UPCs come from allied/opici/peerless (and partially high_grade); ~27,877
  distinct real UPCs across `cpl_enriched` (latest edition).
- Therefore matching is: **Fedway item NAME (semantic) + frontline PRICE -> live
  UPC**. Name match must be SEMANTIC, not exact. Frontline price is the strong
  disambiguator.
- `distributor_code` MUST be the app's wholesaler code `fedway` (lowercase), so
  the crosswalk joins `cpl_enriched.wholesaler` and the rest of the app.
- Item-number padding rule (verified empirically, NOT the prompt's guess): plain
  zero-pad to 9, NO *10. (`util.norm_item_catalog`.)

## Pipeline / files

- `config.py`      paths, section->parser map (header detection), distributor id
- `util.py`        size parse, item-number norm, name cleaning/normalisation
- `extract.py`     PDF: section routing + parser A (3-col catalog), B (best-deal/
                   partial), C (retail incentives), D (combos). Font-keyed.
- `db.py`          staging tables + UPC master loader + crosswalk writers
                   (LocalPostgresWriter / RenderPostgresWriter, upsert/append)
- `semantic.py`    Voyage (voyage-3) embeddings + cosine retrieval, disk cache
- `llm.py`         Claude (claude-sonnet-4-6) disambiguation, JSON out
- `matchv2.py`     semantic retrieve -> price+size score -> Claude for ambiguous
- `match.py`       shared `_matched/_unmatched`; v1 passes (kept for reference)
- `run.py`         end-to-end orchestrator + reports

Run:
```
python -m distributor_pipeline.run                 # full, semantic+price+Claude, push local+Render
python -m distributor_pipeline.run --no-render --no-llm --max-pages 80   # fast smoke test
```
Reports -> `Distributor product parsing/output/` (unmatched_fedway, unmatched_upc,
match_review, unparsed_lines, run_summary, _fullrun.log). Embedding cache ->
`distributor_pipeline/cache/` (master_emb_*.npz, keyed by name set; safe to delete).

Env (all set in `.env`): `DATABASE_URL` (local PG), `RENDER_EXTERNAL_DATABASE_URL`,
`VOYAGE_API_KEY`, `ANTHROPIC_API_KEY` (or `CROSSWALK_ANTHROPIC_KEY` for a dedicated key).

## PDF structure (parser A is the crux)

- 612x792 pages, header line `Order Phone: 800-4-FEDWAY  {SECTION}  Order Fax:...`
  drives section routing (don't hardcode page numbers).
- 3 columns. Column left edges = x of the repeated `ITEM` header tokens
  (~36/223/410). Cut at next column's left edge - 6. (0 pages need the fallback.)
- Rigid FONTS classify each line (`extract._font_class`):
  - `Kingsbridge-Bold`  -> TYPE (size>=8.5) / COUNTRY header
  - `AsapCondensed-Bold`     -> BRAND banner
  - `AsapCondensed-SemiBold` -> PRODUCT label
  - `AsapCondensed-Italic`   -> description (product_notes)
  - `AsapCondensed-Regular`  -> data (item / RIP / price rows)
- Item line: `[+]itemnum size pack PK proof(PF)|vintage  [deal tiers]`.
  RIP line: `RIP: <id> [1BOTTLE $x]`. Price rows: `1 CASE $.. $..` (BUY PER CS,
  BEST RIP PER BT), `1 BOTTLE $..`. Leading `+` = changed this month.

## Current results (Fedway June 2026)

- Extract (BEFORE the latest parser fixes were re-run end to end): 6,323 item
  rows, 5,919 distinct item numbers, 5,538 catalogue listings.
- Crosswalk pushed to local + Render: **3,287 / 5,919 UPCs assigned = 55.5%**
  (HIGH 2,772 + MEDIUM 466 + LLM 49). 1,539 rows have BOTH prices.
- Crosswalk columns include `front_line_case_price` (PDF), `live_frontline_case_price`
  (live), `price_delta` (live - pdf; NULL unless both present). Render upsert is
  append-only (PK distributor_code+item_number_norm) so Allied data is safe.

## FIXED in the latest parser pass (extract.py)

These three were root-caused and fixed; the improved extract gives **6,141
distinct items (0 lost vs v1, +222 recovered), catalogue price capture 60% ->
80%, brandless 41% -> 18%**.

1. **Item lines swallowed as prices (~938 items lost).** ROOT CAUSE: item lines
   carry a deal string `1C\$60` (has a `$`). The price-row check ran BEFORE the
   item check, and with lazy emit the prior item is still open, so the new item
   line was consumed as a price and never created. FIX: the price/dollar branch
   now skips lines that match `ITEM_RE` (item lines win). This is the key bug.
2. **Price dropped when a product label sits between item and price rows.** FIX:
   LAZY emit, only close the item on the NEXT item line / column end, not on
   naming lines.
3. **Unit price misread as case price** (`1 CASE $7.14 $181 $181`, the $7.14 is
   per-OZ). FIX: case price is the SECOND-TO-LAST dollar (`_apply_prices`).
4. **Brandless names.** FIX: page-level `page_brand` fallback so an item inherits
   the last BRAND banner (Asap-Bold) seen on the page when the immediate context
   was reset. Brandless 41% -> 18%.

## STILL OPEN (continue here)

1. **Remaining ~18% brandless** are on the fragmented combo / variety-pack pages
   (e.g. p56-67: COMBO (3+3+3), EASYPOUR PET, flavor stacks). These pages have
   the item details split oddly across lines. Options: a dedicated combo-page
   parser, or relax `ITEM_RE` to catch the `itemnum size` lines that lack the
   `N PK` token, then attach pack/price from following lines.
2. **Bulk packs (104CS / 52CS).** PDF price is a bulk total (e.g. $5,200 for 104
   cases) matched to a single-case UPC ($60) -> huge false `price_delta`. Detect
   the `NN CS` pack and normalise to per-case (or exclude from the discrepancy).
3. **Wine match rate** is the weak spot (vintage/varietal ambiguity); spirits
   match ~77%. Better vintage handling in the semantic step would help.
4. **`_apply_prices` for 3-dollar CASE rows**: re-check the BUY-PER-CS vs
   BEST-RIP-PER-BT assignment on rows that also carry a unit price, spot-check a
   sample after each run.

## Matching knobs (`matchv2.py`)

- `LLM_BATCH=25`, `LLM_WORKERS=8` (Claude runs in parallel; was sequential and
  took ~20 min, now ~3). Accept thresholds: HIGH if cosine>=0.86 & price within
  10%; MEDIUM if cosine>=0.80 & price within 7% & clear margin; else Claude.
- 700ml<->750ml treated as size-compatible in `_size_ok`.

## After any parser change: re-run, then the rows update

`python -m distributor_pipeline.run` re-extracts, re-stages (truncate-reload
per distributor_code), re-matches, and upserts local + Render. The crosswalk
rows update in place (append/upsert; other distributors untouched).
