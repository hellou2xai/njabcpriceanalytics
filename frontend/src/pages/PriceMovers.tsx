import { useEffect, useMemo, useState } from 'react';
import { useSearchParams, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { useResultCount } from '../lib/resultCount';
import { analytics, watchlist, type PriceMover, type CatalogTier, type Price3moBlock } from '../lib/api';
import { ContextMenuProvider, RowMenuButton } from '../components/ContextMenu';
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
import { AI_EXPLAINERS_ENABLED } from '../lib/flags';
import VintageSticker from '../components/VintageSticker';
import { useProductQuickView } from '../components/ProductQuickView';
import { distributorName, ALL_DISTRIBUTORS, packLabel, perUnitAbbr } from '../lib/distributors';
import { ErrorState, EmptyState } from '../components/DataState';
import DataLoading from '../components/DataLoading';

const money = (v?: number | null) => (v == null ? '-' : `$${Number(v).toFixed(2)}`);
const pct = (v?: number | null, sign = false) => v == null ? '-' : `${sign && v > 0 ? '+' : ''}${v.toFixed(1)}%`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtEdition(ed?: string | null): string {
  if (!ed) return '-';
  const m = /^(\d{4})-(\d{1,2})/.exec(ed);
  if (!m) return ed;
  return `${MONTHS[parseInt(m[2], 10) - 1]} ${m[1]}`;
}
function fmtEdShort(ed?: string | null): string {
  if (!ed) return '';
  const m = /^(\d{4})-(\d{1,2})/.exec(ed);
  return m ? MONTHS[parseInt(m[2], 10) - 1] : ed;
}
/** The edition one calendar month before `ed` (e.g. "2026-06" -> "2026-05"). */
function prevEdition(ed?: string | null): string | null {
  if (!ed) return null;
  const m = /^(\d{4})-(\d{1,2})/.exec(ed);
  if (!m) return null;
  const y = parseInt(m[1], 10); const mo = parseInt(m[2], 10);
  return `${mo === 1 ? y - 1 : y}-${String(mo === 1 ? 12 : mo - 1).padStart(2, '0')}`;
}
/** Sticker text per validity using the row's cur/next edition labels. */
function activeLabel(validity?: string, cur?: string | null, next?: string | null): string {
  const curM = fmtEdShort(cur);
  const nextM = fmtEdShort(next);
  const yr = (cur || next || '').slice(0, 4);
  if (validity === 'both' && curM && nextM)   return `Active ${curM} + ${nextM} ${yr}`;
  if (validity === 'next_only' && nextM)      return `Active ${nextM} ${yr} only`;
  if (validity === 'current_only' && curM)    return `Active ${curM} ${yr} only`;
  return cur ? `Active ${fmtEdition(cur)}` : '';
}

interface Props { direction: 'up' | 'down'; }

export default function PriceMovers({ direction }: Props) {
  const isDrop = direction === 'down';
  const accent = isDrop ? '#16a34a' : '#dc2626';
  const Icon = isDrop ? ArrowDownRight : ArrowUpRight;
  const title = isDrop ? 'Price Drops' : 'Price Increases';

  const { open } = useProductQuickView();
  const [params] = useSearchParams();
  const [wholesaler, setWholesaler] = useState('');
  const [q, setQ] = useState(params.get('q') ?? '');
  // The assistant can filter this page in place by pushing ?q=<term|upc>.
  useEffect(() => { const u = params.get('q'); if (u !== null) setQ(u); }, [params]);
  const [productType, setProductType] = useState('');
  const [minChange, setMinChange] = useState('');     // min ABS % change
  const [minDollar, setMinDollar] = useState('1');    // min ABS $ change per case (default $1: hide rounding noise)
  const [hasRip, setHasRip] = useState<'' | 'yes' | 'no'>('');
  const [sizes, setSizes] = useState<string[]>([]);
  const [trackedOnly, setTrackedOnly] = useState(false);
  const [sort, setSort] = useState<'biggest-pct' | 'biggest-dollar' | 'name'>('biggest-pct');
  const [limit, setLimit] = useState(60);
  const [page, setPage] = useState(0);
  // `current_only` = changed last->this (the two most recent editions LOADED in
  // the system). `next_only` = will change this->next. `both` = either.
  // Default to current_only: the page ALWAYS compares the last two months of
  // prices actually loaded, so it shows data even when no future edition has
  // been ingested yet (the old next_only default left the page empty whenever
  // next month wasn't loaded). The next-month projection stays available, but
  // only when a future edition actually exists (see hasNext below).
  const [validity, setValidity] = useState<'current_only' | 'next_only' | 'both'>('current_only');
  const [view, setView] = useState<'cards' | 'table'>(() => (localStorage.getItem('pm-view') as 'cards' | 'table') || 'cards');
  useEffect(() => { localStorage.setItem('pm-view', view); }, [view]);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['price-movers', direction, wholesaler, validity],
    queryFn: () => analytics.priceMovers({ direction, wholesaler: wholesaler || undefined, validity, limit: 2000 }),
  });
  const { data: wl } = useQuery({ queryKey: ['watchlist'], queryFn: watchlist.get, enabled: trackedOnly });
  // Category facet computed from the actual movers list, not the global
  // /api/catalog/categories endpoint. See TimeSensitive.tsx for the same
  // reasoning: the global facet returned "Wine (61,861)" on a page that
  // only shows a few hundred movers.
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

  // The editions actually loaded in the system, derived from the data. `curEd`
  // is the most recent edition present; `prevEd` the one before it (the two
  // months we compare by default); `nextEd` exists only if a future edition was
  // ingested. Drives the "Comparing prices for…" header and whether the
  // next-month projection is even offered.
  const eds = useMemo(() => {
    let curEd: string | null = null;
    let nextEd: string | null = null;
    for (const d of data ?? []) {
      const c = d.cur_edition ?? d.edition ?? null;
      if (c && (!curEd || c > curEd)) curEd = c;
      const n = d.next_edition ?? null;
      if (n && (!nextEd || n > nextEd)) nextEd = n;
    }
    return { curEd, prevEd: prevEdition(curEd), nextEd, hasNext: !!nextEd };
  }, [data]);

  // Which two months the page is currently comparing, given the validity pick.
  const compare = useMemo(() => {
    if (validity === 'next_only' && eds.nextEd) return { from: eds.curEd, to: eds.nextEd };
    return { from: eds.prevEd, to: eds.curEd };   // current_only + both both start here
  }, [validity, eds]);

  const items = useMemo(() => {
    let res: PriceMover[] = data ?? [];
    if (q) {
      const ql = q.toLowerCase();
      const qd = q.replace(/\D/g, '');                 // digits only -> UPC search
      res = res.filter(i =>
        i.product_name.toLowerCase().includes(ql) ||
        (i.brand ?? '').toLowerCase().includes(ql) ||
        (qd.length >= 6 && String(i.upc ?? '').replace(/^0+/, '').includes(qd.replace(/^0+/, ''))));
    }
    if (productType) res = res.filter(i => i.product_type === productType);
    if (sizes.length > 0) {
      const set = new Set(sizes);
      res = res.filter(i => set.has(i.unit_volume ?? ''));
    }
    if (hasRip === 'yes') res = res.filter(i => i.has_rip);
    if (hasRip === 'no') res = res.filter(i => !i.has_rip);
    if (minChange) { const n = parseFloat(minChange); res = res.filter(i => Math.abs(i.case_delta_pct ?? 0) >= n); }
    if (minDollar) { const n = parseFloat(minDollar); res = res.filter(i => Math.abs(i.case_delta ?? 0) >= n); }
    if (trackedOnly && wl) {
      const tracked = new Set(wl.map(i => `${i.product_name}|${i.wholesaler}`));
      res = res.filter(i => tracked.has(`${i.product_name}|${i.wholesaler}`));
    }
    switch (sort) {
      case 'biggest-dollar': res = [...res].sort((a, b) => Math.abs(b.case_delta ?? 0) - Math.abs(a.case_delta ?? 0)); break;
      case 'name':           res = [...res].sort((a, b) => a.product_name.localeCompare(b.product_name)); break;
      case 'biggest-pct':
      default:               res = [...res].sort((a, b) => Math.abs(b.case_delta_pct ?? 0) - Math.abs(a.case_delta_pct ?? 0));
    }
    return res;
  }, [data, q, productType, sizes, hasRip, minChange, minDollar, trackedOnly, wl, sort]);

  // Publish the matched-row count so the AI assistant echoes the exact number.
  const { report } = useResultCount();
  const { pathname } = useLocation();
  useEffect(() => {
    if (!isLoading) report(pathname, items.length);
  }, [isLoading, items.length, pathname, report]);

  // Build the Size filter options from the data: every distinct
  // unit_volume that appears in the current movers, ranked by frequency
  // so the most-stocked sizes (750ML, 1.75L, ...) land first.
  const sizeOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const d of data ?? []) {
      const v = d.unit_volume;
      if (!v) continue;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 18)
      .map(([value, count]) => ({ value, label: value, count }));
  }, [data]);

  const shown = items.slice(page * limit, (page + 1) * limit);

  const sections: FilterSection[] = [
    { type: 'text', key: 'q', title: 'Search', placeholder: 'Product or brand', value: q, onChange: setQ },
    { type: 'pills', key: 'wholesaler', title: 'Distributor', options: ALL_DISTRIBUTORS, value: wholesaler, onChange: setWholesaler },
    { type: 'pills', key: 'validity', title: 'Months compared',
      options: [
        // Label each pill with the actual month names it compares, so the user
        // sees "May → Jun" rather than a generic "last 2 months". Falls back to
        // wording when editions haven't loaded yet.
        { value: 'current_only',
          label: eds.curEd ? `${fmtEdShort(eds.prevEd)} → ${fmtEdShort(eds.curEd)}` : 'Last 2 months loaded' },
        { value: 'both',         label: 'Show all' },
        // Only offer the next-month projection when a future edition is loaded;
        // otherwise it would silently show nothing.
        ...(eds.hasNext ? [{ value: 'next_only',
          label: `${fmtEdShort(eds.curEd)} → ${fmtEdShort(eds.nextEd)}` }] : []),
      ],
      value: validity, onChange: (v) => setValidity(v as 'current_only' | 'next_only' | 'both') },
    { type: 'select', key: 'product_type', title: 'Category', placeholder: 'All categories',
      options: (cats ?? []).map(c => ({ value: c.product_type, label: c.product_type, count: c.count })),
      value: productType, onChange: setProductType },
    { type: 'pills', key: 'min_pct', title: `Min ${isDrop ? 'drop' : 'rise'} %`, value: minChange, onChange: setMinChange,
      options: [
        { value: '', label: 'Any' }, { value: '2', label: '2%+' }, { value: '5', label: '5%+' },
        { value: '10', label: '10%+' }, { value: '20', label: '20%+' },
      ] },
    { type: 'pills', key: 'min_dollar', title: 'Min change / case', value: minDollar, onChange: setMinDollar,
      options: [
        { value: '', label: 'Any' }, { value: '1', label: '$1+' }, { value: '5', label: '$5+' },
        { value: '10', label: '$10+' }, { value: '25', label: '$25+' }, { value: '50', label: '$50+' },
      ] },
    { type: 'pills', key: 'has_rip', title: 'Has RIP rebate', value: hasRip, onChange: v => setHasRip(v as '' | 'yes' | 'no'),
      options: [{ value: '', label: 'Any' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] },
    { type: 'multi-pills', key: 'size', title: 'Size', options: sizeOptions, values: sizes, onChange: setSizes },
    { type: 'toggle', key: 'tracked', title: 'Favorites', value: trackedOnly, onChange: setTrackedOnly, label: 'Only my favourites' },
  ];

  const sortOptions = [
    { value: 'biggest-pct' as const,    label: isDrop ? 'Biggest % drop' : 'Biggest % rise' },
    { value: 'biggest-dollar' as const, label: 'Biggest $ change' },
    { value: 'name' as const,           label: 'Name (A-Z)' },
  ];

  return (
    <div className="page">
      <div className="orders-header">
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon size={22} color={accent} /> {title}
        </h2>
        <span className="text-muted" style={{ fontSize: 13 }}>
          {isLoading ? 'Loading…' : `${items.length.toLocaleString()} product${items.length === 1 ? '' : 's'}`}
        </span>
      </div>
      <p className="text-muted" style={{ marginTop: 0, fontSize: 13 }}>
        {isDrop
          ? 'Products whose effective case price went down between the two most recent editions loaded in the system. Bigger drops at the top.'
          : 'Products whose effective case price went up between the two most recent editions loaded in the system. Bigger rises at the top.'}
      </p>

      {/* Which two months are being compared. The page always compares the two
          most recent editions loaded; this header makes that explicit. */}
      <div className="pm-compare-banner" style={{ borderLeftColor: accent }}>
        <span className="pm-compare-label">Comparing prices for</span>
        {compare.from && compare.to ? (
          <span className="pm-compare-months">
            <strong>{fmtEdition(compare.from)}</strong>
            <span className="pm-compare-arrow">→</span>
            <strong>{fmtEdition(compare.to)}</strong>
          </span>
        ) : (
          <span className="pm-compare-months text-muted">
            {isLoading ? 'loading…' : 'the two most recent editions'}
          </span>
        )}
      </div>

      <FilterSidebar storageKey={`pm-${direction}-filters`} sections={sections}
          onReset={() => { setQ(''); setWholesaler(''); setValidity('current_only'); setProductType(''); setMinChange(''); setMinDollar(''); setHasRip(''); setSizes([]); setTrackedOnly(false); setSort('biggest-pct'); }}>

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
            noun={isDrop ? 'price drops' : 'price increases'}
            page={page}
            onPageChange={setPage}
          />

          {isError ? (
            <ErrorState retry={() => refetch()} />
          ) : isLoading ? (
            <DataLoading label={isDrop ? 'Loading price drops…' : 'Loading price increases…'} />
          ) : (
          <ContextMenuProvider onView={open}>
            {view === 'cards' ? (
              <div className="deal-cards">
                {/* Index in the key so multi-vintage / multi-edition rows
                    with the same (wholesaler, UPC) don't collide. */}
                {shown.map((d, i) => <MoverCard key={`${d.wholesaler}|${d.upc ?? d.product_name}|${d.unit_volume ?? ''}|${d.edition ?? ''}|${i}`} d={d} isDrop={isDrop} open={open} />)}
                {!isLoading && shown.length === 0 && (
                  <div className="empty" style={{ padding: 30, textAlign: 'center' }}>No products match these filters.</div>
                )}
              </div>
            ) : items.length === 0 ? (
              <EmptyState title={isDrop ? 'No price drops match these filters' : 'No price increases match these filters'}>
                Try broadening or clearing your filters.
              </EmptyState>
            ) : (
              <PromotionsTable
                rows={items.map(r => moverToPromotionRow(r, isDrop))}
                exportName={isDrop ? 'price-drops' : 'price-increases'}
                onRowClick={r => open(r.product_name, r.wholesaler, undefined,
                  { upc: r.upc ?? undefined, unitVolume: r.unit_volume ?? undefined })}
              />
            )}
          </ContextMenuProvider>
          )}
          <PromotionsPager page={page} total={items.length} limit={limit} onPageChange={setPage} view={view} />
        </div>
      </FilterSidebar>
    </div>
  );
}

