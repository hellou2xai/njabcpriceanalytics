import { useState, useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { catalog, deals, watchlist } from '../lib/api';
import WholesalerFilter from '../components/WholesalerFilter';
import TrackedOnlyToggle from '../components/TrackedOnlyToggle';
import RowLimitSelect from '../components/RowLimitSelect';
import { useProductQuickView } from '../components/ProductQuickView';
import CatalogTable, { loadCart, saveCart, type CartState } from '../components/CatalogTable';
import CatalogFilterPanel, {
  emptyCatalogFilters,
  countActiveFilters,
} from '../components/CatalogFilterPanel';
import type { CatalogFilters } from '../components/CatalogFilterPanel';
import type { Product } from '../lib/api';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthLabel(ym: string): string {
  if (!ym) return '';
  const [y, m] = ym.split('-');
  const idx = parseInt(m, 10) - 1;
  return idx >= 0 && idx < 12 ? `${MONTH_NAMES[idx]} ${y}` : ym;
}

type SortKey = 'product_name' | 'frontline_case_price' | 'effective_case_price';

/**
 * New Items: the catalog filtered to products newly introduced in the last few
 * editions (an item whose UPC was absent from the wholesaler's prior edition).
 * Same layout, table, filters, and deal/discount detail as the main Catalog,
 * plus an "Introduced" column and a month filter. The full new-items set is
 * small, so search, filtering, sorting, and paging all run client-side here.
 */
export default function NewItems() {
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [wholesaler, setWholesaler] = useState(params.get('wholesaler') ?? '');
  const [introduced, setIntroduced] = useState(params.get('introduced') ?? '');
  const [sort, setSort] = useState<SortKey>('product_name');
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(0);
  const [limit, setLimit] = useState(50);
  const [trackedOnly, setTrackedOnly] = useState(false);
  const [filters, setFilters] = useState<CatalogFilters>({ ...emptyCatalogFilters });
  const [cart, setCartState] = useState<CartState>(loadCart);
  const { open } = useProductQuickView();
  const [showFilters, setShowFilters] = useState(() => localStorage.getItem('lpb_catalog_filters_open') !== 'false');
  const toggleFilters = () => setShowFilters(s => { localStorage.setItem('lpb_catalog_filters_open', String(!s)); return !s; });

  const setCart = useCallback((update: CartState | ((p: CartState) => CartState)) => {
    setCartState(prev => {
      const next = typeof update === 'function' ? update(prev) : update;
      saveCart(next);
      return next;
    });
  }, []);
  const updateQty = useCallback((key: string, field: 'cases' | 'units', value: number) => {
    setCart(prev => ({
      ...prev,
      [key]: { cases: prev[key]?.cases ?? 0, units: prev[key]?.units ?? 0, [field]: value },
    }));
  }, [setCart]);

  // One fetch of every new item (the set is small). All other refinement is
  // client-side so the page behaves exactly like the catalog.
  const { data, isLoading } = useQuery({
    queryKey: ['new-items-all'],
    queryFn: () => catalog.newItems({ limit: 5000, include_tiers: true }),
  });
  const { data: tracked } = useQuery({ queryKey: ['watchlist'], queryFn: watchlist.get });

  // Combo bundle links (same as catalog).
  const { data: comboIdx } = useQuery({ queryKey: ['combo-index'], queryFn: () => deals.comboIndex(), staleTime: 300_000 });
  const comboMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of comboIdx?.items ?? []) m.set(`${c.wholesaler}|${c.upc_norm}`, c.combo_code);
    return m;
  }, [comboIdx]);
  const comboLink = useCallback((item: Product) => {
    const norm = String(item.upc ?? '').replace(/^0+/, '');
    const code = norm ? comboMap.get(`${item.wholesaler}|${norm}`) : undefined;
    return code ? `/combos?code=${encodeURIComponent(code)}` : null;
  }, [comboMap]);

  const allItems = useMemo(() => (data?.items ?? []) as Product[], [data]);
  const months = data?.months ?? [];

  const trackedKeys = useMemo(() => {
    const s = new Set<string>();
    for (const w of tracked ?? []) s.add(`${w.product_name}|${w.wholesaler}`);
    return s;
  }, [tracked]);

  // Scope = wholesaler + search + month. Facet counts reflect this scope (as the
  // catalog's facets reflect its search/wholesaler scope).
  const scoped = useMemo(() => {
    const term = q.trim().toLowerCase();
    const digits = q.replace(/\D/g, '').replace(/^0+/, '');
    return allItems.filter(i => {
      if (wholesaler && i.wholesaler !== wholesaler) return false;
      if (introduced && i.introduced_edition !== introduced) return false;
      if (term) {
        const name = (i.product_name ?? '').toLowerCase();
        const upc = String(i.upc ?? '');
        const upcNorm = upc.replace(/^0+/, '');
        const hit = name.includes(term) || upc.includes(q) || (digits !== '' && upcNorm.includes(digits));
        if (!hit) return false;
      }
      return true;
    });
  }, [allItems, wholesaler, introduced, q]);

  // Panel filters (deals, distributors, price, category, brand, size) + tracked.
  const filtered = useMemo(() => {
    let r = scoped;
    if (filters.hasRip !== undefined) r = r.filter(i => i.has_rip === filters.hasRip);
    if (filters.hasDiscount !== undefined) r = r.filter(i => i.has_discount === filters.hasDiscount);
    if (filters.divisions.length > 0) { const set = new Set(filters.divisions); r = r.filter(i => set.has(i.wholesaler)); }
    if (filters.priceMin !== undefined) r = r.filter(i => i.frontline_case_price >= filters.priceMin!);
    if (filters.priceMax !== undefined) r = r.filter(i => i.frontline_case_price <= filters.priceMax!);
    if (filters.categories.length > 0) { const set = new Set(filters.categories); r = r.filter(i => set.has(i.product_type)); }
    if (filters.brands.length > 0) { const set = new Set(filters.brands); r = r.filter(i => i.brand !== undefined && set.has(i.brand)); }
    if (filters.sizes.length > 0) { const set = new Set(filters.sizes); r = r.filter(i => set.has(i.unit_volume)); }
    if (trackedOnly) r = r.filter(i => trackedKeys.has(`${i.product_name}|${i.wholesaler}`));
    return r;
  }, [scoped, filters, trackedOnly, trackedKeys]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    const dir = order === 'asc' ? 1 : -1;
    arr.sort((a, b) => {
      if (sort === 'product_name') {
        const av = (a.product_name ?? '').toLowerCase();
        const bv = (b.product_name ?? '').toLowerCase();
        return av < bv ? -dir : av > bv ? dir : 0;
      }
      const av = (a[sort] as number) ?? 0;
      const bv = (b[sort] as number) ?? 0;
      return (av - bv) * dir;
    });
    return arr;
  }, [filtered, sort, order]);

  const total = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, totalPages - 1);
  const pageItems = useMemo(
    () => sorted.slice(safePage * limit, safePage * limit + limit),
    [sorted, safePage, limit],
  );

  const activeFilterCount = countActiveFilters(filters);
  const handleSort = (col: SortKey) => {
    if (sort === col) setOrder(o => (o === 'asc' ? 'desc' : 'asc'));
    else { setSort(col); setOrder(col === 'product_name' ? 'asc' : 'desc'); }
    setPage(0);
  };

  return (
    <div className="page">
      <div className="orders-header">
        <h2>New Items</h2>
        <WholesalerFilter value={wholesaler} onChange={(v) => { setWholesaler(v); setPage(0); }} />
      </div>
      <p className="text-muted" style={{ fontSize: 13, marginTop: -8, marginBottom: 12 }}>
        Products that appeared this edition but were not in the prior one (matched by UPC).
      </p>

      <div className="search-bar">
        <input type="text" placeholder="Search new products..." value={q} onChange={e => { setQ(e.target.value); setPage(0); }} />
        <span className="search-count">{total.toLocaleString()} results</span>
      </div>

      {/* Month-introduced filter */}
      <div className="tile-filter-bar" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="text-muted" style={{ fontSize: 12, marginRight: 2 }}>Introduced:</span>
          <button type="button" className={`filter-pill ${introduced === '' ? 'active' : ''}`}
            onClick={() => { setIntroduced(''); setPage(0); }}>All</button>
          {months.map(({ edition, count }) => (
            <button key={edition} type="button"
              className={`filter-pill ${introduced === edition ? 'active' : ''}`}
              onClick={() => { setIntroduced(edition); setPage(0); }}>
              {monthLabel(edition)}
              <span className="filter-pill-count">{count}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="toolbar">
        <button className="btn btn-secondary btn-sm" onClick={toggleFilters}
          title={showFilters ? 'Hide filter panel' : 'Show filter panel'}>
          {showFilters ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
          {showFilters ? 'Hide Filters' : 'Show Filters'}
        </button>
        <TrackedOnlyToggle enabled={trackedOnly} onChange={(v) => { setTrackedOnly(v); setPage(0); }} />
        <RowLimitSelect value={limit} onChange={v => { setLimit(v); setPage(0); }} />
        {activeFilterCount > 0 && (
          <button className="btn btn-secondary" onClick={() => setFilters({ ...emptyCatalogFilters })}>
            Clear all ({activeFilterCount})
          </button>
        )}
      </div>

      <div className={`catalog-layout ${showFilters ? '' : 'catalog-layout--full'}`}>
        {showFilters && (
          <CatalogFilterPanel
            filters={filters}
            onChange={(f) => { setFilters(f); setPage(0); }}
            items={scoped}
          />
        )}

        <div className="catalog-results">
          {isLoading ? <p>Loading...</p> : (
            <CatalogTable
              items={pageItems}
              open={open}
              cart={cart}
              updateQty={updateQty}
              sortControls={{ sort, order, onSort: handleSort }}
              comboLink={comboLink}
              showIntroduced
            />
          )}

          <div className="pagination">
            <button disabled={safePage === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>Prev</button>
            <span>Page {safePage + 1} of {totalPages}</span>
            <button disabled={safePage + 1 >= totalPages} onClick={() => setPage(p => p + 1)}>Next</button>
          </div>
        </div>
      </div>
    </div>
  );
}
