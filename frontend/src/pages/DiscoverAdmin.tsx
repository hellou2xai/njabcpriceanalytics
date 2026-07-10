/**
 * Discover Deals (Admin) — a parallel copy of Discover wired to the NEW
 * architecture: it reads the precomputed `deal_grid` via /api/catalog/discover-deals
 * (one indexed query, every value precomputed) instead of the live search + the
 * client-side merge/collapse/pricing that Discover does. Admin-only, for manual
 * A/B testing before we make it the permanent Discover page.
 */
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search, Store, SlidersHorizontal, PanelLeftClose, Clock, ChevronDown } from 'lucide-react';
import { catalog, watchlist, type MiRail, type DealGridCard, type Product, type WatchlistItem } from '../lib/api';
import ProductThumb from '../components/ProductThumb';
import FavoriteButton from '../components/FavoriteButton';
import AvailabilityButton from '../components/AvailabilityButton';
import { distributorName, ALL_DISTRIBUTORS } from '../lib/distributors';
import { bottlesPerCase } from '../lib/productSizes';
import './Discover.css';

// Product deep-link (favourites are live Product rows, not deal_grid cards).
function productHref(p: Product): string {
  const q = new URLSearchParams({ w: p.wholesaler, n: p.product_name });
  if (p.upc) q.set('u', String(p.upc));
  if (p.unit_volume) q.set('s', String(p.unit_volume));
  if (p.unit_qty) q.set('pk', String(p.unit_qty));
  if (p.vintage != null && String(p.vintage) !== '') q.set('v', String(p.vintage));
  return `/product?${q.toString()}`;
}
function ripPerCaseP(p: Product): number {
  const rip = (p.tiers ?? []).filter((t) => t.source === 'rip')
    .reduce<{ qty?: number; save_per_case?: number } | null>((a, b) => (!a || (b.qty ?? 0) > (a.qty ?? 0) ? b : a), null);
  return rip?.save_per_case ?? 0;  // unit-aware per-case (not amount/qty)
}
// Quantity + its unit read together: a bottle-unit tier is bottles, not cases.
function qtyUnit(qty?: number | null, unit?: string | null): string {
  if (qty == null) return '';
  return `${qty} ${/^b/i.test(unit || '') ? 'btl' : 'CS'}`;
}

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

