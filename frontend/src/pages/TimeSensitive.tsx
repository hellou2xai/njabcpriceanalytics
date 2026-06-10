import { useEffect, useMemo, useState } from 'react';
import { useSearchParams, useLocation } from 'react-router-dom';
import { useResultCount } from '../lib/resultCount';
import { useQuery } from '@tanstack/react-query';
import { deals, watchlist, type TimeSensitiveDeal } from '../lib/api';
import { ContextMenuProvider } from '../components/ContextMenu';
import { RowMenuButton } from '../components/ContextMenu';
import FavoriteButton from '../components/FavoriteButton';
import AddToCartButton from '../components/AddToCartButton';
import AddToListButton from '../components/AddToListButton';
import ProductThumb from '../components/ProductThumb';
import FilterSidebar, { type FilterSection } from '../components/FilterSidebar';
import PromotionsToolbar from '../components/PromotionsToolbar';
import PromotionsPager from '../components/PromotionsPager';
import PromotionsTable, { type PromotionRow } from '../components/PromotionsTable';
import MonthEffectiveSparkline from '../components/MonthEffectiveSparkline';
import { buildSparkProps } from '../lib/promotionsSparkline';
import VintageSticker from '../components/VintageSticker';
import { useProductQuickView } from '../components/ProductQuickView';
import { distributorName, ALL_DISTRIBUTORS, priceUnit } from '../lib/distributors';
import { AI_EXPLAINERS_ENABLED } from '../lib/flags';

const money = (v?: number | null) => (v == null ? '-' : `$${Number(v).toFixed(2)}`);

function urgencyClass(days: number | null | undefined): string {
  if (days == null) return '';
  if (days < 0) return 'urgency-ended';
  if (days <= 3) return 'urgency-hot';
  if (days <= 7) return 'urgency-warm';
  if (days <= 14) return 'urgency-soon';
  return 'urgency-later';
}
function urgencyLabel(days: number | null | undefined): string {
  if (days == null) return 'Ends soon';
  if (days < 0) return `Ended ${-days} day${days === -1 ? '' : 's'} ago`;
  if (days === 0) return 'Ends today';
  if (days === 1) return 'Ends tomorrow';
  return `Ends in ${days} days`;
}
// Days until a deal STARTS (>0 means it hasn't begun yet — a future deal).
function daysUntilStart(from?: string | null): number | null {
  if (!from) return null;
  const f = new Date(from + 'T00:00:00');
  if (isNaN(f.getTime())) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((f.getTime() - today.getTime()) / 86400000);
}
function fmtDateRange(from?: string | null, to?: string | null): string {
  const f = (d?: string | null) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  if (from && to) return `${f(from)} to ${f(to)}`;
  return f(from || to);
}
// True when a deal spans a full calendar month (starts on the 1st, ends on the
// month's last day). The assistant's ?window=partial filter excludes these so
// only genuinely short-window deals show.
function spansFullMonth(from?: string | null, to?: string | null): boolean {
  if (!from || !to) return false;
  const f = new Date(from + 'T00:00:00'), t = new Date(to + 'T00:00:00');
  if (isNaN(f.getTime()) || isNaN(t.getTime())) return false;
  const lastDay = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  return f.getDate() === 1 && t.getDate() === lastDay
    && f.getFullYear() === t.getFullYear() && f.getMonth() === t.getMonth();
}

