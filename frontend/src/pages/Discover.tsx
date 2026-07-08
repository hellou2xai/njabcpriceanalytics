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
import { Search, Store, SlidersHorizontal, PanelLeftClose } from 'lucide-react';
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
// Discount depth = how far the CANONICAL effective price (deepest QD+RIP, current
// edition — the same number the detail page shows) sits below the frontline list.
// We use the precomputed columns, never re-derive the pricing math here.
function discountScore(p: Product): number {
  const list = p.frontline_case_price ?? 0;
  const eff = p.effective_case_price ?? list;
  if (list <= 0) return 0;
  return Math.max(0, list - eff) / list;
}

// Bottle volume in litres from the size label (750ML->0.75, 1L/LITER->1, 1.75L->1.75).
function litresOf(size?: string | null): number | null {
  const s = String(size ?? '').toUpperCase().replace(/\s/g, '');
  if (['LITER', 'LITRE', '1L', '1LT', '1LTR'].includes(s)) return 1;
  const ml = s.match(/^([\d.]+)ML$/); if (ml) return parseFloat(ml[1]) / 1000;
  const l = s.match(/^([\d.]+)L(?:T|TR)?$/); if (l) return parseFloat(l[1]);
  return null;
}
// Effective BOTTLE price = CANONICAL effective case price (deepest QD+RIP, current
// edition) / bottles-per-case — the exact per-bottle number the detail page shows.
// "Better 1L price" compares the 1L bottle price to the 750ML bottle price: a 1L
// that costs about the same as (or less than) a 750ML is a better deal because
// you get 33% more product for the money. (Per-LITRE is the wrong lens — it
// normalises volume away, so a 1L and 750ML at the same $/L look "equivalent"
// even though the 1L bottle costs a third more.)
function perBottle(p: Product): number | null {
  const eff = p.effective_case_price;
  const pack = bottlesPerCase(p.product_name, p.unit_qty);
  if (eff == null || !pack) return null;
  return eff / pack;
}
// The two sizes we compare for "Better 1L price".
function sizeBucket(size?: string | null): '1L' | '750ML' | null {
  const L = litresOf(size);
  return L === 1 ? '1L' : L === 0.75 ? '750ML' : null;
}
// Cross-distributor product key (shared by mergeByDeal and the size comparison).
function productKey(p: Product): string {
  return realUpc(p.upc) ? `U:${realUpc(p.upc)}` : `N:${(p.product_name || '').toUpperCase()}`;
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
  // Full SKU identity so the detail seeds the EXACT clicked SKU (barcodes can be
  // shared across sizes/packs, or be placeholders): upc + size + pack + vintage.
  if (p.upc) q.set('u', String(p.upc));
  if (p.unit_volume) q.set('s', String(p.unit_volume));
  if (p.unit_qty) q.set('pk', String(p.unit_qty));
  if (p.vintage != null && String(p.vintage) !== '') q.set('v', String(p.vintage));
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
    const key = `${productKey(it)}||${dealSig(it)}`;
    const g = groups.get(key);
    if (!g) groups.set(key, { p: it, dists: [it.wholesaler] });
    else if (!g.dists.includes(it.wholesaler)) g.dists.push(it.wholesaler);
  }
  return [...groups.values()].map(({ p, dists }) => ({ ...p, dists }));
}

