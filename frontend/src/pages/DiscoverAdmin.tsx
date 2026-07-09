/**
 * Discover Deals (Admin) — a parallel copy of Discover wired to the NEW
 * architecture: it reads the precomputed `deal_grid` via /api/catalog/discover-deals
 * (one indexed query, every value precomputed) instead of the live search + the
 * client-side merge/collapse/pricing that Discover does. Admin-only, for manual
 * A/B testing before we make it the permanent Discover page.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search, Store, SlidersHorizontal, PanelLeftClose, Clock } from 'lucide-react';
import { catalog, type MiRail, type DealGridCard } from '../lib/api';
import ProductThumb from '../components/ProductThumb';
import FavoriteButton from '../components/FavoriteButton';
import AvailabilityButton from '../components/AvailabilityButton';
import { distributorName, ALL_DISTRIBUTORS } from '../lib/distributors';
import './Discover.css';

const DIST_PINNED = ['allied', 'fedway', 'opici'];
const DISTRIBUTOR_OPTS = [...ALL_DISTRIBUTORS.filter((d) => d.value)].sort((a, b) => {
  const ia = DIST_PINNED.indexOf(a.value); const ib = DIST_PINNED.indexOf(b.value);
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
});
const SORT_OPTS: [string, string][] = [
  ['case', 'Largest Case Deal'], ['net', 'Net Discount'], ['name', 'Product name'],
  ['rip', 'Highest Case RIP'], ['qd', 'Highest Case QD'], ['pct', 'Deal %'],
];
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtMonth(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  return m ? `${MONTH_ABBR[parseInt(m[2], 10) - 1]}-${m[1].slice(2)}` : ym;
}
function money(n?: number | null): string | null {
  return n == null ? null : `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
function money2(n?: number | null): string | null {
  return n == null ? null : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function toggleIn(s: Set<string>, v: string): Set<string> {
  const n = new Set(s); n.has(v) ? n.delete(v) : n.add(v); return n;
}
// Deep-link to the exact SKU's product detail (mirrors Discover's productHref).
function cardHref(d: DealGridCard): string {
  const q = new URLSearchParams({ w: d.primary_wholesaler ?? '', n: d.product_name });
  if (d.upc) q.set('u', String(d.upc));
  if (d.unit_volume) q.set('s', String(d.unit_volume));
  if (d.unit_qty) q.set('pk', String(d.unit_qty));
  if (d.vintage != null && String(d.vintage) !== '') q.set('v', String(d.vintage));
  return `/product?${q.toString()}`;
}

// The three bottle prices, straight from deal_grid (no math here).
function BottlePrices({ d }: { d: DealGridCard }) {
  const tip = '1-case list bottle / after best QD / after best QD + RIP';
  return (
    <div className="disc-fav-prices" title={tip}>
      <span className="disc-bp-label">Bottle Price:</span>{' '}
      {money2(d.btl_1cs)}, {money2(d.btl_best_qd)}, {money2(d.btl_best_qd_rip)}
    </div>
  );
}

// One precomputed deal card — renders deal_grid fields directly.
function AdminDealCard({ d }: { d: DealGridCard }) {
  const dists = (d.wholesalers || d.primary_wholesaler || '').split(',').filter(Boolean);
  const primary = d.primary_wholesaler || dists[0] || '';
  const size = [d.unit_volume, d.pack ? `${d.pack}pk` : null].filter(Boolean).join(', ');
  return (
    <Link to={cardHref(d)} className="disc-card">
      <div className="disc-card-top">
        <span className="disc-card-dist" title={dists.map(distributorName).join(', ')}>
          <Store size={11} />{' '}
          {dists.length <= 1 ? distributorName(primary) : `${distributorName(primary)} +${dists.length - 1}`}
        </span>
        <FavoriteButton productName={d.product_name} wholesaler={primary}
          upc={d.upc ?? undefined} unitVolume={d.unit_volume ?? undefined} />
      </div>
      <AvailabilityButton wholesaler={primary} name={d.product_name}
        itemNumber={d.dist_item_no ?? undefined} className="disc-card-avail" />
      <div className="disc-card-media">
        <ProductThumb src={d.image_url} alt={d.product_name} size={120} />
        {d.is_time_sensitive && <span className="disc-ts-btn" title="Time-sensitive deal"><Clock size={12} /></span>}
      </div>
      <div className="disc-card-name">
        {d.display_name || d.product_name}
        {size && <span className="disc-fav-size"> ({size})</span>}
      </div>
      <BottlePrices d={d} />
      <div className="disc-card-deals">
        {d.has_rip && (
          <span className="disc-deal disc-deal--rip">
            Best RIP: {d.rip_qty} CS {money(d.rip_amount)} ({money(d.rip_per_case)}/cs)
          </span>
        )}
        {d.has_qd && (
          <span className="disc-deal disc-deal--qd">
            Best QD: {d.qd_qty} CS {money(d.qd_total)} ({money(d.qd_save_per_case)}/cs)
          </span>
        )}
      </div>
    </Link>
  );
}

// A category rail: one indexed query to deal_grid for this category + filters.
function AdminRail({ rail, dists, deals, sizes, sortBy, edition }:
  { rail: MiRail; dists: string[]; deals: string[]; sizes: string[]; sortBy: string; edition: string }) {
  const pr = rail.params || {};
  const params: Record<string, unknown> = {
    ...(pr.spirit_category ? { spirit_category: pr.spirit_category } : {}),
    ...(pr.grapes ? { grapes: pr.grapes } : {}),
    ...(pr.product_type ? { product_type: pr.product_type } : {}),
    ...(pr.q ? { q: pr.q } : {}),
    ...(edition ? { edition } : {}),
    ...(dists.length ? { divisions: dists.join(',') } : {}),
    ...(deals.length ? { deals: deals.join(',') } : {}),
    ...(sizes.length ? { sizes: sizes.join(',') } : {}),
    sort: sortBy, limit: 60,
  };
  const { data, isLoading } = useQuery({
    queryKey: ['dg-rail', rail.label, JSON.stringify(params)],
    queryFn: () => catalog.discoverDeals(params),
    staleTime: 300_000,
  });
  const items = data?.items ?? [];
  if (!isLoading && !items.length) return null;
  return (
    <section className="disc-rail">
      <div className="disc-rail-head">
        <h2 className="disc-rail-title">{rail.label} Deals</h2>
        <span className="disc-rail-count">{items.length}</span>
      </div>
      <div className="disc-rail-track">
        {isLoading
          ? <div className="disc-rail-loading">Loading…</div>
          : items.map((d, i) => <AdminDealCard key={`${d.primary_wholesaler}-${d.upc}-${d.unit_volume}-${i}`} d={d} />)}
      </div>
    </section>
  );
}

export default function DiscoverAdmin() {
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [distSet, setDistSet] = useState<Set<string>>(new Set());
  const [dealSet, setDealSet] = useState<Set<string>>(new Set());
  const [sizeSet, setSizeSet] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState('case');
  const [edition, setEdition] = useState('');
  const [collapsed, setCollapsed] = useState(false);

  const { data: cats } = useQuery({ queryKey: ['mi-top-categories'], queryFn: catalog.topCategories, staleTime: 3_600_000 });
  const { data: eds } = useQuery({ queryKey: ['editions'], queryFn: catalog.editions, staleTime: 3_600_000 });
  const months = [...new Set((eds ?? []).map((e) => e.edition))].sort().reverse();
  const rails: MiRail[] = [...(cats?.spirits ?? []), ...(cats?.wine ?? [])];

  const dists = [...distSet], deals = [...dealSet], sizes = [...sizeSet];
  const activeCount = distSet.size + dealSet.size + sizeSet.size + (edition ? 1 : 0);

  // Search: reuse the same endpoint with q (semantic name match over deal_grid).
  const searchParams: Record<string, unknown> = {
    q: submitted, ...(edition ? { edition } : {}),
    ...(dists.length ? { divisions: dists.join(',') } : {}),
    ...(deals.length ? { deals: deals.join(',') } : {}),
    ...(sizes.length ? { sizes: sizes.join(',') } : {}),
    sort: sortBy, limit: 120,
  };
  const { data: searchData } = useQuery({
    queryKey: ['dg-search', JSON.stringify(searchParams)],
    queryFn: () => catalog.discoverDeals(searchParams),
    enabled: !!submitted,
    staleTime: 300_000,
  });

  return (
    <div className="disc-page">
      <header className="disc-hero">
        <div className="disc-admin-badge">ADMIN · wired to deal_grid</div>
        <h1 className="disc-title">Celr AI · Discover Deals (Admin)</h1>
        <p className="disc-sub">New architecture: reads the precomputed deal_grid directly</p>
        <form className="disc-search" onSubmit={(e) => { e.preventDefault(); setSubmitted(q.trim()); }}>
          <Search size={18} className="disc-search-ic" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search deals — product, brand, region…" aria-label="Search deals" />
          {submitted && <button type="button" onClick={() => { setQ(''); setSubmitted(''); }}>Clear</button>}
          <button type="submit">Search</button>
        </form>
      </header>

      <div className={`disc-body${collapsed ? ' disc-body--nofilters' : ''}`}>
        {collapsed ? (
          <button type="button" className="disc-filters-show" onClick={() => setCollapsed(false)}>
            <SlidersHorizontal size={16} /> Filters{activeCount > 0 ? ` (${activeCount})` : ''}
          </button>
        ) : (
          <aside className="disc-filters">
            <div className="disc-filters-head">
              <span>Filters</span>
              <span className="disc-filters-head-actions">
                {activeCount > 0 && (
                  <button type="button" className="disc-filters-clear"
                    onClick={() => { setDistSet(new Set()); setDealSet(new Set()); setSizeSet(new Set()); setEdition(''); }}>Clear</button>
                )}
                <button type="button" className="disc-filters-collapse" title="Collapse filters" onClick={() => setCollapsed(true)}>
                  <PanelLeftClose size={16} />
                </button>
              </span>
            </div>
            <div className="disc-filter-sect">
              <div className="disc-filter-h">Month</div>
              <select className="disc-filter-select" value={edition} onChange={(e) => setEdition(e.target.value)}>
                <option value="">Current</option>
                {months.map((m) => <option key={m} value={m}>{fmtMonth(m)}</option>)}
              </select>
            </div>
            <div className="disc-filter-sect">
              <div className="disc-filter-h">Sort by</div>
              <select className="disc-filter-select" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                {SORT_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div className="disc-filter-sect">
              <div className="disc-filter-h">Deal</div>
              {[['rip', 'Has RIP'], ['qd', 'Has QD'], ['both', 'Has both QD & RIP'], ['time_sensitive', 'Time-sensitive']].map(([v, l]) => (
                <label key={v} className="disc-filter-opt">
                  <input type="checkbox" checked={dealSet.has(v)} onChange={() => setDealSet((s) => toggleIn(s, v))} />
                  <span>{l}</span>
                </label>
              ))}
            </div>
            <div className="disc-filter-sect">
              <div className="disc-filter-h">Size</div>
              {['375ML', '750ML', '1L', '1.75L'].map((s) => (
                <label key={s} className="disc-filter-opt">
                  <input type="checkbox" checked={sizeSet.has(s)} onChange={() => setSizeSet((x) => toggleIn(x, s))} />
                  <span>{s}</span>
                </label>
              ))}
            </div>
            <div className="disc-filter-sect">
              <div className="disc-filter-h">Distributor</div>
              {DISTRIBUTOR_OPTS.map((d) => (
                <label key={d.value} className="disc-filter-opt">
                  <input type="checkbox" checked={distSet.has(d.value)} onChange={() => setDistSet((s) => toggleIn(s, d.value))} />
                  <span>{d.label}</span>
                </label>
              ))}
            </div>
          </aside>
        )}

        <div className="disc-rails">
          {submitted ? (
            <section className="disc-rail">
              <div className="disc-rail-head"><h2 className="disc-rail-title">Deals matching “{submitted}”</h2>
                <span className="disc-rail-count">{searchData?.items?.length ?? 0}</span></div>
              <div className="disc-rail-track">
                {(searchData?.items ?? []).map((d, i) => <AdminDealCard key={`s-${d.upc}-${i}`} d={d} />)}
              </div>
            </section>
          ) : (
            rails.map((rail) => (
              <AdminRail key={rail.label} rail={rail} dists={dists} deals={deals} sizes={sizes} sortBy={sortBy} edition={edition} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
