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
import { Search, Store, SlidersHorizontal, PanelLeftClose, Clock } from 'lucide-react';
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
// 'YYYY-MM-DD' -> 'M/D' for the time-sensitive RIP window.
function fmtDate(d?: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d ?? '');
  return m ? `${parseInt(m[2], 10)}/${parseInt(m[3], 10)}` : (d ?? '');
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

// ---- Side-by-side compare mode (2+ distributors picked) ----
// Group the flat per-distributor rows by match_key (the SAME product across
// distributors — backend already matched them precisely, no welds).
function groupByMatch(items: CompareGridCard[]): CompareGridCard[][] {
  const groups: CompareGridCard[][] = [];
  const idx = new Map<string, number>();
  for (const it of items) {
    const k = it.match_key || `${it.upc}-${it.unit_volume}-${it.unit_qty}`;
    let g = idx.get(k);
    if (g == null) { g = groups.length; idx.set(k, g); groups.push([]); }
    groups[g].push(it);
  }
  return groups;
}

// One distributor's offer inside a comparison group; the cheapest is highlighted.
function CmpCard({ d, cheapest }: { d: CompareGridCard; cheapest: boolean }) {
  const dist = d.wholesaler ?? '';
  return (
    <Link to={cardHref(d)} className={`disc-cmp-card${cheapest ? ' is-cheapest' : ''}`}>
      <div className="disc-cmp-card-top">
        <span className="disc-card-dist"><Store size={11} /> {distributorName(dist)}</span>
        {cheapest && <span className="disc-cmp-win">Cheapest</span>}
      </div>
      <div className="disc-cmp-price">{money(d.effective_case_price)}<span className="disc-cmp-price-u">/cs</span></div>
      <div className="disc-cmp-btl">{money2(d.btl_effective)}/btl</div>
      <div className="disc-cmp-deals">
        {d.has_rip && <span className="disc-deal disc-deal--rip">RIP</span>}
        {d.has_discount && <span className="disc-deal disc-deal--qd">QD</span>}
        {d.ts_rip_to && (
          <span className="disc-deal disc-deal--ts"
            title={`Time-sensitive RIP: ${fmtDate(d.ts_rip_from)}–${fmtDate(d.ts_rip_to)} · ${money(d.ts_rip_per_case)}/cs back (partial-month window — not the stable RIP)`}>
            <Clock size={10} /> RIP till {fmtDate(d.ts_rip_to)}
          </span>
        )}
      </div>
      <AvailabilityButton wholesaler={dist} name={d.product_name} itemNumber={d.item_no ?? undefined} className="disc-cmp-avail" />
    </Link>
  );
}

// A product's side-by-side comparison across the selected distributors.
function CompareGroup({ rows }: { rows: CompareGridCard[] }) {
  const head = rows[0];
  const size = [head.unit_volume, head.unit_qty ? `${head.unit_qty}/cs` : null].filter(Boolean).join(', ');
  const minEff = Math.min(...rows.map((r) => r.effective_case_price ?? Infinity));
  const pct = head.pct_diff != null ? Math.round(head.pct_diff * 100) : null;
  return (
    <div className="disc-cmp-group">
      <div className="disc-cmp-head">
        <ProductThumb src={head.image_url ?? undefined} alt={head.product_name} size={40} />
        <div className="disc-cmp-meta">
          <div className="disc-cmp-name">{head.display_name || head.product_name}</div>
          {size && <div className="disc-cmp-size">{size}</div>}
        </div>
        {pct != null && pct > 0 && <span className="disc-cmp-gap">{pct}% gap</span>}
      </div>
      <div className="disc-cmp-cards">
        {rows.map((r, i) => <CmpCard key={i} d={r} cheapest={(r.effective_case_price ?? Infinity) === minEff} />)}
      </div>
    </div>
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
  const compareMode = dists.length >= 2;   // 2+ distributors picked -> side-by-side
  if (!isLoading && !items.length) return null;
  const groups = compareMode ? groupByMatch(items) : [];
  return (
    <section className="disc-rail">
      <div className="disc-rail-head">
        <h2 className="disc-rail-title">{rail.label}</h2>
        <span className="disc-rail-count">{compareMode ? groups.length : items.length}</span>
      </div>
      {compareMode ? (
        <div className="disc-cmp-grid">
          {isLoading
            ? <div className="disc-rail-loading">Loading…</div>
            : groups.map((g, i) => <CompareGroup key={g[0].match_key || i} rows={g} />)}
        </div>
      ) : (
        <div className="disc-rail-track">
          {isLoading
            ? <div className="disc-rail-loading">Loading…</div>
            : items.map((d, i) => <CompareCard key={`${d.wholesaler}-${d.upc}-${d.unit_volume}-${i}`} d={d} />)}
        </div>
      )}
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
        <form className="disc-search" onSubmit={(e) => { e.preventDefault(); setSubmitted(q.trim()); }}>
          <Search size={18} className="disc-search-ic" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search — product, brand, region…" aria-label="Search" />
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
              {[['rip', 'Has RIP'], ['qd', 'Has QD'], ['both', 'Has both QD & RIP']].map(([v, l]) => (
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
              <div className="disc-filter-h">Distributor <span className="disc-filter-hint">(pick 2-3 to compare side by side)</span></div>
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
              <div className="disc-rail-head">
                <h2 className="disc-rail-title">Matching “{submitted}”</h2>
                <span className="disc-rail-count">{dists.length >= 2 ? groupByMatch(searchData?.items ?? []).length : (searchData?.items?.length ?? 0)}</span>
              </div>
              {dists.length >= 2 ? (
                <div className="disc-cmp-grid">
                  {groupByMatch(searchData?.items ?? []).map((g, i) => <CompareGroup key={g[0]?.match_key || i} rows={g} />)}
                </div>
              ) : (
                <div className="disc-rail-track">
                  {(searchData?.items ?? []).map((d, i) => <CompareCard key={`s-${d.wholesaler}-${d.upc}-${i}`} d={d} />)}
                </div>
              )}
            </section>
          ) : (
            rails.map((rail) => (
              <CompareRail key={rail.label} rail={rail} dists={dists} deals={deals} sizes={sizes} sortBy={sortBy} edition={edition} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
