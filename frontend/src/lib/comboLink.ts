/**
 * useComboLink — shared "is this SKU in a combo?" resolver.
 *
 * Combo membership isn't reliable on the catalogue row (combo_code is often
 * '0'); the authoritative source is the combo index (deals.comboIndex), keyed
 * by wholesaler + normalised UPC. Returns a function that maps a (wholesaler,
 * upc) to a /combos deep link (or null). Reused by the Products list + detail
 * so the combo sticker behaves identically everywhere. Navigating via a
 * react-router Link keeps the browser Back button returning to the product.
 */
import { useQuery } from '@tanstack/react-query';
import { useMemo, useCallback } from 'react';
import { deals } from './api';

export function useComboLink() {
  const { data } = useQuery({
    queryKey: ['combo-index'],
    queryFn: () => deals.comboIndex(),
    staleTime: 300_000,
  });
  const map = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of data?.items ?? []) m.set(`${c.wholesaler}|${c.upc_norm}`, c.combo_code);
    return m;
  }, [data]);
  return useCallback((wholesaler: string, upc?: string | null): string | null => {
    const norm = String(upc ?? '').replace(/^0+/, '');
    const code = norm ? map.get(`${wholesaler}|${norm}`) : undefined;
    return code ? `/combos?code=${encodeURIComponent(code)}` : null;
  }, [map]);
}
