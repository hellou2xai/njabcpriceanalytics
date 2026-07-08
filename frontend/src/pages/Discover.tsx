/**
 * Discover — market-intelligence landing. A stack of horizontal "Top <Category>"
 * rails (spirit categories, then wine varietals) ordered by MI sales revenue.
 * Each rail lazy-loads its top products (ranked by MI 9L sales volume desc) only
 * when it scrolls into view, and its header deep-links into the existing Products
 * page with the category filter + volume sort. Does not touch the Products page.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search, Store } from 'lucide-react';
import { catalog, type MiRail, type Product, type CatalogTier } from '../lib/api';
import ProductThumb from '../components/ProductThumb';
import FavoriteButton from '../components/FavoriteButton';
import { distributorName, ALL_DISTRIBUTORS } from '../lib/distributors';
import { bottlesPerCase } from '../lib/productSizes';
import './Discover.css';

const TYPES = ['Beer', 'Wine', 'Spirits', 'RTD', 'Seltzer', 'Cider', 'Non-Alcoholic'];

// Build the Products deep-link for a rail: its filter params + volume sort.
function railHref(params: Record<string, string>): string {
  const sp = new URLSearchParams({ ...params, sort: 'mi_volume', order: 'desc' });
  return `/products?${sp.toString()}`;
}

// Fire once when the element first scrolls near the viewport (lazy rails).
function useInView<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (!ref.current || seen) return;
    const io = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { setSeen(true); io.disconnect(); } },
      { rootMargin: '300px' },
    );
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen]);
  return { ref, seen };
}

function money(n?: number | null): string | null {
  return n == null ? null : `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

// A tier's buy quantity as a compact label ("25cs" / "3bt"). Bottle-unit tiers
// start with B; everything else is cases.
function tierQty(t: CatalogTier): string {
  return `${t.qty}${/^b/i.test(t.unit || '') ? 'bt' : 'cs'}`;
}

// Whether a discount tier is the 1-case entry QD (already folded into the price).
function isOneCsQd(t: CatalogTier): boolean {
  return t.source === 'discount' && t.qty === 1 && !/^b/i.test(t.unit || '');
}

// Top tier of a kind, taken straight from the canonical tier ladder (FOUNDATION)
// — no math re-derived here. RIP wins by its source `amount` (the CPL's TOTAL
// rebate for buying `qty`, per rip_utils); QD wins by per-case discount. Time-
// sensitive tiers ARE eligible (the TS button exposes their windows); the 1-case
// entry QD is excluded from the QD chip since it's already in the shown price.
function topTier(tiers: CatalogTier[] | undefined, source: 'discount' | 'rip'): CatalogTier | null {
  const of = (tiers ?? []).filter(
    (t) => t.source === source && !(source === 'discount' && isOneCsQd(t)),
  );
  if (!of.length) return null;
  const metric = (t: CatalogTier) => (source === 'rip' ? (t.amount ?? 0) : (t.save_per_case ?? 0));
  return of.reduce((a, b) => (metric(b) > metric(a) ? b : a));
}

// Best per-case discount as a FRACTION of list price, comparing the list price
// to the price after the highest QD and the price after the highest RIP (the
// deeper of the two wins; QD and RIP are never blended, per FOUNDATION). Used to
// rank a category's top-volume pool so the biggest deals feature first.
function discountScore(p: Product): number {
  const list = p.frontline_case_price ?? p.effective_case_price ?? 0;
  if (list <= 0) return 0;
  const qd = topTier(p.tiers, 'discount');
  const rip = topTier(p.tiers, 'rip');
  const qdSave = qd?.save_per_case ?? 0;                       // per-case QD saving
  const ripPerCase = rip && rip.amount != null && rip.qty ? rip.amount / rip.qty : 0;  // per-case rebate
  return Math.max(qdSave, ripPerCase) / list;
}

// Realistic single-case price: list minus the (stable) 1-case entry QD when the
// SKU has one, else the frontline list price. A time-sensitive entry QD is not
// baked into the headline — it surfaces under the TS button instead.
function oneCsCasePrice(p: Product): number | null {
  const entry = (p.tiers ?? []).find((t) => isOneCsQd(t) && !t.is_time_sensitive);
  return entry?.price_after ?? p.frontline_case_price ?? p.effective_case_price ?? null;
}

// Deep-link straight to ONE SKU's product detail (w + name + upc + exact size),
// mirroring the shared /product route used across the app.
function productHref(p: Product): string {
  const q = new URLSearchParams({ w: p.wholesaler, n: p.product_name });
  if (p.upc) q.set('u', String(p.upc));
  if (p.unit_volume) q.set('s', String(p.unit_volume));   // pins the exact size
  return `/product?${q.toString()}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// 'YYYY-MM-DD' -> 'Jul 30'. Parsed by hand so there is no timezone shift.
function shortDate(iso?: string | null): string {
  if (!iso) return '';
  const [, m, d] = iso.split('-').map(Number);
  return m && d ? `${MONTHS[m - 1]} ${d}` : '';
}

// A product plus the distributors that carry it at the same deal.
type MergedProduct = Product & { dists: string[] };

// A REAL barcode (drops all-zero/short/repeated placeholder codes) — the reliable
// cross-distributor product key (CPL names differ per distributor).
function realUpc(u?: string | null): string | null {
  const s = String(u ?? '').replace(/\D/g, '').replace(/^0+/, '');
  return s.length >= 11 && !/^(\d)\1+$/.test(s) ? s : null;
}

// Signature of a product's featured deals — same RIP AND same QD (RIP is
// statewide, so the differentiator is usually QD).
function dealSig(p: Product): string {
  const rip = topTier(p.tiers, 'rip');
  const qd = topTier(p.tiers, 'discount');
  return `${rip?.amount ?? '-'}|${rip?.qty ?? '-'}|${qd?.save_per_case ?? '-'}|${qd?.qty ?? '-'}`;
}

// Collapse search rows to one card per (product, deal): the SAME product from
// multiple distributors with the SAME RIP/QD becomes a single card that lists
// every distributor. Different deals stay separate cards.
function mergeByDeal(items: Product[]): MergedProduct[] {
  const groups = new Map<string, { p: Product; dists: string[] }>();
  for (const it of items) {
    if (!it.image_url) continue;
    const pk = realUpc(it.upc) ? `U:${realUpc(it.upc)}` : `N:${(it.product_name || '').toUpperCase()}`;
    const key = `${pk}||${dealSig(it)}`;
    const g = groups.get(key);
    if (!g) groups.set(key, { p: it, dists: [it.wholesaler] });
    else if (!g.dists.includes(it.wholesaler)) g.dists.push(it.wholesaler);
  }
  return [...groups.values()].map(({ p, dists }) => ({ ...p, dists }));
}

// One featured product card. Price (after the stable 1-case QD) + Top RIP / Top
// QD chips, plus a TS button that opens the SKU's time-sensitive deal windows.
function DiscCard({ p }: { p: MergedProduct }) {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  // Popover position (viewport coords) when open, else null. Rendered in a body
  // portal so the horizontally-scrolling rail track can't clip it.
  const [pop, setPop] = useState<{ top: number; left: number } | null>(null);
  const price = money(oneCsCasePrice(p));
  const rip = topTier(p.tiers, 'rip');
  const qd = topTier(p.tiers, 'discount');
  const ts = (p.tiers ?? []).filter((t) => t.is_time_sensitive);

  // Group the time-sensitive tiers by their validity window, tiers ascending by
  // buy quantity so each window reads as a ladder.
  const windows = new Map<string, CatalogTier[]>();
  for (const t of ts) {
    const k = `${t.from_date}|${t.to_date}`;
    (windows.get(k) ?? windows.set(k, []).get(k)!).push(t);
  }
  for (const arr of windows.values()) arr.sort((a, b) => (a.qty ?? 0) - (b.qty ?? 0));

  function toggle(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (pop) { setPop(null); return; }
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const W = 208;
    const left = Math.max(8, Math.min(r.right - W, window.innerWidth - W - 8));
    setPop({ top: r.bottom + 6, left });
  }

  // Close on Escape, any outside click, or scroll (position would go stale).
  useEffect(() => {
    if (!pop) return;
    const close = () => setPop(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPop(null); };
    document.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [pop]);

  return (
    <Link to={productHref(p)} className="disc-card">
      <div className="disc-card-top">
        <span className="disc-card-dist" title={p.dists.map(distributorName).join(', ')}>
          <Store size={11} />{' '}
          {p.dists.length === 1
            ? distributorName(p.dists[0])
            : `${distributorName(p.dists[0])} +${p.dists.length - 1}`}
        </span>
        <FavoriteButton productName={p.product_name} wholesaler={p.wholesaler}
          upc={p.upc ?? undefined} unitVolume={p.unit_volume ?? undefined} />
      </div>
      <div className="disc-card-media">
        <ProductThumb src={p.image_url} alt={p.product_name} size={120} />
        {ts.length > 0 && (
          <button
            ref={btnRef}
            type="button"
            className={`disc-ts-btn${pop ? ' is-open' : ''}`}
            title="Time-sensitive deals"
            aria-expanded={!!pop}
            onClick={toggle}
          >
            TS
          </button>
        )}
        {pop && createPortal(
          <div
            className="disc-ts-pop"
            role="dialog"
            aria-label="Time-sensitive deals"
            style={{ top: pop.top, left: pop.left }}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
          >
            <div className="disc-ts-pop-h">Time-sensitive deals</div>
            {[...windows.entries()].map(([k, tiers]) => {
              const w = tiers[0];
              return (
                <div key={k} className="disc-ts-win">
                  <div className="disc-ts-win-h">
                    {shortDate(w.from_date)} – {shortDate(w.to_date)}
                    {typeof w.days_to_expire === 'number' && (
                      <span className="disc-ts-exp"> · {w.days_to_expire}d left</span>
                    )}
                  </div>
                  {tiers.map((t, j) => (
                    <div key={j} className="disc-ts-row">
                      <span className={`disc-ts-kind disc-ts-kind--${t.source}`}>
                        {t.source === 'rip' ? 'RIP' : 'QD'} {tierQty(t)}
                      </span>
                      <span className="disc-ts-vals">
                        {money(t.price_after)}
                        {t.source === 'rip'
                          ? t.amount != null && <em> {money(t.amount)} back</em>
                          : t.save_per_case != null && <em> save {money(t.save_per_case)}</em>}
                      </span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>,
          document.body,
        )}
      </div>
      <div className="disc-card-name">{p.abg_item_name?.trim() || p.product_name}</div>
      {p.unit_volume && (
        <div className="disc-card-size">
          {p.unit_volume}
          {(() => { const pack = bottlesPerCase(p.product_name, p.unit_qty); return pack != null ? ` (${pack}/cs)` : ''; })()}
        </div>
      )}
      <div className="disc-card-foot">
        {price && (
          <div className="disc-card-price">{price}<span className="disc-card-price-u">/cs</span></div>
        )}
        {(rip || qd) && (
          <div className="disc-card-deals">
            {rip && (
              <span
                className="disc-deal disc-deal--rip"
                title={`Top RIP: buy ${tierQty(rip)} → ${money(rip.amount)} total rebate back (from CPL)`}
              >
                Best RIP {tierQty(rip)} · {money(rip.amount)}
              </span>
            )}
            {qd && (
              <span
                className="disc-deal disc-deal--qd"
                title={`Top QD: buy ${tierQty(qd)}, save ${money(qd.save_per_case)}/case`}
              >
                Best QD {tierQty(qd)} · {money(qd.save_per_case)}/cs
              </span>
            )}
          </div>
        )}
      </div>
    </Link>
  );
}

function Rail({ rail, distributors, deals }: { rail: MiRail; distributors: string[]; deals: string[] }) {
  const { ref, seen } = useInView<HTMLElement>();
  const distParam = distributors.length ? distributors.join(',') : undefined;
  const { data, isLoading } = useQuery({
    // distParam is part of the key so a distributor filter refetches, not caches.
    queryKey: ['mi-rail', rail.params, distParam ?? ''],
    enabled: seen,
    staleTime: 300_000,
    // Featured rails show standard retail bottles only (1.75L / 1L / 750ML),
    // not minis, 4-packs, cans or tray packs that otherwise top the volume rank.
    // include_tiers gives us each SKU's QD + RIP ladder for the deal chips.
    queryFn: () => catalog.search({ ...rail.params, ...(distParam ? { divisions: distParam } : {}), sizes: '750ML,1L,1.75L', sort: 'mi_volume', order: 'desc', limit: 300, images_first: false, include_tiers: true }),
  });
  // Merge the same product from multiple distributors (same RIP/QD) into one
  // card, then FEATURE every product with a RIP or QD deal, ranked by deepest
  // discount, up to 60 (stops earlier when the category runs out of deals).
  const products = mergeByDeal(data?.items ?? [])
    .filter((p) => discountScore(p) > 0)
    .filter((p) => {
      if (!deals.length) return true;   // no deal-type filter -> any deal
      const hasRip = !!topTier(p.tiers, 'rip');
      const hasQd = !!topTier(p.tiers, 'discount');
      return (deals.includes('rip') && hasRip) || (deals.includes('qd') && hasQd);
    })
    .sort((a, b) => discountScore(b) - discountScore(a))
    .slice(0, 60);
  return (
    <section ref={ref} className="disc-rail">
      <div className="disc-rail-head">
        <h2 className="disc-rail-title">{rail.label}</h2>
        <Link to={railHref(rail.params)} className="disc-rail-all">See all &rarr;</Link>
      </div>
      <div className="disc-rail-track">
        {(!seen || isLoading) && Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="disc-card disc-card--skel" />
        ))}
        {seen && !isLoading && products.length === 0 && (
          <div className="disc-rail-empty">No products found.</div>
        )}
        {products.map((p, i) => <DiscCard key={`${p.product_name}-${i}`} p={p} />)}
      </div>
    </section>
  );
}

function toggleIn(set: Set<string>, v: string): Set<string> {
  const n = new Set(set);
  n.has(v) ? n.delete(v) : n.add(v);
  return n;
}

export default function Discover() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [distSet, setDistSet] = useState<Set<string>>(new Set());
  const [catSet, setCatSet] = useState<Set<string>>(new Set());
  const [dealSet, setDealSet] = useState<Set<string>>(new Set());
  const { data } = useQuery({ queryKey: ['mi-top-categories'], queryFn: catalog.topCategories, staleTime: 3_600_000 });
  const allRails: MiRail[] = [...(data?.spirits ?? []), ...(data?.wine ?? [])];
  const rails = catSet.size ? allRails.filter((r) => catSet.has(r.label)) : allRails;
  const dists = [...distSet];
  const deals = [...dealSet];
  const activeCount = distSet.size + catSet.size + dealSet.size;

  return (
    <div className="disc-page">
      <header className="disc-hero">
        <h1 className="disc-title">Celr AI</h1>
        <p className="disc-sub">Find any product, at any distributor</p>
        <form
          className="disc-search"
          onSubmit={(e) => { e.preventDefault(); if (q.trim()) nav(`/products?q=${encodeURIComponent(q.trim())}`); }}
        >
          <Search size={18} className="disc-search-ic" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search products, brands, regions, varietals…"
            aria-label="Search products"
          />
          <button type="submit">Search</button>
        </form>
        <div className="disc-types">
          {TYPES.map((t) => (
            <Link key={t} to={`/products?product_type=${encodeURIComponent(t)}`} className="disc-type">{t}</Link>
          ))}
        </div>
        <p className="disc-hint">Top categories by market sales volume</p>
      </header>

      <div className="disc-body">
        <aside className="disc-filters">
          <div className="disc-filters-head">
            <span>Filters</span>
            {activeCount > 0 && (
              <button type="button" className="disc-filters-clear"
                onClick={() => { setDistSet(new Set()); setCatSet(new Set()); setDealSet(new Set()); }}>
                Clear
              </button>
            )}
          </div>

          <div className="disc-filter-sect">
            <div className="disc-filter-h">Deal</div>
            {[['rip', 'Has RIP'], ['qd', 'Has QD']].map(([v, label]) => (
              <label key={v} className="disc-filter-opt">
                <input type="checkbox" checked={dealSet.has(v)} onChange={() => setDealSet((s) => toggleIn(s, v))} />
                <span>{label}</span>
              </label>
            ))}
          </div>

          <div className="disc-filter-sect">
            <div className="disc-filter-h">Distributor</div>
            <div className="disc-filter-list">
              {ALL_DISTRIBUTORS.filter((d) => d.value).map((d) => (
                <label key={d.value} className="disc-filter-opt">
                  <input type="checkbox" checked={distSet.has(d.value)} onChange={() => setDistSet((s) => toggleIn(s, d.value))} />
                  <span>{d.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="disc-filter-sect">
            <div className="disc-filter-h">Category</div>
            <div className="disc-filter-list">
              {allRails.map((r) => (
                <label key={r.label} className="disc-filter-opt">
                  <input type="checkbox" checked={catSet.has(r.label)} onChange={() => setCatSet((s) => toggleIn(s, r.label))} />
                  <span>{r.label.replace(/^Top /, '')}</span>
                </label>
              ))}
            </div>
          </div>
        </aside>

        <div className="disc-rails">
          {rails.map((r) => <Rail key={r.label} rail={r} distributors={dists} deals={deals} />)}
        </div>
      </div>
    </div>
  );
}
