import { useState, useMemo, useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams, useLocation } from 'react-router-dom';
import { catalog, deals } from '../lib/api';
import WholesalerFilter from '../components/WholesalerFilter';
import RowLimitSelect from '../components/RowLimitSelect';
import ProductSearchBox from '../components/ProductSearchBox';
import { useResultCount } from '../lib/resultCount';
import { useProductQuickView } from '../components/ProductQuickView';
import CatalogTable, { loadCart, saveCart, type CartState } from '../components/CatalogTable';
import CatalogFilterPanel, {
  emptyCatalogFilters,
} from '../components/CatalogFilterPanel';
import type { CatalogFilters } from '../components/CatalogFilterPanel';
import type { Product } from '../lib/api';

type CatalogSort = 'product_name' | 'frontline_case_price' | 'effective_case_price' | 'live_effective_case_price';

// Single source of truth for URL -> filters, used by BOTH the useState
// initializer and the params effect below. If the initial state seeds less
// than the effect parses, the state->URL mirror runs against the incomplete
// first-render state and strips the missing params on a fresh mount (deep
// links like ?categories=Wine or the assistant's group_by_rip/price_drop
// would silently vanish before the first query fired).
function filtersFromParams(params: URLSearchParams): CatalogFilters {
  const csv = (k: string) => (params.get(k)?.split(',').filter(Boolean) ?? []);
  return {
    ...emptyCatalogFilters,
    hasRip: params.get('hasRip') === '1' ? true : undefined,
    hasDiscount: params.get('hasDiscount') === '1' ? true : undefined,
    // group_by_rip accepts both '1' (canonical) and 'true' so older deep
    // links from the assistant keep working.
    groupByRip: (params.get('group_by_rip') === '1' || params.get('group_by_rip') === 'true') || undefined,
    // Assistant "only show prices going up / down" deep-links land here.
    priceTrend: params.get('price_increase') === '1' ? 'increase'
              : params.get('price_drop') === '1' ? 'drop' : undefined,
    categories: csv('categories'),
    divisions: csv('divisions'),
    sizes: csv('sizes'),
    unitKinds: csv('unit_kinds'),
    priceMin: params.get('priceMin') ? parseFloat(params.get('priceMin')!) : undefined,
    priceMax: params.get('priceMax') ? parseFloat(params.get('priceMax')!) : undefined,
  };
}
function sortFromParams(params: URLSearchParams): CatalogSort {
  const sp = params.get('sort');
  return (sp === 'product_name' || sp === 'frontline_case_price' || sp === 'effective_case_price' || sp === 'live_effective_case_price')
    ? sp : 'product_name';
}