export default function TimeSensitive() {
  const { open } = useProductQuickView();
  const [params] = useSearchParams();
  const [wholesaler, setWholesaler] = useState('');
  const [q, setQ] = useState(params.get('q') ?? '');
  // The assistant can filter this page in place by pushing ?q=<term|upc>.
  useEffect(() => { const u = params.get('q'); if (u !== null) setQ(u); }, [params]);
  const [productType, setProductType] = useState('');
  const [validity, setValidity] = useState('');     // '' | 'this-week' | 'ends-this-month' | 'next-month' | 'future'
  const [minSave, setMinSave] = useState('');
  const [minDiscount, setMinDiscount] = useState('');
  const [minGp, setMinGp] = useState('');
  const [hasRip, setHasRip] = useState<'' | 'yes' | 'no'>('');
  const [hasCloseout, setHasCloseout] = useState<'' | 'yes' | 'no'>('');
  const [size, setSize] = useState('');
  const [trackedOnly, setTrackedOnly] = useState(false);
  const [sort, setSort] = useState<'ending' | 'save' | 'pct' | 'name'>('ending');
  const [limit, setLimit] = useState(60);
  const [page, setPage] = useState(0);

  const { data, isLoading } = useQuery({
    queryKey: ['time-sensitive', wholesaler],
    queryFn: () => deals.timeSensitive({ wholesaler: wholesaler || undefined, limit: 2000 }),
  });
  const { data: wl } = useQuery({ queryKey: ['watchlist'], queryFn: watchlist.get, enabled: trackedOnly });
  // Category facet computed from the actual time-sensitive deals list, not
  // the global /api/catalog/categories endpoint. The global one returned the
  // full catalog ("Wine 61,861") which on a 214-deal page is misleading at
  // best and click-bait at worst. Now the dropdown shows the real count of
  // time-sensitive deals per category.
  const cats = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of data ?? []) {
      const t = d.product_type;
      if (!t) continue;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([product_type, count]) => ({ product_type, count }))
      .sort((a, b) => b.count - a.count);
  }, [data]);

  // Assistant-driven: ?window=partial keeps only deals that DON'T span a full
  // calendar month (the genuinely short-window deals); ?window=full keeps the
  // full-month promos.
  const windowFilter = params.get('window');

  const items = useMemo(() => {
    let res: TimeSensitiveDeal[] = data ?? [];
    // Past deals are never relevant on this page — only current + upcoming.
    res = res.filter(i => (i.days_to_expire ?? 0) >= 0);
    // "Future Deals": only deals that haven't started yet (start date is ahead).
    // Every other view shows deals that HAVE started (the complement) — the old
    // `days_to_expire < 0` else-branch here was a leftover from the removed
    // "Past deals" toggle and emptied the page (nothing is both unexpired AND
    // expired).
    if (validity === 'future') res = res.filter(i => (daysUntilStart(i.from_date) ?? -1) > 0);
    else res = res.filter(i => (daysUntilStart(i.from_date) ?? 0) <= 0);
    // A deal that runs the WHOLE calendar month isn't time-sensitive, so it is
    // EXCLUDED by default (and under the assistant's ?window=partial). Only an
    // explicit ?window=full surfaces those full-month promos.
    if (windowFilter === 'full') res = res.filter(i => spansFullMonth(i.from_date, i.to_date));
    else res = res.filter(i => !spansFullMonth(i.from_date, i.to_date));
    if (q) {
      const ql = q.toLowerCase();
      { const qd = q.replace(/\D/g, '');
        res = res.filter(i =>
          i.product_name.toLowerCase().includes(ql) ||
          (i.brand ?? '').toLowerCase().includes(ql) ||
          (qd.length >= 6 && String(i.upc ?? '').replace(/^0+/, '').includes(qd.replace(/^0+/, '')))); }
    }
    if (productType) res = res.filter(i => i.product_type === productType);
    if (size) res = res.filter(i => (i.unit_volume ?? '').toLowerCase().includes(size.toLowerCase()));
    if (hasRip === 'yes') res = res.filter(i => i.has_rip);
    if (hasRip === 'no') res = res.filter(i => !i.has_rip);
    if (hasCloseout === 'yes') res = res.filter(i => i.has_closeout);
    if (hasCloseout === 'no') res = res.filter(i => !i.has_closeout);
    if (minSave) { const n = parseFloat(minSave); res = res.filter(i => (i.total_savings_per_case ?? 0) >= n); }
    if (minDiscount) { const n = parseFloat(minDiscount); res = res.filter(i => (i.discount_pct ?? 0) >= n); }
    if (minGp) {
      const n = parseFloat(minGp);
      res = res.filter(i => {
        const fr = i.frontline_case_price, save = i.total_savings_per_case;
        if (fr == null || !fr || save == null) return false;
        return (save / fr) * 100 >= n;
      });
    }
    if (validity === 'this-week') res = res.filter(i => (i.days_to_expire ?? 999) <= 7);
    if (validity === 'next-month') {
      const eom = new Date(); eom.setMonth(eom.getMonth() + 1); eom.setDate(0);
      const lastDay = eom.toISOString().slice(0, 10);
      res = res.filter(i => i.to_date != null && i.to_date > lastDay);
    }
    if (validity === 'ends-this-month') {
      const eom = new Date(); eom.setMonth(eom.getMonth() + 1); eom.setDate(0);
      const lastDay = eom.toISOString().slice(0, 10);
      res = res.filter(i => i.to_date != null && i.to_date <= lastDay);
    }
    if (trackedOnly && wl) {
      const tracked = new Set(wl.map(i => `${i.product_name}|${i.wholesaler}`));
      res = res.filter(i => tracked.has(`${i.product_name}|${i.wholesaler}`));
    }
    switch (sort) {
      case 'save': res = [...res].sort((a, b) => (b.total_savings_per_case ?? 0) - (a.total_savings_per_case ?? 0)); break;
      case 'pct':  res = [...res].sort((a, b) => (b.discount_pct ?? 0) - (a.discount_pct ?? 0)); break;
      case 'name': res = [...res].sort((a, b) => a.product_name.localeCompare(b.product_name)); break;
      case 'ending':
      default:     res = [...res].sort((a, b) => (a.days_to_expire ?? 999) - (b.days_to_expire ?? 999));
    }
    return res;
  }, [data, q, productType, size, hasRip, hasCloseout, minSave, minDiscount, minGp, validity, windowFilter, trackedOnly, wl, sort]);

  // Publish the matched-row count so the AI assistant echoes the exact number.
  const { report } = useResultCount();
  const { pathname } = useLocation();
  useEffect(() => {
    if (!isLoading) report(pathname, items.length);
  }, [isLoading, items.length, pathname, report]);

  const shown = items.slice(page * limit, (page + 1) * limit);
  const [view, setView] = useState<'cards' | 'table'>(() => (localStorage.getItem('ts-view') as 'cards' | 'table') || 'cards');
  useEffect(() => { localStorage.setItem('ts-view', view); }, [view]);

  // Distinguish "filters hid everything" from "the source genuinely returned
  // nothing". The latter happens when the current edition's dated promos have
  // all expired (or none are loaded yet) — a blank page reads as broken, so
  // say what's actually going on.
  const rawCount = (data ?? []).length;
  const emptyMessage = rawCount === 0
    ? 'No active dated deals right now. Every time-sensitive promotion for the current price sheet has either expired or not started yet. New dated deals appear here as the next edition loads.'
    : 'No deals match these filters.';

  // ---- Filter sections ----
  const sections: FilterSection[] = [
    { type: 'text', key: 'q', title: 'Search', placeholder: 'Product or brand', value: q, onChange: setQ },
    { type: 'pills', key: 'wholesaler', title: 'Distributor', options: ALL_DISTRIBUTORS, value: wholesaler, onChange: setWholesaler },
    { type: 'select', key: 'product_type', title: 'Category', placeholder: 'All categories',
      options: (cats ?? []).map(c => ({ value: c.product_type, label: c.product_type, count: c.count })),
      value: productType, onChange: setProductType },
    { type: 'pills', key: 'validity', title: 'Deal validity', value: validity, onChange: setValidity,
      options: [
        { value: '', label: 'All' },
        { value: 'this-week', label: 'Ends this week' },
        { value: 'ends-this-month', label: 'Ends this month' },
        { value: 'next-month', label: 'Continues next month' },
        { value: 'future', label: 'Future Deals' },
      ] },
    { type: 'pills', key: 'min_save', title: 'Min saving / case', value: minSave, onChange: setMinSave,
      options: [
        { value: '', label: 'Any' }, { value: '5', label: '$5+' }, { value: '10', label: '$10+' },
        { value: '25', label: '$25+' }, { value: '50', label: '$50+' }, { value: '100', label: '$100+' },
      ] },
    { type: 'pills', key: 'min_discount', title: 'Min discount %', value: minDiscount, onChange: setMinDiscount,
      options: [
        { value: '', label: 'Any' }, { value: '5', label: '5%+' }, { value: '10', label: '10%+' },
        { value: '15', label: '15%+' }, { value: '25', label: '25%+' },
      ] },
    { type: 'pills', key: 'min_gp', title: 'Min GP %', value: minGp, onChange: setMinGp,
      options: [
        { value: '', label: 'Any' }, { value: '10', label: '10%+' }, { value: '15', label: '15%+' },
        { value: '20', label: '20%+' }, { value: '25', label: '25%+' },
      ] },
    { type: 'pills', key: 'has_rip', title: 'Has RIP rebate', value: hasRip, onChange: v => setHasRip(v as '' | 'yes' | 'no'),
      options: [{ value: '', label: 'Any' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] },
    { type: 'pills', key: 'has_closeout', title: 'Closeout', value: hasCloseout, onChange: v => setHasCloseout(v as '' | 'yes' | 'no'),
      options: [{ value: '', label: 'Any' }, { value: 'yes', label: 'Closeout' }, { value: 'no', label: 'No' }] },
    { type: 'text', key: 'size', title: 'Size', placeholder: 'e.g. 750ML, 1.75L', value: size, onChange: setSize },
    { type: 'toggle', key: 'tracked', title: 'Favorites', value: trackedOnly, onChange: setTrackedOnly, label: 'Only my favourites' },
  ];

  const sortOptions = [
    { value: 'ending' as const, label: 'Ending soonest' },
    { value: 'save' as const,   label: 'Biggest saving $' },
    { value: 'pct' as const,    label: 'Biggest % off' },
    { value: 'name' as const,   label: 'Name (A-Z)' },
  ];

  return (
    <div className="page">
      <div className="orders-header">
        <h2>Time-Sensitive Deals</h2>
        <span className="text-muted" style={{ fontSize: 13 }}>
          {isLoading ? 'Loading…' : `${items.length.toLocaleString()} deal${items.length === 1 ? '' : 's'}`}
        </span>
      </div>
      <p className="text-muted" style={{ marginTop: 0, fontSize: 13 }}>
        Promotions and special prices that end on a specific date and do not recur next month. Easy to miss.
      </p>

      <div className="catalog-layout">
        <FilterSidebar storageKey="ts-filters" sections={sections}
          onReset={() => { setQ(''); setWholesaler(''); setProductType(''); setValidity(''); setMinSave(''); setMinDiscount(''); setMinGp(''); setHasRip(''); setHasCloseout(''); setSize(''); setTrackedOnly(false); setSort('ending'); }} />

        <div className="catalog-results">
          <PromotionsToolbar
            sortValue={sort}
            onSortChange={setSort}
            sortOptions={sortOptions}
            limit={limit}
            onLimitChange={(n) => { setLimit(n); setPage(0); }}
            total={items.length}
            shownInCards={shown.length}
            view={view}
            onViewChange={setView}
            page={page}
            onPageChange={setPage}
            noun="deals"
          />

          <ContextMenuProvider onView={open}>
            {view === 'cards' ? (
              <div className="deal-cards">
                {shown.map((d, i) => (
                  // Key includes index so multi-vintage rows with the same
                  // (wholesaler, UPC) don't collide. Vintage/edition is
                  // not on TimeSensitiveDeal so falling back to the index
                  // is the cheapest collision-free option, and the list
                  // is short enough (capped by `limit`) that index-key
                  // reconciliation is fine here.
                  <DealCard key={`${d.wholesaler}|${d.upc ?? d.product_name}|${d.unit_volume ?? ''}|${i}`} d={d} open={open} />
                ))}
                {!isLoading && shown.length === 0 && (
                  <div className="empty" style={{ padding: 30, textAlign: 'center', maxWidth: 480, margin: '0 auto' }}>{emptyMessage}</div>
                )}
              </div>
            ) : (
              <PromotionsTable
                rows={items.map(tsdToPromotionRow)}
                exportName="time-sensitive-deals"
                onRowClick={(r) => open(r.product_name, r.wholesaler, undefined,
                  { upc: r.upc ?? undefined, unitVolume: r.unit_volume ?? undefined })}
              />
            )}
          </ContextMenuProvider>
          <PromotionsPager page={page} total={items.length} limit={limit} onPageChange={setPage} view={view} />
        </div>
      </div>
    </div>
  );
}

