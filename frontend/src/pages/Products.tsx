import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
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
import { useCachedQuery } from '../hooks/useCachedQuery';
import { useIsMobile } from '../hooks/useIsMobile';
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

// Single source of truth for URL -> filters. Used by BOTH the useState
// initializer and the params effect: if the initial state is seeded with less
// than the effect parses (the old code seeded only hasRip/hasDiscount), the
// state->URL sync runs against the incomplete first-render state and strips
// the missing params (e.g. ?categories=Spirits from a Home "View all" link)
// before they ever reach a query.
function filtersFromParams(params: URLSearchParams): CatalogFilters {
  const csv = (k: string) => (params.get(k)?.split(',').filter(Boolean) ?? []);
  return {
    ...emptyCatalogFilters,
    hasRip: params.get('hasRip') === '1' ? true : undefined,
    hasDiscount: params.get('hasDiscount') === '1' ? true : undefined,
    inCombo: params.get('in_combo') === '1' ? true : undefined,
    timeSensitive: params.get('time_sensitive') === '1' ? true : undefined,
    categories: csv('categories'),
    divisions: csv('divisions'),
    brands: csv('brands'),
    sizes: csv('sizes'),
    unitKinds: csv('unit_kinds'),
    priceMin: params.get('priceMin') ? parseFloat(params.get('priceMin')!) : undefined,
    priceMax: params.get('priceMax') ? parseFloat(params.get('priceMax')!) : undefined,
  };
}

const _MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 'YYYY-MM' -> 'Mon YYYY' (e.g. '2026-07' -> 'Jul 2026'). */
function monthLabel(ed: string): string {
  const m = /^(\d{4})-(\d{1,2})/.exec(ed);
  return m ? `${_MONTHS[parseInt(m[2], 10) - 1] ?? ''} ${m[1]}`.trim() : ed;
}

