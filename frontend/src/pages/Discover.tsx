/**
 * Discover — market-intelligence landing. A stack of horizontal "Top <Category>"
 * rails (spirit categories, then wine varietals) ordered by MI sales revenue.
 * Each rail lazy-loads its top products (ranked by MI 9L sales volume desc) only
 * when it scrolls into view, and its header deep-links into the existing Products
 * page with the category filter + volume sort. Does not touch the Products page.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search, Store, SlidersHorizontal, PanelLeftClose, ChevronDown } from 'lucide-react';
import { catalog, watchlist, type MiRail, type Product, type CatalogTier, type WatchlistItem } from '../lib/api';
import ProductThumb from '../components/ProductThumb';
import FavoriteButton from '../components/FavoriteButton';
import AvailabilityButton from '../components/AvailabilityButton';
import { distributorName, ALL_DISTRIBUTORS } from '../lib/distributors';
import { bottlesPerCase } from '../lib/productSizes';
import './Discover.css';

const TYPES = ['Beer', 'Wine', 'Spirits', 'RTD', 'Seltzer', 'Cider', 'Non-Alcoholic'];

// Distributor filter options with the major NJ houses pinned to the top; the rest
// keep their existing order (stable sort).
const DIST_PINNED = ['allied', 'fedway', 'opici'];
const DISTRIBUTOR_OPTS = [...ALL_DISTRIBUTORS.filter((d) => d.value)].sort((a, b) => {
  const ia = DIST_PINNED.indexOf(a.value);
  const ib = DIST_PINNED.indexOf(b.value);
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
});

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

// Featured tier of a kind, from the canonical tier ladder (FOUNDATION) — no math
// re-derived here. We feature the LARGEST case quantity first (the bulk-buy tier),
// not a small 1-2 CS one; ties break by depth (RIP total `amount` per rip_utils /
// QD per-case save). Time-sensitive tiers ARE eligible (the TS button exposes their
// windows); the 1-case entry QD is excluded (already baked into the shown price).
function topTier(tiers: CatalogTier[] | undefined, source: 'discount' | 'rip'): CatalogTier | null {
  const of = (tiers ?? []).filter(
    (t) => t.source === source && !(source === 'discount' && isOneCsQd(t)),
  );
  if (!of.length) return null;
  const depth = (t: CatalogTier) => (source === 'rip' ? (t.amount ?? 0) : (t.save_per_case ?? 0));
  return of.reduce((a, b) => {
    const qa = a.qty ?? 0, qb = b.qty ?? 0;
    if (qb !== qa) return qb > qa ? b : a;   // larger case wins
    return depth(b) > depth(a) ? b : a;      // tie -> deeper wins
  });
}

// Best per-case discount as a FRACTION of list price, comparing the list price
// to the price after the highest QD and the price after the highest RIP (the
// deeper of the two wins; QD and RIP are never blended, per FOUNDATION). Used to
// rank a category's top-volume pool so the biggest deals feature first.
// Savings % that drives the ranking = the 1-CASE price the card shows
// (oneCsCasePrice — list, or the 1-case entry QD when there is one) vs the
// CANONICAL effective price (deepest QD+RIP, current edition — the detail-page
// number). So: (1-case price − price after best QD+RIP) / 1-case price. Both are
// precomputed columns; we never re-derive pricing here.
// Net discount $ per case = 1-case price - price after best QD+RIP.
function netDiscount(p: Product): number {
  const base = oneCsCasePrice(p) ?? p.frontline_case_price ?? 0;
  const eff = p.effective_case_price ?? base;
  return Math.max(0, base - eff);
}
// A tier's buy quantity in physical CASES. RIP/QD tiers can be quoted in BOTTLES
// (unit starts with 'b'), which convert by pack — so unit AND qty are read together.
function tierCases(t: CatalogTier | null | undefined, pack: number | null): number {
  if (!t || t.qty == null) return 0;
  return /^b/i.test(t.unit || '') && pack ? t.qty / pack : t.qty;
}
// Deepest RIP rebate PER CASE: the unit-aware canonical value (save_per_case),
// NEVER amount/qty (which is per BOTTLE for a bottle-unit tier — undervalued by pack).
function ripPerCase(p: Product): number {
  return topTier(p.tiers, 'rip')?.save_per_case ?? 0;
}
function qdPerCase(p: Product): number {
  return topTier(p.tiers, 'discount')?.save_per_case ?? 0;
}
// Largest case quantity the card's featured RIP/QD deal asks for — used to GROUP
// bulk-buy deals to the top. Bottle-unit tiers count as their case-equivalent.
function caseQty(p: Product): number {
  const pack = bottlesPerCase(p.product_name, p.unit_qty);
  return Math.max(tierCases(topTier(p.tiers, 'rip'), pack), tierCases(topTier(p.tiers, 'discount'), pack));
}
// Sort comparators for the "Sort by" control.
const SORT_FNS: Record<string, (a: Product, b: Product) => number> = {
  case: (a, b) => (caseQty(b) - caseQty(a)) || (netDiscount(b) - netDiscount(a)),
  net: (a, b) => netDiscount(b) - netDiscount(a),
  pct: (a, b) => discountScore(b) - discountScore(a),
  name: (a, b) => (a.abg_item_name || a.product_name).localeCompare(b.abg_item_name || b.product_name),
  rip: (a, b) => ripPerCase(b) - ripPerCase(a),
  qd: (a, b) => qdPerCase(b) - qdPerCase(a),
};
const SORT_OPTS: [string, string][] = [
  ['case', 'Largest Case Deal'], ['net', 'Net Discount'], ['name', 'Product name'],
  ['rip', 'Highest Case RIP'], ['qd', 'Highest Case QD'], ['pct', 'Deal %'],
];
// '2026-06' -> 'Jun-26'.
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtMonth(ym: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  return m ? `${MONTH_ABBR[parseInt(m[2], 10) - 1]}-${m[1].slice(2)}` : ym;
}

function discountScore(p: Product): number {
  const base = oneCsCasePrice(p) ?? p.frontline_case_price ?? 0;
  const eff = p.effective_case_price ?? base;
  if (base <= 0) return 0;
  return Math.max(0, base - eff) / base;
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
// Per-bottle price AFTER best QD AND deepest RIP (including time-sensitive) — the
// exact X3 the cards show (best_unit_price − rip-per-case / pack). Used by the
// "Better 1L price" compare so a 1L whose winning deal is a time-sensitive RIP is
// still credited (effective_case_price drops TS RIPs, so perBottle would miss it).
function afterDealBottle(p: Product): number | null {
  const x2 = p.best_unit_price ?? p.frontline_unit_price;
  const pack = bottlesPerCase(p.product_name, p.unit_qty);
  if (x2 == null || !pack) return null;
  return Math.max(0, x2 - ripPerCase(p) / pack);
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
  const pack = bottlesPerCase(p.product_name, p.unit_qty);
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
      {/* Check Allied / Check Fedway — self-hides for other distributors. */}
      <AvailabilityButton wholesaler={p.wholesaler} name={p.product_name}
        itemNumber={p.abg_sku ?? undefined} className="disc-card-avail" />
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
      <BottlePrices p={p} />
      <div className="disc-card-foot">
        {price && <div className="disc-card-price">{price}<span className="disc-card-price-u">/cs</span></div>}
        {(rip || qd) && (
          <div className="disc-card-deals">
            {rip && (
              <span
                className="disc-deal disc-deal--rip"
                title={`Top RIP: buy ${tierQty(rip)} → ${money(rip.amount)} total rebate back (from CPL)`}
              >
                Best RIP: {tierQty(rip)} - {money(rip.amount)} ({money(rip.save_per_case ?? 0)}/cs)
              </span>
            )}
            {qd && (
              <span
                className="disc-deal disc-deal--qd"
                title={`Top QD: buy ${tierQty(qd)}, save ${money(qd.save_per_case)}/case (total ${money((qd.save_per_case ?? 0) * tierCases(qd, pack))})`}
              >
                Best QD: {tierQty(qd)} - {money((qd.save_per_case ?? 0) * tierCases(qd, pack))} ({money(qd.save_per_case)}/cs)
              </span>
            )}
          </div>
        )}
      </div>
    </Link>
  );
}

