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

## Remaining (operational — do from the other PC)
- [ ] **Rebuild derived tables** so the `cross_source_links` pack fix hits real data:
      `python run_etl.py --derive-only`  (then commit the rebuilt parquet if tracked).
- [ ] **Deploy / restart** backend + frontend; the live-query + UI fixes need the new
      build serving (Render serves the old build ~5–8 min).
- [ ] **Verify on prod** (per CLAUDE.md): on the Opici Castiglioni Chianti card the
      "Best price: Allied" chip should be GONE (Opici '24 vs Allied '24 are tied $104);
      the Allied '23 5cs Active-now $100 deal stays on the '23 row only. In the cart,
      the Opici line should offer the distributor switch (Opici/Allied/Fedway).

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
