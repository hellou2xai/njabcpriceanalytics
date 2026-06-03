# Claude Code Prompt: Distributor Price Book to UPC Crosswalk Pipeline (Fedway + Allied, June 2026)

Build a Python pipeline that extracts NJ distributor monthly price book PDFs into a staging table, matches every item to my existing UPC master data, resolves ambiguous matches using frontline price, and loads a final enriched table. The pipeline is distributor-agnostic: one shared staging/matching/loading core, plus one parser module per distributor. Process both books in this run: Fedway (distributor_code FEDWAY) and Allied Beverage Group (distributor_code ALLIED).

## Inputs

- ./input/Fedway_Pricebook_Full_June_2026.pdf (text-layer PDF, 299 pages, use pdfplumber or pdftotext -layout, NOT OCR)
- ./input/2026-06_Price_Book.pdf = Allied Beverage Group June 2026 (text-layer PDF, 256 pages, same extraction tools, NOT OCR)
- UPC master data already lives in my local Postgres. Connect via env vars (PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD), use psycopg2 or SQLAlchemy. Find the UPC table yourself: you have memory of this database from prior sessions, and if needed query information_schema for tables with a upc column. Infer the column mapping (upc, product_name, brand, size_ml, pack_qty, category, price) from column names and sample rows. Determine from the data whether the price column is retail or cost by comparing magnitudes against the Fedway bottle prices after extraction, and set the pass 3 tolerance accordingly. Do not stop to ask me anything, run end to end

## Step 1: Fedway section routing

The Fedway book has distinct sections. Parse only these page ranges for items, route each through the right parser:

- Pages 67-161 SPIRITS, 162-179 CANS AND COCKTAILS, 180 MALT, 181-278 WINE, 279-285 NON ALCOHOLIC/GLASSWARE/MIXERS, 286-292 CRAFT DISTILLED, 293-298 SAKE/HIGHLY RATED: all use the 3-column catalog format (parser A)
- Pages 22-27 BEST DEAL ALL BUY-INS and 28-32 PARTIAL MONTH: tabular format with zero-padded item numbers like (000547820) (parser B)
- Pages 33-55 RETAIL INCENTIVES: brand-level deal tiers like "2 Cs/$12, 4 Cs/$48" (parser C)
- Pages 56-66 COMBO PACKS: bundle SKUs (parser D)
- Skip pages 1-21 and 299+

Do not hardcode these page numbers as the only mechanism. Detect the section from the page header line (format: "Order Phone: 800-4-FEDWAY  {SECTION NAME}  Order Fax: ...") so the pipeline survives next month's pagination changes. Use the page ranges above only to validate detection.

## Step 2: Fedway catalog parser (parser A)

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

## Step 2b: Allied (ABG) section routing and parser

Allied's book is a different layout. Section map for June 2026 (detect from page headers, do not hardcode):

- Pages 2-7 INVENTORY REDUCTION: clean table (product code, description, size, pack, original case/bottle, best case/bottle, savings). Parse into staging with raw_attributes flag inventory_reduction=true
- Pages 8-10 ABG NEW ITEMS: table (category, brand, description, size, SKU, pack, availability). Parse, mark is_changed=true
- Pages 11-14 PARTIALS/WEB RIPS: table (description, size, start_date, end_date, RIP like "1CASE=$36", "3BOTTLES=$21", multiple tiers per item). Parse into deals with date bounds. No item codes here, link by normalized description+size where possible, otherwise store unlinked with the raw description
- Pages 15-16 KEG LIST: parse if item codes present, else skip
- Pages 17-25 ABG COMBOS: table (category, SKU, item, contains, front line price) into the combos table
- Pages 26-31 intro/retail incentive notes: skip
- Pages 32-72 RETAIL INCENTIVES: visual brand-card layout with item numbers, low text fidelity. Skip for item extraction, the catalog section carries the deal data anyway
- Pages 74-256 CATALOG: the main item listing, category per page header (BLENDED WHISKEY, TEQUILA, VODKA, WINES OF CALIFORNIA, BURGUNDY RED, PORT & MADEIRA, NON-ALCOHOLIC, HEMP BEVERAGES, etc.)

Allied catalog format (3 columns per page, like Fedway, but different hierarchy and line shapes):

- Category comes from the page header line, not in-column banners. Map Allied wine-region categories (WINES OF CALIFORNIA, BURGUNDY RED) into category=WINE with type/country derived from the header text, so both distributors normalize into the same category/type/country columns
- Column header row: Code No., Size, Pk, P.O., Case Cost, Btl Cost, Best Buy, Best Rip
- BRAND headers are centered caps lines (BIB & TUCKER, BRECKENRIDGE, BLOOD OATH)
- PRODUCT label lines may carry warehouse availability codes like "FB ( L GS JD IV )" or "JD ( L GS FB IV )". Store the whole string in program_flags. Codes are warehouse identifiers, codes outside the parens differ from those inside, keep raw
- Item line: `2227040 750ML 6  259.98 43.33  120.00/2C`
  - 7-digit item code, size (750ML, 1.75L, LITER, 200ML, 50 ML, 700ML, CMB), pack, case_cost (= front_line_case_price), bottle_cost (= bottle_price), optional deal
  - Deal format is amount-first: `120.00/2C` = $120 off at 2 cases, `37.00/24B` = $37 at 24 bottles, also `1000.00/12C`. Regex: `([\d,]+\.\d{2})/(\d+)(C|B)`. Note this is reversed from Fedway's tier-first format, normalize both into (tier_qty, tier_unit, discount_amount)
  - Net-price sub-lines like `$12.00 ON 1CS  348.00  29.00` = after a 1-case rip of $12, net case 348.00, net bottle 29.00. Store net bottle as best_rip_bottle_price and the rip amount as a deal row with tier 1C
  - "NEW" marker near an item = is_changed true
- Inline combos inside the catalog: item code with size CMB, a "CONTAINS:" line follows. Route to the combos table with contents_raw from the CONTAINS line, do not put CMB rows in the items table
- Size normalization additions: LITER=1000, 1.75L=1750, 700ML=700, 19.5L=19500, CMB=combo flag not a size

Allied item code normalization: 7-digit codes, apply the same item_number_norm padding rule used for Fedway so the column is consistent, but uniqueness is always within distributor_code, codes can collide across distributors.

## Step 3: Staging table (distributor-agnostic)

Table: stg_distributor_items
- distributor_code (FEDWAY or ALLIED), source_file, price_book_month (2026-06, reference only), extracted_at
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
2. Extract Fedway to staging, then Allied to staging (separate parser modules, shared staging writer)
3. Run matching passes 1-3 across all staged items (skip the LLM pass unless HIGH+MEDIUM match rate is below 70% for a distributor, then run it on that remainder)
4. Build the final crosswalk locally, push it to Render
5. Write all reports to ./output/ and finish with a summary per distributor: rows extracted per section, match rate by confidence tier, rows pushed to Render, top 10 unmatched items by case price so I can see what high-value items still need manual mapping. Also report items matched to the same UPC from both distributors, that overlap is the price comparison set and the most valuable output

If something blocks the run (Render connection fails, UPC table genuinely ambiguous), make the safest reasonable choice, log it in the summary, and keep going. Only halt for destructive risks, never overwrite or drop any existing table other than the staging tables defined here.