// Push the deal-type filter into the SEARCH (server-side) so a single deal type
// or "both" isn't limited to whichever top-volume rows happen to qualify. OR
// combinations (rip AND qd checkboxes) stay client-side (can't AND them here).
function dealSearchParams(deals: string[]): Record<string, boolean> {
  const set = new Set(deals.filter((d) => d !== 'better_1l' && d !== 'time_sensitive'));
  if (set.size === 1 && set.has('both')) return { has_rip: true, has_discount: true };
  if (set.size === 1 && set.has('rip')) return { has_rip: true };
  if (set.size === 1 && set.has('qd')) return { has_discount: true };
  return {};
}

// Build the deal cards for a set of search rows: size filter, merge same product
// across distributors, keep only products that ACTUALLY have a RIP or QD, collapse
// case-mix flavour variants, apply the deal-type filter, sort, cap at 60.
function dealProducts(items: Product[], deals: string[], sizes: string[], sortBy: string): MergedProduct[] {
  const litreSet = new Set(sizes.map((s) => litresOf(s)).filter((v): v is number => v != null));
  const sized = litreSet.size
    ? items.filter((it) => { const L = litresOf(it.unit_volume); return L != null && litreSet.has(L); })
    : items;
  // better_1l / time_sensitive are cross-cutting filters, not RIP/QD deal TYPES.
  const typeDeals = deals.filter((d) => d !== 'better_1l' && d !== 'time_sensitive');
  const hasDeal = (p: Product) => !!topTier(p.tiers, 'rip') || !!topTier(p.tiers, 'discount');
  let out = collapseCaseMix(mergeByDeal(sized).filter(hasDeal))
    .filter((p) => {
      if (!typeDeals.length) return true;   // no deal-type filter -> any RIP or QD
      const hasRip = !!topTier(p.tiers, 'rip');
      const hasQd = !!topTier(p.tiers, 'discount');
      return (typeDeals.includes('rip') && hasRip)
          || (typeDeals.includes('qd') && hasQd)
          || (typeDeals.includes('both') && hasRip && hasQd);
    });
  // Time-sensitive: keep only cards carrying a dated (limited-window) tier.
  if (deals.includes('time_sensitive')) {
    out = out.filter((p) => (p.tiers ?? []).some((t) => t.is_time_sensitive));
  }
  // Better 1L price: keep 1L cards whose per-BOTTLE price is <= the SAME product's
  // 750ML per-bottle price (you get 33% more product for about the same money).
  // The 750ML reference comes from the FULL, unsized item set.
  if (deals.includes('better_1l')) {
    const ref750 = new Map<string, number>();
    for (const it of items) {
      if (sizeBucket(it.unit_volume) !== '750ML') continue;
      const pb = afterDealBottle(it);
      if (pb == null) continue;
      const k = productKey(it);
      const cur = ref750.get(k);
      if (cur == null || pb < cur) ref750.set(k, pb);
    }
    // A 1L qualifies if its after-deal bottle price is within 5% of the 750ML's
    // (i.e. up to 5% dearer per bottle still wins, since the 1L is 33% more product).
    out = out.filter((p) => {
      if (sizeBucket(p.unit_volume) !== '1L') return false;
      const ref = ref750.get(productKey(p));
      const pb = afterDealBottle(p);
      return ref != null && pb != null && pb <= ref * 1.05;
    });
  }
  return out.sort(SORT_FNS[sortBy] ?? SORT_FNS.net).slice(0, 60);
}

