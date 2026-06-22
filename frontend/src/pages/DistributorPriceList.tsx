import { useState, useCallback, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams, useLocation } from 'react-router-dom';
import { Search, SlidersHorizontal, Store } from 'lucide-react';
import { catalog } from '../lib/api';
import type { Product } from '../lib/api';
import RowLimitSelect from '../components/RowLimitSelect';
import { useResultCount } from '../lib/resultCount';
import { loadCart, saveCart, type CartState } from '../components/CatalogTable';
import ProductsFilterRail from '../components/ProductsFilterRail';
import ProductsGrid, { countProductGroups } from '../components/ProductsGrid';
import { useCachedQuery } from '../hooks/useCachedQuery';
import { emptyCatalogFilters } from '../components/CatalogFilterPanel';
import type { CatalogFilters } from '../components/CatalogFilterPanel';
import { distributorName } from '../lib/distributors';

/**
 * Distributor Price List — pick a distributor from the LOV and browse that
 * distributor's ENTIRE catalogue. It reuses the same machinery as the Products
 * page (smart/semantic `/catalog/search`, the faceted filter rail, the grid,
 * the cart) but locks the result set to ONE distributor chosen up front. No
 * grid shows until a distributor is selected — the distributor is the gate.
 */
export default function DistributorPriceList() {
  const [params, setSearchParams] = useSearchParams();
  const [wholesaler, setWholesaler] = useState(params.get('wholesaler') ?? '');
  const [q, setQ] = useState(params.get('q') ?? '');
  const [page, setPage] = useState(0);
  const [limit, setLimit] = useState(60);
  const [sort, setSort] = useState<'product_name' | 'frontline_case_price' | 'effective_case_price'>('product_name');
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [filters, setFilters] = useState<CatalogFilters>({ ...emptyCatalogFilters });
  const [cart, setCartState] = useState<CartState>(loadCart);
  // A distributor's price list reads as a flat list of every size/SKU it sells,
  // so default the grouped (cross-distributor family) view OFF; the toggle is
  // still offered. Persisted.
  const [grouped, setGroupedState] = useState(() => localStorage.getItem('dpl_grouped') === '1');
  const setGrouped = (v: boolean) => { setGroupedState(v); localStorage.setItem('dpl_grouped', v ? '1' : '0'); };
  const [priceDetails, setPriceDetails] = useState(() => localStorage.getItem('dpl_price_details') !== '0');
  const setDetails = (v: boolean) => { setPriceDetails(v); localStorage.setItem('dpl_price_details', v ? '1' : '0'); };
  const [railCollapsed, setRailCollapsed] = useState(() => localStorage.getItem('dplFiltersCollapsed') === '1');
  const toggleRail = (v: boolean) => { setRailCollapsed(v); localStorage.setItem('dplFiltersCollapsed', v ? '1' : '0'); };

  // Debounce the search box so the list filters without a request per keystroke.
  const [qDebounced, setQDebounced] = useState(q);
  useEffect(() => { const t = setTimeout(() => setQDebounced(q), 300); return () => clearTimeout(t); }, [q]);

  // The LOV: every distributor that has a loaded price list, by display name.
  const { data: editions } = useQuery({ queryKey: ['dpl-editions'], queryFn: catalog.editions, staleTime: 300_000 });
  const distributors = useMemo(() => {
    const slugs = [...new Set((editions ?? []).map(e => e.wholesaler))];
    return slugs
      .map(s => ({ slug: s, name: distributorName(s) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [editions]);

  // URL <-> state so a chosen distributor + search is shareable / survives Back.
  useEffect(() => {
    const next = new URLSearchParams();
    if (wholesaler) next.set('wholesaler', wholesaler);
    if (q) next.set('q', q);
    if (next.toString() !== params.toString()) setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wholesaler, q]);

  const setCart = useCallback((update: CartState | ((p: CartState) => CartState)) => {
    setCartState(prev => { const n = typeof update === 'function' ? update(prev) : update; saveCart(n); return n; });
  }, []);
  const updateQty = useCallback((key: string, field: 'cases' | 'units', value: number) => {
    setCart(prev => ({ ...prev, [key]: { cases: prev[key]?.cases ?? 0, units: prev[key]?.units ?? 0, [field]: value } }));
  }, [setCart]);

  const filterParams = {
    has_rip: filters.hasRip,
    has_discount: filters.hasDiscount,
    in_combo: filters.inCombo || undefined,
    time_sensitive: filters.timeSensitive || undefined,
    categories: filters.categories.join(',') || undefined,
    brands: filters.brands.join(',') || undefined,
    sizes: filters.sizes.join(',') || undefined,
    unit_kinds: filters.unitKinds.join(',') || undefined,
    min_price: filters.priceMin,
    max_price: filters.priceMax,
  };
  const filterKey = JSON.stringify(filters);

  const { data, isLoading } = useCachedQuery(
    ['distlist', wholesaler, qDebounced, sort, order, page, limit, filterKey],
    () => catalog.search({
      q: qDebounced,
      wholesaler,                 // locked to the LOV selection
      sort, order, limit, offset: page * limit,
      ...filterParams,
      images_first: sort === 'product_name' ? true : undefined,
    }),
    { enabled: !!wholesaler },
  );

  const effectiveQ = data?.corrected_query ?? qDebounced;
  const { data: facets } = useCachedQuery(
    ['distlist-facets', wholesaler, effectiveQ, filterKey],
    () => catalog.facets({ q: effectiveQ, wholesaler, ...filterParams }),
    { enabled: !!wholesaler && (!qDebounced.trim() || !!data) },
  );

  const items = (data?.items ?? []) as Product[];
  const total = data?.total ?? 0;
  const productCount = countProductGroups(items, grouped);
  const totalPages = Math.max(1, Math.ceil(total / limit));

  const { report } = useResultCount();
  const { pathname } = useLocation();
  useEffect(() => { if (!isLoading && wholesaler) report(pathname, total); }, [isLoading, total, pathname, report, wholesaler]);

  const pickDistributor = (slug: string) => {
    setWholesaler(slug);
    setQ(''); setQDebounced('');
    setFilters({ ...emptyCatalogFilters });
    setPage(0);
  };

  // The LOV control, reused in the empty state (big) and the header (compact).
  const lov = (
    <select className="dpl-lov" value={wholesaler} onChange={e => pickDistributor(e.target.value)}>
      <option value="">Select a distributor…</option>
      {distributors.map(d => <option key={d.slug} value={d.slug}>{d.name}</option>)}
    </select>
  );

  return (
    <div className="page products-page">
      {!wholesaler ? (
        <div className="dpl-gate">
          <div className="dpl-gate-icon"><Store size={30} /></div>
          <h1 className="dpl-gate-title">Distributor Price List</h1>
          <p className="dpl-gate-sub">
            Choose a distributor to view their complete price list. You can then
            search and filter their items just like the Products page.
          </p>
          <div className="dpl-gate-lov">{lov}</div>
        </div>
      ) : (
        <>
          <div className="orders-header">
            <h2>Distributor Price List</h2>
            <div className="dpl-header-lov">
              <span className="dpl-header-lov-label">Distributor</span>
              {lov}
            </div>
          </div>

          <div className="products-hero-box products-hero-box--grid">
            <div className="products-hero-search">
              <Search size={20} className="products-hero-icon" />
              <input type="text" className="products-hero-input"
                placeholder={`Search ${distributorName(wholesaler)}'s items — name, brand, size or barcode…`}
                value={q} onChange={e => { setQ(e.target.value); setPage(0); }} />
            </div>
            <div className="products-hero-count">{isLoading ? 'Loading…' : `${total.toLocaleString()} items`}</div>
          </div>
          {data?.corrected_query && data.corrected_query.toLowerCase() !== qDebounced.trim().toLowerCase() && (
            <p className="search-correction" style={{ fontSize: 13, color: 'var(--text-muted)', margin: '-4px 0 12px' }}>
              No exact match for "{qDebounced.trim()}". Showing results for{' '}
              <button type="button" className="link-btn" onClick={() => { setQ(data.corrected_query!); setPage(0); }}
                style={{ background: 'none', border: 0, padding: 0, color: 'var(--accent)', fontWeight: 600, cursor: 'pointer' }}>
                "{data.corrected_query}"
              </button>.
            </p>
          )}

          <div className={`products-layout${railCollapsed ? ' products-layout--collapsed' : ''}`}>
            {railCollapsed ? (
              <button type="button" className="prod-rail-reopen" onClick={() => toggleRail(false)} title="Show filters">
                <SlidersHorizontal size={15} />
                <span className="prod-rail-reopen-label">Filters</span>
              </button>
            ) : (
              <ProductsFilterRail
                filters={filters}
                onChange={f => { setFilters(f); setPage(0); }}
                items={items}
                facets={facets}
                onCollapse={() => toggleRail(true)}
              />
            )}

            <div className="products-main">
              <div className="products-toolbar">
                <span className="products-showing">
                  {isLoading ? 'Loading…' : grouped ? (
                    <>Showing <strong>{productCount}</strong> product{productCount === 1 ? '' : 's'}
                      {' '}<span className="products-showing-sub">({total.toLocaleString()} sizes)</span></>
                  ) : (
                    <>Showing <strong>{productCount}</strong> listing{productCount === 1 ? '' : 's'}
                      {' '}<span className="products-showing-sub">by size</span></>
                  )}
                </span>
                <div className="products-toolbar-right">
                  <label className="products-group-toggle"
                    title="OFF (default): one row per size. ON: combine a product's sizes into one family card.">
                    <input type="checkbox" checked={grouped} onChange={e => { setGrouped(e.target.checked); setPage(0); }} />
                    Group products
                  </label>
                  <div className="products-detail-toggle" role="group" aria-label="Deal detail level"
                    title="Price details shows every QD/RIP tier on the cards; Summary keeps cards compact.">
                    <button type="button" className={priceDetails ? 'on' : ''} onClick={() => setDetails(true)}>Price details</button>
                    <button type="button" className={!priceDetails ? 'on' : ''} onClick={() => setDetails(false)}>Summary</button>
                  </div>
                  <label className="products-sort">
                    <span>Sort by</span>
                    <select value={`${sort}:${order}`}
                      onChange={e => { const [s, o] = e.target.value.split(':') as [typeof sort, typeof order]; setSort(s); setOrder(o); setPage(0); }}>
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

              {isLoading ? <p>Loading…</p> : total === 0 ? (
                <p className="dpl-empty">No items match. Try clearing the search or filters.</p>
              ) : (
                <ProductsGrid items={items} cart={cart} updateQty={updateQty}
                  showDeals={priceDetails} grouped={grouped} expandAll={!!qDebounced.trim()} dealMonth="current" />
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