// Collapse case-mix RIP flavour variants. Products that share the SAME RIP
// program (rip_code) AND brand are flavours of one case-mix offering (e.g. Ole
// Smoky's dozen+ flavours all on RIP 10cs · $200). Keep only the Market-
// Intelligence primary — the top seller, which is first here because the rows
// arrive in mi_volume-desc order — so one brand can't swamp the rail. The rest
// stay available under the rail's "See all" (the /products page doesn't collapse).
function collapseCaseMix(products: MergedProduct[]): MergedProduct[] {
  const seen = new Set<string>();
  const out: MergedProduct[] = [];
  for (const p of products) {
    const code = (p.rip_code || '').trim();
    const brand = (p.brand || '').trim().toUpperCase();
    if (code && brand) {
      const k = `${code}|${brand}`;
      if (seen.has(k)) continue;   // a higher-volume flavour already represents this program
      seen.add(k);
    }
    out.push(p);
  }
  return out;
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
                Best RIP: {tierQty(rip)} · {money(rip.amount)}
              </span>
            )}
            {qd && (
              <span
                className="disc-deal disc-deal--qd"
                title={`Top QD: buy ${tierQty(qd)}, save ${money(qd.save_per_case)}/case`}
              >
                Best QD: {tierQty(qd)} · {money(qd.save_per_case)}/cs
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
  const items = data?.items ?? [];
  // Per-product best BOTTLE price by size, for the "Better 1L price" filter.
  const pbBySize = new Map<string, { '1L'?: number; '750ML'?: number }>();
  for (const it of items) {
    const bucket = sizeBucket(it.unit_volume); if (!bucket) continue;
    const pb = perBottle(it); if (pb == null) continue;
    const pk = productKey(it);
    const rec = pbBySize.get(pk) ?? {};
    if (rec[bucket] == null || pb < rec[bucket]!) rec[bucket] = pb;
    pbBySize.set(pk, rec);
  }
  // A product's 1L BOTTLE (after best QD+RIP) costs <= its 750ML bottle within
  // 5% — i.e. ~same money for 33% more product.
  const better1L = (p: Product) => {
    const rec = pbBySize.get(productKey(p));
    return !!(rec && rec['1L'] != null && rec['750ML'] != null && rec['1L']! <= rec['750ML']! * 1.05);
  };
  // "Better 1L price" restricts to qualifying 1L rows BEFORE the merge.
  const base = deals.includes('better_1l')
    ? items.filter((it) => sizeBucket(it.unit_volume) === '1L' && better1L(it))
    : items;
  const typeDeals = deals.filter((d) => d !== 'better_1l');
  // mergeByDeal keeps rows in mi_volume-desc order; collapse case-mix flavour
  // variants to the top-volume primary AFTER the deal filter (so the primary is
  // a deal-bearing one), then rank by discount.
  const products = collapseCaseMix(mergeByDeal(base).filter((p) => discountScore(p) > 0))
    .filter((p) => {
      if (!typeDeals.length) return true;   // no deal-type filter -> any deal
      const hasRip = !!topTier(p.tiers, 'rip');
      const hasQd = !!topTier(p.tiers, 'discount');
      return (typeDeals.includes('rip') && hasRip)
          || (typeDeals.includes('qd') && hasQd)
          || (typeDeals.includes('both') && hasRip && hasQd);
    })
    .sort((a, b) => discountScore(b) - discountScore(a))
    .slice(0, 60);
  return (
    <section ref={ref} className="disc-rail">
      <div className="disc-rail-head">
        <h2 className="disc-rail-title">{rail.label} Deals</h2>
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
  const [filtersCollapsed, setFiltersCollapsed] = useState(() => localStorage.getItem('disc_filters_collapsed') === '1');
  useEffect(() => { localStorage.setItem('disc_filters_collapsed', filtersCollapsed ? '1' : '0'); }, [filtersCollapsed]);
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

      <div className={`disc-body${filtersCollapsed ? ' disc-body--nofilters' : ''}`}>
        {filtersCollapsed ? (
          <button type="button" className="disc-filters-show" onClick={() => setFiltersCollapsed(false)}>
            <SlidersHorizontal size={16} /> Filters{activeCount > 0 ? ` (${activeCount})` : ''}
          </button>
        ) : (
        <aside className="disc-filters">
          <div className="disc-filters-head">
            <span>Filters</span>
            <span className="disc-filters-head-actions">
              {activeCount > 0 && (
                <button type="button" className="disc-filters-clear"
                  onClick={() => { setDistSet(new Set()); setCatSet(new Set()); setDealSet(new Set()); }}>
                  Clear
                </button>
              )}
              <button type="button" className="disc-filters-collapse" title="Collapse filters"
                aria-label="Collapse filters" onClick={() => setFiltersCollapsed(true)}>
                <PanelLeftClose size={16} />
              </button>
            </span>
          </div>

          <div className="disc-filter-sect">
            <div className="disc-filter-h">Deal</div>
            {[['rip', 'Has RIP'], ['qd', 'Has QD'], ['both', 'Has both QD & RIP'], ['better_1l', 'Better 1L price']].map(([v, label]) => (
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
        )}

        <div className="disc-rails">
          {rails.map((r) => <Rail key={r.label} rail={r} distributors={dists} deals={deals} />)}
        </div>
      </div>
    </div>
  );
}
