# CELR Product Number: family grouping across sizes and distributors

Design for the persistent product identity the app is missing. Drafted
2026-06-11 from the user's direction plus industry research. Status: design
agreed in principle, implementation pending.

## The problem

A barcode (UPC/GTIN) identifies ONE size and pack of a product, never the
product family. That is by GS1 design: every size, pack count, or bundle
change requires a new GTIN. So grouping by UPC (phase 1, commit da6502a)
correctly merged distributor name variants of one SKU, but split a product's
sizes into separate cards, because each size is its own barcode.

What buyers think in is the FAMILY ("Glenlivet Founders Reserve"), then pick
a variant (size, pack, vintage). Marketplaces like Provi model exactly this:
one product card, variants underneath. The family key does not exist in any
distributor file, so CELR must mint its own: the **CELR Product Number (CPN)**.

## Identity model: three levels

1. **Family (CPN)**: what the product IS. One card in the Products grid.
2. **Variant**: a specific size/pack/vintage of the family. One barcode
   (usually), one size row under the card.
3. **Listing**: one distributor's row for a variant (own name spelling, own
   item number, own price). Shown under the variant with the distributor's
   exact name and item number, per the user's requirement.

## Family vs variant attributes by product type

The split below decides what makes two rows the SAME family. Family
attributes differ by type; variant attributes are always size + pack (+
package type), plus the type-specific ones marked V.

| Type | Family identity | Variant (V) |
|---|---|---|
| Wine | producer/brand + label (cuvee) + varietal + appellation/colour | vintage (V), size, pack |
| Spirits | brand + expression + spirit type + AGE statement + flavour (+ proof when it names the product, e.g. ABSOLUT 80) | size, pack |
| Beer | brewery + brand line + style | package type can/btl/keg (V), container oz (V), pack count (V) |
| RTD / FAB / Seltzer | brand + flavour or variety-pack name + ABV tier | package, oz, pack count |
| Cider / Sparkling | producer + label (+ sweetness) | vintage where present, size, pack |

User-confirmed simplifications that anchor v1: spirits group on
name + age (sizes are variants; age formats differ per distributor),
wine groups on name (vintage and size are variants).

## Normalization dictionary (the "smart" part)

Distributors write the same attribute differently; matching runs on
normalized tokens, never raw strings:

- **Age**: `12Y` = `12YR` = `12 YR` = `12 YEAR` = `12-year-old` -> `AGE:12`.
- **Size**: reuse `sizeToMl` semantics: `1.75L` = `1750ML`; `LITER` = `1L`;
  beer in oz. Size tokens are STRIPPED from family cores (they are variant).
- **Pack**: `6P`/`6PK`/`BAG6P`/`2/12` -> pack attrs, stripped from cores.
  Allied-style pack-code suffixes (`A226P`, `196P`, `216P`) are junk tokens.
- **Vintage**: 4-digit years and 2-digit name suffixes (`SV 23`) -> variant
  attribute for wine, stripped from the family core.
- **Abbreviations**: expansion dictionary seeded from enrichment names
  (`DC` -> DIRECTOR'S CUT, `CAB`/`CS` -> CABERNET SAUVIGNON, `CHARD`,
  `PN` -> PINOT NOIR, `VAP` value-added pack, `W/` -> WITH ...). The Go-UPC
  enrichment name is the PREFERRED source for the family core because it is
  already unabbreviated; catalogue-name parsing is the fallback.
- **Junk**: `OLD LOT`, closeout markers, glass/VAP suffixes -> ignored for
  identity, preserved on the listing display.

## v2 revision (2026-06-11, after the Jim Beam Orange live test)

v1 keyed identity off Go-UPC enrichment names and split one product five
ways: enrichment names vary in descriptor verbosity ("Jim Beam Orange" vs
"... Kentucky Straight Bourbon Whiskey") and are sometimes garbage ("Beam
Banner Jim Orange Pet"; "Kyocera Test Artist" for placeholder barcode
111111111117, which also passed the clean-barcode check). User-confirmed v2
order, implemented in backend/celr.py + the union-find builder:

1. **Name clustering first**: catalogue-name token signatures are the
   primary identity signal (distributor names are consistent).
2. **Barcode equality second**: the same real barcode anywhere = the same
   family, stitching distributors whose name spellings differ.
