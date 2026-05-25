import { useState, useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { catalog, deals } from '../lib/api';
import WholesalerFilter from '../components/WholesalerFilter';
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

// "2026-05" -> "May 2026" for the month-filter pills.
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthLabel(ym: string): string {
  if (!ym) return '';
  const [y, m] = ym.split('-');
  const idx = parseInt(m, 10) - 1;
  return idx >= 0 && idx < 12 ? `${MONTH_NAMES[idx]} ${y}` : ym;
}

/**
 * New Items: the catalog filtered to products newly introduced in the last few
 * editions (an item whose UPC was absent from the wholesaler's prior edition).
 * Same layout and table as the main Catalog, plus an "Introduced" column and a
 * month filter.
 */
export default function NewItems() {
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [wholesaler, setWholesaler] = useState(params.get('wholesaler') ?? '');
  const [introduced, setIntroduced] = useState(params.get('introduced') ?? '');
  const [sort, setSort] = useState<'product_name' | 'frontline_case_price' | 'effective_case_price'>('product_name');
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(0);
  const [limit, setLimit] = useState(50);
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
      [key]: {
        cases: prev[key]?.cases ?? 0,
        units: prev[key]?.units ?? 0,
        [field]: value,
      },
    }));
  }, [setCart]);

  const activeFilterCount = countActiveFilters(filters);

  const { data, isLoading } = useQuery({
    queryKey: ['new-items', q, wholesaler, introduced, sort, order, page, limit, filters.hasRip, filters.hasDiscount],
    queryFn: () => catalog.newItems({
      q,
      wholesaler: wholesaler || undefined,
      introduced_edition: introduced || undefined,
      sort, order, limit,
      offset: page * limit,
      has_rip: filters.hasRip,
      has_discount: filters.hasDiscount,
      include_tiers: true,
    }),
  });

  // Products that belong to a combo bundle → link to its details.
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

  // Client-side filters layered on top of server pagination (mirrors Catalog).
  const items = useMemo(() => {
    let result = data?.items ?? [];
    if (filters.divisions.length > 0) {
      const set = new Set(filters.divisions);
      result = result.filter(i => set.has(i.wholesaler));
    }
    if (filters.priceMin !== undefined) result = result.filter(i => i.frontline_case_price >= filters.priceMin!);
    if (filters.priceMax !== undefined) result = result.filter(i => i.frontline_case_price <= filters.priceMax!);
    if (filters.categories.length > 0) {
      const set = new Set(filters.categories);
      result = result.filter(i => set.has(i.product_type));
    }
    if (filters.brands.length > 0) {
      const set = new Set(filters.brands);
      result = result.filter(i => i.brand !== undefined && set.has(i.brand));
    }
    if (filters.sizes.length > 0) {
      const set = new Set(filters.sizes);
      result = result.filter(i => set.has(i.unit_volume));
    }
    return result;
  }, [data?.items, filters]);

  const facetItems = data?.items ?? [];
  const months = data?.months ?? [];

  const handleSort = (col: 'product_name' | 'frontline_case_price' | 'effective_case_price') => {
    if (sort === col) setOrder(o => o === 'asc' ? 'desc' : 'asc');
    else { setSort(col); setOrder(col === 'product_name' ? 'asc' : 'desc'); }
    setPage(0);
  };
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / limit));

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
        <span className="search-count">{data?.total?.toLocaleString() ?? 0} results</span>
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
            items={facetItems}
          />
        )}

        <div className="catalog-results">
          {isLoading ? <p>Loading...</p> : (
            <CatalogTable
              items={items as Product[]}
              open={open}
              cart={cart}
              updateQty={updateQty}
              sortControls={{ sort, order, onSort: (c) => handleSort(c) }}
              comboLink={comboLink}
              showIntroduced
            />
          )}

          <div className="pagination">
            <button disabled={page === 0} onClick={() => setPage(p => p - 1)}>Prev</button>
            <span>Page {page + 1} of {totalPages}</span>
            <button disabled={(page + 1) * limit >= (data?.total ?? 0)} onClick={() => setPage(p => p + 1)}>Next</button>
          </div>
        </div>
      </div>
    </div>
  );
}
