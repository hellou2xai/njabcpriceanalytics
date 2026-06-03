# Claude Code Prompt: Distributor Price Book to UPC Crosswalk Pipeline (Fedway June 2026)

Build a Python pipeline that extracts the Fedway monthly price book PDF into a staging table, matches every Fedway item to my existing UPC master data, resolves ambiguous matches using frontline price, and loads a final enriched table. The schema must be distributor-agnostic because I will reuse the same pipeline and tables for other NJ distributors (Allied, Opici, Fedway updates each month, etc.).

## Inputs

- ./input/Fedway_Pricebook_Full_June_2026.pdf (text-layer PDF, 299 pages, use pdfplumber or pdftotext -layout, NOT OCR)
- UPC master data already lives in my local Postgres. Connect via env vars (PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD), use psycopg2 or SQLAlchemy. Find the UPC table yourself: you have memory of this database from prior sessions, and if needed query information_schema for tables with a upc column. Infer the column mapping (upc, product_name, brand, size_ml, pack_qty, category, price) from column names and sample rows. Determine from the data whether the price column is retail or cost by comparing magnitudes against the Fedway bottle prices after extraction, and set the pass 3 tolerance accordingly. Do not stop to ask me anything, run end to end

## Step 1: PDF section routing

The book has distinct sections. Parse only these page ranges for items, route each through the right parser:

- Pages 67-161 SPIRITS, 162-179 CANS AND COCKTAILS, 180 MALT, 181-278 WINE, 279-285 NON ALCOHOLIC/GLASSWARE/MIXERS, 286-292 CRAFT DISTILLED, 293-298 SAKE/HIGHLY RATED: all use the 3-column catalog format (parser A)
- Pages 22-27 BEST DEAL ALL BUY-INS and 28-32 PARTIAL MONTH: tabular format with zero-padded item numbers like (000547820) (parser B)
- Pages 33-55 RETAIL INCENTIVES: brand-level deal tiers like "2 Cs/$12, 4 Cs/$48" (parser C)
- Pages 56-66 COMBO PACKS: bundle SKUs (parser D)
- Skip pages 1-21 and 299+

Do not hardcode these page numbers as the only mechanism. Detect the section from the page header line (format: "Order Phone: 800-4-FEDWAY  {SECTION NAME}  Order Fax: ...") so the pipeline survives next month's pagination changes. Use the page ranges above only to validate detection.

## Step 2: Catalog parser (parser A)

Three vertical columns per page. Segment by x-coordinate first (pdfplumber word boxes), then process each column top to bottom with a hierarchy state machine:

CATEGORY banner (SPIRITS/WINE) > TYPE banner (STILL, WHISKIES, RED, WHITE) > COUNTRY banner (USA, CANADA, FRANCE) > BRAND banner (caps, may carry program flags like "F LA GP JNC" on the right) > PRODUCT label line (may be followed by an italic description line, store as product_notes).

Item blocks under a product:
```
       55920 375 ML 24 PK   80.0 PF                JUN    15C\$270
RIP: 324             1 BOTTLE                                $7.49
                     1 CASE              $179.76             $7.49
```
- Item line: item_number, size, pack_qty, proof or vintage (PF = proof for spirits, VTG = vintage year for wine, capture which)
- Leading "+" on item number = changed/new this month, store as boolean, strip it
- Merge BOTTLE/CASE/SLEEVE child rows into one item record: front_line_case_price (BUY PER CS column), bottle_price, best_rip_bottle_price (BEST RIP PER BT column)
- "/OZ" and "/EA" values go to (unit_price, unit_of_measure)
- "RIP: 324" attaches rip_id to the item
- Deal strings: `(\d+)C\\?\$(\d+)` = case tier, `(\d+)B\\?\$(\d+)` = bottle tier. Month code (JAN-DEC) nearby = effective month. One item can have multiple tiers
- Normalize size to size_ml: 750 ML=750, 1 LT=1000, 1.75LT=1750, 50 ML=50, 12 OZ=355, etc.

## Step 3: Staging table (distributor-agnostic)

