import { useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams, useLocation, Link } from 'react-router-dom';
import { Search, SlidersHorizontal, Store, ChevronRight, ArrowLeft, ArrowUp, ArrowDown } from 'lucide-react';
import { catalog } from '../lib/api';
import type { Product } from '../lib/api';
import RowLimitSelect from '../components/RowLimitSelect';
import { useResultCount } from '../lib/resultCount';
import ProductsFilterRail from '../components/ProductsFilterRail';
import { useCachedQuery } from '../hooks/useCachedQuery';
import { useIsMobile } from '../hooks/useIsMobile';
import { emptyCatalogFilters } from '../components/CatalogFilterPanel';
import type { CatalogFilters } from '../components/CatalogFilterPanel';
import { distributorName } from '../lib/distributors';
import { bottlesPerCase } from '../lib/productSizes';

/**
 * Distributor Price List — pick a distributor, then see that distributor's full
 * catalogue as a TWO-MONTH price list: the current edition's price beside the
 * adjacent month (the NEXT edition when it's loaded, otherwise the PREVIOUS
 * one), with the month-over-month change. Smart search + the faceted filter rail
 * behave exactly as on the Products page; the distributor is the gate.
 */
const _MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 'YYYY-MM' -> 'Mon YYYY' (e.g. '2026-07' -> 'Jul 2026'). */
function monthLabel(ed?: string): string {
  if (!ed) return '';
  const m = /^(\d{4})-(\d{1,2})/.exec(ed);
  return m ? `${_MONTHS[parseInt(m[2], 10) - 1] ?? ''} ${m[1]}`.trim() : ed;
}
/** 'YYYY-MM' -> 'Mon' (short, for tight column heads). */
function monthShort(ed?: string): string {
  if (!ed) return '';
  const m = /^(\d{4})-(\d{1,2})/.exec(ed);
  return m ? (_MONTHS[parseInt(m[2], 10) - 1] ?? ed) : ed;
}
const money = (n?: number | null) => (n == null ? '—' : `$${n.toFixed(2)}`);
const normUpc = (u?: string | null) => (u ?? '').toString().replace(/^0+/, '');
/** Full SKU identity so a month's price is matched to the SAME item, never a
 *  sibling size/vintage (barcode + size + pack + vintage; name as a fallback
 *  when the barcode is a placeholder). Mirrors the app's SKU-identity rule. */
function skuKey(p: Product): string {
  const base = normUpc(p.upc) || (p.product_name ?? '').trim().toLowerCase();
  return `${base}|${(p.unit_volume ?? '').toLowerCase()}|${p.unit_qty ?? ''}|${p.vintage ?? ''}`;
}
function detailUrl(p: Product): string {
  const q = new URLSearchParams({ w: p.wholesaler, n: p.product_name });
  if (p.upc) q.set('u', String(p.upc));
  if (p.unit_volume) q.set('s', String(p.unit_volume));
  return `/product?${q.toString()}`;
}