export default function Products({ newItems = false }: { newItems?: boolean } = {}) {
  const [params, setSearchParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [wholesaler, setWholesaler] = useState(params.get('wholesaler') ?? '');
  const [region, setRegion] = useState(params.get('region') ?? '');
  const [varietal, setVarietal] = useState(params.get('varietal') ?? '');
  const [page, setPage] = useState(0);
  const [limit, setLimit] = useState(60);
  const [trackedOnly, setTrackedOnly] = useState(false);
  // New Items: filter to one introduced edition (YYYY-MM); '' = all of the window.
  // Defaults to the most recent loaded edition (July, here) on open.
  const [introducedMonth, setIntroducedMonth] = useState('');
  const niMonthDefaulted = useRef(false);
  // Sort is by product_name by default so a product's sizes arrive contiguously
  // and group cleanly. Price sorts are offered too (server-side).
  const [sort, setSort] = useState<'product_name' | 'frontline_case_price' | 'effective_case_price'>('product_name');
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [filters, setFilters] = useState<CatalogFilters>(() => filtersFromParams(params));
  const [cart, setCartState] = useState<CartState>(loadCart);
  // "Price details / Summary" toggle: whether collapsed cards show the full
  // deal ladder. Persisted; expanding a card always shows full detail rows.
  // Default to Summary view; only Price details when the user explicitly chose it.
  const [priceDetails, setPriceDetails] = useState(() =>
    localStorage.getItem('lpb_products_price_details') === '1');
  const setDetails = (v: boolean) => {
    setPriceDetails(v);
    localStorage.setItem('lpb_products_price_details', v ? '1' : '0');
  };
  // Which month's RIP/QD tier ladder the cards show: 'current' (default) or
  // 'next' (the early-loaded next edition). Display-only; doesn't refetch.
  const [dealMonth, setDealMonth] = useState<'current' | 'next'>('current');
  // "Group products" toggle: OFF by default shows one row per distributor +
  // size (UPC variants collapsed to the best price); ON restores the
  // cross-distributor family cards. Persisted.
  // Grouped (CELR family) view is the DEFAULT; the choice persists and only an
  // explicit opt-out ('0') turns it off.
  const [grouped, setGroupedState] = useState(() =>
    localStorage.getItem('lpb_products_grouped') !== '0');
  const setGrouped = (v: boolean) => {
    setGroupedState(v);
    localStorage.setItem('lpb_products_grouped', v ? '1' : '0');
  };
  // Collapsible filter rail (persisted on desktop). On MOBILE it starts hidden
  // and opens as a slide-over drawer, so filters never eat the small screen.
  const isMobile = useIsMobile();
  const [railCollapsed, setRailCollapsed] = useState(() =>
    (typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches)
      ? true : localStorage.getItem('prodFiltersCollapsed') === '1');
  const toggleRail = (v: boolean) => {
    setRailCollapsed(v);
    if (!isMobile) localStorage.setItem('prodFiltersCollapsed', v ? '1' : '0');
  };
  useEffect(() => { if (isMobile) setRailCollapsed(true); }, [isMobile]);
  const railDrawer = isMobile && !railCollapsed;

  // URL -> state, so deep links (incl. the assistant's) and Back/Forward work.
  useEffect(() => {
    setQ(params.get('q') ?? '');
    setWholesaler(params.get('wholesaler') ?? '');
    setRegion(params.get('region') ?? '');
    setVarietal(params.get('varietal') ?? '');
    setFilters(filtersFromParams(params));
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
    if (filters.timeSensitive) next.set('time_sensitive', '1');
    if (filters.categories?.length) next.set('categories', filters.categories.join(','));
    if (filters.divisions?.length) next.set('divisions', filters.divisions.join(','));
    if (filters.brands?.length) next.set('brands', filters.brands.join(','));
    if (filters.sizes?.length) next.set('sizes', filters.sizes.join(','));
    if (filters.unitKinds?.length) next.set('unit_kinds', filters.unitKinds.join(','));
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
    time_sensitive: filters.timeSensitive || undefined,
    divisions: filters.divisions.join(',') || undefined,
    categories: filters.categories.join(',') || undefined,
    brands: filters.brands.join(',') || undefined,
    sizes: filters.sizes.join(',') || undefined,
    unit_kinds: filters.unitKinds.join(',') || undefined,
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
  // New Items always shows the grid (the whole new-items set) — no search splash.
  const showGrid = newItems || committed.trim().length > 0 || !!wholesaler || countActiveFilters(filters) > 0;

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

  // A pure category aisle (Home View-all / chip click: one category, first
  // page, default sort, nothing else active) is the high-traffic entry point,
  // so those snapshots persist to localStorage for an instant paint. Other
  // combinations (keystrokes, deep filters, page > 1) stay in-memory only.
  const isAisleView = filters.categories.length === 1 && countActiveFilters(filters) === 1
    && !q.trim() && page === 0 && sort === 'product_name' && order === 'asc'
    && !wholesaler && !region && !varietal && !trackedOnly;

  const { data, isLoading } = useCachedQuery(
    ['products', q, wholesaler, sort, order, page, limit, trackedOnly, filterKey, region, varietal, newItems, introducedMonth, priceDetails],
    () => catalog.search({
      q,
      wholesaler: wholesaler || undefined,
      sort, order,
      limit, offset: page * limit,
      ...filterParams,
      // New Items = the last 4 loaded editions; optionally one introduced month.
      introduced_within_months: newItems ? 4 : undefined,
      introduced_edition: newItems ? (introducedMonth || undefined) : undefined,
      tracked_only: trackedOnly || undefined,
      // Storefront browsing: rows that have a product image rank first when
      // sorting by name (relevance still wins for typed searches).
      images_first: sort === 'product_name' ? true : undefined,
      // The general catalog's collapsed cards only need price + deal flags, not
      // the full tier ladder — so we skip include_tiers there (it's ~8x slower)
      // and fetch tiers per product on expand. New Items is a small curated set,
      // so when its cards show price details we fetch tiers up front to render
      // the QD/RIP ladder right on the card (no expand needed).
      include_tiers: (newItems && priceDetails) ? true : undefined,
      region: region || undefined,
      varietal: varietal || undefined,
    }),
    { enabled: showGrid, persist: isAisleView },
  );

  // Facets must mirror what the grid SHOWS: when /search spell-corrected (or
  // AI-corrected) the query, count facets on the corrected term, not the raw
  // misspelling (which matches nothing and blanked the whole filter rail).
  const effectiveQ = data?.corrected_query ?? q;
  const { data: facets } = useCachedQuery(
    ['products-facets', effectiveQ, wholesaler, filterKey, newItems, introducedMonth],
    () => catalog.facets({ q: effectiveQ, wholesaler: wholesaler || undefined, ...filterParams,
      introduced_within_months: newItems ? 4 : undefined,
      introduced_edition: newItems ? (introducedMonth || undefined) : undefined }),
    { enabled: showGrid && (!q.trim() || !!data), persist: isAisleView },
  );

  // Loaded editions: powers the New Items introduced-month filter AND the
  // general "RIP / QD month" rail toggle (current vs early-loaded next month).
  const { data: niEditions } = useQuery({
    queryKey: ['ni-editions'], queryFn: catalog.editions,
  });
  // The early-loaded NEXT edition (if any): the first loaded edition after the
  // current calendar month. Drives the rail "RIP / QD month" toggle.
  const nextLoadedEd = useMemo(() => {
    const d = new Date();
    const cym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    return [...new Set((niEditions ?? []).map(e => e.edition))].sort().find(e => e > cym) ?? null;
  }, [niEditions]);
  const curMonthShort = useMemo(() => _MONTHS[new Date().getMonth()] ?? 'This month', []);
  const nextMonthShort = useMemo(() => {
    if (!nextLoadedEd) return undefined;
    const m = /^(\d{4})-(\d{1,2})/.exec(nextLoadedEd);
    return m ? (_MONTHS[parseInt(m[2], 10) - 1] ?? nextLoadedEd) : nextLoadedEd;
  }, [nextLoadedEd]);
  const introMonthOpts = useMemo(
    () => [...new Set((niEditions ?? []).map(e => e.edition))].sort().reverse().slice(0, 4),
    [niEditions]);
  // Default the New Items view to the MOST RECENT introduced month (e.g. July)
  // so the freshest items show first; only auto-sets once and not over a manual
  // pick (incl. "Last 4 months").
  useEffect(() => {
    if (newItems && !niMonthDefaulted.current && introMonthOpts.length && introducedMonth === '') {
      niMonthDefaulted.current = true;
      setIntroducedMonth(introMonthOpts[0]);
      setPage(0);
    }
  }, [newItems, introMonthOpts, introducedMonth]);

  // New Items shows one card per newly-introduced FAMILY (not every size), so
  // grouping is forced on regardless of the persisted toggle.
  const effGrouped = newItems ? true : grouped;
  const items = (data?.items ?? []) as Product[];
  const total = data?.total ?? 0;
  const productCount = countProductGroups(items, effGrouped);

  // Publish the matched-row count so the AI assistant can echo the same number.
  const { report } = useResultCount();
  const { pathname } = useLocation();
  useEffect(() => { if (!isLoading) report(pathname, total); }, [isLoading, total, pathname, report]);

  const totalPages = Math.max(1, Math.ceil(total / limit));

  // "Hidden by filters" guard. A typed search that comes back EMPTY under active
  // filters is the #1 confusion: the deal filters (Dated deal this month, Has
  // RIP, In QD, In combo), a distributor tab, or region/varietal silently hide a
  // product the user is searching for by name — e.g. "aspen vodka" while "Dated
  // deal this month" is on (Aspen has no dated deal), which also suppresses the
  // hero type-ahead. Rather than a blank grid, probe the SAME query with no
  // filters and, when it would match, tell the user and offer a one-click clear.
  const constraintsActive = countActiveFilters(filters) > 0
    || !!wholesaler || !!region || !!varietal || trackedOnly;
  const gridEmpty = showGrid && !isLoading && !!data && total === 0;
  const { data: unfilteredProbe } = useQuery({
    enabled: gridEmpty && constraintsActive && q.trim().length > 0 && !newItems,
    queryKey: ['products-unfiltered-probe', q],
    queryFn: () => catalog.search({ q, limit: 1 }),
    staleTime: 60_000,
  });
  const hiddenByFilters = (gridEmpty && constraintsActive) ? (unfilteredProbe?.total ?? 0) : 0;
  const clearAllConstraints = () => {
    setFilters({ ...emptyCatalogFilters });
    setWholesaler(''); setRegion(''); setVarietal(''); setTrackedOnly(false);
    setPage(0);
  };

  // "View all" from Home lands on /products?categories=X: title the page after
  // the category so it reads as a storefront aisle, not a generic grid.
  const CATEGORY_LABELS: Record<string, string> = {
    Beer: 'Beer', Wine: 'Wine', Spirits: 'Spirits', RTD: 'Ready-to-Drink',
    FAB: 'Seltzer / FMB', Cider: 'Cider', Sparkling: 'Sparkling',
    Hemp: 'Hemp / THC', 'Non-Alcoholic': 'Non-Alcoholic',
  };
  const soleCategory = filters.categories.length === 1 && !q.trim() ? filters.categories[0] : null;
  const pageTitle = newItems ? 'New Items'
    : soleCategory ? (CATEGORY_LABELS[soleCategory] ?? soleCategory) : 'Products';

  // Category quick-browse chips (same set as the Home hero), shown under the
  // big search box on both the landing and the grid so users can hop aisles.
  const BROWSE: { key: string; label: string }[] = [
    { key: 'Beer', label: 'Beer' },
    { key: 'Wine', label: 'Wine' },
    { key: 'Spirits', label: 'Spirits' },
    { key: 'RTD', label: 'Ready-to-Drink' },
    { key: 'FAB', label: 'Seltzer / FMB' },
    { key: 'Cider', label: 'Cider' },
    { key: 'Non-Alcoholic', label: 'Non-Alcoholic' },
  ];
  const browseTo = (key: string) => {
    setQ(''); setCommitted('');
    setFilters(f => ({ ...f, categories: [key] }));
    setPage(0);
  };
  const browseChips = (
    <div className="products-grid-browse">
      {BROWSE.map(b => (
        <button key={b.key} type="button"
          className={`products-grid-chip${soleCategory === b.key ? ' on' : ''}`}
          onClick={() => browseTo(b.key)}>
          {b.label}
        </button>
      ))}
    </div>
  );

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
                title="Search" onClick={() => setCommitted(q)}>
                <Search size={16} /> Search
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
          {browseChips}
          <p className="products-splash-hint">
            Type a product and press <kbd className="products-hero-kbd">Enter</kbd>. Smart search handles brands, misspellings, sizes and barcodes.
          </p>
        </div>
      ) : (
      <>
      <div className="orders-header">
        <h2>{pageTitle}</h2>
        <WholesalerFilter value={wholesaler} onChange={v => { setWholesaler(v); setPage(0); }} />
      </div>

      {/* The BIG hero search stays on top in grid mode too, so View-all category
          pages and search results keep the storefront feel. Typing filters the
          grid live; the AI button parses natural language into filters. */}
      <div className="products-hero-box products-hero-box--grid">
        <div className="products-hero-search">
          <Search size={20} className="products-hero-icon" />
          <input type="text" autoFocus className="products-hero-input"
            placeholder="Search products, brands, regions, varietals…"
            value={q} onChange={e => { setQ(e.target.value); setPage(0); }}
            onKeyDown={e => { if (e.key === 'Enter') setCommitted(e.currentTarget.value); }} />
          <button type="button" className="products-hero-ai"
            title="Search" onClick={() => setCommitted(q)}>
            <Search size={16} /> Search
          </button>
        </div>
        {browseChips}
        <div className="products-hero-count">{isLoading ? 'Searching…' : `${total.toLocaleString()} items`}</div>
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

      <div className={`products-layout${railCollapsed ? ' products-layout--collapsed' : ''}${railDrawer ? ' products-layout--drawer' : ''}`}>
        {railDrawer && <div className="filter-rail-backdrop" onClick={() => toggleRail(true)} />}
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
            dealMonth={dealMonth}
            onDealMonthChange={setDealMonth}
            currentMonthLabel={curMonthShort}
            nextMonthLabel={nextMonthShort}
          />
        )}

        <div className="products-main">
          <div className="products-toolbar">
            <span className="products-showing">
              {isLoading ? 'Loading…' : effGrouped ? (
                <>Showing <strong>{productCount}</strong> {newItems ? 'new product' : 'product'}{productCount === 1 ? '' : 's'}
                  {' '}<span className="products-showing-sub">({total.toLocaleString()} sizes)</span></>
              ) : (
                <>Showing <strong>{productCount}</strong> listing{productCount === 1 ? '' : 's'}
                  {' '}<span className="products-showing-sub">by size &amp; distributor</span></>
              )}
            </span>
            <div className="products-toolbar-right">
              {/* New Items: filter to the month a product was introduced. */}
              {newItems && (
                <label className="products-sort">
                  <span>Introduced</span>
                  <select value={introducedMonth}
                    onChange={e => { niMonthDefaulted.current = true; setIntroducedMonth(e.target.value); setPage(0); }}>
                    {introMonthOpts.map(ed => <option key={ed} value={ed}>{monthLabel(ed)}</option>)}
                    <option value="">Last 4 months</option>
                  </select>
                </label>
              )}
              {/* Group toggle is hidden in New Items (always grouped by family). */}
              {!newItems && (
              <label className="products-group-toggle"
                title="OFF (default): one row per size per distributor, with multiple barcodes (vintages / closeouts) collapsed to the best price. ON: combine a product's sizes and distributors into one family card.">
                <input type="checkbox" checked={grouped}
                  onChange={e => { setGrouped(e.target.checked); setPage(0); }} />
                Group products
              </label>
              )}
              <div className="products-detail-toggle" role="group" aria-label="Deal detail level"
                title="Price details shows every QD/RIP tier on the cards; Summary keeps cards compact (expand a card for full details).">
                <button type="button" className={priceDetails ? 'on' : ''} onClick={() => setDetails(true)}>Price details</button>
                <button type="button" className={!priceDetails ? 'on' : ''} onClick={() => setDetails(false)}>Summary</button>
              </div>
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

          {hiddenByFilters > 0 && (
            <div className="products-hidden-banner" role="status"
              style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                margin: '0 0 12px', padding: '10px 14px', borderRadius: 8,
                border: '1px solid color-mix(in srgb, var(--accent) 35%, var(--bg))',
                background: 'color-mix(in srgb, var(--accent) 10%, var(--bg))', fontSize: 13 }}>
              <span>
                <strong>{hiddenByFilters.toLocaleString()}</strong> product{hiddenByFilters === 1 ? '' : 's'} match
                {' '}"<strong>{q.trim()}</strong>" but {hiddenByFilters === 1 ? 'is' : 'are'} hidden by your active filters
                {' '}(e.g. Dated deal / Has RIP / distributor).
              </span>
              <button type="button" className="btn btn-primary btn-sm" onClick={clearAllConstraints}>
                Clear filters &amp; show {hiddenByFilters === 1 ? 'it' : 'them'}
              </button>
            </div>
          )}
          {isLoading ? <p>Loading…</p> : (
            <ProductsGrid items={items} cart={cart} updateQty={updateQty} showDeals={priceDetails} grouped={effGrouped} expandAll={!newItems && !!q.trim()} dealMonth={dealMonth} />
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
