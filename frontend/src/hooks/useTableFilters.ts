import { useMemo, useState } from 'react';

export interface FilterState {
  search: string;
  productType: string;
  distributor: string;
  priceMin: string;
  priceMax: string;
  deal: 'all' | 'discount' | 'rip' | 'closeout';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface FilterConfig<T extends Record<string, any>> {
  nameKeys: (keyof T)[];
  upcKeys: (keyof T)[];
  productTypeKey?: keyof T;
  distributorKey?: keyof T;  // enables the distributor filter
  priceKey?: keyof T;       // enables the price-range filter
  discountKey?: keyof T;    // enables "Has discount"
  ripKey?: keyof T;         // enables "Has RIP"
  closeoutKey?: keyof T;    // enables "Closeout"
}

const EMPTY: FilterState = { search: '', productType: '', distributor: '', priceMin: '', priceMax: '', deal: 'all' };

/**
 * Shared faceted filtering for every data table / popup: free-text search
 * (name + UPC), category, price range, and deal flags. Returns the filtered
 * rows plus the filter state and a setter so the filter bar can render the
 * matching controls. Only the facets whose config key is supplied are applied.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useTableFilters<T extends Record<string, any>>(
  items: T[] | undefined,
  config: FilterConfig<T>,
) {
  const [state, setState] = useState<FilterState>(EMPTY);
  const set = (patch: Partial<FilterState>) => setState(s => ({ ...s, ...patch }));
  const reset = () => setState(EMPTY);

  const { nameKeys, upcKeys, productTypeKey, distributorKey, priceKey, discountKey, ripKey, closeoutKey } = config;

  const filtered = useMemo(() => {
    const list = items ?? [];
    const s = state.search.trim().toLowerCase();
    const min = state.priceMin === '' ? null : Number(state.priceMin);
    const max = state.priceMax === '' ? null : Number(state.priceMax);
    return list.filter(item => {
      if (s) {
        const hit = nameKeys.some(k => String(item[k] ?? '').toLowerCase().includes(s))
          || upcKeys.some(k => String(item[k] ?? '').includes(s));
        if (!hit) return false;
      }
      if (state.productType && productTypeKey) {
        if (String(item[productTypeKey] ?? '') !== state.productType) return false;
      }
      if (state.distributor && distributorKey) {
        if (String(item[distributorKey] ?? '') !== state.distributor) return false;
      }
      if (priceKey && (min != null || max != null)) {
        const p = Number(item[priceKey]);
        if (!Number.isNaN(p)) {
          if (min != null && p < min) return false;
          if (max != null && p > max) return false;
        }
      }
      if (state.deal !== 'all') {
        const key = state.deal === 'discount' ? discountKey
          : state.deal === 'rip' ? ripKey
          : closeoutKey;
        if (key && !item[key]) return false;
      }
      return true;
    });
  }, [items, state, nameKeys, upcKeys, productTypeKey, distributorKey, priceKey, discountKey, ripKey, closeoutKey]);

  return { filtered, state, set, reset };
}
