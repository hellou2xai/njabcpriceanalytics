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
import { isRealUpc } from './upc';

// Parse a size label ("750ML", "1.75L", "16OZ") to millilitres so sizes sort
// smallest -> largest. Unknowns sort last.
export function sizeToMl(label?: string | null): number {
  const s = (label || '').toUpperCase().trim();
  // Number is OPTIONAL: a bare unit means 1 of it, so "LITER"/"LTR"/"L" = 1L =
  // 1000mL (without this, "LITER" couldn't be parsed and sorted AFTER "1.75L").
  // Longest unit alternatives first so "LITER" isn't short-matched as "L".
  const m = s.match(/^([\d.]+)?\s*(MILLILITERS?|MILLILITRES?|LITERS?|LITRES?|ML|CL|LTR|LT|L|OZ)?\b/);
  if (!m) return Number.MAX_SAFE_INTEGER;
  const unit = m[2] || (m[1] ? 'ML' : '');
  if (!unit) return Number.MAX_SAFE_INTEGER;
  const n = m[1] ? parseFloat(m[1]) : 1;          // bare unit ("LITER") => 1
  if (isNaN(n)) return Number.MAX_SAFE_INTEGER;
  if (unit === 'OZ') return n * 29.5735;
  if (unit === 'CL') return n * 10;
  if (unit.startsWith('ML') || unit.startsWith('MILLIL')) return n;
  if (unit.startsWith('L')) return n * 1000;       // L, LT, LTR, LITER, LITRE
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
/**
 * Drop an embedded vintage year from a WINE header/title. Go-UPC enrichment
 * names often carry a stale vintage (e.g. "...Willamette Valley 2018" for a
 * product whose current vintage is different); the real vintage is shown
 * separately on the size rows. Only wine-family titles are touched, and only a
 * plausible vintage range (1950-2039) so brand numbers like "1924" or "1800"
 * survive. Display-only — never use the result to resolve a product.
 */
export function stripHeaderVintage(name?: string | null, productType?: string | null): string {
  const s = String(name ?? '');
  if (!s) return s;
  const isWine = /wine|sparkling|vermouth|champagne|port|sherry/i.test(productType || '');
  if (!isWine) return s;
  return s.replace(/\b(?:19[5-9]\d|20[0-3]\d)\b/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

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
  isError: boolean;     // the SIZES load failed — caller should show retry, not spin
  refetch: () => void;
  mode?: string;        // 'name_core' | 'wine_name' (from the backend)
}

export function useProductSizes(
  wholesaler: string,
  productName: string,
  upc?: string,
  enabled = true,
  // When true, also pull the SAME product's listings at OTHER distributors
  // (matched by the shared real UPCs) and merge them in. A pure enhancement —
  // it never blocks the page; if it errors we just show this distributor.
  allDistributors = false,
): UseProductSizesResult {
  const on = enabled && !!wholesaler && !!productName;

  // 1) Resolve the variant UPC set for this product. This is an OPTIMISATION
  //    (it finds inconsistently-named sizes); it is NOT required to render. So
  //    we never block on it: if it errors or returns nothing, step 2 falls back
  //    to the exact-name search. The old gate (`variant !== undefined`) treated
  //    "errored" and "still loading" identically, so any blip on this call hung
  //    the page on "Loading sizes…" forever — that is the bug this fixes.
  const variantQ = useQuery({
    enabled: on,
    staleTime: 60_000,
    retry: 1,
    meta: { background: true },
    queryKey: ['product-variant', wholesaler, productName, upc],
    queryFn: () => catalog.productVariantUpcs(wholesaler, productName, { upc }),
  });
  // "Settled" = success OR error (no longer pending). On error we proceed with
  // an empty UPC set, which routes step 2 down the name fallback.
  const variantSettled = !on || variantQ.isSuccess || variantQ.isError;
  const variantUpcs = useMemo(
    () => (variantQ.data?.upcs ?? []).filter(u => isRealUpc(u)),
    [variantQ.data],
  );

  // 2) Load the rows — by exact UPC set (spirits) or by name (wine / fallback).
  const sizesQ = useQuery({
    enabled: on && variantSettled,
    staleTime: 60_000,
    retry: 1,
    meta: { background: true },
    queryKey: ['product-sizes', wholesaler, productName, variantUpcs.join(',')],
    queryFn: () => variantUpcs.length
      ? catalog.search({ wholesaler, upcs: variantUpcs.join(','), include_tiers: true, limit: 60, sort: 'product_name', order: 'asc' })
      : catalog.search({ q: productName, wholesaler, include_tiers: true, limit: 60, sort: 'product_name', order: 'asc' }),
  });
  const { data, isFetching } = sizesQ;

  // This distributor's rows for the product. UPC path: every returned row is a
  // size of this product. Name path: keep only the exact product + wholesaler
  // (collects a wine's vintages).
  const ownKept = useMemo(() => {
    const rows = (data?.items ?? []) as Product[];
    return variantUpcs.length
      ? rows.filter(r => r.wholesaler === wholesaler)
      : rows.filter(r => r.product_name === productName && r.wholesaler === wholesaler);
  }, [data, variantUpcs, wholesaler, productName]);

  // 3) Cross-distributor (opt-in): the SAME product at other distributors shares
  //    these real UPCs (taken from this product's OWN kept rows, so it can't
  //    pull in unrelated SKUs). Searched across ALL distributors and merged.
  //    Gated + fault-tolerant so it can never hang or block the primary sizes.
  const crossUpcs = useMemo(() => {
    const fromOwn = ownKept.map(r => r.upc).filter(u => isRealUpc(u)) as string[];
    return [...new Set([...variantUpcs, ...fromOwn])];
  }, [variantUpcs, ownKept]);
  const crossQ = useQuery({
    enabled: on && allDistributors && crossUpcs.length > 0,
    staleTime: 60_000,
    retry: 1,
    meta: { background: true },
    queryKey: ['product-sizes-cross', crossUpcs.join(',')],
    queryFn: () => catalog.search({ upcs: crossUpcs.join(','), include_tiers: true, limit: 60, sort: 'product_name', order: 'asc' }),
  });

  const sizes = useMemo(() => {
    // Other distributors' listings of the same UPCs (when allDistributors).
    const crossRows = allDistributors ? ((crossQ.data?.items ?? []) as Product[]) : [];
    // Collapse only EXACT duplicates (same DISTRIBUTOR + name + size + vintage +
    // upc) — wholesaler is part of the key so two distributors' listings of the
    // same SKU both survive. We do NOT merge same-barcode variants like "MAKERS
    // MARK 250TH" or a Festive pack — distinct orderable SKUs the buyer picks.
    const seen = new Set<string>();
    const deduped = [...ownKept, ...crossRows].filter(r => {
      const k = `${r.wholesaler}|${r.product_name ?? ''}|${r.unit_volume ?? ''}|${String(r.vintage ?? '')}|${String(r.upc ?? '').replace(/^0+/, '')}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    // Smallest -> largest by physical size (LITER = 1000 mL, so it lands AFTER
    // 750 mL), then by distributor so same-size listings group together.
    return deduped.sort((a, b) =>
      sizeToMl(a.unit_volume) - sizeToMl(b.unit_volume) || a.wholesaler.localeCompare(b.wholesaler));
  }, [ownKept, crossQ.data, allDistributors]);

  return {
    sizes,
    // Loading ONLY while we genuinely expect sizes and have neither data nor an
    // error yet. A failed variant lookup no longer counts as "loading" (step 2
    // takes over); a failed sizes search surfaces as isError, not a spinner.
    isLoading: on && !sizesQ.isSuccess && !sizesQ.isError,
    isFetching,
    isError: on && sizesQ.isError,
    refetch: () => { variantQ.refetch(); sizesQ.refetch(); },
    mode: variantQ.data?.mode,
  };
}