function MoverCard({ d, isDrop, open }: { d: PriceMover; isDrop: boolean; open: (n: string, w: string, c?: unknown, opts?: { upc?: string; unitVolume?: string }) => void }) {
  // The headline reflects whichever transition is the bigger |effective Δ%|.
  // We pull the two prices that bracket that transition from the API row.
  const headline: 'cur' | 'next' = (d.headline_period as 'cur' | 'next' | undefined) ?? 'cur';
  const headWas  = headline === 'next' ? (d.case_price ?? null)       : (d.prev_case_price ?? null);
  const headNow  = headline === 'next' ? (d.next_case_price ?? null)  : (d.case_price ?? null);
  // Month labels for the headline transition.
  const monthLabels = (() => {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const ymToLabel = (ym?: string | null) => {
      if (!ym) return '';
      const m = /^(\d{4})-(\d{1,2})/.exec(ym);
      return m ? `${months[parseInt(m[2],10)-1]} ${m[1].slice(2)}` : ym;
    };
    const prevYM = (ym?: string | null) => {
      if (!ym) return null;
      const m = /^(\d{4})-(\d{1,2})/.exec(ym);
      if (!m) return null;
      const y = parseInt(m[1],10); const mo = parseInt(m[2],10);
      return `${mo===1?y-1:y}-${String(mo===1?12:mo-1).padStart(2,'0')}`;
    };
    const curEd = d.cur_edition ?? d.edition;
    if (headline === 'next') return { fromM: ymToLabel(curEd), toM: ymToLabel(d.next_edition ?? null) };
    return { fromM: ymToLabel(prevYM(curEd)), toM: ymToLabel(curEd) };
  })();
  const delta = d.case_delta ?? null;
  const deltaPct = d.case_delta_pct ?? null;

  const eff = d.effective_case_price ?? null;
  const uq = Number(d.unit_qty) || 0;
  const colour = isDrop ? '#16a34a' : '#dc2626';
  const bgClass = isDrop ? 'mover-card--drop' : 'mover-card--rise';

  // Monthly comparison stack: each row shows the From -> To change for the
  // headline transition. Per-edition figures come from price_3mo (each block
  // carries that edition's frontline, 1cs-QD price and full tier ladder). We
  // only ever show the BEST (deepest) QD tier and the BEST RIP tier.
  const btlAbbr = perUnitAbbr(d.unit_volume, d.unit_type);
  const perBtl = (cs?: number | null) => (cs != null && uq > 1 ? cs / uq : null);
  const blocks = d.price_3mo ?? [];
  const curEd = d.cur_edition ?? d.edition ?? null;
  const toEd = headline === 'next' ? (d.next_edition ?? null) : curEd;
  const fromEd = headline === 'next' ? curEd : prevEdition(curEd);
  const byEd = (ed?: string | null) => (ed ? blocks.find(b => b.edition === ed) ?? null : null);
  let toBlk = byEd(toEd);
  let fromBlk = byEd(fromEd);
  if ((!toBlk || !fromBlk) && blocks.length >= 2) {
    const s = [...blocks].sort((a, b) => ((a.edition ?? '') < (b.edition ?? '') ? -1 : 1));
    toBlk = toBlk ?? s[s.length - 1];
    fromBlk = fromBlk ?? s[s.length - 2];
  }
  const fl1Of = (b?: Price3moBlock | null) => b?.disc1_price ?? b?.frontline ?? null;
  const bestOf = (b: Price3moBlock | null | undefined, src: 'discount' | 'rip') => {
    const ts = (b?.tiers ?? []).filter(t => t.source === src && t.price_after != null
      && (src === 'rip' || !t.is_time_sensitive));
    return ts.length ? Math.min(...ts.map(t => t.price_after!)) : null;
  };
  const cmpRows = [
    { key: 'fl',  label: 'Front line (after 1cs QD)', from: fl1Of(fromBlk),               to: fl1Of(toBlk) },
    { key: 'qd',  label: 'QD change',                 from: bestOf(fromBlk, 'discount'),   to: bestOf(toBlk, 'discount') },
    { key: 'rip', label: 'RIP change', rip: true,     from: bestOf(fromBlk, 'rip'),        to: bestOf(toBlk, 'rip') },
  ].filter(r => r.from != null || r.to != null);

  return (
    <div className={`deal-card mover-card ${bgClass}`} role="button" tabIndex={0}
         data-ctx data-ctx-product={d.product_name} data-ctx-wholesaler={d.wholesaler}
         data-ctx-upc={d.upc ?? ''} data-ctx-volume={d.unit_volume ?? ''}
         onClick={(e) => {
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
          <div className="deal-card-name" title={d.product_name}>{d.product_name}</div>
          <div className="deal-card-sub">
            {d.brand && <span>{d.brand}</span>}
            {d.unit_volume && <span>· {d.unit_volume}</span>}
            {packLabel(d.unit_volume, d.unit_qty, d.unit_type) && (
              <span>· {packLabel(d.unit_volume, d.unit_qty, d.unit_type)}</span>
            )}
            <span className="cell-distributor-badge">{distributorName(d.wholesaler)}</span>
          </div>
        </div>
        <div className="deal-card-pills">
          <span className="deal-urgency" style={{ background: isDrop ? '#dcfce7' : '#fee2e2', color: colour }}>
            {isDrop ? 'Price drop' : 'Price up'}
          </span>
          <span className="mover-month" title="Months this price change is active in">
            {activeLabel(d.validity, d.cur_edition ?? d.edition, d.next_edition)}
          </span>
        </div>
      </div>

      <div className="deal-card-price">
        {monthLabels.fromM && (
          <span className="text-muted" style={{ fontSize: 11, marginRight: 4 }}>{monthLabels.fromM}</span>
        )}
        {headWas != null && <span className="deal-was">{money(headWas)}</span>}
        {monthLabels.toM && (
          <span className="text-muted" style={{ fontSize: 11, margin: '0 4px' }}>→ {monthLabels.toM}</span>
        )}
        <span className="deal-now" style={{ color: colour }}>{money(headNow)}<span className="deal-unit">/cs</span></span>
        {delta != null && (
          <span className="deal-save pm-diff">
            <strong>{delta > 0 ? '+' : ''}{money(delta)}/cs</strong>{deltaPct != null ? ` · ${pct(deltaPct, true)}` : ''}
          </span>
        )}
      </div>
      {/* Monthly comparison: three rows (front line after 1cs QD, best-QD change,
          best-RIP change), each showing the From -> To change in case AND bottle
          price (same size, parity rule). Only the best QD / best RIP tier. */}
      <div className="pm-stack">
        {cmpRows.map(r => {
          const changed = r.from != null && r.to != null && Math.abs(r.from - r.to) >= 0.005;
          const toStyle = changed ? { color: colour } : undefined;
          return (
            <div key={r.key} className={`pm-row${r.rip ? ' pm-row--rip' : ''}`}>
              <span className="pm-row-label">{r.label}</span>
              <span className="pm-row-vals">
                <span className="pm-cmp">
                  {r.from != null && <span className="pm-from">{money(r.from)}</span>}
                  <span className="pm-arrow">→</span>
                  <span className="pm-cs" style={toStyle}>{money(r.to)}<span className="deal-unit">/cs</span></span>
                </span>
                {(perBtl(r.from) != null || perBtl(r.to) != null) && (
                  <span className="pm-cmp">
                    {perBtl(r.from) != null && <span className="pm-from">{money(perBtl(r.from))}</span>}
                    <span className="pm-arrow">→</span>
                    <span className="pm-btl" style={toStyle}>{money(perBtl(r.to))}<span className="deal-unit">/{btlAbbr}</span></span>
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>

      <div className="deal-card-meta">
        {eff != null && <span>Net {money(eff)}/cs (after deals)</span>}
        {d.has_rip && <span className="source-badge source-rip">RIP rebate stacks</span>}
        {d.vintage && !/^(0|0\.0+|na|n\/a|nv|none)$/i.test(String(d.vintage)) && (
          <span>· Vintage {String(d.vintage).replace(/\.0+$/, '')}</span>
        )}
        <VintageSticker vintages={d.vintages_available} currentVintage={d.vintage} />
      </div>

      <div className="deal-card-spark" onClick={(e) => e.stopPropagation()}>
        {/* Same this-month vs next-month sparkline + popover as the
            Catalog row. buildSparkProps consults the row's
            headline_period so movers that qualified on prev→cur
            (rather than cur→next) plot THAT transition — fixes the
            "flat sparkline tagged as Price Drop" the user flagged.
            tiers + next_tiers are attached by the backend's
            attach_promotion_tiers so the popover now lights up the
            full Discount / RIP / Best breakdown. */}
        <MonthEffectiveSparkline {...buildSparkProps(d)} />
        <span className="text-muted" style={{ fontSize: 11 }}>Edition {fmtEdition(d.edition)}</span>
      </div>

      {AI_EXPLAINERS_ENABLED && d.ai_blurb && (
        <div className="deal-card-ai" title="AI explanation of this price change">
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

// ---- adapter: PriceMover -> standard PromotionRow ----
// "Starts" is the cur_edition's month-1 (e.g., May 2026 -> "2026-05-01"). "Ends"
// is the day before the next edition's month-1 (or month-end if cur is final).
// Days = days until the next edition starts. Disc/cs is the absolute change.
// GP%, Closeout do not apply, so they are blank.
function editionMonthStart(ed?: string | null): string | null {
  if (!ed) return null;
  const m = /^(\d{4})-(\d{1,2})/.exec(ed);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-01` : null;
}
function editionMonthEnd(ed?: string | null): string | null {
  if (!ed) return null;
  const m = /^(\d{4})-(\d{1,2})/.exec(ed);
  if (!m) return null;
  const y = parseInt(m[1], 10); const mo = parseInt(m[2], 10);
  const d = new Date(y, mo, 0); // last day of that month
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function daysFromTodayTo(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso); if (isNaN(t)) return null;
  const now = new Date(); const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((t - today) / 86400000);
}

function moverToPromotionRow(r: PriceMover, isDrop: boolean): PromotionRow {
  const curEd = r.cur_edition ?? r.edition ?? null;
  const nextEd = r.next_edition ?? null;
  // Headline transition picks which two effective prices the row displays as
  // "was" (orig_case_price) and "now" (net_case_price) — the same one the card
  // bolds. case_delta / case_delta_pct already reflect the headlined Δ.
  const headline = r.headline_period === 'next' ? 'next' : 'cur';
  const headFrom = headline === 'next' ? curEd : null; // start at "this month"
  const headTo   = headline === 'next' ? nextEd : curEd;
  const from = editionMonthStart(headFrom ?? curEd);
  const to   = editionMonthEnd(headTo);
  const days = daysFromTodayTo(to);
  const delta = r.case_delta ?? null;
  const discPerCase = delta != null ? Math.abs(delta) : null;
  const offPct = r.case_delta_pct != null ? Math.abs(r.case_delta_pct) : null;
  const qty = Number(r.unit_qty) || 0;
  const wasPrice = headline === 'next' ? (r.case_price ?? null)      : (r.prev_case_price ?? null);
  const nowPrice = headline === 'next' ? (r.next_case_price ?? null) : (r.case_price ?? null);
  const netBtl = qty > 0 && nowPrice != null ? nowPrice / qty : null;
  // Sticker re-uses the existing "Active May 2026 only" label so users see
  // exactly which months this price change is live in.
  const stickerLabel = activeLabel(r.validity, curEd, nextEd);
  const sticker: PromotionRow['sticker'] = stickerLabel
    ? { label: stickerLabel.replace(/^Active\s+/, ''), tone: r.validity === 'both' ? 'green' : 'blue' }
    : null;
  return {
    product_name: r.product_name,
    brand: r.brand ?? null,
    wholesaler: r.wholesaler,
    upc: r.upc ?? null,
    product_type: r.product_type ?? null,
    unit_volume: r.unit_volume ?? null,
    type_label: isDrop ? 'Price drop' : 'Price up',
    from_date: from,
    to_date: to,
    days_to_expire: days,
    orig_case_price: wasPrice,                       // was (effective)
    disc_per_case: discPerCase,                      // |Δ|
    net_case_price: nowPrice,                        // now (effective)
    net_btl_price: netBtl,
    gp_pct: null,                                    // not applicable here
    off_pct: offPct,                                 // |Δ%|
    has_rip: r.has_rip ?? false,
    has_closeout: false,
    ai_blurb: r.ai_blurb ?? null,
    sticker,
  };
}