// On-submit SEMANTIC deal search: the query goes to the shared /api/catalog/search
// (aliases + spell-fix + semantic), and we show the matching DEALS. Replaces the
// category rails while a search is active.
function SearchResults({ query, distributors, deals, sizes, sortBy, edition }:
  { query: string; distributors: string[]; deals: string[]; sizes: string[]; sortBy: string; edition: string }) {
  const distParam = distributors.length ? distributors.join(',') : undefined;
  const sizesParam = sizes.length ? sizes.join(',') : '375ML,750ML,1L,1.75L';
  const { data, isLoading } = useQuery({
    queryKey: ['disc-search', query, distParam ?? '', edition, deals.filter((d) => d !== 'better_1l' && d !== 'time_sensitive').sort().join(','), sizesParam],
    staleTime: 300_000,
    queryFn: () => catalog.search({ q: query, ...dealSearchParams(deals), ...(distParam ? { divisions: distParam } : {}), ...(edition ? { edition } : {}), sizes: sizesParam, sort: 'mi_volume', order: 'desc', limit: 300, images_first: false, include_tiers: true }),
  });
  const products = dealProducts(data?.items ?? [], deals, sizes, sortBy);
  return (
    <section className="disc-rail">
      <div className="disc-rail-head"><h2 className="disc-rail-title">Deals matching “{query}”</h2></div>
      <div className="disc-rail-track">
        {isLoading && Array.from({ length: 6 }).map((_, i) => <div key={i} className="disc-card disc-card--skel" />)}
        {!isLoading && products.length === 0 && (
          <div className="disc-rail-empty">No deals found for “{query}”. Try another product, brand, or category.</div>
        )}
        {products.map((p, i) => <DiscCard key={`${p.product_name}-${i}`} p={p} />)}
      </div>
    </section>
  );
}

