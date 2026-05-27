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
import { ChevronLeft, ChevronRight } from 'lucide-react';

export default function Catalog() {
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [wholesaler, setWholesaler] = useState(params.get('wholesaler') ?? '');
  const [sort, setSort] = useState<'product_name' | 'frontline_case_price' | 'effective_case_price'>('product_name');
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(0);
  const [limit, setLimit] = useState(50);
  const [trackedOnly, setTrackedOnly] = useState(false);
  const [filters, setFilters] = useState<CatalogFilters>({ ...emptyCatalogFilters });
  const [cart, setCartState] = useState<CartState>(loadCart);
  const { open } = useProductQuickView();
  const [showFilters, setShowFilters] = useState(() => {
    const stored = localStorage.getItem('lpb_catalog_filters_open');
    if (stored !== null) return stored !== 'false';
    // Default: open on desktop, collapsed on mobile so the product list shows first.
    return typeof window === 'undefined' || window.innerWidth > 1023;
  });
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

  // All panel filters are sent to the server so they apply across every page
  // (not just the current one) and the counts reconcile with the results.
  const filterParams = {
    has_rip: filters.hasRip,
    has_discount: filters.hasDiscount,
    in_combo: filters.inCombo || undefined,
    divisions: filters.divisions.join(',') || undefined,
    categories: filters.categories.join(',') || undefined,
    brands: filters.brands.join(',') || undefined,
    sizes: filters.sizes.join(',') || undefined,
    min_price: filters.priceMin,
    max_price: filters.priceMax,
  };
  const filterKey = JSON.stringify(filters);

  const { data, isLoading } = useQuery({
    queryKey: ['catalog', q, wholesaler, sort, order, page, limit, trackedOnly, filterKey],
    queryFn: () => catalog.search({
      q,
      wholesaler: wholesaler || undefined,
      sort, order, limit,
      offset: page * limit,
      ...filterParams,
      tracked_only: trackedOnly || undefined,
      include_tiers: true,
    }),
  });

  const { data: facets } = useQuery({
    queryKey: ['catalog-facets', q, wholesaler, filterKey],
    queryFn: () => catalog.facets({ q, wholesaler: wholesaler || undefined, ...filterParams }),
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

  // Filtering is done server-side now, so the returned page is already filtered.
  const items = data?.items ?? [];
  const facetItems = data?.items ?? [];

  const handleSort = (col: 'product_name' | 'frontline_case_price' | 'effective_case_price') => {
    if (sort === col) setOrder(o => o === 'asc' ? 'desc' : 'asc');
    else { setSort(col); setOrder(col === 'product_name' ? 'asc' : 'desc'); }
    setPage(0);
  };
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / limit));

  return (
    <div className="page">
      <div className="orders-header">
        <h2>Product Catalog</h2>
        <WholesalerFilter value={wholesaler} onChange={(v) => { setWholesaler(v); setPage(0); }} />
      </div>

      <div className="search-bar">
        <input type="text" placeholder="Search products..." value={q} onChange={e => { setQ(e.target.value); setPage(0); }} />
        <span className="search-count">{data?.total?.toLocaleString() ?? 0} results</span>
      </div>
      {data?.corrected_query && data.corrected_query.toLowerCase() !== q.trim().toLowerCase() && (
        <p className="search-correction" style={{ fontSize: 13, color: 'var(--text-muted)', margin: '-8px 0 12px' }}>
          No exact match for "{q.trim()}". Showing results for{' '}
          <button type="button" className="link-btn" onClick={() => { setQ(data.corrected_query!); setPage(0); }}
            style={{ background: 'none', border: 0, padding: 0, color: 'var(--accent)', fontWeight: 600, cursor: 'pointer' }}>
            "{data.corrected_query}"
          </button>.
        </p>
      )}

      {/* Always-visible edge tab to hide/show the filter panel. */}
      <button
        className={`edge-tab edge-tab-filters${showFilters ? ' is-open' : ''}`}
        onClick={toggleFilters}
        title={showFilters ? 'Hide filters' : 'Show filters'}
        aria-label={showFilters ? 'Hide filters' : 'Show filters'}
      >
        {showFilters ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
      </button>

      <div className="toolbar">
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
            facets={facets}
            trackedOnly={trackedOnly}
            onTrackedChange={(v) => { setTrackedOnly(v); setPage(0); }}
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
