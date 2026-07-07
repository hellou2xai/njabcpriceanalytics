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
import { Search } from 'lucide-react';
import { catalog, type MiRail, type Product, type CatalogTier } from '../lib/api';
import ProductThumb from '../components/ProductThumb';
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

// Dedupe search rows (many sizes/distributors per product) to one card each.
function distinctProducts(items: Product[], max: number): Product[] {
  const seen = new Set<string>();
  const out: Product[] = [];
  for (const p of items) {
    const k = (p.product_name || '').toUpperCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

// One featured product card. Price (after the stable 1-case QD) + Top RIP / Top
// QD chips, plus a TS button that opens the SKU's time-sensitive deal windows.
function DiscCard({ p }: { p: Product }) {
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
      {p.unit_volume && <div className="disc-card-size">{p.unit_volume}</div>}
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
                RIP {tierQty(rip)} · {money(rip.amount)}
              </span>
            )}
            {qd && (
              <span
                className="disc-deal disc-deal--qd"
                title={`Top QD: buy ${tierQty(qd)}, save ${money(qd.save_per_case)}/case`}
              >
                QD {tierQty(qd)} · {money(qd.save_per_case)}
              </span>
            )}
          </div>
        )}
      </div>
    </Link>
  );
}

function Rail({ rail }: { rail: MiRail }) {
  const { ref, seen } = useInView<HTMLElement>();
  const { data, isLoading } = useQuery({
    queryKey: ['mi-rail', rail.params],
    enabled: seen,
    staleTime: 300_000,
    // Featured rails show standard retail bottles only (1.75L / 1L / 750ML),
    // not minis, 4-packs, cans or tray packs that otherwise top the volume rank.
    // include_tiers gives us each SKU's QD + RIP ladder for the deal chips.
    queryFn: () => catalog.search({ ...rail.params, sizes: '750ML,1L,1.75L', sort: 'mi_volume', order: 'desc', limit: 150, images_first: false, include_tiers: true }),
  });
  // Scope = the category's TOP 50 products by 9L sales volume (image-bearing,
  // deduped). Within that pool, FEATURE the 16 with the deepest discount
  // (list vs best QD/RIP), so the rail leads with the best deals on top sellers.
  const pool = distinctProducts((data?.items ?? []).filter((p) => !!p.image_url), 50);
  const products = [...pool].sort((a, b) => discountScore(b) - discountScore(a)).slice(0, 24);
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

export default function Discover() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const { data } = useQuery({ queryKey: ['mi-top-categories'], queryFn: catalog.topCategories, staleTime: 3_600_000 });
  const rails: MiRail[] = [...(data?.spirits ?? []), ...(data?.wine ?? [])];

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

      <div className="disc-rails">
        {rails.map((r) => <Rail key={r.label} rail={r} />)}
      </div>
    </div>
  );
}