// Rails scrolled into view at least once this session — so BACK renders them from
// cache instead of re-fetching. Module-level: survives route changes.
const seenRails = new Set<string>();

function Rail({ rail, distributors, deals, sizes, sortBy, edition }: { rail: MiRail; distributors: string[]; deals: string[]; sizes: string[]; sortBy: string; edition: string }) {
  const { ref, seen: inView } = useInView<HTMLElement>();
  // A rail that has been scrolled into view ONCE stays "shown" for the rest of
  // the SPA session. So on BACK, every rail the user already loaded renders again
  // straight from the React Query cache — no network, no skeleton flicker — while
  // rails never seen stay lazy. (Previously we force-fetched all rails on POP,
  // which re-queried the network on every back.)
  const show = inView || seenRails.has(rail.label);
  useEffect(() => { if (inView) seenRails.add(rail.label); }, [inView, rail.label]);
  const distParam = distributors.length ? distributors.join(',') : undefined;
  const sizesParam = sizes.length ? sizes.join(',') : '375ML,750ML,1L,1.75L';
  const { data, isLoading } = useQuery({
    // distParam / deals / sizes are part of the key so every filter REFETCHES
    // (server-side) instead of just narrowing the initial 300 — so the grid can
    // fill from the full qualifying set, not whatever the top-volume list held.
    queryKey: ['mi-rail', rail.params, distParam ?? '', edition, deals.filter((d) => d !== 'better_1l' && d !== 'time_sensitive').sort().join(','), sizesParam],
    enabled: show,
    // Deal data only changes on a monthly reload, and the server memoises these
    // responses, so keep them fresh client-side for a long while (no refetch on
    // every revisit / back-navigation within a session).
    staleTime: 1_800_000,
    gcTime: 3_600_000,
    // Featured rails show standard retail bottles only (1.75L / 1L / 750ML / 375ML),
    // not minis, 4-packs, cans or tray packs that otherwise top the volume rank.
    // include_tiers gives us each SKU's QD + RIP ladder for the deal chips.
    queryFn: () => catalog.search({ ...rail.params, ...dealSearchParams(deals), ...(distParam ? { divisions: distParam } : {}), ...(edition ? { edition } : {}), sizes: sizesParam, sort: 'mi_volume', order: 'desc', limit: 300, images_first: false, include_tiers: true }),
  });
  const products = dealProducts(data?.items ?? [], deals, sizes, sortBy);
  return (
    <section ref={ref} className="disc-rail">
      <div className="disc-rail-head">
        <h2 className="disc-rail-title">{rail.label} Deals</h2>
        <Link to={railHref(rail.params)} className="disc-rail-all">See all &rarr;</Link>
      </div>
      <div className="disc-rail-track">
        {(!show || isLoading) && Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="disc-card disc-card--skel" />
        ))}
        {show && !isLoading && products.length === 0 && (
          <div className="disc-rail-empty">No products found.</div>
        )}
        {products.map((p, i) => <DiscCard key={`${p.product_name}-${i}`} p={p} />)}
      </div>
    </section>
  );
}