function DealCard({ d, open }: { d: TimeSensitiveDeal; open: (n: string, w: string, c?: unknown, opts?: { upc?: string; unitVolume?: string }) => void }) {
  const save = d.total_savings_per_case ?? null;
  const pct = d.discount_pct ?? null;
  const fr = d.frontline_case_price ?? null;
  const eff = d.effective_case_price ?? null;
  const uq = Number(d.unit_qty) || 0;
  const effBtl = eff != null && uq > 1 ? eff / uq : null;
  const gp = fr && save ? (save / fr) * 100 : null;
  const urgency = urgencyClass(d.days_to_expire);
  // A deal whose start date is still in the future hasn't begun — label it a
  // "Future deal" rather than "Ends in N days" (which reads as already active).
  const startsIn = daysUntilStart(d.from_date);
  const isFuture = startsIn != null && startsIn > 0;

  return (
    <div className={`deal-card ${urgency}`} role="button" tabIndex={0}
         data-ctx data-ctx-product={d.product_name} data-ctx-wholesaler={d.wholesaler}
         data-ctx-upc={d.upc ?? ''} data-ctx-volume={d.unit_volume ?? ''}
         onClick={(e) => {
           // Ignore clicks that originated on an interactive child (buttons,
           // links, inputs, the order action row) so those keep their own
           // behaviour. Otherwise open the full product details pop-up, same
           // as clicking a row in the table view.
           const t = e.target as HTMLElement;
           if (t.closest('button, a, input, label, .deal-card-actions, .add-to-list-menu, .row-menu-btn, .ctx-menu')) return;
           open(d.product_name, d.wholesaler, undefined, { upc: d.upc ?? undefined, unitVolume: d.unit_volume ?? undefined, unitQty: d.unit_qty ?? undefined, vintage: d.vintage ?? undefined });
         }}
         onKeyDown={(e) => {
           if (e.key === 'Enter' || e.key === ' ') {
             e.preventDefault();
             open(d.product_name, d.wholesaler, undefined, { upc: d.upc ?? undefined, unitVolume: d.unit_volume ?? undefined, unitQty: d.unit_qty ?? undefined, vintage: d.vintage ?? undefined });
           }
         }}>
      <div className="deal-card-head">
        <ProductThumb src={d.image_url ?? undefined} alt={d.product_name} size={70} />
        <div className="deal-card-id">
          <div className="deal-card-name" title={d.product_name}>
            {d.product_name}
          </div>
          <div className="deal-card-sub">
            {d.brand && <span>{d.brand}</span>}
            {d.unit_volume && <span>· {d.unit_volume}</span>}
            {d.vintage && d.vintage !== '0' && (
              <span>· Vintage {String(d.vintage).replace(/\.0+$/, '')}</span>
            )}
            <span className="cell-distributor-badge">{distributorName(d.wholesaler)}</span>
            <VintageSticker vintages={d.vintages_available} currentVintage={d.vintage as string | null} />
          </div>
        </div>
        <span className={`deal-urgency ${isFuture ? 'urgency-future' : urgency}`} title={fmtDateRange(d.from_date, d.to_date)}>
          {isFuture
            ? (startsIn === 1 ? 'Future deal · starts tomorrow' : `Future deal · in ${startsIn} days`)
            : urgencyLabel(d.days_to_expire)}
        </span>
      </div>

      <div className="deal-card-price">
        {fr != null && eff != null && fr !== eff && <span className="deal-was">${fr.toFixed(2)}</span>}
        <span className="deal-now">{money(eff ?? fr)}<span className="deal-unit">/{priceUnit(d.unit_volume)}</span></span>
        {save != null && save > 0 && (
          <span className="deal-save">Save <strong>${save.toFixed(2)}/{priceUnit(d.unit_volume)}</strong>{pct ? ` · ${pct.toFixed(0)}% off` : ''}</span>
        )}
      </div>

      {effBtl != null && (
        <div className="deal-btl-now">${effBtl.toFixed(2)}<span className="deal-unit">/btl</span><span className="deal-btl-tag">effective</span></div>
      )}

      <div className="deal-card-meta">
        {gp != null && <span>GP {gp.toFixed(0)}%</span>}
        {d.has_rip && <span className="source-badge source-rip">RIP rebate stacks</span>}
        {d.has_closeout && <span className="tag tag-orange">Closeout</span>}
      </div>

      <div className="deal-card-spark">
        {/* Same two-point this-month vs next-month sparkline + popover as
            the Catalog row. Backend's attach_promotion_tiers fills the
            tier ladders for both editions so the popover renders
            Frontline / Discount / RIP / Best identically. */}
        <MonthEffectiveSparkline
          {...buildSparkProps(d)}
        />
        <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text)' }}>{fmtDateRange(d.from_date, d.to_date)}</span>
      </div>

      {AI_EXPLAINERS_ENABLED && d.ai_blurb && (
        <div className="deal-card-ai" title="AI explanation, refreshed with each data load">
          <span className="deal-ai-mark">✨</span> {d.ai_blurb}
        </div>
      )}

      <div className="deal-card-actions">
        <FavoriteButton productName={d.product_name} wholesaler={d.wholesaler}
          upc={d.upc ?? undefined} unitVolume={d.unit_volume ?? undefined} />
        <AddToCartButton productName={d.product_name} wholesaler={d.wholesaler}
          upc={d.upc ?? undefined} unitVolume={d.unit_volume ?? undefined} qtyCases={1} qtyUnits={0} />
        <AddToListButton productName={d.product_name} wholesaler={d.wholesaler}
          upc={d.upc ?? undefined} unitVolume={d.unit_volume ?? undefined} />
        <RowMenuButton product={{ product_name: d.product_name, wholesaler: d.wholesaler, upc: d.upc ?? undefined, unit_volume: d.unit_volume ?? undefined }} />
      </div>
    </div>
  );
}