Table: stg_distributor_items
- distributor_code (FEDWAY), source_file, price_book_month (2026-06), extracted_at
- item_number_raw, item_number_norm (zero-pad to 9 digits so catalog 55920 joins Best Deal 000559200; verify padding rule against actual data before assuming)
- category, type, country, brand, product_name, product_notes, program_flags
- size_raw, size_ml, pack_qty, proof, vintage
- front_line_case_price, bottle_price, best_rip_bottle_price, unit_price, unit_of_measure
- rip_id, is_changed
- raw_attributes (JSON column for anything distributor-specific that doesn't fit, so other distributors never force schema changes)

Child tables: stg_distributor_deals (item ref, tier_qty, tier_unit, discount_amount, effective_month, source_section), stg_distributor_combos (combo item_number, title, contents_raw, savings_amount, case_price).

## Step 4: UPC matching

No UPCs exist in the price book, so match on name + size + price. Run in passes, tag each match with match_method and match_confidence:

Pass 1, blocking: candidate pairs must agree on size_ml (exact) and share a brand token. Normalize both sides first: uppercase, strip punctuation, expand common abbreviations (CHARD=CHARDONNAY, CAB=CABERNET, SAUV=SAUVIGNON, PN=PINOT NOIR, PG=PINOT GRIGIO, BBN=BOURBON, WHSKY=WHISKEY), remove size/pack tokens from names.

Pass 2, scoring within block: rapidfuzz token_set_ratio on normalized brand+product strings. Score >= 92 and a gap of >= 5 points to the runner-up = auto-match (confidence HIGH).

Pass 3, price disambiguation: when 2+ candidates score within 5 points of each other, compare the UPC record's known_price to Fedway bottle_price. Pick the candidate whose price ratio is most plausible and within tolerance (configurable, default: known retail between 1.1x and 1.8x of Fedway bottle cost if known_price is retail; if known_price is cost, within 10%). Tag confidence MEDIUM with price_delta stored.

Pass 4, semantic fallback for unresolved: batch the remaining ambiguous sets through the Anthropic API (one call per batch of 50, structured JSON out) asking which UPC name refers to the same physical product as the Fedway listing, with size and price as context. Tag confidence LLM. Make this pass optional behind a --use-llm flag.

Anything still unresolved goes to match_review.csv with all candidates and scores. Never silently drop or silently auto-pick.

## Step 5: Final enriched table

Table: dim_distributor_upc_crosswalk
- upc, upc_product_name (from my master)
- All enrichment from staging: distributor_code, item_number_norm, brand, product_name, size_ml, pack_qty, proof/vintage, front_line_case_price, bottle_price, best_rip_bottle_price, rip_id, program_flags, price_book_month (reference column only, not part of any key)
- match_method, match_confidence, match_score, price_delta
- Unique key: (distributor_code, item_number_norm). Reloading a newer book upserts the row (ON CONFLICT DO UPDATE), price_book_month just records which book the current values came from. Other distributors land in the same table under their own distributor_code

Also produce: unmatched_fedway.csv (items with no UPC), unmatched_upc.csv (UPCs in my master with no Fedway item, useful to see what I stock that Fedway doesn't carry), match_review.csv.

## Storage

Staging and matching run against local Postgres (same database as the UPC master): stg_distributor_items, stg_distributor_deals, stg_distributor_combos in a staging schema, truncate-and-reload per distributor_code per run.

The final dim_distributor_upc_crosswalk gets pushed to my Render-hosted Postgres. Connection string in env var RENDER_DATABASE_URL (require SSL, sslmode=require). Create the table there if it doesn't exist, upsert via ON CONFLICT (distributor_code, item_number_norm). Also keep a local copy of the final table and dump CSV exports of the final table plus all review/validation files to ./output/. Keep the writer behind a class interface (LocalPostgresWriter, RenderPostgresWriter) so future targets drop in without touching parse or match code.

## Validation

- Reconcile counts: items parsed per section vs lines logged as unparsed (unparsed_lines.csv with page, column, y-position, text)
- Sanity check: pack_qty * bottle_price within 25% of case price where both exist, log outliers
- Match rate report: % HIGH / MEDIUM / LLM / unresolved, by category
- Spot-check sample: print 20 random HIGH matches for my eyeball review before the final load

## Build order (autonomous, no check-ins)

Run the whole thing end to end without stopping to ask me anything. Sequence:

1. Connect to local Postgres, locate the UPC table from memory or information_schema, infer column mapping
2. Extract all sections of the PDF to staging
3. Run matching passes 1-3 (skip the LLM pass unless match rate for HIGH+MEDIUM is below 70%, then run it on the remainder)
4. Build the final crosswalk locally, push it to Render
5. Write all reports to ./output/ and finish with a summary: rows extracted per section, match rate by confidence tier, rows pushed to Render, top 10 unmatched Fedway items by case price so I can see what high-value items still need manual mapping

If something blocks the run (Render connection fails, UPC table genuinely ambiguous), make the safest reasonable choice, log it in the summary, and keep going. Only halt for destructive risks, never overwrite or drop any existing table other than the staging tables defined here.