// ---- My Favorites: the user's watchlisted products, priced, with three
// per-bottle prices (1-case list / after best QD / after best QD+RIP). The hero
// search filters this grid IN PLACE (never leaves the page).
// The three per-bottle prices in ONE format used everywhere: ($X1, $X2, $X3) =
// 1-case list, after best QD, after best QD+RIP. Hover for the breakdown.
function BottlePrices({ p }: { p: Product }) {
  const pack = bottlesPerCase(p.product_name, p.unit_qty);
  const x1 = p.frontline_unit_price ?? null;                        // 1-case bottle price (list)
  const x2 = p.best_unit_price ?? null;                             // after best QD (canonical column)
  // After best QD + best RIP: subtract the deepest RIP (per bottle) — the same
  // RIP shown in the chip — from the best-QD bottle price. (effective_case_price
  // is the STABLE whole-month price and drops time-sensitive RIPs, so it can't
  // be used here — that was the bug where X3 == X2.)
  const rip = topTier(p.tiers, 'rip');
  const ripPerCase = rip?.save_per_case ?? 0;   // unit-aware per-case, NOT amount/qty
  const x3 = x2 != null && pack ? Math.max(0, x2 - ripPerCase / pack) : null;
  const tip = `Bottle price: ${money(x1) ?? '—'} at 1 case (list) · ${money(x2) ?? '—'} after best QD · ${x3 != null ? money(x3) : '—'} after best QD + RIP`;
  return (
    <div className="disc-fav-prices" title={tip}>
      <span className="disc-bp-label">Bottle Price:</span> {money(x1) ?? '—'}, {x2 != null ? money(x2) : '—'}, {x3 != null ? money(x3) : '—'}
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
        <FavoriteButton productName={p.product_name} wholesaler={p.wholesaler}
          upc={p.upc ?? undefined} unitVolume={p.unit_volume ?? undefined} />
      </div>
      {/* Check Allied / Check Fedway — self-hides for other distributors. */}
      <AvailabilityButton wholesaler={p.wholesaler} name={p.product_name}
        itemNumber={p.abg_sku ?? undefined} className="disc-card-avail" />
      <div className="disc-card-media">
        <ProductThumb src={p.image_url ?? undefined} alt={p.product_name} size={120} />
      </div>
      <div className="disc-card-name">
        {(p.abg_item_name?.trim() || p.product_name)}
        {sizeLabel && <span className="disc-fav-size"> ({sizeLabel})</span>}
      </div>
      <BottlePrices p={p} />
    </Link>
  );
}

function MyFavorites({ query, edition }: { query: string; edition: string }) {
  const { data: favs } = useQuery({ queryKey: ['watchlist'], queryFn: watchlist.get, staleTime: 60_000 });
  const upcs = [...new Set((favs ?? []).map((f) => f.upc).filter(Boolean) as string[])];
  const { data: priced } = useQuery({
    enabled: upcs.length > 0,
    queryKey: ['fav-priced', upcs.slice().sort().join(','), edition],
    staleTime: 300_000,
    queryFn: () => catalog.search({ upcs: upcs.join(','), ...(edition ? { edition } : {}), limit: 500, sort: 'product_name', order: 'asc' }),
  });
  if (!favs || favs.length === 0) return null;
  const items = priced?.items ?? [];
  // Index priced rows by leading-zero-normalised UPC (a UPC can appear at several
  // distributors / sizes).
  const normUpc = (u?: string | null) => String(u ?? '').replace(/^0+/, '');
  const byUpc = new Map<string, Product[]>();
  for (const p of items) {
    const k = normUpc(p.upc);
    const arr = byUpc.get(k); if (arr) arr.push(p); else byUpc.set(k, [p]);
  }
  const q = query.trim().toLowerCase();
  const cards = (favs as WatchlistItem[])
    .map((f) => {
      const rows = byUpc.get(normUpc(f.upc)); if (!rows?.length) return undefined;
      // Prefer the favourited distributor + exact size; then same distributor;
      // then exact size at any distributor; else the first priced row.
      return rows.find((p) => p.wholesaler === f.wholesaler && p.unit_volume === f.unit_volume)
        ?? rows.find((p) => p.wholesaler === f.wholesaler)
        ?? rows.find((p) => p.unit_volume === f.unit_volume)
        ?? rows[0];
    })
    .filter((p): p is Product => !!p)
    .filter((p) => !q || `${p.abg_item_name ?? ''} ${p.product_name} ${p.brand ?? ''}`.toLowerCase().includes(q));
  return (
    <section className="disc-favs">
      <div className="disc-rail-head"><h2 className="disc-rail-title">My Favorites</h2></div>
      <div className="disc-rail-track">
        {cards.map((p, i) => <FavCard key={`${p.wholesaler}-${p.upc}-${i}`} p={p} />)}
        {cards.length === 0 && <div className="disc-rail-empty">No favorites match your search.</div>}
      </div>
    </section>
  );
}