3. **Sizes/distributor listings group UNDER the family** as variants.
4. Trusted enrichment (shares >=1 significant token with the catalogue
   name) only BRIDGES abbreviation variance and supplies header_name;
   untrusted enrichment is ignored entirely.
5. Repeated-digit placeholder barcodes are not identity nodes; their rows
   join families AT SERVING TIME by name key (celr_family_keys), so
   **nothing is ever hidden** — grouping only decides which card a listing
   sits under.

## Grouping algorithm (deterministic cascade, future-proof)

Run after every monthly ingest; incremental and idempotent:

1. **Pass 0, barcode unification**: normalized UPC equal -> same VARIANT,
   across all distributors. (Known data quirk: Allied reuses a barcode
   across distinct products, e.g. Coppola Chard + Pinot on 739958057209.
   When one UPC carries multiple distinct family cores, the variant keeps
   per-listing families rather than force-merging.)
2. **Pass 1, enrichment core**: family key from Go-UPC name + brand with the
   normalization dictionary applied (strip variant tokens, expand
   abbreviations, normalize age).
3. **Pass 2, catalogue-name core** for unenriched rows, with per-type rules
   (wine keeps varietal tokens, strips vintage; spirits normalize age).
4. **Pass 3, similarity join**: brand-scoped token-set matching of a new core
   against existing family cores; join only above a high threshold.
   **Below threshold always mints a NEW family: wrong splits are cheap to
   merge later, wrong merges corrupt history.**
5. **Persistence**: `celr_families` (cpn PK, family_key UNIQUE, header_name,
   brand, product_type, attrs) + `celr_product_upcs` (upc_norm PK, cpn) in
   Postgres (durable across monthly reloads), exported to parquet for local
   dev, loaded into the DuckDB cache for serving. CPNs are monotonic and
   never reused. Manual corrections live in a merge/alias table
   (cpn -> canonical cpn) so re-runs cannot undo a human decision.
6. **New items** (the future-proofing): a new UPC either lands in an existing
   family via passes 1-3 or mints the next CPN. Existing assignments are
   never recomputed, so numbers are stable forever.

## Naming convention (the new columns)

Two display columns, following the attribute order used by state-portal
naming standards (producer, brand, flavour/varietal, appellation, type,
age, vintage, size):

- **`header_name`** (family level, on `celr_families`): standardized,
  unabbreviated, no size/pack/vintage. e.g.
  `Coppola Director's Cut Cabernet Sauvignon`,
  `Glenlivet Founders Reserve`, `Don Q Cristal Rum`.
  Built from the enrichment name when available, else the best catalogue
  name (most common, junk-free, longest), title-cased with the dictionary.
- **`celr_product_number`**: rendered `CELR-000123`. Shown as a small chip on
  the card header and the product page, searchable.
- Variant line under the header: `750ML · 6 btl/cs · 2023` (wine adds
  vintage, spirits add age only if it distinguishes variants).
- Listing line keeps the distributor's exact `product_name` + item number
  (ABG/Fedway SKU) + UPC, unchanged, exactly as today's size rows do.

## Serving

`catalog /search` post-processing replaces the current grouping cascade:
rows whose UPC has a CPN get `product_group = "cpn:<n>"`,
`product_display = header_name`, plus `celr_product_number`; rows without a
CPN keep the current phase-1/phase-2 behaviour as fallback. The frontend
`groupByProduct` needs no structural change (it already groups on
`product_group`); the card header gains the CPN chip.

## Rollout

1. Registry build script + Postgres tables + parquet export, backfill from
   the current edition, wire into the ingest pipeline steps.
2. Serve CPN in `/search`, switch grid grouping, CPN chip in UI.
3. Curation: admin merge/split screen feeding the alias table; assistant
   exposure ("show me everything under CELR-000123").

## Sources consulted

- GS1 GTIN Management Standard: pack/size changes require a new GTIN; family
  grouping is a separate construct above the GTIN.
- PLCB vendor e-commerce naming conventions: attribute order for spirits and
  wine product names.
- Provi / SevenFifty marketplace model: one product, variants by size/pack,
  ~750k-product canonical catalogue layered over 1,200+ distributor files.
- Wine data models (Wine-Searcher, db.wine, X-Wines): producer / label /
  varietal / appellation as identity, vintage as variant.
- Liquor POS inventory guides (Bottle POS etc.): clean size ladders under one
  product, avoid per-batch volatile attributes in identity.
