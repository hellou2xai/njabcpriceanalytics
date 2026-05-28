import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { deals, watchlist, catalog, type TimeSensitiveDeal } from '../lib/api';
import { ContextMenuProvider } from '../components/ContextMenu';
import { RowMenuButton } from '../components/ContextMenu';
import FavoriteButton from '../components/FavoriteButton';
import AddToCartButton from '../components/AddToCartButton';
import AddToListButton from '../components/AddToListButton';
import ProductThumb from '../components/ProductThumb';
import FilterSidebar, { type FilterSection } from '../components/FilterSidebar';
import RowLimitSelect from '../components/RowLimitSelect';
import DealSparkline from '../components/DealSparkline';
import { useProductQuickView } from '../components/ProductQuickView';
import { distributorName, ALL_DISTRIBUTORS } from '../lib/distributors';

const money = (v?: number | null) => (v == null ? '-' : `$${Number(v).toFixed(2)}`);

function urgencyClass(days: number | null | undefined): string {
  if (days == null) return '';
  if (days <= 3) return 'urgency-hot';
  if (days <= 7) return 'urgency-warm';
  if (days <= 14) return 'urgency-soon';
  return 'urgency-later';
}
function urgencyLabel(days: number | null | undefined): string {
  if (days == null) return 'Ends soon';
  if (days <= 0) return 'Ends today';
  if (days === 1) return 'Ends tomorrow';
  return `Ends in ${days} day${days === 1 ? '' : 's'}`;
}
function fmtDateRange(from?: string | null, to?: string | null): string {
  const f = (d?: string | null) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  if (from && to) return `${f(from)} to ${f(to)}`;
  return f(from || to);
}

export default function TimeSensitive() {
  const { open } = useProductQuickView();
  const [wholesaler, setWholesaler] = useState('');
  const [q, setQ] = useState('');
  const [productType, setProductType] = useState('');
  const [validity, setValidity] = useState('');     // '' | 'ends-this-month' | 'next-month' | 'this-week'
  const [minSave, setMinSave] = useState('');
  const [minDiscount, setMinDiscount] = useState('');
  const [minGp, setMinGp] = useState('');
  const [hasRip, setHasRip] = useState<'' | 'yes' | 'no'>('');
  const [hasCloseout, setHasCloseout] = useState<'' | 'yes' | 'no'>('');
  const [size, setSize] = useState('');
  const [trackedOnly, setTrackedOnly] = useState(false);
  const [sort, setSort] = useState<'ending' | 'save' | 'pct' | 'name'>('ending');
  const [limit, setLimit] = useState(60);

  const { data, isLoading } = useQuery({
    queryKey: ['time-sensitive', wholesaler],
    queryFn: () => deals.timeSensitive({ wholesaler: wholesaler || undefined, limit: 2000 }),
  });
  const { data: wl } = useQuery({ queryKey: ['watchlist'], queryFn: watchlist.get, enabled: trackedOnly });
  const { data: cats } = useQuery({
    queryKey: ['categories', wholesaler],
    queryFn: () => catalog.categories({ wholesaler: wholesaler || undefined }),
  });

  const items = useMemo(() => {
    let res: TimeSensitiveDeal[] = data ?? [];
    if (q) {
      const ql = q.toLowerCase();
      res = res.filter(i => i.product_name.toLowerCase().includes(ql) || (i.brand ?? '').toLowerCase().includes(ql));
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
  }, [data, q, productType, size, hasRip, hasCloseout, minSave, minDiscount, minGp, validity, trackedOnly, wl, sort]);

  const shown = items.slice(0, limit);

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
    { type: 'pills', key: 'sort', title: 'Sort by', value: sort, onChange: v => setSort(v as 'ending' | 'save' | 'pct' | 'name'),
      options: [
        { value: 'ending', label: 'Ending soonest' },
        { value: 'save', label: 'Biggest saving' },
        { value: 'pct', label: 'Biggest %' },
        { value: 'name', label: 'Name (A-Z)' },
      ] },
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
          <div className="toolbar" style={{ marginBottom: 12 }}>
            <RowLimitSelect value={limit} onChange={setLimit} />
            <span className="text-muted" style={{ fontSize: 12 }}>
              Showing {Math.min(limit, items.length)} of {items.length}
            </span>
          </div>

          <ContextMenuProvider onView={open}>
            <div className="deal-cards">
              {shown.map(d => (
                <DealCard key={`${d.wholesaler}|${d.upc ?? d.product_name}`} d={d} open={open} />
              ))}
              {!isLoading && shown.length === 0 && (
                <div className="empty" style={{ padding: 30, textAlign: 'center' }}>No deals match these filters.</div>
              )}
            </div>
          </ContextMenuProvider>
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

  return (
    <div className={`deal-card ${urgency}`}
         data-ctx data-ctx-product={d.product_name} data-ctx-wholesaler={d.wholesaler}
         data-ctx-upc={d.upc ?? ''} data-ctx-volume={d.unit_volume ?? ''}>
      <div className="deal-card-head">
        <ProductThumb src={d.image_url ?? undefined} alt={d.product_name} size={70} />
        <div className="deal-card-id">
          <div className="deal-card-name"
               onClick={() => open(d.product_name, d.wholesaler, undefined, { upc: d.upc ?? undefined, unitVolume: d.unit_volume ?? undefined })}
               title={d.product_name}>
            {d.product_name}
          </div>
          <div className="deal-card-sub">
            {d.brand && <span>{d.brand}</span>}
            {d.unit_volume && <span>· {d.unit_volume}</span>}
            <span className="cell-distributor-badge">{distributorName(d.wholesaler)}</span>
          </div>
        </div>
        <span className={`deal-urgency ${urgency}`} title={fmtDateRange(d.from_date, d.to_date)}>
          {urgencyLabel(d.days_to_expire)}
        </span>
      </div>

      <div className="deal-card-price">
        {fr != null && eff != null && fr !== eff && <span className="deal-was">${fr.toFixed(2)}</span>}
        <span className="deal-now">{money(eff ?? fr)}<span className="deal-unit">/cs</span></span>
        {save != null && save > 0 && (
          <span className="deal-save">Save <strong>${save.toFixed(2)}/cs</strong>{pct ? ` · ${pct.toFixed(0)}% off` : ''}</span>
        )}
      </div>

      <div className="deal-card-meta">
        {effBtl != null && <span>${effBtl.toFixed(2)}/btl effective</span>}
        {gp != null && <span>· GP {gp.toFixed(0)}%</span>}
        {d.has_rip && <span className="source-badge source-rip">RIP rebate stacks</span>}
        {d.has_closeout && <span className="tag tag-orange">Closeout</span>}
      </div>

      <div className="deal-card-spark">
        <DealSparkline wholesaler={d.wholesaler} productName={d.product_name} />
        <span className="text-muted" style={{ fontSize: 11 }}>{fmtDateRange(d.from_date, d.to_date)}</span>
      </div>

      {d.ai_blurb && (
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