export default function Catalog() {
  const [params, setSearchParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [wholesaler, setWholesaler] = useState(params.get('wholesaler') ?? '');
  // Exact-UPC lock used by Celar Assistant "Open in Catalog" deep-links —
  // the grid shows ONLY the same SKUs the chat surfaced.
  const [upcs, setUpcs] = useState(params.get('upcs') ?? '');
  // RIP-code restriction. Filters the grid to products in this (wholesaler,
  // rip_code) Case Mix. Used by the assistant's deep links and by the new
  // 'RIP Code' filter input in the sidebar.
  const [ripCode, setRipCode] = useState(params.get('rip_code') ?? '');
  // Semantic region hint ("california", "napa", "bordeaux"...) — backend
  // resolves to product-name tokens + enrichment description match and
  // auto-narrows product_type when implied (e.g. california -> Wine).
  const [region, setRegion] = useState(params.get('region') ?? '');
  // Semantic varietal / style hint ("cabernet", "ipa", "bourbon", "single malt").
  // Stacks with region for "California cabernets" / "Kentucky bourbon" style
  // queries. Backend auto-narrows product_type too.
  const [varietal, setVarietal] = useState(params.get('varietal') ?? '');
  const [sort, setSort] = useState<CatalogSort>(() => sortFromParams(params));
  const [order, setOrder] = useState<'asc' | 'desc'>(() => (params.get('order') === 'desc' ? 'desc' : 'asc'));
  const [page, setPage] = useState(0);
  const [limit, setLimit] = useState(50);
  const [trackedOnly, setTrackedOnly] = useState(false);
  const [filters, setFilters] = useState<CatalogFilters>(() => filtersFromParams(params));
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

  // Apply filters from the URL whenever it changes — this is how the AI
  // assistant "shows results on screen": it navigates to /catalog?…filters and
  // the catalog reflects them (even if we're already on this page).
  useEffect(() => {
    setQ(params.get('q') ?? '');
    setWholesaler(params.get('wholesaler') ?? '');
    setUpcs(params.get('upcs') ?? '');
    setRipCode(params.get('rip_code') ?? '');
    setRegion(params.get('region') ?? '');
    setVarietal(params.get('varietal') ?? '');
    setFilters(filtersFromParams(params));
    setSort(sortFromParams(params));
    setOrder(params.get('order') === 'desc' ? 'desc' : 'asc');
    setPage(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // Mirror the live filter state back INTO the URL so the Back/Forward buttons
  // restore search + filters (React would otherwise discard this useState on
  // unmount) and a filtered view is shareable / bookmarkable. Guarded against
  // the URL->state effect above: we only write when the canonical query string
  // actually changes, so the two effects converge in one extra render instead
  // of looping. `replace` keeps each keystroke out of the history stack.
  useEffect(() => {
    const next = new URLSearchParams();
    if (q) next.set('q', q);
    if (wholesaler) next.set('wholesaler', wholesaler);
    if (upcs) next.set('upcs', upcs);
    if (ripCode) next.set('rip_code', ripCode);
    if (region) next.set('region', region);
    if (varietal) next.set('varietal', varietal);
    if (sort !== 'product_name') next.set('sort', sort);
    if (order !== 'asc') next.set('order', order);
    if (filters.hasRip) next.set('hasRip', '1');
    if (filters.hasDiscount) next.set('hasDiscount', '1');
    if (filters.groupByRip) next.set('group_by_rip', '1');
    if (filters.priceTrend === 'increase') next.set('price_increase', '1');
    if (filters.priceTrend === 'drop') next.set('price_drop', '1');
    if (filters.categories?.length) next.set('categories', filters.categories.join(','));
    if (filters.divisions?.length) next.set('divisions', filters.divisions.join(','));
    if (filters.sizes?.length) next.set('sizes', filters.sizes.join(','));
    if (filters.unitKinds?.length) next.set('unit_kinds', filters.unitKinds.join(','));
    if (filters.priceMin != null) next.set('priceMin', String(filters.priceMin));
    if (filters.priceMax != null) next.set('priceMax', String(filters.priceMax));
    if (next.toString() !== params.toString()) setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, wholesaler, upcs, ripCode, region, varietal, sort, order, filters]);

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
    unit_kinds: filters.unitKinds.join(',') || undefined,
    min_price: filters.priceMin,
    max_price: filters.priceMax,
  };
  const filterKey = JSON.stringify(filters);

  const { data, isLoading } = useQuery({
    queryKey: ['catalog', q, wholesaler, sort, order, page, limit, trackedOnly, filterKey, upcs, ripCode, region, varietal],
    queryFn: () => catalog.search({
      q,
      wholesaler: wholesaler || undefined,
      sort, order, limit,
      offset: page * limit,
      ...filterParams,
      tracked_only: trackedOnly || undefined,
      include_tiers: true,
      upcs: upcs || undefined,
      rip_code: ripCode || undefined,
      region: region || undefined,
      varietal: varietal || undefined,
    }),
  });

  // Facets must mirror what the grid SHOWS: when /search spell-corrected (or
  // AI-corrected) the query, count facets on the corrected term, not the raw
  // misspelling (which matches nothing and blanked the whole filter panel).
  const effectiveQ = data?.corrected_query ?? q;
  const { data: facets } = useQuery({
    enabled: !q.trim() || !!data,
    queryKey: ['catalog-facets', effectiveQ, wholesaler, filterKey],
    queryFn: () => catalog.facets({ q: effectiveQ, wholesaler: wholesaler || undefined, ...filterParams }),
  });

  // Publish the matched-row count so the AI assistant can echo the exact same
  // number when it drives this screen.
  const { report } = useResultCount();
  const { pathname } = useLocation();
  const total = data?.total ?? 0;
  useEffect(() => {
    if (!isLoading) report(pathname, total);
  }, [isLoading, total, pathname, report]);

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

  const handleSort = (col: 'product_name' | 'frontline_case_price' | 'effective_case_price' | 'live_effective_case_price') => {
    if (sort === col) setOrder(o => o === 'asc' ? 'desc' : 'asc');
    // Price columns default to cheapest-first (asc); name defaults A-Z.
    else { setSort(col); setOrder(col === 'live_effective_case_price' ? 'asc' : col === 'product_name' ? 'asc' : 'desc'); }
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
        <ProductSearchBox
          value={q}
          onChange={v => { setQ(v); setPage(0); }}
          onSelect={p => { setQ(p.product_name); setPage(0); }}
          placeholder="Search products, UPC, item # or RIP code..."
        />
        {/* RIP-code pinpoint filter, sitting on the top filter row (the user
            asked for it here, not in a side panel). Sets the same param the
            assistant's 'Open in Catalog' deep-link uses, so a typed code and
            a clicked link land on the identical filtered grid. */}
        <input
          type="text"
          placeholder="RIP code…"
          value={ripCode}
          onChange={e => { setRipCode(e.target.value); setPage(0); }}
          title="Filter the grid to products in a specific RIP Case Mix. Pair with a distributor filter when the same code is reused across wholesalers."
          style={{ maxWidth: 140 }}
        />
        {ripCode && (
          <button type="button" className="link-btn"
                  onClick={() => { setRipCode(''); setPage(0); }}
                  title="Clear RIP code filter"
                  style={{ background: 'none', border: 0, padding: '0 6px', color: 'var(--text-muted)', cursor: 'pointer' }}>
            ✕
          </button>
        )}
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
        <span className="result-count-badge" title="Products matching the current filters">
          {isLoading ? 'Fetching…' : `${total.toLocaleString()} result${total === 1 ? '' : 's'}`}
        </span>
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
