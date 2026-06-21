# SKU Identity — TODO / status

**Rule:** a product's SKU identity = **barcode (upc_norm) + bottle size (normalized ml)
+ pack (unit_qty, bottles/case) + vintage**. A single barcode is polysemous — it can
carry two vintages ('23 AND '24, e.g. UPC `839183000060`) or two packs (6P/12P).
Every group / dedup / react-key / compare / match on products MUST use all four
dimensions. Partial keys silently weld distinct SKUs — the recurring bug class.

**Vintage nuance (important):**
- Vintage IS identity for **pricing / cart / lists / compare / best-price** — a '23
  and a '24 are different SKUs the buyer chooses between.
- Vintage is NOT a lifecycle/churn event — a '24 succeeding a '23 is normal wine
  continuity. So `item_lifecycle` (derive.py ~276) stays vintage-agnostic. RESOLVED —
  no change needed there.

## Done (committed to main, this session)
- [x] `cart.py` comparison/switch/pricing + `cart_items`/`list_items` now persist
      `unit_qty` + `vintage`; unique keys include them. (`85d592f`)
- [x] `DistCompareChip` group key + `ProductsGrid` sizeSibs → full identity. (`4ceb047`)
- [x] `catalog.py:1231` search dedup → add `unit_qty`. (`7eea8ad`)
- [x] `deals.py:1490` time-sensitive dedup → add `unit_volume`+`unit_qty`+`vintage`. (`7eea8ad`)
- [x] `ProductsGrid` card grouping + `countProductGroups` → add vintage (`normVtg`). (`7eea8ad`)
- [x] `CatalogTable` cartByKey / RIP-banner / stepper keys → add pack+vintage;
      its Add-to-cart/list carry full identity. (`7eea8ad`)
- [x] `derive.py:987` cross_source_links → require equal pack (vintage left free,
      re-checked downstream). (`7eea8ad`)
- [x] Products-page Add-to-cart / Add-to-list pass `unit_qty` + `vintage`.
- [x] Add-to-cart defaults to 1 case when no qty set; cart + lists show "Vintage NNNN".

## Remaining (operational) — DONE 2026-06-21 from office PC
- [x] **Rebuild derived tables** so the `cross_source_links` pack fix hits real data:
      re-derived locally (`build_all`) and re-ingested to prod Postgres. The equal-pack
      filter dropped the pack-mismatched welds: `cross_source_links` 7333 -> 5504.
      Verified prod Postgres matches the freshly-built local signature.
- [x] **Deploy / restart**: SKU-identity code is on `main` (`21bb88f`); empty-commit
      redeploy (`de0fb3d`) rebuilt the prod cache from the updated Postgres.
- [~] **Verify on prod** (per CLAUDE.md):
      - Data layer VERIFIED: catalog search returns Allied '23 (CHIAN23) and '24
        (CHIAN24) as SEPARATE rows; Opici '24 and Allied '24 both $104 (tied), so the
        grid no longer has a cheaper Allied to flag. `cross_source_links` corrected.
      - Frontend acceptance (eyeball in browser): the Opici Castiglioni Chianti card's
        "Best price: Allied" chip should be GONE, and the cart Opici line should offer
        the distributor switch. DistCompareChip computes client-side from the grid's
        size rows (no endpoint), so it follows from the verified data + deployed code.

## Intentional — DO NOT "fix" (detectors whose job is to find partial-key collisions)
- `catalog.py:3276/3399/3639` ambiguous-barcode finders, `:3430` stub+real,
  `:3452` multi-pack history, `deals.py:508` combo-dup.

## Related / separate (paused earlier)
- [ ] Product-level CELR family enrichment (predetermined name match; Allied↔Fedway
      primary, Opici secondary) — was paused awaiting an a/b decision.

## Canonical helpers (use these; don't re-derive partial keys)
- Backend: `_size_ml_key`, `_qty_key`, `_vtg_key`, `_spv`, `_ident_text` in
  `backend/routers/cart.py`.
- Frontend: `normPack`/`normVtg` (ProductsGrid, CatalogTable),
  `sizeToMl`/`bottlesPerCase` (`lib/productSizes`).