export default function DistributorPriceList() {
  const [params, setSearchParams] = useSearchParams();
  const [wholesaler, setWholesaler] = useState(params.get('wholesaler') ?? '');
  const [q, setQ] = useState(params.get('q') ?? '');
  const [page, setPage] = useState(0);
  const [limit, setLimit] = useState(60);
  const [sort, setSort] = useState<'product_name' | 'frontline_case_price'>('product_name');
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [filters, setFilters] = useState<CatalogFilters>({ ...emptyCatalogFilters });
  const isMobile = useIsMobile();
  const [railCollapsed, setRailCollapsed] = useState(() =>
    (typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches)
      ? true : localStorage.getItem('dplFiltersCollapsed') === '1');
  const toggleRail = (v: boolean) => { setRailCollapsed(v); if (!isMobile) localStorage.setItem('dplFiltersCollapsed', v ? '1' : '0'); };
  useEffect(() => { if (isMobile) setRailCollapsed(true); }, [isMobile]);
  const railDrawer = isMobile && !railCollapsed;

  const [qDebounced, setQDebounced] = useState(q);
  useEffect(() => { const t = setTimeout(() => setQDebounced(q), 300); return () => clearTimeout(t); }, [q]);
  const [distQuery, setDistQuery] = useState('');

  // Distributor LOV data: item count of the latest edition + edition count.
  const { data: editions } = useQuery({ queryKey: ['dpl-editions'], queryFn: catalog.editions, staleTime: 300_000 });
  const distributors = useMemo(() => {
    const byWs = new Map<string, Map<string, number>>();
    for (const e of editions ?? []) {
      const m = byWs.get(e.wholesaler) ?? new Map<string, number>();
      m.set(e.edition, e.item_count ?? 0);
      byWs.set(e.wholesaler, m);
    }
    return [...byWs.entries()].map(([slug, itemsByEd]) => {
      const eds = [...itemsByEd.keys()].sort();
      const latest = eds[eds.length - 1];
      return { slug, name: distributorName(slug), latest, items: itemsByEd.get(latest) ?? 0 };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }, [editions]);
  const pickList = useMemo(() => {
    const t = distQuery.trim().toLowerCase();
    return t ? distributors.filter(d => d.name.toLowerCase().includes(t)) : distributors;
  }, [distributors, distQuery]);
  const selectedDist = distributors.find(d => d.slug === wholesaler);

  // The two editions to show. current = latest loaded edition on/before this
  // calendar month (else the earliest loaded); adjacent = the NEXT edition when
  // one is loaded, otherwise the PREVIOUS one.
  const cym = useMemo(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }, []);
  const { currentEd, adjacentEd, adjacentIsNext } = useMemo(() => {
    const eds = [...new Set((editions ?? []).filter(e => e.wholesaler === wholesaler).map(e => e.edition))].sort();
    if (!eds.length) return { currentEd: undefined as string | undefined, adjacentEd: undefined as string | undefined, adjacentIsNext: false };
    let i = -1;
    for (let k = 0; k < eds.length; k++) if (eds[k] <= cym) i = k;
    if (i === -1) i = 0;
    const cur = eds[i], next = eds[i + 1], prev = eds[i - 1];
    if (next) return { currentEd: cur, adjacentEd: next, adjacentIsNext: true };
    if (prev) return { currentEd: cur, adjacentEd: prev, adjacentIsNext: false };
    return { currentEd: cur, adjacentEd: undefined, adjacentIsNext: false };
  }, [editions, wholesaler, cym]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (wholesaler) next.set('wholesaler', wholesaler);
    if (q) next.set('q', q);
    if (next.toString() !== params.toString()) setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wholesaler, q]);

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

  // Current-edition page (paginated). One row per size (the catalogue's native
  // by-size listing) — exactly what a price list is.
  const { data, isLoading } = useCachedQuery(
    ['dpl', wholesaler, currentEd, qDebounced, sort, order, page, limit, filterKey],
    () => catalog.search({
      q: qDebounced, wholesaler, edition: currentEd || undefined,
      sort, order, limit, offset: page * limit, ...filterParams,
    }),
    { enabled: !!wholesaler && !!currentEd },
  );
  const items = (data?.items ?? []) as Product[];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  const effectiveQ = data?.corrected_query ?? qDebounced;
  const { data: facets } = useCachedQuery(
    ['dpl-facets', wholesaler, currentEd, effectiveQ, filterKey],
    () => catalog.facets({ q: effectiveQ, wholesaler, edition: currentEd || undefined, ...filterParams }),
    { enabled: !!wholesaler && !!currentEd && (!qDebounced.trim() || !!data) },
  );

  // Adjacent-month prices for just the UPCs ON THIS PAGE — cheap, and aligned to
  // the rows actually shown. Merged by full SKU identity.
  const upcCsv = useMemo(() => {
    const s = new Set<string>();
    for (const it of items) { const u = (it.upc ?? '').toString(); if (u) s.add(u); }
    return [...s].join(',');
  }, [items]);
  const { data: adjData } = useCachedQuery(
    ['dpl-adj', wholesaler, adjacentEd, upcCsv],
    () => catalog.search({ wholesaler, edition: adjacentEd, upcs: upcCsv, limit: 1000 }),
    { enabled: !!wholesaler && !!adjacentEd && upcCsv.length > 0 },
  );
  const adjMap = useMemo(() => {
    const m = new Map<string, Product>();
    // Only this distributor's rows (the UPC fetch could widen across houses).
    for (const p of (adjData?.items ?? []) as Product[]) {
      if (p.wholesaler === wholesaler) m.set(skuKey(p), p);
    }
    return m;
  }, [adjData, wholesaler]);

  const { report } = useResultCount();
  const { pathname } = useLocation();
  useEffect(() => { if (!isLoading && wholesaler) report(pathname, total); }, [isLoading, total, pathname, report, wholesaler]);

  const pickDistributor = (slug: string) => {
    setWholesaler(slug); setQ(''); setQDebounced(''); setFilters({ ...emptyCatalogFilters }); setPage(0);
  };

  const casePrice = (p?: Product | null) => p?.frontline_case_price ?? p?.effective_case_price ?? null;

  if (!wholesaler) {
    return (
      <div className="page products-page">
        <div className="dpl-pick">
          <header className="dpl-pick-head">
            <p className="dpl-pick-eyebrow"><Store size={13} /> Price List</p>
            <h1>Choose a distributor</h1>
            <p className="dpl-pick-sub">
              Open any distributor's complete price list — each item priced for
              two months side by side, with smart search and filters.
            </p>
            <div className="dpl-pick-search">
              <Search size={17} />
              <input type="text" autoFocus placeholder="Find a distributor…"
                value={distQuery} onChange={e => setDistQuery(e.target.value)} />
            </div>
          </header>
          <div className="dpl-grid">
            {pickList.map((d, i) => (
              <button key={d.slug} type="button" className="dpl-card"
                style={{ animationDelay: `${Math.min(i, 14) * 22}ms` }}
                onClick={() => pickDistributor(d.slug)}>
                <span className="dpl-card-name">{d.name}</span>
                <span className="dpl-card-meta">
                  <strong>{d.items.toLocaleString()}</strong> items
                  {d.latest ? <> · {monthLabel(d.latest)}</> : null}
                </span>
                <ChevronRight size={16} className="dpl-card-arrow" />
              </button>
            ))}
            {pickList.length === 0 && <p className="dpl-empty">No distributor matches “{distQuery}”.</p>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page products-page">
      <div className="orders-header dpl-topbar">
        <div className="dpl-topbar-left">
          <button type="button" className="dpl-back" onClick={() => setWholesaler('')} title="Choose a different distributor">
            <ArrowLeft size={16} />
          </button>
          <div>
            <div className="dpl-topbar-eyebrow">Distributor Price List</div>
            <h2 className="dpl-topbar-name">{distributorName(wholesaler)}</h2>
          </div>
        </div>
        <button type="button" className="dpl-switch" onClick={() => setWholesaler('')}>
          <span className="dpl-switch-meta">
            {selectedDist ? `${selectedDist.items.toLocaleString()} items` : ''}
            {currentEd ? ` · ${monthLabel(currentEd)}` : ''}
          </span>
          <span className="dpl-switch-change">Change</span>
        </button>
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

      <div className={`products-layout${railCollapsed ? ' products-layout--collapsed' : ''}${railDrawer ? ' products-layout--drawer' : ''}`}>
        {railDrawer && <div className="filter-rail-backdrop" onClick={() => toggleRail(true)} />}
        {railCollapsed ? (
          <button type="button" className="prod-rail-reopen" onClick={() => toggleRail(false)} title="Show filters">
            <SlidersHorizontal size={15} />
            <span className="prod-rail-reopen-label">Filters</span>
          </button>
        ) : (
          <ProductsFilterRail filters={filters} onChange={f => { setFilters(f); setPage(0); }}
            items={items} facets={facets} onCollapse={() => toggleRail(true)} />
        )}

        <div className="products-main">
          <div className="products-toolbar">
            <span className="products-showing">
              {isLoading ? 'Loading…' : <>Showing <strong>{items.length}</strong> of {total.toLocaleString()} items</>}
              {adjacentEd && (
                <span className="products-showing-sub">
                  {' '}· comparing {monthLabel(currentEd)} vs {monthLabel(adjacentEd)}
                </span>
              )}
            </span>
            <div className="products-toolbar-right">
              <label className="products-sort">
                <span>Sort by</span>
                <select value={`${sort}:${order}`}
                  onChange={e => { const [s, o] = e.target.value.split(':') as [typeof sort, typeof order]; setSort(s); setOrder(o); setPage(0); }}>
                  <option value="product_name:asc">Name (A–Z)</option>
                  <option value="product_name:desc">Name (Z–A)</option>
                  <option value="frontline_case_price:asc">Price (low → high)</option>
                  <option value="frontline_case_price:desc">Price (high → low)</option>
                </select>
              </label>
              <RowLimitSelect value={limit} onChange={v => { setLimit(v); setPage(0); }} />
            </div>
          </div>

          {isLoading ? <p>Loading…</p> : total === 0 ? (
            <p className="dpl-empty">No items match. Try clearing the search or filters.</p>
          ) : (
            <div className="dpl-table-wrap">
              <table className="dpl-table">
                <thead>
                  <tr>
                    <th className="dpl-th-prod">Product</th>
                    <th className="dpl-th-num dpl-th-current">
                      {monthShort(currentEd)} <span className="dpl-th-tag">current</span>
                    </th>
                    <th className="dpl-th-num">
                      {adjacentEd ? monthShort(adjacentEd) : '—'}
                      {adjacentEd && <span className="dpl-th-tag dpl-th-tag--adj">{adjacentIsNext ? 'next' : 'prev'}</span>}
                    </th>
                    <th className="dpl-th-num">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(row => {
                    const adj = adjMap.get(skuKey(row));
                    const curC = casePrice(row);
                    const adjC = casePrice(adj);
                    const pack = bottlesPerCase(row.product_name, row.unit_qty);
                    const curB = curC != null && pack ? curC / pack : null;
                    const adjB = adjC != null && pack ? adjC / pack : null;
                    // Change reads chronologically (later − earlier): up = price rose.
                    const earlier = adjacentIsNext ? curC : adjC;
                    const later = adjacentIsNext ? adjC : curC;
                    const delta = earlier != null && later != null ? Math.round((later - earlier) * 100) / 100 : null;
                    const pct = delta != null && earlier ? (delta / earlier) * 100 : null;
                    const flat = delta != null && Math.abs(delta) < 0.005;
                    const dir = delta == null ? null : flat ? 'flat' : delta > 0 ? 'up' : 'down';
                    const meta = [row.product_type, row.unit_volume, row.brand].filter(Boolean).join(' · ');
                    return (
                      <tr key={skuKey(row) + (row.edition ?? '')}>
                        <td className="dpl-td-prod">
                          <Link to={detailUrl(row)} className="dpl-prod-name">{row.product_name}</Link>
                          {meta && <div className="dpl-prod-meta">{meta}</div>}
                        </td>
                        <td className="dpl-td-num dpl-td-current">
                          <span className="dpl-price">{money(curC)}</span>
                          {curB != null && <span className="dpl-price-btl">{money(curB)}/btl</span>}
                        </td>
                        <td className="dpl-td-num">
                          {adjC != null ? (
                            <>
                              <span className="dpl-price">{money(adjC)}</span>
                              {adjB != null && <span className="dpl-price-btl">{money(adjB)}/btl</span>}
                            </>
                          ) : adjacentEd ? (
                            <span className="dpl-tag-missing">{adjacentIsNext ? 'not in next' : 'new'}</span>
                          ) : '—'}
                        </td>
                        <td className="dpl-td-num">
                          {delta == null ? <span className="dpl-chg-na">—</span> : flat ? (
                            <span className="dpl-chg dpl-chg--flat">no change</span>
                          ) : (
                            <span className={`dpl-chg dpl-chg--${dir}`}>
                              {dir === 'up' ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
                              {money(Math.abs(delta))}{pct != null && <> ({Math.abs(pct).toFixed(1)}%)</>}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="pagination">
            <button disabled={page === 0} onClick={() => setPage(p => p - 1)}>Prev</button>
            <span>Page {page + 1} of {totalPages}</span>
            <button disabled={(page + 1) * limit >= total} onClick={() => setPage(p => p + 1)}>Next</button>
          </div>
        </div>
      </div>
    </div>
  );
}