// The three bottle prices, straight from deal_grid (no math here). X1 is the
// per-bottle price AFTER the 1-case QD (see precompute_deals `btl_1cs`).
function BottlePrices({ d }: { d: DealGridCard }) {
  const tip = 'after 1-case QD / after best QD / after best QD + RIP';
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
  // Bottle size · case pack, e.g. "750ML · 6/cs" — shown on its own labelled line.
  const size = [d.unit_volume, d.pack ? `${d.pack}/cs` : null].filter(Boolean).join(' · ');
  // Vintage on the card — bold, and distinctly badged for WINE (a barcode can
  // cover several vintages, so the year is part of the SKU the buyer is choosing).
  const vRaw = d.vintage != null ? String(d.vintage).trim() : '';
  const isWine = /wine|sparkl|champagne|vermouth|ros[eé]|port|sherry/i.test(d.product_type || '');
  // A real YEAR always shows; a non-vintage marker (NV) only for wine — an "NV"
  // on a spirit is placeholder noise, not a real vintage.
  const vtg = /^(19|20)\d{2}$/.test(vRaw) ? vRaw : (isWine && /^nv$/i.test(vRaw) ? 'NV' : '');
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
        {vtg && <span className={`disc-card-vtg${isWine ? ' disc-card-vtg--wine' : ''}`}>{vtg}</span>}
      </div>
      {/* Bottle size / case pack on their OWN line, not buried in the name. */}
      {size && <div className="disc-card-size">{size}</div>}
      <BottlePrices d={d} />
      <div className="disc-card-foot">
        {/* 1-case price (list minus any 1cs QD) — the headline per-case number. */}
        {d.one_cs_case_price != null && (
          <div className="disc-card-price">{money(d.one_cs_case_price)}<span className="disc-card-price-u">/cs</span></div>
        )}
        <div className="disc-card-deals">
          {d.has_rip && (
            <span className="disc-deal disc-deal--rip">
              Best RIP: {qtyUnit(d.rip_qty, d.rip_unit)} {money(d.rip_amount)} ({money(d.rip_per_case)}/cs)
            </span>
          )}
          {d.has_qd && (
            <span className="disc-deal disc-deal--qd">
              Best QD: {qtyUnit(d.qd_qty, d.qd_unit)} {money(d.qd_total)} ({money(d.qd_save_per_case)}/cs)
            </span>
          )}
        </div>
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
  // Blend/style wine rails (a `q`, no grape) have no geo_varietal to filter on, so
  // resolve them through the SHARED semantic search (like the search box), then read
  // deal_grid for those UPCs. Grape + spirit rails filter deal_grid directly.
  const isBlend = !!pr.q && !pr.grapes && !pr.spirit_category;
  const { data, isLoading } = useQuery({
    queryKey: ['dg-rail', rail.label, JSON.stringify(params)],
    staleTime: 300_000,
    queryFn: async () => {
      if (isBlend) {
        const s = await catalog.search({ q: pr.q, ...(pr.product_type ? { product_type: pr.product_type } : {}), limit: 120, ...(edition ? { edition } : {}) });
        const upcs = [...new Set((s.items || []).map((i) => i.upc).filter(Boolean))].join(',');
        if (!upcs) return { edition: '', count: 0, items: [] as DealGridCard[] };
        return catalog.discoverDeals({
          upcs, ...(edition ? { edition } : {}),
          ...(dists.length ? { divisions: dists.join(',') } : {}),
          ...(deals.length ? { deals: deals.join(',') } : {}),
          ...(sizes.length ? { sizes: sizes.join(',') } : {}),
          sort: sortBy, limit: 60,
        });
      }
      return catalog.discoverDeals(params);
    },
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

// My Favorites — the user's watchlisted products (deal or not), so it reads the
// shared smart search, not deal_grid. Three bottle prices, hero search filters it.
function FavBottlePrices({ p }: { p: Product }) {
  const pack = bottlesPerCase(p.product_name, p.unit_qty);
  const x1 = p.frontline_unit_price ?? null;
  const x2 = p.best_unit_price ?? null;
  const x3 = x2 != null && pack ? Math.max(0, x2 - ripPerCaseP(p) / pack) : null;
  return (
    <div className="disc-fav-prices" title="1-case list / after best QD / after best QD + RIP">
      <span className="disc-bp-label">Bottle Price:</span> {money2(x1)}, {money2(x2)}, {money2(x3)}
    </div>
  );
}
function FavCard({ p }: { p: Product }) {
  const pack = bottlesPerCase(p.product_name, p.unit_qty);
  const sizeLabel = [p.unit_volume, pack ? `${pack}/cs` : null].filter(Boolean).join(', ');
  return (
    <Link to={productHref(p)} className="disc-card">
      <div className="disc-card-top">
        <span className="disc-card-dist"><Store size={11} /> {distributorName(p.wholesaler)}</span>
        <FavoriteButton productName={p.product_name} wholesaler={p.wholesaler} upc={p.upc ?? undefined} unitVolume={p.unit_volume ?? undefined} />
      </div>
      <AvailabilityButton wholesaler={p.wholesaler} name={p.product_name} itemNumber={p.abg_sku ?? undefined} className="disc-card-avail" />
      <div className="disc-card-media"><ProductThumb src={p.image_url ?? undefined} alt={p.product_name} size={120} /></div>
      <div className="disc-card-name">{(p.abg_item_name?.trim() || p.product_name)}{sizeLabel && <span className="disc-fav-size"> ({sizeLabel})</span>}</div>
      <FavBottlePrices p={p} />
    </Link>
  );
}
function MyFavorites({ query, edition }: { query: string; edition: string }) {
  const { data: favs } = useQuery({ queryKey: ['watchlist'], queryFn: watchlist.get, staleTime: 60_000 });
  const upcs = [...new Set((favs ?? []).map((f) => f.upc).filter(Boolean) as string[])];
  const { data: priced } = useQuery({
    enabled: upcs.length > 0,
    queryKey: ['fav-priced-dg', upcs.slice().sort().join(','), edition],
    staleTime: 300_000,
    queryFn: () => catalog.search({ upcs: upcs.join(','), ...(edition ? { edition } : {}), limit: 500, include_tiers: true, sort: 'product_name', order: 'asc' }),
  });
  if (!favs || favs.length === 0) return null;
  const items = priced?.items ?? [];
  const norm = (u?: string | null) => String(u ?? '').replace(/^0+/, '');
  const byUpc = new Map<string, Product[]>();
  for (const p of items) { const k = norm(p.upc); const a = byUpc.get(k); if (a) a.push(p); else byUpc.set(k, [p]); }
  const qy = query.trim().toLowerCase();
  const cards = (favs as WatchlistItem[]).map((f) => {
    const rows = byUpc.get(norm(f.upc)); if (!rows?.length) return undefined;
    return rows.find((p) => p.wholesaler === f.wholesaler && p.unit_volume === f.unit_volume)
      ?? rows.find((p) => p.wholesaler === f.wholesaler) ?? rows.find((p) => p.unit_volume === f.unit_volume) ?? rows[0];
  }).filter((p): p is Product => !!p)
    .filter((p) => !qy || (p.abg_item_name || p.product_name).toLowerCase().includes(qy) || (p.brand ?? '').toLowerCase().includes(qy));
  if (!cards.length) return null;
  return (
    <section className="disc-rail disc-favs">
      <div className="disc-rail-head"><h2 className="disc-rail-title">My Favorites</h2></div>
      <div className="disc-rail-track">{cards.map((p, i) => <FavCard key={`${p.wholesaler}-${p.upc}-${i}`} p={p} />)}</div>
    </section>
  );
}

// A collapsible filter section: click the header to show/hide its body. `count`
// shows how many options are active (kept visible even when collapsed).
function FilterSection({ title, count = 0, defaultOpen = true, children }:
  { title: string; count?: number; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="disc-filter-sect">
      <button type="button" className="disc-filter-h disc-filter-h--btn"
        aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>{title}{count > 0 && <span className="disc-filter-count">{count}</span>}</span>
        <ChevronDown size={14} className={`disc-filter-chev${open ? ' is-open' : ''}`} />
      </button>
      {open && <div className="disc-filter-body">{children}</div>}
    </div>
  );
}

export default function DiscoverAdmin() {
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [distSet, setDistSet] = useState<Set<string>>(new Set());
  const [catSet, setCatSet] = useState<Set<string>>(new Set());
  const [dealSet, setDealSet] = useState<Set<string>>(new Set());
  const [sizeSet, setSizeSet] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState('case');
  const [edition, setEdition] = useState('');
  const [collapsed, setCollapsed] = useState(false);

  const { data: cats } = useQuery({ queryKey: ['mi-top-categories'], queryFn: catalog.topCategories, staleTime: 3_600_000 });
  const { data: eds } = useQuery({ queryKey: ['editions'], queryFn: catalog.editions, staleTime: 3_600_000 });
  const months = [...new Set((eds ?? []).map((e) => e.edition))].sort().reverse();
  const allRails: MiRail[] = [...(cats?.spirits ?? []), ...(cats?.wine ?? [])];
  // Category filter narrows WHICH rails render (each rail is one category).
  const rails = catSet.size ? allRails.filter((r) => catSet.has(r.label)) : allRails;

  const dists = [...distSet], deals = [...dealSet], sizes = [...sizeSet];
  const activeCount = distSet.size + catSet.size + dealSet.size + sizeSet.size + (edition ? 1 : 0);

  // Semantic search: resolve the query through the SHARED smart-search stack
  // (aliases + spell-fix + semantic), then read deal_grid for those exact UPCs —
  // so the deal cards are the precomputed ones but the matching is fully semantic.
  const { data: searchData } = useQuery({
    queryKey: ['dg-search', submitted, edition, dists.join(','), deals.join(','), sizes.join(','), sortBy],
    enabled: !!submitted,
    staleTime: 300_000,
    queryFn: async () => {
      const s = await catalog.search({ q: submitted, limit: 100, ...(edition ? { edition } : {}) });
      const upcs = [...new Set((s.items || []).map((i) => i.upc).filter(Boolean))].join(',');
      if (!upcs) return { edition, count: 0, items: [] as DealGridCard[] };
      return catalog.discoverDeals({
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
        <h1 className="disc-title">Celr AI</h1>
        <p className="disc-sub">Find any product, at any distributor</p>
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
                    onClick={() => { setDistSet(new Set()); setCatSet(new Set()); setDealSet(new Set()); setSizeSet(new Set()); setEdition(''); }}>Clear</button>
                )}
                <button type="button" className="disc-filters-collapse" title="Collapse filters" onClick={() => setCollapsed(true)}>
                  <PanelLeftClose size={16} />
                </button>
              </span>
            </div>
            <FilterSection title="Month">
              <select className="disc-filter-select" value={edition} onChange={(e) => setEdition(e.target.value)}>
                <option value="">Current</option>
                {months.map((m) => <option key={m} value={m}>{fmtMonth(m)}</option>)}
              </select>
            </FilterSection>
            <FilterSection title="Sort by">
              <select className="disc-filter-select" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
                {SORT_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </FilterSection>
            <FilterSection title="Deal" count={dealSet.size}>
              {[['rip', 'Has RIP'], ['qd', 'Has QD'], ['both', 'Has both QD & RIP'], ['time_sensitive', 'Time-sensitive'], ['better_1l', 'Better 1L price']].map(([v, l]) => (
                <label key={v} className="disc-filter-opt">
                  <input type="checkbox" checked={dealSet.has(v)} onChange={() => setDealSet((s) => toggleIn(s, v))} />
                  <span>{l}</span>
                </label>
              ))}
            </FilterSection>
            <FilterSection title="Size" count={sizeSet.size}>
              {['375ML', '750ML', '1L', '1.75L'].map((s) => (
                <label key={s} className="disc-filter-opt">
                  <input type="checkbox" checked={sizeSet.has(s)} onChange={() => setSizeSet((x) => toggleIn(x, s))} />
                  <span>{s}</span>
                </label>
              ))}
            </FilterSection>
            <FilterSection title="Category" count={catSet.size}>
              <div className="disc-filter-list">
                {allRails.map((r) => (
                  <label key={r.label} className="disc-filter-opt">
                    <input type="checkbox" checked={catSet.has(r.label)} onChange={() => setCatSet((s) => toggleIn(s, r.label))} />
                    <span>{r.label.replace(/^Top /, '')}</span>
                  </label>
                ))}
              </div>
            </FilterSection>
            <FilterSection title="Distributor" count={distSet.size}>
              <div className="disc-filter-list">
                {DISTRIBUTOR_OPTS.map((d) => (
                  <label key={d.value} className="disc-filter-opt">
                    <input type="checkbox" checked={distSet.has(d.value)} onChange={() => setDistSet((s) => toggleIn(s, d.value))} />
                    <span>{d.label}</span>
                  </label>
                ))}
              </div>
            </FilterSection>
          </aside>
        )}

        <div className="disc-rails">
          <MyFavorites query="" edition={edition} />
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
