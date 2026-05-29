import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { analytics, watchlist, type PriceMover } from '../lib/api';
import { ContextMenuProvider, RowMenuButton } from '../components/ContextMenu';
import FavoriteButton from '../components/FavoriteButton';
import AddToCartButton from '../components/AddToCartButton';
import AddToListButton from '../components/AddToListButton';
import ProductThumb from '../components/ProductThumb';
import FilterSidebar, { type FilterSection } from '../components/FilterSidebar';
import PromotionsToolbar from '../components/PromotionsToolbar';
import PromotionsTable, { type PromotionRow } from '../components/PromotionsTable';
import DealSparkline from '../components/DealSparkline';
import { useProductQuickView } from '../components/ProductQuickView';
import { distributorName, ALL_DISTRIBUTORS } from '../lib/distributors';

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
  const [wholesaler, setWholesaler] = useState('');
  const [q, setQ] = useState('');
  const [productType, setProductType] = useState('');
  const [minChange, setMinChange] = useState('');     // min ABS % change
  const [minDollar, setMinDollar] = useState('');     // min ABS $ change per case
  const [hasRip, setHasRip] = useState<'' | 'yes' | 'no'>('');
  const [size, setSize] = useState('');
  const [trackedOnly, setTrackedOnly] = useState(false);
  const [sort, setSort] = useState<'biggest-pct' | 'biggest-dollar' | 'name'>('biggest-pct');
  const [limit, setLimit] = useState(60);
  // `both` = show every product on the page (the user's "show all" semantic).
  // `current_only` = rose last→this. `next_only` = will rise this→next.
  // A product can satisfy both transitions, so memberships overlap.
  const [validity, setValidity] = useState<'current_only' | 'next_only' | 'both'>('both');
  const [view, setView] = useState<'cards' | 'table'>(() => (localStorage.getItem('pm-view') as 'cards' | 'table') || 'cards');
  useEffect(() => { localStorage.setItem('pm-view', view); }, [view]);

  const { data, isLoading } = useQuery({
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

  const items = useMemo(() => {
    let res: PriceMover[] = data ?? [];
    if (q) {
      const ql = q.toLowerCase();
      res = res.filter(i => i.product_name.toLowerCase().includes(ql) || (i.brand ?? '').toLowerCase().includes(ql));
    }
    if (productType) res = res.filter(i => i.product_type === productType);
    if (size) res = res.filter(i => (i.unit_volume ?? '').toLowerCase().includes(size.toLowerCase()));
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
  }, [data, q, productType, size, hasRip, minChange, minDollar, trackedOnly, wl, sort]);

  const shown = items.slice(0, limit);

  const sections: FilterSection[] = [
    { type: 'text', key: 'q', title: 'Search', placeholder: 'Product or brand', value: q, onChange: setQ },
    { type: 'pills', key: 'wholesaler', title: 'Distributor', options: ALL_DISTRIBUTORS, value: wholesaler, onChange: setWholesaler },
    { type: 'pills', key: 'validity', title: isDrop ? 'When the drop hits' : 'When the rise hits',
      options: [
        { value: 'both',         label: 'Both (show all)' },
        { value: 'current_only', label: isDrop ? 'This month (vs last)' : 'This month (vs last)' },
        { value: 'next_only',    label: 'Next month (vs this)' },
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
        { value: '', label: 'Any' }, { value: '5', label: '$5+' }, { value: '10', label: '$10+' },
        { value: '25', label: '$25+' }, { value: '50', label: '$50+' },
      ] },
    { type: 'pills', key: 'has_rip', title: 'Has RIP rebate', value: hasRip, onChange: v => setHasRip(v as '' | 'yes' | 'no'),
      options: [{ value: '', label: 'Any' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] },
    { type: 'text', key: 'size', title: 'Size', placeholder: 'e.g. 750ML, 1.75L', value: size, onChange: setSize },
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
          ? 'Products whose frontline case price went down in the latest edition versus the prior one. Bigger drops at the top.'
          : 'Products whose frontline case price went up in the latest edition versus the prior one. Bigger rises at the top.'}
      </p>

      <div className="catalog-layout">
        <FilterSidebar storageKey={`pm-${direction}-filters`} sections={sections}
          onReset={() => { setQ(''); setWholesaler(''); setValidity('both'); setProductType(''); setMinChange(''); setMinDollar(''); setHasRip(''); setSize(''); setTrackedOnly(false); setSort('biggest-pct'); }} />

        <div className="catalog-results">
          <PromotionsToolbar
            sortValue={sort}
            onSortChange={setSort}
            sortOptions={sortOptions}
            limit={limit}
            onLimitChange={setLimit}
            total={items.length}
            shownInCards={limit}
            view={view}
            onViewChange={setView}
            noun={isDrop ? 'price drops' : 'price increases'}
          />

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
            ) : (
              <PromotionsTable
                rows={items.map(r => moverToPromotionRow(r, isDrop))}
                exportName={isDrop ? 'price-drops' : 'price-increases'}
                onRowClick={r => open(r.product_name, r.wholesaler, undefined,
                  { upc: r.upc ?? undefined, unitVolume: r.unit_volume ?? undefined })}
              />
            )}
          </ContextMenuProvider>
        </div>
      </div>
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
  // Frontline (list) story for the same headline transition, shown as a small
  // secondary line so the user sees when a list-price spike is masked by RIP.
  const flWas = headline === 'next' ? (d.frontline_case_price ?? null) : (d.frontline_prev_case_price ?? null);
  const flNow = headline === 'next' ? (d.frontline_next_case_price ?? null) : (d.frontline_case_price ?? null);
  const flDelta = headline === 'next' ? (d.frontline_next_delta ?? null) : (d.frontline_cur_delta ?? null);
  const flDeltaPct = headline === 'next' ? (d.frontline_next_delta_pct ?? null) : (d.frontline_cur_delta_pct ?? null);
  // "List" line is worth showing only when it disagrees materially with the
  // effective story (e.g. list up 27% but effective up 0.5%).
  const showListLine = flDeltaPct != null && deltaPct != null && Math.abs(flDeltaPct - deltaPct) >= 1.0;

  const eff = d.effective_case_price ?? null;
  const uq = Number(d.unit_qty) || 0;
  const effBtl = eff != null && uq > 1 ? eff / uq : null;
  const colour = isDrop ? '#16a34a' : '#dc2626';
  const bgClass = isDrop ? 'mover-card--drop' : 'mover-card--rise';

  return (
    <div className={`deal-card mover-card ${bgClass}`} role="button" tabIndex={0}
         data-ctx data-ctx-product={d.product_name} data-ctx-wholesaler={d.wholesaler}
         data-ctx-upc={d.upc ?? ''} data-ctx-volume={d.unit_volume ?? ''}
         onClick={(e) => {
           const t = e.target as HTMLElement;
           if (t.closest('button, a, input, label, .deal-card-actions, .add-to-list-menu, .row-menu-btn, .ctx-menu')) return;
           open(d.product_name, d.wholesaler, undefined, { upc: d.upc ?? undefined, unitVolume: d.unit_volume ?? undefined });
         }}
         onKeyDown={(e) => {
           if (e.key === 'Enter' || e.key === ' ') {
             e.preventDefault();
             open(d.product_name, d.wholesaler, undefined, { upc: d.upc ?? undefined, unitVolume: d.unit_volume ?? undefined });
           }
         }}>
      <div className="deal-card-head">
        <ProductThumb src={d.image_url ?? undefined} alt={d.product_name} size={70} />
        <div className="deal-card-id">
          <div className="deal-card-name" title={d.product_name}>{d.product_name}</div>
          <div className="deal-card-sub">
            {d.brand && <span>{d.brand}</span>}
            {d.unit_volume && <span>· {d.unit_volume}</span>}
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
          <span className="deal-save" style={{ color: colour }}>
            <strong>{delta > 0 ? '+' : ''}{money(delta)}/cs</strong>{deltaPct != null ? ` · ${pct(deltaPct, true)}` : ''}
          </span>
        )}
      </div>
      {showListLine && flWas != null && flNow != null && (
        <div className="deal-card-listline text-muted" style={{ fontSize: 11, marginTop: -4, marginBottom: 4 }}>
          List: {money(flWas)} → <strong>{money(flNow)}</strong>
          {flDelta != null && (
            <> ({flDelta > 0 ? '+' : ''}{money(flDelta)}
            {flDeltaPct != null && ` · ${pct(flDeltaPct, true)}`})</>
          )}{' '}
          <span title="Effective price hides most of this list change because the RIP rebate offsets it.">· RIP absorbs</span>
        </div>
      )}

      <div className="deal-card-meta">
        {eff != null && <span>Net {money(eff)}/cs (after deals)</span>}
        {effBtl != null && <span>· {money(effBtl)}/btl</span>}
        {d.has_rip && <span className="source-badge source-rip">RIP rebate stacks</span>}
        {d.vintage && <span>· Vintage {d.vintage}</span>}
      </div>

      <div className="deal-card-spark" onClick={(e) => e.stopPropagation()}>
        <DealSparkline
          wholesaler={d.wholesaler}
          productName={d.product_name}
          interactive
          upc={d.upc ?? undefined}
          unitVolume={d.unit_volume ?? undefined}
          curEdition={d.cur_edition ?? d.edition ?? undefined}
          nextEdition={d.next_edition ?? undefined}
        />
        <span className="text-muted" style={{ fontSize: 11 }}>Edition {fmtEdition(d.edition)}</span>
      </div>

      {d.ai_blurb && (
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
