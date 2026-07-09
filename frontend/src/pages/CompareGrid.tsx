/**
 * Compare Distributor Prices (redesign) — Discover-style category card rails, but
 * each card is a CROSS-DISTRIBUTOR comparison: the cheapest-net distributor for a
 * product group, how much cheaper it is than the dearest (% gap + $/cs spread),
 * plus RIP/QD. Reads the precomputed sku_offer grid via /api/catalog/compare-grid.
 * Mirrors DiscoverAdmin's layout exactly (same card, filters, rails, mobile).
 * Search waits for Enter/submit (no search-as-you-type).
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search, Store, SlidersHorizontal, PanelLeftClose } from 'lucide-react';
import { catalog, type MiRail, type CompareGridCard } from '../lib/api';
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
  ['diff', 'Biggest price gap'], ['mi', 'Top sellers'], ['price', 'Lowest price'], ['name', 'Product name'],
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
function cardHref(d: CompareGridCard): string {
  const q = new URLSearchParams({ w: d.wholesaler ?? '', n: d.product_name });
  if (d.upc) q.set('u', String(d.upc));
  if (d.unit_volume) q.set('s', String(d.unit_volume));
  if (d.unit_qty) q.set('pk', String(d.unit_qty));
  if (d.vintage != null && String(d.vintage) !== '') q.set('v', String(d.vintage));
  return `/product?${q.toString()}`;
}

// One cross-distributor comparison card (same shell as the Discover deal card).
function CompareCard({ d }: { d: CompareGridCard }) {
  const pct = d.pct_diff != null ? Math.round(d.pct_diff * 100) : null;
  const size = [d.unit_volume, d.unit_qty ? `${d.unit_qty}/cs` : null].filter(Boolean).join(', ');
  const dist = d.wholesaler ?? '';
  return (
    <Link to={cardHref(d)} className="disc-card">
      <div className="disc-card-top">
        <span className="disc-card-dist" title={`Cheapest at ${distributorName(dist)}`}>
          <Store size={11} /> {distributorName(dist)}
        </span>
        <FavoriteButton productName={d.product_name} wholesaler={dist}
          upc={d.upc ?? undefined} unitVolume={d.unit_volume ?? undefined} />
      </div>
      <AvailabilityButton wholesaler={dist} name={d.product_name}
        itemNumber={d.item_no ?? undefined} className="disc-card-avail" />
      <div className="disc-card-media">
        <ProductThumb src={d.image_url ?? undefined} alt={d.product_name} size={120} />
      </div>
      <div className="disc-card-name">
        {d.display_name || d.product_name}
        {size && <span className="disc-fav-size"> ({size})</span>}
      </div>
      <div className="disc-fav-prices" title="Cheapest distributor: per bottle / per case (after best QD + RIP)">
        <span className="disc-bp-label">Best price:</span> {money2(d.btl_effective)}/btl · {money(d.effective_case_price)}/cs
      </div>
      <div className="disc-card-deals">
        {(d.n_distributors ?? 0) > 1 && pct != null && pct > 0 && (
          <span className="disc-deal disc-deal--diff">
            {d.n_distributors} distributors · save up to {pct}% ({money(d.spread_net)}/cs) vs dearest
          </span>
        )}
        {d.has_rip && <span className="disc-deal disc-deal--rip">Has RIP</span>}
        {d.has_discount && <span className="disc-deal disc-deal--qd">Has QD</span>}
      </div>
    </Link>
  );
}

// A category rail: one /compare-grid query. Blend/style wine rails (q, no grape)
// resolve through the shared semantic search first, then read the grid by UPC.
function CompareRail({ rail, dists, deals, sizes, sortBy, edition }:
  { rail: MiRail; dists: string[]; deals: string[]; sizes: string[]; sortBy: string; edition: string }) {
  const pr = rail.params || {};
  const params: Record<string, unknown> = {
    ...(pr.spirit_category ? { spirit_category: pr.spirit_category } : {}),
    ...(pr.grapes ? { grapes: pr.grapes } : {}),
    ...(pr.product_type ? { product_type: pr.product_type } : {}),
    ...(edition ? { edition } : {}),
    ...(dists.length ? { divisions: dists.join(',') } : {}),
    ...(deals.length ? { deals: deals.join(',') } : {}),
    ...(sizes.length ? { sizes: sizes.join(',') } : {}),
    sort: sortBy, limit: 60,
  };
  const isBlend = !!pr.q && !pr.grapes && !pr.spirit_category;
  const { data, isLoading } = useQuery({
    queryKey: ['cg-rail', rail.label, JSON.stringify(params)],
    staleTime: 300_000,
    queryFn: async () => {
      if (isBlend) {
        const s = await catalog.search({ q: pr.q, ...(pr.product_type ? { product_type: pr.product_type } : {}), limit: 120, ...(edition ? { edition } : {}) });
        const upcs = [...new Set((s.items || []).map((i) => i.upc).filter(Boolean))].join(',');
        if (!upcs) return { edition: '', count: 0, items: [] as CompareGridCard[] };
        return catalog.compareGrid({
          upcs, ...(edition ? { edition } : {}),
          ...(dists.length ? { divisions: dists.join(',') } : {}),
          ...(deals.length ? { deals: deals.join(',') } : {}),
          ...(sizes.length ? { sizes: sizes.join(',') } : {}),
          sort: sortBy, limit: 60,
        });
      }
      return catalog.compareGrid(params);
    },
  });
  const items = data?.items ?? [];
  if (!isLoading && !items.length) return null;
  return (
    <section className="disc-rail">
      <div className="disc-rail-head">
        <h2 className="disc-rail-title">{rail.label}</h2>
        <span className="disc-rail-count">{items.length}</span>
      </div>
      <div className="disc-rail-track">
        {isLoading
          ? <div className="disc-rail-loading">Loading…</div>
          : items.map((d, i) => <CompareCard key={`${d.wholesaler}-${d.upc}-${d.unit_volume}-${i}`} d={d} />)}
      </div>
    </section>
  );
}

export default function CompareGrid() {
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [distSet, setDistSet] = useState<Set<string>>(new Set());
  const [dealSet, setDealSet] = useState<Set<string>>(new Set());
  const [sizeSet, setSizeSet] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState('diff');
  const [edition, setEdition] = useState('');
  const [collapsed, setCollapsed] = useState(false);

  const { data: cats } = useQuery({ queryKey: ['mi-top-categories'], queryFn: catalog.topCategories, staleTime: 3_600_000 });
  const { data: eds } = useQuery({ queryKey: ['editions'], queryFn: catalog.editions, staleTime: 3_600_000 });
  const months = [...new Set((eds ?? []).map((e) => e.edition))].sort().reverse();
  const rails: MiRail[] = [...(cats?.spirits ?? []), ...(cats?.wine ?? [])];

  const dists = [...distSet], deals = [...dealSet], sizes = [...sizeSet];
  const activeCount = distSet.size + dealSet.size + sizeSet.size + (edition ? 1 : 0);

  // Search waits for Enter/submit: resolve the query semantically, then read the
  // grid for those UPCs (no search-as-you-type).
  const { data: searchData } = useQuery({
    queryKey: ['cg-search', submitted, edition, dists.join(','), deals.join(','), sizes.join(','), sortBy],
    enabled: !!submitted,
    staleTime: 300_000,
    queryFn: async () => {
      const s = await catalog.search({ q: submitted, limit: 100, ...(edition ? { edition } : {}) });
      const upcs = [...new Set((s.items || []).map((i) => i.upc).filter(Boolean))].join(',');
      if (!upcs) return { edition, count: 0, items: [] as CompareGridCard[] };
      return catalog.compareGrid({
        upcs, ...(edition ? { edition } : {}),
        ...(dists.length ? { divisions: dists.join(',') } : {}),
        ...(deals.length ? { deals: deals.join(',') } : {}),
        ...(sizes.length ? { sizes: sizes.join(',') } : {}),
        sort: sortBy, limit: 120,
      });
    },
  });

  return (
    <div className="disc-page">
      <header className="disc-hero">
        <h1 className="disc-title">Compare Distributor Prices</h1>
        <p className="disc-sub">Same product, every distributor — who's cheapest and by how much</p>
      </header>

      <div className="disc-body">
        <button type="button" className={`disc-filters-show${collapsed ? '' : ' is-hidden'}`} onClick={() => setCollapsed(false)}>
          <SlidersHorizontal size={15} /> Filters{activeCount ? ` (${activeCount})` : ''}
        </button>

        <aside className={`disc-filters${collapsed ? ' is-collapsed' : ''}`}>
          <div className="disc-filters-head">
            <span className="disc-filters-title"><SlidersHorizontal size={15} /> Filters</span>
            <button type="button" className="disc-filters-collapse" onClick={() => setCollapsed(true)} title="Hide filters">
              <PanelLeftClose size={16} />
            </button>
          </div>

          {/* Search — submit on Enter, no search-as-you-type */}
          <form className="disc-filter-sect" onSubmit={(e) => { e.preventDefault(); setSubmitted(q.trim()); }}>
            <div className="disc-search">
              <Search size={15} />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Product or brand… (press Enter)" />
              {submitted && <button type="button" className="disc-search-clear" onClick={() => { setQ(''); setSubmitted(''); }}>×</button>}
            </div>
          </form>

          <div className="disc-filter-sect">
            <label className="disc-filter-label">Month</label>
            <select value={edition} onChange={(e) => setEdition(e.target.value)}>
              <option value="">Current</option>
              {months.map((m) => <option key={m} value={m}>{fmtMonth(m)}</option>)}
            </select>
          </div>

          <div className="disc-filter-sect">
            <label className="disc-filter-label">Sort by</label>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              {SORT_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>

          <div className="disc-filter-sect">
            <label className="disc-filter-label">Deal</label>
            {[['rip', 'Has RIP'], ['qd', 'Has QD'], ['both', 'Has both QD & RIP']].map(([v, l]) => (
              <label key={v} className="disc-check">
                <input type="checkbox" checked={dealSet.has(v)} onChange={() => setDealSet(toggleIn(dealSet, v))} /> {l}
              </label>
            ))}
          </div>

          <div className="disc-filter-sect">
            <label className="disc-filter-label">Size</label>
            {['375ML', '750ML', '1L', '1.75L'].map((s) => (
              <label key={s} className="disc-check">
                <input type="checkbox" checked={sizeSet.has(s)} onChange={() => setSizeSet(toggleIn(sizeSet, s))} /> {s}
              </label>
            ))}
          </div>

          <div className="disc-filter-sect">
            <label className="disc-filter-label">Distributor</label>
            {DISTRIBUTOR_OPTS.map((d) => (
              <label key={d.value} className="disc-check">
                <input type="checkbox" checked={distSet.has(d.value)} onChange={() => setDistSet(toggleIn(distSet, d.value))} /> {d.label}
              </label>
            ))}
          </div>
        </aside>

        <main className="disc-rails">
          {submitted ? (
            <section className="disc-rail">
              <div className="disc-rail-head">
                <h2 className="disc-rail-title">Matching “{submitted}”</h2>
                <span className="disc-rail-count">{searchData?.items?.length ?? 0}</span>
              </div>
              <div className="disc-rail-track">
                {(searchData?.items ?? []).map((d, i) => <CompareCard key={`s-${d.wholesaler}-${d.upc}-${i}`} d={d} />)}
              </div>
            </section>
          ) : (
            rails.map((rail) => (
              <CompareRail key={rail.label} rail={rail} dists={dists} deals={deals} sizes={sizes} sortBy={sortBy} edition={edition} />
            ))
          )}
        </main>
      </div>
    </div>
  );
}
