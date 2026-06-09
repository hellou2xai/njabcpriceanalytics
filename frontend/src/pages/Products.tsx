import { useState, useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams, useLocation } from 'react-router-dom';
import { Search, SlidersHorizontal, Sparkles } from 'lucide-react';
import { catalog } from '../lib/api';
import WholesalerFilter from '../components/WholesalerFilter';
import RowLimitSelect from '../components/RowLimitSelect';
import { useResultCount } from '../lib/resultCount';
import { loadCart, saveCart, type CartState } from '../components/CatalogTable';
import ProductsFilterRail from '../components/ProductsFilterRail';
import ProductsGrid, { countProductGroups } from '../components/ProductsGrid';
import { emptyCatalogFilters, countActiveFilters } from '../components/CatalogFilterPanel';
import type { CatalogFilters } from '../components/CatalogFilterPanel';
import type { Product } from '../lib/api';

/**
 * Products — a Provi-style grouped view of the same catalog data.
 *
 * It reuses every piece of the Catalog machinery (semantic search via
 * `region` / `varietal`, the full filter set, facet counts, the cart) but
 * presents one expandable card per product family with its sizes nested below,
 * and a left filter rail. Search results are fetched sorted by product_name so
 * a product's sizes arrive contiguously and group cleanly within a page.
 */
