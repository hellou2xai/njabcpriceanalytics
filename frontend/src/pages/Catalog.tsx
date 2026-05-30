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
} from '../components/CatalogFilterPanel';
import type { CatalogFilters } from '../components/CatalogFilterPanel';
import type { Product } from '../lib/api';

export default function Catalog() {
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [wholesaler, setWholesaler] = useState(params.get('wholesaler') ?? '');
  const [sort, setSort] = useState<'product_name' | 'frontline_case_price' | 'effective_case_price'>('product_name');
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(0);
  const [limit, setLimit] = useState(50);
  const [trackedOnly, setTrackedOnly] = useState(false);
  const [filters, setFilters] = useState<CatalogFilters>(() => {
    // Honor a `hasRip=1` URL param so dashboards / external links can deep-link
    // into the "products with a RIP rebate" view of the catalog without
    // routing through the (now admin-only) RIP Products page.
    const next: CatalogFilters = { ...emptyCatalogFilters };
    if (params.get('hasRip') === '1') next.hasRip = true;
    if (params.get('hasDiscount') === '1') next.hasDiscount = true;
    return next;
  });
  const [cart, setCartState] = useState<CartState>(loadCart);
  const { open } = useProductQuickView();
  const [showFilters, setShowFilters] = useState(() => {
    const stored = localStorage.getItem('lpb_catalog_filters_open');
    if (stored !== null) return stored !== 'false';
    // Default: open on desktop, collapsed on mobile so the product list shows first.
    return typeof window === 'undefined' || window.innerWidth > 1023;
  });
  const toggleFilters = () => setShowFilters(s => { localStorage.setItem('lpb_catalog_filters_open', String(!s)); return !s; });
  // Display preference: show / hide the three Pro teaser columns
  // (Time to Sell, Suggested Qty, Quantity Justification). Defaults
  // ON so a new visitor sees the upgrade preview; persisted in
  // localStorage so a return visit honours their last choice.
  const [showPro, setShowPro] = useState<boolean>(() => {
    const stored = localStorage.getItem('lpb_catalog_show_pro');
    return stored === null ? false : stored !== 'false';   // Pro teaser columns OFF by default
  });
  const onShowProChange = (v: boolean) => {
    setShowPro(v);
    localStorage.setItem('lpb_catalog_show_pro', String(v));
  };

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

  // All panel filters are sent to the server so they apply across every page
  // (not just the current one) and the counts reconcile with the results.
  const filterParams = {
    has_rip: filters.hasRip,
    has_discount: filters.hasDiscount,
    in_combo: filters.inCombo || undefined,
    group_by_rip: filters.groupByRip || undefined,
    price_drop: filters.priceTrend === 'drop' || undefined,
    price_increase: filters.priceTrend === 'increase' || undefined,
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
        <span className="search-count">{isLoading ? 'Fetching data…' : `${(data?.total ?? 0).toLocaleString()} results`}</span>
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

      {/* Horizontal filter toolbar pinned above the catalog. Each section is a
          dropdown popover so we don't lose the long checkbox lists. Clear all
          filters anchors on the LEFT, matching the other horizontal toolbars. */}
      <CatalogFilterPanel
        filters={filters}
        onChange={(f) => { setFilters(f); setPage(0); }}
        items={facetItems}
        facets={facets}
        trackedOnly={trackedOnly}
        onTrackedChange={(v) => { setTrackedOnly(v); setPage(0); }}
        showPro={showPro}
        onShowProChange={onShowProChange}
        collapsed={!showFilters}
        onToggleCollapsed={toggleFilters}
      />

      <div className="toolbar">
        <RowLimitSelect value={limit} onChange={v => { setLimit(v); setPage(0); }} />
      </div>

      <div className="catalog-layout catalog-layout--full">
        <div className="catalog-results">
          {isLoading ? <p>Loading...</p> : (
            <CatalogTable
              items={items as Product[]}
              open={open}
              cart={cart}
              updateQty={updateQty}
              sortControls={{ sort, order, onSort: (c) => handleSort(c) }}
              comboLink={comboLink}
              groupByRip={!!filters.groupByRip}
              showProColumns={showPro}
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