// ---- adapter: TimeSensitiveDeal -> standard PromotionRow ----
// The shared PromotionsTable renders the standard column set, so every
// promotions page (Time-Sensitive, Major Discounts, Price Drops/Increases,
// Top Discounts) shows the same columns in the same order.

function tsdQty(r: TimeSensitiveDeal): number {
  const q = r.unit_qty ? parseInt(r.unit_qty, 10) : 0;
  return isNaN(q) ? 0 : q;
}
function tsdNetCase(r: TimeSensitiveDeal): number | null {
  return r.effective_case_price ?? r.frontline_case_price ?? null;
}
function tsdSpanDays(r: TimeSensitiveDeal): number | null {
  if (!r.from_date || !r.to_date) return null;
  const f = Date.parse(r.from_date); const t = Date.parse(r.to_date);
  if (isNaN(f) || isNaN(t)) return null;
  return Math.round((t - f) / 86400000);
}
function tsdStickerObj(r: TimeSensitiveDeal): PromotionRow['sticker'] {
  const s = tsdSpanDays(r);
  if (s == null) return null;
  if (s <= 0) return { label: '1-DAY ONLY', tone: 'red' };
  if (s < 7)  return { label: 'UNDER A WEEK', tone: 'orange' };
  return null;
}

function tsdToPromotionRow(r: TimeSensitiveDeal): PromotionRow {
  const net = tsdNetCase(r);
  const qty = tsdQty(r);
  const netBtl = qty > 0 && net != null ? net / qty : null;
  const full = r.frontline_case_price;
  const gp = full != null && net != null && full > 0 ? ((full - net) / full) * 100 : null;
  return {
    product_name: r.product_name,
    brand: r.brand ?? null,
    wholesaler: r.wholesaler,
    upc: r.upc ?? null,
    product_type: r.product_type ?? null,
    unit_volume: r.unit_volume ?? null,
    type_label: r.deal_kind ?? 'Deal',
    from_date: r.from_date ?? null,
    to_date: r.to_date ?? null,
    days_to_expire: r.days_to_expire ?? null,
    orig_case_price: r.frontline_case_price ?? null,
    disc_per_case: r.total_savings_per_case ?? null,
    net_case_price: net,
    net_btl_price: netBtl,
    gp_pct: gp,
    off_pct: r.discount_pct ?? null,
    has_rip: r.has_rip ?? false,
    has_closeout: r.has_closeout ?? false,
    ai_blurb: r.ai_blurb ?? null,
    sticker: tsdStickerObj(r),
  };
}