export default function Products() {
  const [params, setSearchParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [wholesaler, setWholesaler] = useState(params.get('wholesaler') ?? '');
  const [region, setRegion] = useState(params.get('region') ?? '');
  const [varietal, setVarietal] = useState(params.get('varietal') ?? '');
  const [page, setPage] = useState(0);
  const [limit, setLimit] = useState(60);
  const [trackedOnly, setTrackedOnly] = useState(false);
  // Sort is by product_name by default so a product's sizes arrive contiguously
  // and group cleanly. Price sorts are offered too (server-side).
  const [sort, setSort] = useState<'product_name' | 'frontline_case_price' | 'effective_case_price'>('product_name');
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [filters, setFilters] = useState<CatalogFilters>(() => {
    const next: CatalogFilters = { ...emptyCatalogFilters };
    if (params.get('hasRip') === '1') next.hasRip = true;
    if (params.get('hasDiscount') === '1') next.hasDiscount = true;
    return next;
  });
  const [cart, setCartState] = useState<CartState>(loadCart);
  // Collapsible filter rail (persisted): collapsed = a slim strip, grid full width.
  const [railCollapsed, setRailCollapsed] = useState(() =>
    localStorage.getItem('prodFiltersCollapsed') === '1');
  const toggleRail = (v: boolean) => {
    setRailCollapsed(v);
    localStorage.setItem('prodFiltersCollapsed', v ? '1' : '0');
  };

  // URL -> state, so deep links (incl. the assistant's) and Back/Forward work.
  useEffect(() => {
    const csv = (k: string) => (params.get(k)?.split(',').filter(Boolean) ?? []);
    setQ(params.get('q') ?? '');
    setWholesaler(params.get('wholesaler') ?? '');
    setRegion(params.get('region') ?? '');
    setVarietal(params.get('varietal') ?? '');
    setFilters({
      ...emptyCatalogFilters,
      hasRip: params.get('hasRip') === '1' ? true : undefined,
      hasDiscount: params.get('hasDiscount') === '1' ? true : undefined,
      inCombo: params.get('in_combo') === '1' ? true : undefined,
      categories: csv('categories'),
      divisions: csv('divisions'),
      brands: csv('brands'),
      sizes: csv('sizes'),
      priceMin: params.get('priceMin') ? parseFloat(params.get('priceMin')!) : undefined,
      priceMax: params.get('priceMax') ? parseFloat(params.get('priceMax')!) : undefined,
    });
    setPage(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // state -> URL (shareable / bookmarkable; replace keeps keystrokes out of history).
  useEffect(() => {
    const next = new URLSearchParams();
    if (q) next.set('q', q);
    if (wholesaler) next.set('wholesaler', wholesaler);
    if (region) next.set('region', region);
    if (varietal) next.set('varietal', varietal);
    if (filters.hasRip) next.set('hasRip', '1');
    if (filters.hasDiscount) next.set('hasDiscount', '1');
    if (filters.inCombo) next.set('in_combo', '1');
    if (filters.categories?.length) next.set('categories', filters.categories.join(','));
    if (filters.divisions?.length) next.set('divisions', filters.divisions.join(','));
    if (filters.brands?.length) next.set('brands', filters.brands.join(','));
    if (filters.sizes?.length) next.set('sizes', filters.sizes.join(','));
    if (filters.priceMin != null) next.set('priceMin', String(filters.priceMin));
    if (filters.priceMax != null) next.set('priceMax', String(filters.priceMax));
    if (next.toString() !== params.toString()) setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, wholesaler, region, varietal, filters]);

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

  // Google-style landing: the grid appears only when the user COMMITS a query —
  // i.e. presses Enter (handled on the hero input). Typing alone never swaps the
  // screen, so the hero stays put and keeps focus. Clearing the box returns to
  // the hero. (No debounce/auto-transition — the user wants Enter to be the trigger.)
  const [committed, setCommitted] = useState(q);
  useEffect(() => { if (!q.trim()) setCommitted(''); }, [q]);
  const showGrid = committed.trim().length > 0 || !!wholesaler || countActiveFilters(filters) > 0;

  // Hero typeahead: while on the landing, typing shows SUGGESTIONS (semantic
  // /catalog/search) but never the grid — the grid waits for Enter (or picking a
  // suggestion). Debounced so it doesn't fire per keystroke.
  const [qSugg, setQSugg] = useState('');
  useEffect(() => { const t = setTimeout(() => setQSugg(q), 200); return () => clearTimeout(t); }, [q]);
  const { data: suggData } = useQuery({
    enabled: !showGrid && qSugg.trim().length >= 2,
    queryKey: ['products-suggest', qSugg],
    queryFn: () => catalog.search({ q: qSugg, limit: 8, sort: 'product_name', order: 'asc' }),
    staleTime: 60_000,
  });
  const suggestions = (() => {
    const m = new Map<string, { name: string; size?: string; n: number; type?: string }>();
    for (const r of (suggData?.items ?? []) as Product[]) {
      const key = `${(r.product_name || '').toLowerCase()}|${r.unit_volume ?? ''}`;
      const cur = m.get(key);
      if (cur) cur.n += 1;
      else m.set(key, { name: r.product_name, size: r.unit_volume ?? undefined, n: 1, type: r.product_type ?? undefined });
    }
    return [...m.values()].slice(0, 8);
  })();
  const pickSuggestion = (name: string) => { setQ(name); setQSugg(name); setCommitted(name); setPage(0); };

  const { data, isLoading } = useQuery({
    enabled: showGrid,
    queryKey: ['products', q, wholesaler, sort, order, page, limit, trackedOnly, filterKey, region, varietal],
    queryFn: () => catalog.search({
      q,
      wholesaler: wholesaler || undefined,
      sort, order,
      limit, offset: page * limit,
      ...filterParams,
      tracked_only: trackedOnly || undefined,
      // The collapsed cards only need price + deal flags, not the full tier
      // ladder — so we skip include_tiers here (it makes the search ~8x slower).
      // Tiers are fetched per product on expand and on the detail page.
      region: region || undefined,
      varietal: varietal || undefined,
    }),
  });

  const { data: facets } = useQuery({
    enabled: showGrid,
    queryKey: ['products-facets', q, wholesaler, filterKey],
    queryFn: () => catalog.facets({ q, wholesaler: wholesaler || undefined, ...filterParams }),
  });

  const items = (data?.items ?? []) as Product[];
  const total = data?.total ?? 0;
  const productCount = countProductGroups(items);

  // Publish the matched-row count so the AI assistant can echo the same number.
  const { report } = useResultCount();
  const { pathname } = useLocation();
  useEffect(() => { if (!isLoading) report(pathname, total); }, [isLoading, total, pathname, report]);

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="page products-page">
      {!showGrid ? (
        <div className="products-splash">
          <div className="products-splash-brand"><Sparkles size={26} /> Celr AI</div>
          <h1 className="products-splash-title">Find any product, at any distributor</h1>
          <div className="products-hero-box">
            <div className="products-hero-search">
              <Search size={20} className="products-hero-icon" />
              <input
                type="text"
                autoFocus
                className="products-hero-input"
                placeholder="Search products, brands, regions, varietals…"
                value={q}
                onChange={e => { setQ(e.target.value); setPage(0); }}
                onKeyDown={e => { if (e.key === 'Enter') setCommitted(e.currentTarget.value); }}
              />
              <button type="button" className="products-hero-ai"
                title="Ask the AI to find products by region, varietal, price or deal"
                onClick={() => window.dispatchEvent(new CustomEvent('celr-open-assistant',
                  { detail: q.trim() ? { question: q.trim() } : undefined }))}>
                <Sparkles size={16} /> Ask AI
              </button>
            </div>
            {suggestions.length > 0 && (
              <ul className="products-hero-suggest">
                {suggestions.map((s, i) => (
                  // mouseDown (not click) so it fires before the input blur
                  <li key={i} onMouseDown={e => { e.preventDefault(); pickSuggestion(s.name); }}>
                    <span className="phs-name">{s.name}</span>
                    <span className="phs-meta">
                      {[s.size, s.type, s.n > 1 ? `${s.n} distributors` : null].filter(Boolean).join(' · ')}
                    </span>
                  </li>
                ))}
                <li className="phs-foot" onMouseDown={e => { e.preventDefault(); setCommitted(q); }}>
                  Press <kbd className="products-hero-kbd">Enter</kbd> to see all results for “{q}”
                </li>
              </ul>
            )}
          </div>
          <p className="products-splash-hint">
            Type a product and press <kbd className="products-hero-kbd">Enter</kbd>. Smart search handles brands, misspellings, sizes and barcodes.
          </p>
        </div>
      ) : (
      <>
      <div className="orders-header">
        <h2>Products</h2>
        <WholesalerFilter value={wholesaler} onChange={v => { setWholesaler(v); setPage(0); }} />
      </div>

      <div className="search-bar products-search">
        <Search size={16} className="products-search-icon" />
        <input type="text" autoFocus placeholder="Search products, brands, regions, varietals…"
          value={q} onChange={e => { setQ(e.target.value); setPage(0); }} />
        {/* Semantic / natural-language search via the AI assistant: it parses
            "California cabernet under $200 on a RIP" into region/varietal/price/
            deal filters and drives this grid. */}
        <button type="button" className="products-ai-btn"
          title="Ask the AI to find products by region, varietal, price or deal"
          onClick={() => window.dispatchEvent(new CustomEvent('celr-open-assistant',
            { detail: q.trim() ? { question: q.trim() } : undefined }))}>
          <Sparkles size={15} /> Ask AI
        </button>
        <span className="search-count">{isLoading ? 'Searching…' : `${total.toLocaleString()} items`}</span>
      </div>
      {data?.corrected_query && data.corrected_query.toLowerCase() !== q.trim().toLowerCase() && (
        <p className="search-correction" style={{ fontSize: 13, color: 'var(--text-muted)', margin: '-4px 0 12px' }}>
          No exact match for "{q.trim()}". Showing results for{' '}
          <button type="button" className="link-btn" onClick={() => { setQ(data.corrected_query!); setPage(0); }}
            style={{ background: 'none', border: 0, padding: 0, color: 'var(--accent)', fontWeight: 600, cursor: 'pointer' }}>
            "{data.corrected_query}"
          </button>.
        </p>
      )}

      <div className={`products-layout${railCollapsed ? ' products-layout--collapsed' : ''}`}>
        {railCollapsed ? (
          <button type="button" className="prod-rail-reopen" onClick={() => toggleRail(false)}
                  title="Show filters">
            <SlidersHorizontal size={15} />
            <span className="prod-rail-reopen-label">Filters</span>
          </button>
        ) : (
          <ProductsFilterRail
            filters={filters}
            onChange={f => { setFilters(f); setPage(0); }}
            items={items}
            facets={facets}
            trackedOnly={trackedOnly}
            onTrackedChange={v => { setTrackedOnly(v); setPage(0); }}
            onCollapse={() => toggleRail(true)}
          />
        )}

        <div className="products-main">
          <div className="products-toolbar">
            <span className="products-showing">
              {isLoading ? 'Loading…' : (
                <>Showing <strong>{productCount}</strong> product{productCount === 1 ? '' : 's'}
                  {' '}<span className="products-showing-sub">({total.toLocaleString()} sizes)</span></>
              )}
            </span>
            <div className="products-toolbar-right">
              <label className="products-sort">
                <span>Sort by</span>
                <select
                  value={`${sort}:${order}`}
                  onChange={e => {
                    const [s, o] = e.target.value.split(':') as [typeof sort, typeof order];
                    setSort(s); setOrder(o); setPage(0);
                  }}
                >
                  <option value="product_name:asc">Name (A–Z)</option>
                  <option value="product_name:desc">Name (Z–A)</option>
                  <option value="frontline_case_price:asc">Price (low → high)</option>
                  <option value="frontline_case_price:desc">Price (high → low)</option>
                  <option value="effective_case_price:asc">Best price (low → high)</option>
                </select>
              </label>
              <RowLimitSelect value={limit} onChange={v => { setLimit(v); setPage(0); }} />
            </div>
          </div>

          {isLoading ? <p>Loading…</p> : (
            <ProductsGrid items={items} cart={cart} updateQty={updateQty} />
          )}

          <div className="pagination">
            <button disabled={page === 0} onClick={() => setPage(p => p - 1)}>Prev</button>
            <span>Page {page + 1} of {totalPages}</span>
            <button disabled={(page + 1) * limit >= total} onClick={() => setPage(p => p + 1)}>Next</button>
          </div>
        </div>
      </div>
      </>
      )}
    </div>
  );
}
