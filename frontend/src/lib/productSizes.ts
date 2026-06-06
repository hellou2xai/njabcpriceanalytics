/**
 * useProductSizes — the single shared "products by size" tool.
 *
 * Every page that needs all the sizes of a product (the Product detail page,
 * the Products list card on expand, and anything future) calls THIS hook so the
 * grouping logic lives in one place.
 *
 * Our catalogue names a product's sizes inconsistently (Glenfiddich 12 is
 * "GLENFID MALT 12Y 12P" in 1L but "GLENFID MALT 12YR" in 750mL), so an exact
 * product_name match misses most sizes. The backend /product-variant-upcs
 * endpoint resolves the real variant set:
 *   - spirits: group by the Go-UPC enrichment-name core (+ a catalogue-name
 *     fallback for un-enriched SKUs), returning the variant UPCs;
 *   - wine: returns [] (a wine's identity is its name + vintage; its barcode is
 *     often the '0' placeholder), so we fall back to grouping by product_name,
 *     which already collects the wine's vintages.
 * Placeholder '0' barcodes are filtered server-side AND here so they can never
 * over-match in /search?upcs=.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { catalog } from './api';
import type { Product } from './api';

// Parse a size label ("750ML", "1.75L", "16OZ") to millilitres so sizes sort
// smallest -> largest. Unknowns sort last.
export function sizeToMl(label?: string | null): number {
  const s = (label || '').toUpperCase().trim();
  const m = s.match(/^([\d.]+)\s*(ML|L|LIT|LITER|OZ)?/);
  if (!m) return Number.MAX_SAFE_INTEGER;
  const n = parseFloat(m[1]);
  if (isNaN(n)) return Number.MAX_SAFE_INTEGER;
  const unit = m[2] || 'ML';
  if (unit.startsWith('L')) return n * 1000;
  if (unit === 'OZ') return n * 29.5735;
  return n;
}

/**
 * True bottles-per-case for per-bottle math.
 *
 * For most SKUs this is just `unit_qty`. But slash-multipacks encode the real
 * count in the NAME while `unit_qty` is the number of inner TRAYS: e.g.
 * "MAKERS MARK 120/12" (50mL) has unit_qty=10 — that's 10 trays of 12 = 120
 * bottles, so case ÷ 10 = the per-TRAY price ($35.90), not per-bottle. The name
 * "X/Y" self-validates (X ÷ Y must equal unit_qty), so when it does we trust X
 * as the true bottle count (case ÷ 120 = $2.99/bottle). When it doesn't match,
 * we never override — so this can only ever fix a known-wrong case.
 */
export function bottlesPerCase(productName?: string | null, unitQty?: string | number | null): number | null {
  const q = Number(unitQty);
  const qq = q > 0 ? q : null;
  const m = /\b(\d{2,3})\s*\/\s*(\d{1,2})\b/.exec(productName || '');
  if (m && qq) {
    const X = parseInt(m[1], 10), Y = parseInt(m[2], 10);
    if (Y > 0 && Math.round(X / Y) === Math.round(qq)) return X;   // self-validating
  }
  return qq;
}

export interface UseProductSizesResult {
  sizes: Product[];
  isLoading: boolean;
  isFetching: boolean;
  mode?: string;        // 'name_core' | 'wine_name' (from the backend)
}

export function useProductSizes(
  wholesaler: string,
  productName: string,
  upc?: string,
  enabled = true,
): UseProductSizesResult {
  const on = enabled && !!wholesaler && !!productName;

  // 1) Resolve the variant UPC set for this product.
  const { data: variant } = useQuery({
    enabled: on,
    staleTime: 60_000,
    queryKey: ['product-variant', wholesaler, productName, upc],
    queryFn: () => catalog.productVariantUpcs(wholesaler, productName, { upc }),
  });
  const variantUpcs = useMemo(
    () => (variant?.upcs ?? []).filter(u => u && u.replace(/^0+/, '')),
    [variant],
  );

  // 2) Load the rows — by exact UPC set (spirits) or by name (wine / fallback).
  const { data, isLoading, isFetching } = useQuery({
    enabled: on && variant !== undefined,
    staleTime: 60_000,
    queryKey: ['product-sizes', wholesaler, productName, variantUpcs.join(',')],
    queryFn: () => variantUpcs.length
      ? catalog.search({ wholesaler, upcs: variantUpcs.join(','), include_tiers: true, limit: 200, sort: 'product_name', order: 'asc' })
      : catalog.search({ q: productName, wholesaler, include_tiers: true, limit: 200, sort: 'product_name', order: 'asc' }),
  });

  const sizes = useMemo(() => {
    const rows = (data?.items ?? []) as Product[];
    // UPC path: every returned row is a size of this product. Name path: keep
    // only the exact product + wholesaler (collects a wine's vintages).
    const kept = variantUpcs.length
      ? rows.filter(r => r.wholesaler === wholesaler)
      : rows.filter(r => r.product_name === productName && r.wholesaler === wholesaler);
    // Collapse only EXACT duplicates (same name + size + vintage + upc). We do
    // NOT merge same-barcode variants like "MAKERS MARK 250TH" or a Festive
    // pack — those are distinct orderable SKUs (own cart line) the buyer must be
    // able to pick. They're disambiguated by their name on the row.
    const seen = new Set<string>();
    const deduped = kept.filter(r => {
      const k = `${r.product_name ?? ''}|${r.unit_volume ?? ''}|${String(r.vintage ?? '')}|${String(r.upc ?? '').replace(/^0+/, '')}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return deduped.sort((a, b) => sizeToMl(a.unit_volume) - sizeToMl(b.unit_volume));
  }, [data, productName, wholesaler, variantUpcs]);

  return {
    sizes,
    isLoading: on && (isLoading || variant === undefined),
    isFetching,
    mode: variant?.mode,
  };
}