function toggleIn(set: Set<string>, v: string): Set<string> {
  const n = new Set(set);
  n.has(v) ? n.delete(v) : n.add(v);
  return n;
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

export default function Discover() {
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');   // the query actually searched (on Enter/Search)
  const [distSet, setDistSet] = useState<Set<string>>(new Set());
  const [catSet, setCatSet] = useState<Set<string>>(new Set());
  const [dealSet, setDealSet] = useState<Set<string>>(new Set());
  const [sizeSet, setSizeSet] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState('case');
  const [edition, setEdition] = useState('');   // '' = current month
  const [filtersCollapsed, setFiltersCollapsed] = useState(() => localStorage.getItem('disc_filters_collapsed') === '1');
  useEffect(() => { localStorage.setItem('disc_filters_collapsed', filtersCollapsed ? '1' : '0'); }, [filtersCollapsed]);
  const { data } = useQuery({ queryKey: ['mi-top-categories'], queryFn: catalog.topCategories, staleTime: 3_600_000 });
  // Available months (YYYY-MM), newest first; default (current) is the first.
  const { data: eds } = useQuery({ queryKey: ['editions'], queryFn: catalog.editions, staleTime: 3_600_000 });
  const months = [...new Set((eds ?? []).map((e) => e.edition))].sort().reverse();
  const allRails: MiRail[] = [...(data?.spirits ?? []), ...(data?.wine ?? [])];
  const rails = catSet.size ? allRails.filter((r) => catSet.has(r.label)) : allRails;
  const dists = [...distSet];
  const deals = [...dealSet];
  const sizeList = [...sizeSet];
  const activeCount = distSet.size + catSet.size + dealSet.size + sizeSet.size + (edition ? 1 : 0);

  return (
    <div className="disc-page">
      <header className="disc-hero">
        <h1 className="disc-title">Celr AI</h1>
        <p className="disc-sub">Find any product, at any distributor</p>
        {/* Semantic deal search: runs ONLY on Enter / Search (not per keystroke),
            and finds matching DEALS on this page. */}
        <form className="disc-search" onSubmit={(e) => { e.preventDefault(); setSubmitted(q.trim()); }}>
          <Search size={18} className="disc-search-ic" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search deals — product, brand, region…"
            aria-label="Search deals"
          />
          {submitted && <button type="button" onClick={() => { setQ(''); setSubmitted(''); }}>Clear</button>}
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
                  onClick={() => { setDistSet(new Set()); setCatSet(new Set()); setDealSet(new Set()); setSizeSet(new Set()); setEdition(''); }}>
                  Clear
                </button>
              )}
              <button type="button" className="disc-filters-collapse" title="Collapse filters"
                aria-label="Collapse filters" onClick={() => setFiltersCollapsed(true)}>
                <PanelLeftClose size={16} />
              </button>
            </span>
          </div>

          <FilterSection title="Month">
            <select className="disc-filter-select" value={edition} onChange={(e) => setEdition(e.target.value)}>
              <option value="">Current month</option>
              {months.map((m) => <option key={m} value={m}>{fmtMonth(m)}</option>)}
            </select>
          </FilterSection>

          <FilterSection title="Sort by">
            <select className="disc-filter-select" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              {SORT_OPTS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </FilterSection>

          <FilterSection title="Deal" count={dealSet.size}>
            {[['rip', 'Has RIP'], ['qd', 'Has QD'], ['both', 'Has both QD & RIP'], ['time_sensitive', 'Time-sensitive'], ['better_1l', 'Better 1L price']].map(([v, label]) => (
              <label key={v} className="disc-filter-opt">
                <input type="checkbox" checked={dealSet.has(v)} onChange={() => setDealSet((s) => toggleIn(s, v))} />
                <span>{label}</span>
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
          {submitted
            ? <SearchResults query={submitted} distributors={dists} deals={deals} sizes={sizeList} sortBy={sortBy} edition={edition} />
            : rails.map((r) => <Rail key={r.label} rail={r} distributors={dists} deals={deals} sizes={sizeList} sortBy={sortBy} edition={edition} />)}
        </div>
      </div>
    </div>
  );
}
